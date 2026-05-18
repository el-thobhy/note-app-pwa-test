using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;
using NoteApp.Services;

namespace NoteApp.Hubs
{
    /// <summary>
    /// Real-time collaboration hub — server-authoritative merge.
    ///
    /// Kunci desain:
    ///   - BaseContent disimpan PER CLIENT (per connectionId), bukan shared.
    ///     Setiap client punya snapshot dari state saat mereka terakhir sync.
    ///     Ini adalah "titik divergence" yang akurat untuk 3-way merge.
    ///
    ///   - Alur SendHtmlUpdate:
    ///     1. Client kirim (content, clientVersion)
    ///     2. Server ambil BaseContent milik client ini (snapshot terakhir yang client tahu)
    ///     3. Kalau clientVersion == serverVersion → no conflict, accept as-is
    ///     4. Kalau clientVersion &lt; serverVersion → conflict:
    ///        merge(clientBase, clientContent, serverContent)
    ///        = "apply perubahan client di atas state server terbaru"
    ///     5. Update BaseContent client = merged result (untuk merge berikutnya)
    ///     6. Broadcast ke semua
    ///
    ///   - Lock per entry → serialize semua writes, tidak ada concurrent write
    ///   - Lock release sebelum broadcast → tidak hold lock saat network I/O
    /// </summary>
    public class CollaborationHub : Hub
    {
        private static readonly ConcurrentDictionary<string, DocState>      _docStates   = new();
        private static readonly ConcurrentDictionary<string, CollabUser>    _users       = new();
        private static readonly ConcurrentDictionary<string, string>        _connEntry   = new();
        private static readonly ConcurrentDictionary<string, SemaphoreSlim> _locks       = new();
        // BaseContent per client: key = connectionId, value = last known content
        private static readonly ConcurrentDictionary<string, string>        _clientBases = new();

        private readonly ILogger<CollaborationHub> _logger;
        private readonly IDailyEntryService _entryService;

        public CollaborationHub(ILogger<CollaborationHub> logger, IDailyEntryService entryService)
        {
            _logger       = logger;
            _entryService = entryService;
        }

        public async Task JoinEntry(string entryId, string displayName, string avatar)
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, GroupName(entryId));

            _connEntry[Context.ConnectionId] = entryId;
            _users[Context.ConnectionId] = new CollabUser
            {
                ConnectionId = Context.ConnectionId,
                DisplayName  = displayName,
                Avatar       = avatar,
                EntryId      = entryId,
                Color        = GenerateColor(Context.ConnectionId)
            };

            var docLock = _locks.GetOrAdd(entryId, _ => new SemaphoreSlim(1, 1));
            await docLock.WaitAsync();
            DocState state;
            bool isNewState;
            try
            {
                isNewState = !_docStates.ContainsKey(entryId);
                state = _docStates.GetOrAdd(entryId, _ => new DocState());

                if (isNewState && string.IsNullOrEmpty(state.Content))
                {
                    if (int.TryParse(entryId, out var id))
                    {
                        try
                        {
                            var entry = _entryService.GetEntryById(id);
                            if (!string.IsNullOrEmpty(entry?.Content))
                                state.Content = entry.Content;
                        }
                        catch (Exception ex)
                        {
                            _logger.LogWarning(ex, "[Collab] Failed to load entry {EntryId} from DB", entryId);
                        }
                    }
                }

                // Set base untuk client ini = current server content
                // Ini adalah "titik divergence" awal client
                _clientBases[Context.ConnectionId] = state.Content;
            }
            finally { docLock.Release(); }

            // Kirim state ke client hanya kalau ada content
            if (!string.IsNullOrEmpty(state.Content))
                await Clients.Caller.SendAsync("ReceiveDocState", state.Content, state.Version);

