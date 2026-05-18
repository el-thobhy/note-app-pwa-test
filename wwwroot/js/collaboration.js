/**
 * collaboration.js
 *
 * Client-side collaboration handler.
 * Desain: server-authoritative merge. Client tidak merge.
 *
 * Fix race condition utama:
 *   - Tidak pakai boolean flag _applyingRemote untuk guard editor events,
 *     karena TinyMCE fire Change event secara async setelah setContent()
 *     sehingga flag sudah di-reset sebelum event fire.
 *   - Pakai _lastReceivedContent: content terakhir yang diterima dari server.
 *     Di sendContentUpdate, skip kalau content == _lastReceivedContent.
 *     Ini mencegah echo loop: ReceiveUpdate → setContent → Change → send → loop.
 *
 * In-flight guard:
 *   Hanya 1 request boleh in-flight ke server.
 *   Kalau user ketik saat ada in-flight, simpan ke _pendingContent.
 *   Setelah ReceiveUpdate diterima, kirim _pendingContent kalau ada.
 */

class CollaborationClient {
    constructor(entryId, displayName, avatar) {
        this.entryId     = String(entryId);
        this.displayName = displayName;
        this.avatar      = avatar;
        this.connection  = null;
        this.editor      = null;

        this._connected     = false;

        // Version terakhir yang dikonfirmasi server
        this._serverVersion = 0;

        // Content terakhir yang diterima dari server (untuk mencegah echo loop)
        // sendContentUpdate akan skip kalau content == _lastReceivedContent
        this._lastReceivedContent = null;

        // Ketikan terbaru yang belum dikirim
        this._pendingContent = null;

        // In-flight guard: true = ada request yang sedang menunggu response
        this._inflight = false;

        this._sendDebounce  = null;
        this._maxDelayTimer = null;
        this._maxDelay      = 2000;
        this._isTyping      = false;
        this._typingTimer   = null;

        this._peers = new Map();
    }

