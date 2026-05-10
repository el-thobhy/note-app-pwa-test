/**
 * collaboration.js
 * Real-time collaboration dengan 3-way merge menggunakan diff-match-patch.
 *
 * Strategi merge:
 * - Setiap client menyimpan `baseContent` = konten terakhir yang disepakati
 * - Saat terima update dari peer:
 *     peerDiff  = diff(base, peerContent)   → apa yang peer ubah
 *     localDiff = diff(base, localContent)  → apa yang kita ubah
 *     merged    = apply(peerDiff + localDiff ke base)
 * - Hasil merge di-apply ke editor tanpa replace cursor
 * - base di-update ke merged
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

        this._baseContent    = '';   // versi terakhir yang disepakati
        this._sendDebounce   = null;
        this._isTyping       = false;
        this._typingTimer    = null;

        this._dmp    = null; // diff-match-patch instance
        this._peers  = new Map();
    }

    async init(editorInstance) {
        this.editor = editorInstance;

        // Init diff-match-patch
        if (typeof diff_match_patch !== 'undefined') {
            this._dmp = new diff_match_patch();
            this._dmp.Patch_Timeout = 1;
        } else {
            console.warn('[Collab] diff-match-patch tidak tersedia, fallback ke replace mode');
        }

        // Set base dari konten awal editor
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
            this._connected = true;
            await this.connection.invoke('JoinEntry', this.entryId, this.displayName, this.avatar);
            this._showStatus('connected');
        });
        this.connection.onreconnecting(() => { this._connected = false; this._showStatus('reconnecting'); });
        this.connection.onclose(()       => { this._connected = false; this._showStatus('disconnected'); });
    }

    _registerHandlers() {
        // State awal saat join room — langsung apply, set sebagai base
        this.connection.on('ReceiveDocState', (content) => {
            if (!content || !this.editor) return;
            this._applyingRemote = true;
            try {
                this.editor.setContent(content);
                this._baseContent = content;
            } finally {
                this._applyingRemote = false;
            }
        });

        // Update dari peer — merge dengan konten lokal
        this.connection.on('ReceiveUpdate', (peerContent) => {
            if (!peerContent || !this.editor || this._applyingRemote) return;
            this._mergeAndApply(peerContent);
        });

        // Typing awareness
        this.connection.on('ReceiveAwareness', (data) => {
            if (data.isTyping) {
                this._showPeerTyping(data.connectionId, data.displayName, data.color);
            } else {
                this._hidePeerTyping(data.connectionId);
            }
        });

        // Online users
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
     * 3-way merge: base + peer changes + local changes → merged result.
     */
    _mergeAndApply(peerContent) {
        const localContent = this.editor.getContent();

        // Kalau local sama dengan base (kita tidak mengetik), langsung apply peer
        if (localContent === this._baseContent) {
            this._applyingRemote = true;
            try {
                if (localContent !== peerContent) {
                    const bookmark = this.editor.selection.getBookmark(2, true);
                    this.editor.setContent(peerContent);
                    try { this.editor.selection.moveToBookmark(bookmark); } catch (_) {}
                }
                this._baseContent = peerContent;
            } finally {
                this._applyingRemote = false;
            }
            return;
        }

        // Kalau peer sama dengan base (peer tidak mengubah apa-apa), tidak perlu merge
        if (peerContent === this._baseContent) {
            return;
        }

        // Keduanya berubah dari base — lakukan 3-way merge
        if (this._dmp) {
            try {
                const merged = this._threeWayMerge(this._baseContent, localContent, peerContent);
                this._applyingRemote = true;
                try {
                    if (merged !== localContent) {
                        const bookmark = this.editor.selection.getBookmark(2, true);
                        this.editor.setContent(merged);
                        try { this.editor.selection.moveToBookmark(bookmark); } catch (_) {}
                    }
                    this._baseContent = merged;
                } finally {
                    this._applyingRemote = false;
                }
            } catch (e) {
                console.warn('[Collab] Merge failed, using peer content:', e);
                // Fallback: peer wins
                this._applyingRemote = true;
                try {
                    const bookmark = this.editor.selection.getBookmark(2, true);
                    this.editor.setContent(peerContent);
                    try { this.editor.selection.moveToBookmark(bookmark); } catch (_) {}
                    this._baseContent = peerContent;
                } finally {
                    this._applyingRemote = false;
                }
            }
        } else {
            // Fallback tanpa dmp: peer wins
            this._applyingRemote = true;
            try {
                const bookmark = this.editor.selection.getBookmark(2, true);
                this.editor.setContent(peerContent);
                try { this.editor.selection.moveToBookmark(bookmark); } catch (_) {}
                this._baseContent = peerContent;
            } finally {
                this._applyingRemote = false;
            }
        }
    }

    /**
     * 3-way merge menggunakan diff-match-patch patch.
     * base    = versi awal yang sama-sama dimiliki
     * local   = versi setelah perubahan lokal
     * peer    = versi setelah perubahan peer
     * return  = hasil merge
     */
    _threeWayMerge(base, local, peer) {
        // Buat patch dari base → peer
        const peerPatches = this._dmp.patch_make(base, peer);

        // Apply patch peer ke local content
        const [merged, results] = this._dmp.patch_apply(peerPatches, local);

        // Cek apakah semua patch berhasil di-apply
        const allApplied = results.every(r => r === true);
        if (!allApplied) {
            console.warn('[Collab] Some patches failed to apply, partial merge result');
        }

        return merged;
    }

    /**
     * Dipanggil dari TinyMCE event saat konten berubah.
     */
    sendContentUpdate(htmlContent) {
        if (!this._connected || this._applyingRemote) return;

        this._setTyping(true);

        clearTimeout(this._sendDebounce);
        this._sendDebounce = setTimeout(() => {
            if (!this._connected) return;
            // Update base ke konten yang kita kirim
            this._baseContent = htmlContent;
            this.connection.invoke('SendHtmlUpdate', this.entryId, htmlContent)
                .catch(err => console.warn('[Collab] SendHtmlUpdate failed:', err));
        }, 300);

        clearTimeout(this._typingTimer);
        this._typingTimer = setTimeout(() => {
            this._setTyping(false);
        }, 1500);
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
