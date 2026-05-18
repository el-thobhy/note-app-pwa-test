/**
 * collaboration.js
 *
 * Client-side collaboration handler.
 *
 * Desain: server-authoritative merge.
 * Client TIDAK merge — server yang merge saat conflict.
 * Client hanya:
 *   1. Kirim content + version ke server
 *   2. Terima ReceiveUpdate dari server → replace editor
 *
 * State yang dijaga:
 *   _serverVersion  = version terakhir yang dikonfirmasi server
 *   _pendingContent = ketikan terbaru yang belum dikirim (null = tidak ada)
 *   _inflight       = apakah ada request yang sedang menunggu response
 *
 * In-flight guard:
 *   Hanya 1 request boleh in-flight ke server.
 *   Kalau user ketik saat ada in-flight, simpan ke _pendingContent.
 *   Setelah ReceiveUpdate diterima (ack), kirim _pendingContent kalau ada.
 *
 * Kenapa ini menghindari race condition:
 *   - Tidak ada 2 request dengan version yang sama
 *   - Server selalu terima request secara serial per entry (SemaphoreSlim)
 *   - Conflict resolution ada di server, bukan di client
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

        // Version terakhir yang dikonfirmasi server
        this._serverVersion  = 0;

        // Ketikan terbaru yang belum dikirim
        // null = tidak ada perubahan lokal yang pending
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

    _registerHandlers() {

        // ── ReceiveDocState ──────────────────────────────────────────
        // Diterima saat join. Apply langsung ke editor.
        this.connection.on('ReceiveDocState', (content, version) => {
            if (!this.editor) return;

            this._serverVersion = version ?? 0;
            this._inflight      = false;

            this._applyingRemote = true;
            try {
                this.editor.setContent(content || '');
            } finally {
                this._applyingRemote = false;
            }

            // Kalau ada pending yang terjadi sebelum join selesai, kirim sekarang
            if (this._pendingContent !== null) {
                this._scheduleSend();
            }
        });

        // ── ReceiveUpdate ────────────────────────────────────────────
        // Diterima setelah:
        //   a) Server accept update kita (ack) — content = merged result
        //   b) Peer kirim update — content = merged result dari server
        //
        // Dalam kedua kasus, REPLACE editor dengan content ini.
        // Server sudah merge, kita tinggal display hasilnya.
        this.connection.on('ReceiveUpdate', (serverContent, serverVersion) => {
            if (!this.editor || !serverContent) return;

            // Ignore stale
            if (serverVersion !== undefined && serverVersion <= this._serverVersion) return;

            this._serverVersion = serverVersion ?? (this._serverVersion + 1);

            // Clear in-flight — server sudah respond
            this._inflight = false;

            // Replace editor content dengan merged result dari server
            this._applyingRemote = true;
            try {
                const current = this.editor.getContent();
                if (current !== serverContent) {
                    const bookmark = this.editor.selection.getBookmark(2, true);
                    this.editor.setContent(serverContent);
                    try { this.editor.selection.moveToBookmark(bookmark); } catch (_) {}
                }
            } finally {
                this._applyingRemote = false;
            }

            // Kalau ada pending yang terjadi saat in-flight, kirim sekarang
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
    // Dipanggil dari TinyMCE event saat konten berubah.
    sendContentUpdate(htmlContent) {
        if (!this._connected || this._applyingRemote) return;

        this._setTyping(true);

        // Simpan ketikan terbaru sebagai pending
        this._pendingContent = htmlContent;

        // Schedule debounced send
        this._scheduleSend();

        // Max delay: force send setelah 2 detik walaupun user masih ngetik
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

        // IN-FLIGHT GUARD: hanya 1 request at a time
        // Kalau ada yang in-flight, pending akan dikirim setelah ReceiveUpdate
        if (this._inflight) return;

        const content = this._pendingContent;
        const version = this._serverVersion;

        // Set in-flight SEBELUM invoke
        this._inflight       = true;
        this._pendingContent = null;

        // Clear max delay timer
        if (this._maxDelayTimer) {
            clearTimeout(this._maxDelayTimer);
            this._maxDelayTimer = null;
        }

        this.connection.invoke('SendHtmlUpdate', this.entryId, content, version)
            .catch(err => {
                console.warn('[Collab] SendHtmlUpdate failed:', err);
                // Kembalikan ke pending supaya bisa retry
                this._inflight = false;
                if (this._pendingContent === null) {
                    this._pendingContent = content;
                }
                // Retry setelah delay
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
        if (this.connection) {
            this.connection.stop();
            this.connection = null;
        }
    }
}

window.CollaborationClient = CollaborationClient;
