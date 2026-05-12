// wwwroot/js/collab-editor-yxml.js
// Fix untuk huruf hilang saat multi-user typing
// Strategi: Sync dengan Y.js state sebelum commit diff

import * as Y from 'yjs';

// Ambil docId dari data attribute (lebih reliable)
const container = document.getElementById('editor-container');
const docId = container?.dataset.docId || 'default';

// ─── Yjs setup ────────────────────────────────────────────────────────────────
const ydoc = new Y.Doc();
const ytext = ydoc.getText('content');
var editor = null;

// State tracking
let applyingRemote = false;
let syncReady = false;
let lastSyncedContent = '';  // Track konten terakhir yang sync dengan Y.js

// ─── SignalR setup ─────────────────────────────────────────────────────────────
const connection = new signalR.HubConnectionBuilder()
    .withUrl('/documentHub')
    .withAutomaticReconnect()
    .build();

let isJoined = false;

// ─── Yjs → Server ─────────────────────────────────────────────────────────────
ydoc.on('update', (update, origin) => {
    if (origin !== 'local') return;
    if (!isJoined || !syncReady) return;
    if (connection.state !== signalR.HubConnectionState.Connected) return;

    connection.invoke('SendUpdate', docId, Array.from(update))
        .catch(err => console.error('[Collab] send failed:', err.message));
});

// ─── Yjs → Editor ─────────────────────────────────────────────────────────────
ytext.observe(event => {
    if (event.transaction.origin === 'local') return;
    if (!editor || applyingRemote) return;

    const yjsContent = ytext.toString();

    applyingRemote = true;
    try {
        const currentContent = editor.getContent();
        if (yjsContent !== currentContent) {
            // Save cursor position before update
            const bm = editor.selection.getBookmark(2, true);
            
            editor.setContent(yjsContent);
            lastSyncedContent = yjsContent;
            
            // Restore cursor
            try { editor.selection.moveToBookmark(bm); } catch (_) {}
        }
    } finally {
        applyingRemote = false;
    }
});

// ─── SignalR handlers ──────────────────────────────────────────────────────────
connection.on('ReceiveUpdate', (arr) => {
    if (!arr?.length) return;
    try {
        Y.applyUpdate(ydoc, new Uint8Array(arr), 'remote');
    } catch (e) {
        console.error('[Collab] applyUpdate error:', e);
    }
});

connection.on('SyncComplete', () => {
    syncReady = true;
    const yjsContent = ytext.toString();
    console.log('[Collab] sync ready, content length:', yjsContent.length);

    lastSyncedContent = yjsContent;

    if (editor) {
        // Jika Yjs kosong, inisialisasi dengan konten editor
        if (yjsContent.length === 0) {
            const initialContent = editor.getContent();
            if (initialContent) {
                ydoc.transact(() => {
                    ytext.insert(0, initialContent);
                }, 'local');
                lastSyncedContent = initialContent;
            }
        }
        // Jika Yjs ada konten, update editor
        else if (yjsContent !== editor.getContent()) {
            applyingRemote = true;
            try { editor.setContent(yjsContent); } finally { applyingRemote = false; }
        }
    }
});

connection.on('RequestFullState', async (targetId) => {
    try {
        const state = Y.encodeStateAsUpdate(ydoc);
        await connection.invoke('SendFullState', docId, targetId, Array.from(state));
    } catch (e) {
        console.error('[Collab] sendFullState error:', e);
    }
});

// ─── Diff function dengan proper rebase ────────────────────────────────────────

/**
 * Commit diff dari editor ke Y.js
 * Penting: Gunakan Y.js state terbaru sebagai base, bukan lastSyncedContent
 */
