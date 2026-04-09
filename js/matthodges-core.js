/**
 * matthodges-core.js
 * * Shared library for common application logic across multiple Canvas/Web/APK projects.
 * Handles environment detection, app updates, safe storage, file I/O, and external links.
 * * ⚠️ CRITICAL DEPLOYMENT RULE ⚠️
 * The CDN link (jsDelivr) should ONLY be used as a fallback for the Canvas/AI preview environment.
 * Live production apps (Itch.io, Android APKs) MUST bundle and use a tested local copy of this file
 * (e.g., `<script src="assets/js/matthodges-core.js"></script>`). 
 * * Usage:
 * Include this script before your main application logic using the local-first fallback pattern.
 * All functions are accessed via the global `MHCore` object.
 */

(function() {
    // Prevent double-initialization
    if (window.MHCore) return;

    const MHCore = {
        
        // --- 1. ENVIRONMENT DETECTION ---
        
        isApk: function() {
            const hasFramework = !!(window.Capacitor || window.cordova || window.location.protocol === 'file:');
            const isAndroidWebView = /wv|android.*version\/[\d.]+.*chrome/i.test(navigator.userAgent);
            return hasFramework || isAndroidWebView;
        },

        isCanvas: function() {
            try {
                return window.self !== window.top;
            } catch (e) {
                return true;
            }
        },

        // --- 2. UPDATE CHECKER ---

        checkForUpdates: async function(appName, currentVersion, callbacks) {
            if (!this.isApk()) {
                this.log(`[MHCore] Update check bypassed (Not an APK environment)`);
                return;
            }

            try {
                const manifestUrl = `https://raw.githubusercontent.com/mphodges/itch-releases/main/releases/${appName}.json?t=${Date.now()}`;
                const response = await fetch(manifestUrl);
                
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                const data = await response.json();
                
                const skipKey = `${appName}-skipped-version`;
                const skippedVersion = this.storage.get(skipKey, null);

                if (data.version && data.version !== currentVersion && data.version !== skippedVersion) {
                    this.log(`[MHCore] Update available: ${currentVersion} -> ${data.version}`);
                    
                    if (callbacks && typeof callbacks.onUpdateAvailable === 'function') {
                        const skipFunc = () => this.storage.set(skipKey, data.version);
                        callbacks.onUpdateAvailable(data.url, data.notes, data.version, skipFunc);
                    }
                } else {
                    this.log(`[MHCore] App is up to date (${currentVersion}) or update skipped.`);
                }
            } catch (err) {
                this.log(`[MHCore] Failed to check for updates: ${err.message}`);
            }
        },

        // --- 3. EXTERNAL LINKS ---

        openLink: function(url) {
            if (window.cordova) {
                window.open(url, '_system');
            } else {
                window.open(url, '_blank');
            }
        },

        // --- 4. CONFIG / DATA EXPORT ---

        /**
         * Exports data to a JSON file.
         * 1. Tries Modern Desktop File Picker.
         * 2. Tries Capacitor Native Filesystem/Share (for APKs).
         * 3. Tries Web Share API.
         * 4. Falls back to standard <a download> (or clipboard for unsupported WebViews).
         */
        exportData: async function(filename, dataObject) {
            try {
                const dataStr = JSON.stringify(dataObject, null, 2);

                // 1. Try Modern Web File System API (Desktop OS File Picker)
                if (window.showSaveFilePicker && !this.isCanvas() && !this.isApk()) {
                    try {
                        const handle = await window.showSaveFilePicker({
                            suggestedName: filename,
                            types: [{ description: 'JSON File', accept: {'application/json': ['.json']} }]
                        });
                        const writable = await handle.createWritable();
                        await writable.write(dataStr);
                        await writable.close();
                        this.log(`[MHCore] Exported via native OS picker to ${handle.name}`);
                        return true;
                    } catch (err) {
                        if (err.name !== 'AbortError') throw err;
                        return false; 
                    }
                }

                // 2. Capacitor Native Plugins (The correct way for Android APKs)
                if (window.Capacitor && window.Capacitor.Plugins.Filesystem && window.Capacitor.Plugins.Share) {
                    try {
                        const { Filesystem, Share } = window.Capacitor.Plugins;
                        // Write to device temporary cache directory
                        const writeResult = await Filesystem.writeFile({
                            path: filename,
                            data: dataStr,
                            directory: 'CACHE',
                            encoding: 'utf8'
                        });
                        
                        // Trigger native share sheet with the file URI
                        await Share.share({
                            title: 'Export ' + filename,
                            url: writeResult.uri,
                            dialogTitle: 'Save Export'
                        });
                        
                        this.log(`[MHCore] Exported via Capacitor Share: ${writeResult.uri}`);
                        return true;
                    } catch (err) {
                        this.log(`[MHCore] Capacitor File/Share failed: ${err.message}`);
                        // Fall through
                    }
                }

                // 3. Web Share API
                try {
                    if (navigator.share) {
                        const file = new File([dataStr], filename, { type: 'application/json' });
                        
                        // Try file share first
                        if (navigator.canShare && navigator.canShare({ files: [file] })) {
                            await navigator.share({ files: [file], title: filename });
                            this.log(`[MHCore] Exported via native Web Share API (File)`);
                            return true;
                        }
                        // Fallback to raw text share if files aren't supported by this WebView
                        else if (navigator.canShare && navigator.canShare({ text: dataStr })) {
                            await navigator.share({ title: filename, text: dataStr });
                            this.log(`[MHCore] Exported via native Web Share API (Text)`);
                            return true;
                        }
                    }
                } catch (err) {
                    if (err.name === 'AbortError') return false; 
                    this.log(`[MHCore] Web Share failed: ${err.message}`);
                }

                // 4. Universal Fallback
                if (this.isApk()) {
                    // Android WebView silently swallows Anchor downloads. 
                    // If we made it here, Capacitor plugins are missing. Fallback to clipboard so it's not a NOOP.
                    try {
                        await navigator.clipboard.writeText(dataStr);
                        alert(`File download requires Capacitor Filesystem plugins.\n\nYour export data has been copied to your clipboard instead.`);
                        return true;
                    } catch (e) {
                        alert("Export failed in this environment. Unable to access clipboard.");
                        return false;
                    }
                }

                // Standard Web browser download
                const blob = new Blob([dataStr], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
                
                this.log(`[MHCore] Exported data via download to ${filename}`);
                return true;
            } catch (err) {
                this.log(`[MHCore] Export failed: ${err.message}`);
                console.error("Export Error:", err);
                return false;
            }
        },

        // --- 5. CONFIG / DATA IMPORT ---

        /**
         * Opens an OS file picker to select and parse a JSON file.
         * Works natively on Desktop, Canvas, and Mobile WebViews without plugins.
         */
        importData: async function() {
            return new Promise(async (resolve, reject) => {
                
                // 1. Try Modern Web File System API (Desktop OS File Picker)
                if (window.showOpenFilePicker && !this.isCanvas() && !this.isApk()) {
                    try {
                        const [handle] = await window.showOpenFilePicker({
                            types: [{ description: 'JSON File', accept: {'application/json': ['.json']} }],
                            multiple: false
                        });
                        const file = await handle.getFile();
                        const text = await file.text();
                        this.log(`[MHCore] Imported via native OS picker: ${file.name}`);
                        return resolve(JSON.parse(text));
                    } catch (err) {
                        if (err.name === 'AbortError') return reject(new Error("User cancelled"));
                        // Fall through to fallback if API fails for other reasons
                    }
                }

                // 2. Universal Fallback (Works magically in Cordova, Web, and Canvas)
                // Creating a hidden file input and clicking it triggers the native mobile file picker
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json,application/json';
                
                input.onchange = (e) => {
                    const file = e.target.files[0];
                    if (!file) return reject(new Error("No file selected"));
                    
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        try {
                            const parsed = JSON.parse(e.target.result);
                            this.log(`[MHCore] Successfully imported data from ${file.name}`);
                            resolve(parsed);
                        } catch (err) {
                            this.log(`[MHCore] Failed to parse JSON from ${file.name}`);
                            reject(new Error("Invalid JSON file"));
                        }
                    };
                    reader.onerror = () => reject(new Error("Failed to read file"));
                    reader.readAsText(file);
                };
                
                input.click(); // Trigger the OS dialog
            });
        },

        // --- 6. SAFE LOCAL STORAGE ---
        
        storage: {
            get: function(key, defaultValue = null) {
                try {
                    const item = localStorage.getItem(key);
                    return item ? JSON.parse(item) : defaultValue;
                } catch (e) {
                    MHCore.log(`[MHCore] Storage GET failed for ${key}`);
                    return defaultValue;
                }
            },
            set: function(key, value) {
                try {
                    localStorage.setItem(key, JSON.stringify(value));
                } catch (e) {
                    MHCore.log(`[MHCore] Storage SET failed for ${key} (Quota exceeded or disabled)`);
                }
            }
        },

        // --- 7. DEVELOPER LOGGING ---
        
        _logs: [],
        
        log: function(msg, data = null) {
            const timestamp = new Date().toLocaleTimeString();
            const logEntry = `[${timestamp}] ${msg}`;
            this._logs.push(logEntry);
            if (this._logs.length > 100) this._logs.shift(); 
            if (data) { console.log(logEntry, data); } else { console.log(logEntry); }
        },

        getLogs: function() { return [...this._logs]; },
        clearLogs: function() { this._logs = []; }
    };

    window.MHCore = MHCore;
})();
