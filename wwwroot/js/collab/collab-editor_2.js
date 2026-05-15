/**
 * Collaborative Editor v2 - Race-condition-free real-time collaboration
 * 
 * SignalR (@microsoft/signalr) + diff-match-patch
 * 
 * ============================================================
 * STRATEGI ANTI RACE CONDITION:
 * ============================================================
 * 
 * 1. IN-FLIGHT GUARD: Hanya 1 request boleh in-flight ke server.
 *    Kalau ada request in-flight, perubahan baru di-queue sebagai pending.
 *    Setelah ack/resync diterima, baru kirim pending berikutnya.
 *
 * 2. STRICT VERSION: Server pakai strict equality (baseVersion == serverVersion).
 *    Kalau 2 client kirim bersamaan, yang kedua akan di-reject (Resync).
 *    Client yang di-reject harus merge ulang di atas state terbaru.
 *
 * 3. CONFIRMED BASE: Merge selalu pakai _confirmedContent sebagai base.
 *    _confirmedContent HANYA di-update setelah UpdateAck dari server.
 *    Ini memastikan patch yang dibuat selalu relatif terhadap state yang benar.
 *
 * 4. RESYNC RECOVERY: Saat server reject (Resync), client:
 *    - Update _confirmedContent dan _confirmedVersion ke state server
 *    - Merge ulang pending di atas state baru
 *    - Kirim ulang otomatis
 *
 * ============================================================
 * DEPENDENCIES:
 * ============================================================
 *   - signalr.min.js (@microsoft/signalr)
 *   - diff_match_patch.js
 *   - TinyMCE (sudah diinisialisasi)
 *
 * ============================================================
 * CARA PAKAI:
 * ============================================================
 * 
 *   tinymce.init({
 *       selector: '#editor',
 *       setup: function(editor) {
 *           editor.on('init', function() {
 *               CollabEditor.attach(editor, {
 *                   userName: 'Budi',
 *                   avatar: '/img/budi.png',
 *                   documentId: 'entry-123',
 *                   hubUrl: '/hubs/collaboration',
 *                   debounceMs: 200,
 *                   maxDelayMs: 1500
 *               });
 *           });
 *       }
 *   });
 *
 * ============================================================
 * PUBLIC API:
 * ============================================================
 * 
 *   CollabEditor.attach(editor, options)
 *   CollabEditor.detach()
 *   CollabEditor.getContent()
 *   CollabEditor.setContent(html)
 *   CollabEditor.disconnect()
 *   CollabEditor.reconnect()
 *   CollabEditor.isConnected()
 *   CollabEditor.isReady()
 *   CollabEditor.sendChanges()
 */