            await BroadcastUsers(entryId);
        }

        /// <summary>
        /// Client kirim update.
        ///
        /// clientVersion = version terakhir yang client tahu dari server.
        ///
        /// No conflict (clientVersion >= serverVersion):
        ///   Client up-to-date, accept as-is.
        ///   Update clientBase = content yang dikirim.
        ///
        /// Conflict (clientVersion &lt; serverVersion):
        ///   Client belum tahu update terbaru dari peer.
        ///   3-way merge: diff(clientBase, clientContent) applied on top of serverContent.
        ///   clientBase = snapshot server yang client terakhir tahu (per-client, akurat).
        ///   Update clientBase = merged result.
        ///
        /// Broadcast ke SEMUA termasuk pengirim.
        /// Update clientBase semua peer = merged result (mereka sekarang tahu state ini).
        /// </summary>
        public async Task SendHtmlUpdate(string entryId, string htmlContent, long clientVersion)
        {
            if (string.IsNullOrEmpty(htmlContent)) return;

            var docLock = _locks.GetOrAdd(entryId, _ => new SemaphoreSlim(1, 1));
            await docLock.WaitAsync();

            long   newVersion;
            string resultContent;
            List<string> allConnectionIds;

            try
            {
                var state = _docStates.GetOrAdd(entryId, _ => new DocState());

                // Ambil base milik client ini (snapshot terakhir yang dia tahu)
                var clientBase = _clientBases.GetValueOrDefault(Context.ConnectionId, state.Content);

                if (clientVersion >= state.Version)
                {
                    // No conflict
                    resultContent = htmlContent;
                    newVersion    = state.Version + 1;
                }
                else
                {
                    // Conflict — 3-way merge pakai clientBase yang akurat
                    _logger.LogDebug(
                        "[Collab] Conflict entry={EntryId} clientVer={ClientVer} serverVer={ServerVer}",
                        entryId, clientVersion, state.Version);

                    resultContent = ServerMerge(clientBase, htmlContent, state.Content);
                    newVersion    = state.Version + 1;
                }

                state.Content = resultContent;
                state.Version = newVersion;

                // Update base semua client yang ada di room ini = merged result
                // Mereka sekarang tahu state ini setelah menerima broadcast
                allConnectionIds = _users.Values
                    .Where(u => u.EntryId == entryId)
                    .Select(u => u.ConnectionId)
                    .ToList();

                foreach (var connId in allConnectionIds)
                    _clientBases[connId] = resultContent;
            }
            finally
            {
                docLock.Release();
            }

            await Clients.Group(GroupName(entryId))
                .SendAsync("ReceiveUpdate", resultContent, newVersion);
        }

        /// <summary>
        /// 3-way merge.
        /// base  = snapshot server yang client terakhir tahu (per-client, akurat)
        /// mine  = content yang client kirim
        /// theirs = current server content
        ///
        /// diff(base, mine) = perubahan yang client buat
        /// apply ke theirs  = perubahan client di atas state server terbaru
        /// </summary>
        private string ServerMerge(string baseContent, string mine, string theirs)
        {
            if (mine == theirs)        return mine;
            if (mine == baseContent)   return theirs;
            if (theirs == baseContent) return mine;
            if (string.IsNullOrEmpty(baseContent)) return theirs;

            try
            {
                var dmp = new DiffMatchPatch.diff_match_patch();
                dmp.Match_Threshold = 0.5f;
                dmp.Match_Distance  = 2000;

                var diffs   = dmp.diff_main(baseContent, mine);
                dmp.diff_cleanupSemantic(diffs);
                var patches = dmp.patch_make(baseContent, diffs);
                var result  = dmp.patch_apply(patches, theirs);
                var merged  = (string)result[0];
                var success = (bool[])result[1];

                var failCount = 0;
                foreach (var s in success) if (!s) failCount++;
                if (failCount > 0)
                    _logger.LogDebug("[Collab] Merge: {Fail}/{Total} patches failed", failCount, success.Length);

                return merged;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[Collab] Merge exception, using server content");
                return theirs;
            }
        }

        public async Task SendAwareness(string entryId, AwarenessData awarenessData)
        {
            var user = _users.GetValueOrDefault(Context.ConnectionId);
            await Clients.OthersInGroup(GroupName(entryId)).SendAsync("ReceiveAwareness", new
            {
                connectionId = Context.ConnectionId,
                displayName  = user?.DisplayName ?? "Unknown",
                color        = user?.Color ?? "#888",
                isTyping     = awarenessData.IsTyping
            });
        }

        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            if (_connEntry.TryRemove(Context.ConnectionId, out var entryId))
            {
                _users.TryRemove(Context.ConnectionId, out _);
                _clientBases.TryRemove(Context.ConnectionId, out _);
                await Groups.RemoveFromGroupAsync(Context.ConnectionId, GroupName(entryId));
                await BroadcastUsers(entryId);
            }
            await base.OnDisconnectedAsync(exception);
        }

        private async Task BroadcastUsers(string entryId)
        {
            var online = _users.Values
                .Where(u => u.EntryId == entryId)
                .Select(u => new { u.ConnectionId, u.DisplayName, u.Avatar, u.Color })
                .ToList();
            await Clients.Group(GroupName(entryId)).SendAsync("UsersOnline", online);
        }

        private static string GroupName(string entryId) => $"entry-{entryId}";

        private static string GenerateColor(string connectionId)
        {
            var colors = new[] {
                "#e74c3c", "#3498db", "#2ecc71", "#f39c12",
                "#9b59b6", "#1abc9c", "#e67e22", "#e91e63"
            };
            return colors[Math.Abs(connectionId.GetHashCode()) % colors.Length];
        }
    }

    public class DocState
    {
        public string Content { get; set; } = "";
        public long   Version { get; set; } = 0;
    }

    public class CollabUser
    {
        public string ConnectionId { get; set; } = "";
        public string DisplayName  { get; set; } = "";
        public string Avatar       { get; set; } = "";
        public string EntryId      { get; set; } = "";
        public string Color        { get; set; } = "";
    }

    public class AwarenessData
    {
        public bool   IsTyping    { get; set; }
        public string DisplayName { get; set; } = "";
    }
}
