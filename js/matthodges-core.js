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
            return !!(window.Capacitor || window.cordova || window.location.protocol === 'file:');
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
         * Tries the modern Desktop OS File Picker first (maps to Google Drive natively).
         * Falls back to a standard browser download for Canvas and Mobile APKs.
         */
        exportData: async function(filename, dataObject) {
            try {
                const dataStr = JSON.stringify(dataObject, null, 2);

                // 1. Try Modern Web File System API (Desktop OS File Picker)
                // We disable this in Canvas and APKs because it requires top-level secure contexts
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
                        return false; // User cancelled the dialog
                    }
                }

                // 2. Universal Fallback (Canvas / Cordova / Older Browsers)
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