function commitDiff(editorContent) {
    // Selalu ambil state terbaru dari Y.js
    const yjsContent = ytext.toString();
    
    // Jika Y.js kosong, insert semua
    if (yjsContent.length === 0) {
        ydoc.transact(() => {
            ytext.insert(0, editorContent);
        }, 'local');
        lastSyncedContent = editorContent;
        return;
    }
    
    // Jika sama, skip
    if (yjsContent === editorContent) {
        return;
    }
    
    // Hitung diff dari Y.js state ke editor content
    // Ini memastikan kita meng-apply perubahan user ke atas state Y.js terbaru
    const diff = computeDiff(yjsContent, editorContent);
    
    if (diff.ops.length > 0) {
        ydoc.transact(() => {
            // Apply ops dari belakang ke depan agar index tidak bergeser
            for (let i = diff.ops.length - 1; i >= 0; i--) {
                const op = diff.ops[i];
                if (op.delete > 0) {
                    ytext.delete(op.index, op.delete);
                }
                if (op.insert) {
                    ytext.insert(op.index, op.insert);
                }
            }
        }, 'local');
    }
    
    lastSyncedContent = editorContent;
}

/**
 * Compute diff operations dari oldStr ke newStr
 * Mengembalikan array of operations
 */
function computeDiff(oldStr, newStr) {
    const ops = [];
    
    // Cari common prefix
    let prefix = 0;
    const minLen = Math.min(oldStr.length, newStr.length);
    while (prefix < minLen && oldStr[prefix] === newStr[prefix]) {
        prefix++;
    }
    
    // Cari common suffix
    let oldSuffix = oldStr.length;
    let newSuffix = newStr.length;
    while (oldSuffix > prefix && newSuffix > prefix && oldStr[oldSuffix - 1] === newStr[newSuffix - 1]) {
        oldSuffix--;
        newSuffix--;
    }
    
    const deleteCount = oldSuffix - prefix;
    const insertStr = newStr.slice(prefix, newSuffix);
    
    if (deleteCount > 0 || insertStr.length > 0) {
        ops.push({
            index: prefix,
            delete: deleteCount,
            insert: insertStr
        });
    }
    
    return { ops };
}

// ─── TinyMCE setup ─────────────────────────────────────────────────────────────
tinymce.init({
    selector: '#editor',
    height: 500,
    plugins: 'link image code lists',
    toolbar: 'undo redo | formatselect | bold italic | alignleft aligncenter alignright | bullist numlist | code',

    setup(ed) {
        editor = ed;

        ed.on('init', () => startConnection());

        // Debounce untuk sync
        let debounce = null;

        ed.on('input keyup paste Change', () => {
            if (applyingRemote || !syncReady || !isJoined) return;

            clearTimeout(debounce);
            debounce = setTimeout(() => {
                if (applyingRemote || !syncReady || !isJoined) return;

                const current = ed.getContent();
                if (current === lastSyncedContent) return;

                commitDiff(current);
            }, 150);
        });
    }
});

// ─── Connection management ─────────────────────────────────────────────────────
async function startConnection() {
    try {
        await connection.start();
        await connection.invoke('JoinDocument', docId);
        isJoined = true;
        showStatus('connected');
        console.log('[Collab] joined:', docId);
    } catch (e) {
        console.error('[Collab] connect error:', e);
        showStatus('error');
        setTimeout(startConnection, 3000);
    }
}

connection.onclose(() => { 
    isJoined = false; 
    syncReady = false; 
    showStatus('disconnected');
});
connection.onreconnecting(() => { 
    isJoined = false; 
    syncReady = false; 
    showStatus('reconnecting');
});
connection.onreconnected(() => {
    syncReady = false;
    connection.invoke('JoinDocument', docId)
        .then(() => { 
            isJoined = true; 
            showStatus('connected');
        })
        .catch(e => console.error('[Collab] rejoin error:', e));
});

// ─── Status UI ─────────────────────────────────────────────────────────────────
function showStatus(status) {
    const el = document.getElementById('collab-status');
    if (!el) return;
    
    const map = {
        connected:    { text: '● Online', cls: 'color: green;' },
        disconnected: { text: '● Offline', cls: 'color: red;' },
        reconnecting: { text: '● Reconnecting...', cls: 'color: orange;' },
        error:        { text: '● Error', cls: 'color: red;' },
    };
    const s = map[status] || map.disconnected;
    el.textContent = s.text;
    el.style = s.cls;
}

window.addEventListener('beforeunload', () => {
    if (isJoined) connection.invoke('LeaveDocument', docId).catch(() => {});
    connection.stop();
});
