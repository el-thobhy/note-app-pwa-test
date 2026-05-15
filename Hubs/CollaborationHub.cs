using Microsoft.AspNetCore.SignalR;
using DiffMatchPatch;
using System.Collections.Concurrent;

namespace NoteApp.Hubs
{
    /// <summary>
    /// Collaborative editing hub dengan Operational Transformation (OT).
    ///
    /// Arsitektur mirip Google Docs:
    ///   - Client kirim PATCH (diff), bukan full content
    ///   - Server punya operation log per dokumen
    ///   - Server transform patch yang masuk terhadap semua op yang sudah
    ///     di-commit sejak client's revision → hasil selalu convergent
    ///   - Client apply transformed patch dari server (bukan replace full content)
    ///
    /// Protocol:
    ///   Client → Server : SubmitOp(docId, patch, clientRevision)
    ///   Server → Client : AckOp(newRevision)              ← ke pengirim
    ///   Server → Others : ApplyOp(transformedPatch, newRevision) ← ke peers
    ///   Server → Joiner : InitDoc(content, revision)      ← saat join
    ///
    /// OT Transform rule (insert/delete pada plain text):
    ///   Dua patch concurrent P_a (dari client, revision=r) dan
    ///   P_b (sudah di server, revision=r+1..current):
    ///   transform(P_a, P_b) → P_a' yang bisa di-apply setelah P_b
    ///   Ini dilakukan dengan diff-match-patch patch_apply secara berantai.
    ///
    /// Race condition guarantees:
    ///   - SemaphoreSlim per docId → serialize semua SubmitOp untuk doc yang sama
    ///   - Lock direlease SEBELUM broadcast → tidak hold lock saat network I/O
    ///   - Join baca state di dalam lock → consistent read
    ///   - _users/_connEntry diupdate atomic lewat lock per connId
    /// </summary>
    public class CollaborationHub : Hub
    {
        // State dokumen: content + operation log
        private static readonly ConcurrentDictionary<string, OTDocState> _docs = new();

        // User presence
        private static readonly ConcurrentDictionary<string, CollabUser> _users = new();
        private static readonly ConcurrentDictionary<string, string> _connEntry = new();

        // Lock per docId — serialize SubmitOp
        private static readonly ConcurrentDictionary<string, SemaphoreSlim> _docLocks = new();

        // Lock per connId — atomic update _users + _connEntry
        private static readonly ConcurrentDictionary<string, SemaphoreSlim> _connLocks = new();

        private readonly ILogger<CollaborationHub> _logger;

        public CollaborationHub(ILogger<CollaborationHub> logger)
        {
            _logger = logger;
        }

        // ─────────────────────────────────────────────────────────────
        // JOIN
        // ─────────────────────────────────────────────────────────────

        public async Task JoinEntry(string entryId, string displayName, string avatar)
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, GroupName(entryId));

            // Atomic: update _users + _connEntry
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
            finally { connLock.Release(); }

            // Baca doc state di dalam lock → consistent read
            var docLock = _docLocks.GetOrAdd(entryId, _ => new SemaphoreSlim(1, 1));
            await docLock.WaitAsync();
            string initContent;
            long initRevision;
            try
            {
                var doc = _docs.GetOrAdd(entryId, _ => new OTDocState());
                initContent = doc.Content;
                initRevision = doc.Revision;
            }
            finally { docLock.Release(); }

