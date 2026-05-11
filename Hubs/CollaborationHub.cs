using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;
using System.Text;
using HtmlAgilityPack;

namespace NoteApp.Hubs
{
    /// <summary>
    /// SignalR hub untuk real-time collaboration per entry.
    ///
    /// Strategi merge (server-authoritative 3-way merge):
    /// - Server menyimpan `base` = konten yang sudah disepakati semua client
    /// - Saat client kirim update, server lakukan:
    ///     peerDiff  = diff(clientBase, newContent)   → apa yang client ubah
    ///     localDiff = diff(serverBase, serverCurrent) → sudah tidak relevan, server IS the base
    ///     merged    = apply(peerDiff ke serverBase)
    /// - Hasil merge di-broadcast ke SEMUA client (termasuk pengirim)
    /// - Client cukup apply hasil merge dari server tanpa perlu merge sendiri
    /// </summary>
    public class CollaborationHub : Hub
    {
        // State per entryId: (currentContent, baseContent, version)
        private static readonly ConcurrentDictionary<string, DocState> _docStates = new();

        // connectionId -> user info
        private static readonly ConcurrentDictionary<string, CollabUser> _users = new();

        // connectionId -> entryId
        private static readonly ConcurrentDictionary<string, string> _connEntry = new();

        // Lock per entryId untuk serialisasi merge
        private static readonly ConcurrentDictionary<string, SemaphoreSlim> _entryLocks = new();

        private readonly ILogger<CollaborationHub> _logger;

        public CollaborationHub(ILogger<CollaborationHub> logger)
        {
            _logger = logger;
        }

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
            if (_docStates.TryGetValue(entryId, out var state) && !string.IsNullOrEmpty(state.Content))
            {
                await Clients.Caller.SendAsync("ReceiveDocState", state.Content, state.Version);
            }

            await BroadcastUsers(entryId);
        }

        /// <summary>
        /// Client kirim HTML update beserta base yang dia ketahui.
        /// Server lakukan 3-way merge dan broadcast hasilnya ke semua client.
        /// </summary>
        public async Task SendHtmlUpdate(string entryId, string htmlContent, string clientBase, long clientVersion)
        {
            if (string.IsNullOrEmpty(htmlContent)) return;

            var entryLock = _entryLocks.GetOrAdd(entryId, _ => new SemaphoreSlim(1, 1));
            await entryLock.WaitAsync();

            try
            {
                var current = _docStates.GetValueOrDefault(entryId, new DocState
                {
                    Content = htmlContent,
                    Base    = htmlContent,
                    Version = 0
                });

                string merged;

                // Kalau client version sama dengan server version, tidak ada divergence
                if (clientVersion >= current.Version || current.Content == clientBase)
                {
                    // Fast path: tidak ada conflict, langsung pakai konten client
                    merged = htmlContent;
                    _logger.LogDebug("[Collab] Fast path merge for entry {EntryId}", entryId);
                }
                else
                {
                    // 3-way merge: base = clientBase (titik divergence), local = server current, peer = client new
                    _logger.LogDebug("[Collab] 3-way merge for entry {EntryId}, serverVer={ServerVer}, clientVer={ClientVer}",
                        entryId, current.Version, clientVersion);
                    merged = ThreeWayMerge(clientBase, current.Content, htmlContent);
                }

                var newVersion = current.Version + 1;
                _docStates[entryId] = new DocState
                {
                    Content = merged,
                    Base    = merged,
                    Version = newVersion
                };

                // Broadcast hasil merge ke SEMUA client di room (termasuk pengirim).
                // Sertakan senderConnectionId supaya pengirim bisa skip setContent
                // tapi tetap update base dan version.
                await Clients.Group(GroupName(entryId))
                    .SendAsync("ReceiveUpdate", merged, newVersion, Context.ConnectionId);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[Collab] Merge failed for entry {EntryId}", entryId);

                // Fallback: simpan konten client, broadcast apa adanya
                var fallbackVersion = (_docStates.GetValueOrDefault(entryId)?.Version ?? 0) + 1;
                _docStates[entryId] = new DocState
                {
                    Content = htmlContent,
                    Base    = htmlContent,
                    Version = fallbackVersion
                };
                await Clients.Group(GroupName(entryId))
                    .SendAsync("ReceiveUpdate", htmlContent, fallbackVersion, Context.ConnectionId);
            }
            finally
            {
                entryLock.Release();
            }
        }

