/**
 * collaboration.js
 * Real-time collaboration dengan server version guard + client-side 3-way merge.
 *
 * Alur:
 * 1. Client ketik → simpan sebagai _pendingContent, schedule debounced send
 * 2. Send: kirim (content, clientVersion) ke server
 * 3a. Server accept (clientVersion >= serverVersion):
 *     → broadcast ke peers via ReceiveUpdate
 *     → kirim UpdateAck ke pengirim → update _serverVersion, clear pending
 * 3b. Server reject (client ketinggalan):
 *     → kirim ReceiveUpdate dengan state terbaru ke pengirim
 *     → client merge: _threeWayMerge(_baseContent, serverContent, _pendingContent)
 *     → kirim hasil merge sebagai update baru
 *
 * _baseContent = konten terakhir yang dikonfirmasi server (via UpdateAck atau ReceiveDocState)
 * Merge dilakukan di client menggunakan diff-match-patch.
 */

class CollaborationClient {
    constructor(entryId, displayName, avatar) {
        this.entryId     = String(entryId);
        this.displayName = displayName;
        this.avatar      = avatar;
        this.connection  = null;
        this.editor      = null;

        this._connected      = false;
        this._applyingRemote = false;

        this._baseContent    = '';   // konten terakhir yang dikonfirmasi server
        this._serverVersion  = 0;
        this._pendingContent = null; // konten lokal yang belum dikonfirmasi server

        this._sendDebounce   = null;
        this._isTyping       = false;
        this._typingTimer    = null;

        this._dmp   = null;
        this._peers = new Map();
    }

    async init(editorInstance) {
        this.editor = editorInstance;

        if (typeof diff_match_patch !== 'undefined') {
            this._dmp = new diff_match_patch();
            this._dmp.Patch_Timeout = 1;
        } else {
            console.warn('[Collab] diff-match-patch tidak tersedia, merge akan fallback ke server content');
        }

        this._baseContent = this.editor.getContent();

        this.connection = new signalR.HubConnectionBuilder()
            .withUrl('/hubs/collaboration')
            .withAutomaticReconnect([0, 1000, 3000, 5000])
            .build();

        this._registerHandlers();

        try {
            await this.connection.start();
            this._connected = true;
            await this.connection.invoke('JoinEntry', this.entryId, this.displayName, this.avatar);
            this._showStatus('connected');
        } catch (err) {
            console.error('[Collab] Connection failed:', err);
            this._showStatus('error');
        }

        this.connection.onreconnected(async () => {
            this._connected     = true;
            this._serverVersion = 0;
            await this.connection.invoke('JoinEntry', this.entryId, this.displayName, this.avatar);
            this._showStatus('connected');
        });
        this.connection.onreconnecting(() => { this._connected = false; this._showStatus('reconnecting'); });
        this.connection.onclose(()       => { this._connected = false; this._showStatus('disconnected'); });
    }

