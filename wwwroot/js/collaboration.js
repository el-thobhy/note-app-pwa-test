/**
 * collaboration.js
 * Real-time collaboration dengan server-authoritative merge.
 *
 * Strategi:
 * - Client kirim update beserta `clientBase` (versi terakhir yang client ketahui)
 *   dan `clientVersion` ke server.
 * - Server lakukan 3-way merge dan broadcast hasilnya ke SEMUA client di room,
 *   termasuk pengirim.
 * - Client cukup apply hasil dari server — tidak perlu merge sendiri.
 * - `_baseContent` di client hanya di-update setelah menerima konfirmasi dari server
 *   via `ReceiveUpdate`.
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

        // Base = konten terakhir yang dikonfirmasi server (bukan yang kita kirim)
        this._baseContent    = '';
        this._serverVersion  = 0;   // version terakhir yang diterima dari server

        this._sendDebounce   = null;
        this._pendingContent = null; // konten yang akan dikirim saat debounce fire

        this._isTyping       = false;
        this._typingTimer    = null;

        this._peers  = new Map();
    }

    async init(editorInstance) {
        this.editor = editorInstance;

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
        this.connection.on('ReceiveDocState', (content, version) => {
            if (!content || !this.editor) return;
            this._applyingRemote = true;
            try {
                this.editor.setContent(content);
                this._baseContent   = content;
                this._serverVersion = version ?? 0;
            } finally {
                this._applyingRemote = false;
            }
        });

        // Update dari server (hasil merge yang sudah authoritative)
        // Diterima oleh SEMUA client, termasuk pengirim
        this.connection.on('ReceiveUpdate', (serverContent, serverVersion, senderConnectionId) => {
            if (!serverContent || !this.editor) return;

            // Ignore update yang lebih lama dari yang sudah kita punya
            if (serverVersion !== undefined && serverVersion <= this._serverVersion) {
                console.debug('[Collab] Ignoring stale update, serverVer=%d, ourVer=%d',
                    serverVersion, this._serverVersion);
                return;
            }

            const isSelf = senderConnectionId && senderConnectionId === this.connection.connectionId;

            // Selalu update base dan version — ini source of truth dari server
            this._baseContent   = serverContent;
            this._serverVersion = serverVersion ?? (this._serverVersion + 1);

            if (isSelf) {
                // Ini echo dari update kita sendiri — jangan setContent supaya tidak flicker.
                // Base sudah diupdate di atas, cukup.
                // Kalau ada pending content yang berbeda dari hasil merge server,
                // kirim ulang supaya perubahan kita yang belum terkirim tetap masuk.
                if (this._pendingContent !== null && this._pendingContent !== serverContent) {
                    this._scheduleSend(this._pendingContent);
                } else {
                    this._pendingContent = null;
                }
                return;
            }

            // Update dari peer — apply ke editor
            this._applyingRemote = true;
            try {
                const localContent = this.editor.getContent();

                if (localContent !== serverContent) {
                    const bookmark = this.editor.selection.getBookmark(2, true);
                    this.editor.setContent(serverContent);
                    try { this.editor.selection.moveToBookmark(bookmark); } catch (_) {}
                }

                // Kalau ada pending content yang belum dikirim, kirim ulang dengan base baru
                if (this._pendingContent !== null && this._pendingContent !== serverContent) {
                    this._scheduleSend(this._pendingContent);
                } else {
                    this._pendingContent = null;
                }
            } finally {
                this._applyingRemote = false;
            }
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
     * Dipanggil dari TinyMCE event saat konten berubah.
     * Simpan sebagai pending dan schedule debounced send.
     */
    sendContentUpdate(htmlContent) {
        if (!this._connected || this._applyingRemote) return;

        this._setTyping(true);

        // Simpan konten terbaru sebagai pending
        this._pendingContent = htmlContent;

        this._scheduleSend(htmlContent);

        clearTimeout(this._typingTimer);
        this._typingTimer = setTimeout(() => {
            this._setTyping(false);
        }, 1500);
    }

    /**
     * Schedule debounced send ke server.
     * Kirim beserta `clientBase` (base yang kita ketahui) dan `clientVersion`
     * supaya server bisa lakukan 3-way merge yang benar.
     */
    _scheduleSend(htmlContent) {
        clearTimeout(this._sendDebounce);
        this._sendDebounce = setTimeout(() => {
            if (!this._connected) return;

            // Snapshot base dan version saat ini sebelum kirim
            const baseSnapshot    = this._baseContent;
            const versionSnapshot = this._serverVersion;

            this.connection.invoke(
                'SendHtmlUpdate',
                this.entryId,
                htmlContent,
                baseSnapshot,
                versionSnapshot
            ).catch(err => {
                console.warn('[Collab] SendHtmlUpdate failed:', err);
            });

            // TIDAK update _baseContent di sini.
            // Base hanya update setelah server konfirmasi via ReceiveUpdate.
        }, 300);
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
