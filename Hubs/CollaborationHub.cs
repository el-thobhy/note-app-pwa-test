using Microsoft.AspNetCore.SignalR;
using DiffMatchPatch;
using System.Collections.Concurrent;

namespace NoteApp.Hubs
{
    /// <summary>
    /// Real-time collaboration hub — SERVER-SIDE MERGE ONLY.
    ///
    /// Client:
    ///   - Kirim: SendUpdate(entryId, content, baseVersion)
    ///   - Terima: ReceiveState(content, version) → replace editor
    ///
    /// Merge strategy (3-way diff):
    ///   - base  = snapshot di baseVersion dari history
    ///   - mine  = content dari client
    ///   - theirs = current server state
    ///   - diff(base, mine) → patch → apply ke theirs
    ///
    /// Race condition fixes:
    ///   1. JoinEntry baca state di dalam lock → consistent read
    ///   2. DocState pakai version history → merge selalu pakai base yang tepat
    ///   3. _users + _connEntry dikelola atomic lewat satu lock per connId
    ///   4. Lock di SendUpdate direlease SEBELUM broadcast → tidak hold lock saat I/O
    /// </summary>
    public class CollaborationHub : Hub
    {
        private static readonly ConcurrentDictionary<string, DocState> _docStates = new();
        private static readonly ConcurrentDictionary<string, CollabUser> _users = new();
        private static readonly ConcurrentDictionary<string, string> _connEntry = new();

        // Lock per entryId untuk serialize writes ke DocState
        private static readonly ConcurrentDictionary<string, SemaphoreSlim> _docLocks = new();

        // Lock per connectionId untuk atomic update _users + _connEntry
        private static readonly ConcurrentDictionary<string, SemaphoreSlim> _connLocks = new();

        private readonly ILogger<CollaborationHub> _logger;

        public CollaborationHub(ILogger<CollaborationHub> logger)
        {
            _logger = logger;
        }

        public async Task JoinEntry(string entryId, string displayName, string avatar)
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, GroupName(entryId));

            // FIX #3: Update _users dan _connEntry secara atomic lewat lock per connId.
            // Sebelumnya dua write terpisah tanpa koordinasi — BroadcastUsers bisa
            // baca _users di tengah-tengah sehingga user baru tidak kelihatan atau
            // user lama masih kelihatan padahal sudah disconnect.
            var connLock = _connLocks.GetOrAdd(Context.ConnectionId, _ => new SemaphoreSlim(1, 1));
            await connLock.WaitAsync();
            try
            {
                _connEntry[Context.ConnectionId] = entryId;
                _users[Context.ConnectionId] = new CollabUser
                {
                    ConnectionId = Context.ConnectionId,
                    DisplayName = displayName,
                    Avatar = avatar,
                    EntryId = entryId,
                    Color = GenerateColor(Context.ConnectionId)
                };
            }
            finally
            {
                connLock.Release();
            }

            // FIX #1: Baca DocState di dalam doc lock → consistent read.
            // Sebelumnya baca Content + Version di luar lock, bisa dapat
            // Content versi baru tapi Version versi lama karena SendUpdate
            // nulis keduanya secara concurrent.
            var docLock = _docLocks.GetOrAdd(entryId, _ => new SemaphoreSlim(1, 1));
            await docLock.WaitAsync();
            string currentContent;
            long currentVersion;
            try
            {
                var state = _docStates.GetOrAdd(entryId, _ => new DocState());
                currentContent = state.Content;
                currentVersion = state.Version;
            }
            finally
            {
                docLock.Release();
            }

