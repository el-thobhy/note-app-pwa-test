/**
 * COLLABORATION CLIENT WITH YJS + OT ENGINE
 * File: collab-editor_2.js
 * 
 * Modernized version that uses Yjs + OTEngine client-side and ASP.NET Core SignalR.
 */

class CollaborationClient {
    constructor(entryId, displayName, avatar) {
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
        } catch (err) {
            console.error('[Collab] Connection failed:', err);
            this._showStatus('error');
        }

        this.connection.onreconnected(async () => {
            this.isConnected = true;
            await this.connection.invoke('JoinDocument', this.entryId, this.siteId, this.displayName);
            this._showStatus('connected');
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
                        color: this.getRandomColor(user.siteId)
                    });
                }
            });
            this.updateEditorAvatars();
        });

        this.connection.on('userJoined', (data) => {
            console.log('👤 [Collab] User joined:', data);
            if (!this.activeUsers.has(data.siteId)) {
                this.activeUsers.set(data.siteId, {
                    id: data.siteId,
                    name: data.userName,
                    color: this.getRandomColor(data.siteId)
                });
                this.updateEditorAvatars();
            }
        });

        this.connection.on('userLeft', (data) => {
            console.log('👋 [Collab] User left:', data);
            this.activeUsers.delete(data.siteId);
            this.updateEditorAvatars();
        });

        this.connection.on('userCount', (count) => {
            console.log('📊 [Collab] Active user count:', count);
            $(document).trigger('collaboration.userCount', count);
        });
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

    async flushPendingLocalChanges() {
        if (this.editor && !this.editor.removed && this.ydoc && this.yText && !this.isUpdatingFromRemote && !this.isApplyingToEditor) {
            const currentContent = this.editor.getContent();
            if (currentContent !== this.lastContent) {
                this.sendContentUpdate(currentContent);
            }
        }
    }

    sendContentUpdate(newContent) {
        if (!this.isConnected || !this.editor || this.editor.removed) return;
        if (this.isUpdatingFromRemote || this.isApplyingToEditor) return;
        if (newContent === this.lastContent) return;

        const diffs = this.otEngine.computeDiff(this.lastContent, newContent);
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
                this.otEngine.enqueueOperation(op);
            }

            this.ydoc.transact(() => {
                if (this.yText.length > 0) {
                    this.yText.delete(0, this.yText.length);
                }
                this.yText.insert(0, newContent);
            }, 'local');

            const opsJson = JSON.stringify(operations);
            this.baseContent = newContent; // Update base content secara sinkron agar tidak race dengan ReceiveUpdate
            this.connection.invoke('SendOperationOT', this.entryId, opsJson, this.siteId)
                .then(() => {
                    console.log('✅ [Collab] SendOperationOT broadcasted successfully');
                    operations.forEach(op => this.otEngine.markSynced(op.id));
                })
                .catch(err => console.error('❌ [Collab] Broadcast failed:', err));

            this.lastContent = newContent;
        } catch (error) {
            console.error('Failed to apply OT operations:', error);
        } finally {
            this.isApplyingToEditor = false;
        }
    }

    async handleRemoteOTOperation(operationsJson) {
        if (!this.useOT) return;

        console.log('📥 [Collab] Enqueueing remote OT operation, current queue size:', this.remoteOpQueue.length);
        this.remoteOpQueue.push(operationsJson);

        if (this.isProcessingRemoteQueue) return;
        this.isProcessingRemoteQueue = true;

        try {
            while (this.remoteOpQueue.length > 0) {
                const currentOpsJson = this.remoteOpQueue.shift();
                console.log('⚙️ [Collab] Processing remote operation...');
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
        const list = Array.from(this.activeUsers.values());
        this.editor.updateCollaborators(list);
    }

    getRandomColor(siteId) {
        const colors = ['#667eea', '#764ba2', '#f093fb', '#4facfe', '#43e97b', '#fa709a', '#fee140', '#30cfd0'];
        const index = siteId.length % colors.length;
        return colors[index];
    }

    _getBookmark() {
        try {
            return this.editor.selection.getBookmark(2, true);
        } catch (e) {
            return null;
        }
    }

    _restoreBookmark(bookmark) {
        if (!bookmark) return;
        try {
            this.editor.selection.moveToBookmark(bookmark);
        } catch (e) {}
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

    destroy() {
        if (this.connection && this.isConnected) {
            this.connection.invoke('LeaveDocument', this.entryId, this.siteId, this.displayName)
                .then(() => this.connection.stop())
                .catch(() => {});
        }
        this.isConnected = false;
        instances.delete(this.id);
    }
}
