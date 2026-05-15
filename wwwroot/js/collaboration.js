/**
 * collaboration.js
 * Real-time collaboration dengan server version guard + client-side 3-way merge.
 *
 * State yang dijaga client:
 *   _serverContent  = konten terakhir yang dikonfirmasi server (via UpdateAck atau ReceiveDocState)
 *   _serverVersion  = version dari _serverContent
 *   _pendingContent = konten lokal terbaru yang belum dikonfirmasi server (null = tidak ada pending)
 *
 * Alur kirim:
 *   user ketik → simpan ke _pendingContent → schedule debounce (300ms)
 *   debounce fire ATAU max delay (2s) → merge(_serverContent, _pendingContent) → kirim ke server
 *   UpdateAck → cek apakah ada ketikan baru sejak kirim:
 *     - tidak ada → reset pending & mergeBase
 *     - ada → update mergeBase ke state terkonfirmasi, reschedule send
 *
 * Alur terima dari peer:
 *   ReceiveUpdate → simpan ke _serverContent + _serverVersion
 *                 → kalau tidak ada pending: apply ke editor
 *                 → kalau ada pending: apply merged ke editor, reschedule send
 *
 * Reconnect:
 *   ReceiveDocState → kalau ada pending: merge pending ke atas state baru, pertahankan pending
 *                   → kalau tidak ada pending: apply langsung
 *
 * Proteksi data loss:
 *   1. UpdateAck hanya reset pending kalau tidak ada ketikan baru (fix race condition)
 *   2. Max delay 2s — force send walaupun user masih ngetik (kurangi window of loss)
 *   3. Reconnect merge — pending tidak dibuang saat reconnect, di-merge ke state baru
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

        // State server — hanya update setelah konfirmasi dari server
        this._serverContent  = '';
        this._serverVersion  = 0;

        // Konten lokal terbaru yang belum dikonfirmasi server
        // null = tidak ada perubahan lokal yang pending
        this._pendingContent = null;

        // Titik divergence: snapshot _serverContent saat user MULAI ketik
        // Dipakai sebagai base di patch_make supaya diff akurat
        // Reset ke null setelah UpdateAck (konfirmasi server)
        this._mergeBase      = null;

        this._sendDebounce = null;
        this._maxDelayTimer = null;   // Force send setelah max delay
        this._maxDelay      = 2000;   // 2 detik max tanpa kirim
        this._isTyping     = false;
        this._typingTimer  = null;

        this._dmp   = null;
        this._peers = new Map();
    }

    async init(editorInstance) {
        this.editor = editorInstance;

        if (typeof diff_match_patch !== 'undefined') {
            this._dmp = new diff_match_patch();
            this._dmp.Patch_Timeout = 1;
        } else {
            console.warn('[Collab] diff-match-patch tidak tersedia, merge fallback ke server content');
        }

        // Init server content dari konten awal editor
        this._serverContent = this.editor.getContent();

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
            this._connected    = true;
            this._serverVersion = 0;
            await this.connection.invoke('JoinEntry', this.entryId, this.displayName, this.avatar);
            this._showStatus('connected');
        });
        this.connection.onreconnecting(() => { this._connected = false; this._showStatus('reconnecting'); });
        this.connection.onclose(()       => { this._connected = false; this._showStatus('disconnected'); });
    }

    _registerHandlers() {
        // State awal saat join — apply langsung, set sebagai server content
        // Kalau ada pending (reconnect case), merge dulu sebelum overwrite
        this.connection.on('ReceiveDocState', (content, version) => {
            if (!content || !this.editor) return;
            this._applyingRemote = true;
            try {
                if (this._pendingContent !== null && this._dmp) {
                    // Reconnect dengan pending — merge perubahan lokal ke atas state server
                    const base = this._mergeBase ?? this._serverContent;
                    const merged = this._merge(content, this._pendingContent);
                    this.editor.setContent(merged);
                    this._serverContent  = content;
                    this._serverVersion  = version ?? 0;
                    // Pertahankan pending supaya dikirim ulang
                    this._pendingContent = merged;
                    this._mergeBase      = base;
                    // Schedule send supaya pending terkirim ke server
                    this._scheduleSend();
                } else {
                    this.editor.setContent(content);
                    this._serverContent  = content;
                    this._serverVersion  = version ?? 0;
                    this._pendingContent = null;
                    this._mergeBase      = null;
                }
            } finally {
                this._applyingRemote = false;
            }
        });

        // Update dari peer ATAU resync dari server
        this.connection.on('ReceiveUpdate', (serverContent, serverVersion) => {
            if (!serverContent || !this.editor) return;

            // Ignore stale — sudah punya version ini atau lebih baru
            if (serverVersion !== undefined && serverVersion <= this._serverVersion) return;

            // Simpan state server terbaru
            this._serverContent = serverContent;
            this._serverVersion = serverVersion ?? (this._serverVersion + 1);

            if (this._pendingContent !== null) {
                // Ada perubahan lokal pending — tampilkan preview merge ke editor
                // supaya user tidak melihat konten "loncat"
                // Merge sebenarnya (yang dikirim ke server) dilakukan di _scheduleSend
                const preview = this._merge(this._serverContent, this._pendingContent);
                this._applyingRemote = true;
                try {
                    if (this.editor.getContent() !== preview) {
                        const bookmark = this.editor.selection.getBookmark(2, true);
                        this.editor.setContent(preview);
                        try { this.editor.selection.moveToBookmark(bookmark); } catch (_) {}
                    }
                } finally {
                    this._applyingRemote = false;
                }
                // Reschedule send — saat fire akan merge ulang dengan _pendingContent terbaru
                this._scheduleSend();
            } else {
                // Tidak ada pending — update murni dari peer, apply ke editor
                this._applyingRemote = true;
                try {
                    if (this.editor.getContent() !== serverContent) {
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
            if (this._lastSentContent !== undefined) {
                this._serverContent = this._lastSentContent;
            }
            this._serverVersion = newVersion;

            // Fix race condition: hanya reset pending kalau TIDAK ada ketikan baru
            // sejak terakhir kirim. Kalau _pendingContent sudah berubah dari yang dikirim,
            // berarti user ketik lagi antara send dan ack — jangan buang.
            if (this._pendingContent === null ||
                this._pendingContent === this._lastSentContent) {
                this._pendingContent = null;
                this._mergeBase      = null;
            } else {
                // Ada ketikan baru sejak terakhir kirim — update mergeBase ke state terkonfirmasi
                // supaya merge berikutnya pakai base yang benar
                this._mergeBase = this._serverContent;
                // Reschedule send untuk pending yang masih ada
                this._scheduleSend();
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

        // Snapshot _serverContent sebagai titik divergence saat user MULAI ketik.
        // Hanya di-set sekali per "sesi ketik" — tidak di-reset selama pending masih ada.
        if (this._pendingContent === null) {
            this._mergeBase = this._serverContent;
        }

        // Simpan ketikan terbaru sebagai pending
        this._pendingContent = htmlContent;

        // Schedule debounced send
        this._scheduleSend();

        // Max delay: force send setelah 2 detik walaupun user masih ngetik
        // Ini mengurangi window of loss dan memastikan peer dapat update periodik
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

    /**
     * Schedule debounced send.
     * Merge dilakukan DI SINI saat debounce fire — bukan saat ReceiveUpdate.
     */
    _scheduleSend() {
        clearTimeout(this._sendDebounce);
        this._sendDebounce = setTimeout(() => this._doSend(), 300);
    }

    /**
     * Eksekusi merge + kirim ke server.
     * Dipisah dari _scheduleSend supaya bisa dipanggil dari max delay timer juga.
     */
    _doSend() {
        if (!this._connected || this._pendingContent === null) return;

        // Merge tepat sebelum kirim — pakai state terbaru
        const toSend = this._merge(this._serverContent, this._pendingContent);

        // Simpan apa yang dikirim supaya UpdateAck bisa compare
        this._lastSentContent = toSend;

        // Clear max delay timer karena kita sudah kirim
        if (this._maxDelayTimer) {
            clearTimeout(this._maxDelayTimer);
            this._maxDelayTimer = null;
        }

        const versionSnapshot = this._serverVersion;

        this.connection.invoke(
            'SendHtmlUpdate',
            this.entryId,
            toSend,
            versionSnapshot
        ).catch(err => console.warn('[Collab] SendHtmlUpdate failed:', err));
    }

    /**
     * Merge server content dengan local pending menggunakan diff-match-patch.
     *
     * base   = _mergeBase  → snapshot _serverContent saat user mulai ketik
     *                         (titik divergence yang benar, tidak bergeser)
     * server = _serverContent terbaru (sudah include perubahan peer)
     * local  = _pendingContent (perubahan lokal yang belum dikonfirmasi)
     *
     * patch_make(base → local) = "apa yang user ubah dari titik awal"
     * patch_apply(patch, server) = "terapkan perubahan user ke atas konten server terbaru"
     */
    _merge(server, local) {
        if (local === server) return local;
        if (!this._dmp)       return local;

        // Pakai _mergeBase sebagai titik divergence yang benar.
        // Fallback ke _serverContent kalau _mergeBase belum di-set.
        const base = this._mergeBase ?? this._serverContent;

        try {
            // Diff: apa yang user ubah dari titik divergence
            const patches = this._dmp.patch_make(base, local);

            // Apply perubahan user ke atas konten server terbaru
            const [merged, results] = this._dmp.patch_apply(patches, server);

            const failCount = results.filter(r => !r).length;
            if (failCount > 0) {
                console.debug(`[Collab] ${failCount}/${results.length} patches failed, server wins for conflicts`);
            }

            return merged;
        } catch (e) {
            console.warn('[Collab] Merge error, using local:', e);
            return local;
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
        clearTimeout(this._maxDelayTimer);
        this._setTyping(false);
        if (this.connection) {
            this.connection.stop();
            this.connection = null;
        }
    }
}

window.CollaborationClient = CollaborationClient;