    _registerHandlers() {
        // State awal saat join — apply langsung, set sebagai base
        this.connection.on('ReceiveDocState', (content, version) => {
            if (!content || !this.editor) return;
            this._applyingRemote = true;
            try {
                this.editor.setContent(content);
                this._baseContent    = content;
                this._serverVersion  = version ?? 0;
                this._pendingContent = null;
            } finally {
                this._applyingRemote = false;
            }
        });

        // Dua kasus masuk sini:
        // (A) Update dari peer — apply ke editor
        // (B) Resync dari server karena client ketinggalan — merge lalu kirim ulang
        this.connection.on('ReceiveUpdate', (serverContent, serverVersion) => {
            if (!serverContent || !this.editor) return;
            if (serverVersion !== undefined && serverVersion <= this._serverVersion) return;

            const prevBase      = this._baseContent;
            const pending       = this._pendingContent;
            const prevVersion   = this._serverVersion;

            // Update base dan version ke state server terbaru
            this._baseContent   = serverContent;
            this._serverVersion = serverVersion ?? (this._serverVersion + 1);

            if (pending !== null && pending !== serverContent) {
                // Ada perubahan lokal yang belum dikonfirmasi server
                // Merge: base=prevBase, server=serverContent, local=pending
                const merged = this._threeWayMerge(prevBase, serverContent, pending);

                // Apply merged ke editor (supaya user lihat hasil merge)
                this._applyingRemote = true;
                try {
                    const bookmark = this.editor.selection.getBookmark(2, true);
                    this.editor.setContent(merged);
                    try { this.editor.selection.moveToBookmark(bookmark); } catch (_) {}
                    // Update base ke merged — ini yang akan kita kirim ke server
                    this._baseContent = merged;
                } finally {
                    this._applyingRemote = false;
                }

                // Kirim hasil merge ke server
                this._pendingContent = merged;
                this._scheduleSend(merged);
            } else {
                // Tidak ada pending — ini update murni dari peer, apply ke editor
                this._pendingContent = null;
                this._applyingRemote = true;
                try {
                    const localContent = this.editor.getContent();
                    if (localContent !== serverContent) {
                        const bookmark = this.editor.selection.getBookmark(2, true);
                        this.editor.setContent(serverContent);
                        try { this.editor.selection.moveToBookmark(bookmark); } catch (_) {}
                    }
                } finally {
                    this._applyingRemote = false;
                }
            }
        });

        // Server konfirmasi update kita diterima
        this.connection.on('UpdateAck', (newVersion) => {
            // Base sudah benar (di-set saat kirim), cukup update version dan clear pending
            this._serverVersion  = newVersion;
            this._pendingContent = null;
        });

        this.connection.on('ReceiveAwareness', (data) => {
            if (data.isTyping) {
                this._showPeerTyping(data.connectionId, data.displayName, data.color);
            } else {
                this._hidePeerTyping(data.connectionId);
            }
        });

        this.connection.on('UsersOnline', (users) => {
            this._renderOnlineUsers(users);
            users.forEach(u => {
                if (!this._peers.has(u.connectionId)) {
                    this._peers.set(u.connectionId, { displayName: u.displayName, color: u.color });
                }
            });
        });
    }

    /**
     * Dipanggil dari TinyMCE event saat konten berubah.
     */
    sendContentUpdate(htmlContent) {
        if (!this._connected || this._applyingRemote) return;

        this._setTyping(true);
        this._pendingContent = htmlContent;
        this._scheduleSend(htmlContent);

        clearTimeout(this._typingTimer);
        this._typingTimer = setTimeout(() => this._setTyping(false), 1500);
    }

    _scheduleSend(htmlContent) {
        clearTimeout(this._sendDebounce);
        this._sendDebounce = setTimeout(() => {
            if (!this._connected) return;

            // Snapshot version saat ini sebelum kirim
            const versionSnapshot = this._serverVersion;

            this.connection.invoke(
                'SendHtmlUpdate',
                this.entryId,
                htmlContent,
                versionSnapshot
            ).catch(err => console.warn('[Collab] SendHtmlUpdate failed:', err));

        }, 300);
    }

    /**
     * 3-way merge menggunakan diff-match-patch.
     *
     * base   = titik divergence terakhir yang dikonfirmasi server
     * server = konten terbaru dari server (sudah include perubahan peer)
     * local  = perubahan lokal yang belum dikonfirmasi
     *
     * Strategi: buat patch dari base→local, apply ke server content.
     * Artinya: perubahan lokal di-overlay ke atas perubahan server.
     * Conflict resolution: server wins (patch gagal di-apply → bagian server dipertahankan).
     */
    _threeWayMerge(base, server, local) {
        // Fast paths
        if (local  === base)   return server; // tidak ada perubahan lokal
        if (server === base)   return local;  // tidak ada perubahan server
        if (local  === server) return local;  // sudah sama

        if (!this._dmp) return server; // fallback tanpa dmp

        try {
            // Buat patch: apa yang kita ubah dari base
            const localPatches = this._dmp.patch_make(base, local);

            // Apply patch kita ke konten server
            const [merged, results] = this._dmp.patch_apply(localPatches, server);

            const failCount = results.filter(r => !r).length;
            if (failCount > 0) {
                console.debug(`[Collab] Merge: ${failCount}/${results.length} patches failed (conflict), server wins for those parts`);
            }

            return merged;
        } catch (e) {
            console.warn('[Collab] Merge failed, using server content:', e);
            return server;
        }
    }

