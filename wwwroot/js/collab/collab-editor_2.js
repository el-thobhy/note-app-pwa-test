/**
 * COLLABORATION CLIENT WITH YJS + OT ENGINE
 * File: collab-editor_2.js
 * 
 * Modernized version that uses Yjs + OTEngine client-side and ASP.NET Core SignalR.
 * Aligned with collaboration-teletype.js featuring Chat Integration & Pending Offline Queue.
 */

class CollaborationClient {
    constructor(entryId, displayName, avatar, config = {}) {
        this.entryId = entryId;
        this.displayName = displayName;
        this.avatar = avatar;
        this.siteId = 'site_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
        this.editor = null;

        this.isConnected = false;
        this.isUpdatingFromRemote = false;
        this.isApplyingToEditor = false;
        this.baseContent = ''; // Base asli yang terkonfirmasi oleh server
        this.lastContent = ''; // Editor content terakhir untuk hitung diff
        this.updateTimer = null;
        this.UPDATE_DELAY = 100;

        this.activeUsers = new Map();
        this.ydoc = null;
        this.yText = null;

        this.otEngine = new OTEngine();
        this.useOT = true;
        this.remoteOpQueue = [];
        this.isProcessingRemoteQueue = false;

        // Pending queue for offline mode
        this.pendingQueue = [];

        // Chat Integration
        this.chat = null;
        this.chatEnabled = config.enableChat !== false;
    }

    async init(editorInstance) {
        this.editor = editorInstance;

        if (typeof Y === 'undefined') {
            console.error('❌ Yjs library not loaded! Please check Views/Collaboration/Room.cshtml for import map.');
            return;
        }

        console.log('🚀 Initializing Yjs + OTEngine Collaboration for:', this.entryId);

        this.ydoc = new Y.Doc();
        this.yText = this.ydoc.getText('tinymce');

        this.connection = new signalR.HubConnectionBuilder()
            .withUrl('/hubs/collaboration')
            .withAutomaticReconnect([0, 1000, 3000, 5000])
            .build();

        this._registerHandlers();

        try {
            await this.connection.start();
            this.isConnected = true;
            this._showStatus('connected');

            // Join the document group
            await this.connection.invoke('JoinDocument', this.entryId, this.siteId, this.displayName);

            if (this.editor && this.editor.initialized) {
                this.lastContent = this.editor.getContent();
                this.baseContent = this.editor.getContent();
            }

            // Sync initial content
            const existingContent = this.editor.getContent();
            if (existingContent && existingContent !== '<p></p>') {
                this.ydoc.transact(() => {
                    if (this.yText.length > 0) {
                        this.yText.delete(0, this.yText.length);
                    }
                    this.yText.insert(0, existingContent);
                });
                this.lastContent = existingContent;
                this.baseContent = existingContent;
            }

            this.setupYjsListeners();
            this.setupEditorListeners();

            // Initialize chat if enabled
            this.initChat();
        } catch (err) {
            console.error('[Collab] Connection failed:', err);
            this._showStatus('error');
        }

        this.connection.onreconnected(async () => {
            this.isConnected = true;
            await this.connection.invoke('JoinDocument', this.entryId, this.siteId, this.displayName);
            this._showStatus('connected');
            setTimeout(() => this.flushPendingQueue(), 500);
        });

        this.connection.onreconnecting(() => {
            this.isConnected = false;
            this._showStatus('reconnecting');
        });

        this.connection.onclose(() => {
            this.isConnected = false;
            this._showStatus('disconnected');
        });
    }

