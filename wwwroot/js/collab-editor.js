// wwwroot/js/collab-editor.js
import * as Y from 'yjs';

const docId = document.querySelector('h2').textContent.replace('Document: ', '');
const username = document.getElementById('username').value;

// === 1. Setup Yjs ===
const ydoc = new Y.Doc();
const ytext = ydoc.getText('content');
var tinymceEditor = null;

// === 2. Setup SignalR ===
const connection = new signalR.HubConnectionBuilder()
    .withUrl('/documentHub')
    .withAutomaticReconnect()
    .configureLogging(signalR.LogLevel.Debug) // Tambah debug logging
    .build();

let isJoined = false;

// === 3. Event Handlers ===

connection.on('InitialState', (stateArray) => {
    console.log('InitialState received, length:', stateArray?.length || 0);

    if (!stateArray || stateArray.length === 0) {
        console.warn('No initial state — starting fresh');
        return;
    }

    try {
        const uint8 = new Uint8Array(stateArray);
        Y.applyUpdate(ydoc, uint8);

        if (tinymceEditor) {
            tinymceEditor.setContent(ytext.toString());
        }
    } catch (err) {
        console.error('Error applying initial state:', err);
    }
});

// Server minta kita kirim full state ke newcomer
connection.on('RequestFullState', async (targetConnectionId) => {
    try {
        const fullState = Y.encodeStateAsUpdate(ydoc);
        await connection.invoke('SendFullState', docId, targetConnectionId, Array.from(fullState));
        console.log('Full state sent to', targetConnectionId);
    } catch (err) {
        console.error('Error sending full state:', err);
    }
});

connection.on('ReceiveUpdate', (updateArray) => {
    try {
        const uint8 = new Uint8Array(updateArray);
        Y.applyUpdate(ydoc, uint8, 'remote');

        if (tinymceEditor) {
            const currentContent = tinymceEditor.getContent();
            const newContent = ytext.toString();

            if (currentContent !== newContent) {
                const bookmark = tinymceEditor.selection.getBookmark(2, true);
                tinymceEditor.setContent(newContent);
                tinymceEditor.selection.moveToBookmark(bookmark);
            }
        }
    } catch (err) {
        console.error('Error applying update:', err);
    }
});

// Local changes → kirim ke server
ydoc.on('update', (update, origin) => {
    // Hanya kirim update yang berasal dari user lokal (origin 'local')
    if (origin !== 'local') return;
    if (!isJoined) return;
    if (connection.state !== signalR.HubConnectionState.Connected) return;

    connection.invoke('SendUpdate', docId, Array.from(update))
        .catch(err => console.error('Send failed:', err.message));
});

// === 4. TinyMCE Setup ===
tinymce.init({
    selector: '#editor',
    height: 500,
    plugins: 'link image code lists',
    toolbar: 'undo redo | formatselect | bold italic | alignleft aligncenter alignright | bullist numlist | code',

    setup: (editor) => {
        tinymceEditor = editor;

        editor.on('init', () => {
            // Start SignalR setelah TinyMCE ready
            startConnection();
        });

        let debounceTimer;
        editor.on('input keyup paste', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (!isJoined) return;
                const html = editor.getContent();
                const currentText = ytext.toString();

                if (html !== currentText) {
                    // origin 'local' → akan di-send ke server via ydoc.on('update')
                    ydoc.transact(() => {
                        ytext.delete(0, currentText.length);
                        ytext.insert(0, html);
                    }, 'local');
                }
            }, 100);
        });
    }
});

// === 5. Connection Management ===
async function startConnection() {
    try {
        await connection.start();
        console.log('SignalR connected');

        await connection.invoke('JoinDocument', docId);
        console.log('Joined document:', docId);

        // Set isJoined SETELAH join selesai
        isJoined = true;

        // Sync konten editor ke ydoc dengan origin 'init' agar tidak trigger SendUpdate
        if (tinymceEditor) {
            const html = tinymceEditor.getContent();
            if (html && ytext.toString() !== html) {
                ydoc.transact(() => {
                    ytext.delete(0, ytext.toString().length);
                    ytext.insert(0, html);
                }, 'remote'); // origin 'remote' → tidak akan di-send ke server
            }
        }

    } catch (err) {
        console.error('SignalR connection error:', err);
        setTimeout(startConnection, 3000);
    }
}

connection.onclose((error) => {
    console.log('SignalR closed:', error);
    isJoined = false;
});

connection.onreconnecting((error) => {
    console.log('SignalR reconnecting:', error);
    isJoined = false;
});

connection.onreconnected((connectionId) => {
    console.log('SignalR reconnected:', connectionId);
    // Re-join document
    connection.invoke('JoinDocument', docId)
        .then(() => { isJoined = true; })
        .catch(err => console.error('Re-join failed:', err));
});

// Cleanup
window.addEventListener('beforeunload', () => {
    if (isJoined) {
        connection.invoke('LeaveDocument', docId);
    }
    connection.stop();
});