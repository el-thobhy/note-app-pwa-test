// wwwroot/js/collab-editor-yxml.js
// Collaborative editing dengan Y.XmlFragment untuk HTML content
// Y.XmlFragment didesain untuk structured content (DOM-like)

import * as Y from 'yjs';

// Ambil docId dari data attribute (lebih reliable)
const container = document.getElementById('editor-container');
const docId = container?.dataset.docId || 'default';

// ─── Yjs setup dengan XmlFragment ─────────────────────────────────────────────
const ydoc = new Y.Doc();

// GUNAKAN XmlFragment BUKAN Text untuk HTML content
// XmlFragment mendukung nested elements dan formatting
const yxml = ydoc.get('content', Y.XmlFragment);

var editor = null;

// State tracking
let lastCommitted = '';
let applyingRemote = false;
let syncReady = false;

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

// ─── Helper: XmlFragment ↔ HTML conversion ────────────────────────────────────

/**
 * Konversi HTML string ke Y.XmlFragment
 * Parse HTML dan buat struktur Y.XmlElement/Y.XmlText
 */
function htmlToYxml(html, yxmlFragment) {
    // Parse HTML ke DOM
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div id="root">${html}</div>`, 'text/html');
    const root = doc.getElementById('root');

    // Clear existing content
    yxmlFragment.delete(0, yxmlFragment.length);

    // Convert DOM nodes ke Y.Xml nodes
    function convertNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            return new Y.XmlText(node.textContent);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node;
            const tagName = element.tagName.toLowerCase();

            // Skip wrapper div
            if (tagName === 'div' && element.id === 'root') {
                const children = [];
                element.childNodes.forEach(child => {
                    const converted = convertNode(child);
                    if (converted) children.push(converted);
                });
                return children;
            }

            // Buat Y.XmlElement
            const yElement = new Y.XmlElement(tagName);

            // Copy attributes
            Array.from(element.attributes).forEach(attr => {
                yElement.setAttribute(attr.name, attr.value);
            });

            // Convert children
            element.childNodes.forEach(child => {
                const converted = convertNode(child);
                if (converted) {
                    if (Array.isArray(converted)) {
                        converted.forEach(c => yElement.push([c]));
                    } else {
                        yElement.push([converted]);
                    }
                }
            });

            return yElement;
        }
        return null;
    }

    const result = convertNode(root);
    if (Array.isArray(result)) {
        result.forEach(node => {
            if (node) yxmlFragment.push([node]);
        });
    }
}

/**
 * Konversi Y.XmlFragment ke HTML string
 */
function yxmlToHtml(yxmlFragment) {
    let html = '';

    yxmlFragment.toArray().forEach(node => {
        html += nodeToHtml(node);
    });

    return html;
}

/**
 * Konversi single Y.Xml node ke HTML string
 */
function nodeToHtml(node) {
    if (node instanceof Y.XmlText) {
        return node.toString();
    } else if (node instanceof Y.XmlElement) {
        const tagName = node.nodeName;
        const attrs = Array.from(node.getAttributes())
            .map(([key, value]) => `${key}="${escapeHtml(value)}"`)
            .join(' ');

        const attrStr = attrs ? ` ${attrs}` : '';

        const children = node.toArray()
            .map(child => nodeToHtml(child))
            .join('');

        // Self-closing tags
        const selfClosing = ['br', 'hr', 'img', 'input', 'meta', 'link'];
        if (selfClosing.includes(tagName) && !children) {
            return `<${tagName}${attrStr} />`;
        }

        return `<${tagName}${attrStr}>${children}</${tagName}>`;
    }
    return '';
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ─── Yjs → Editor ─────────────────────────────────────────────────────────────
// Deep observer untuk perubahan apapun di XmlFragment
yxml.observeDeep(events => {
    // Skip jika perubahan dari local
    const isLocal = events.some(e => e.transaction?.origin === 'local');
    if (isLocal) return;

    if (!editor || applyingRemote || !syncReady) return;

    const yjsContent = yxmlToHtml(yxml);
    lastCommitted = yjsContent;

    applyingRemote = true;
    try {
        if (editor.getContent() !== yjsContent) {
            const bm = editor.selection.getBookmark(2, true);
            editor.setContent(yjsContent);
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

    const yjsContent = yxmlToHtml(yxml);
    console.log('[Collab] sync ready, content length:', yjsContent.length);

    lastCommitted = yjsContent;

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

        // Debounce untuk sync editor → Yjs
        let debounce = null;

        ed.on('input keyup paste Change', () => {
            if (applyingRemote || !syncReady || !isJoined) return;

            clearTimeout(debounce);
            debounce = setTimeout(() => {
                if (applyingRemote || !syncReady || !isJoined) return;

                const current = ed.getContent();

                // Hanya sync jika benar-benar berbeda
                if (current === lastCommitted) return;

                // Update tracking
                lastCommitted = current;

                // Apply ke Y.XmlFragment
                ydoc.transact(() => {
                    htmlToYxml(current, yxml);
                }, 'local');

            }, 100);
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
