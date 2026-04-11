/**
 * ============================================================================
 * MHCore (Matt Hodges Core Library)
 * ============================================================================
 * A shared, reusable utility library for Hybrid Web Applications (Canvas, Itch.io, APK).
 * * CORE FEATURES:
 * 1. Environment Detection: Identifies Web, Canvas/Iframe, and APK WebViews.
 * 2. Sovereign Cloud Sync: Total-State Firestore Sync with conflict resolution.
 * 3. File I/O: Export/Import JSON gracefully across Desktop, Web, and Native.
 * 4. Safe Storage: Resilient localStorage wrapper (handles Incognito quotas).
 * 5. Update Checker: Polls GitHub for APK releases.
 * * ⚠️ CRITICAL DEPLOYMENT RULE ⚠️
 * Live production apps (Itch.io, Android APKs) MUST bundle and use a tested local 
 * copy of this file (e.g., `<script src="assets/js/matthodges-core.js"></script>`). 
 * ============================================================================
 */

// Firebase module references. 
// Loaded dynamically in `sync.connect()` so offline apps don't waste bandwidth.
let fbApp, fbAuth, fbFirestore;

(function() {
    // Prevent double-initialization if the script is loaded twice
    if (window.MHCore) return;

    // --- Internal Sync State Variables ---
    let db, auth, user, activeVaultId, activeAppId, unsubscribeSnapshot;
    let isConnected = false;
    let memLastSynced = 0; // RAM isolation to prevent multi-tab cross-talk

    const MHCore = {
        LIB_VERSION: "1.1.3",
        verbosity: 1, // 0 = Critical/Errors, 1 = Standard Sync, 2 = Verbose Engine Diagnostics
        
        // ====================================================================
        // 1. ENVIRONMENT DETECTION
        // ====================================================================
        
        /**
         * Detects if the app is running as a packaged Android/iOS application.
         * Used to conditionally route external links and alter file I/O behavior, 
         * as WebViews block standard <a> tag downloads and window.open().
         * * @returns {boolean} True if running inside Capacitor, Cordova, or a recognized WebView.
         */
        isApk: function() {
            const hasFramework = !!(window.Capacitor || window.cordova || window.location.protocol === 'file:');
            const isAndroidLocalhost = /android/i.test(navigator.userAgent) && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
            const isAndroidWebView = /wv|android.*version\/[\d.]+.*chrome/i.test(navigator.userAgent);
            return hasFramework || isAndroidLocalhost || isAndroidWebView;
        },

        /**
         * Detects if the app is embedded in an iframe (e.g., Itch.io or AI Canvas).
         * Used to disable modern File System APIs (showSaveFilePicker) which throw 
         * security exceptions when called from cross-origin iframes.
         * * @returns {boolean} True if embedded in an iframe.
         */
        isCanvas: function() {
            try { 
                return window.self !== window.top; 
            } catch (e) { 
                return true; 
            }
        },

        // ====================================================================
        // 2. CLOUD SYNC (Sovereign Vault Model)
        // ====================================================================
        
        sync: {
            /** @returns {boolean} Current active connection status. */
            get isConnected() { return isConnected; },
            
            /** @returns {string|null} The currently active Vault ID (Sync Key). */
            get vaultId() { return activeVaultId; },

            /**
             * Connects to Firestore, authenticates anonymously, and performs the Initial Handshake.
             * Handles edge cases like empty clouds, empty local storage, and sync conflicts.
             * * @param {string} configStr - Stringified Firebase config object.
             * @param {string} appId - The namespace for the app (e.g., 'karta', 'flow').
             * @param {string} vaultId - The user's secret Sync Key.
             * @param {object} localData - The current local state of the app to be merged/pushed.
             * @param {object} callbacks - Object containing `onUpdate(payload)` and `onConflict(cloudTimestamp, resolveFn)`.
             * @returns {Promise<boolean>} True if connection and handshake succeed.
             */
            connect: async function(configStr, appId, vaultId, localData, callbacks) {
                if (!configStr || !vaultId || !appId) {
                    MHCore.log("[MHCore] Sync aborted: Missing config, appId, or vaultId.", null, 0);
                    return false;
                }

                try {
                    const firebaseConfig = JSON.parse(configStr);
                    
                    if (!fbApp) {
                        MHCore.log("[MHCore] Downloading Firebase SDKs...", null, 1);
                        const [appMod, authMod, fsMod] = await Promise.all([
                            import('https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js'),
                            import('https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js'),
                            import('https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js')
                        ]);
                        fbApp = appMod; fbAuth = authMod; fbFirestore = fsMod;
                        MHCore.log("[MHCore] Firebase SDKs loaded successfully.", null, 2);
                    }

                    const app = fbApp.getApps().length === 0 ? fbApp.initializeApp(firebaseConfig) : fbApp.getApp();
                    auth = fbAuth.getAuth(app);
                    db = fbFirestore.getFirestore(app);
                    activeVaultId = vaultId;
                    activeAppId = appId;

                    MHCore.log("[MHCore] Authenticating with Firebase...", null, 2);
                    await fbAuth.signInAnonymously(auth);
                    user = auth.currentUser;
                    if (!user) throw new Error("Anonymous Auth Failed");

                    // THE HANDSHAKE
                    MHCore.log(`[MHCore] Fetching cloud vault state (${vaultId})...`, null, 2);
                    const docRef = fbFirestore.doc(db, 'artifacts', appId, 'public', 'data', 'vaults', vaultId);
                    const cloudSnap = await fbFirestore.getDoc(docRef);
                    const cloudData = cloudSnap.exists() ? cloudSnap.data() : null;
                    
                    // Boot up RAM state from physical storage
                    const localSyncManifest = MHCore.storage.get(`mhcore_sync_${appId}_${vaultId}`, { lastSynced: 0 });
                    memLastSynced = localSyncManifest.lastSynced;

                    if (!cloudData) {
                        // Scenario A: Cloud is empty. Push local data immediately.
                        MHCore.log(`[MHCore] Cloud vault empty. Claiming with local data (TS: ${Date.now()}).`, null, 1);
                        await this.push(localData);
                        
                    } else if (!localData || Object.keys(localData).length === 0) {
                        // Scenario B: Local is empty. Pull cloud data silently.
                        MHCore.log(`[MHCore] Local empty. Pulling from cloud (TS: ${cloudData.lastUpdated}).`, null, 1);
                        callbacks.onUpdate(cloudData.payload);
                        this._markSynced(cloudData.lastUpdated);
                        
                    } else if (memLastSynced) {
                        // Scenario C: Both have data, device is known and trusted.
                        if (cloudData.lastUpdated > memLastSynced) {
                            MHCore.log(`[MHCore] Cloud is newer (Cloud: ${cloudData.lastUpdated} > Local: ${memLastSynced}). Pulling.`, null, 1);
                            callbacks.onUpdate(cloudData.payload);
                            this._markSynced(cloudData.lastUpdated);
                        } else {
                            MHCore.log(`[MHCore] Local is newer/equal (Cloud: ${cloudData.lastUpdated} <= Local: ${memLastSynced}). Ready to push.`, null, 2);
                        }
                        // Note: We deliberately do NOT call _markSynced() if local is newer, 
                        // to avoid inflating the local watermark before an actual push.
                        
                    } else {
                        // Scenario D: Conflict. Local has data, Cloud has data, device is NOT trusted.
                        MHCore.log(`[MHCore] Sync Conflict Detected! (Cloud TS: ${cloudData.lastUpdated})`, null, 0);
                        
                        return new Promise((resolve) => {
                            callbacks.onConflict(
                                cloudData.lastUpdated, 
                                async (decision) => {
                                    if (decision === 'local') {
                                        MHCore.log("[MHCore] User resolved conflict: Pushing Local.", null, 1);
                                        await this.push(localData);
                                    } else if (decision === 'cloud') {
                                        MHCore.log(`[MHCore] User resolved conflict: Pulling Cloud (TS: ${cloudData.lastUpdated}).`, null, 1);
                                        callbacks.onUpdate(cloudData.payload);
                                        this._markSynced(cloudData.lastUpdated);
                                    }
                                    this._setupListener(callbacks.onUpdate);
                                    this._setupNetworkListeners();
                                    isConnected = true;
                                    resolve(true);
                                }
                            );
                        });
                    }

                    this._setupListener(callbacks.onUpdate);
                    this._setupNetworkListeners();
                    isConnected = true;
                    MHCore.log("[MHCore] Handshake complete. Listening for changes.", null, 2);
                    return true;

                } catch (err) {
                    MHCore.log(`[MHCore] Sync Connection Error: ${err.message}`, null, 0);
                    return false;
                }
            },

            /**
             * Pushes the current application state to the active Cloud Vault.
             * * @param {object} payload - The complete JSON state of the application.
             * @returns {Promise<boolean>} True if the push was successful.
             */
            push: async function(payload) {
                if (!isConnected || !user || !activeVaultId || !activeAppId) return false;
                
                try {
                    // Enforce strictly monotonic timestamps to overcome any minor NTP drift
                    const pushTime = Math.max(Date.now(), memLastSynced + 1);
                    
                    // Stamp locally FIRST to prevent Firestore's local cache from triggering an echo loop
                    this._markSynced(pushTime);

                    MHCore.log(`[MHCore] Initiating push to Firestore (TS: ${pushTime})...`, null, 2);

                    const docRef = fbFirestore.doc(db, 'artifacts', activeAppId, 'public', 'data', 'vaults', activeVaultId);
                    await fbFirestore.setDoc(docRef, {
                        payload: payload,
                        lastUpdated: pushTime,
                        device: navigator.userAgent
                    }, { merge: true }); 
                    
                    MHCore.log(`[MHCore] Pushed state to vault: ${activeVaultId} (TS: ${pushTime})`, null, 1);
                    return true;
                } catch (err) {
                    MHCore.log(`[MHCore] Sync Push Error: ${err.message}`, null, 0);
                    return false;
                }
            },

            /**
             * Disconnects the active sync listener, clears active state, and removes
             * the local trust manifest. Removing the manifest guarantees that if sync is 
             * toggled back on later, any drift between local and cloud will safely trigger 
             * the Conflict Resolution prompt instead of silently overwriting data.
             */
            disconnect: function() {
                if (unsubscribeSnapshot) unsubscribeSnapshot();
                
                // Wipe trust manifest to force a fresh handshake if re-enabled
                if (activeAppId && activeVaultId) {
                    localStorage.removeItem(`mhcore_sync_${activeAppId}_${activeVaultId}`);
                }
                
                isConnected = false;
                user = null;
                activeVaultId = null;
                activeAppId = null;
                memLastSynced = 0; // Wipe RAM state
                MHCore.log("[MHCore] Sync disconnected and trust manifest cleared.", null, 1);
            },

            /**
             * @private
             * Records the exact timestamp of the last successful sync to prevent infinite loops
             * when the snapshot listener fires.
             * @param {number} timestamp - The exact lastUpdated timestamp from the synced payload
             */
            _markSynced: function(timestamp) {
                memLastSynced = timestamp || Date.now();
                MHCore.storage.set(`mhcore_sync_${activeAppId}_${activeVaultId}`, { lastSynced: memLastSynced });
            },

            /**
             * @private
             * Attaches the Firestore onSnapshot listener to the active vault.
             * @param {function} onUpdateCallback - Function to call when new cloud data arrives.
             */
            _setupListener: function(onUpdateCallback) {
                if (unsubscribeSnapshot) unsubscribeSnapshot();
                const docRef = fbFirestore.doc(db, 'artifacts', activeAppId, 'public', 'data', 'vaults', activeVaultId);
                
                unsubscribeSnapshot = fbFirestore.onSnapshot(docRef, (docSnap) => {
                    if (docSnap.exists()) {
                        const data = docSnap.data();
                        
                        MHCore.log(`[MHCore] Snapshot Fired. Cloud: ${data.lastUpdated} | RAM: ${memLastSynced}`, null, 2);

                        // Use isolated RAM state, NOT localStorage, to prevent multi-tab crosstalk.
                        if (data.lastUpdated > memLastSynced) {
                            MHCore.log(`[MHCore] Remote update received (TS: ${data.lastUpdated}).`, null, 1);
                            this._markSynced(data.lastUpdated);
                            onUpdateCallback(data.payload);
                        } else {
                            MHCore.log(`[MHCore] Remote update ignored (Cloud ${data.lastUpdated} <= RAM ${memLastSynced}).`, null, 2);
                        }
                    }
                }, (err) => MHCore.log(`[MHCore] Listener Error: ${err.message}`, null, 0));
            },

            _networkListenersAttached: false,

            /**
             * @private
             * Hooks into native OS events (Airplane Mode toggle, App Foregrounding)
             * to aggressively defibrillate the Firestore WebSocket. Fixes "stuffed wombat" bugs.
             */
            _setupNetworkListeners: function() {
                if (this._networkListenersAttached) return;
                this._networkListenersAttached = true;

                const wakeUp = async () => {
                    if (!isConnected || !db || !navigator.onLine) return;
                    MHCore.log("[MHCore] Network/Wake event. Forcing Firestore reconnect...", null, 2);
                    try {
                        await fbFirestore.disableNetwork(db);
                        await fbFirestore.enableNetwork(db);
                    } catch (e) {
                        MHCore.log(`[MHCore] Wake error: ${e.message}`, null, 0);
                    }
                };

                window.addEventListener('online', wakeUp);
                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'visible') wakeUp();
                });
            }
        },

        // ====================================================================
        // 3. UPDATE CHECKER
        // ====================================================================
        
        /**
         * Polls the GitHub release manifest to check if a newer APK version is available.
         * Only executes in APK environments (bypassed on web).
         * * @param {string} appName - The GitHub project name (e.g., 'karta').
         * @param {string} currentVersion - The running version string (e.g., '1.12.0').
         * @param {object} callbacks - Contains `onUpdateAvailable(url, notes, version, skipFunc)`.
         */
        checkForUpdates: async function(appName, currentVersion, callbacks) {
            if (!this.isApk()) {
                this.log(`[MHCore] Update check bypassed (Not an APK environment)`, null, 1);
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
                    this.log(`[MHCore] Update available: ${currentVersion} -> ${data.version}`, null, 1);
                    
                    if (callbacks && typeof callbacks.onUpdateAvailable === 'function') {
                        const skipFunc = () => this.storage.set(skipKey, data.version);
                        callbacks.onUpdateAvailable(data.url, data.notes, data.version, skipFunc);
                    }
                } else {
                    this.log(`[MHCore] App is up to date (${currentVersion}) or update skipped.`, null, 1);
                }
            } catch (err) {
                this.log(`[MHCore] Failed to check for updates: ${err.message}`, null, 0);
            }
        },

        // ====================================================================
        // 4. EXTERNAL LINKS
        // ====================================================================
        
        /**
         * Safely opens an external URL, adapting to the Cordova/Capacitor environment.
         * * @param {string} url - The external URL to open.
         */
        openLink: function(url) {
            if (window.cordova) {
                window.open(url, '_system'); // Breaks out of the Cordova WebView
            } else {
                window.open(url, '_blank');  // Standard web tab
            }
        },

        // ====================================================================
        // 5. CONFIG / DATA EXPORT
        // ====================================================================
        
        /**
         * Exports a JSON object to a file, utilizing a 4-step fallback waterfall 
         * to guarantee delivery regardless of device or WebView restrictions.
         * * @param {string} filename - Suggested name for the exported file.
         * @param {object} dataObject - The JSON data to serialize and export.
         * @returns {Promise<boolean>} True if the export successfully resolved.
         */
        exportData: async function(filename, dataObject) {
            try {
                const dataStr = JSON.stringify(dataObject, null, 2);

                // STEP 1: Modern Web File System API (Desktop Chrome/Edge)
                if (window.showSaveFilePicker && !this.isCanvas() && !this.isApk()) {
                    try {
                        const handle = await window.showSaveFilePicker({
                            suggestedName: filename,
                            types: [{ description: 'JSON File', accept: {'application/json': ['.json']} }]
                        });
                        const writable = await handle.createWritable();
                        await writable.write(dataStr);
                        await writable.close();
                        this.log(`[MHCore] Exported via native OS picker to ${handle.name}`, null, 1);
                        return true;
                    } catch (err) {
                        if (err.name !== 'AbortError') throw err; 
                        return false; 
                    }
                }

                // STEP 2: Capacitor Native Plugins (Android/iOS APKs)
                if (window.Capacitor && window.Capacitor.Plugins.Filesystem && window.Capacitor.Plugins.Share) {
                    try {
                        const { Filesystem, Share } = window.Capacitor.Plugins;
                        const writeResult = await Filesystem.writeFile({
                            path: filename, data: dataStr, directory: 'CACHE', encoding: 'utf8'
                        });
                        await Share.share({ title: 'Export ' + filename, url: writeResult.uri, dialogTitle: 'Save Export' });
                        this.log(`[MHCore] Exported via Capacitor Share: ${writeResult.uri}`, null, 1);
                        return true;
                    } catch (err) {
                        this.log(`[MHCore] Capacitor File/Share failed: ${err.message}`, null, 0);
                    }
                }

                // STEP 3: Web Share API (Mobile Web Browsers)
                try {
                    if (navigator.share) {
                        const file = new File([dataStr], filename, { type: 'application/json' });
                        if (navigator.canShare && navigator.canShare({ files: [file] })) {
                            await navigator.share({ files: [file], title: filename });
                            this.log(`[MHCore] Exported via native Web Share API (File)`, null, 1);
                            return true;
                        } else if (navigator.canShare && navigator.canShare({ text: dataStr })) {
                            await navigator.share({ title: filename, text: dataStr });
                            this.log(`[MHCore] Exported via native Web Share API (Text)`, null, 1);
                            return true;
                        }
                    }
                } catch (err) {
                    if (err.name === 'AbortError') return false; 
                    this.log(`[MHCore] Web Share failed: ${err.message}`, null, 0);
                }

                // STEP 4: Universal Fallback (Clipboard or <a> tag)
                if (this.isApk()) {
                    try {
                        await navigator.clipboard.writeText(dataStr);
                        this.log(`[MHCore] Exported via clipboard fallback (APK detected)`, null, 1);
                        alert(`File download requires Capacitor plugins to be bundled.\n\nYour export data has been copied to your clipboard instead.`);
                        return true;
                    } catch (e) {
                        alert("Export failed in this environment. Unable to access clipboard.");
                        return false;
                    }
                }

                const blob = new Blob([dataStr], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
                
                this.log(`[MHCore] Exported data via standard web download to ${filename}`, null, 1);
                return true;
            } catch (err) {
                this.log(`[MHCore] Export failed: ${err.message}`, null, 0);
                console.error("Export Error:", err);
                return false;
            }
        },

        // ====================================================================
        // 6. CONFIG / DATA IMPORT
        // ====================================================================
        
        /**
         * Triggers an OS file picker dialog, parses the selected JSON file, 
         * and returns the resulting object.
         * * @returns {Promise<object>} The parsed JSON data.
         */
        importData: async function() {
            return new Promise(async (resolve, reject) => {
                
                // 1. Try Modern Web File System API (Desktop Chrome/Edge)
                if (window.showOpenFilePicker && !this.isCanvas() && !this.isApk()) {
                    try {
                        const [handle] = await window.showOpenFilePicker({
                            types: [{ description: 'JSON File', accept: {'application/json': ['.json']} }],
                            multiple: false
                        });
                        const file = await handle.getFile();
                        const text = await file.text();
                        this.log(`[MHCore] Imported via native OS picker: ${file.name}`, null, 1);
                        return resolve(JSON.parse(text));
                    } catch (err) {
                        if (err.name === 'AbortError') return reject(new Error("User cancelled"));
                    }
                }

                // 2. Universal Fallback (Works magically in WebViews, Cordova, and Itch.io)
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
                            this.log(`[MHCore] Successfully imported data from ${file.name}`, null, 1);
                            resolve(parsed);
                        } catch (err) {
                            this.log(`[MHCore] Failed to parse JSON from ${file.name}`, null, 0);
                            reject(new Error("Invalid JSON file"));
                        }
                    };
                    reader.onerror = () => reject(new Error("Failed to read file"));
                    reader.readAsText(file);
                };
                
                input.click(); 
            });
        },

        // ====================================================================
        // 7. SAFE LOCAL STORAGE
        // ====================================================================
        
        storage: {
            /**
             * Safely retrieves and parses JSON from localStorage.
             * * @param {string} key - The localStorage key.
             * @param {any} defaultValue - Fallback value if key doesn't exist or storage throws.
             * @returns {any} The parsed value or defaultValue.
             */
            get: function(key, defaultValue = null) {
                try {
                    const item = localStorage.getItem(key);
                    return item ? JSON.parse(item) : defaultValue;
                } catch (e) {
                    MHCore.log(`[MHCore] Storage GET failed for ${key} (Likely Incognito Mode)`, null, 0);
                    return defaultValue;
                }
            },
            
            /**
             * Safely stringifies and sets a value in localStorage.
             * Prevents the app from crashing if storage is full or disabled (e.g., iOS Safari Private).
             * * @param {string} key - The localStorage key.
             * @param {any} value - The value to store.
             */
            set: function(key, value) {
                try {
                    localStorage.setItem(key, JSON.stringify(value));
                } catch (e) {
                    MHCore.log(`[MHCore] Storage SET failed for ${key} (Quota exceeded or Incognito)`, null, 0);
                }
            }
        },

        // ====================================================================
        // 8. DEVELOPER LOGGING
        // ====================================================================
        
        _logs: [],
        
        /**
         * Standardized internal logger that maintains a history buffer.
         * * @param {string} msg - The log message.
         * @param {any} [data] - Optional object to dump to the console alongside the message.
         * @param {number} [level] - Verbosity level of this log (0, 1, or 2). Defaults to 1.
         */
        log: function(msg, data = null, level = 1) {
            if (level > this.verbosity) return;

            const timestamp = new Date().toLocaleTimeString();
            const logEntry = `[${timestamp}] ${msg}`;
            this._logs.push(logEntry);
            
            if (this._logs.length > 100) this._logs.shift(); 
            if (data) { console.log(logEntry, data); } else { console.log(logEntry); }
        },

        /** @returns {Array<string>} Array of the last 100 log messages. */
        getLogs: function() { return [...this._logs]; },
        
        /** Clears the internal log buffer. */
        clearLogs: function() { this._logs = []; }
    };

    MHCore.log(`[MHCore] Initialized v${MHCore.LIB_VERSION}`, null, 0);

    window.MHCore = MHCore;
})();
