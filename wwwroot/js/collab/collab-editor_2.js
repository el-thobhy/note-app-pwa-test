/**
 * Collaborative Editor v2 — Server-Side Merge Only
 * 
 * Client TIDAK melakukan merge apapun.
 * Client hanya:
 *   1. Kirim content + baseVersion ke server
 *   2. Terima merged result dari server → replace editor
 *
 * Server yang handle semua conflict resolution.
 *
 * Dependencies:
 *   - signalr.min.js (@microsoft/signalr)
 *   - TinyMCE (sudah diinisialisasi)
 *   - diff_match_patch.js TIDAK diperlukan di client
 *
 * API:
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

    var _config = {};
    var _connection = null;
    var _editor = null;
    var _attached = false;
    var _connected = false;

    // Version terakhir yang kita terima dari server
    var _version = 0;

    // Flag: sedang apply content dari server (jangan trigger send)
    var _applying = false;

    // Flag: ada send yang sedang in-flight
    var _inflight = false;

    // Flag: ada perubahan lokal yang belum dikirim
    var _dirty = false;

    // Content terakhir yang kita kirim atau terima dari server
    // Dipakai untuk detect apakah editor benar-benar berubah
    var _lastKnownContent = '';

    // Typing
    var _isTyping = false;
    var _typingTimer = null;

    // Timers
    var _sendDebounce = null;
    var _maxDelayTimer = null;

    // Event handlers
    var _boundHandlers = {};

    // Peers
    var _peers = new Map();

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

    // === PRIVATE ===

    function _buildConnection() {
        if (typeof signalR === 'undefined') {
            console.error('[CollabEditor] signalR not loaded.');
            return false;
        }
        _connection = new signalR.HubConnectionBuilder()
            .withUrl(_config.hubUrl)
            .withAutomaticReconnect([0, 1000, 3000, 5000])
            .build();
        _registerHandlers();
        return true;
    }

    function _registerHandlers() {

        /**
         * ReceiveState: Server kirim merged content + version.
         * Ini diterima saat:
         *   - Join (initial state)
         *   - Setelah kita SendUpdate (ack + merged result)
         *   - Setelah peer SendUpdate (broadcast merged result)
         *
         * Client SELALU replace editor content dengan ini.
         * Tidak ada merge di client.
         */
        _connection.on('ReceiveState', function (content, version) {
            if (!_editor) return;

            // Update version
            _version = version;

            // Kalau content sama dengan yang di editor, skip update (avoid cursor jump)
            var currentContent = _editor.getContent();
            if (content === currentContent) {
                _lastKnownContent = content;
                _inflight = false;
                // Kalau ada pending changes, kirim sekarang
                if (_dirty) {
                    _scheduleSend();
                }
                return;
            }

            // Replace editor content
            _applying = true;
            try {
                // Simpan cursor position
                var bookmark = null;
                try { bookmark = _editor.selection.getBookmark(2, true); } catch (e) { }

                _editor.setContent(content);
                _lastKnownContent = content;

                // Restore cursor
                if (bookmark) {
                    try { _editor.selection.moveToBookmark(bookmark); } catch (e) { }
                }
            } finally {
                _applying = false;
            }

            // Clear inflight flag
            _inflight = false;

            // Kalau ada pending changes yang terjadi saat inflight, kirim sekarang
            if (_dirty) {
                _scheduleSend();
            }

            _fireCallback('onRemoteEdit');
        });

        _connection.on('ReceiveAwareness', function (data) {
            if (data.isTyping) {
                _showPeerTyping(data.connectionId, data.displayName, data.color);
            } else {
                _hidePeerTyping(data.connectionId);
            }
        });

        _connection.on('UsersOnline', function (users) {
            _renderOnlineUsers(users);
            users.forEach(function (u) {
                _peers.set(u.connectionId, { displayName: u.displayName, color: u.color });
            });
            _fireCallback('onUserListChanged', users);
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
            _inflight = false;
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

    function _scheduleSend() {
        clearTimeout(_sendDebounce);
        _sendDebounce = setTimeout(function () {
            _doSend();
        }, _config.debounceMs);
    }

    /**
     * Kirim current editor content ke server.
     * Server akan merge kalau ada conflict, lalu broadcast result ke semua.
     */
    function _doSend() {
        if (!_connected || !_editor) return;

        // In-flight guard: hanya 1 request at a time
        if (_inflight) {
            _dirty = true;
            return;
        }

        var content = _editor.getContent();

        // Skip kalau content tidak berubah dari terakhir kali
        if (content === _lastKnownContent) {
            _dirty = false;
            return;
        }

        _inflight = true;
        _dirty = false;
        _lastKnownContent = content;

        // Clear max delay
        if (_maxDelayTimer) {
            clearTimeout(_maxDelayTimer);
            _maxDelayTimer = null;
        }

        _connection.invoke('SendUpdate', _config.documentId, content, _version)
            .catch(function (err) {
                console.warn('[CollabEditor] SendUpdate failed:', err);
                _inflight = false;
                _dirty = true;
                // Retry
                setTimeout(function () { _scheduleSend(); }, 1000);
            });

        _fireCallback('onLocalEdit');
    }

    function _onContentChange() {
        if (_applying || !_attached || !_editor || !_connected) return;

        var content = _editor.getContent();
        if (content === _lastKnownContent) return;

        _dirty = true;
        _setTyping(true);
        _scheduleSend();

        // Max delay: force send
        if (!_maxDelayTimer) {
            _maxDelayTimer = setTimeout(function () {
                _maxDelayTimer = null;
                if (_dirty && _connected) {
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

    // === UI ===

    function _showPeerTyping(connectionId, displayName, color) {
        var container = document.getElementById('collab-typing-indicators');
        if (!container) return;
        var id = 'typing-' + connectionId.replace(/[^a-z0-9]/gi, '');
        var el = document.getElementById(id);
        if (!el) {
            el = document.createElement('span');
            el.id = id;
            el.style.cssText =
                'background:' + color + '22;border:1px solid ' + color + ';color:' + color +
                ';border-radius:12px;padding:2px 10px;font-size:0.75rem;font-weight:600;' +
                'display:inline-flex;align-items:center;gap:5px;';
            el.innerHTML =
                '<span style="width:7px;height:7px;border-radius:50%;background:' + color +
                ';display:inline-block;animation:collab-pulse 1s infinite;"></span>' +
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
        _attached = false;
        _connected = false;
        _version = 0;
        _applying = false;
        _inflight = false;
        _dirty = false;
        _lastKnownContent = '';
        _isTyping = false;
        _typingTimer = null;
        _sendDebounce = null;
        _maxDelayTimer = null;
        _boundHandlers = {};
        _peers = new Map();
    }

    // === PUBLIC API ===
    return {
        attach: function (editor, options) {
            if (!editor) { console.error('[CollabEditor] Editor required.'); return; }
            if (_attached) this.detach();

            _config = Object.assign({}, _defaults, options);
            _editor = editor;
            if (!_buildConnection()) return;

            _lastKnownContent = _editor.getContent();
            _bindEditorEvents();
            _attached = true;
            _startConnection();

            console.log('[CollabEditor] Attached (ServerMerge) | Doc: ' + _config.documentId);
        },

        detach: function () {
            clearTimeout(_sendDebounce);
            clearTimeout(_maxDelayTimer);
            clearTimeout(_typingTimer);
            _setTyping(false);
            _unbindEditorEvents();
            if (_connection) _connection.stop();
            _resetState();
        },

        getContent: function () {
            return (_attached && _editor) ? _editor.getContent() : '';
        },

        setContent: function (content) {
            if (!_attached || !_editor) return;
            _applying = true;
            _editor.setContent(content);
            _applying = false;
            _lastKnownContent = content;
            if (_connected) {
                _connection.invoke('SendUpdate', _config.documentId, content, _version).catch(function () { });
            }
        },

        sendChanges: function () { _doSend(); },
        disconnect: function () { if (_connection) _connection.stop(); },
        reconnect: function () { if (_connection && !_connected) _startConnection(); },
        isConnected: function () { return _connected; },
        isReady: function () { return _attached; },
        get _applyingRemote() { return _applying; }
    };
})();
