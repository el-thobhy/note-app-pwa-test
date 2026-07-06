// File: Scripts/test-table-merge-live.js
(function (window) {
    'use strict';

    class RealTimeChaosTest {
        constructor() {
            this.instance = null;
            this.engine = null;
            this.editor = null;
            this.isTesting = false;
        }

        init() {
            console.log('%c 🌪️ REAL-TIME TABLE CHAOS TEST ', 'background: #d32f2f; color: white; font-size: 16px; padding: 10px;');

            const instances = window.TeletypeCollaboration?.getAllInstances() || [];
            if (instances.length === 0) {
                console.error('❌ Tidak ditemukan instance TeletypeCollaboration yang aktif! (Pastikan document sudah terbuka)');
                return false;
            }

            this.instance = instances[0];
            this.engine = this.instance.otEngine;
            this.editor = this.instance.editor;

            if (!this.engine || !this.editor) {
                console.error('❌ Editor atau OTEngine belum siap.');
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

            console.log('\n%c 🚀 MEMULAI SIMULASI MENGETIK BERSAMAAN HURUF-PER-HURUF DI EDITOR NYATA ', 'background: #ff5722; color: white; padding: 5px;');

            // 1. Siapkan teks yang sangat panjang untuk diketik secara real-time
            const textA = " [TEKS USER A LOKAL]: Sedang mengetik dokumen yang sangat penting secara real time. ".repeat(4);
            const textB = " [TEKS USER B REMOTE]: Sedang mengetik dokumen yang berbeda di baris lain. ".repeat(4);
            const textC = " [TEKS USER C REMOTE]: Menambahkan bagian lain yang juga tidak kalah penting. ".repeat(4);
            const textD = " [TEKS USER D REMOTE]: Merombak baris ke empat untuk memberikan contoh. ".repeat(4);
            const textE = " [TEKS USER E REMOTE]: Mengetik pelan-pelan tapi pasti di sel kelima. ".repeat(4);
            const textF = " [TEKS USER F REMOTE]: Mengubah gaya bahasa teks pada baris terakhir. ".repeat(4);

            const maxLength = Math.max(textA.length, textB.length, textC.length, textD.length, textE.length, textF.length);

            // 2. Bersihkan editor dan buat struktur tabel awal
            this.editor.setContent(`
                <table border="1" style="width:100%; border-collapse: collapse;">
                    <tbody>
                        <tr><td id="cell-a">Base A:</td></tr>
                        <tr><td id="cell-b">Base B:</td></tr>
                        <tr><td id="cell-c">Base C:</td></tr>
                        <tr><td id="cell-d">Base D:</td></tr>
                        <tr><td id="cell-e">Base E:</td></tr>
                        <tr><td id="cell-f">Base F:</td></tr>
                    </tbody>
                </table>
            `);

            // Beri waktu sejenak agar perubahan konten editor tersimpan ke sistem Yjs
            await new Promise(r => setTimeout(r, 500));
            this.instance.lastContent = this.editor.getContent();

            let indexA = 0;
            let indices = { b: 0, c: 0, d: 0, e: 0, f: 0 };
            let currentSimulatedRemoteHTML = this.editor.getContent(); // User B-F state

            // Fokuskan editor ke ujung cell-a untuk User A
            const cellA = this.editor.dom.select('#cell-a')[0];
            this.editor.selection.select(cellA, true);
            this.editor.selection.collapse(false);

            console.log('⏳ Mengetik perlahan secara simultan (6 USER) setiap 100 milidetik...');

            const typeInterval = setInterval(async () => {
                // Hentikan jika semuanya selesai
                if (indexA >= maxLength && indices.b >= maxLength) {
                    clearInterval(typeInterval);
                    this.isTesting = false;
                    console.log('%c ✅ TES SELESAI! Silakan periksa tabel di editor Anda. Teks dari 6 User harus utuh.', 'background: #28a745; color: white; padding: 10px;');
                    return;
                }

                // ==========================================
                // 🔹 SIMULASI USER A (Lokal - mengetik dari keyboard)
                // ==========================================
                if (indexA < textA.length) {
                    const charA = textA[indexA];
                    this.editor.insertContent(charA);
                    this.editor.fire('keyup');
                    indexA++;
                }

                // ==========================================
                // 🔹 SIMULASI 5 USER REMOTE
                // ==========================================
                const remotes = [
                    { key: 'Base B:', text: textB, idxKey: 'b', siteId: 'userB_111' },
                    { key: 'Base C:', text: textC, idxKey: 'c', siteId: 'userC_222' },
                    { key: 'Base D:', text: textD, idxKey: 'd', siteId: 'userD_333' },
                    { key: 'Base E:', text: textE, idxKey: 'e', siteId: 'userE_444' },
                    { key: 'Base F:', text: textF, idxKey: 'f', siteId: 'userF_555' }
                ];

                for (let r of remotes) {
                    let idx = indices[r.idxKey];
                    if (idx < r.text.length) {
                        const char = r.text[idx];

                        // Escape the key if needed, or just match literally
                        const match = new RegExp(`(${r.key}[\\s\\S]*?)(?=</td>)`, 'i').exec(currentSimulatedRemoteHTML);
                        if (match) {
                            const insertPos = match.index + match[0].length;
                            const newRemoteHTML = currentSimulatedRemoteHTML.substring(0, insertPos) + char + currentSimulatedRemoteHTML.substring(insertPos);

                            const mockOps = [{
                                type: 'replace',
                                position: 0,
                                oldText: currentSimulatedRemoteHTML,
                                newText: newRemoteHTML,
                                isTableOperation: true,
                                isFullReplace: true,
                                id: 'mock_op_' + Date.now() + Math.random().toString().substr(2, 5),
                                timestamp: Date.now(),
                                siteId: r.siteId
                            }];

                            currentSimulatedRemoteHTML = newRemoteHTML;

                            // Tembakkan langsung ke fungsi penerima SignalR (mensimulasikan paket data masuk!)
                            await this.instance.handleRemoteOTOperation(JSON.stringify(mockOps));
                        }
                        indices[r.idxKey]++;
                    }
                }

            }, 100); // Eksekusi persis bersamaan setiap 100 milidetik (kondisi ekstrem 6 user)
        }
    }

    window.RealTimeChaosTest = new RealTimeChaosTest();
    console.log('%c ✅ Real-Time Chaos Test loaded! Type RealTimeChaosTest.runContinuousTypingTest() to run. ', 'background: #17a2b8; color: white; padding: 10px;');

})(window);
