/**
 * collab-editor_2.js
 * Real-time collaboration: server LWW version guard + client-side 3-way merge.
 *
 * Alur normal:
 *   1. User ketik → simpan ke _pendingContent, schedule debounced send
 *   2. Saat debounce fire: kalau tidak ada op in-flight, kirim (content, clientVersion)
 *      Kalau ada in-flight: tunda, kirim setelah AckOp diterima
 *   3a. Server accept (clientVersion >= serverVersion):
 *       → broadcast ke peers via ReceiveUpdate
 *       → kirim UpdateAck ke pengirim → update _serverVersion, clear pending
 *   3b. Server reject (client ketinggalan):
 *       → kirim ReceiveUpdate dengan state terbaru ke pengirim
 *       → client merge: _threeWayMerge(_baseContent, serverContent, _pendingContent)
 *       → kirim hasil merge sebagai update baru
 *
 * Race condition fix:
 *   - _inflight flag: tidak kirim op baru saat masih menunggu AckOp
 *   - Setelah AckOp: kalau ada pending baru, langsung kirim
 *   - ReceiveDocState/ReceiveUpdate: normalisasi content setelah setContent()
 *     supaya _baseContent selalu dalam format yang sudah di-normalize TinyMCE
 *
 * _baseContent = content terakhir yang dikonfirmasi server (normalized)
 * _pendingContent = content lokal terbaru yang belum dikonfirmasi (atau null)
 * _inflight = true saat ada op yang sudah dikirim, menunggu AckOp
 */

class CollaborationClient {
    constructor(entryId, displayName, avatar) {
        this.entryId = String(entryId);
        this.displayName = displayName;
        this.avatar = avatar;
        this.connection = null;
        this.editor = null;

        this._connected = false;
        this._initialized = false; // true setelah ReceiveDocState diterima
        this._applyingRemote = false;

        this._baseContent = '';   // content terakhir yang dikonfirmasi server (normalized)
        this._serverVersion = 0;
        this._pendingContent = null; // content lokal terbaru yang belum dikonfirmasi

        // Race condition guard: jangan kirim op baru saat masih menunggu AckOp
        this._inflight = false;

        this._sendDebounce = null;
        this._maxDelayTimer = null;
        this._isTyping = false;
        this._typingTimer = null;

        this._dmp = null;
        this._peers = new Map();
    }

