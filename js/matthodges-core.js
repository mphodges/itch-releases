/**
 * matthodges-core.js
 * * Shared library for common application logic across multiple Canvas/Web/APK projects.
 * Handles environment detection, app updates, safe storage, file I/O, and external links.
 * * ⚠️ CRITICAL DEPLOYMENT RULE ⚠️
 * The CDN link (jsDelivr) should ONLY be used as a fallback for the Canvas/AI preview environment.
 * Live production apps (Itch.io, Android APKs) MUST bundle and use a tested local copy of this file
 * (e.g., `<script src="assets/js/matthodges-core.js"></script>`). 
 * * This ensures apps outside Canvas always default to their tested versions and prevents 
 * active development changes from silently breaking stable, deployed apps.
 * * Usage:
 * Include this script before your main application logic using the local-first fallback pattern.
 * All functions are accessed via the global `MHCore` object.
 */

(function() {
    // Prevent double-initialization
    if (window.MHCore) return;

    const MHCore = {
        
        // --- 1. ENVIRONMENT DETECTION ---
        
        /**
         * Checks if the app is running in a packaged mobile wrapper (Cordova/Capacitor)
         * or locally via the file:// protocol (typical for unhosted APK testing).
         * @returns {boolean}
         */
        isApk: function() {
            return !!(window.Capacitor || window.cordova || window.location.protocol === 'file:');
        },

        /**
         * Checks if the app is running inside an iframe (like the Canvas environment).
         * Useful for disabling features that don't work in sandboxed previews.
         * @returns {boolean}
         */
        isCanvas: function() {
            try {
                return window.self !== window.top;
            } catch (e) {
                // If accessing window.top throws a cross-origin error, we are in an iframe.
                return true;
            }
        },

        // --- 2. UPDATE CHECKER ---

        /**
         * Checks the itch-releases repo for a new version.
         * Expects a JSON file at: https://raw.githubusercontent.com/mphodges/itch-releases/main/{appName}.json
         * * @param {string} appName - The project name (e.g., 'jelly-merge', 'flow')
         * @param {string} currentVersion - The current APP_VERSION string
         * @param {Object} callbacks - UI hooks: { onUpdateAvailable: (url, notes, version) => void }
         */
        checkForUpdates: async function(appName, currentVersion, callbacks) {
            if (!this.isApk()) {
                this.log(`[MHCore] Update check bypassed (Not an APK environment)`);
                return;
            }

            try {
                // Bust cache with timestamp
                const manifestUrl = `https://raw.githubusercontent.com/mphodges/itch-releases/main/${appName}.json?t=${Date.now()}`;
                const response = await fetch(manifestUrl);
                
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                const data = await response.json();
                
                // Allow users to skip a specific version via localStorage
                const skipKey = `${appName}-skipped-version`;
                const skippedVersion = this.storage.get(skipKey, null);

                if (data.version && data.version !== currentVersion && data.version !== skippedVersion) {
                    this.log(`[MHCore] Update available: ${currentVersion} -> ${data.version}`);
                    
                    if (callbacks && typeof callbacks.onUpdateAvailable === 'function') {
                        // Provide a helper function to skip this specific update
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

        /**
         * Safely opens a URL. In Cordova/APK it forces the external system browser.
         * On the web, it opens in a new tab.
         * @param {string} url - The URL to open
         */
        openLink: function(url) {
            if (window.cordova) {
                window.open(url, '_system');
            } else {
                window.open(url, '_blank');
            }
        },

        // --- 4. CONFIG / DATA EXPORT ---

        /**
         * Triggers a browser download of a JSON file containing the provided data.
         * @param {string} filename - The name of the file (e.g., 'flow-config.json')
         * @param {Object|Array} dataObject - The Javascript object to stringify and export
         */
        exportData: function(filename, dataObject) {
            try {
                const dataStr = JSON.stringify(dataObject, null, 2);
                const blob = new Blob([dataStr], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                
                // Cleanup
                setTimeout(() => {
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                }, 0);
                this.log(`[MHCore] Exported data to ${filename}`);
            } catch (err) {
                this.log(`[MHCore] Export failed: ${err.message}`);
                console.error("Export Error:", err);
            }
        },

        // --- 5. CONFIG / DATA IMPORT ---

        /**
         * Reads a local File object (from an <input type="file">) and parses it as JSON.
         * @param {File} file - The file object from an input event
         * @returns {Promise<Object>} Resolves with the parsed JSON data
         */
        importData: function(file) {
            return new Promise((resolve, reject) => {
                if (!file) {
                    return reject(new Error("No file provided"));
                }
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
            });
        },

        // --- 6. SAFE LOCAL STORAGE ---
        
        storage: {
            /**
             * Safely retrieves a parsed JSON object from localStorage.
             * @param {string} key 
             * @param {*} defaultValue - Returned if key doesn't exist or localStorage is disabled
             */
            get: function(key, defaultValue = null) {
                try {
                    const item = localStorage.getItem(key);
                    return item ? JSON.parse(item) : defaultValue;
                } catch (e) {
                    MHCore.log(`[MHCore] Storage GET failed for ${key}`);
                    return defaultValue;
                }
            },
            /**
             * Safely saves a JSON object to localStorage.
             * @param {string} key 
             * @param {*} value 
             */
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
        
        /**
         * Logs a message to both the console and an internal array for DevUI viewing.
         */
        log: function(msg, data = null) {
            const timestamp = new Date().toLocaleTimeString();
            const logEntry = `[${timestamp}] ${msg}`;
            this._logs.push(logEntry);
            
            // Keep memory footprint small
            if (this._logs.length > 100) this._logs.shift(); 
            
            if (data) {
                console.log(logEntry, data);
            } else {
                console.log(logEntry);
            }
        },

        getLogs: function() {
            return [...this._logs];
        },
        
        clearLogs: function() {
            this._logs = [];
        }
    };

    // Expose to global scope
    window.MHCore = MHCore;

})();
