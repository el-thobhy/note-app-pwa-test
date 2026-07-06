using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using HtmlAgilityPack;
using NoteApp.Services;

namespace NoteApp.Hubs
{
    /// <summary>
    /// Real-time collaboration hub — server-authoritative merge.
    ///
    /// Kunci desain:
    ///   - BaseContent disimpan PER CLIENT (per connectionId), bukan shared.
    ///     Setiap client punya snapshot dari state saat mereka terakhir sync.
    ///     Ini adalah "titik divergence" yang akurat untuk 3-way merge.
    ///
    ///   - Alur SendHtmlUpdate:
    ///     1. Client kirim (content, clientVersion)
    ///     2. Server ambil BaseContent milik client ini (snapshot terakhir yang client tahu)
    ///     3. Kalau clientVersion == serverVersion → no conflict, accept as-is
    ///     4. Kalau clientVersion &lt; serverVersion → conflict:
    ///        merge(clientBase, clientContent, serverContent)
    ///        = "apply perubahan client di atas state server terbaru"
    ///     5. Update BaseContent client = merged result (untuk merge berikutnya)
    ///     6. Broadcast ke semua
    ///
    ///   - Lock per entry → serialize semua writes, tidak ada concurrent write
    ///   - Lock release sebelum broadcast → tidak hold lock saat network I/O
    /// </summary>
    public class CollaborationHub : Hub
    {
        private static readonly ConcurrentDictionary<string, DocState>      _docStates   = new();
        private static readonly ConcurrentDictionary<string, CollabUser>    _users       = new();
        private static readonly ConcurrentDictionary<string, string>        _connEntry   = new();
        private static readonly ConcurrentDictionary<string, SemaphoreSlim> _locks       = new();
        // BaseContent per client: key = connectionId, value = last known content
        private static readonly ConcurrentDictionary<string, string>        _clientBases = new();

        private readonly ILogger<CollaborationHub> _logger;
        private readonly IDailyEntryService _entryService;

        public CollaborationHub(ILogger<CollaborationHub> logger, IDailyEntryService entryService)
        {
            _logger       = logger;
            _entryService = entryService;
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

            var docLock = _locks.GetOrAdd(entryId, _ => new SemaphoreSlim(1, 1));
            await docLock.WaitAsync();
            DocState state;
            bool isNewState;
            try
            {
                isNewState = !_docStates.ContainsKey(entryId);
                state = _docStates.GetOrAdd(entryId, _ => new DocState());

                if (isNewState && string.IsNullOrEmpty(state.Content))
                {
                    if (int.TryParse(entryId, out var id))
                    {
                        try
                        {
                            var entry = _entryService.GetEntryById(id);
                            if (!string.IsNullOrEmpty(entry?.Content))
                                state.Content = entry.Content;
                        }
                        catch (Exception ex)
                        {
                            _logger.LogWarning(ex, "[Collab] Failed to load entry {EntryId} from DB", entryId);
                        }
                    }
                }

                // Set base untuk client ini = current server content
                // Ini adalah "titik divergence" awal client
                _clientBases[Context.ConnectionId] = state.Content;
            }
            finally { docLock.Release(); }

            // Kirim state ke client (selalu kirim agar client ter-inisialisasi)
            await Clients.Caller.SendAsync("ReceiveDocState", state.Content ?? "", state.Version);

            await BroadcastUsers(entryId);
        }

