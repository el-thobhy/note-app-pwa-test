using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;
using NoteApp.Services;

namespace NoteApp.Hubs
{
    /// <summary>
    /// SignalR hub untuk real-time collaboration per entry.
    ///
    /// Strategi: server-authoritative merge dengan strict version guard.
    ///
    /// Alur normal (no conflict):
    ///   Client kirim (entryId, htmlContent, clientVersion)
    ///   clientVersion == serverVersion → accept, simpan, broadcast, ack
    ///
    /// Alur conflict (2 client kirim bersamaan):
    ///   Client A kirim ver=1 → masuk lock → accept → ver=2 → release → broadcast
    ///   Client B kirim ver=1 → masuk lock → clientVer(1) != serverVer(2) → conflict
    ///   Server merge: diff(base_at_ver1, B_content) applied on top of ver2_content
    ///   Hasil merge disimpan sebagai ver=3, broadcast ke semua
    ///
    /// Kenapa server merge lebih baik dari client merge:
    ///   - Server punya base snapshot yang akurat (state sebelum update terakhir)
    ///   - Merge terjadi 1x di server, hasilnya konsisten untuk semua client
    ///   - Client tidak perlu tahu tentang conflict — cukup terima ReceiveUpdate
    ///
    /// Lock guarantee:
    ///   - SemaphoreSlim per entryId → serialize semua writes untuk entry yang sama
    ///   - Lock direlease SEBELUM broadcast → tidak hold lock saat network I/O
    /// </summary>
    public class CollaborationHub : Hub
    {
        private static readonly ConcurrentDictionary<string, DocState>      _docStates = new();
        private static readonly ConcurrentDictionary<string, CollabUser>    _users     = new();
        private static readonly ConcurrentDictionary<string, string>        _connEntry = new();
        private static readonly ConcurrentDictionary<string, SemaphoreSlim> _locks     = new();

        private readonly ILogger<CollaborationHub> _logger;
        private readonly IDailyEntryService _entryService;

        public CollaborationHub(ILogger<CollaborationHub> logger, IDailyEntryService entryService)
        {
            _logger       = logger;
            _entryService = entryService;
        }

        // ─────────────────────────────────────────────────────────────
        // JOIN
        // ─────────────────────────────────────────────────────────────

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
            try
            {
                state = _docStates.GetOrAdd(entryId, _ =>
                {
                    var s = new DocState();
                    if (int.TryParse(entryId, out var id))
                    {
                        try
                        {
                            var entry = _entryService.GetEntryById(id);
                            if (entry?.Content != null)
                            {
                                s.Content     = entry.Content;
                                s.BaseContent = entry.Content;
                            }
                        }
                        catch (Exception ex)
                        {
                            _logger.LogWarning(ex, "[Collab] Failed to load entry {EntryId} from DB", entryId);
                        }
                    }
                    return s;
                });
            }
            finally { docLock.Release(); }

            await Clients.Caller.SendAsync("ReceiveDocState", state.Content, state.Version);
            await BroadcastUsers(entryId);
        }

        // ─────────────────────────────────────────────────────────────
        // SEND UPDATE
        // ─────────────────────────────────────────────────────────────