    _setTyping(isTyping) {
        if (this._isTyping === isTyping) return;
        this._isTyping = isTyping;
        if (this._connected) {
            this.connection.invoke('SendAwareness', this.entryId, {
                isTyping: isTyping,
                displayName: this.displayName
            }).catch(() => {});
        }
    }

    // ── Typing indicator UI ──────────────────────────────────────

    _showPeerTyping(connectionId, displayName, color) {
        const container = document.getElementById('collab-typing-indicators');
        if (!container) return;

        const id = `typing-${connectionId.replace(/[^a-z0-9]/gi, '')}`;
        let el = document.getElementById(id);

        if (!el) {
            el = document.createElement('span');
            el.id = id;
            el.style.cssText = `
                background:${color}22; border:1px solid ${color}; color:${color};
                border-radius:12px; padding:2px 10px; font-size:0.75rem;
                font-weight:600; display:inline-flex; align-items:center; gap:5px;
            `;
            el.innerHTML = `
                <span style="width:7px;height:7px;border-radius:50%;background:${color};
                             display:inline-block;animation:collab-pulse 1s infinite;"></span>
                ${displayName} mengetik...
            `;
            container.appendChild(el);
        }

        const peer = this._peers.get(connectionId) || {};
        clearTimeout(peer.typingTimer);
        peer.typingTimer = setTimeout(() => this._hidePeerTyping(connectionId), 3000);
        this._peers.set(connectionId, { ...peer, displayName, color });
    }

    _hidePeerTyping(connectionId) {
        const id = `typing-${connectionId.replace(/[^a-z0-9]/gi, '')}`;
        const el = document.getElementById(id);
        if (el) el.remove();
    }

    // ── Online users UI ──────────────────────────────────────────

    _renderOnlineUsers(users) {
        const container = document.getElementById('collab-users');
        if (!container) return;

        container.innerHTML = '';
        users.forEach(user => {
            const el = document.createElement('div');
            el.className = 'collab-avatar';
            el.title = user.displayName;
            el.style.borderColor = user.color;
            el.style.outline = `2px solid ${user.color}`;

            if (user.avatar) {
                el.innerHTML = `<img src="${user.avatar}" alt="${user.displayName}" />`;
            } else {
                const initials = user.displayName.split(' ')
                    .map(n => n[0]).join('').substring(0, 2).toUpperCase();
                el.innerHTML = `<span style="background:${user.color}">${initials}</span>`;
            }
            container.appendChild(el);
        });

        const counter = document.getElementById('collab-count');
        if (counter) {
            counter.textContent = users.length > 1
                ? `${users.length} orang sedang mengedit`
                : 'Hanya kamu';
        }
    }

    _showStatus(status) {
        const el = document.getElementById('collab-status');
        if (!el) return;
        const map = {
            connected:    { text: '● Online',         cls: 'text-success' },
            disconnected: { text: '● Offline',         cls: 'text-danger' },
            reconnecting: { text: '● Reconnecting...', cls: 'text-warning' },
            error:        { text: '● Error',           cls: 'text-danger' },
        };
        const s = map[status] || map.disconnected;
        el.textContent = s.text;
        el.className = `collab-status-text ${s.cls}`;
    }

    destroy() {
        clearTimeout(this._sendDebounce);
        clearTimeout(this._typingTimer);
        this._setTyping(false);
        if (this.connection) {
            this.connection.stop();
            this.connection = null;
        }
    }
}

window.CollaborationClient = CollaborationClient;