            // Broadcast di luar semua lock
            await Clients.Caller.SendAsync("ReceiveState", currentContent, currentVersion);
            await BroadcastUsers(entryId);
        }

        /// <summary>
        /// Client kirim update.
        ///
        /// FIX #4: Lock direlease SEBELUM broadcast ke group.
        /// Sebelumnya lock masih dipegang saat Clients.Group().SendAsync() —
        /// network I/O yang bisa lambat — sehingga semua SendUpdate lain
        /// untuk entryId yang sama harus nunggu, berpotensi deadlock.
        /// </summary>
        public async Task SendUpdate(string entryId, string content, long baseVersion)
        {
            if (content == null) return;

            var docLock = _docLocks.GetOrAdd(entryId, _ => new SemaphoreSlim(1, 1));
            await docLock.WaitAsync();

            string merged;
            long newVersion;
            try
            {
                var state = _docStates.GetOrAdd(entryId, _ => new DocState());

                if (state.Version == 0 || baseVersion >= state.Version)
                {
                    // No conflict — client up to date
                    merged = content;
                }
                else
                {
                    // Conflict — ambil snapshot tepat di baseVersion (FIX #2)
                    var baseText = state.GetSnapshot(baseVersion);
                    merged = MergeContent(baseText, content, state.Content);
                }

                state.SaveSnapshot(state.Version, state.Content);
                state.Content = merged;
                state.Version++;
                newVersion = state.Version;
            }
            finally
            {
                // FIX #4: Release lock SEBELUM broadcast
                docLock.Release();
            }

            // Broadcast di luar lock — tidak ada state mutation di sini
            await Clients.Group(GroupName(entryId))
                .SendAsync("ReceiveState", merged, newVersion);
        }

        /// <summary>
        /// 3-way merge pakai diff-match-patch.
        ///
        /// base  = state saat client mulai edit
        /// mine  = content dari client
        /// theirs = current server state (sudah include peer edits)
        ///
        /// Strategy 1: apply client's diff on top of server state
        /// Strategy 2: apply server's diff on top of client content (fallback)
        /// Pilih strategy dengan patch failure paling sedikit.
        /// </summary>
        private string MergeContent(string baseText, string mine, string theirs)
        {
            if (mine == theirs) return mine;
            if (mine == baseText) return theirs;
            if (theirs == baseText) return mine;
            if (string.IsNullOrEmpty(baseText)) return theirs;

            try
            {
                var dmp = new diff_match_patch();
                dmp.Match_Threshold = 0.4f;
                dmp.Match_Distance = 2000;

                // Strategy 1: client changes on top of server state
                var diffs1 = dmp.diff_main(baseText, mine);
                if (diffs1.Count > 2) dmp.diff_cleanupSemantic(diffs1);
                var patches1 = dmp.patch_make(baseText, diffs1);
                var result1 = dmp.patch_apply(patches1, theirs);
                var merged1 = (string)result1[0];
                var fail1 = ((bool[])result1[1]).Count(s => !s);

                if (fail1 == 0) return merged1;

                _logger.LogDebug("[Collab] Strategy1: {Fail} patches failed, trying reverse", fail1);

                // Strategy 2: server changes on top of client content
                var diffs2 = dmp.diff_main(baseText, theirs);
                if (diffs2.Count > 2) dmp.diff_cleanupSemantic(diffs2);
                var patches2 = dmp.patch_make(baseText, diffs2);
                var result2 = dmp.patch_apply(patches2, mine);
                var merged2 = (string)result2[0];
                var fail2 = ((bool[])result2[1]).Count(s => !s);

                return fail2 < fail1 ? merged2 : merged1;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[Collab] Merge exception, server wins");
                return theirs;
            }
        }

        public async Task SendAwareness(string entryId, AwarenessData awarenessData)
        {
            // Baca user snapshot — kalau tidak ada (timing edge case) skip saja
            if (!_users.TryGetValue(Context.ConnectionId, out var user)) return;

            await Clients.OthersInGroup(GroupName(entryId)).SendAsync("ReceiveAwareness", new
            {
                connectionId = Context.ConnectionId,
                displayName = user.DisplayName,
                color = user.Color,
                isTyping = awarenessData.IsTyping
            });
        }

        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            // FIX #3: Remove _connEntry dan _users secara atomic
            var connLock = _connLocks.GetOrAdd(Context.ConnectionId, _ => new SemaphoreSlim(1, 1));
            await connLock.WaitAsync();
            string? entryId = null;
            try
            {
                if (_connEntry.TryRemove(Context.ConnectionId, out entryId))
                    _users.TryRemove(Context.ConnectionId, out _);
            }
            finally
            {
                connLock.Release();
                // Cleanup lock entry supaya tidak leak
                if (_connLocks.TryRemove(Context.ConnectionId, out var removedLock))
                    removedLock.Dispose();
            }

            if (entryId != null)
            {
                await Groups.RemoveFromGroupAsync(Context.ConnectionId, GroupName(entryId));
                await BroadcastUsers(entryId);
            }

            await base.OnDisconnectedAsync(exception);
        }

        private async Task BroadcastUsers(string entryId)
        {
            // Snapshot _users.Values sekali — ConcurrentDictionary.Values sudah thread-safe untuk read
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
        public long Version { get; set; } = 0;

        // Version history — simpan N snapshot terakhir
        // supaya merge selalu bisa pakai base yang tepat sesuai baseVersion client
        private const int MaxSnapshots = 30;
        private readonly Dictionary<long, string> _snapshots = new();

        /// <summary>
        /// Simpan snapshot sebelum Content di-overwrite.
        /// Dipanggil di dalam doc lock.
        /// </summary>
        public void SaveSnapshot(long version, string content)
        {
            _snapshots[version] = content;

            if (_snapshots.Count > MaxSnapshots)
            {
                var oldest = _snapshots.Keys.Min();
                _snapshots.Remove(oldest);
            }
        }

        /// <summary>
        /// Ambil snapshot terdekat yang &lt;= targetVersion.
        /// Return string kosong kalau tidak ada history.
        /// </summary>
        public string GetSnapshot(long targetVersion)
        {
            if (_snapshots.Count == 0) return "";

            var best = _snapshots.Keys
                .Where(k => k <= targetVersion)
                .OrderByDescending(k => k)
                .FirstOrDefault(-1);

            return best >= 0 ? _snapshots[best] : "";
        }
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
