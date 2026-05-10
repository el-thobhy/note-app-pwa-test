/**
 * collaboration.js
 * Real-time collaboration — SignalR broadcast dengan conflict prevention.
 *
 * Strategi:
 * - Saat user sedang aktif mengetik, remote update TIDAK langsung di-apply
 * - Remote update di-queue, di-apply setelah user berhenti mengetik 1.5 detik
 * - Ini mencegah cursor loncat saat dua user mengetik bersamaan
 */

class CollaborationClient {
    constructor(entryId, displayName, avatar) {
        this.entryId      = String(entryId);
        this.displayName  = displayName;
        this.avatar       = avatar;
        this.connection   = null;
        this.editor       = null;

        this._connected       = false;
        this._applyingRemote  = false;

        // Typing state
        this._isTyping        = false;
        this._typingTimer     = null;   // reset "berhenti mengetik"
        this._sendDebounce    = null;   // debounce kirim ke server

        // Queue remote update saat user sedang mengetik
        this._pendingContent  = null;
        this._applyTimer      = null;

        this._peers = new Map();
    }

    async init(editorInstance) {
        this.editor = editorInstance;

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
        // State awal saat join room
        this.connection.on('ReceiveDocState', (content) => {
            if (!content || !this.editor) return;
            // State awal: langsung apply, user belum mengetik
            this._forceApply(content);
        });

        // Update dari peer lain
        this.connection.on('ReceiveUpdate', (content) => {
            if (!content || !this.editor) return;
            if (this._isTyping) {
                // User sedang mengetik — queue dulu, jangan ganggu cursor
                this._pendingContent = content;
            } else {
                // User idle — langsung apply
                this._safeApply(content);
            }
        });

        // Typing awareness dari peer
        this.connection.on('ReceiveAwareness', (data) => {
            if (data.isTyping) {
                this._showPeerTyping(data.connectionId, data.displayName, data.color);
            } else {
                this._hidePeerTyping(data.connectionId);
            }
        });

        // Daftar user online
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
     * Dipanggil dari TinyMCE event (Change, KeyUp, dll).
     * Tandai user sedang mengetik, kirim update ke server dengan debounce.
     */
    sendContentUpdate(htmlContent) {
        if (!this._connected || this._applyingRemote) return;

        // Tandai sedang mengetik
        this._setTyping(true);

        // Kirim ke server dengan debounce 400ms
        clearTimeout(this._sendDebounce);
        this._sendDebounce = setTimeout(() => {
            if (!this._connected) return;
            this.connection.invoke('SendHtmlUpdate', this.entryId, htmlContent)
                .catch(err => console.warn('[Collab] SendHtmlUpdate failed:', err));
        }, 400);

        // Berhenti mengetik setelah 1.5 detik idle
        clearTimeout(this._typingTimer);
        this._typingTimer = setTimeout(() => {
            this._setTyping(false);
        }, 1500);
    }

    _setTyping(isTyping) {
        if (this._isTyping === isTyping) return;
        this._isTyping = isTyping;

        // Kirim awareness ke peers
        if (this._connected) {
            this.connection.invoke('SendAwareness', this.entryId, {
                isTyping: isTyping,
                displayName: this.displayName
            }).catch(() => {});
        }

        // Saat berhenti mengetik, apply pending update jika ada
        if (!isTyping && this._pendingContent) {
            const content = this._pendingContent;
            this._pendingContent = null;
            // Delay kecil agar TinyMCE selesai commit perubahan terakhir
            setTimeout(() => this._safeApply(content), 100);
        }
    }

    /**
     * Apply konten remote dengan bookmark cursor (tidak ganggu posisi).
     */
    _safeApply(content) {
        if (!this.editor || this._applyingRemote) return;
        const current = this.editor.getContent();
        if (current === content) return; // tidak ada perubahan

        this._applyingRemote = true;
        try {
            const bookmark = this.editor.selection.getBookmark(2, true);
            this.editor.setContent(content);
            try { this.editor.selection.moveToBookmark(bookmark); } catch (_) {}
        } finally {
            this._applyingRemote = false;
        }
    }

    /**
     * Force apply tanpa bookmark (untuk initial state).
     */
    _forceApply(content) {
        if (!this.editor) return;
        this._applyingRemote = true;
        try {
            this.editor.setContent(content);
        } finally {
            this._applyingRemote = false;
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
                background: ${color}22; border: 1px solid ${color}; color: ${color};
                border-radius: 12px; padding: 2px 10px; font-size: 0.75rem;
                font-weight: 600; display: inline-flex; align-items: center; gap: 5px;
            `;
            el.innerHTML = `
                <span style="width:7px;height:7px;border-radius:50%;background:${color};
                             display:inline-block;animation:collab-pulse 1s infinite;"></span>
                ${displayName} mengetik...
            `;
            container.appendChild(el);
        }

        // Reset auto-hide
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
        clearTimeout(this._applyTimer);
        this._setTyping(false);
        if (this.connection) {
            this.connection.stop();
            this.connection = null;
        }
    }
}

window.CollaborationClient = CollaborationClient;