    _registerHandlers() {
        this.connection.on('receiveOperationOT', (operationsJson, senderSiteId, senderDocumentId) => {
            console.log('📡 [Collab] Received receiveOperationOT:', senderDocumentId, 'from:', senderSiteId);
            if (senderDocumentId === this.entryId && senderSiteId !== this.siteId) {
                this.handleRemoteOTOperation(operationsJson);
            } else {
                console.log('⏭️ [Collab] receiveOperationOT ignored (same site or diff entry)');
            }
        });

        this.connection.on('receiveOperation', (operationsJson, senderSiteId, senderDocumentId) => {
            console.log('📡 [Collab] Received receiveOperation:', senderDocumentId, 'from:', senderSiteId);
            if (senderDocumentId === this.entryId && senderSiteId !== this.siteId) {
                this.handleRemoteOperation(operationsJson);
            }
        });

        // Handler untuk ReceiveUpdate (Full HTML update) demi kecocokan dengan Chaos Test
        this.connection.on('ReceiveUpdate', (serverContent, serverVersion) => {
            console.log('📡 [Collab] Received ReceiveUpdate (Full HTML):', serverVersion);
            if (!this.editor) return;

            const baseContent = this.baseContent; // Gunakan baseContent asli sebagai pembanding merge
            const localContent = this.editor.getContent();
            const remoteContent = serverContent;

            console.log('📊 --- ReceiveUpdate 3-WAY MERGE DEBUG ---');
            console.log('BASE:', baseContent);
            console.log('LOCAL:', localContent);
            console.log('REMOTE:', remoteContent);

            const mergedContent = this.otEngine.smartThreeWayMerge(baseContent, localContent, remoteContent);
            console.log('RESULT:', mergedContent);

            try {
                this.isUpdatingFromRemote = true;
                this.isApplyingToEditor = true;

                this.ydoc.transact(() => {
                    if (this.yText.length > 0) {
                        this.yText.delete(0, this.yText.length);
                    }
                    this.yText.insert(0, mergedContent);
                }, 'remote');

                this.baseContent = serverContent; // Perbarui base content resmi
                this.lastContent = mergedContent; // Perbarui lastContent resmi agar event change tidak salah mendeteksi ketikan lokal
                this._safeSetContent(mergedContent);
            } finally {
                this.isUpdatingFromRemote = false;
                this.isApplyingToEditor = false;
            }
        });

        this.connection.on('existingUsers', (users) => {
            console.log('📋 [Collab] Existing users:', users);
            users.forEach((user) => {
                if (!this.activeUsers.has(user.siteId)) {
                    this.activeUsers.set(user.siteId, {
                        id: user.siteId,
                        name: user.userName,
                        color: this.getRandomColor(user.siteId),
                        joinedAt: user.joinedAt
                    });
                }
            });
            this.updateEditorAvatars();
        });

        this.connection.on('userJoined', (data) => {
            console.log('👤 [Collab] User joined:', data);
            this.showNotification(`${data.userName} joined the document (${data.userCount} online)`, 'info');
            if (!this.activeUsers.has(data.siteId)) {
                this.activeUsers.set(data.siteId, {
                    id: data.siteId,
                    name: data.userName,
                    color: this.getRandomColor(data.siteId),
                    joinedAt: data.timestamp
                });
                this.updateEditorAvatars();
            }
        });

        this.connection.on('userLeft', (data) => {
            console.log('👋 [Collab] User left:', data);
            this.showNotification(`${data.userName} left the document (${data.userCount} online)`, 'info');
            this.activeUsers.delete(data.siteId);
            this.updateEditorAvatars();
        });

        this.connection.on('userCount', (count) => {
            console.log('📊 [Collab] Active user count:', count);
            $(document).trigger('collaboration.userCount', count);
            this.updateOnlineCount(count);
        });
    }

    showNotification(message, type) {
        console.log(`[${type}] ${message}`);
        if (window.showToast) {
            window.showToast(message, type);
        }
    }

    setupYjsListeners() {
        if (!this.ydoc) return;

        this.yText.observe(() => {
            if (this.isApplyingToEditor) return;
            if (this.isUpdatingFromRemote) return;

            if (this.editor && !this.editor.removed) {
                const newContent = this.yText.toString();
                const currentContent = this.editor.getContent();

                if (newContent !== currentContent) {
                    this.isApplyingToEditor = true;
                    try {
                        this._safeSetContent(newContent);
                    } catch (err) {
                        console.error('❌ Error setting editor content:', err);
                    }
                    this.isApplyingToEditor = false;
                }
            }
        });
    }

    setupEditorListeners() {
        if (!this.editor) return;

        const bindEvents = () => {
            console.log('📝 Binding editor events for:', this.entryId);
            this.editor.on('keyup change undo redo', () => {
                if (this.isUpdatingFromRemote) return;
                if (this.isApplyingToEditor) return;

                if (this.updateTimer) clearTimeout(this.updateTimer);
                this.updateTimer = setTimeout(() => {
                    if (this.useOT) {
                        this.sendLocalChangesWithOT();
                    } else {
                        this.sendLocalChangesToYjs();
                    }
                }, this.UPDATE_DELAY);
            });
        };

        if (this.editor.initialized) {
            bindEvents();
        } else {
            this.editor.on('init', bindEvents);
        }
    }

