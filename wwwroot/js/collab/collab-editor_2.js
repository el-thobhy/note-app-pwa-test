/**
 * Collaborative Editor — Operational Transformation (OT)
 *
 * Protocol (mirip Google Docs):
 *   Client → Server : SubmitOp(docId, patch, clientRevision)
 *   Server → Client : AckOp(newRevision)          ← konfirmasi op kita diterima
 *   Server → Others : ApplyOp(patch, newRevision) ← op dari peer, apply ke editor
 *   Server → Joiner : InitDoc(content, revision)  ← initial state saat join
 *
 * Client state machine:
 *   IDLE      → tidak ada op in-flight, tidak ada pending
 *   INFLIGHT  → ada 1 op yang sudah dikirim, menunggu AckOp
 *   BUFFERED  → ada op in-flight + ada perubahan lokal yang belum dikirim
 *
 * Kenapa state machine ini penting (OT correctness):
 *   Saat ada op in-flight, perubahan lokal baru TIDAK boleh langsung dikirim.
 *   Mereka harus di-buffer dulu. Setelah AckOp diterima, buffer di-compose
 *   dan baru dikirim sebagai op berikutnya.
 *   Ini memastikan setiap op yang dikirim ke server selalu berbasis revision
 *   yang sudah confirmed — tidak ada "revision gap".
 *
 * Dependencies:
 *   - signalr.min.js
 *   - diff-match-patch.js (diff_match_patch global)
 *   - TinyMCE
 *
 * API:
 *   CollabEditor.attach(editor, options)
 *   CollabEditor.detach()
 *   CollabEditor.isReady()
 *   CollabEditor.isConnected()
 *   CollabEditor.sendChanges()
 */

