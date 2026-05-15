/**
 * Collaborative Editor v2 - Differential Synchronization
 * 
 * Menggunakan "shadow copy" approach (Neil Fraser's Differential Sync):
 * - Client menyimpan "shadow" = copy terakhir yang server tahu
 * - Saat user edit: diff(shadow, current) → kirim PATCH ke server
 * - Saat terima patch dari peer: apply patch ke shadow DAN ke editor
 * - Shadow selalu sinkron dengan server state
 *
 * Kenapa ini menghindari race condition:
 * - Patch bersifat INCREMENTAL, bukan full-replace
 * - 2 user ketik bersamaan → 2 patch yang BERBEDA dikirim
 * - Server apply patch A, lalu patch B → kedua perubahan preserved
 * - Tidak ada "siapa yang menang" — semua patch di-apply berurutan
 *
 * Dependencies:
 *   - signalr.min.js (@microsoft/signalr)
 *   - diff_match_patch.js
 *   - TinyMCE (sudah diinisialisasi)
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

    // === STATE ===
    var _config = {};
    var _dmp = null;
    var _connection = null;
    var _editor = null;
    var _attached = false;
    var _connected = false;

    // Shadow copy: representasi terakhir yang server tahu
    // Selalu di-update SETELAH patch berhasil dikirim (ack) atau diterima dari peer
    var _shadow = '';

    // Apakah ada patch yang sedang in-flight ke server
    var _inflight = false;
    // Patch text yang sedang in-flight (untuk recovery kalau gagal)
    var _inflightPatch = null;

    // Flag: ada perubahan baru yang belum dikirim
    var _dirty = false;

    // Flags
    var _isRemoteUpdate = false;
    var _isTyping = false;

    // Timers
    var _sendDebounce = null;
    var _maxDelayTimer = null;
    var _typingTimer = null;

    // Bound handlers
    var _boundHandlers = {};

    // Peers
    var _peers = new Map();

    // === DEFAULTS ===
    var _defaults = {
        userName: 'Anonymous',
        avatar: '',
        documentId: 'default',
        hubUrl: '/hubs/collaboration',
        debounceMs: 250,
        maxDelayMs: 1500,
        onUserListChanged: null,
        onConnectionChanged: null,
        onRemoteEdit: null,
        onLocalEdit: null
    };

    // === PRIVATE METHODS ===

    function _initDmp() {
        if (typeof diff_match_patch === 'undefined') {
            console.error('[CollabEditor] diff_match_patch is REQUIRED.');
            return false;
        }
        _dmp = new diff_match_patch();
        _dmp.Patch_Timeout = 2.0;
        // Turunkan threshold supaya patch lebih toleran terhadap pergeseran posisi
        _dmp.Patch_DeleteThreshold = 0.6;
        _dmp.Match_Threshold = 0.6;
        _dmp.Match_Distance = 1500;
        return true;
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

        _registerHandlers();
        return true;
    }

    function _registerHandlers() {

        // === ReceiveDocState: Full state saat join atau resync ===
        _connection.on('ReceiveDocState', function (content, version) {
            if (!_editor) return;

            _isRemoteUpdate = true;
            try {
                // Reset shadow ke server state
                _shadow = content || '';

                // Kalau editor punya perubahan lokal yang belum dikirim,
                // kita perlu preserve-nya
                var currentContent = _editor.getContent();
                if (currentContent !== _shadow && _dirty) {
                    // Ada local edits — jangan overwrite, biarkan dirty flag
                    // Nanti _doSend akan diff dari shadow baru ke current
                    // Ini otomatis "merge" karena patch = diff(shadow_baru, current)
                    // yang hanya berisi perubahan lokal
                } else {
                    _editor.setContent(_shadow);
                    _dirty = false;
                }
            } finally {
                _isRemoteUpdate = false;
            }

            _fireCallback('onRemoteEdit');
        });

        // === ReceivePatch: Patch dari peer ===
        _connection.on('ReceivePatch', function (patchText, version) {
            if (!_editor || !patchText) return;

            _isRemoteUpdate = true;
            try {
                var patches = _dmp.patch_fromText(patchText);

                // 1. Apply patch ke shadow
                var shadowResult = _dmp.patch_apply(patches, _shadow);
                var newShadow = shadowResult[0];
                var shadowSuccess = shadowResult[1];

                // 2. Apply patch ke editor content
                var currentContent = _editor.getContent();
                var editorResult = _dmp.patch_apply(patches, currentContent);
                var newEditorContent = editorResult[0];
                var editorSuccess = editorResult[1];

                // Update shadow (selalu, karena server sudah apply)
                _shadow = newShadow;

                // Update editor kalau patch berhasil dan content berubah
                if (newEditorContent !== currentContent) {
                    var bookmark = null;
                    try { bookmark = _editor.selection.getBookmark(2, true); } catch (e) { }

                    _editor.setContent(newEditorContent);

                    if (bookmark) {
                        try { _editor.selection.moveToBookmark(bookmark); } catch (e) { }
                    }
                }
            } finally {
                _isRemoteUpdate = false;
            }

            _fireCallback('onRemoteEdit');
        });

        // === PatchAck: Server accepted our patch ===
        _connection.on('PatchAck', function (version) {
            _inflight = false;
            _inflightPatch = null;

            // Kalau ada perubahan baru yang terjadi saat in-flight, kirim sekarang
            if (_dirty) {
                _doSend();
            }
        });

        // === FullResync: Server gagal apply patch kita, kirim full state ===
        _connection.on('FullResync', function (content, version) {
            _isRemoteUpdate = true;
            try {
                _inflight = false;
                _inflightPatch = null;

                // Reset shadow ke server state
                _shadow = content || '';

                var currentContent = _editor.getContent();
                if (currentContent !== _shadow) {
                    // Ada local edits — set dirty supaya dikirim ulang
                    // Patch berikutnya = diff(shadow_baru, current) = hanya local changes
                    _dirty = true;
                    _scheduleSend();
                } else {
                    _editor.setContent(_shadow);
                    _dirty = false;
                }
            } finally {
                _isRemoteUpdate = false;
            }
        });

        // === Awareness ===
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
            _inflightPatch = null;
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
     * Core sync: diff shadow vs current editor → kirim patch ke server.
     * 
     * Ini adalah inti dari Differential Sync:
     * - shadow = apa yang server terakhir tahu
     * - current = apa yang user lihat sekarang
     * - diff(shadow, current) = perubahan yang HANYA user ini buat
     * - Kirim patch ini ke server
     * - Update shadow = current (karena setelah ack, server tahu state ini)
     */
    function _doSend() {
        if (!_connected || !_editor) return;

        // In-flight guard: tunggu ack sebelum kirim lagi
        if (_inflight) {
            _dirty = true; // tandai supaya dikirim setelah ack
            return;
        }

        var currentContent = _editor.getContent();

        // Kalau tidak ada perubahan dari shadow, skip
        if (currentContent === _shadow) {
            _dirty = false;
            return;
        }

        // Buat diff: shadow → current
        var diffs = _dmp.diff_main(_shadow, currentContent);
        if (diffs.length > 2) {
            _dmp.diff_cleanupEfficiency(diffs);
        }
        var patches = _dmp.patch_make(_shadow, diffs);
        var patchText = _dmp.patch_toText(patches);

        if (!patchText || patches.length === 0) {
            _dirty = false;
            return;
        }

        // Update shadow SEKARANG (optimistic) — karena kita expect server akan accept
        // Kalau server reject (FullResync), shadow akan di-reset
        _shadow = currentContent;
        _dirty = false;
        _inflight = true;
        _inflightPatch = patchText;

        // Clear max delay timer
        if (_maxDelayTimer) {
            clearTimeout(_maxDelayTimer);
            _maxDelayTimer = null;
        }

        _connection.invoke('SendPatch', _config.documentId, patchText)
            .catch(function (err) {
                console.warn('[CollabEditor] SendPatch failed:', err);
                // Rollback shadow — kita tidak tahu apakah server apply atau tidak
                // Safest: request full resync
                _inflight = false;
                _inflightPatch = null;
                _dirty = true;
                // Shadow tetap di posisi lama? Tidak, karena kita sudah update.
                // Kirim full content sebagai fallback
                _connection.invoke('SendFullContent', _config.documentId, currentContent)
                    .then(function () {
                        _shadow = currentContent;
                        _dirty = false;
                    })
                    .catch(function () { });
            });

        _fireCallback('onLocalEdit');
    }

    function _onContentChange() {
        if (_isRemoteUpdate || !_attached || !_editor || !_connected) return;

        _dirty = true;
        _setTyping(true);

        // Schedule send (debounced)
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
        _shadow = '';
        _inflight = false;
        _inflightPatch = null;
        _dirty = false;
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

            if (_attached) this.detach();

            _config = Object.assign({}, _defaults, options);
            _editor = editor;

            if (!_initDmp()) return;
            if (!_buildConnection()) return;

            _shadow = _editor.getContent();
            _bindEditorEvents();
            _attached = true;
            _startConnection();

            console.log('[CollabEditor] Attached (DiffSync) | Doc: ' + _config.documentId + ' | User: ' + _config.userName);
        },

        detach: function () {
            clearTimeout(_sendDebounce);
            clearTimeout(_maxDelayTimer);
            clearTimeout(_typingTimer);
            _setTyping(false);
            _unbindEditorEvents();
            if (_connection) _connection.stop();
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
            // Kirim full content ke server
            if (_connected) {
                _connection.invoke('SendFullContent', _config.documentId, content)
                    .then(function () { _shadow = content; })
                    .catch(function () { });
            }
        },

        sendChanges: function () { _doSend(); },
        disconnect: function () { if (_connection) _connection.stop(); },
        reconnect: function () { if (_connection && !_connected) _startConnection(); },
        isConnected: function () { return _connected; },
        isReady: function () { return _attached; },

        get _applyingRemote() { return _isRemoteUpdate; }
    };

})();