    async flushPendingLocalChanges() {
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }
        if (this.editor && !this.editor.removed && this.ydoc && this.yText && !this.isUpdatingFromRemote && !this.isApplyingToEditor) {
            const currentContent = this.editor.getContent();
            if (currentContent !== this.lastContent) {
                console.log('⚡ Flushing pending local changes before applying remote...');
                if (this.useOT) {
                    await this.sendLocalChangesWithOT();
                } else {
                    this.sendLocalChangesToYjs();
                }
            }
        }
    }

    async sendLocalChangesWithOT() {
        if (!this.isConnected || !this.editor || this.editor.removed) return;
        if (!this.ydoc || !this.yText) return;
        if (this.isUpdatingFromRemote) return;
        if (this.isApplyingToEditor) return;

        const newContent = this.editor.getContent();
        if (newContent === this.lastContent) return;

        const initialLastContent = this.lastContent;

        console.log('✍️ Computing diff with versioned merge...');
        const diffs = this.otEngine.computeDiff(initialLastContent, newContent);

        if (diffs.length === 0) return;

        const operations = diffs.map(diff => ({
            ...diff,
            id: this.otEngine.generateOperationId(),
            timestamp: Date.now(),
            siteId: this.siteId,
            documentId: this.entryId,
            version: this.otEngine.documentVersion,
            isHTML: true
        }));

        try {
            this.isApplyingToEditor = true;

            for (const op of operations) {
                await this.otEngine.enqueueOperation(op);
            }

            // Periksa apakah ada pembaruan remote yang masuk selama proses await (mengubah lastContent)
            if (this.lastContent === initialLastContent) {
                this.ydoc.transact(() => {
                    if (this.yText.length > 0) {
                        this.yText.delete(0, this.yText.length);
                    }
                    this.yText.insert(0, newContent);
                }, 'local');

                this.baseContent = newContent;
                this.lastContent = newContent;
            } else {
                console.log('🔄 Pembaruan remote terintegrasi selama await, melewatkan penulisan ulang konten lokal.');
            }

            this.broadcastOTOperations(operations).catch(err => console.error(err));
        } catch (error) {
            console.error('❌ Failed to apply OT operations:', error);
            this.fallbackFullReplace(newContent);
        } finally {
            this.isApplyingToEditor = false;
        }
    }

    async broadcastOTOperations(operations) {
        const opsJson = JSON.stringify(operations);

        if (this.isConnected && this.connection) {
            try {
                await this.connection.invoke('SendOperationOT', this.entryId, opsJson, this.siteId);
                console.log('📤 Broadcasted', operations.length, 'OT operations');

                operations.forEach(op => {
                    this.otEngine.markSynced(op.id);
                });
            } catch (err) {
                console.error('❌ Broadcast failed:', err);
                this.pendingQueue.push({
                    documentId: this.entryId,
                    operationsJson: opsJson,
                    siteId: this.siteId,
                    isOT: true
                });
            }
        } else {
            this.pendingQueue.push({
                documentId: this.entryId,
                operationsJson: opsJson,
                siteId: this.siteId,
                isOT: true
            });
        }
    }

    flushPendingQueue() {
        if (this.pendingQueue.length === 0) return;
        if (!this.connection || !this.isConnected) return;

        console.log(`🔁 Flushing ${this.pendingQueue.length} queued operations...`);
        const snapshot = this.pendingQueue.splice(0, this.pendingQueue.length);
        snapshot.forEach((item) => {
            if (item.isOT) {
                this.connection.invoke('SendOperationOT', this.entryId, item.operationsJson, this.siteId)
                    .catch(() => this.pendingQueue.push(item));
            } else {
                this.connection.invoke('SendOperation', this.entryId, item.updateBase64, this.siteId)
                    .catch(() => this.pendingQueue.push(item));
            }
        });
    }

    async handleRemoteOTOperation(operationsJson) {
        if (!this.useOT) return;

        this.remoteOpQueue = this.remoteOpQueue || [];
        this.remoteOpQueue.push(operationsJson);

        if (this.isProcessingRemoteQueue) return;
        this.isProcessingRemoteQueue = true;

        try {
            while (this.remoteOpQueue.length > 0) {
                const currentOpsJson = this.remoteOpQueue.shift();
                await this._processSingleRemoteOperation(currentOpsJson);
            }
        } finally {
            this.isProcessingRemoteQueue = false;
        }
    }

    async _processSingleRemoteOperation(operationsJson) {
        await this.flushPendingLocalChanges();

        try {
            let operations = JSON.parse(operationsJson);
            if (!Array.isArray(operations) || operations.length === 0) return;

            const hasLocalChanges = this.otEngine.getPendingOperations().length > 0;
            const currentContent = this.yText.toString();

            if (hasLocalChanges) {
                for (const op of operations) {
                    if (op.isFullReplace) {
                        const baseContent = op.oldText || this.lastContent || currentContent;
                        const localContent = currentContent;
                        const remoteContent = op.newText || op.text || '';

                        const mergedContent = this.otEngine.smartThreeWayMerge(baseContent, localContent, remoteContent);

                        this.isUpdatingFromRemote = true;
                        this.isApplyingToEditor = true;

                        this.ydoc.transact(() => {
                            if (this.yText.length > 0) {
                                this.yText.delete(0, this.yText.length);
                            }
                            this.yText.insert(0, mergedContent);
                        }, 'remote');

                        this.isUpdatingFromRemote = false;
                        this.isApplyingToEditor = false;

                        if (this.editor && !this.editor.removed) {
                            this.baseContent = mergedContent;
                            this.lastContent = mergedContent;
                            this._safeSetContent(mergedContent);
                        }
                        return;
                    }
                }
            }

            const pendingOps = this.otEngine.getPendingOperations();
            const transformedOps = this.otEngine.transformOperation(operations, pendingOps);

            this.isUpdatingFromRemote = true;
            this.isApplyingToEditor = true;

            let docContent = this.yText.toString();

            for (const op of transformedOps) {
                if (op.isFullReplace) {
                    const newContent = op.newText || op.text || '';
                    if (newContent === docContent) continue;
                    if (this.yText.length > 0) {
                        this.yText.delete(0, this.yText.length);
                    }
                    this.yText.insert(0, newContent);
                    docContent = this.yText.toString();
                    continue;
                }

                if (op.type === 'delete') {
                    const pos = op.position;
                    const deleteLen = Math.min(op.length || 1, docContent.length - pos);
                    if (pos >= 0 && deleteLen > 0) {
                        this.yText.delete(pos, deleteLen);
                        docContent = this.yText.toString();
                    }
                } else if (op.type === 'insert') {
                    const pos = op.position;
                    const text = op.text || op.html || '';
                    if (pos >= 0 && pos <= docContent.length) {
                        this.yText.insert(pos, text);
                        docContent = this.yText.toString();
                    }
                }
            }

            const finalContent = this.yText.toString();
            if (this.editor && !this.editor.removed) {
                this.baseContent = finalContent;
                this.lastContent = finalContent;
                this._safeSetContent(finalContent);
            }

            this.isUpdatingFromRemote = false;
            this.isApplyingToEditor = false;
        } catch (err) {
            console.error('Failed to apply remote OT operation:', err);
            this.isUpdatingFromRemote = false;
            this.isApplyingToEditor = false;
        }
    }

    // Compatibility alias for chaos tests
    sendContentUpdate(newContent) {
        if (this.useOT) {
            this.sendLocalChangesWithOT();
        } else {
            this.sendLocalChangesToYjs();
        }
    }

    sendLocalChangesToYjs() {
        if (!this.isConnected || !this.editor || this.editor.removed) return;
        if (!this.ydoc || !this.yText) return;
        if (this.isUpdatingFromRemote) return;
        if (this.isApplyingToEditor) return;

        const newContent = this.editor.getContent();
        if (newContent === this.lastContent) return;

        this.isApplyingToEditor = true;
        this.ydoc.transact(() => {
            if (this.yText.length > 0) {
                this.yText.delete(0, this.yText.length);
            }
            this.yText.insert(0, newContent);
        });
        this.isApplyingToEditor = false;
        this.lastContent = newContent;
    }

    async handleRemoteOperation(operationsBase64) {
        if (this.isUpdatingFromRemote) return;

        await this.flushPendingLocalChanges();

        try {
            const update = Uint8Array.from(atob(operationsBase64), c => c.charCodeAt(0));
            if (update.length === 0) return;

            this.isUpdatingFromRemote = true;
            this.ydoc.transact(() => {
                Y.applyUpdate(this.ydoc, update);
            }, 'remote');

            const afterContent = this.yText.toString();
            if (this.editor && !this.editor.removed) {
                this.isApplyingToEditor = true;
                this._safeSetContent(afterContent);
                this.isApplyingToEditor = false;
            }

            this.isUpdatingFromRemote = false;
        } catch (err) {
            console.error('❌ Failed to apply remote operation:', err);
            this.isUpdatingFromRemote = false;
        }
    }

    fallbackFullReplace(newContent) {
        this.isApplyingToEditor = true;
        this.ydoc.transact(() => {
            if (this.yText.length > 0) {
                this.yText.delete(0, this.yText.length);
            }
            this.yText.insert(0, newContent);
        });
        this.isApplyingToEditor = false;
        this.lastContent = newContent;
    }

    _safeSetContent(content) {
        if (!this.editor || this.editor.removed) return;

        let bookmark = null;
        try {
            if (this.editor.selection) {
                bookmark = this.editor.selection.getBookmark(2, true);
            }
        } catch (e) {}

        this.editor.setContent(content);
        this.lastContent = content;

        if (bookmark) {
            try {
                if (this.editor.selection) {
                    this.editor.selection.moveToBookmark(bookmark);
                }
            } catch (e) {}
        }
    }

    updateEditorAvatars() {
        if (!this.editor || !this.editor.updateCollaborators) return;
        const allConnections = Array.from(this.activeUsers.values()).map(u => ({
            ...u,
            isMe: u.id === this.siteId
        }));

        const currentUser = {
            id: this.siteId,
            name: this.displayName || 'You',
            color: '#4caf50',
            isMe: true
        };

        const distinctUsers = [];
        const seenNames = new Set();

        seenNames.add(currentUser.name);
        distinctUsers.push(currentUser);

        allConnections.forEach(u => {
            if (!seenNames.has(u.name)) {
                seenNames.add(u.name);
                distinctUsers.push(u);
            }
        });

        this.editor.updateCollaborators(distinctUsers);
    }

    getRandomColor(siteId) {
        const colors = ['#667eea', '#764ba2', '#f093fb', '#4facfe', '#43e97b', '#fa709a', '#fee140', '#30cfd0'];
        const index = siteId.length % colors.length;
        return colors[index];
    }

    _showStatus(status) {
        const badge = document.getElementById('collab-status-badge');
        if (!badge) return;
        badge.className = 'badge rounded-pill align-middle ms-2';
        if (status === 'connected') {
            badge.className += ' bg-success';
            badge.innerText = 'Online';
        } else if (status === 'reconnecting') {
            badge.className += ' bg-warning text-dark';
            badge.innerText = 'Reconnecting...';
        } else {
            badge.className += ' bg-danger';
            badge.innerText = 'Offline';
        }
    }

    // Chat Integration Methods
    initChat() {
        if (!this.chatEnabled) {
            console.log('💬 Chat disabled for this instance');
            return;
        }

        try {
            if (typeof CollaborationChat === 'undefined') {
                console.warn('⚠️ CollaborationChat not loaded! Chat disabled.');
                return;
            }

            this.chat = new CollaborationChat({
                documentId: this.entryId,
                documentBodyId: this.entryId, // Hub expects documentBodyId
                userId: this.siteId,
                userName: this.displayName,
                color: this.getRandomColor(this.siteId)
            }).init();

            console.log('💬 Chat initialized for client:', this.entryId);
        } catch (error) {
            console.error('❌ Failed to init chat:', error);
        }
    }

    destroyChat() {
        if (this.chat) {
            this.chat.destroy();
            this.chat = null;
        }
    }

    updateOnlineCount(count) {
        if (this.chat) {
            this.chat.updateOnlineCount(count);
        }
    }

    destroy() {
        this.destroyChat();
        if (this.connection && this.isConnected) {
            this.connection.invoke('LeaveDocument', this.entryId, this.siteId, this.displayName)
                .then(() => this.connection.stop())
                .catch(() => {});
        }
        this.isConnected = false;
    }
}

window.CollaborationClient = CollaborationClient;