var CollabEditor = (function () {
    'use strict';

    // ── Config & connection ──────────────────────────────────────────
    var _config = {};
    var _connection = null;
    var _editor = null;
    var _attached = false;
    var _connected = false;

    // ── OT state ─────────────────────────────────────────────────────
    // Revision terakhir yang confirmed oleh server
    var _revision = 0;

    // Content yang kita tahu server punya (setelah semua ack)
    // Dipakai sebagai base untuk membuat patch
    var _serverContent = '';

    // State machine: 'idle' | 'inflight' | 'buffered'
    var _state = 'idle';

    // Op yang sedang in-flight (sudah dikirim, belum di-ack)
    // { patch: string, baseRevision: number, baseContent: string }
    var _inflightOp = null;

    // Buffer: perubahan lokal yang terjadi saat ada op in-flight
    // Akan di-compose dan dikirim setelah AckOp
    var _buffer = null; // content string (latest local state)

    // ── Editor state ─────────────────────────────────────────────────
    // Flag: sedang apply remote op (jangan trigger send)
    var _applying = false;

    // Content terakhir yang diketahui (untuk detect perubahan)
    var _localContent = '';

    // ── Timers & awareness ───────────────────────────────────────────
    var _sendDebounce = null;
    var _maxDelayTimer = null;
    var _typingTimer = null;
    var _isTyping = false;
    var _boundHandlers = {};
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

    // ── Helpers ──────────────────────────────────────────────────────

    function _dmp() {
        var d = new diff_match_patch();
        d.Match_Threshold = 0.5;
        d.Match_Distance = 5000;
        return d;
    }

    /** Buat patch text dari oldText → newText */
    function _makePatch(oldText, newText) {
        var d = _dmp();
        var diffs = d.diff_main(oldText, newText);
        d.diff_cleanupEfficiency(diffs);
        var patches = d.patch_make(oldText, diffs);
        return d.patch_toText(patches);
    }

    /** Apply patch text ke content, return hasil */
    function _applyPatch(patchText, content) {
        if (!patchText) return content;
        var d = _dmp();
        try {
            var patches = d.patch_fromText(patchText);
            var result = d.patch_apply(patches, content);
            return result[0];
        } catch (e) {
            console.warn('[CollabEditor] patch_apply failed:', e);
            return content;
        }
    }

    // ── SignalR handlers ─────────────────────────────────────────────

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
         * InitDoc — diterima saat join.
         * Set editor ke initial content dan catat revision sebagai baseline.
         */
        _connection.on('InitDoc', function (content, revision) {
            if (!_editor) return;
            _revision = revision;
            _serverContent = content;
            _localContent = content;
            _state = 'idle';
            _inflightOp = null;
            _buffer = null;

            _applying = true;
            try {
                _editor.setContent(content);
            } finally {
                _applying = false;
            }
        });

        /**
         * AckOp — server konfirmasi op kita diterima dan di-commit.
         * newRevision = revision setelah op kita.
         *
         * OT state machine:
         *   - Update _revision dan _serverContent
         *   - Kalau ada buffer (state = 'buffered'), kirim buffer sebagai op baru
         *   - Kalau tidak ada buffer, kembali ke idle
         */
        _connection.on('AckOp', function (newRevision) {
            if (!_inflightOp) return;

            // Server sudah apply op kita — update server content
            _serverContent = _applyPatch(_inflightOp.patch, _inflightOp.baseContent);
            _revision = newRevision;
            _inflightOp = null;

            if (_state === 'buffered' && _buffer !== null) {
                // Ada perubahan lokal yang terjadi saat in-flight
                // Kirim sekarang sebagai op baru
                _state = 'idle';
                var bufferedContent = _buffer;
                _buffer = null;
                _sendOp(bufferedContent);
            } else {
                _state = 'idle';
            }
        });

        /**
         * ApplyOp — op dari peer yang sudah di-transform oleh server.
         * Apply patch ke editor content.
         *
         * Karena server sudah transform, kita tinggal apply langsung.
         * Tapi kita perlu hati-hati: kalau ada local changes yang belum dikirim,
         * kita apply patch ke _serverContent dulu, lalu re-apply local changes.
         */
        _connection.on('ApplyOp', function (patch, newRevision) {
            if (!_editor) return;

            _revision = newRevision;

            // Apply patch ke server content untuk update baseline
            var newServerContent = _applyPatch(patch, _serverContent);
            _serverContent = newServerContent;

            // Kalau ada local changes yang belum dikirim (buffer atau dirty),
            // kita perlu preserve mereka di atas server content yang baru
            var currentLocal = _editor.getContent();
            var hasLocalChanges = currentLocal !== _localContent || _buffer !== null;

            _applying = true;
            try {
                var bookmark = null;
                try { bookmark = _editor.selection.getBookmark(2, true); } catch (e) {}

                if (hasLocalChanges && _state !== 'idle') {
                    // Ada local changes — apply patch ke current editor content
                    // (server sudah transform patch ini, jadi posisinya sudah adjusted)
                    var merged = _applyPatch(patch, currentLocal);
                    _editor.setContent(merged);
                    _localContent = merged;
                    // Update buffer juga kalau ada
                    if (_buffer !== null) {
                        _buffer = _applyPatch(patch, _buffer);
                    }
                } else {
                    // Tidak ada local changes — apply langsung
                    _editor.setContent(newServerContent);
                    _localContent = newServerContent;
                }

                if (bookmark) {
                    try { _editor.selection.moveToBookmark(bookmark); } catch (e) {}
                }
            } finally {
                _applying = false;
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
            _state = 'idle';
            _inflightOp = null;
            _buffer = null;
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

    // ── OT send logic ────────────────────────────────────────────────

    /**
     * Kirim op ke server.
     * newContent = current editor content yang ingin kita commit.
     *
     * State machine:
     *   idle     → buat patch dari _serverContent → newContent, kirim, state = inflight
     *   inflight → simpan ke buffer, state = buffered
     *   buffered → update buffer (compose: ambil yang terbaru)
     */
    function _sendOp(newContent) {
        if (!_connected || !_editor) return;
        if (newContent === _serverContent) return; // tidak ada perubahan

        if (_state === 'inflight' || _state === 'buffered') {
            // Ada op in-flight — buffer perubahan ini
            _buffer = newContent;
            _state = 'buffered';
            return;
        }

        // state === 'idle' — buat dan kirim op
        var patch = _makePatch(_serverContent, newContent);
        if (!patch) return;

        _inflightOp = {
            patch: patch,
            baseRevision: _revision,
            baseContent: _serverContent
        };
        _state = 'inflight';
        _localContent = newContent;

        _connection.invoke('SubmitOp', _config.documentId, patch, _revision)
            .catch(function (err) {
                console.warn('[CollabEditor] SubmitOp failed:', err);
                // Rollback state supaya bisa retry
                _state = 'idle';
                _inflightOp = null;
                // Retry setelah delay
                setTimeout(function () { _scheduleSend(); }, 1000);
            });

        _fireCallback('onLocalEdit');
    }

    function _scheduleSend() {
        clearTimeout(_sendDebounce);
        _sendDebounce = setTimeout(function () {
            if (!_editor) return;
            var content = _editor.getContent();
            if (content !== _localContent) {
                _sendOp(content);
            }
        }, _config.debounceMs);
    }

    // ── Editor event binding ─────────────────────────────────────────

    function _onContentChange() {
        if (_applying || !_attached || !_editor || !_connected) return;

        var content = _editor.getContent();
        if (content === _localContent) return;

        _setTyping(true);
        _scheduleSend();

        // Max delay: force send supaya tidak terlalu lama nunggu debounce
        if (!_maxDelayTimer) {
            _maxDelayTimer = setTimeout(function () {
                _maxDelayTimer = null;
                if (_connected && _editor) {
                    clearTimeout(_sendDebounce);
                    var c = _editor.getContent();
                    if (c !== _localContent) _sendOp(c);
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
            }).catch(function () {});
        }
    }

    function _bindEditorEvents() {
        _boundHandlers.onChange = function () { _onContentChange(); };
        _editor.on('Change', _boundHandlers.onChange);
        _editor.on('KeyUp', _boundHandlers.onChange);
        _editor.on('Paste', _boundHandlers.onChange);
        _editor.on('Undo', _boundHandlers.onChange);
        _editor.on('Redo', _boundHandlers.onChange);
    }

    function _unbindEditorEvents() {
        if (_editor && _boundHandlers.onChange) {
            _editor.off('Change', _boundHandlers.onChange);
            _editor.off('KeyUp', _boundHandlers.onChange);
            _editor.off('Paste', _boundHandlers.onChange);
            _editor.off('Undo', _boundHandlers.onChange);
            _editor.off('Redo', _boundHandlers.onChange);
        }
        _boundHandlers = {};
    }

    // ── UI helpers ───────────────────────────────────────────────────

    function _fireConnectionChanged(status) {
        _showStatus(status);
        if (typeof _config.onConnectionChanged === 'function')
            _config.onConnectionChanged(status);
    }

    function _fireCallback(name, data) {
        if (typeof _config[name] === 'function') _config[name](data);
    }

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
        var el = document.getElementById('typing-' + connectionId.replace(/[^a-z0-9]/gi, ''));
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
            connected:    { text: '● Online',         cls: 'text-success' },
            disconnected: { text: '● Offline',         cls: 'text-danger' },
            reconnecting: { text: '● Reconnecting...', cls: 'text-warning' },
            error:        { text: '● Error',           cls: 'text-danger' }
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
        _revision = 0;
        _serverContent = '';
        _state = 'idle';
        _inflightOp = null;
        _buffer = null;
        _applying = false;
        _localContent = '';
        _isTyping = false;
        clearTimeout(_sendDebounce);
        clearTimeout(_maxDelayTimer);
        clearTimeout(_typingTimer);
        _sendDebounce = null;
        _maxDelayTimer = null;
        _typingTimer = null;
        _boundHandlers = {};
        _peers = new Map();
    }

    // ── Public API ───────────────────────────────────────────────────
    return {
        attach: function (editor, options) {
            if (!editor) { console.error('[CollabEditor] Editor required.'); return; }
            if (_attached) this.detach();

            _config = Object.assign({}, _defaults, options);
            _editor = editor;
            if (!_buildConnection()) return;

            _localContent = _editor.getContent();
            _bindEditorEvents();
            _attached = true;
            _startConnection();
        },

        detach: function () {
            _setTyping(false);
            _unbindEditorEvents();
            if (_connection) _connection.stop();
            _resetState();
        },

        sendChanges: function () {
            if (_editor) _sendOp(_editor.getContent());
        },

        isConnected: function () { return _connected; },
        isReady:     function () { return _attached; }
    };
})();
