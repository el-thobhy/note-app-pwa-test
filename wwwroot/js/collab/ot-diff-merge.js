// ============================================================
// OPERATIONAL TRANSFORM ENGINE WITH VERSIONED MERGE - FIXED
// File: Scripts/ot-diff-merge.js
// ============================================================

(function (window) {
    'use strict';

    class OTEngine {
        constructor() {
            this.operationQueue = [];
            this.operationHistory = [];
            this.version = 0;
            this.isProcessing = false;
            this.maxHistory = 100;
            this.opCounter = 0;
            this.documentVersion = 0;
            this.lastSyncTime = Date.now();
            this.versionMap = new Map();
            this.conflictCache = new Map();
        }

        // ============================================================
        // QUEUE SYSTEM
        // ============================================================

        enqueueOperation(operation) {
            return new Promise((resolve, reject) => {
                this.operationQueue.push({
                    operation: operation,
                    resolve: resolve,
                    reject: reject,
                    timestamp: Date.now(),
                    id: this.generateOperationId(),
                    version: this.documentVersion
                });
                this.processQueue();
            });
        }

        async processQueue() {
            if (this.isProcessing || this.operationQueue.length === 0) return;

            this.isProcessing = true;

            try {
                while (this.operationQueue.length > 0) {
                    const item = this.operationQueue.shift();
                    await this.processOperation(item);
                }
            } catch (error) {
                console.error('❌ Error processing queue:', error);
            } finally {
                this.isProcessing = false;
            }
        }

        async processOperation(item) {
            const { operation, resolve, reject, version } = item;

            try {
                // Check version conflict
                if (this.hasVersionConflict(version)) {
                    console.log('⚠️ Version conflict detected! Merging...');
                    const merged = await this.mergeWithConflict(operation);
                    resolve(merged);
                    return;
                }

                const pendingOps = this.getPendingOperations();

                // 🔥 FIX: Call transformOperation correctly
                const transformedOps = this.transformOperation(operation, pendingOps);
                const result = await this.executeOperation(transformedOps);
                this.addToHistory(transformedOps);
                this.documentVersion++;
                this.versionMap.set(this.documentVersion, Date.now());
                resolve(result);
            } catch (error) {
                console.error('❌ Operation failed:', error);
                reject(error);
            }
        }

        // ============================================================
        // VERSION MANAGEMENT
        // ============================================================

        hasVersionConflict(version) {
            const latestVersion = this.getLatestVersion();
            return version < latestVersion;
        }

        getLatestVersion() {
            if (this.versionMap.size === 0) return 0;
            return Math.max(...Array.from(this.versionMap.keys()));
        }

        getVersionTimestamp(version) {
            return this.versionMap.get(version) || 0;
        }

        // ============================================================
        // 🔥 TRANSFORM OPERATION - FIXED
        // ============================================================

        transformOperation(operation, concurrentOperations) {
            if (Array.isArray(operation)) {
                return operation.flatMap(op => this.transformOperation(op, concurrentOperations));
            }
            
            let transformed = [this.cloneOperation(operation)];

            if (!concurrentOperations || concurrentOperations.length === 0) {
                return transformed.length === 1 ? transformed[0] : transformed;
            }

            for (const concurrentOp of concurrentOperations) {
                transformed = transformed.flatMap(tOp => {
                    const result = this.transformPair(tOp, concurrentOp);
                    return Array.isArray(result) ? result : [result];
                });
            }

            return transformed.length === 1 ? transformed[0] : transformed;
        }

        transformPair(op1, op2) {
            if (!op1 || !op2) return this.cloneOperation(op1);

            // Handle table operations
            if (op1.isTableOperation || op2.isTableOperation) {
                return this.transformTableOperation(op1, op2);
            }

            // Handle full replace operations
            if (op1.isFullReplace || op2.isFullReplace) {
                return this.transformFullReplace(op1, op2);
            }

            // Text operations
            if (op1.type === 'insert' && op2.type === 'insert') {
                return this.transformInsertInsert(op1, op2);
            } else if (op1.type === 'delete' && op2.type === 'insert') {
                return this.transformDeleteInsert(op1, op2);
            } else if (op1.type === 'insert' && op2.type === 'delete') {
                return this.transformInsertDelete(op1, op2);
            } else if (op1.type === 'delete' && op2.type === 'delete') {
                return this.transformDeleteDelete(op1, op2);
            } else if (op1.type === 'replace') {
                return this.transformReplace(op1, op2);
            } else if (op2.type === 'replace') {
                const op2Delete = {
                    type: 'delete',
                    position: op2.position,
                    length: op2.oldText ? op2.oldText.length : 0,
                    id: op2.id
                };
                const op2Insert = {
                    type: 'insert',
                    position: op2.position,
                    text: op2.newText || '',
                    id: op2.id
                };
                let result = this.transformPair(op1, op2Delete);
                result = this.transformPair(result, op2Insert);
                return result;
            }

            return this.cloneOperation(op1);
        }

        transformTableOperation(op1, op2) {
            const result = this.cloneOperation(op1);

            // For table operations, preserve both
            if (op1.type === 'replace' && op2.type === 'replace') {
                if (op1.timestamp && op2.timestamp) {
                    if (op1.timestamp < op2.timestamp) {
                        return this.cloneOperation(op2);
                    }
                }
            }

            return result;
        }

        transformFullReplace(op1, op2) {
            // For full replace, keep the newer one
            const result = this.cloneOperation(op1);

            if (op1.timestamp && op2.timestamp) {
                if (op1.timestamp < op2.timestamp) {
                    return this.cloneOperation(op2);
                }
            }

            return result;
        }

        transformInsertInsert(op1, op2) {
            const result = this.cloneOperation(op1);

            if (op1.position <= op2.position) {
                if (op1.position === op2.position && op1.id < op2.id) {
                    result.position += op2.text.length;
                }
            } else {
                result.position += op2.text.length;
            }

            return result;
        }

        transformDeleteInsert(op1, op2) {
            const result = this.cloneOperation(op1);

            if (op1.position + op1.length <= op2.position) {
                // Delete before insert, no change
            } else if (op1.position >= op2.position) {
                // Delete after insert
                result.position += op2.text.length;
            } else {
                // Insert inside delete, split delete
                const del1 = { type: 'delete', position: op1.position, length: op2.position - op1.position, id: op1.id };
                const del2 = { type: 'delete', position: op2.position + op2.text.length - del1.length, length: op1.length - del1.length, id: op1.id };
                
                if (del1.length > 0 && del2.length > 0) return [del1, del2];
                if (del1.length > 0) return del1;
                if (del2.length > 0) return del2;
            }

            return result;
        }

        transformInsertDelete(op1, op2) {
            const result = this.cloneOperation(op1);

            if (op1.position <= op2.position) {
                // Insert before delete, no change
            } else {
                if (op2.position + op2.length <= op1.position) {
                    result.position -= op2.length;
                } else {
                    result.position = op2.position;
                }
            }

            return result;
        }

        transformDeleteDelete(op1, op2) {
            const result = this.cloneOperation(op1);

            const start1 = op1.position;
            const end1 = op1.position + op1.length;
            const start2 = op2.position;
            const end2 = op2.position + op2.length;

            const leftOverlap = Math.max(0, Math.min(start1, end2) - start2);
            const intersection = Math.max(0, Math.min(end1, end2) - Math.max(start1, start2));

            result.position = start1 - leftOverlap;
            result.length = op1.length - intersection;

            return result;
        }

        transformReplace(op1, op2) {
            const result = this.cloneOperation(op1);

            const deleteOp = {
                type: 'delete',
                position: op1.position,
                length: op1.oldText ? op1.oldText.length : 0,
                id: op1.id
            };

            const insertOp = {
                type: 'insert',
                position: op1.position,
                text: op1.newText || '',
                id: op1.id
            };

            const transformedDelete = this.transformPair(deleteOp, op2);
            const transformedInsert = this.transformPair(insertOp, op2);

            result.position = transformedDelete.position;
            result.oldText = op1.oldText;
            result.newText = transformedInsert.text;

            return result;
        }

        operationsOverlap(op1, op2) {
            if (!op1 || !op2) return false;

            if (op1.type === 'insert' && op2.type === 'insert') {
                return op1.position === op2.position;
            }

            const op1Start = op1.position || 0;
            const op1End = op1.type === 'delete' ?
                op1.position + (op1.length || 0) :
                op1.position + (op1.text ? op1.text.length : 0);

            const op2Start = op2.position || 0;
            const op2End = op2.type === 'delete' ?
                op2.position + (op2.length || 0) :
                op2.position + (op2.text ? op2.text.length : 0);

            return !(op1End <= op2Start || op2End <= op1Start);
        }

        // ============================================================
        // CONFLICT RESOLUTION WITH MERGE
        // ============================================================

        async mergeWithConflict(operation) {
            console.log('🔄 Merging conflicting operation...');

            const baseContent = this.getBaseContent();
            const localChanges = this.getLocalChanges();
            const remoteChange = operation.newText || operation.text || '';

            const isTable = this.hasComplexTable(baseContent) ||
                this.hasComplexTable(localChanges) ||
                this.hasComplexTable(remoteChange);

            let mergedContent;

            if (isTable) {
                mergedContent = this.threeWayMergeTable(baseContent, localChanges, remoteChange);
            } else {
                mergedContent = this.threeWayMergeText(baseContent, localChanges, remoteChange);
            }

            return {
                type: 'replace',
                position: 0,
                oldText: baseContent,
                newText: mergedContent,
                isFullReplace: true,
                isMerged: true,
                mergeTimestamp: Date.now(),
                id: this.generateOperationId(),
                timestamp: Date.now()
            };
        }

        smartThreeWayMerge(base, local, remote) {
            const isTable = this.hasTable(base) || this.hasTable(local) || this.hasTable(remote);
            if (isTable) {
                return this.threeWayMergeTable(base, local, remote);
            } else {
                return this.threeWayMergeText(base, local, remote);
            }
        }

        threeWayMergeTable(base, local, remote) {
            console.log('📊 Three-way merge for table...');

            if (local === base) return remote;
            if (remote === base) return local;

            // Parse all three versions
            const baseDoc = this.parseHTML(base);
            const localDoc = this.parseHTML(local);
            const remoteDoc = this.parseHTML(remote);

            const baseTables = baseDoc.querySelectorAll('table');
            const localTables = localDoc.querySelectorAll('table');
            const remoteTables = remoteDoc.querySelectorAll('table');

            // If table structure changed differently, use latest
            if (baseTables.length !== localTables.length ||
                baseTables.length !== remoteTables.length) {
                return this.getLatestContent(local, remote);
            }

            // Merge table by table
            const mergedHTML = this.mergeTables(base, local, remote);
            
            console.log('--- 3-WAY MERGE TABLE DEBUG ---');
            console.log('BASE A:', (this.parseHTML(base).querySelectorAll('td')[0] || {}).innerHTML);
            console.log('LOCAL A:', (this.parseHTML(local).querySelectorAll('td')[0] || {}).innerHTML);
            console.log('REMOTE A:', (this.parseHTML(remote).querySelectorAll('td')[0] || {}).innerHTML);
            console.log('MERGED A:', (this.parseHTML(mergedHTML).querySelectorAll('td')[0] || {}).innerHTML);
            console.log('BASE B:', (this.parseHTML(base).querySelectorAll('td')[1] || {}).innerHTML);
            console.log('LOCAL B:', (this.parseHTML(local).querySelectorAll('td')[1] || {}).innerHTML);
            console.log('REMOTE B:', (this.parseHTML(remote).querySelectorAll('td')[1] || {}).innerHTML);
            console.log('MERGED B:', (this.parseHTML(mergedHTML).querySelectorAll('td')[1] || {}).innerHTML);
            
            return mergedHTML;
        }

        mergeTables(baseHTML, localHTML, remoteHTML) {
            const baseDoc = this.parseHTML(baseHTML);
            const localDoc = this.parseHTML(localHTML);
            const remoteDoc = this.parseHTML(remoteHTML);

            const baseTables = baseDoc.querySelectorAll('table');
            const localTables = localDoc.querySelectorAll('table');
            const remoteTables = remoteDoc.querySelectorAll('table');

            const mergedTables = [];

            for (let i = 0; i < Math.min(baseTables.length, localTables.length, remoteTables.length); i++) {
                const baseTable = baseTables[i];
                const localTable = localTables[i];
                const remoteTable = remoteTables[i];

                const mergedTable = this.mergeSingleTable(baseTable, localTable, remoteTable);
                mergedTables.push(mergedTable);
            }

            let result = this.reconstructHTML(baseHTML, localHTML, remoteHTML, mergedTables);
            return result;
        }

        mergeSingleTable(baseTable, localTable, remoteTable) {
            const baseRows = baseTable.querySelectorAll('tr');
            const localRows = localTable.querySelectorAll('tr');
            const remoteRows = remoteTable.querySelectorAll('tr');

            const maxRows = Math.max(baseRows.length, localRows.length, remoteRows.length);

            const mergedTable = baseTable.cloneNode(false);
            const tbody = document.createElement('tbody');

            for (let i = 0; i < maxRows; i++) {
                const baseRow = baseRows[i] || null;
                const localRow = localRows[i] || null;
                const remoteRow = remoteRows[i] || null;

                const mergedRow = this.mergeRow(baseRow, localRow, remoteRow);
                if (mergedRow) {
                    tbody.appendChild(mergedRow);
                }
            }

            mergedTable.appendChild(tbody);
            return mergedTable;
        }

        mergeRow(baseRow, localRow, remoteRow) {
            if (!baseRow) {
                return localRow || remoteRow ? (localRow || remoteRow).cloneNode(true) : null;
            }

            const baseCells = baseRow.querySelectorAll('td, th');
            const localCells = localRow ? localRow.querySelectorAll('td, th') : [];
            const remoteCells = remoteRow ? remoteRow.querySelectorAll('td, th') : [];

            const maxCells = Math.max(baseCells.length, localCells.length, remoteCells.length);

            const mergedRow = baseRow.cloneNode(false);

            for (let i = 0; i < maxCells; i++) {
                const baseCell = baseCells[i] || null;
                const localCell = localCells[i] || null;
                const remoteCell = remoteCells[i] || null;

                const mergedCell = this.mergeCell(baseCell, localCell, remoteCell);
                if (mergedCell) {
                    mergedRow.appendChild(mergedCell);
                }
            }

            return mergedRow;
        }

        mergeCell(baseCell, localCell, remoteCell) {
            if (!baseCell) {
                return localCell || remoteCell ? (localCell || remoteCell).cloneNode(true) : null;
            }

            const baseContent = baseCell ? baseCell.innerHTML : '';
            const localContent = localCell ? localCell.innerHTML : '';
            const remoteContent = remoteCell ? remoteCell.innerHTML : '';
            
            const normalize = (html) => {
                let text = html.replace(/<[^>]+>/g, '');
                text = text.replace(/(&nbsp;)/gi, ' ');
                return text.replace(/\s+/g, ' ');
            };

            if (normalize(localContent) === normalize(baseContent)) {
                const cell = baseCell.cloneNode(true);
                cell.innerHTML = remoteContent;
                return cell;
            }

            if (remoteContent === baseContent) {
                const cell = baseCell.cloneNode(true);
                cell.innerHTML = localContent;
                return cell;
            }

            const mergedContent = this.threeWayMergeText(baseContent, localContent, remoteContent);

            const cell = baseCell.cloneNode(true);
            cell.innerHTML = mergedContent;
            return cell;
        }

        threeWayMergeText(base, local, remote) {
            if (local === base) return remote;
            if (remote === base) return local;

            const baseTokens = this.tokenizeHTML(base);
            const localTokens = this.tokenizeHTML(local);
            const remoteTokens = this.tokenizeHTML(remote);
            
            console.log('--- threeWayMergeText TOKENS ---');
            console.log('BASE:', JSON.stringify(baseTokens));
            console.log('LOCAL:', JSON.stringify(localTokens));
            console.log('REMOTE:', JSON.stringify(remoteTokens));

            const lOps = this.myersDiff(baseTokens, localTokens);
            const rOps = this.myersDiff(baseTokens, remoteTokens);

            const localInserts = {};
            const localDeletes = new Set();
            let bIndex = 0;
            for (const op of lOps) {
                if (op.type === 'equal') {
                    bIndex++;
                } else if (op.type === 'delete') {
                    localDeletes.add(bIndex);
                    bIndex++;
                } else if (op.type === 'insert') {
                    if (!localInserts[bIndex]) localInserts[bIndex] = [];
                    localInserts[bIndex].push(op.text);
                }
            }

            const remoteInserts = {};
            const remoteDeletes = new Set();
            bIndex = 0;
            for (const op of rOps) {
                if (op.type === 'equal') {
                    bIndex++;
                } else if (op.type === 'delete') {
                    remoteDeletes.add(bIndex);
                    bIndex++;
                } else if (op.type === 'insert') {
                    if (!remoteInserts[bIndex]) remoteInserts[bIndex] = [];
                    remoteInserts[bIndex].push(op.text);
                }
            }

            let mergedTokens = [];
            for (let i = 0; i <= baseTokens.length; i++) {
                const lIns = localInserts[i] || [];
                const rIns = remoteInserts[i] || [];

                if (lIns.length > 0 && rIns.length > 0) {
                    if (lIns.join('') === rIns.join('')) {
                        mergedTokens.push(...lIns);
                    } else {
                        mergedTokens.push(...rIns);
                        mergedTokens.push(...lIns);
                    }
                } else {
                    mergedTokens.push(...rIns);
                    mergedTokens.push(...lIns);
                }

                if (i < baseTokens.length) {
                    if (!localDeletes.has(i) && !remoteDeletes.has(i)) {
                        mergedTokens.push(baseTokens[i]);
                    }
                }
            }

            const parser = new DOMParser();
            const doc = parser.parseFromString(mergedTokens.join(''), 'text/html');
            return doc.body.innerHTML;
        }

        detectConflict(diff1, diff2) {
            for (const d2 of diff2) {
                const start1 = diff1.position;
                const end1 = diff1.type === 'delete' ? diff1.position + diff1.length : diff1.position + (diff1.text ? diff1.text.length : 0);
                const start2 = d2.position;
                const end2 = d2.type === 'delete' ? d2.position + d2.length : d2.position + (d2.text ? d2.text.length : 0);

                if (!(end1 <= start2 || end2 <= start1)) {
                    return true;
                }
            }
            return false;
        }

        resolveTextConflict(content, diff, otherDiffs, offset) {
            const pos = diff.position + offset;

            if (diff.type === 'delete') {
                const insertText = this.getConflictingInsert(otherDiffs, diff.position);
                if (insertText) {
                    return content.substring(0, pos) + insertText + content.substring(pos);
                } else {
                    const len = Math.min(diff.length, content.length - pos);
                    return content.substring(0, pos) + content.substring(pos + len);
                }
            } else if (diff.type === 'insert') {
                if (pos >= 0 && pos <= content.length) {
                    return content.substring(0, pos) + diff.text + content.substring(pos);
                }
            }

            return content;
        }

        getConflictingInsert(diffs, position) {
            for (const diff of diffs) {
                if (diff.type === 'insert' && diff.position === position) {
                    return diff.text;
                }
            }
            return null;
        }

        getLatestContent(content1, content2) {
            return content2;
        }

        reconstructHTML(baseHTML, localHTML, remoteHTML, mergedTables) {
            // Mask tables with placeholders so Myers diff doesn't corrupt complex HTML tags
            let bIndex = 0, lIndex = 0, rIndex = 0;
            const bMasked = baseHTML.replace(/<table[\s\S]*?<\/table>/gi, () => `__TABLE_MERGE_${bIndex++}__`);
            const lMasked = localHTML.replace(/<table[\s\S]*?<\/table>/gi, () => `__TABLE_MERGE_${lIndex++}__`);
            const rMasked = remoteHTML.replace(/<table[\s\S]*?<\/table>/gi, () => `__TABLE_MERGE_${rIndex++}__`);

            // Merge the full text (with placeholders) first to preserve non-table edits
            let result = this.threeWayMergeText(bMasked, lMasked, rMasked);

            // Restore the beautifully merged tables back into their placeholders
            for (let i = 0; i < mergedTables.length; i++) {
                const tableHTML = mergedTables[i].outerHTML;
                result = result.replace(`__TABLE_MERGE_${i}__`, tableHTML);
            }

            // Cleanup any orphaned placeholders
            result = result.replace(/__TABLE_MERGE_\d+__/g, '');

            return result;
        }

        // ============================================================
        // TABLE DETECTION & EXTRACTION
        // ============================================================

        hasComplexTable(html) {
            if (!html) return false;

            const patterns = [
                /<table[\s\S]*?>/i,
                /<thead[\s\S]*?>/i,
                /<tbody[\s\S]*?>/i,
                /<colgroup[\s\S]*?>/i,
                /rowspan\s*=/i,
                /colspan\s*=/i
            ];

            let hasTable = false;
            let hasComplex = false;

            for (const pattern of patterns) {
                if (pattern.test(html)) {
                    if (pattern === patterns[0]) {
                        hasTable = true;
                    } else {
                        hasComplex = true;
                    }
                }
            }

            return hasTable && hasComplex;
        }

        hasTable(html) {
            if (!html) return false;
            return /<table[\s\S]*?>/i.test(html);
        }

        extractTables(html) {
            const tables = [];
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            const tableElements = doc.querySelectorAll('table');
            tableElements.forEach((table, index) => {
                tables.push({
                    index: index,
                    html: table.outerHTML,
                    rows: table.querySelectorAll('tr').length,
                    cols: table.querySelectorAll('tr:first-child td, tr:first-child th').length,
                    hasThead: !!table.querySelector('thead'),
                    hasTbody: !!table.querySelector('tbody'),
                    hasColgroup: !!table.querySelector('colgroup'),
                    hasRowspan: !!table.querySelector('[rowspan]'),
                    hasColspan: !!table.querySelector('[colspan]')
                });
            });

            return tables;
        }

        removeTables(html) {
            if (!html) return '';
            return html.replace(/<table[\s\S]*?<\/table>/gi, '');
        }

        // ============================================================
        // SMART DIFF
        // ============================================================

        computeDiff(oldText, newText) {
            if (!oldText) oldText = '';
            if (!newText) newText = '';
            if (oldText === newText) return [];

            // Check for complex table
            if (this.hasComplexTable(oldText) || this.hasComplexTable(newText)) {
                console.log('📊 Complex table detected! Using full replace with version.');
                return [{
                    type: 'replace',
                    position: 0,
                    oldText: oldText,
                    newText: newText,
                    isTableOperation: true,
                    isFullReplace: true,
                    version: this.documentVersion,
                    id: this.generateOperationId(),
                    timestamp: Date.now()
                }];
            }

            // Check for simple table
            if (this.hasTable(oldText) || this.hasTable(newText)) {
                console.log('📊 Simple table detected, using table-aware merge...');
                try {
                    const result = this.computeTableAwareDiff(oldText, newText);
                    if (result && result.length > 0) {
                        return result;
                    }
                } catch (e) {
                    console.warn('⚠️ Table-aware diff failed, using full replace:', e);
                }
                return [{
                    type: 'replace',
                    position: 0,
                    oldText: oldText,
                    newText: newText,
                    isTableOperation: true,
                    isFullReplace: true,
                    version: this.documentVersion,
                    id: this.generateOperationId(),
                    timestamp: Date.now()
                }];
            }

            // Plain text diff
            return this.computeTextDiff(oldText, newText);
        }

        computeTableAwareDiff(oldHTML, newHTML) {
            return [{
                type: 'replace',
                position: 0,
                oldText: oldHTML,
                newText: newHTML,
                isTableOperation: true,
                isFullReplace: true,
                version: this.documentVersion,
                id: this.generateOperationId(),
                timestamp: Date.now()
            }];
        }

        // ============================================================
        // TEXT DIFF
        // ============================================================

        computeTextDiff(oldText, newText) {
            if (oldText === newText) return [];

            const oldTokens = this.tokenizeHTML(oldText);
            const newTokens = this.tokenizeHTML(newText);
            
            const rawOps = this.myersDiff(oldTokens, newTokens);
            
            const operations = [];
            let charPos = 0;
            let shift = 0;
            let chunk = [];

            const processChunk = (chunkOps, pos) => {
                let delText = '';
                let insText = '';
                for (const op of chunkOps) {
                    if (op.type === 'delete') delText += op.text;
                    if (op.type === 'insert') insText += op.text;
                }
                const actualPos = pos + shift;
                if (delText.length > 0) {
                    operations.push({
                        type: 'delete',
                        position: actualPos,
                        length: delText.length,
                        text: delText
                    });
                    shift -= delText.length;
                }
                if (insText.length > 0) {
                    operations.push({
                        type: 'insert',
                        position: actualPos,
                        text: insText
                    });
                    shift += insText.length;
                }
            };

            for (const op of rawOps) {
                if (op.type === 'equal') {
                    if (chunk.length > 0) {
                        processChunk(chunk, charPos);
                        chunk = [];
                    }
                    charPos += op.text.length;
                } else {
                    chunk.push(op);
                }
            }
            if (chunk.length > 0) {
                processChunk(chunk, charPos);
            }

            return operations;
        }

        tokenizeHTML(html) {
            if (!html) return [];
            return html.split(/(<[^>]+>|\b\w+\b|\s+|[^\w\s<>]+)/).filter(Boolean);
        }

        myersDiff(oldArr, newArr) {
            const N = oldArr.length;
            const M = newArr.length;
            const max = N + M;
            let v = { 1: 0 };
            const trace = [];

            for (let d = 0; d <= max; d++) {
                trace.push(Object.assign({}, v));
                for (let k = -d; k <= d; k += 2) {
                    let x;
                    if (k === -d || (k !== d && (v[k - 1] || 0) < (v[k + 1] || 0))) {
                        x = v[k + 1] || 0;
                    } else {
                        x = (v[k - 1] || 0) + 1;
                    }
                    let y = x - k;
                    while (x < N && y < M && oldArr[x] === newArr[y]) {
                        x++;
                        y++;
                    }
                    v[k] = x;
                    if (x >= N && y >= M) {
                        return this.backtrackMyers(trace, oldArr, newArr, x, y);
                    }
                }
            }
            return [];
        }

        backtrackMyers(trace, oldArr, newArr, x, y) {
            const ops = [];
            for (let d = trace.length - 1; d >= 0; d--) {
                const v = trace[d];
                const k = x - y;
                let prev_k;
                if (k === -d || (k !== d && (v[k - 1] || 0) < (v[k + 1] || 0))) {
                    prev_k = k + 1;
                } else {
                    prev_k = k - 1;
                }
                const prev_x = v[prev_k] || 0;
                const prev_y = prev_x - prev_k;

                while (x > prev_x && y > prev_y) {
                    ops.unshift({ type: 'equal', text: oldArr[x - 1] });
                    x--; y--;
                }
                if (d > 0) {
                    if (x === prev_x) {
                        ops.unshift({ type: 'insert', text: newArr[y - 1] });
                        y--;
                    } else {
                        ops.unshift({ type: 'delete', text: oldArr[x - 1] });
                        x--;
                    }
                }
            }
            return ops;
        }

        // ============================================================
        // UTILITY
        // ============================================================

        parseHTML(html) {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            return doc.body;
        }

        getBaseContent() {
            return this.operationHistory.length > 0 ?
                this.operationHistory[this.operationHistory.length - 1].newText || '' : '';
        }

        getLocalChanges() {
            const pending = this.getPendingOperations();
            if (pending.length === 0) return '';

            let content = this.getBaseContent();
            for (const op of pending) {
                if (op.type === 'insert') {
                    content = content.substring(0, op.position) + (op.text || '') + content.substring(op.position);
                } else if (op.type === 'delete') {
                    const pos = op.position;
                    const len = Math.min(op.length || 1, content.length - pos);
                    content = content.substring(0, pos) + content.substring(pos + len);
                }
            }
            return content;
        }

        getPendingOperations() {
            // FIX: markSynced immediately clears pending operations, breaking the OT transform.
            // We must return recent local operations (e.g. last 3 seconds) so concurrent 
            // incoming remote operations can be transformed against them and shift indices correctly.
            const recentThreshold = Date.now() - 3000;
            return this.operationHistory
                .filter(op => op.timestamp >= recentThreshold)
                .slice(-50);
        }

        addToHistory(operation) {
            this.operationHistory.push({
                ...operation,
                synced: false,
                version: this.documentVersion,
                timestamp: Date.now()
            });

            if (this.operationHistory.length > this.maxHistory) {
                this.operationHistory = this.operationHistory.slice(-this.maxHistory);
            }
        }

        markSynced(operationId) {
            const op = this.operationHistory.find(o => o.id === operationId);
            if (op) op.synced = true;
        }

        cloneOperation(op) {
            return JSON.parse(JSON.stringify(op));
        }

        generateOperationId() {
            this.opCounter++;
            return 'op_' + Date.now() + '_' + this.opCounter;
        }

        executeOperation(operation) {
            return Promise.resolve(operation);
        }

        clear() {
            this.operationQueue = [];
            this.operationHistory = [];
            this.documentVersion = 0;
            this.isProcessing = false;
            this.versionMap.clear();
            this.conflictCache.clear();
        }

        getStatus() {
            return {
                queueLength: this.operationQueue.length,
                historyLength: this.operationHistory.length,
                version: this.documentVersion,
                isProcessing: this.isProcessing,
                pendingOps: this.getPendingOperations().length
            };
        }
    }

    window.OTEngine = OTEngine;
    console.log('✅ OT Engine with Versioned Merge loaded');

})(window);