        /// <summary>
        /// Client kirim update.
        ///
        /// clientVersion = version terakhir yang client tahu dari server.
        ///
        /// No conflict (clientVersion >= serverVersion):
        ///   Client up-to-date, accept as-is.
        ///   Update clientBase = content yang dikirim.
        ///
        /// Conflict (clientVersion &lt; serverVersion):
        ///   Client belum tahu update terbaru dari peer.
        ///   3-way merge: diff(clientBase, clientContent) applied on top of serverContent.
        ///   clientBase = snapshot server yang client terakhir tahu (per-client, akurat).
        ///   Update clientBase = merged result.
        ///
        /// Broadcast ke SEMUA termasuk pengirim.
        /// Update clientBase semua peer = merged result (mereka sekarang tahu state ini).
        /// </summary>
        public async Task SendHtmlUpdate(string entryId, string htmlContent, long clientVersion)
        {
            if (string.IsNullOrEmpty(htmlContent)) return;

            var docLock = _locks.GetOrAdd(entryId, _ => new SemaphoreSlim(1, 1));
            await docLock.WaitAsync();

            long   newVersion;
            string resultContent;
            List<string> allConnectionIds;

            try
            {
                var state = _docStates.GetOrAdd(entryId, _ => new DocState());

                // Ambil base milik client ini (snapshot terakhir yang dia tahu)
                var clientBase = _clientBases.GetValueOrDefault(Context.ConnectionId, state.Content);

                if (clientVersion >= state.Version)
                {
                    // No conflict
                    resultContent = htmlContent;
                    newVersion    = state.Version + 1;
                }
                else
                {
                    // Conflict — 3-way merge pakai clientBase yang akurat
                    _logger.LogDebug(
                        "[Collab] Conflict entry={EntryId} clientVer={ClientVer} serverVer={ServerVer}",
                        entryId, clientVersion, state.Version);

                    resultContent = ServerMerge(clientBase, htmlContent, state.Content);
                    newVersion    = state.Version + 1;
                }

                state.Content = resultContent;
                state.Version = newVersion;

                // Update base semua client yang ada di room ini = merged result
                // Mereka sekarang tahu state ini setelah menerima broadcast
                allConnectionIds = _users.Values
                    .Where(u => u.EntryId == entryId)
                    .Select(u => u.ConnectionId)
                    .ToList();

                foreach (var connId in allConnectionIds)
                    _clientBases[connId] = resultContent;
            }
            finally
            {
                docLock.Release();
            }

            await Clients.Group(GroupName(entryId))
                .SendAsync("ReceiveUpdate", resultContent, newVersion);

            await Clients.Caller.SendAsync("UpdateAck", newVersion);
        }