var CollabEditor = (function () {
    'use strict';

    // === PRIVATE STATE ===
    var _config = {};
    var _dmp = null;
    var _connection = null;
    var _editor = null;
    var _attached = false;
    var _connected = false;

    // === CONFIRMED STATE (hanya update setelah ack dari server) ===
    // Ini adalah "ground truth" — base untuk semua merge operations
    var _confirmedContent = '';
    var _confirmedVersion = 0;

    // === IN-FLIGHT STATE ===
    // Content yang sedang dikirim ke server, menunggu ack/resync
    var _inflightContent = null;
    var _inflightVersion = null; // baseVersion yang dikirim

    // === PENDING STATE ===
    // Perubahan lokal yang belum dikirim (karena ada in-flight)
    // null = tidak ada perubahan baru sejak terakhir kirim
    var _pendingContent = null;

    // Flags
    var _isRemoteUpdate = false;
    var _isTyping = false;

    // Timers
    var _sendDebounce = null;
    var _maxDelayTimer = null;
    var _typingTimer = null;

    // Bound handlers for cleanup
    var _boundHandlers = {};

    // Peers tracking
    var _peers = new Map();

    // === DEFAULT OPTIONS ===
    var _defaults = {
        userName: 'Anonymous',
        avatar: '',
        documentId: 'default',
        hubUrl: '/hubs/collaboration',
        debounceMs: 200,
        maxDelayMs: 1500,
        onUserListChanged: null,
        onConnectionChanged: null,
        onRemoteEdit: null,
        onLocalEdit: null
    };

    // === PRIVATE METHODS ===

    function _initDiffMatchPatch() {
        if (typeof diff_match_patch === 'undefined') {
            console.warn('[CollabEditor] diff_match_patch not loaded, merge disabled.');
            return true;
        }
        _dmp = new diff_match_patch();
        _dmp.Patch_Timeout = 1;
        return true;
    }

    /**
     * 3-way merge: apply perubahan dari `base→local` ke atas `server`.
     * 
     * @param {string} base - Titik divergence (confirmed content saat user mulai edit)
     * @param {string} local - Konten lokal user
     * @param {string} server - Konten server terbaru
     * @returns {string} Merged content
     */
    function _merge3(base, local, server) {
        if (local === server) return local;
        if (local === base) return server; // user tidak ubah apa-apa, ambil server
        if (server === base) return local; // server tidak berubah, ambil local
        if (!_dmp) return local; // no merge capability, prefer local

        try {
            // Buat patch dari base → local (apa yang user ubah)
            var patches = _dmp.patch_make(base, local);
            // Apply patch ke atas server content
            var result = _dmp.patch_apply(patches, server);
            var merged = result[0];
            var success = result[1];

            var failCount = success.filter(function (s) { return !s; }).length;
            if (failCount > 0) {
                console.debug('[CollabEditor] ' + failCount + '/' + success.length + ' patches failed — server wins for conflicts');
            }

            return merged;
        } catch (e) {
            console.warn('[CollabEditor] Merge error, preferring local:', e);
            return local;
        }
    }

    /**
     * Hitung "effective content" — apa yang seharusnya ditampilkan di editor.
     * Ini adalah merge dari semua layer: confirmed + inflight + pending
     */
    function _getEffectiveContent() {
        // Start dari confirmed
        var effective = _confirmedContent;

        // Layer 1: apply inflight changes
        if (_inflightContent !== null) {
            effective = _inflightContent;
        }

        // Layer 2: apply pending changes di atas effective
        if (_pendingContent !== null) {
            // Base untuk pending = state sebelum pending dimulai
            // Kalau ada inflight, base = inflight content (karena pending dimulai setelah inflight dikirim)
            // Kalau tidak ada inflight, base = confirmed content
            var pendingBase = _inflightContent !== null ? _inflightContent : _confirmedContent;
            effective = _merge3(pendingBase, _pendingContent, effective);
        }

        return effective;
    }

    function _buildConnection() {
        if (typeof signalR === 'undefined') {
            console.error('[CollabEditor] @microsoft/signalr not loaded.');
            return false;
        }

        _connection = new signalR.HubConnectionBuilder()
            .withUrl(_config.hubUrl)
            .withAutomaticReconnect([0, 1000, 3000, 5000])
            .build();

        _registerHubHandlers();
        return true;
    }

    function _registerHubHandlers() {

        // === ReceiveDocState: State awal saat join ===
        _connection.on('ReceiveDocState', function (content, version) {
            if (!_editor) return;

            _isRemoteUpdate = true;
            try {
                _confirmedContent = content || '';
                _confirmedVersion = version || 0;

                // Reset inflight — server state sudah fresh
                _inflightContent = null;
                _inflightVersion = null;

                if (_pendingContent !== null) {
                    // Ada pending — merge ke atas state baru
                    var merged = _merge3(_confirmedContent, _pendingContent, _confirmedContent);
                    _pendingContent = merged;
                    _updateEditor(merged);
                    // Schedule send
                    _scheduleSend();
                } else {
                    _updateEditor(_confirmedContent);
                }
            } finally {
                _isRemoteUpdate = false;
            }

            _fireCallback('onRemoteEdit');
        });

        // === ReceiveUpdate: Update dari peer (broadcast) ===
        _connection.on('ReceiveUpdate', function (serverContent, serverVersion) {
            if (!_editor || !serverContent) return;

            // Ignore stale updates
            if (serverVersion !== undefined && serverVersion <= _confirmedVersion) return;

            _isRemoteUpdate = true;
            try {
                // Update confirmed state
                var oldConfirmed = _confirmedContent;
                _confirmedContent = serverContent;
                _confirmedVersion = serverVersion;

                // Recalculate effective content
                if (_inflightContent !== null || _pendingContent !== null) {
                    // Ada local changes — merge dan tampilkan
                    var effective = _getEffectiveContent();
                    _updateEditor(effective);
                } else {
                    // Tidak ada local changes — apply langsung
                    _updateEditor(serverContent);
                }
            } finally {
                _isRemoteUpdate = false;
            }

            _fireCallback('onRemoteEdit');
        });

        // === UpdateAck: Server accepted our update ===
        _connection.on('UpdateAck', function (newVersion, acceptedContent) {
            // Server confirmed our inflight content
            _confirmedContent = acceptedContent || _inflightContent || _confirmedContent;
            _confirmedVersion = newVersion;

            // Clear inflight
            _inflightContent = null;
            _inflightVersion = null;

            // Kalau ada pending, kirim sekarang
            if (_pendingContent !== null) {
                _doSend();
            }
        });

        // === Resync: Server rejected our update (version mismatch) ===
        _connection.on('Resync', function (serverContent, serverVersion) {
            _isRemoteUpdate = true;
            try {
                // Server bilang: "base version kamu salah, ini state terbaru"
                // Kita harus merge ulang inflight + pending di atas state baru

                var oldConfirmed = _confirmedContent;
                _confirmedContent = serverContent;
                _confirmedVersion = serverVersion;

                // Merge inflight content yang ditolak ke atas server state
                var recoveredLocal = _inflightContent;
                if (_pendingContent !== null) {
                    // Gabungkan inflight + pending sebagai "total local changes"
                    recoveredLocal = _pendingContent;
                }

                // Clear inflight (sudah ditolak)
                _inflightContent = null;
                _inflightVersion = null;

                if (recoveredLocal !== null && recoveredLocal !== serverContent) {
                    // Merge local changes ke atas server state baru
                    var merged = _merge3(oldConfirmed, recoveredLocal, serverContent);
                    _pendingContent = merged;
                    _updateEditor(merged);
                    // Kirim ulang segera (tanpa debounce penuh, tapi beri sedikit jeda)
                    setTimeout(function () { _doSend(); }, 50);
                } else {
                    _pendingContent = null;
                    _updateEditor(serverContent);
                }
            } finally {
                _isRemoteUpdate = false;
            }
        });

        // === Awareness (typing indicators) ===
        _connection.on('ReceiveAwareness', function (data) {
            if (data.isTyping) {
                _showPeerTyping(data.connectionId, data.displayName, data.color);
            } else {
                _hidePeerTyping(data.connectionId);
            }
        });

        // === Online users ===
        _connection.on('UsersOnline', function (users) {
            _renderOnlineUsers(users);
            users.forEach(function (u) {
                if (!_peers.has(u.connectionId)) {
                    _peers.set(u.connectionId, { displayName: u.displayName, color: u.color });
                }
            });
            _fireCallback('onUserListChanged', users);
        });
    }

    /**
     * Update editor content dengan preserve cursor position.
     */
    function _updateEditor(content) {
        if (!_editor) return;
        if (_editor.getContent() === content) return; // no-op

        var bookmark = null;
        try { bookmark = _editor.selection.getBookmark(2, true); } catch (e) { }

        _editor.setContent(content);

        if (bookmark) {
            try { _editor.selection.moveToBookmark(bookmark); } catch (e) { }
        }
    }

    function _startConnection() {
        _connection.start().then(function () {
            _connected = true;
            _connection.invoke('JoinEntry', _config.documentId, _config.userName, _config.avatar);
            _fireConnectionChanged('connected');
        }).catch(function (err) {
            _connected = false;
            console.error('[CollabEditor] Connection failed:', err);
            _fireConnectionChanged('error');
        });

        _connection.onreconnected(function () {
            _connected = true;
            _confirmedVersion = 0;
            _inflightContent = null;
            _inflightVersion = null;
            _connection.invoke('JoinEntry', _config.documentId, _config.userName, _config.avatar);
            _fireConnectionChanged('connected');
        });

        _connection.onreconnecting(function () {
            _connected = false;
            _fireConnectionChanged('reconnecting');
        });

        _connection.onclose(function () {
            _connected = false;
            _fireConnectionChanged('disconnected');
        });
    }

    function _fireConnectionChanged(status) {
        _showStatus(status);
        if (typeof _config.onConnectionChanged === 'function') {
            _config.onConnectionChanged(status);
        }
    }

    function _fireCallback(name, data) {
        if (typeof _config[name] === 'function') {
            _config[name](data);
        }
    }

    function _scheduleSend() {
        clearTimeout(_sendDebounce);
        _sendDebounce = setTimeout(function () {
            _doSend();
        }, _config.debounceMs);
    }

    /**
     * Kirim pending content ke server.
     * 
     * GUARD: Tidak boleh kirim kalau:
     * - Tidak connected
     * - Tidak ada pending
     * - Ada request in-flight (tunggu ack/resync dulu)
     */
    function _doSend() {
        if (!_connected || _pendingContent === null) return;

        // IN-FLIGHT GUARD: tunggu ack/resync sebelum kirim lagi
        if (_inflightContent !== null) {
            // Sudah ada yang in-flight, pending akan dikirim setelah ack
            return;
        }

        // Merge pending di atas confirmed untuk menghasilkan content yang dikirim
        var toSend = _pendingContent;

        // Kalau pending sama dengan confirmed, tidak perlu kirim
        if (toSend === _confirmedContent) {
            _pendingContent = null;
            return;
        }

        // Pindahkan pending ke inflight
        _inflightContent = toSend;
        _inflightVersion = _confirmedVersion; // base version yang kita pakai
        _pendingContent = null;

        // Clear max delay timer
        if (_maxDelayTimer) {
            clearTimeout(_maxDelayTimer);
            _maxDelayTimer = null;
        }

        _connection.invoke('SendHtmlUpdate', _config.documentId, toSend, _inflightVersion)
            .catch(function (err) {
                console.warn('[CollabEditor] SendHtmlUpdate failed:', err);
                // Kembalikan inflight ke pending untuk retry
                if (_pendingContent !== null) {
                    // Ada pending baru — merge inflight + pending
                    _pendingContent = _merge3(_confirmedContent, _pendingContent, _inflightContent);
                } else {
                    _pendingContent = _inflightContent;
                }
                _inflightContent = null;
                _inflightVersion = null;
                // Retry setelah delay
                setTimeout(function () { _scheduleSend(); }, 1000);
            });

        _fireCallback('onLocalEdit');
    }

    function _onContentChange() {
        if (_isRemoteUpdate || !_attached || !_editor || !_connected) return;

        var htmlContent = _editor.getContent();

        // Ignore kalau content sama dengan yang sudah confirmed + inflight
        var currentEffective = _getEffectiveContent();
        if (htmlContent === currentEffective && htmlContent === _confirmedContent) return;

        _setTyping(true);

        // Simpan sebagai pending
        _pendingContent = htmlContent;

        // Schedule send (dengan debounce)
        _scheduleSend();

        // Max delay: force send setelah N ms
        if (!_maxDelayTimer) {
            _maxDelayTimer = setTimeout(function () {
                _maxDelayTimer = null;
                if (_pendingContent !== null && _connected) {
                    clearTimeout(_sendDebounce);
                    _doSend();
                }
            }, _config.maxDelayMs);
        }

        clearTimeout(_typingTimer);
        _typingTimer = setTimeout(function () { _setTyping(false); }, 1500);
    }

    function _setTyping(isTyping) {
        if (_isTyping === isTyping) return;
        _isTyping = isTyping;
        if (_connected && _connection) {
            _connection.invoke('SendAwareness', _config.documentId, {
                isTyping: isTyping,
                displayName: _config.userName
            }).catch(function () { });
        }
    }

    function _bindEditorEvents() {
        _boundHandlers.onChange = function () { _onContentChange(); };
        _boundHandlers.onKeyup = function () { _onContentChange(); };
        _boundHandlers.onPaste = function () { _onContentChange(); };
        _boundHandlers.onUndo = function () { _onContentChange(); };
        _boundHandlers.onRedo = function () { _onContentChange(); };

        _editor.on('Change', _boundHandlers.onChange);
        _editor.on('KeyUp', _boundHandlers.onKeyup);
        _editor.on('Paste', _boundHandlers.onPaste);
        _editor.on('Undo', _boundHandlers.onUndo);
        _editor.on('Redo', _boundHandlers.onRedo);
    }

    function _unbindEditorEvents() {
        if (_editor && _boundHandlers.onChange) {
            _editor.off('Change', _boundHandlers.onChange);
            _editor.off('KeyUp', _boundHandlers.onKeyup);
            _editor.off('Paste', _boundHandlers.onPaste);
            _editor.off('Undo', _boundHandlers.onUndo);
            _editor.off('Redo', _boundHandlers.onRedo);
        }
        _boundHandlers = {};
    }

    // === UI HELPERS ===

    function _showPeerTyping(connectionId, displayName, color) {
        var container = document.getElementById('collab-typing-indicators');
        if (!container) return;

        var id = 'typing-' + connectionId.replace(/[^a-z0-9]/gi, '');
        var el = document.getElementById(id);

        if (!el) {
            el = document.createElement('span');
            el.id = id;
            el.style.cssText =
                'background:' + color + '22; border:1px solid ' + color + '; color:' + color + ';' +
                'border-radius:12px; padding:2px 10px; font-size:0.75rem;' +
                'font-weight:600; display:inline-flex; align-items:center; gap:5px;';
            el.innerHTML =
                '<span style="width:7px;height:7px;border-radius:50%;background:' + color + ';' +
                'display:inline-block;animation:collab-pulse 1s infinite;"></span>' +
                displayName + ' mengetik...';
            container.appendChild(el);
        }

        var peer = _peers.get(connectionId) || {};
        clearTimeout(peer.typingTimer);
        peer.typingTimer = setTimeout(function () { _hidePeerTyping(connectionId); }, 3000);
        _peers.set(connectionId, Object.assign({}, peer, { displayName: displayName, color: color }));
    }

    function _hidePeerTyping(connectionId) {
        var id = 'typing-' + connectionId.replace(/[^a-z0-9]/gi, '');
        var el = document.getElementById(id);
        if (el) el.remove();
    }

    function _renderOnlineUsers(users) {
        var container = document.getElementById('collab-users');
        if (!container) return;

        container.innerHTML = '';
        users.forEach(function (user) {
            var el = document.createElement('div');
            el.className = 'collab-avatar';
            el.title = user.displayName;
            el.style.borderColor = user.color;
            el.style.outline = '2px solid ' + user.color;

            if (user.avatar) {
                el.innerHTML = '<img src="' + user.avatar + '" alt="' + user.displayName + '" />';
            } else {
                var initials = user.displayName.split(' ')
                    .map(function (n) { return n[0]; }).join('').substring(0, 2).toUpperCase();
                el.innerHTML = '<span style="background:' + user.color + '">' + initials + '</span>';
            }
            container.appendChild(el);
        });

        var counter = document.getElementById('collab-count');
        if (counter) {
            counter.textContent = users.length > 1
                ? users.length + ' orang sedang mengedit'
                : 'Hanya kamu';
        }
    }

    function _showStatus(status) {
        var el = document.getElementById('collab-status');
        if (!el) return;
        var map = {
            connected: { text: '\u25CF Online', cls: 'text-success' },
            disconnected: { text: '\u25CF Offline', cls: 'text-danger' },
            reconnecting: { text: '\u25CF Reconnecting...', cls: 'text-warning' },
            error: { text: '\u25CF Error', cls: 'text-danger' }
        };
        var s = map[status] || map.disconnected;
        el.textContent = s.text;
        el.className = 'collab-status-text ' + s.cls;
    }

    function _resetState() {
        _editor = null;
        _connection = null;
        _dmp = null;
        _attached = false;
        _connected = false;
        _confirmedContent = '';
        _confirmedVersion = 0;
        _inflightContent = null;
        _inflightVersion = null;
        _pendingContent = null;
        _isRemoteUpdate = false;
        _isTyping = false;
        _sendDebounce = null;
        _maxDelayTimer = null;
        _typingTimer = null;
        _boundHandlers = {};
        _peers = new Map();
    }

    // === PUBLIC API ===
    return {
        attach: function (editor, options) {
            if (!editor) {
                console.error('[CollabEditor] Editor instance is required.');
                return;
            }

            if (_attached) {
                this.detach();
            }

            _config = Object.assign({}, _defaults, options);
            _editor = editor;

            _initDiffMatchPatch();
            if (!_buildConnection()) return;

            _confirmedContent = _editor.getContent();
            _bindEditorEvents();
            _attached = true;
            _startConnection();

            console.log('[CollabEditor] Attached | Doc: ' + _config.documentId + ' | User: ' + _config.userName);
        },

        detach: function () {
            clearTimeout(_sendDebounce);
            clearTimeout(_maxDelayTimer);
            clearTimeout(_typingTimer);

            _setTyping(false);
            _unbindEditorEvents();

            if (_connection) {
                _connection.stop();
            }

            _resetState();
            console.log('[CollabEditor] Detached.');
        },

        getContent: function () {
            if (!_attached || !_editor) return '';
            return _editor.getContent();
        },

        setContent: function (content) {
            if (!_attached || !_editor) return;
            _isRemoteUpdate = true;
            _editor.setContent(content);
            _isRemoteUpdate = false;

            _pendingContent = content;
            _doSend();
        },

        sendChanges: function () {
            _doSend();
        },

        disconnect: function () {
            if (_connection) _connection.stop();
        },

        reconnect: function () {
            if (_connection && !_connected) _startConnection();
        },

        isConnected: function () {
            return _connected;
        },

        isReady: function () {
            return _attached;
        },

        get _applyingRemote() {
            return _isRemoteUpdate;
        }
    };

})();
