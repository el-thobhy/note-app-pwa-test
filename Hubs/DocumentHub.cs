// Hubs/DocumentHub.cs
using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;

public class DocumentHub : Hub
{
    private readonly YDocService _docService;
    private readonly ILogger<DocumentHub> _logger;

    private static readonly ConcurrentDictionary<string, HashSet<string>> _rooms = new();
    private static readonly ConcurrentDictionary<string, string> _connToDoc = new();
    private static readonly object _roomLock = new();

    public DocumentHub(YDocService docService, ILogger<DocumentHub> logger)
    {
        _docService = docService;
        _logger = logger;
    }

    public async Task JoinDocument(string docId)
    {
        _connToDoc[Context.ConnectionId] = docId;

        int peerCount;
        lock (_roomLock)
        {
            if (!_rooms.ContainsKey(docId))
                _rooms[docId] = new HashSet<string>();
            peerCount = _rooms[docId].Count;
            _rooms[docId].Add(Context.ConnectionId);
        }

        await Groups.AddToGroupAsync(Context.ConnectionId, docId);

        _logger.LogInformation("JoinDocument: {DocId}, peers before join: {PeerCount}", docId, peerCount);

        if (_docService.HasState(docId))
        {
            // Kirim semua accumulated updates ke client baru
            // Client akan apply semua secara berurutan → state konsisten
            var updates = _docService.GetUpdates(docId);
            _logger.LogInformation("Sending {Count} accumulated updates to new client", updates.Count);

            foreach (var update in updates)
            {
                await Clients.Caller.SendAsync("ReceiveUpdate", update.Select(b => (int)b).ToArray());
            }

            // Sinyal bahwa initial sync selesai
            await Clients.Caller.SendAsync("SyncComplete");
        }
        else if (peerCount > 0)
        {
            // Ada peer tapi belum ada state tersimpan
            // Minta peer kirim full state
            await Clients.OthersInGroup(docId).SendAsync("RequestFullState", Context.ConnectionId);
        }
        else
        {
            // Room kosong, client pertama
            await Clients.Caller.SendAsync("SyncComplete");
        }
    }

    /// <summary>
    /// Client kirim update → akumulasi di server + broadcast ke peers.
    /// </summary>
    public async Task SendUpdate(string docId, int[] update)
    {
        if (update == null || update.Length == 0) return;

        var bytes = update.Select(i => (byte)i).ToArray();

        // Akumulasi update di server
        _docService.AddUpdate(docId, bytes);

        // Broadcast ke semua peer (kecuali pengirim)
        await Clients.OthersInGroup(docId).SendAsync("ReceiveUpdate", update);
    }

    /// <summary>
    /// Client kirim full state (snapshot) sebagai respons RequestFullState.
    /// Ini menggantikan semua accumulated updates dengan snapshot bersih.
    /// </summary>
    public async Task SendFullState(string docId, string targetConnectionId, int[] fullState)
    {
        if (fullState == null || fullState.Length == 0) return;

        var bytes = fullState.Select(i => (byte)i).ToArray();

        // Simpan sebagai snapshot bersih
        _docService.SetSnapshot(docId, bytes);

        // Forward ke target client
        await Clients.Client(targetConnectionId).SendAsync("ReceiveUpdate",
            fullState);
        await Clients.Client(targetConnectionId).SendAsync("SyncComplete");

        _logger.LogInformation("Snapshot ({Length} bytes) sent to {Target}", bytes.Length, targetConnectionId);
    }

    public async Task LeaveDocument(string docId)
    {
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, docId);
        lock (_roomLock)
        {
            if (_rooms.TryGetValue(docId, out var room))
                room.Remove(Context.ConnectionId);
        }
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (_connToDoc.TryRemove(Context.ConnectionId, out var docId))
        {
            lock (_roomLock)
            {
                if (_rooms.TryGetValue(docId, out var room))
                    room.Remove(Context.ConnectionId);
            }
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, docId);
        }
        await base.OnDisconnectedAsync(exception);
    }
}
