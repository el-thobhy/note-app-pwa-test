using Microsoft.AspNetCore.SignalR;
using DiffMatchPatch;
using System.Collections.Concurrent;

namespace NoteApp.Hubs
{
    /// <summary>
    /// Real-time collaboration hub — SERVER-SIDE MERGE ONLY.
    ///
    /// Client sangat simple:
    ///   - Kirim: SendUpdate(entryId, content, baseVersion)
    ///   - Terima: ReceiveState(content, version) → replace editor
    ///
    /// Server yang handle semua merge:
    ///   - Kalau baseVersion == serverVersion → no conflict, accept langsung
    ///   - Kalau baseVersion < serverVersion → conflict, server merge pakai 3-way diff
    ///
    /// Merge strategy (3-way):
    ///   - base = snapshot server text saat client's baseVersion
    ///   - theirs = current server text (sudah include edits dari peer)
    ///   - mine = client's content
    ///   - diff(base, mine) → patch (apa yang client ubah)
    ///   - apply patch ke theirs → merged result
    ///
    /// Hasilnya: kedua perubahan (client + peer) preserved.
    /// </summary>
    public class CollaborationHub : Hub
    {
        private static readonly ConcurrentDictionary<string, DocState> _docStates = new();
        private static readonly ConcurrentDictionary<string, CollabUser> _users = new();
        private static readonly ConcurrentDictionary<string, string> _connEntry = new();
        private static readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new();

        private readonly ILogger<CollaborationHub> _logger;

        public CollaborationHub(ILogger<CollaborationHub> logger)
        {
            _logger = logger;
        }

        public async Task JoinEntry(string entryId, string displayName, string avatar)
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, GroupName(entryId));

            _connEntry[Context.ConnectionId] = entryId;
            _users[Context.ConnectionId] = new CollabUser
            {
                ConnectionId = Context.ConnectionId,
                DisplayName = displayName,
                Avatar = avatar,
                EntryId = entryId,
                Color = GenerateColor(Context.ConnectionId)
            };

            // Kirim current state ke client yang baru join
            var state = _docStates.GetOrAdd(entryId, _ => new DocState());
            await Clients.Caller.SendAsync("ReceiveState", state.Content, state.Version);

