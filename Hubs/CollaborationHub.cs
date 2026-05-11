using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;

namespace NoteApp.Hubs
{
    /// <summary>
    /// SignalR hub untuk real-time collaboration per entry.
    ///
    /// Strategi (server-authoritative, last-write-wins dengan version guard):
    /// - Server menyimpan konten + version per entry
    /// - Client kirim (entryId, htmlContent, clientVersion)
    /// - Server hanya accept update kalau clientVersion == serverVersion (tidak ada gap)
    ///   Kalau ada gap (client ketinggalan update), server kirim balik state terbaru
    ///   supaya client bisa resync, lalu client kirim ulang dengan base yang benar
    /// - Broadcast ke semua KECUALI pengirim (pengirim sudah punya kontennya sendiri)
    /// - Pengirim terima ack (version terbaru) supaya bisa track apakah update diterima
    /// </summary>
    public class CollaborationHub : Hub
    {
        private static readonly ConcurrentDictionary<string, DocState> _docStates  = new();
        private static readonly ConcurrentDictionary<string, CollabUser> _users     = new();
        private static readonly ConcurrentDictionary<string, string> _connEntry     = new();
        private static readonly ConcurrentDictionary<string, SemaphoreSlim> _locks  = new();

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
                DisplayName  = displayName,
                Avatar       = avatar,
                EntryId      = entryId,
                Color        = GenerateColor(Context.ConnectionId)
            };

            if (_docStates.TryGetValue(entryId, out var state) && !string.IsNullOrEmpty(state.Content))
            {
                await Clients.Caller.SendAsync("ReceiveDocState", state.Content, state.Version);
            }

            await BroadcastUsers(entryId);
        }

        /// <summary>
        /// Client kirim update konten.
        /// clientVersion = version terakhir yang client ketahui dari server.
        /// </summary>
        public async Task SendHtmlUpdate(string entryId, string htmlContent, long clientVersion)
        {
            if (string.IsNullOrEmpty(htmlContent)) return;

            var lock_ = _locks.GetOrAdd(entryId, _ => new SemaphoreSlim(1, 1));
            await lock_.WaitAsync();
            try
            {
                var current = _docStates.GetValueOrDefault(entryId);

                // Client sudah up-to-date — accept update, simpan, broadcast ke peers
                if (current == null || clientVersion >= current.Version)
                {
                    var newVersion = (current?.Version ?? 0) + 1;
                    _docStates[entryId] = new DocState { Content = htmlContent, Version = newVersion };

                    // Broadcast ke peers (bukan pengirim) — pengirim sudah punya kontennya
                    await Clients.OthersInGroup(GroupName(entryId))
                        .SendAsync("ReceiveUpdate", htmlContent, newVersion);

                    // Kirim ack ke pengirim supaya dia tahu version terbaru
                    await Clients.Caller
                        .SendAsync("UpdateAck", newVersion);
                }
                else
                {
                    // Client ketinggalan update — kirim state terbaru supaya client resync
                    // Client akan apply state ini, update base-nya, lalu kirim ulang perubahannya
                    _logger.LogDebug("[Collab] Client behind for entry {EntryId}, clientVer={ClientVer}, serverVer={ServerVer}",
                        entryId, clientVersion, current.Version);

                    await Clients.Caller
                        .SendAsync("ReceiveUpdate", current.Content, current.Version);
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