        /// <summary>
        /// 3-way merge.
        /// base  = snapshot server yang client terakhir tahu (per-client, akurat)
        /// mine  = content yang client kirim
        /// theirs = current server content
        ///
        /// diff(base, mine) = perubahan yang client buat
        /// apply ke theirs  = perubahan client di atas state server terbaru
        /// </summary>
        private string ServerMerge(string baseContent, string mine, string theirs)
        {
            if (mine == theirs)        return mine;
            if (mine == baseContent)   return theirs;
            if (theirs == baseContent) return mine;
            if (string.IsNullOrEmpty(baseContent)) return theirs;

            if (HasTable(baseContent) || HasTable(mine) || HasTable(theirs))
            {
                try
                {
                    var docBase = new HtmlDocument(); docBase.LoadHtml(baseContent);
                    var docMine = new HtmlDocument(); docMine.LoadHtml(mine);
                    var docTheirs = new HtmlDocument(); docTheirs.LoadHtml(theirs);

                    var baseTables = docBase.DocumentNode.SelectNodes("//table");
                    var mineTables = docMine.DocumentNode.SelectNodes("//table");
                    var theirsTables = docTheirs.DocumentNode.SelectNodes("//table");

                    int baseCount = baseTables?.Count ?? 0;
                    int mineCount = mineTables?.Count ?? 0;
                    int theirsCount = theirsTables?.Count ?? 0;

                    if (baseCount > 0 && baseCount == mineCount && baseCount == theirsCount)
                    {
                        var mergedTables = new List<string>();
                        for (int i = 0; i < baseCount; i++)
                        {
                            mergedTables.Add(MergeSingleTable(baseTables[i], mineTables[i], theirsTables[i]));
                        }

                        // Mask tables in HTML texts
                        int bIdx = 0, mIdx = 0, tIdx = 0;
                        var tableRegex = new Regex("<table[\\s\\S]*?<\\/table>", RegexOptions.IgnoreCase);

                        var bMasked = tableRegex.Replace(baseContent, _ => $"__TABLE_MERGE_{bIdx++}__");
                        var mMasked = tableRegex.Replace(mine, _ => $"__TABLE_MERGE_{mIdx++}__");
                        var tMasked = tableRegex.Replace(theirs, _ => $"__TABLE_MERGE_{tIdx++}__");

                        var mergedText = StandardMerge(bMasked, mMasked, tMasked);

                        // Restore tables
                        for (int i = 0; i < mergedTables.Count; i++)
                        {
                            mergedText = mergedText.Replace($"__TABLE_MERGE_{i}__", mergedTables[i]);
                        }

                        // Clean up any remaining placeholders
                        mergedText = Regex.Replace(mergedText, "__TABLE_MERGE_\\d+__", "");
                        return mergedText;
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[Collab] Table-aware ServerMerge failed, falling back to StandardMerge");
                }
            }

            return StandardMerge(baseContent, mine, theirs);
        }

        private string MergeSingleTable(HtmlNode baseTable, HtmlNode mineTable, HtmlNode theirsTable)
        {
            var baseRows = baseTable.SelectNodes(".//tr") ?? new HtmlNodeCollection(null);
            var mineRows = mineTable.SelectNodes(".//tr") ?? new HtmlNodeCollection(null);
            var theirsRows = theirsTable.SelectNodes(".//tr") ?? new HtmlNodeCollection(null);

            int maxRows = Math.Max(baseRows.Count, Math.Max(mineRows.Count, theirsRows.Count));
            
            var mergedTable = baseTable.CloneNode(false);
            var tbody = mergedTable.OwnerDocument.CreateElement("tbody");
            mergedTable.AppendChild(tbody);

            for (int r = 0; r < maxRows; r++)
            {
                var baseRow = r < baseRows.Count ? baseRows[r] : null;
                var mineRow = r < mineRows.Count ? mineRows[r] : null;
                var theirsRow = r < theirsRows.Count ? theirsRows[r] : null;

                if (baseRow == null)
                {
                    var fallbackRow = mineRow ?? theirsRow;
                    if (fallbackRow != null) tbody.AppendChild(fallbackRow.CloneNode(true));
                    continue;
                }

                var mergedRow = baseRow.CloneNode(false);
                tbody.AppendChild(mergedRow);

                var baseCells = baseRow.SelectNodes(".//td|.//th") ?? new HtmlNodeCollection(null);
                var mineCells = mineRow?.SelectNodes(".//td|.//th") ?? new HtmlNodeCollection(null);
                var theirsCells = theirsRow?.SelectNodes(".//td|.//th") ?? new HtmlNodeCollection(null);

                int maxCells = Math.Max(baseCells.Count, Math.Max(mineCells.Count, theirsCells.Count));

                for (int c = 0; c < maxCells; c++)
                {
                    var baseCell = c < baseCells.Count ? baseCells[c] : null;
                    var mineCell = c < mineCells.Count ? mineCells[c] : null;
                    var theirsCell = c < theirsCells.Count ? theirsCells[c] : null;

                    if (baseCell == null)
                    {
                        var fallbackCell = mineCell ?? theirsCell;
                        if (fallbackCell != null) mergedRow.AppendChild(fallbackCell.CloneNode(true));
                        continue;
                    }

                    var mergedCell = baseCell.CloneNode(false);
                    mergedRow.AppendChild(mergedCell);

                    string baseHtml = baseCell.InnerHtml;
                    string mineHtml = mineCell != null ? mineCell.InnerHtml : "";
                    string theirsHtml = theirsCell != null ? theirsCell.InnerHtml : "";

                    mergedCell.InnerHtml = StandardMerge(baseHtml, mineHtml, theirsHtml);
                }
            }

            return mergedTable.OuterHtml;
        }

        private string StandardMerge(string baseContent, string mine, string theirs)
        {
            if (mine == theirs)        return mine;
            if (mine == baseContent)   return theirs;
            if (theirs == baseContent) return mine;
            if (string.IsNullOrEmpty(baseContent)) return theirs;

            try
            {
                var dmp = new DiffMatchPatch.diff_match_patch();
                dmp.Match_Threshold = 0.5f;
                dmp.Match_Distance  = 2000;

                var diffs   = dmp.diff_main(baseContent, mine);
                dmp.diff_cleanupSemantic(diffs);
                var patches = dmp.patch_make(baseContent, diffs);
                var result  = dmp.patch_apply(patches, theirs);
                return (string)result[0];
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[Collab] StandardMerge exception");
                return theirs;
            }
        }

        private bool HasTable(string html)
        {
            if (string.IsNullOrEmpty(html)) return false;
            return html.Contains("<table", StringComparison.OrdinalIgnoreCase);
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
                _clientBases.TryRemove(Context.ConnectionId, out _);
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

        // ============================================================
        // YJS / OT HUBS SUPPORT FOR TELETYPE COLLABORATION
        // ============================================================
        private static readonly ConcurrentDictionary<string, ConcurrentDictionary<string, UserInfo>> _documentConnections
            = new ConcurrentDictionary<string, ConcurrentDictionary<string, UserInfo>>();
        private static readonly ConcurrentDictionary<string, string> _connectionToDocument
            = new ConcurrentDictionary<string, string>();
        private static readonly ConcurrentDictionary<string, HashSet<string>> _documentTypingUsers
            = new ConcurrentDictionary<string, HashSet<string>>();

        public class UserInfo
        {
            public string SiteId { get; set; } = "";
            public string UserName { get; set; } = "";
            public DateTime JoinedAt { get; set; }
        }

        public async Task JoinDocument(string documentId, string siteId, string userName)
        {
            try
            {
                if (_connectionToDocument.TryGetValue(Context.ConnectionId, out var oldDocumentId))
                {
                    if (oldDocumentId != documentId)
                    {
                        await LeaveDocument(oldDocumentId, siteId, userName);
                    }
                }

                await Groups.AddToGroupAsync(Context.ConnectionId, documentId);
                _connectionToDocument[Context.ConnectionId] = documentId;
                var group = _documentConnections.GetOrAdd(documentId, _ => new ConcurrentDictionary<string, UserInfo>());

                var userInfo = new UserInfo
                {
                    SiteId = siteId,
                    UserName = userName,
                    JoinedAt = DateTime.UtcNow
                };
                group[Context.ConnectionId] = userInfo;

                var groupSize = group.Count;

                // Send existing users list to new user
                var existingUsers = new List<object>();
                foreach (var kvp in group)
                {
                    if (kvp.Key != Context.ConnectionId)
                    {
                        existingUsers.Add(new
                        {
                            connectionId = kvp.Key,
                            siteId = kvp.Value.SiteId,
                            userName = kvp.Value.UserName,
                            joinedAt = kvp.Value.JoinedAt
                        });
                    }
                }
                await Clients.Caller.SendAsync("existingUsers", existingUsers);

                // Notify other users that someone joined
                await Clients.OthersInGroup(documentId).SendAsync("userJoined", new
                {
                    connectionId = Context.ConnectionId,
                    siteId = siteId,
                    userName = userName,
                    userCount = groupSize,
                    timestamp = DateTime.UtcNow
                });

                // Send current user count to all members
                await Clients.Group(documentId).SendAsync("userCount", groupSize);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in JoinDocument");
            }
        }

        public async Task SendOperation(string documentId, string operationsJson, string siteId)
        {
            if (string.IsNullOrEmpty(documentId)) return;
            await Clients.OthersInGroup(documentId).SendAsync("receiveOperation", operationsJson, siteId, documentId);
        }

        public async Task SendOperationOT(string documentId, string operationsJson, string siteId)
        {
            if (string.IsNullOrEmpty(documentId) || string.IsNullOrEmpty(operationsJson)) return;
            await Clients.OthersInGroup(documentId).SendAsync("receiveOperationOT", operationsJson, siteId, documentId);
        }

        public async Task LeaveDocument(string documentId, string siteId, string userName)
        {
            try
            {
                await Groups.RemoveFromGroupAsync(Context.ConnectionId, documentId);

                if (_connectionToDocument.TryRemove(Context.ConnectionId, out _))
                {
                    if (_documentConnections.TryGetValue(documentId, out var connections))
                    {
                        connections.TryRemove(Context.ConnectionId, out _);
                        var userCount = connections.Count;

                        if (_documentTypingUsers.TryGetValue(documentId, out var typingUsers))
                        {
                            lock (typingUsers)
                            {
                                typingUsers.Remove(siteId);
                            }
                        }

                        // Broadcast user left ke semua user lain
                        await Clients.OthersInGroup(documentId).SendAsync("userLeft", new
                        {
                            connectionId = Context.ConnectionId,
                            siteId = siteId,
                            userName = userName,
                            userCount = userCount,
                            timestamp = DateTime.UtcNow
                        });

                        await Clients.Group(documentId).SendAsync("userCount", userCount);
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in LeaveDocument");
            }
        }

        public async Task TestBroadcast(string message)
        {
            await Clients.All.SendAsync("testMessage", message, Context.ConnectionId);
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
