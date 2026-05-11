// Services/YDocService.cs
// YDocService: akumulasi semua Yjs updates per dokumen.
// Server tidak parse konten — hanya relay dan akumulasi updates.
// Client baru menerima semua accumulated updates dan merge sendiri via Yjs CRDT.

public class YDocService
{
    // Simpan semua updates per docId (bukan hanya yang terakhir)
    private readonly Dictionary<string, List<byte[]>> _updates = new();
    private readonly object _lock = new();

    /// <summary>
    /// Ambil semua accumulated updates untuk dokumen.
    /// Client baru akan apply semua ini secara berurutan untuk rebuild state.
    /// </summary>
    public List<byte[]> GetUpdates(string docId)
    {
        lock (_lock)
        {
            return _updates.TryGetValue(docId, out var list)
                ? new List<byte[]>(list)   // return copy
                : new List<byte[]>();
        }
    }

    /// <summary>
    /// Tambahkan update baru ke akumulasi.
    /// </summary>
    public void AddUpdate(string docId, byte[] update)
    {
        lock (_lock)
        {
            if (!_updates.ContainsKey(docId))
                _updates[docId] = new List<byte[]>();
            _updates[docId].Add(update);
        }
    }

    /// <summary>
    /// Ganti seluruh state dengan full snapshot dari client.
    /// Dipakai saat client pertama join dan mengirim state awal.
    /// Ini menggantikan semua accumulated updates dengan satu snapshot bersih.
    /// </summary>
    public void SetSnapshot(string docId, byte[] snapshot)
    {
        lock (_lock)
        {
            _updates[docId] = new List<byte[]> { snapshot };
        }
    }

    /// <summary>
    /// Cek apakah ada state tersimpan untuk dokumen ini.
    /// </summary>
    public bool HasState(string docId)
    {
        lock (_lock)
        {
            return _updates.ContainsKey(docId) && _updates[docId].Count > 0;
        }
    }
}