        /// <summary>
        /// Client kirim awareness (typing indicator).
        /// </summary>
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

        // ── Merge Logic ──────────────────────────────────────────────────────────

        /// <summary>
        /// 3-way merge berbasis teks (plain text dari HTML).
        ///
        /// base   = titik divergence (clientBase yang dikirim client)
        /// local  = konten server saat ini (sudah include perubahan client lain)
        /// peer   = konten baru dari client pengirim
        ///
        /// Strategi:
        /// 1. Extract plain text dari HTML untuk diff
        /// 2. Buat diff: base → peer (apa yang client ubah)
        /// 3. Apply diff tersebut ke local (konten server)
        /// 4. Kalau conflict, peer wins untuk bagian yang conflict
        /// </summary>
        private static string ThreeWayMerge(string base_, string local, string peer)
        {
            // Kalau salah satu sama dengan base, tidak perlu merge
            if (local == base_) return peer;
            if (peer  == base_) return local;
            if (local == peer)  return local;

            try
            {
                // Extract plain text untuk diff yang lebih akurat
                var baseText  = ExtractText(base_);
                var localText = ExtractText(local);
                var peerText  = ExtractText(peer);

                // Kalau text sama, kembalikan peer (peer punya HTML terbaru)
                if (localText == peerText) return peer;

                // Lakukan diff-based merge pada level karakter
                var merged = MergeTexts(baseText, localText, peerText);

                // Kalau hasil merge sama dengan peer text, kembalikan peer HTML
                if (merged == peerText) return peer;
                // Kalau sama dengan local text, kembalikan local HTML
                if (merged == localText) return local;

                // Ada true merge — inject merged text ke dalam struktur HTML peer
                return InjectTextIntoHtml(peer, merged);
            }
            catch
            {
                // Fallback: peer wins
                return peer;
            }
        }

        /// <summary>
        /// Merge tiga versi teks menggunakan diff line-by-line.
        /// Conflict resolution: peer wins.
        /// </summary>
        private static string MergeTexts(string baseText, string localText, string peerText)
        {
            var baseLines  = SplitLines(baseText);
            var localLines = SplitLines(localText);
            var peerLines  = SplitLines(peerText);

            var localDiff = ComputeLineDiff(baseLines, localLines);
            var peerDiff  = ComputeLineDiff(baseLines, peerLines);

            var result = new List<string>();
            int bi = 0, li = 0, pi = 0;

            while (bi < baseLines.Count || li < localLines.Count || pi < peerLines.Count)
            {
                // Ambil operasi berikutnya dari masing-masing diff
                var localOp = li < localDiff.Count ? localDiff[li] : null;
                var peerOp  = pi < peerDiff.Count  ? peerDiff[pi]  : null;

                if (localOp == null && peerOp == null) break;

                // Keduanya equal (tidak ada perubahan)
                if ((localOp?.Type == DiffType.Equal) && (peerOp?.Type == DiffType.Equal))
                {
                    result.Add(localOp.Line);
                    li++; pi++; bi++;
                }
                // Hanya local yang berubah
                else if (peerOp?.Type == DiffType.Equal && localOp?.Type != DiffType.Equal)
                {
                    if (localOp?.Type == DiffType.Insert)
                    {
                        result.Add(localOp.Line);
                        li++;
                    }
                    else if (localOp?.Type == DiffType.Delete)
                    {
                        li++; bi++;
                    }
                    else { result.Add(peerOp?.Line ?? ""); pi++; bi++; }
                }
                // Hanya peer yang berubah
                else if (localOp?.Type == DiffType.Equal && peerOp?.Type != DiffType.Equal)
                {
                    if (peerOp?.Type == DiffType.Insert)
                    {
                        result.Add(peerOp.Line);
                        pi++;
                    }
                    else if (peerOp?.Type == DiffType.Delete)
                    {
                        pi++; bi++;
                    }
                    else { result.Add(localOp?.Line ?? ""); li++; bi++; }
                }
                // Keduanya berubah — conflict, peer wins
                else
                {
                    if (peerOp?.Type == DiffType.Insert)
                    {
                        result.Add(peerOp.Line);
                        pi++;
                    }
                    else if (peerOp?.Type == DiffType.Delete)
                    {
                        pi++; bi++;
                        if (localOp?.Type == DiffType.Delete) li++;
                    }
                    else if (localOp?.Type == DiffType.Insert)
                    {
                        result.Add(localOp.Line);
                        li++;
                    }
                    else
                    {
                        // Keduanya delete baris yang sama
                        li++; pi++; bi++;
                    }
                }
            }

            return string.Join("\n", result);
        }

