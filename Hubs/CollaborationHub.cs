using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;

namespace NoteApp.Hubs
{
    /// <summary>
    /// SignalR hub untuk real-time collaboration per entry.
    ///
    /// Strategi: Differential Synchronization (Neil Fraser style)
    /// - Server menyimpan "server text" per entry
    /// - Client kirim PATCH (diff dari shadow → current)
    /// - Server apply patch ke server text, lalu broadcast patch ke peers
    /// - Peers apply patch ke shadow DAN editor mereka
    /// - Ini menghindari race condition karena patch bersifat incremental,
    ///   bukan full-replace. Dua patch dari 2 user bisa di-apply berurutan
    ///   tanpa saling overwrite.
    ///
    /// Fallback: kalau patch gagal, server kirim full state untuk resync.
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
            if (_docStates.TryGetValue(entryId, out var state) && !string.IsNullOrEmpty(state.Content))
            {
                await Clients.Caller.SendAsync("ReceiveDocState", state.Content, state.Version);
            }

            await BroadcastUsers(entryId);
        }

        /// <summary>
        /// Client kirim patch (diff text dari diff-match-patch).
        /// Server apply patch ke server text, lalu broadcast ke peers.
        /// 
        /// Kalau patch gagal apply, server kirim full state ke pengirim untuk resync.
        /// </summary>
        public async Task SendPatch(string entryId, string patchText)
        {
            if (string.IsNullOrEmpty(patchText)) return;

            var lock_ = _locks.GetOrAdd(entryId, _ => new SemaphoreSlim(1, 1));
            await lock_.WaitAsync();
            try
            {
                var current = _docStates.GetOrAdd(entryId, _ => new DocState());
                var serverContent = current.Content ?? "";

                // Apply patch ke server text
                var dmp = new DiffMatchPatch.diff_match_patch();
                var patches = dmp.patch_fromText(patchText);
                var result = dmp.patch_apply(patches, serverContent);
                var newContent = (string)result[0];
                var success = (bool[])result[1];

                // Cek apakah semua patch berhasil
                var allSuccess = true;
                foreach (var s in success)
                {
                    if (!s) { allSuccess = false; break; }
                }

                if (allSuccess && newContent != serverContent)
                {
                    // Patch berhasil — update server state
                    current.Content = newContent;
                    current.Version++;

                    // Broadcast patch ke peers (bukan pengirim)
                    // Peers akan apply patch ini ke shadow dan editor mereka
                    await Clients.OthersInGroup(GroupName(entryId))
                        .SendAsync("ReceivePatch", patchText, current.Version);

                    // Ack ke pengirim: patch accepted, kirim version baru
                    await Clients.Caller.SendAsync("PatchAck", current.Version);
                }
                else if (!allSuccess)
                {
                    // Patch gagal — kirim full state ke pengirim untuk resync
                    _logger.LogWarning("[Collab] Patch failed for {EntryId}, sending full resync", entryId);
                    await Clients.Caller.SendAsync("FullResync", current.Content, current.Version);
                }
                else
                {
                    // Patch berhasil tapi content tidak berubah (no-op)
                    await Clients.Caller.SendAsync("PatchAck", current.Version);
                }
            }
            finally
            {
                lock_.Release();
            }
        }

        /// <summary>
        /// Client kirim full content (untuk initial set atau force sync).
        /// </summary>
        public async Task SendFullContent(string entryId, string content)
        {
            if (string.IsNullOrEmpty(content)) return;

            var lock_ = _locks.GetOrAdd(entryId, _ => new SemaphoreSlim(1, 1));
            await lock_.WaitAsync();
            try
            {
                var current = _docStates.GetOrAdd(entryId, _ => new DocState());
                current.Content = content;
                current.Version++;

                // Broadcast full state ke peers
                await Clients.OthersInGroup(GroupName(entryId))
                    .SendAsync("ReceiveDocState", content, current.Version);

                await Clients.Caller.SendAsync("PatchAck", current.Version);
            }
            finally
            {
                lock_.Release();
            }
        }

        /// <summary>
        /// BACKWARD COMPAT: Client lama (collaboration.js) masih pakai SendHtmlUpdate.
        /// Ini menerima full content dan broadcast sebagai ReceiveUpdate + UpdateAck.
        /// </summary>
        public async Task SendHtmlUpdate(string entryId, string htmlContent, long clientVersion)
        {
            if (string.IsNullOrEmpty(htmlContent)) return;

            var lock_ = _locks.GetOrAdd(entryId, _ => new SemaphoreSlim(1, 1));
            await lock_.WaitAsync();
            try
            {
                var current = _docStates.GetOrAdd(entryId, _ => new DocState());
                var newVersion = current.Version + 1;
                current.Content = htmlContent;
                current.Version = newVersion;

                await Clients.OthersInGroup(GroupName(entryId))
                    .SendAsync("ReceiveUpdate", htmlContent, newVersion);

                await Clients.Caller.SendAsync("UpdateAck", newVersion, htmlContent);
            }
            finally
            {
                lock_.Release();
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
