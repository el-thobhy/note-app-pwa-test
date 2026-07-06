// File: wwwroot/js/collab/realtime-chaos-test-v2.js
(function (window) {
    'use strict';

    // Intercept registered SignalR callbacks at the prototype level to bypass minification
    window.SignalRInterceptors = window.SignalRInterceptors || {
        callbacks: {}
    };

    if (window.signalR && window.signalR.HubConnection) {
        const originalOn = window.signalR.HubConnection.prototype.on;
        window.signalR.HubConnection.prototype.on = function (methodName, newMethod) {
            const lowerName = methodName.toLowerCase();
            if (!window.SignalRInterceptors.callbacks[lowerName]) {
                window.SignalRInterceptors.callbacks[lowerName] = [];
            }
            // Prevent duplicate interceptor registration
            if (window.SignalRInterceptors.callbacks[lowerName].indexOf(newMethod) === -1) {
                window.SignalRInterceptors.callbacks[lowerName].push(newMethod);
            }
            
            // Register a wrapped callback with the real SignalR connection
            const wrappedCallback = (...args) => {
                if (window.RealTimeChaosTest && window.RealTimeChaosTest.isTesting) {
                    console.log(`[ChaosTest] Ignored real network message for ${methodName}`);
                    return;
                }
                newMethod(...args);
            };
            
            return originalOn.call(this, methodName, wrappedCallback);
        };
    }

    class RealTimeChaosTest {
        constructor() {
            this.client = null;
            this.editor = null;
            this.isTesting = false;
        }

        init() {
            console.log('%c 🌪️ REAL-TIME COLLABORATION CHAOS TEST V2 ', 'background: #2e7d32; color: white; font-size: 16px; padding: 10px;');

            if (typeof _collabClient === 'undefined' || !_collabClient) {
                console.error('❌ Tidak ditemukan instance _collabClient yang aktif! (Pastikan Anda sudah berada di Room.cshtml dan editor sudah ter-load)');
                return false;
            }

            this.client = _collabClient;
            this.editor = _collabClient.editor;

            if (!this.editor) {
                console.error('❌ TinyMCE Editor belum siap.');
                return false;
            }

            return true;
        }

        async runContinuousTypingTest() {
            if (!this.init()) return;
            if (this.isTesting) {
                console.warn('⚠️ Tes sedang berjalan!');
                return;
            }
            this.isTesting = true;

            console.log('\n%c 🚀 MEMULAI SIMULASI MENGETIK BERSAMAAN HURUF-PER-HURUF ', 'background: #ff9800; color: black; padding: 5px; font-weight: bold;');

            const textLocal = " [LOKAL USER A]: Menulis data tabel baris pertama secara real-time. ".repeat(3);
            const textRemote = " [REMOTE USER B]: Menulis data tabel baris kedua secara simultan. ".repeat(3);
            const maxLength = Math.max(textLocal.length, textRemote.length);

            // 1. Reset isi editor dengan tabel template
            this.editor.setContent(`
                <table border="1" style="width:100%; border-collapse: collapse;">
                    <tbody>
                        <tr><td id="cell-a" style="white-space: pre-wrap;">Base A: </td></tr>
                        <tr><td id="cell-b" style="white-space: pre-wrap;">Base B: </td></tr>
                    </tbody>
                </table>
            `);

            await new Promise(r => setTimeout(r, 500));

            // Set baseline konten di client agar sinkron
            const baseContent = this.editor.getContent();
            this.client._baseContent = baseContent;
            this.client.baseContent = baseContent; // Mendukung client Yjs/OT baru
            this.client.lastContent = baseContent; // Mendukung client Yjs/OT baru
            this.client._pendingContent = null;
            this.client._serverVersion = 1;

            let indexLocal = 0;
            let indexRemote = 0;
            let currentSimulatedServerContent = baseContent;
            let simulatedServerVersion = 1;

            // Backup original invoke method
            const originalInvoke = this.client.connection.invoke;
            
            // Stub connection.invoke to handle SendHtmlUpdate locally
            this.client.connection.invoke = (methodName, ...args) => {
                if (methodName === 'SendHtmlUpdate') {
                    const contentSent = args[1];
                    const versionSnapshot = args[2];
                    
                    // Update our simulated server content with the local changes that were merged/sent
                    currentSimulatedServerContent = contentSent;
                    simulatedServerVersion = versionSnapshot + 1;
                    
                    // Simulate server Ack (UpdateAck) after a short delay
                    setTimeout(() => {
                        const ackCallbacks = window.SignalRInterceptors.callbacks["updateack"] || [];
                        for (let cb of ackCallbacks) {
                            cb(simulatedServerVersion);
                        }
                    }, 20);
                    
                    return Promise.resolve();
                }
                if (methodName === 'SendOperationOT') {
                    currentSimulatedServerContent = this.editor.getContent();
                    simulatedServerVersion++;
                    return Promise.resolve();
                }
                return originalInvoke.apply(this.client.connection, [methodName, ...args]);
            };

            console.log('⏳ Mulai mengetik simultan antara LOKAL (User A) dan REMOTE (User B) setiap 120ms...');

            const typeInterval = setInterval(async () => {
                if (indexLocal >= textLocal.length && indexRemote >= textRemote.length) {
                    clearInterval(typeInterval);
                    this.isTesting = false;
                    
                    // Restore original invoke method
                    this.client.connection.invoke = originalInvoke;
                    
                    console.log('%c ✅ TES SELESAI! Silakan periksa tabel di TinyMCE. Perubahan User A & B harus ter-merge dengan rapi.', 'background: #2e7d32; color: white; padding: 10px;');
                    console.log('KONTEN EDITOR SEKARANG:', this.editor.getContent());
                    console.log('SIMULATED SERVER CONTENT:', currentSimulatedServerContent);

                    // Tunda pemulihan koneksi agar tidak menimpa konten editor sebelum kita sempat melihatnya
                    setTimeout(() => {
                        this.client.connection.invoke = originalInvoke;
                        this.isTesting = false;
                        console.log('[ChaosTest] Koneksi riil dipulihkan.');
                    }, 3000);
                    return;
                }

                // 1. Simulasi Ketikan Lokal (User A)
                if (indexLocal < textLocal.length) {
                    let charLocal = textLocal[indexLocal];
                    if (charLocal === ' ') charLocal = '\u00a0'; // Gunakan non-breaking space agar tidak di-trim oleh TinyMCE
                    
                    const cellA = this.editor.dom.select('#cell-a')[0];
                    if (cellA) {
                        // Temukan atau buat text node di dalam cell untuk mempertahankan spasi
                        let textNode = null;
                        for (let child of cellA.childNodes) {
                            if (child.nodeType === 3) { // Text Node
                                textNode = child;
                            }
                        }
                        if (!textNode) {
                            textNode = document.createTextNode('');
                            cellA.appendChild(textNode);
                        }
                        
                        // Tambahkan karakter ke data text node secara langsung (menghindari stripping spasi HTML)
                        textNode.data = textNode.data + charLocal;
                        
                        this.editor.fire('change');
                        
                        // Kirim update lokal ke handler internal collab client
                        this.client.sendContentUpdate(this.editor.getContent());
                    }
                    indexLocal++;
                }

                // 2. Simulasi Ketikan Remote (User B) masuk melalui ReceiveUpdate
                if (indexRemote < textRemote.length) {
                    let charRemote = textRemote[indexRemote];
                    if (charRemote === ' ') charRemote = '\u00a0'; // Gunakan non-breaking space
                    
                    // Lakukan manipulasi di memori representasi server content
                    const match = /(Base B:\s*[\s\S]*?)(?=<\/td>)/i.exec(currentSimulatedServerContent);
                    if (match) {
                        const insertPos = match.index + match[0].length;
                        currentSimulatedServerContent = 
                            currentSimulatedServerContent.substring(0, insertPos) + 
                            charRemote + 
                            currentSimulatedServerContent.substring(insertPos);
                        
                        simulatedServerVersion++;

                        // Trigger callback ReceiveUpdate di client secara terprogram menggunakan interceptor
                        const callbacks = window.SignalRInterceptors.callbacks["receiveupdate"] || [];
                        for (let cb of callbacks) {
                            cb(currentSimulatedServerContent, simulatedServerVersion);
                        }
                    } else {
                        console.warn('[Test Debug] Regex "Base B:" tidak cocok pada content:', currentSimulatedServerContent);
                    }
                    indexRemote++;
                }

            }, 120);
        }
    }

    window.RealTimeChaosTest = new RealTimeChaosTest();
    console.log('%c ✅ Real-Time Chaos Test V2 loaded! Ketik RealTimeChaosTest.runContinuousTypingTest() di console untuk memulai. ', 'background: #0288d1; color: white; padding: 5px;');

})(window);
