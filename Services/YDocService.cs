// Services/YDocService.cs
// YDocService: menyimpan Yjs document state di server sebagai raw bytes.
// Server tidak perlu parse isi dokumen — cukup simpan state vector
// dan relay update antar client. YDotNet native DLL tidak dibutuhkan.

public class YDocService
{
    private readonly Dictionary<string, byte[]> _states = new();
    private readonly object _lock = new();

    /// <summary>
    /// Ambil state dokumen. Jika belum ada, return empty array.
    /// Client akan kirim full state saat pertama join.
    /// </summary>
    public byte[] GetOrCreateDoc(string docId)
    {
        lock (_lock)
        {
            return _states.TryGetValue(docId, out var state) ? state : Array.Empty<byte>();
        }
    }

    /// <summary>
    /// Merge update baru ke stored state.
    /// Karena kita tidak parse Yjs di server, kita simpan update terakhir
    /// sebagai "latest full state" yang dikirim ke client baru.
    /// </summary>
    public void ApplyUpdate(string docId, byte[] update)
    {
        lock (_lock)
        {
            // Simpan update terbaru — client yang join belakangan
            // akan menerima ini dan merge ke local doc mereka
            _states[docId] = update;
        }
    }

    /// <summary>
    /// Simpan full state dari client (dipakai saat client pertama join dan kirim state).
    /// </summary>
    public void SetFullState(string docId, byte[] fullState)
    {
        lock (_lock)
        {
            _states[docId] = fullState;
        }
    }
}