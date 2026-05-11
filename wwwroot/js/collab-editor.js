// wwwroot/js/collab-editor.js
import * as Y from 'yjs';

const docId = document.querySelector('h2').textContent.replace('Document: ', '').trim();
const username = document.getElementById('username').value;

// === 1. Setup Yjs ===
const ydoc = new Y.Doc();
const ytext = ydoc.getText('content');
var tinymceEditor = null;

// Flag untuk mencegah loop: editor → yjs → editor → yjs → ...
let _applyingFromYjs = false;

// === 2. Setup SignalR ===
const connection = new signalR.HubConnectionBuilder()
    .withUrl('/documentHub')
    .withAutomaticReconnect()
    .build();

let isJoined = false;

// === 3. Yjs → Editor (satu arah: Yjs update → set editor content) ===

/**
 * Apply perubahan dari Yjs ke TinyMCE.
 * Dipanggil saat menerima update dari remote peer.
 * Menggunakan flag _applyingFromYjs untuk mencegah feedback loop.
 */
function applyYjsToEditor() {
    if (!tinymceEditor || _applyingFromYjs) return;

    const newContent = ytext.toString();
    const currentContent = tinymceEditor.getContent();

    if (newContent === currentContent) return;

    _applyingFromYjs = true;
    try {
        // Simpan posisi kursor sebelum update
        const bookmark = tinymceEditor.selection.getBookmark(2, true);
        tinymceEditor.setContent(newContent);
        // Coba restore kursor, abaikan jika gagal (posisi mungkin sudah tidak valid)
        try { tinymceEditor.selection.moveToBookmark(bookmark); } catch (_) {}
    } finally {
        _applyingFromYjs = false;
    }
}

// === 4. Editor → Yjs (satu arah: user ketik → update Yjs dengan diff minimal) ===

/**
 * Hitung diff minimal antara oldStr dan newStr,
 * lalu apply sebagai operasi insert/delete ke ytext.
 *
 * Ini mencegah "delete all + insert all" yang menyebabkan duplikasi
 * saat dua user mengetik bersamaan.
 */
function applyDiffToYtext(oldStr, newStr) {
    if (oldStr === newStr) return;

    // Cari common prefix
    let prefixLen = 0;
    const minLen = Math.min(oldStr.length, newStr.length);
    while (prefixLen < minLen && oldStr[prefixLen] === newStr[prefixLen]) {
        prefixLen++;
    }

    // Cari common suffix (dari belakang, setelah prefix)
    let oldSuffixStart = oldStr.length;
    let newSuffixStart = newStr.length;
    while (
        oldSuffixStart > prefixLen &&
        newSuffixStart > prefixLen &&
        oldStr[oldSuffixStart - 1] === newStr[newSuffixStart - 1]
    ) {
        oldSuffixStart--;
        newSuffixStart--;
    }

    // Bagian yang dihapus dari old
    const deleteLen = oldSuffixStart - prefixLen;
    // Bagian yang diinsert dari new
    const insertStr = newStr.slice(prefixLen, newSuffixStart);

    // Apply dalam satu transaksi dengan origin 'local'
    ydoc.transact(() => {
        if (deleteLen > 0) {
            ytext.delete(prefixLen, deleteLen);
        }
        if (insertStr.length > 0) {
            ytext.insert(prefixLen, insertStr);
        }
    }, 'local');
}

// === 5. SignalR Event Handlers ===

connection.on('InitialState', (stateArray) => {
    if (!stateArray || stateArray.length === 0) {
        console.log('[Collab] Room kosong, mulai fresh');
        return;
    }

    try {
        const uint8 = new Uint8Array(stateArray);
        // Apply dengan origin 'remote' agar tidak trigger SendUpdate
        Y.applyUpdate(ydoc, uint8, 'remote');
        applyYjsToEditor();
        console.log('[Collab] Initial state applied,', stateArray.length, 'bytes');
    } catch (err) {
        console.error('[Collab] Error applying initial state:', err);
    }
});

connection.on('RequestFullState', async (targetConnectionId) => {
    try {
        const fullState = Y.encodeStateAsUpdate(ydoc);
        await connection.invoke('SendFullState', docId, targetConnectionId, Array.from(fullState));
        console.log('[Collab] Full state sent to', targetConnectionId);
    } catch (err) {
        console.error('[Collab] Error sending full state:', err);
    }
});

connection.on('ReceiveUpdate', (updateArray) => {
    try {
        const uint8 = new Uint8Array(updateArray);
        // Apply dengan origin 'remote' agar tidak trigger SendUpdate
        Y.applyUpdate(ydoc, uint8, 'remote');
        // Update editor dari Yjs (bukan dari updateArray langsung)
        applyYjsToEditor();
    } catch (err) {
        console.error('[Collab] Error applying update:', err);
    }
});

// === 6. Yjs observer → kirim ke server ===

ydoc.on('update', (update, origin) => {
    // Hanya kirim update dari user lokal
    if (origin !== 'local') return;
    if (!isJoined) return;
    if (connection.state !== signalR.HubConnectionState.Connected) return;

    connection.invoke('SendUpdate', docId, Array.from(update))
        .catch(err => console.error('[Collab] Send failed:', err.message));
});

// === 7. TinyMCE Setup ===

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

        // Saat user mengetik, hitung diff dan apply ke Yjs
        editor.on('input keyup paste', () => {
            // Jangan proses jika sedang apply dari Yjs (mencegah loop)
            if (_applyingFromYjs) return;

            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (!isJoined || _applyingFromYjs) return;

                const newHtml = editor.getContent();
                const oldHtml = ytext.toString();

                // Gunakan diff minimal, bukan replace seluruh konten
                applyDiffToYtext(oldHtml, newHtml);
            }, 80); // debounce 80ms — cukup responsif tapi tidak terlalu agresif
        });
    }
});

// === 8. Connection Management ===

async function startConnection() {
    try {
        await connection.start();
        console.log('[Collab] SignalR connected');

        await connection.invoke('JoinDocument', docId);
        console.log('[Collab] Joined document:', docId);

        isJoined = true;

        // Sync konten editor awal ke Yjs dengan origin 'remote'
        // agar tidak langsung di-broadcast ke server
        const html = tinymceEditor?.getContent() ?? '';
        if (html && ytext.toString() !== html) {
            ydoc.transact(() => {
                ytext.delete(0, ytext.toString().length);
                ytext.insert(0, html);
            }, 'remote');
        }

    } catch (err) {
        console.error('[Collab] Connection error:', err);
        setTimeout(startConnection, 3000);
    }
}

connection.onclose(() => {
    isJoined = false;
    console.log('[Collab] Disconnected');
});

connection.onreconnecting(() => {
    isJoined = false;
    console.log('[Collab] Reconnecting...');
});

connection.onreconnected(() => {
    connection.invoke('JoinDocument', docId)
        .then(() => { isJoined = true; console.log('[Collab] Rejoined'); })
        .catch(err => console.error('[Collab] Rejoin failed:', err));
});

window.addEventListener('beforeunload', () => {
    if (isJoined) connection.invoke('LeaveDocument', docId).catch(() => {});
    connection.stop();
});
