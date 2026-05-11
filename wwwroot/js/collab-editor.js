// wwwroot/js/collab-editor.js
import * as Y from 'yjs';

const docId = document.querySelector('h2').textContent.replace('Document: ', '').trim();

// ─── Yjs setup ────────────────────────────────────────────────────────────────
const ydoc  = new Y.Doc();
const ytext = ydoc.getText('content');
var   editor = null;   // TinyMCE instance

// "lastCommitted" = konten HTML yang terakhir kali kita tulis ke Yjs.
// Dipakai untuk mendeteksi apakah editor benar-benar berubah dari sudut pandang Yjs.
let lastCommitted = '';

// Sedang apply update dari Yjs ke editor → jangan trigger sync balik
let applyingRemote = false;

// Sync sudah siap (initial state dari server sudah diterima)
let syncReady = false;

// ─── SignalR setup ─────────────────────────────────────────────────────────────
const connection = new signalR.HubConnectionBuilder()
    .withUrl('/documentHub')
    .withAutomaticReconnect()
    .build();

let isJoined = false;

// ─── Yjs → Server ─────────────────────────────────────────────────────────────
// Kirim update ke server hanya jika berasal dari user lokal
ydoc.on('update', (update, origin) => {
    if (origin !== 'local') return;
    if (!isJoined || !syncReady) return;
    if (connection.state !== signalR.HubConnectionState.Connected) return;

    connection.invoke('SendUpdate', docId, Array.from(update))
        .catch(err => console.error('[Collab] send failed:', err.message));
});

// ─── Yjs → Editor ─────────────────────────────────────────────────────────────
// Saat Yjs berubah karena update remote, update editor
ytext.observe(event => {
    if (event.transaction.origin === 'local') return;  // perubahan lokal, skip
    if (!editor || applyingRemote) return;

    const yjsContent = ytext.toString();

    // Update lastCommitted agar editor change handler tidak re-commit
    lastCommitted = yjsContent;

    applyingRemote = true;
    try {
        const bm = editor.selection.getBookmark(2, true);
        editor.setContent(yjsContent);
        try { editor.selection.moveToBookmark(bm); } catch (_) {}
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

    // Setelah sync, set lastCommitted ke state Yjs saat ini
    lastCommitted = yjsContent;

    // Jika ada konten dari server, tampilkan di editor
    if (editor && yjsContent && yjsContent !== editor.getContent()) {
        applyingRemote = true;
        try { editor.setContent(yjsContent); } finally { applyingRemote = false; }
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

// ─── TinyMCE setup ─────────────────────────────────────────────────────────────
tinymce.init({
    selector: '#editor',
    height: 500,
    plugins: 'link image code lists',
    toolbar: 'undo redo | formatselect | bold italic | alignleft aligncenter alignright | bullist numlist | code',

    setup(ed) {
        editor = ed;

        ed.on('init', () => startConnection());

        // Debounce timer untuk sync editor → Yjs
        let debounce = null;

        ed.on('input keyup paste Change', () => {
            // Jangan proses jika sedang apply dari remote
            if (applyingRemote || !syncReady || !isJoined) return;

            clearTimeout(debounce);
            debounce = setTimeout(() => {
                if (applyingRemote || !syncReady || !isJoined) return;

                const current = ed.getContent();

                // Hanya commit ke Yjs jika konten benar-benar berbeda
                // dari yang terakhir kita commit
                if (current === lastCommitted) return;

                const prev = lastCommitted;
                lastCommitted = current;   // update SEBELUM transact agar tidak loop

                // Hitung diff minimal (prefix/suffix) untuk operasi Yjs yang tepat
                commitDiff(prev, current);
            }, 100);
        });
    }
});

// ─── Diff minimal: hanya delete/insert bagian yang berubah ────────────────────
function commitDiff(oldStr, newStr) {
    // Cari common prefix
    let s = 0;
    const minLen = Math.min(oldStr.length, newStr.length);
    while (s < minLen && oldStr[s] === newStr[s]) s++;

    // Cari common suffix
    let oe = oldStr.length;
    let ne = newStr.length;
    while (oe > s && ne > s && oldStr[oe - 1] === newStr[ne - 1]) { oe--; ne--; }

    const del = oe - s;
    const ins = newStr.slice(s, ne);

    if (del === 0 && ins.length === 0) return;  // tidak ada perubahan nyata

    ydoc.transact(() => {
        if (del > 0) ytext.delete(s, del);
        if (ins)     ytext.insert(s, ins);
    }, 'local');
}

// ─── Connection management ─────────────────────────────────────────────────────
async function startConnection() {
    try {
        await connection.start();
        await connection.invoke('JoinDocument', docId);
        isJoined = true;
        console.log('[Collab] joined:', docId);
    } catch (e) {
        console.error('[Collab] connect error:', e);
        setTimeout(startConnection, 3000);
    }
}

connection.onclose(() => { isJoined = false; syncReady = false; });
connection.onreconnecting(() => { isJoined = false; syncReady = false; });
connection.onreconnected(() => {
    syncReady = false;
    connection.invoke('JoinDocument', docId)
        .then(() => { isJoined = true; })
        .catch(e => console.error('[Collab] rejoin error:', e));
});

window.addEventListener('beforeunload', () => {
    if (isJoined) connection.invoke('LeaveDocument', docId).catch(() => {});
    connection.stop();
});