    async init(editorInstance) {
        this.editor = editorInstance;

        this.connection = new signalR.HubConnectionBuilder()
            .withUrl('/hubs/collaboration')
            .withAutomaticReconnect([0, 1000, 3000, 5000])
            .build();

        this._registerHandlers();
        this._bindEditorEvents();

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
            this._inflight      = false;
            this._serverVersion = 0;
            await this.connection.invoke('JoinEntry', this.entryId, this.displayName, this.avatar);
            this._showStatus('connected');
        });
        this.connection.onreconnecting(() => {
            this._connected = false;
            this._showStatus('reconnecting');
        });
        this.connection.onclose(() => {
            this._connected = false;
            this._showStatus('disconnected');
        });
    }

    _bindEditorEvents() {
        this._editorHandler = () => {
            const content = this.editor.getContent();

            // KUNCI: skip kalau content sama dengan yang terakhir diterima dari server.
            // Ini mencegah echo loop saat ReceiveUpdate → setContent → Change event fire.
            // Tidak pakai boolean flag karena TinyMCE fire Change async setelah setContent.
            if (content === this._lastReceivedContent) return;

            this.sendContentUpdate(content);
        };
        this.editor.on('Change KeyUp Paste Undo Redo', this._editorHandler);
    }

    _unbindEditorEvents() {
        if (this.editor && this._editorHandler) {
            this.editor.off('Change KeyUp Paste Undo Redo', this._editorHandler);
            this._editorHandler = null;
        }
    }

    _registerHandlers() {

        // ── ReceiveDocState ──────────────────────────────────────────
        // Diterima saat join, hanya kalau server punya content.
        // Server tidak kirim event ini kalau content kosong.
        this.connection.on('ReceiveDocState', (content, version) => {
            if (!this.editor || !content) return;

            this._serverVersion       = version ?? 0;
            this._inflight            = false;
            this._lastReceivedContent = content;

            const currentContent = this.editor.getContent();
            if (content !== currentContent) {
                // Server punya content berbeda (ada peer yang sudah edit)
                this.editor.setContent(content);
            }

            if (this._pendingContent !== null) {
                this._scheduleSend();
            }
        });

        // ── ReceiveUpdate ────────────────────────────────────────────
        // Diterima setelah server accept update (ack) atau peer kirim update.
        // Server broadcast ke SEMUA termasuk pengirim.
        // _lastReceivedContent di-set supaya echo loop tidak terjadi.
        this.connection.on('ReceiveUpdate', (serverContent, serverVersion) => {
            if (!this.editor || !serverContent) return;

            // Ignore stale
            if (serverVersion !== undefined && serverVersion <= this._serverVersion) return;

            this._serverVersion = serverVersion ?? (this._serverVersion + 1);
            this._inflight      = false;

            // Simpan sebagai last received — editor event handler akan skip content ini
            this._lastReceivedContent = serverContent;

            const current = this.editor.getContent();
            if (current !== serverContent) {
                const bookmark = this.editor.selection.getBookmark(2, true);
                this.editor.setContent(serverContent);
                try { this.editor.selection.moveToBookmark(bookmark); } catch (_) {}
            }

            // Kirim pending kalau ada (ketikan yang terjadi saat in-flight)
            if (this._pendingContent !== null) {
                this._scheduleSend();
            }
        });

        // ── ReceiveAwareness ─────────────────────────────────────────
        this.connection.on('ReceiveAwareness', (data) => {
            if (data.isTyping) {
                this._showPeerTyping(data.connectionId, data.displayName, data.color);
            } else {
                this._hidePeerTyping(data.connectionId);
            }
        });

        // ── UsersOnline ──────────────────────────────────────────────
        this.connection.on('UsersOnline', (users) => {
            this._renderOnlineUsers(users);
            users.forEach(u => {
                if (!this._peers.has(u.connectionId)) {
                    this._peers.set(u.connectionId, { displayName: u.displayName, color: u.color });
                }
            });
        });
    }

    // ── sendContentUpdate ────────────────────────────────────────────
    sendContentUpdate(htmlContent) {
        if (!this._connected) return;

        // Skip kalau content sama dengan yang terakhir diterima dari server
        // (mencegah echo loop setelah ReceiveUpdate → setContent)
        if (htmlContent === this._lastReceivedContent) return;

        this._setTyping(true);
        this._pendingContent = htmlContent;
        this._scheduleSend();

        if (!this._maxDelayTimer) {
            this._maxDelayTimer = setTimeout(() => {
                this._maxDelayTimer = null;
                if (this._pendingContent !== null && this._connected) {
                    clearTimeout(this._sendDebounce);
                    this._doSend();
                }
            }, this._maxDelay);
        }

        clearTimeout(this._typingTimer);
        this._typingTimer = setTimeout(() => this._setTyping(false), 1500);
    }

    _scheduleSend() {
        clearTimeout(this._sendDebounce);
        this._sendDebounce = setTimeout(() => this._doSend(), 300);
    }

    _doSend() {
        if (!this._connected || this._pendingContent === null) return;

        // In-flight guard: hanya 1 request at a time
        if (this._inflight) return;

        const content = this._pendingContent;
        const version = this._serverVersion;

        // Skip kalau content tidak berubah dari yang terakhir diterima server
        if (content === this._lastReceivedContent) {
            this._pendingContent = null;
            return;
        }

        this._inflight       = true;
        this._pendingContent = null;

        if (this._maxDelayTimer) {
            clearTimeout(this._maxDelayTimer);
            this._maxDelayTimer = null;
        }

        this.connection.invoke('SendHtmlUpdate', this.entryId, content, version)
            .catch(err => {
                console.warn('[Collab] SendHtmlUpdate failed:', err);
                this._inflight = false;
                if (this._pendingContent === null) {
                    this._pendingContent = content;
                }
                setTimeout(() => this._scheduleSend(), 1000);
            });
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

    // ── Typing indicator UI ──────────────────────────────────────────

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

    // ── Online users UI ──────────────────────────────────────────────

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
        clearTimeout(this._maxDelayTimer);
        this._setTyping(false);
        this._unbindEditorEvents();
        if (this.connection) {
            this.connection.stop();
            this.connection = null;
        }
    }
}

window.CollaborationClient = CollaborationClient;
