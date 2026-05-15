using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;
using NoteApp.Services;

namespace NoteApp.Hubs
{
    /// <summary>
    /// SignalR hub untuk real-time collaboration per entry.
    ///
    /// Strategi: server last-write-wins (LWW) dengan version guard.
    ///
    /// Alur:
    ///   Client kirim (entryId, htmlContent, clientVersion)
    ///   → Server accept kalau clientVersion >= serverVersion:
    ///       simpan, broadcast ke peers, kirim UpdateAck ke pengirim
    ///   → Server reject kalau client ketinggalan:
    ///       kirim ReceiveUpdate dengan state terbaru ke pengirim
    ///       client merge sendiri (3-way merge di JS) lalu kirim ulang
    ///
    /// Race condition guarantees:
    ///   - SemaphoreSlim per entryId → serialize semua SendHtmlUpdate untuk entry yang sama
    ///   - Lock direlease SEBELUM broadcast → tidak hold lock saat network I/O
    ///   - JoinEntry load content dari DB kalau belum ada di memory
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

            // Ambil atau inisialisasi state dokumen
            var docLock = _locks.GetOrAdd(entryId, _ => new SemaphoreSlim(1, 1));
            await docLock.WaitAsync();
            DocState state;
            try
            {
                state = _docStates.GetOrAdd(entryId, _ =>
                {
                    var s = new DocState();
                    // Load dari DB kalau belum ada di memory
                    if (int.TryParse(entryId, out var id))
                    {
                        try
                        {
                            var entry = _entryService.GetEntryById(id);
                            if (entry?.Content != null)
                                s.Content = entry.Content;
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

            // Kirim initial state ke client baru
            await Clients.Caller.SendAsync("ReceiveDocState", state.Content, state.Version);
            await BroadcastUsers(entryId);
        }

        // ─────────────────────────────────────────────────────────────
        // SEND UPDATE
        // ─────────────────────────────────────────────────────────────

        /// <summary>
        /// Client kirim update konten.
        /// clientVersion = version terakhir yang client ketahui dari server.
        ///
        /// Accept kalau clientVersion >= serverVersion (client up-to-date).
        /// Reject kalau client ketinggalan → kirim state terbaru untuk resync.
        /// Lock direlease sebelum broadcast.
        /// </summary>
        public async Task SendHtmlUpdate(string entryId, string htmlContent, long clientVersion)
        {
            if (string.IsNullOrEmpty(htmlContent)) return;

            var docLock = _locks.GetOrAdd(entryId, _ => new SemaphoreSlim(1, 1));
            await docLock.WaitAsync();

            bool accepted;
            long newVersion;
            string currentContent;
            long currentVersion;

            try
            {
                var current = _docStates.GetOrAdd(entryId, _ => new DocState());
                currentContent = current.Content;
                currentVersion = current.Version;

                if (clientVersion >= current.Version)
                {
                    // Accept: client up-to-date
                    newVersion       = current.Version + 1;
                    current.Content  = htmlContent;
                    current.Version  = newVersion;
                    accepted         = true;
                }
                else
                {
                    // Reject: client ketinggalan
                    _logger.LogDebug("[Collab] Reject entry={EntryId} clientVer={ClientVer} serverVer={ServerVer}",
                        entryId, clientVersion, current.Version);
                    accepted    = false;
                    newVersion  = current.Version;
                }
            }
            finally
            {
                // Release SEBELUM broadcast
                docLock.Release();
            }

            if (accepted)
            {
                // Broadcast ke peers
                await Clients.OthersInGroup(GroupName(entryId))
                    .SendAsync("ReceiveUpdate", htmlContent, newVersion);
                // Ack ke pengirim
                await Clients.Caller
                    .SendAsync("UpdateAck", newVersion);
            }
            else
            {
                // Kirim state terbaru ke pengirim untuk resync
                await Clients.Caller
                    .SendAsync("ReceiveUpdate", currentContent, currentVersion);
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
