using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;

namespace NoteApp.Hubs
{
    /// <summary>
    /// SignalR hub untuk real-time collaboration per entry.
    ///
    /// Strategi: Operational Transform-lite dengan strict version guard.
    /// - Server menyimpan konten + version per entry (protected by SemaphoreSlim per entry)
    /// - Client kirim (entryId, htmlContent, baseVersion)
    ///   baseVersion = version yang client pakai sebagai base untuk merge
    /// - Server HANYA accept kalau baseVersion == serverVersion (strict equality)
    ///   Ini mencegah race condition saat 2 client kirim bersamaan
    /// - Kalau baseVersion != serverVersion → client ketinggalan, server kirim resync
    /// - Broadcast ke semua KECUALI pengirim
    /// - Pengirim terima UpdateAck(newVersion, serverContent) supaya bisa update base-nya
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

            if (_docStates.TryGetValue(entryId, out var state) && !string.IsNullOrEmpty(state.Content))
            {
                await Clients.Caller.SendAsync("ReceiveDocState", state.Content, state.Version);
            }

            await BroadcastUsers(entryId);
        }

        /// <summary>
        /// Client kirim update konten.
        /// baseVersion = version yang client pakai sebagai base saat merge.
        /// 
        /// STRICT version guard:
        /// - Accept HANYA kalau baseVersion == serverVersion (atau server kosong)
        /// - Reject kalau baseVersion != serverVersion → kirim Resync supaya client merge ulang
        /// 
        /// Ini mencegah race condition: kalau 2 client kirim bersamaan,
        /// yang pertama masuk akan accepted, yang kedua akan di-reject dan harus resync.
        /// </summary>
        public async Task SendHtmlUpdate(string entryId, string htmlContent, long baseVersion)
        {
            if (string.IsNullOrEmpty(htmlContent)) return;

            var lock_ = _locks.GetOrAdd(entryId, _ => new SemaphoreSlim(1, 1));
            await lock_.WaitAsync();
            try
            {
                var current = _docStates.GetValueOrDefault(entryId);
                var serverVersion = current?.Version ?? 0;

                // STRICT: accept hanya kalau base version match server version
                if (current == null || baseVersion == serverVersion)
                {
                    var newVersion = serverVersion + 1;
                    _docStates[entryId] = new DocState { Content = htmlContent, Version = newVersion };

                    // Broadcast ke peers (bukan pengirim)
                    await Clients.OthersInGroup(GroupName(entryId))
                        .SendAsync("ReceiveUpdate", htmlContent, newVersion);

                    // Ack ke pengirim: version baru + content yang disimpan server
                    // Client pakai ini untuk update _serverContent dan _serverVersion
                    await Clients.Caller
                        .SendAsync("UpdateAck", newVersion, htmlContent);
                }
                else
                {
                    // Client base version tidak match — ada update dari peer yang belum di-apply
                    // Kirim Resync: server content terbaru + version
                    // Client harus merge ulang pending-nya di atas state ini, lalu kirim ulang
                    _logger.LogDebug(
                        "[Collab] Version mismatch for {EntryId}: client base={BaseVer}, server={ServerVer}. Sending Resync.",
                        entryId, baseVersion, serverVersion);

                    await Clients.Caller
                        .SendAsync("Resync", current!.Content, current.Version);
                }
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