    async init(editorInstance) {
        this.editor = editorInstance;

        if (typeof diff_match_patch !== 'undefined') {
            this._dmp = new diff_match_patch();
            this._dmp.Match_Threshold = 0.5;
            this._dmp.Match_Distance = 5000;
            this._dmp.Patch_Timeout = 1;
        } else {
            console.warn('[Collab] diff-match-patch tidak tersedia');
        }

        if (typeof OTEngine !== 'undefined') {
            this._otEngine = new OTEngine();
            console.log('[Collab] OTEngine initialized for 3-way merge');
        } else {
            console.warn('[Collab] OTEngine tidak tersedia');
        }

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
            this._initialized = false;
            this._inflight = false;
            this._pendingContent = null;
            this._serverVersion = 0;
            clearTimeout(this._sendDebounce);
            clearTimeout(this._maxDelayTimer);
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

        /**
         * ReceiveDocState — diterima saat join, ini initial state dari server.
         * Set editor ke content ini, jadikan baseline.
         * Setelah setContent, baca kembali untuk dapat versi normalized TinyMCE.
         */
        this.connection.on('ReceiveDocState', (content, version) => {
            if (!this.editor) return;
            this._applyingRemote = true;
            try {
                this.editor.setContent(content ?? '');
                // Baca kembali setelah normalisasi TinyMCE
                const normalized = this.editor.getContent();
                this._baseContent = normalized;
                this._serverVersion = version ?? 0;
                this._pendingContent = null;
                this._inflight = false;
                this._initialized = true;
            } finally {
                this._applyingRemote = false;
            }
        });

        /**
         * ReceiveUpdate — dua kasus:
         * (A) Update dari peer → apply ke editor
         * (B) Resync dari server karena client ketinggalan → merge lalu kirim ulang
         *
         * Setelah setContent, selalu baca kembali untuk normalisasi.
         */
        this.connection.on('ReceiveUpdate', (serverContent, serverVersion) => {
            if (!this.editor) return;
            if (serverVersion !== undefined && serverVersion <= this._serverVersion) return;

            const prevBase = this._baseContent;
            const pending = this._pendingContent;

            this._serverVersion = serverVersion ?? (this._serverVersion + 1);

            if (pending !== null && pending !== serverContent) {
                // Ada perubahan lokal yang belum dikonfirmasi server
                // Merge: base=prevBase, server=serverContent, local=pending
                const merged = this._threeWayMerge(prevBase, serverContent, pending);

                this._applyingRemote = true;
                try {
                    const bookmark = this._getBookmark();
                    
                    // Dapatkan versi normalisasi dari serverContent untuk _baseContent
                    this.editor.setContent(serverContent);
                    const normalizedServer = this.editor.getContent();
                    
                    // Set kembali ke merged content untuk editor dan _pendingContent
                    this.editor.setContent(merged);
                    const normalizedMerged = this.editor.getContent();
                    
                    this._baseContent    = normalizedServer;
                    this._pendingContent = normalizedMerged;
                    this._restoreBookmark(bookmark);
                } finally {
                    this._applyingRemote = false;
                }

                // Kirim hasil merge ke server — reset inflight dulu supaya bisa kirim
                this._inflight = false;
                this._sendNow(this._pendingContent);

            } else {
                // Tidak ada pending — update murni dari peer, apply ke editor
                this._pendingContent = null;
                this._applyingRemote = true;
                try {
                    const localContent = this.editor.getContent();
                    if (localContent !== serverContent) {
                        const bookmark = this._getBookmark();
                        this.editor.setContent(serverContent);
                        const normalized = this.editor.getContent();
                        this._baseContent = normalized;
                        this._restoreBookmark(bookmark);
                    } else {
                        this._baseContent = localContent;
                    }
                } finally {
                    this._applyingRemote = false;
                }
            }
        });

        /**
         * UpdateAck — server konfirmasi op kita diterima.
         * Clear inflight, update version.
         * Kalau ada pending baru yang terkumpul saat in-flight, kirim sekarang.
         */
        this.connection.on('UpdateAck', (newVersion) => {
            this._serverVersion = newVersion;
            this._inflight = false;

            // Kalau ada perubahan lokal yang terkumpul saat in-flight, kirim sekarang
            if (this._pendingContent !== null && this._pendingContent !== this._baseContent) {
                this._sendNow(this._pendingContent);
            } else {
                this._pendingContent = null;
            }
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
                this._peers.set(u.connectionId, { displayName: u.displayName, color: u.color });
            });
        });
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /**
     * Dipanggil dari TinyMCE event saat konten berubah.
     * Jangan kirim apa-apa sebelum ReceiveDocState diterima.
     */
    sendContentUpdate(htmlContent) {
        if (!this._connected || this._applyingRemote || !this._initialized) return;

        this._pendingContent = htmlContent;
        this._setTyping(true);
        this._scheduleDebounce();

        clearTimeout(this._typingTimer);
        this._typingTimer = setTimeout(() => this._setTyping(false), 1500);
    }

    destroy() {
        clearTimeout(this._sendDebounce);
        clearTimeout(this._maxDelayTimer);
        clearTimeout(this._typingTimer);
        this._setTyping(false);
        if (this.connection) {
            this.connection.stop();
            this.connection = null;
        }
        this._initialized = false;
        this._inflight = false;
    }

    // ── Send logic ───────────────────────────────────────────────────────────

    /**
     * Schedule debounced send.
     * Juga set max-delay timer supaya tidak terlalu lama nunggu debounce.
     */
    _scheduleDebounce() {
        clearTimeout(this._sendDebounce);
        this._sendDebounce = setTimeout(() => {
            this._flushPending();
        }, 300);

        // Max delay: force flush setelah 2 detik meski user masih ketik
        if (!this._maxDelayTimer) {
            this._maxDelayTimer = setTimeout(() => {
                this._maxDelayTimer = null;
                clearTimeout(this._sendDebounce);
                this._flushPending();
            }, 2000);
        }
    }

    /**
     * Flush pending content ke server kalau tidak ada op in-flight.
     * Kalau ada in-flight, pending akan dikirim saat AckOp diterima.
     */
    _flushPending() {
        clearTimeout(this._maxDelayTimer);
        this._maxDelayTimer = null;

        if (!this._connected || !this._initialized) return;
        if (this._pendingContent === null) return;
        if (this._pendingContent === this._baseContent) {
            this._pendingContent = null;
            return;
        }
        if (this._inflight) {
            // Ada op in-flight — pending akan dikirim saat AckOp
            return;
        }

        this._sendNow(this._pendingContent);
    }

    /**
     * Kirim content ke server sekarang (tanpa debounce).
     * Set _inflight = true, update _baseContent ke content yang dikirim.
     */
    _sendNow(content) {
        if (!this._connected || this._inflight) return;
        if (content === this._baseContent) {
            this._pendingContent = null;
            return;
        }

        const versionSnapshot = this._serverVersion;
        this._inflight = true;
        // Update base ke content yang kita kirim — ini jadi titik divergence baru
        this._baseContent = content;

        this.connection.invoke('SendHtmlUpdate', this.entryId, content, versionSnapshot)
            .catch(err => {
                console.warn('[Collab] SendHtmlUpdate failed:', err);
                // Rollback: biarkan pending tetap ada, reset inflight supaya bisa retry
                this._inflight = false;
                this._baseContent = this._baseContent; // tidak berubah, sudah di-set
                // Retry setelah delay
                setTimeout(() => this._flushPending(), 1000);
            });
    }

    // ── 3-way merge ──────────────────────────────────────────────────────────

    /**
     * 3-way merge menggunakan diff-match-patch.
     *
     * base   = titik divergence terakhir yang dikonfirmasi server
     * server = content terbaru dari server (sudah include perubahan peer)
     * local  = perubahan lokal yang belum dikonfirmasi
     *
     * Strategi: buat patch dari base→local, apply ke server content.
     * Artinya: perubahan lokal di-overlay ke atas perubahan server.
     * Conflict resolution: server wins untuk bagian yang conflict.
     */
    _threeWayMerge(base, server, local) {
        if (local === base) return server; // tidak ada perubahan lokal
        if (server === base) return local;  // tidak ada perubahan server
        if (local === server) return local;  // sudah sama

        if (this._otEngine) {
            try {
                console.log('[Collab] Using OTEngine for three-way merge');
                return this._otEngine.smartThreeWayMerge(base, local, server);
            } catch (e) {
                console.warn('[Collab] OTEngine merge failed, falling back to diff-match-patch:', e);
            }
        }

        if (!this._dmp) return server; // fallback tanpa dmp

        try {
            const localPatches = this._dmp.patch_make(base, local);
            const [merged, results] = this._dmp.patch_apply(localPatches, server);
            const failCount = results.filter(r => !r).length;
            if (failCount > 0) {
                console.debug(`[Collab] Merge: ${failCount}/${results.length} patches failed, server wins for those parts`);
            }
            return merged;
        } catch (e) {
            console.warn('[Collab] Merge failed, using server content:', e);
            return server;
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    _getBookmark() {
        try { return this.editor.selection.getBookmark(2, true); } catch (_) { return null; }
    }

    _restoreBookmark(bookmark) {
        if (!bookmark) return;
        try { this.editor.selection.moveToBookmark(bookmark); } catch (_) { }
    }

    _setTyping(isTyping) {
        if (this._isTyping === isTyping) return;
        this._isTyping = isTyping;
        if (this._connected && this.connection) {
            this.connection.invoke('SendAwareness', this.entryId, {
                isTyping: isTyping,
                displayName: this.displayName
            }).catch(() => { });
        }
    }

    // ── UI ───────────────────────────────────────────────────────────────────

    _showPeerTyping(connectionId, displayName, color) {
        const container = document.getElementById('collab-typing-indicators');
        if (!container) return;
        const id = `typing-${connectionId.replace(/[^a-z0-9]/gi, '')}`;
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('span');
            el.id = id;
            el.style.cssText =
                `background:${color}22;border:1px solid ${color};color:${color};` +
                `border-radius:12px;padding:2px 10px;font-size:0.75rem;` +
                `font-weight:600;display:inline-flex;align-items:center;gap:5px;`;
            el.innerHTML =
                `<span style="width:7px;height:7px;border-radius:50%;background:${color};` +
                `display:inline-block;animation:collab-pulse 1s infinite;"></span>` +
                `${displayName} mengetik...`;
            container.appendChild(el);
        }
        const peer = this._peers.get(connectionId) || {};
        clearTimeout(peer.typingTimer);
        peer.typingTimer = setTimeout(() => this._hidePeerTyping(connectionId), 3000);
        this._peers.set(connectionId, { ...peer, displayName, color });
    }

    _hidePeerTyping(connectionId) {
        const el = document.getElementById(`typing-${connectionId.replace(/[^a-z0-9]/gi, '')}`);
        if (el) el.remove();
    }

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
            connected: { text: '● Online', cls: 'text-success' },
            disconnected: { text: '● Offline', cls: 'text-danger' },
            reconnecting: { text: '● Reconnecting...', cls: 'text-warning' },
            error: { text: '● Error', cls: 'text-danger' },
        };
        const s = map[status] || map.disconnected;
        el.textContent = s.text;
        el.className = `collab-status-text ${s.cls}`;
    }
}

window.CollaborationClient = CollaborationClient;