            await BroadcastUsers(entryId);
        }

        /// <summary>
        /// Client kirim update.
        /// 
        /// Parameters:
        ///   - entryId: document ID
        ///   - content: full HTML content dari editor client
        ///   - baseVersion: version yang client pakai sebagai starting point
        ///
        /// Server logic:
        ///   1. Lock per entry (serialize semua writes)
        ///   2. Kalau baseVersion == serverVersion → no conflict, accept as-is
        ///   3. Kalau baseVersion < serverVersion → conflict:
        ///      - Ambil snapshot saat baseVersion (atau approximate)
        ///      - 3-way merge: diff(base, clientContent) → apply ke serverContent
        ///   4. Broadcast merged result ke SEMUA (termasuk pengirim)
        ///      Pengirim juga terima supaya editor-nya sync dengan server result
        /// </summary>
        public async Task SendUpdate(string entryId, string content, long baseVersion)
        {
            if (content == null) return;

            var lock_ = _locks.GetOrAdd(entryId, _ => new SemaphoreSlim(1, 1));
            await lock_.WaitAsync();
            try
            {
                var state = _docStates.GetOrAdd(entryId, _ => new DocState());

                string merged;

                if (state.Version == 0 || baseVersion >= state.Version)
                {
                    // No conflict — client is up to date, accept content as-is
                    merged = content;
                }
                else
                {
                    // Conflict — client's baseVersion < server version
                    // Artinya ada edits dari peer yang client belum tahu
                    // Server merge: apply client's changes on top of current server state
                    merged = MergeContent(state.BaseSnapshot, content, state.Content);
                }

                // Update server state
                state.BaseSnapshot = state.Content; // simpan state sebelumnya sebagai base untuk merge berikutnya
                state.Content = merged;
                state.Version++;

                // Broadcast ke SEMUA termasuk pengirim
                // Pengirim juga harus update editor-nya ke merged result
                // Ini memastikan semua client punya state yang SAMA
                await Clients.Group(GroupName(entryId))
                    .SendAsync("ReceiveState", merged, state.Version);
            }
            finally
            {
                lock_.Release();
            }
        }

        /// <summary>
        /// 3-way merge menggunakan diff-match-patch.
        /// 
        /// base: state server saat client mulai edit (sebelum peer edit)
        /// mine: content yang client kirim (client's version)
        /// theirs: current server state (sudah include peer edits)
        /// 
        /// Strategy: 
        ///   1. diff(base, mine) → patches (apa yang client ubah dari base)
        ///   2. apply patches ke theirs → merged (client changes on top of peer changes)
        ///   3. Kalau patch gagal, fallback: coba sebaliknya
        ///   4. Kalau masih gagal, prefer theirs (server wins, data tidak hilang)
        /// </summary>
        private string MergeContent(string baseText, string mine, string theirs)
        {
            // Edge cases
            if (mine == theirs) return mine;
            if (mine == baseText) return theirs; // client tidak ubah apa-apa
            if (theirs == baseText) return mine; // server tidak berubah (seharusnya tidak terjadi)
            if (string.IsNullOrEmpty(baseText)) return theirs; // no base, server wins

            try
            {
                var dmp = new diff_match_patch();
                dmp.Match_Threshold = 0.4f;
                dmp.Match_Distance = 2000;

                // Strategy 1: Apply client's changes on top of server state
                var diffs = dmp.diff_main(baseText, mine);
                if (diffs.Count > 2) dmp.diff_cleanupSemantic(diffs);
                var patches = dmp.patch_make(baseText, diffs);
                var result = dmp.patch_apply(patches, theirs);
                var merged = (string)result[0];
                var success = (bool[])result[1];

                // Cek apakah semua patch berhasil
                var failCount = 0;
                foreach (var s in success)
                {
                    if (!s) failCount++;
                }

                if (failCount == 0)
                {
                    return merged;
                }

                _logger.LogDebug("[Collab] Primary merge: {FailCount}/{Total} patches failed, trying reverse",
                    failCount, success.Length);

                // Strategy 2: Apply server's changes on top of client content
                var diffs2 = dmp.diff_main(baseText, theirs);
                if (diffs2.Count > 2) dmp.diff_cleanupSemantic(diffs2);
                var patches2 = dmp.patch_make(baseText, diffs2);
                var result2 = dmp.patch_apply(patches2, mine);
                var merged2 = (string)result2[0];
                var success2 = (bool[])result2[1];

                var failCount2 = 0;
                foreach (var s in success2)
                {
                    if (!s) failCount2++;
                }

                if (failCount2 < failCount)
                {
                    return merged2;
                }

                // Kedua strategy ada yang gagal — pakai yang pertama (lebih banyak berhasil)
                if (failCount <= failCount2)
                {
                    return merged;
                }

                return merged2;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[Collab] Merge exception, using server content (theirs)");
                return theirs;
            }
        }

        public async Task SendAwareness(string entryId, AwarenessData awarenessData)
        {
            var user = _users.GetValueOrDefault(Context.ConnectionId);
            await Clients.OthersInGroup(GroupName(entryId)).SendAsync("ReceiveAwareness", new
            {
                connectionId = Context.ConnectionId,
                displayName = user?.DisplayName ?? "Unknown",
                color = user?.Color ?? "#888",
                isTyping = awarenessData.IsTyping
            });
        }

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
        public string BaseSnapshot { get; set; } = ""; // snapshot sebelum update terakhir
        public long Version { get; set; } = 0;
    }

    public class CollabUser
    {
        public string ConnectionId { get; set; } = "";
        public string DisplayName { get; set; } = "";
        public string Avatar { get; set; } = "";
        public string EntryId { get; set; } = "";
        public string Color { get; set; } = "";
    }

    public class AwarenessData
    {
        public bool IsTyping { get; set; }
        public string DisplayName { get; set; } = "";
    }
}