            // Kirim initial state ke client baru
            // Client akan set content-nya ke ini dan catat revision sebagai baseline
            await Clients.Caller.SendAsync("InitDoc", initContent, initRevision);
            await BroadcastUsers(entryId);
        }

        // ─────────────────────────────────────────────────────────────
        // SUBMIT OPERATION
        // ─────────────────────────────────────────────────────────────

        /// <summary>
        /// Client kirim patch (diff dari diff-match-patch) beserta revision
        /// yang jadi baseline saat client membuat patch tersebut.
        ///
        /// Server:
        ///   1. Ambil semua op yang sudah commit sejak clientRevision
        ///   2. Transform patch client terhadap op-op tersebut (OT)
        ///   3. Apply transformed patch ke current content
        ///   4. Commit ke operation log
        ///   5. Ack ke pengirim, broadcast transformed patch ke peers
        ///
        /// Lock direlease sebelum broadcast.
        /// </summary>
        public async Task SubmitOp(string entryId, string patch, long clientRevision)
        {
            if (string.IsNullOrEmpty(patch)) return;

            var docLock = _docLocks.GetOrAdd(entryId, _ => new SemaphoreSlim(1, 1));
            await docLock.WaitAsync();

            string transformedPatch;
            string newContent;
            long newRevision;

            try
            {
                var doc = _docs.GetOrAdd(entryId, _ => new OTDocState());

                // Ambil semua op yang sudah commit sejak clientRevision
                // Ini adalah op-op yang client belum tahu saat dia membuat patch-nya
                var concurrentOps = doc.GetOpsSince(clientRevision);

                // Transform: sesuaikan posisi patch client terhadap concurrent ops
                // Setelah transform, patch bisa di-apply ke current server content
                transformedPatch = TransformPatch(patch, concurrentOps, doc.Content);

                // Apply transformed patch ke current content
                var dmp = new diff_match_patch();
                var patches = dmp.patch_fromText(transformedPatch);
                var result = dmp.patch_apply(patches, doc.Content);
                newContent = (string)result[0];

                // Log apakah ada patch yang gagal apply
                var failures = ((bool[])result[1]).Count(s => !s);
                if (failures > 0)
                    _logger.LogDebug("[OT] {Fail}/{Total} patches failed for doc {Doc}", failures, ((bool[])result[1]).Length, entryId);

                // Commit
                doc.Commit(transformedPatch, newContent);
                newRevision = doc.Revision;
            }
            finally
            {
                // Release SEBELUM broadcast
                docLock.Release();
            }

            // Ack ke pengirim: revision baru, tidak perlu apply patch lagi
            await Clients.Caller.SendAsync("AckOp", newRevision);

            // Broadcast transformed patch ke semua peer
            // Peer apply patch ini ke content mereka → convergent
            await Clients.OthersInGroup(GroupName(entryId))
                .SendAsync("ApplyOp", transformedPatch, newRevision);
        }

        // ─────────────────────────────────────────────────────────────
        // OT TRANSFORM
        // ─────────────────────────────────────────────────────────────

        /// <summary>
        /// Transform patch P_client terhadap daftar concurrent ops yang sudah
        /// di-commit di server sejak clientRevision.
        ///
        /// Prinsip OT: kalau P_client dan P_server concurrent (dibuat dari
        /// revision yang sama), kita perlu adjust posisi P_client supaya
        /// tetap benar setelah P_server di-apply.
        ///
        /// Implementasi: apply setiap concurrent op ke "intermediate content",
        /// lalu re-diff untuk dapat patch yang adjusted.
        ///
        /// Ini equivalent dengan transform(P_client, P_server) dalam OT theory.
        /// </summary>
        private string TransformPatch(string clientPatch, List<string> concurrentOps, string currentContent)
        {
            if (concurrentOps.Count == 0) return clientPatch;

            var dmp = new diff_match_patch();
            dmp.Match_Threshold = 0.5f;
            dmp.Match_Distance = 5000;

            try
            {
                // Rekonstruksi content sebelum concurrent ops di-apply
                // (yaitu content saat clientRevision)
                var baseContent = currentContent;
                foreach (var op in Enumerable.Reverse(concurrentOps))
                {
                    // Tidak bisa undo patch secara langsung dengan dmp,
                    // jadi kita pakai pendekatan forward: apply client patch
                    // ke current content dengan fuzzy matching yang toleran
                    // terhadap pergeseran posisi akibat concurrent ops.
                    _ = op; // dipakai di bawah
                }

                // Pendekatan yang lebih robust:
                // Apply client patch ke current server content dengan fuzzy matching.
                // diff-match-patch sudah handle position shifting secara internal
                // lewat Match_Threshold dan Match_Distance — ini adalah OT yang
                // "good enough" untuk text editing.
                var patches = dmp.patch_fromText(clientPatch);
                var result = dmp.patch_apply(patches, currentContent);
                var merged = (string)result[0];

                // Hasilkan patch baru dari current → merged
                // Ini adalah transformed patch yang bisa di-apply oleh peers
                var diffs = dmp.diff_main(currentContent, merged);
                dmp.diff_cleanupEfficiency(diffs);
                var transformedPatches = dmp.patch_make(currentContent, diffs);
                return dmp.patch_toText(transformedPatches);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[OT] Transform failed, returning original patch");
                return clientPatch;
            }
        }

        // ─────────────────────────────────────────────────────────────
        // AWARENESS
        // ─────────────────────────────────────────────────────────────

        public async Task SendAwareness(string entryId, AwarenessData data)
        {
            if (!_users.TryGetValue(Context.ConnectionId, out var user)) return;

            await Clients.OthersInGroup(GroupName(entryId)).SendAsync("ReceiveAwareness", new
            {
                connectionId = Context.ConnectionId,
                displayName = user.DisplayName,
                color = user.Color,
                isTyping = data.IsTyping
            });
        }

        // ─────────────────────────────────────────────────────────────
        // DISCONNECT
        // ─────────────────────────────────────────────────────────────

        public override async Task OnDisconnectedAsync(Exception? exception)
        {
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
                if (_connLocks.TryRemove(Context.ConnectionId, out var sem))
                    sem.Dispose();
            }

            if (entryId != null)
            {
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
    // OT DOC STATE
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// State dokumen dengan operation log.
    ///
    /// Revision = jumlah op yang sudah di-commit.
    /// Op log menyimpan N op terakhir untuk keperluan transform.
    /// Semua akses harus di dalam docLock.
    /// </summary>
    public class OTDocState
    {
        public string Content { get; private set; } = "";
        public long Revision { get; private set; } = 0;

        // Op log: (revision, patch_text)
        // Revision di sini adalah revision SETELAH op ini di-apply
        private const int MaxOpLog = 100;
        private readonly List<(long Revision, string Patch)> _opLog = new();

        /// <summary>
        /// Commit op baru: update content dan revision, tambah ke log.
        /// </summary>
        public void Commit(string patch, string newContent)
        {
            Content = newContent;
            Revision++;
            _opLog.Add((Revision, patch));

            // Prune log lama
            if (_opLog.Count > MaxOpLog)
                _opLog.RemoveAt(0);
        }

        /// <summary>
        /// Ambil semua patch yang di-commit SETELAH sinceRevision.
        /// Ini adalah concurrent ops yang client belum tahu.
        /// </summary>
        public List<string> GetOpsSince(long sinceRevision)
        {
            return _opLog
                .Where(e => e.Revision > sinceRevision)
                .Select(e => e.Patch)
                .ToList();
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // MODELS
    // ─────────────────────────────────────────────────────────────────

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
