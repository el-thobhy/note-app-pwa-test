using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;

namespace NoteApp.Hubs
{
    /// <summary>
    /// SignalR hub untuk real-time collaboration per entry.
    /// Setiap entry memiliki room tersendiri: "entry-{entryId}".
    /// Server menyimpan HTML content terakhir per entry di memory.
    /// </summary>
    public class CollaborationHub : Hub
    {
        // HTML content terakhir per entryId
        private static readonly ConcurrentDictionary<string, string> _docStates = new();

        // connectionId -> user info
        private static readonly ConcurrentDictionary<string, CollabUser> _users = new();

        // connectionId -> entryId
        private static readonly ConcurrentDictionary<string, string> _connEntry = new();

        /// <summary>
        /// Client join ke room entry. Server kirim state terakhir ke user baru.
        /// </summary>
        public async Task JoinEntry(string entryId, string displayName, string avatar)
        {
            var group = GroupName(entryId);
            await Groups.AddToGroupAsync(Context.ConnectionId, group);

            _connEntry[Context.ConnectionId] = entryId;
            _users[Context.ConnectionId] = new CollabUser
            {
                ConnectionId = Context.ConnectionId,
                DisplayName  = displayName,
                Avatar       = avatar,
                EntryId      = entryId,
                Color        = GenerateColor(Context.ConnectionId)
            };

            // Kirim state dokumen saat ini ke user yang baru join
            if (_docStates.TryGetValue(entryId, out var html) && !string.IsNullOrEmpty(html))
            {
                await Clients.Caller.SendAsync("ReceiveDocState", html);
            }

            await BroadcastUsers(entryId);
        }

        /// <summary>
        /// Client kirim HTML content → server simpan & broadcast ke semua di room.
        /// </summary>
        public async Task SendHtmlUpdate(string entryId, string htmlContent)
        {
            _docStates[entryId] = htmlContent;
            await Clients.OthersInGroup(GroupName(entryId)).SendAsync("ReceiveUpdate", htmlContent);
        }

        /// <summary>
        /// Client kirim awareness (typing indicator).
        /// </summary>
        public async Task SendAwareness(string entryId, object awarenessData)
        {
            var user = _users.GetValueOrDefault(Context.ConnectionId);
            await Clients.OthersInGroup(GroupName(entryId)).SendAsync("ReceiveAwareness", new
            {
                connectionId = Context.ConnectionId,
                displayName  = user?.DisplayName ?? "Unknown",
                color        = user?.Color ?? "#888",
                isTyping     = ((dynamic)awarenessData).isTyping
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
            var colors = new[]
            {
                "#e74c3c", "#3498db", "#2ecc71", "#f39c12",
                "#9b59b6", "#1abc9c", "#e67e22", "#e91e63"
            };
            return colors[Math.Abs(connectionId.GetHashCode()) % colors.Length];
        }
    }

    public class CollabUser
    {
        public string ConnectionId { get; set; } = "";
        public string DisplayName  { get; set; } = "";
        public string Avatar       { get; set; } = "";
        public string EntryId      { get; set; } = "";
        public string Color        { get; set; } = "";
    }
}
