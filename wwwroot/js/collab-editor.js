// wwwroot/js/collab-editor.js
import * as Y from 'yjs';

const docId = document.querySelector('h2').textContent.replace('Document: ', '').trim();

// === 1. Setup Yjs ===
const ydoc = new Y.Doc();
const ytext = ydoc.getText('content');
var tinymceEditor = null;

// Mencegah feedback loop: Yjs update → editor → Yjs update → ...
let _applyingFromYjs = false;

// Apakah initial sync dari server sudah selesai
let _syncReady = false;

// === 2. Setup SignalR ===
const connection = new signalR.HubConnectionBuilder()
    .withUrl('/documentHub')
    .withAutomaticReconnect()
    .build();

let isJoined = false;

// === 3. Yjs observer: kirim update ke server ===
ydoc.on('update', (update, origin) => {
    if (origin !== 'local') return;
    if (!isJoined || !_syncReady) return;
    if (connection.state !== signalR.HubConnectionState.Connected) return;

    connection.invoke('SendUpdate', docId, Array.from(update))
        .catch(err => console.error('[Collab] Send failed:', err.message));
});

// === 4. Yjs observer: update editor saat Yjs berubah ===
ytext.observe(event => {
    // Hanya update editor jika perubahan bukan dari user lokal
    // (perubahan lokal sudah ada di editor, tidak perlu di-set ulang)
    if (event.transaction.origin === 'local') return;
    if (!tinymceEditor || _applyingFromYjs) return;

    const newContent = ytext.toString();
    const currentContent = tinymceEditor.getContent();
    if (newContent === currentContent) return;

    _applyingFromYjs = true;
    try {
        const bookmark = tinymceEditor.selection.getBookmark(2, true);
        tinymceEditor.setContent(newContent);
        try { tinymceEditor.selection.moveToBookmark(bookmark); } catch (_) {}
    } finally {
        _applyingFromYjs = false;
    }
});

// === 5. SignalR handlers ===

// Terima update dari server (dari peer atau initial sync)
connection.on('ReceiveUpdate', (updateArray) => {
    if (!updateArray || updateArray.length === 0) return;
    try {
        const uint8 = new Uint8Array(updateArray);
        // Origin 'remote' → tidak akan di-broadcast balik ke server
        Y.applyUpdate(ydoc, uint8, 'remote');
    } catch (err) {
        console.error('[Collab] Error applying update:', err);
    }
});

// Server selesai kirim semua updates → editor siap dipakai
connection.on('SyncComplete', () => {
    _syncReady = true;
    console.log('[Collab] Sync complete, ytext:', ytext.toString().substring(0, 50));

    // Setelah sync, update editor dengan state Yjs terkini
    if (tinymceEditor) {
        const yjsContent = ytext.toString();
        if (yjsContent && yjsContent !== tinymceEditor.getContent()) {
            _applyingFromYjs = true;
            try {
                tinymceEditor.setContent(yjsContent);
            } finally {
                _applyingFromYjs = false;
            }
        }
    }
});

// Peer minta kita kirim full state ke newcomer
connection.on('RequestFullState', async (targetConnectionId) => {
    try {
        const fullState = Y.encodeStateAsUpdate(ydoc);
        await connection.invoke('SendFullState', docId, targetConnectionId, Array.from(fullState));
        console.log('[Collab] Full state sent to', targetConnectionId);
    } catch (err) {
        console.error('[Collab] Error sending full state:', err);
    }
});

// === 6. TinyMCE Setup ===
tinymce.init({
    selector: '#editor',
    height: 500,
    plugins: 'link image code lists',
    toolbar: 'undo redo | formatselect | bold italic | alignleft aligncenter alignright | bullist numlist | code',

    setup: (editor) => {
        tinymceEditor = editor;

        editor.on('init', () => {
            startConnection();
        });

        let debounceTimer;

        editor.on('input keyup paste', () => {
            if (_applyingFromYjs || !_syncReady) return;

            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (_applyingFromYjs || !isJoined || !_syncReady) return;

                const newHtml = editor.getContent();
                const oldHtml = ytext.toString();

                if (newHtml === oldHtml) return;

                // Hitung diff minimal untuk menghindari "delete all + insert all"
                applyDiffToYtext(oldHtml, newHtml);
            }, 80);
        });
    }
});

// === 7. Diff minimal: hanya insert/delete bagian yang berubah ===
function applyDiffToYtext(oldStr, newStr) {
    if (oldStr === newStr) return;

    // Cari common prefix
    let start = 0;
    while (start < oldStr.length && start < newStr.length && oldStr[start] === newStr[start]) {
        start++;
    }

    // Cari common suffix
    let oldEnd = oldStr.length;
    let newEnd = newStr.length;
    while (oldEnd > start && newEnd > start && oldStr[oldEnd - 1] === newStr[newEnd - 1]) {
        oldEnd--;
        newEnd--;
    }

    const deleteCount = oldEnd - start;
    const insertText = newStr.slice(start, newEnd);

    ydoc.transact(() => {
        if (deleteCount > 0) ytext.delete(start, deleteCount);
        if (insertText.length > 0) ytext.insert(start, insertText);
    }, 'local');
}

// === 8. Connection Management ===
async function startConnection() {
    try {
        await connection.start();
        console.log('[Collab] Connected');

        await connection.invoke('JoinDocument', docId);
        console.log('[Collab] Joined:', docId);

        isJoined = true;

        // Jika tidak ada state dari server (room kosong),
        // sync konten editor ke Yjs dan tandai sync selesai
        // SyncComplete akan di-trigger oleh server jika room kosong

    } catch (err) {
        console.error('[Collab] Connection error:', err);
        setTimeout(startConnection, 3000);
    }
}

connection.onclose(() => {
    isJoined = false;
    _syncReady = false;
});

connection.onreconnecting(() => {
    isJoined = false;
    _syncReady = false;
});

connection.onreconnected(() => {
    _syncReady = false;
    connection.invoke('JoinDocument', docId)
        .then(() => { isJoined = true; })
        .catch(err => console.error('[Collab] Rejoin failed:', err));
});

window.addEventListener('beforeunload', () => {
    if (isJoined) connection.invoke('LeaveDocument', docId).catch(() => {});
    connection.stop();
});
