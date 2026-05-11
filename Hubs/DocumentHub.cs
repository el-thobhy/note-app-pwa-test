// Hubs/DocumentHub.cs
using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;

public class DocumentHub : Hub
{
    private readonly YDocService _docService;
    private readonly ILogger<DocumentHub> _logger;

    // Track siapa saja yang ada di tiap doc room
    private static readonly ConcurrentDictionary<string, HashSet<string>> _rooms = new();
    private static readonly ConcurrentDictionary<string, string> _connToDoc = new();
    private static readonly object _roomLock = new();

    public DocumentHub(YDocService docService, ILogger<DocumentHub> logger)
    {
        _docService = docService;
        _logger = logger;
    }

    /// <summary>
    /// Client join ke room dokumen.
    /// Jika ada state tersimpan, kirim ke client baru.
    /// Jika tidak ada (room kosong), minta client pertama kirim state mereka.
    /// </summary>
    public async Task JoinDocument(string docId)
    {
        _logger.LogInformation("JoinDocument: {DocId}, Connection: {ConnectionId}", docId, Context.ConnectionId);

        _connToDoc[Context.ConnectionId] = docId;

        // Hitung peer yang sudah ada SEBELUM kita join group
        int peerCount;
        lock (_roomLock)
        {
            if (!_rooms.ContainsKey(docId))
                _rooms[docId] = new HashSet<string>();
            peerCount = _rooms[docId].Count; // jumlah peer sebelum kita masuk
            _rooms[docId].Add(Context.ConnectionId);
        }

        var state = _docService.GetOrCreateDoc(docId);

        if (state != null && state.Length > 0)
        {
            _logger.LogInformation("Sending stored state ({Length} bytes) to {ConnectionId}", state.Length, Context.ConnectionId);
            // Join group dulu baru kirim state
            await Groups.AddToGroupAsync(Context.ConnectionId, docId);
            await Clients.Caller.SendAsync("InitialState", state.Select(b => (int)b).ToArray());
        }
        else if (peerCount > 0)
        {
            // Ada peer — join group dulu, lalu minta peer kirim state ke kita
            await Groups.AddToGroupAsync(Context.ConnectionId, docId);
            await Clients.Caller.SendAsync("InitialState", Array.Empty<int>());
            _logger.LogInformation("Requesting state from {PeerCount} peer(s) for {DocId}", peerCount, docId);
            await Clients.OthersInGroup(docId).SendAsync("RequestFullState", Context.ConnectionId);
        }
        else
        {
            // Room kosong, kita yang pertama — tidak perlu minta state dari siapapun
            await Groups.AddToGroupAsync(Context.ConnectionId, docId);
            await Clients.Caller.SendAsync("InitialState", Array.Empty<int>());
            _logger.LogInformation("First client in room {DocId}, starting fresh", docId);
        }
    }

    /// <summary>
    /// Client kirim Y.Doc update → simpan dan broadcast ke semua di room.
    /// Client mengirim sebagai int[] karena SignalR JSON tidak support byte[] langsung.
    /// </summary>
    public async Task SendUpdate(string docId, int[] update)
    {
        try
        {
            if (update == null || update.Length == 0) return;

            var bytes = update.Select(i => (byte)i).ToArray();
            _docService.ApplyUpdate(docId, bytes);
            await Clients.OthersInGroup(docId).SendAsync("ReceiveUpdate", update);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in SendUpdate: docId={DocId}, updateLength={Length}", docId, update?.Length ?? 0);
            throw;
        }
    }

    /// <summary>
    /// Client kirim full state sebagai respons dari RequestFullState.
    /// </summary>
    public async Task SendFullState(string docId, string targetConnectionId, int[] fullState)
    {
        try
        {
            if (fullState == null || fullState.Length == 0) return;

            var bytes = fullState.Select(i => (byte)i).ToArray();
            _docService.SetFullState(docId, bytes);
            await Clients.Client(targetConnectionId).SendAsync("InitialState", fullState);
            _logger.LogInformation("Full state ({Length} bytes) forwarded to {Target}", fullState.Length, targetConnectionId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in SendFullState: docId={DocId}", docId);
            throw;
        }
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
