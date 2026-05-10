/**
 * collaboration.js
 * Real-time collaboration client menggunakan SignalR.
 * Sync konten HTML editor + typing awareness antar client.
 */

class CollaborationClient {
    constructor(entryId, displayName, avatar) {
        this.entryId = String(entryId);
        this.displayName = displayName;
        this.avatar = avatar;
        this.connection = null;
        this.editor = null;
        this._applyingRemote = false;
        this._connected = false;
        this._debounce = null;
        this._typingTimeout = null;
        this._isTyping = false;
        this._myColor = null;
        this._peers = new Map(); // connectionId -> { displayName, color, typingTimer }
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
        this.connection.onclose(() => { this._connected = false; this._showStatus('disconnected'); });
    }

    _registerHandlers() {
        // Terima full doc state saat pertama join
        this.connection.on('ReceiveDocState', (content) => {
            if (!content || !this.editor) return;
            this._applyRemoteContent(content);
        });

        // Terima update konten dari peer
        this.connection.on('ReceiveUpdate', (content) => {
            if (!content || !this.editor) return;
            this._applyRemoteContent(content);
        });

        // Terima typing awareness dari peer
        this.connection.on('ReceiveAwareness', (data) => {
            if (data.isTyping) {
                this._showPeerTyping(data.connectionId, data.displayName, data.color);
            } else {
                this._hidePeerTyping(data.connectionId);
            }
        });

        // Terima daftar user online
        this.connection.on('UsersOnline', (users) => {
            this._renderOnlineUsers(users);
            // Simpan info peers
            users.forEach(u => {
                if (!this._peers.has(u.connectionId)) {
                    this._peers.set(u.connectionId, { displayName: u.displayName, color: u.color });
                }
            });
        });
    }

    _applyRemoteContent(content) {
        this._applyingRemote = true;
        try {
            if (this.editor.getContent() !== content) {
                const bookmark = this.editor.selection.getBookmark(2, true);
                this.editor.setContent(content);
                try { this.editor.selection.moveToBookmark(bookmark); } catch (_) {}
            }
        } finally {
            this._applyingRemote = false;
        }
    }

    /**
     * Kirim konten HTML ke semua peer di room.
     */
    sendContentUpdate(htmlContent) {
        if (!this._connected || this._applyingRemote) return;

        // Kirim typing awareness
        this._sendTypingAwareness(true);

        clearTimeout(this._debounce);
        this._debounce = setTimeout(() => {
            this.connection.invoke('SendHtmlUpdate', this.entryId, htmlContent)
                .catch(err => console.warn('[Collab] SendHtmlUpdate failed:', err));
        }, 200);

        // Stop typing setelah 2 detik tidak ada input
        clearTimeout(this._typingTimeout);
        this._typingTimeout = setTimeout(() => {
            this._sendTypingAwareness(false);
        }, 2000);
    }

    _sendTypingAwareness(isTyping) {
        if (!this._connected) return;
        if (this._isTyping === isTyping) return;
        this._isTyping = isTyping;

        this.connection.invoke('SendAwareness', this.entryId, {
            isTyping: isTyping,
            displayName: this.displayName
        }).catch(() => {});
    }

    // ── Typing indicator UI ──────────────────────────────────────

    _showPeerTyping(connectionId, displayName, color) {
        const containerId = 'collab-typing-indicators';
        let container = document.getElementById(containerId);
        if (!container) return;

        const id = `typing-${connectionId.replace(/[^a-z0-9]/gi, '')}`;
        let el = document.getElementById(id);

        if (!el) {
            el = document.createElement('span');
            el.id = id;
            el.className = 'collab-typing-badge me-2';
            el.style.cssText = `
                background: ${color}22;
                border: 1px solid ${color};
                color: ${color};
                border-radius: 12px;
                padding: 2px 10px;
                font-size: 0.75rem;
                font-weight: 600;
                display: inline-flex;
                align-items: center;
                gap: 5px;
            `;
            el.innerHTML = `
                <span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;animation:collab-pulse 1s infinite;"></span>
                ${displayName} sedang mengetik...
            `;
            container.appendChild(el);
        }

        // Reset auto-hide timer
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

    // ── Editor border warna user sendiri ────────────────────────

    _applyMyEditorBorder(color) {
        // Beri border warna pada TinyMCE iframe container
        setTimeout(() => {
            const editorContainer = document.querySelector('.tox-tinymce');
            if (editorContainer) {
                editorContainer.style.borderColor = color;
                editorContainer.style.borderWidth = '2px';
                editorContainer.style.boxShadow = `0 0 0 3px ${color}33`;
            }
        }, 500);
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
                const initials = user.displayName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
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
        clearTimeout(this._debounce);
        clearTimeout(this._typingTimeout);
        this._sendTypingAwareness(false);
        if (this.connection) {
            this.connection.stop();
            this.connection = null;
        }
    }
}

window.CollaborationClient = CollaborationClient;