        /// <summary>
        /// Client kirim update konten.
        ///
        /// clientVersion = version yang client pakai sebagai base saat mengedit.
        ///
        /// Kasus 1 — No conflict (clientVersion == serverVersion):
        ///   Client up-to-date, accept content as-is.
        ///
        /// Kasus 2 — Conflict (clientVersion &lt; serverVersion):
        ///   Ada peer yang sudah update server setelah client mulai edit.
        ///   Server merge: ambil perubahan client (diff base→client),
        ///   apply ke server content terbaru.
        ///   Hasilnya broadcast ke semua termasuk pengirim.
        ///
        /// Kasus 3 — Stale (clientVersion > serverVersion):
        ///   Tidak mungkin terjadi dalam kondisi normal.
        ///   Treat sama seperti no conflict.
        /// </summary>
        public async Task SendHtmlUpdate(string entryId, string htmlContent, long clientVersion)
        {
            if (string.IsNullOrEmpty(htmlContent)) return;

            var docLock = _locks.GetOrAdd(entryId, _ => new SemaphoreSlim(1, 1));
            await docLock.WaitAsync();

            long   newVersion;
            string resultContent;

            try
            {
                var state = _docStates.GetOrAdd(entryId, _ => new DocState());

                if (clientVersion >= state.Version)
                {
                    // Kasus 1: No conflict — accept as-is
                    newVersion     = state.Version + 1;
                    resultContent  = htmlContent;

                    state.BaseContent = state.Content; // simpan sebelum overwrite
                    state.Content     = resultContent;
                    state.Version     = newVersion;
                }
                else
                {
                    // Kasus 2: Conflict — server merge
                    _logger.LogDebug(
                        "[Collab] Conflict entry={EntryId} clientVer={ClientVer} serverVer={ServerVer}",
                        entryId, clientVersion, state.Version);

                    resultContent = ServerMerge(state.BaseContent, htmlContent, state.Content);
                    newVersion    = state.Version + 1;

                    state.BaseContent = state.Content;
                    state.Content     = resultContent;
                    state.Version     = newVersion;
                }
            }
            finally
            {
                // Release SEBELUM broadcast — jangan hold lock saat network I/O
                docLock.Release();
            }

            // Broadcast merged result ke SEMUA (termasuk pengirim)
            // Pengirim juga perlu update supaya editor-nya sync dengan merged result
            await Clients.Group(GroupName(entryId))
                .SendAsync("ReceiveUpdate", resultContent, newVersion);
        }

        // ─────────────────────────────────────────────────────────────
        // SERVER MERGE
        // ─────────────────────────────────────────────────────────────

        /// <summary>
        /// 3-way merge menggunakan diff-match-patch.
        ///
        /// base   = state server sebelum update terakhir (BaseContent)
        /// mine   = content yang client kirim
        /// theirs = current server content (sudah include update dari peer)
        ///
        /// Logika:
        ///   1. diff(base, mine) → "apa yang client ubah"
        ///   2. apply diff ke theirs → "perubahan client di atas state peer"
        ///   3. Kalau ada conflict di patch, server content wins untuk bagian itu
        /// </summary>
        private string ServerMerge(string baseContent, string mine, string theirs)
        {
            if (mine == theirs)    return mine;
            if (mine == baseContent)   return theirs; // client tidak ubah apa-apa
            if (theirs == baseContent) return mine;   // server tidak berubah (race tapi no-op)
            if (string.IsNullOrEmpty(baseContent)) return theirs;

            try
            {
                var dmp = new DiffMatchPatch.diff_match_patch();
                dmp.Match_Threshold = 0.5f;
                dmp.Match_Distance  = 2000;

                // Hitung apa yang client ubah dari base
                var diffs   = dmp.diff_main(baseContent, mine);
                dmp.diff_cleanupSemantic(diffs);
                var patches = dmp.patch_make(baseContent, diffs);

                // Apply perubahan client ke atas server content terbaru
                var result  = dmp.patch_apply(patches, theirs);
                var merged  = (string)result[0];
                var success = (bool[])result[1];

                var failCount = 0;
                foreach (var s in success) if (!s) failCount++;

                if (failCount > 0)
                    _logger.LogDebug("[Collab] Merge: {Fail}/{Total} patches failed (server wins for conflicts)",
                        failCount, success.Length);

                return merged;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[Collab] Merge exception, using server content");
                return theirs;
            }
        }

        // ─────────────────────────────────────────────────────────────
        // AWARENESS
        // ─────────────────────────────────────────────────────────────

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

        // ─────────────────────────────────────────────────────────────
        // DISCONNECT
        // ─────────────────────────────────────────────────────────────

        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            if (_connEntry.TryRemove(Context.ConnectionId, out var entryId))
            {
                _users.TryRemove(Context.ConnectionId, out _);
                await Groups.RemoveFromGroupAsync(Context.ConnectionId, GroupName(entryId));
                await BroadcastUsers(entryId);
            }
            await base.OnDisconnectedAsync(exception);
        }

        // ─────────────────────────────────────────────────────────────
        // HELPERS
        // ─────────────────────────────────────────────────────────────

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

    // ─────────────────────────────────────────────────────────────────
    // MODELS
    // ─────────────────────────────────────────────────────────────────

    public class DocState
    {
        public string Content     { get; set; } = "";
        public string BaseContent { get; set; } = ""; // snapshot sebelum update terakhir (untuk merge)
        public long   Version     { get; set; } = 0;
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
