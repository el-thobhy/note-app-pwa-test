/**
 * Collaborative Editor v2 - SignalR (@microsoft/signalr) + diff-match-patch
 * 
 * Library reusable untuk menambahkan real-time collaboration ke TinyMCE editor
 * yang SUDAH diinisialisasi dengan config sendiri.
 *
 * Dependencies:
 *   - signalr.min.js (@microsoft/signalr)
 *   - diff_match_patch.js
 *   - TinyMCE (sudah diinisialisasi)
 *
 * ============================================================
 * CARA PAKAI:
 * ============================================================
 * 
 * 1. Inisialisasi TinyMCE seperti biasa dengan config kamu sendiri.
 * 2. Di dalam setup > editor.on('init'), panggil CollabEditor.attach()
 *
 * Contoh:
 *
 *   tinymce.init({
 *       selector: '.textarea-editor',
 *       plugins: '...',
 *       toolbar: '...',
 *       setup: function(editor) {
 *           editor.on('init', function() {
 *               CollabEditor.attach(editor, {
 *                   userName: 'Budi',
 *                   avatar: '/img/budi.png',
 *                   documentId: 'entry-123',
 *                   hubUrl: '/hubs/collaboration',
 *                   debounceMs: 300,
 *                   maxDelayMs: 2000,
 *                   onUserListChanged: function(users) { },
 *                   onConnectionChanged: function(status) { },
 *                   onRemoteEdit: function() { },
 *                   onLocalEdit: function() { }
 *               });
 *           });
 *       }
 *   });
 *
 * ============================================================
 * PUBLIC API:
 * ============================================================
 * 
 *   CollabEditor.attach(editor, options)  - Attach collaboration ke editor
 *   CollabEditor.detach()                 - Lepas collaboration & disconnect
 *   CollabEditor.getContent()             - Ambil konten editor
 *   CollabEditor.setContent(html)         - Set konten editor (broadcast ke peers)
 *   CollabEditor.disconnect()             - Putus koneksi SignalR
 *   CollabEditor.reconnect()              - Sambung ulang SignalR
 *   CollabEditor.isConnected()            - Cek status koneksi
 *   CollabEditor.isReady()                - Cek apakah sudah attached & ready
 *   CollabEditor.sendChanges()            - Force kirim perubahan sekarang
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

    // Server-authoritative state
    var _serverContent = '';
    var _serverVersion = 0;
    var _pendingContent = null;
    var _mergeBase = null;
    var _lastSentContent = undefined;

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
        debounceMs: 300,
        maxDelayMs: 2000,
        onUserListChanged: null,
        onConnectionChanged: null,
        onRemoteEdit: null,
        onLocalEdit: null
    };

    // === PRIVATE METHODS ===

    function _initDiffMatchPatch() {
        if (typeof diff_match_patch === 'undefined') {
            console.warn('[CollabEditor] diff_match_patch not loaded, merge will fallback to server content.');
            return true; // non-fatal, will fallback
        }
        _dmp = new diff_match_patch();
        _dmp.Patch_Timeout = 1;
        return true;
    }

    function _merge(server, local) {
        if (local === server) return local;
        if (!_dmp) return local;

        var base = _mergeBase || _serverContent;

        try {
            var patches = _dmp.patch_make(base, local);
            var result = _dmp.patch_apply(patches, server);
            var merged = result[0];
            var results = result[1];

            var failCount = results.filter(function (r) { return !r; }).length;
            if (failCount > 0) {
                console.debug('[CollabEditor] ' + failCount + '/' + results.length + ' patches failed, server wins for conflicts');
            }

            return merged;
        } catch (e) {
            console.warn('[CollabEditor] Merge error, using local:', e);
            return local;
        }
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
        // State awal saat join
        _connection.on('ReceiveDocState', function (content, version) {
            if (!content || !_editor) return;

            _isRemoteUpdate = true;
            try {
                if (_pendingContent !== null && _dmp) {
                    // Reconnect case — merge pending ke atas state server
                    var base = _mergeBase || _serverContent;
                    var merged = _merge(content, _pendingContent);
                    _editor.setContent(merged);
                    _serverContent = content;
                    _serverVersion = version || 0;
                    _pendingContent = merged;
                    _mergeBase = base;
                    _scheduleSend();
                } else {
                    _editor.setContent(content);
                    _serverContent = content;
                    _serverVersion = version || 0;
                    _pendingContent = null;
                    _mergeBase = null;
                }
            } finally {
                _isRemoteUpdate = false;
            }

            if (typeof _config.onRemoteEdit === 'function') {
                _config.onRemoteEdit();
            }
        });

        // Update dari peer atau resync dari server
        _connection.on('ReceiveUpdate', function (serverContent, serverVersion) {
            if (!serverContent || !_editor) return;

            // Ignore stale
            if (serverVersion !== undefined && serverVersion <= _serverVersion) return;

            _serverContent = serverContent;
            _serverVersion = serverVersion || (_serverVersion + 1);

            _isRemoteUpdate = true;
            try {
                if (_pendingContent !== null) {
                    // Ada pending — tampilkan preview merge
                    var preview = _merge(_serverContent, _pendingContent);
                    if (_editor.getContent() !== preview) {
                        var bookmark = _editor.selection.getBookmark(2, true);
                        _editor.setContent(preview);
                        try { _editor.selection.moveToBookmark(bookmark); } catch (e) { }
                    }
                    _scheduleSend();
                } else {
                    // Tidak ada pending — apply langsung
                    if (_editor.getContent() !== serverContent) {
                        var bookmark = _editor.selection.getBookmark(2, true);
                        _editor.setContent(serverContent);
                        try { _editor.selection.moveToBookmark(bookmark); } catch (e) { }
                    }
                }
            } finally {
                _isRemoteUpdate = false;
            }

            if (typeof _config.onRemoteEdit === 'function') {
                _config.onRemoteEdit();
            }
        });

        // Server konfirmasi update diterima
        _connection.on('UpdateAck', function (newVersion) {
            if (_lastSentContent !== undefined) {
                _serverContent = _lastSentContent;
            }
            _serverVersion = newVersion;

            if (_pendingContent === null || _pendingContent === _lastSentContent) {
                _pendingContent = null;
                _mergeBase = null;
            } else {
                // Ada ketikan baru sejak terakhir kirim
                _mergeBase = _serverContent;
                _scheduleSend();
            }
        });

        // Awareness (typing indicators)
        _connection.on('ReceiveAwareness', function (data) {
            if (data.isTyping) {
                _showPeerTyping(data.connectionId, data.displayName, data.color);
            } else {
                _hidePeerTyping(data.connectionId);
            }
        });

        // Online users
        _connection.on('UsersOnline', function (users) {
            _renderOnlineUsers(users);
            users.forEach(function (u) {
                if (!_peers.has(u.connectionId)) {
                    _peers.set(u.connectionId, { displayName: u.displayName, color: u.color });
                }
            });

            if (typeof _config.onUserListChanged === 'function') {
                _config.onUserListChanged(users);
            }
        });
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
            _serverVersion = 0;
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

    function _scheduleSend() {
        clearTimeout(_sendDebounce);
        _sendDebounce = setTimeout(function () {
            _doSend();
        }, _config.debounceMs);
    }

    function _doSend() {
        if (!_connected || _pendingContent === null) return;

        var toSend = _merge(_serverContent, _pendingContent);
        _lastSentContent = toSend;

        // Clear max delay timer
        if (_maxDelayTimer) {
            clearTimeout(_maxDelayTimer);
            _maxDelayTimer = null;
        }

        var versionSnapshot = _serverVersion;

        _connection.invoke('SendHtmlUpdate', _config.documentId, toSend, versionSnapshot)
            .catch(function (err) {
                console.warn('[CollabEditor] SendHtmlUpdate failed:', err);
            });

        if (typeof _config.onLocalEdit === 'function') {
            _config.onLocalEdit();
        }
    }

    function _onContentChange() {
        if (_isRemoteUpdate || !_attached || !_editor || !_connected) return;

        var htmlContent = _editor.getContent();

        _setTyping(true);

        // Set merge base saat user mulai ketik
        if (_pendingContent === null) {
            _mergeBase = _serverContent;
        }

        _pendingContent = htmlContent;
        _scheduleSend();

        // Max delay: force send setelah N ms walaupun user masih ngetik
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
        _serverContent = '';
        _serverVersion = 0;
        _pendingContent = null;
        _mergeBase = null;
        _lastSentContent = undefined;
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
        /**
         * Attach collaboration ke TinyMCE editor yang sudah diinisialisasi.
         * Panggil ini di dalam editor.on('init', ...) callback.
         *
         * @param {Object} editor - Instance TinyMCE editor
         * @param {Object} options - Konfigurasi collaboration
         * @param {string} options.userName - Nama user
         * @param {string} [options.avatar] - URL avatar user
         * @param {string} options.documentId - ID dokumen/entry untuk collaboration
         * @param {string} [options.hubUrl='/hubs/collaboration'] - URL SignalR hub
         * @param {number} [options.debounceMs=300] - Debounce delay (ms)
         * @param {number} [options.maxDelayMs=2000] - Max delay sebelum force send (ms)
         * @param {function} [options.onUserListChanged] - Callback saat user list berubah
         * @param {function} [options.onConnectionChanged] - Callback saat koneksi berubah
         * @param {function} [options.onRemoteEdit] - Callback saat ada edit dari user lain
         * @param {function} [options.onLocalEdit] - Callback saat user lokal mengedit
         */
        attach: function (editor, options) {
            if (!editor) {
                console.error('[CollabEditor] Editor instance is required.');
                return;
            }

            // Detach dulu kalau sudah attached sebelumnya
            if (_attached) {
                this.detach();
            }

            _config = Object.assign({}, _defaults, options);
            _editor = editor;

            _initDiffMatchPatch();

            if (!_buildConnection()) return;

            // Simpan konten awal
            _serverContent = _editor.getContent();

            // Bind event listeners ke editor
            _bindEditorEvents();

            _attached = true;

            // Mulai koneksi SignalR
            _startConnection();

            console.log('[CollabEditor] Attached to editor "' + _editor.id + '" | Document: ' + _config.documentId + ' | User: ' + _config.userName);
        },

        /**
         * Lepas collaboration dari editor & disconnect SignalR
         */
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

        /**
         * Mendapatkan konten editor saat ini
         * @returns {string}
         */
        getContent: function () {
            if (!_attached || !_editor) return '';
            return _editor.getContent();
        },

        /**
         * Set konten editor dan broadcast ke peers
         * @param {string} content - HTML content
         */
        setContent: function (content) {
            if (!_attached || !_editor) return;
            _isRemoteUpdate = true;
            _editor.setContent(content);
            _isRemoteUpdate = false;

            // Kirim sebagai update ke server
            _pendingContent = content;
            _mergeBase = _serverContent;
            _doSend();
        },

        /**
         * Force kirim perubahan sekarang (tanpa debounce)
         */
        sendChanges: function () {
            _doSend();
        },

        /**
         * Disconnect dari SignalR
         */
        disconnect: function () {
            if (_connection) {
                _connection.stop();
            }
        },

        /**
         * Reconnect ke SignalR
         */
        reconnect: function () {
            if (_connection && !_connected) {
                _startConnection();
            }
        },

        /**
         * Cek status koneksi
         * @returns {boolean}
         */
        isConnected: function () {
            return _connected;
        },

        /**
         * Cek apakah sudah attached & ready
         * @returns {boolean}
         */
        isReady: function () {
            return _attached;
        },

        /**
         * Property flag untuk cek apakah sedang apply remote update.
         * Berguna untuk mencegah loop di event handler TinyMCE.
         */
        get _applyingRemote() {
            return _isRemoteUpdate;
        }
    };

})();