        private static List<DiffOp> ComputeLineDiff(List<string> baseLines, List<string> newLines)
        {
            // LCS-based line diff
            int m = baseLines.Count, n = newLines.Count;
            var dp = new int[m + 1, n + 1];

            for (int i = m - 1; i >= 0; i--)
                for (int j = n - 1; j >= 0; j--)
                    dp[i, j] = baseLines[i] == newLines[j]
                        ? dp[i + 1, j + 1] + 1
                        : Math.Max(dp[i + 1, j], dp[i, j + 1]);

            var result = new List<DiffOp>();
            int bi = 0, ni = 0;
            while (bi < m || ni < n)
            {
                if (bi < m && ni < n && baseLines[bi] == newLines[ni])
                {
                    result.Add(new DiffOp(DiffType.Equal, baseLines[bi]));
                    bi++; ni++;
                }
                else if (ni < n && (bi >= m || dp[bi, ni + 1] >= dp[bi + 1, ni]))
                {
                    result.Add(new DiffOp(DiffType.Insert, newLines[ni]));
                    ni++;
                }
                else
                {
                    result.Add(new DiffOp(DiffType.Delete, baseLines[bi]));
                    bi++;
                }
            }
            return result;
        }

        private static List<string> SplitLines(string text) =>
            text.Split('\n').ToList();

        private static string ExtractText(string html)
        {
            if (string.IsNullOrEmpty(html)) return "";
            try
            {
                var doc = new HtmlDocument();
                doc.LoadHtml(html);
                return doc.DocumentNode.InnerText;
            }
            catch
            {
                return html;
            }
        }

        private static string InjectTextIntoHtml(string templateHtml, string mergedText)
        {
            // Sederhana: wrap merged text dalam struktur HTML yang sama dengan template
            // Untuk HTML editor seperti TinyMCE, ini cukup karena struktur paragraf dipertahankan
            try
            {
                var doc = new HtmlDocument();
                doc.LoadHtml(templateHtml);

                // Cari semua text node dan replace dengan merged text
                // Ini simplified — untuk kasus kompleks bisa dikembangkan lebih lanjut
                var textNodes = doc.DocumentNode
                    .SelectNodes("//text()[normalize-space(.) != '']");

                if (textNodes != null && textNodes.Count > 0)
                {
                    // Distribute merged text ke paragraf-paragraf yang ada
                    var paragraphs = mergedText.Split('\n', StringSplitOptions.RemoveEmptyEntries);
                    var pNodes = doc.DocumentNode.SelectNodes("//p | //div | //li");

                    if (pNodes != null && paragraphs.Length > 0)
                    {
                        int pIdx = 0;
                        foreach (var node in pNodes)
                        {
                            if (pIdx < paragraphs.Length)
                            {
                                node.InnerHtml = HtmlDocument.HtmlEncode(paragraphs[pIdx]);
                                pIdx++;
                            }
                            else
                            {
                                node.InnerHtml = "";
                            }
                        }
                        return doc.DocumentNode.OuterHtml;
                    }
                }
            }
            catch { /* fallback below */ }

            // Fallback: kembalikan peer HTML
            return templateHtml;
        }

        // ── Helpers ──────────────────────────────────────────────────────────────

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

    // ── Supporting types ─────────────────────────────────────────────────────────

    public class DocState
    {
        public string Content { get; set; } = "";
        public string Base    { get; set; } = "";
        public long   Version { get; set; } = 0;
    }

    public enum DiffType { Equal, Insert, Delete }

    public class DiffOp
    {
        public DiffType Type { get; }
        public string   Line { get; }
        public DiffOp(DiffType type, string line) { Type = type; Line = line; }
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
