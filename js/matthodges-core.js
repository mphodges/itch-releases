/**
 * ============================================================================
 * MHCore (Matt Hodges Core Library)
 * ============================================================================
 * A shared, reusable utility library for Hybrid Web Applications (Canvas, Itch.io, APK).
 * * CORE FEATURES:
 * 1. Environment Detection: Identifies Web, Canvas/Iframe, and APK WebViews.
 * 2. Sovereign Cloud Sync: Total-State Firestore Sync with conflict resolution.
 * 3. Update Checker: Polls GitHub release manifests for APK updates.
 * 4. External Links: Safely routes external URLs depending on the native wrapper.
 * 5. Config/Data Export: Universal JSON file export (Desktop, Native, Mobile Web).
 * 6. Config/Data Import: Universal JSON file ingestion via OS pickers.
 * 7. Safe Storage: Resilient localStorage wrapper (bypasses Incognito/Quota crashes).
 * 8. Backups: Automated and manual localStorage backups with LZ compression.
 * 9. Developer Logging: Internal console wrapper with a circular history buffer.
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
    let db, auth, user, activeVaultId, activeAppId, unsubscribeSnapshot, _onError;
    let isConnected = false;
    let memLastSynced = 0; // RAM isolation to prevent multi-tab cross-talk

    const MHCore = {
        LIB_VERSION: "1.3.3",
        verbosity: 1, // 0 = Critical/Errors, 1 = Standard Sync, 2 = Verbose Engine Diagnostics
        
        // ====================================================================
        // 1. ENVIRONMENT DETECTION
        // ====================================================================
        
        /**
         * Detects if the app is running as a packaged Android/iOS application.
         * Used to conditionally route external links and alter file I/O behavior, 
         * as WebViews block standard <a> tag downloads and window.open().
         * @returns {boolean} True if running inside Capacitor, Cordova, or a recognized WebView.
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
         * @returns {boolean} True if embedded in an iframe.
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
             * @param {string} configStr - Stringified Firebase config object (supports raw console snippets).
             * @param {string} appId - The namespace for the app (e.g., 'karta', 'flow').
             * @param {string} vaultId - The user's secret Sync Key.
             * @param {object} localData - The current local state of the app to be merged/pushed.
             * @param {object} callbacks - Object containing onUpdate, onError, and onConflict handlers.
             * @returns {Promise<boolean>} True if connection and handshake succeed.
             */
            connect: async function(configStr, appId, vaultId, localData, callbacks = {}) {
                callbacks = callbacks || {};
                _onError = callbacks.onError;

                if (!configStr || !vaultId || !appId) {
                    MHCore.log("[MHCore] Sync aborted: Missing config, appId, or vaultId.", null, 0);
                    return false;
                }

                let firebaseConfig;
                try {
                    // Try Strict JSON
                    firebaseConfig = JSON.parse(configStr);
                } catch (err) {
                    // Fallback for unquoted keys directly copy-pasted from Firebase Console
                    try {
                        firebaseConfig = new Function('return ' + configStr)();
                    } catch (funcErr) {
                        MHCore.log(`[MHCore] Sync Connection Error: Invalid Firebase config format.`, null, 0);
                        if (callbacks.onError) callbacks.onError(new Error("Invalid Firebase config format."));
                        return false;
                    }
                }

                if (!firebaseConfig || !firebaseConfig.apiKey) {
                    MHCore.log("[MHCore] Sync Connection Error: Config missing apiKey.", null, 0);
                    if (callbacks.onError) callbacks.onError(new Error("Config missing apiKey."));
                    return false;
                }

                try {
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

                    // Set isConnected here so `this.push()` can authorize during the handshake
                    isConnected = true; 

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
                        await this.push(localData || {});
                        
                    } else if (!localData || Object.keys(localData).length === 0) {
                        // Scenario B: Local is empty. Pull cloud data silently.
                        MHCore.log(`[MHCore] Local empty. Pulling from cloud (TS: ${cloudData.lastUpdated}).`, null, 1);
                        if (callbacks.onUpdate) callbacks.onUpdate(cloudData.payload);
                        this._markSynced(cloudData.lastUpdated);
                        
                    } else if (memLastSynced) {
                        // Scenario C: Both have data, device is known and trusted.
                        if (cloudData.lastUpdated > memLastSynced) {
                            MHCore.log(`[MHCore] Cloud is newer (Cloud: ${cloudData.lastUpdated} > Local: ${memLastSynced}). Pulling.`, null, 1);
                            if (callbacks.onUpdate) callbacks.onUpdate(cloudData.payload);
                            this._markSynced(cloudData.lastUpdated);
                        } else {
                            MHCore.log(`[MHCore] Local is newer/equal (Cloud: ${cloudData.lastUpdated} <= Local: ${memLastSynced}). Ready to push.`, null, 2);
                        }
                        
                    } else {
                        // Scenario D: Conflict. Local has data, Cloud has data, device is NOT trusted.
                        MHCore.log(`[MHCore] Sync Conflict Detected! (Cloud TS: ${cloudData.lastUpdated})`, null, 0);
                        
                        return new Promise((resolve) => {
                            if (callbacks.onConflict) {
                                callbacks.onConflict(
                                    cloudData.lastUpdated, 
                                    async (decision) => {
                                        if (decision === 'local') {
                                            MHCore.log("[MHCore] User resolved conflict: Pushing Local.", null, 1);
                                            await this.push(localData || {}, true);
                                        } else if (decision === 'cloud') {
                                            MHCore.log(`[MHCore] User resolved conflict: Pulling Cloud (TS: ${cloudData.lastUpdated}).`, null, 1);
                                            if (callbacks.onUpdate) callbacks.onUpdate(cloudData.payload);
                                            this._markSynced(cloudData.lastUpdated);
                                        }
                                        this._setupListener(callbacks.onUpdate);
                                        this._setupNetworkListeners();
                                        resolve(true);
                                    }
                                );
                            } else {
                                MHCore.log("[MHCore] Conflict bypassed (no handler). Assuming Cloud override.", null, 1);
                                if (callbacks.onUpdate) callbacks.onUpdate(cloudData.payload);
                                this._markSynced(cloudData.lastUpdated);
                                this._setupListener(callbacks.onUpdate);
                                this._setupNetworkListeners();
                                resolve(true);
                            }
                        });
                    }

                    this._setupListener(callbacks.onUpdate);
                    this._setupNetworkListeners();
                    MHCore.log("[MHCore] Handshake complete. Listening for changes.", null, 2);
                    return true;

                } catch (err) {
                    // Cleanup internal variables in case the handshake fails after auth
                    isConnected = false; 
                    user = null;
                    activeVaultId = null;
                    activeAppId = null;

                    MHCore.log(`[MHCore] Sync Connection Error: ${err.message}`, null, 0);
                    if (callbacks.onError) callbacks.onError(err);
                    return false;
                }
            },

            /**
             * Pushes the current application state to the active Cloud Vault.
             * @param {object} payload - The complete JSON state of the application.
             * @param {boolean} forceOverwrite - Optional flag to bypass timestamp safety blocks.
             * @returns {Promise<boolean>} True if the push was successful.
             */
            push: async function(payload, forceOverwrite = false) {
                if (!isConnected || !user || !activeVaultId || !activeAppId) return false;
                
                try {
                    const docRef = fbFirestore.doc(db, 'artifacts', activeAppId, 'public', 'data', 'vaults', activeVaultId);
                    
                    // 1. PRE-FLIGHT CHECK: Eliminate Blind Writes
                    let cloudSnap;
                    try {
                        // In Firebase v9+, getDocFromServer explicitly bypasses the offline cache. 
                        // If the socket is dead, this throws an error and prevents the push entirely.
                        if (fbFirestore.getDocFromServer) {
                            cloudSnap = await fbFirestore.getDocFromServer(docRef);
                        } else {
                            cloudSnap = await fbFirestore.getDoc(docRef);
                            if (cloudSnap.metadata && cloudSnap.metadata.fromCache) throw new Error("fromCache");
                        }
                    } catch (err) {
                        MHCore.log("[MHCore] Push aborted: Socket dead. Preventing offline blind overwrite.", null, 0);
                        if (!this._isReconnecting) this.reconnectNetwork('failed_push');
                        return false;
                    }

                    // If we made it here, we hit the live server. Check for remote changes we missed.
                    if (cloudSnap.exists()) {
                        const cloudData = cloudSnap.data();
                        if (cloudData.lastUpdated > memLastSynced && !forceOverwrite) {
                            MHCore.log(`[MHCore] Push blocked! Cloud has newer data (${cloudData.lastUpdated} > ${memLastSynced}).`, null, 0);
                            this.disconnect();
                            if (_onError) _onError(new Error("PUSH_BLOCKED_STALE_STATE"));
                            return false;
                        }
                    }

                    // 2. SAFE PUSH
                    // Enforce strictly monotonic timestamps to overcome any minor NTP drift
                    const pushTime = Math.max(Date.now(), memLastSynced + 1);
                    
                    // Stamp locally FIRST to prevent Firestore's local cache from triggering an echo loop
                    this._markSynced(pushTime);

                    MHCore.log(`[MHCore] Initiating push to Firestore (TS: ${pushTime})...`, null, 2);

                    await fbFirestore.setDoc(docRef, {
                        payload: payload,
                        lastUpdated: pushTime,
                        device: navigator.userAgent
                    }, { merge: true }); 
                    
                    MHCore.log(`[MHCore] Pushed state to vault: ${activeVaultId} (TS: ${pushTime})`, null, 1);
                    return true;
                } catch (err) {
                    MHCore.log(`[MHCore] Sync Push Error: ${err.message}`, null, 0);
                    if (err.message === "PUSH_BLOCKED_STALE_STATE") throw err;
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
                if (this._watchdogTimer) {
                    clearInterval(this._watchdogTimer);
                    this._watchdogTimer = null;
                }
                
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
                            if (onUpdateCallback) onUpdateCallback(data.payload);
                        } else {
                            MHCore.log(`[MHCore] Remote update ignored (Cloud ${data.lastUpdated} <= RAM ${memLastSynced}).`, null, 2);
                        }
                    }
                }, (err) => {
                    MHCore.log(`[MHCore] Listener Error: ${err.message}`, null, 0);
                });
            },

            _networkListenersAttached: false,
            _isReconnecting: false,
            _lastReconnectStart: 0,
            _watchdogTimer: null,

            /**
             * Safely tears down and reconstructs the Firestore network connection.
             * Used to recover from silent connection drops and OS wake events.
             * @param {string} source - The event that triggered the reconnection.
             */
            reconnectNetwork: async function(source) {
                if (!isConnected || !db) return;
                MHCore.log(`[MHCore] OS Event: ${source}. Verifying network...`, null, 2);
                
                if (MHCore.sync._isReconnecting) {
                    // Prevent permanent freeze if a previous disableNetwork hung indefinitely
                    if (Date.now() - MHCore.sync._lastReconnectStart < 30000) {
                        MHCore.log(`[MHCore] Wake aborted: Reconnection already in progress.`, null, 2);
                        return;
                    }
                    MHCore.log(`[MHCore] Overriding hung network recovery lock.`, null, 2);
                }
                
                MHCore.sync._isReconnecting = true;
                MHCore.sync._lastReconnectStart = Date.now();
                
                setTimeout(async () => {
                    if (!navigator.onLine) {
                        MHCore.log(`[MHCore] Wake aborted: navigator.onLine is false`, null, 2);
                        MHCore.sync._isReconnecting = false;
                        return;
                    }

                    // Physical DNS Pre-Check: Prevents falsely declaring success when WiFi is connected but internet is dead
                    try {
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 3000); 
                        await fetch(`https://raw.githubusercontent.com/mphodges/itch-releases/main/release/flow.json?t=${Date.now()}`, {
                            method: 'HEAD', mode: 'no-cors', signal: controller.signal
                        });
                        clearTimeout(timeoutId);
                    } catch (e) {
                        MHCore.log(`[MHCore] Network reset paused: DNS/Internet physically unreachable.`, null, 2);
                        MHCore.sync._isReconnecting = false;
                        return; // Firebase will natively retry when the physical route restores
                    }

                    MHCore.log("[MHCore] Executing Firestore network reset...", null, 2);
                    
                    // 1. Safely disable with a Promise timeout race so it CANNOT hang forever
                    try {
                        const disablePromise = fbFirestore.disableNetwork(db);
                        const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error("disableNetwork timeout")), 3000));
                        await Promise.race([disablePromise, timeoutPromise]);
                    } catch (e) {
                        MHCore.log(`[MHCore] Network disable warning: ${e.message}`, null, 2);
                    }

                    // 2. Aggressively re-enable with progressive backoff and Promise timeouts
                    let retries = 0;
                    const maxRetries = 10; // Try for approx 60 seconds total
                    
                    while (retries < maxRetries) {
                        try {
                            const enablePromise = fbFirestore.enableNetwork(db);
                            const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error("enableNetwork timeout")), 5000));
                            await Promise.race([enablePromise, timeoutPromise]);
                            
                            MHCore.log("[MHCore] Network recovery success. Connection re-enabled.", null, 2);
                            break; // Success!
                        } catch (e) {
                            retries++;
                            const backoff = Math.min(2000 * retries, 10000); // 2s, 4s, 6s, 8s, 10s...
                            MHCore.log(`[MHCore] Network recovery error: ${e.message}. Retry ${retries}/${maxRetries} in ${backoff/1000}s`, null, 2);
                            if (retries < maxRetries) {
                                await new Promise(r => setTimeout(r, backoff));
                            } else {
                                MHCore.log("[MHCore] Network recovery attempts exhausted. Yielding to Firebase native reconnect.", null, 0);
                            }
                        }
                    }
                    
                    MHCore.sync._isReconnecting = false;
                }, 1500);
            },

            /**
             * @private
             * Hooks into native OS events AND starts a Dashboard Watchdog timer.
             */
            _setupNetworkListeners: function() {
                if (this._networkListenersAttached) return;
                this._networkListenersAttached = true;

                // Fires when the OS network hardware confirms a connection
                window.addEventListener('online', () => this.reconnectNetwork('online'));
                
                // Fires when dismissing the OS notification shade / control center
                window.addEventListener('focus', () => this.reconnectNetwork('focus'));

                // Fires when the screen unlocks or app returns from background (Web Standard)
                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'visible') this.reconnectNetwork('visibilitychange');
                });

                // Fires when returning from background (Cordova/Capacitor Native Standard)
                document.addEventListener('resume', () => this.reconnectNetwork('resume'), false);

                // Start the active idle watchdog
                this._startWatchdog();
            },

            /**
             * @private
             * Active Dashboard Watchdog.
             * Fires a tiny ping every 45s to keep the carrier NAT connection hot.
             * If the ping fails, we know the carrier silently dropped us, and we force a reconnect.
             */
            _startWatchdog: function() {
                if (this._watchdogTimer) clearInterval(this._watchdogTimer);
                
                this._watchdogTimer = setInterval(async () => {
                    if (!isConnected || !navigator.onLine || MHCore.sync._isReconnecting) return;
                    
                    try {
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 5000); 
                        
                        // Tiny HEAD request to test if the internet route actually exists
                        await fetch(`https://raw.githubusercontent.com/mphodges/itch-releases/main/release/flow.json?t=${Date.now()}`, {
                            method: 'HEAD',
                            mode: 'no-cors', // Bypasses CORS blocks, we just care if the TCP handshake works
                            signal: controller.signal
                        });
                        
                        clearTimeout(timeoutId);
                        // Deliberately hidden from Verbosity 2 to prevent spamming the log screen
                    } catch (e) {
                        MHCore.log(`[MHCore] Watchdog detected dead connection (${e.name}). Triggering recovery...`, null, 0);
                        this.reconnectNetwork('watchdog_timeout');
                    }
                }, 45000); // Check every 45 seconds
            }
        },

        // ====================================================================
        // 3. UPDATE CHECKER
        // ====================================================================
        
        /**
         * Polls the GitHub release manifest to check if a newer APK version is available.
         * Only executes in APK environments (bypassed on web).
         * @param {string} appName - The GitHub project name (e.g., 'karta').
         * @param {string} currentVersion - The running version string (e.g., '1.12.0').
         * @param {object} callbacks - Contains `onUpdateAvailable(url, notes, version, skipFunc)`.
         */
        checkForUpdates: async function(appName, currentVersion, callbacks) {
            if (!this.isApk()) {
                this.log(`[MHCore] Update check bypassed (Not an APK environment)`, null, 1);
                return;
            }

            try {
                const manifestUrl = `https://raw.githubusercontent.com/mphodges/itch-releases/main/release/${appName}.json?t=${Date.now()}`;
                const response = await fetch(manifestUrl);
                
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                const data = await response.json();
                
                const skipKey = `${appName}-skipped-version`;
                const skippedVersion = this.storage.get(skipKey, null);

                // Compare semantic versions (e.g. 0.9.92 > 0.9.91) instead of basic string inequality
                const isNewer = data.version && data.version.localeCompare(currentVersion, undefined, { numeric: true, sensitivity: 'base' }) > 0;

                if (isNewer && data.version !== skippedVersion) {
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
         * @param {string} url - The external URL to open.
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
         * @param {string} filename - Suggested name for the exported file.
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
         * @returns {Promise<object>} The parsed JSON data.
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
             * @param {string} key - The localStorage key.
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
             * @param {string} key - The localStorage key.
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
        // 8. BACKUPS (GFS / Time Machine Architecture)
        // ====================================================================

        backups: {
            _intervals: {}, 
            _manifestKey: (appId) => `mhcore_backups_manifest_${appId}`,
            _dataKey: (appId, id) => `mhcore_backup_data_${appId}_${id}`,

            _loadLZ: async function() {
                if (window.LZString) return;
                const loadScript = (src) => new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = src; script.onload = resolve; script.onerror = reject;
                    document.head.appendChild(script);
                });
                try {
                    await loadScript("assets/js/lz-string.min.js");
                } catch (e) {
                    try {
                        await loadScript("https://cdnjs.cloudflare.com/ajax/libs/lz-string/1.5.0/lz-string.min.js");
                    } catch (err) {
                        throw new Error("No LZ-String library found (Local or CDN)");
                    }
                }
            },

            startAutoBackup: function(appId, options) {
                if (this._intervals[appId]) clearInterval(this._intervals[appId]);
                
                const intervalMs = (options.intervalMinutes || 10) * 60 * 1000;
                
                this._intervals[appId] = setInterval(async () => {
                    await this._performBackup(appId, options);
                }, intervalMs);

                MHCore.log(`[MHCore] Auto-backup engine started for '${appId}'. Heartbeat configured at ${options.intervalMinutes}m.`, null, 1);
                this._performBackup(appId, options); 
            },

            stopAutoBackup: function(appId) {
                if (this._intervals[appId]) {
                    clearInterval(this._intervals[appId]);
                    delete this._intervals[appId];
                    MHCore.log(`[MHCore] Backups stopped for '${appId}'.`, null, 1);
                }
            },

            createManualBackup: async function(appId, options) {
                const manifest = MHCore.storage.get(this._manifestKey(appId), { recent: [], hourly: [], daily: [], manual: [] });
                if (!manifest.manual) manifest.manual = []; 

                const now = Date.now();
                const rawState = options.getStateFn();
                if (!rawState) return false;

                let payload = JSON.stringify(rawState);
                let isCompressed = false;

                if (options.useCompression) {
                    try {
                        await this._loadLZ();
                        payload = window.LZString.compressToUTF16(payload);
                        isCompressed = true;
                    } catch (err) {
                        MHCore.log(`[MHCore] Compression failed: ${err.message}`, null, 0);
                    }
                }

                const backupId = `manual_${now}`;
                const meta = { id: backupId, timestamp: now, type: 'manual', compressed: isCompressed, sizeBytes: payload.length };

                try {
                    localStorage.setItem(this._dataKey(appId, backupId), payload);
                } catch (e) {
                    MHCore.log(`[MHCore] Manual backup failed: Quota exceeded.`, null, 0);
                    return false;
                }

                manifest.manual.unshift(meta);
                MHCore.storage.set(this._manifestKey(appId), manifest);
                MHCore.log(`[MHCore] Created manual backup: ${backupId}`, null, 1);
                return true;
            },

            delete: function(appId, backupId) {
                const manifest = MHCore.storage.get(this._manifestKey(appId), { recent: [], hourly: [], daily: [], manual: [] });
                const filterOut = (list) => list.filter(b => b.id !== backupId);
                
                manifest.recent = filterOut(manifest.recent || []);
                manifest.hourly = filterOut(manifest.hourly || []);
                manifest.daily = filterOut(manifest.daily || []);
                manifest.manual = filterOut(manifest.manual || []);
                
                localStorage.removeItem(this._dataKey(appId, backupId));
                MHCore.storage.set(this._manifestKey(appId), manifest);
                MHCore.log(`[MHCore] Deleted backup: ${backupId}`, null, 1);
            },

            _performBackup: async function(appId, options) {
                // Ensure legacy states map safely to the new GFS schema
                const manifest = MHCore.storage.get(this._manifestKey(appId), { recent: [], hourly: [], daily: [], manual: [] });
                if (!manifest.recent) manifest.recent = [];

                const schedule = options.schedule || { recent: 6, hourly: 24, daily: 7 };
                const now = Date.now();
                const d = new Date(now);
                
                const currentHour = d.getHours();
                const currentDate = d.toDateString(); 
                const current10MinBlock = Math.floor(d.getMinutes() / 10);

                MHCore.log(`[MHCore] Backup heartbeat received. Evaluating schedule payload...`, null, 2);

                let needsRecent = false;
                let needsHourly = false;
                let needsDaily = false;
                let promotedHourlyToDaily = false;

                // Tier 3: Daily Evaluation
                const lastDaily = manifest.daily[0];
                if (!lastDaily || new Date(lastDaily.timestamp).toDateString() !== currentDate) {
                    const yesterdayStr = new Date(now - 86400000).toDateString();
                    const yesterdayHourlies = manifest.hourly.filter(b => new Date(b.timestamp).toDateString() === yesterdayStr);
                    
                    if (yesterdayHourlies.length > 0) {
                        const target = yesterdayHourlies.pop(); 
                        manifest.hourly = manifest.hourly.filter(b => b.id !== target.id); 
                        target.type = 'daily';
                        manifest.daily.unshift(target);
                        promotedHourlyToDaily = true;
                        MHCore.log(`[MHCore] Rollover executed: Promoted older hourly snapshot (${target.id}) to Daily tier.`, null, 1);
                    } else {
                        needsDaily = true;
                    }
                }

                // Tier 2: Hourly Evaluation
                const lastHourly = manifest.hourly[0];
                if (!lastHourly || new Date(lastHourly.timestamp).getHours() !== currentHour || new Date(lastHourly.timestamp).toDateString() !== currentDate) {
                    needsHourly = true;
                }

                // Tier 1: Recent Evaluation
                const lastRecent = manifest.recent[0];
                if (!lastRecent || Math.floor(new Date(lastRecent.timestamp).getMinutes() / 10) !== current10MinBlock || new Date(lastRecent.timestamp).getHours() !== currentHour) {
                    needsRecent = true;
                }

                // Idle skip
                if (!needsRecent && !needsHourly && !needsDaily) {
                    MHCore.log("[MHCore] Schedule satisfied. Skipping snapshot generation.", null, 2);
                    if (promotedHourlyToDaily) MHCore.storage.set(this._manifestKey(appId), manifest);
                    return;
                }

                // Generate Physical Payload
                const rawState = options.getStateFn();
                if (!rawState) {
                    MHCore.log("[MHCore] App returned empty state, aborting save.", null, 0);
                    return;
                }

                let payload = JSON.stringify(rawState);
                let isCompressed = false;
                if (options.useCompression) {
                    try {
                        await this._loadLZ();
                        payload = window.LZString.compressToUTF16(payload);
                        isCompressed = true;
                    } catch (err) {
                        MHCore.log(`[MHCore] Compression failed, falling back to raw JSON: ${err.message}`, null, 0);
                    }
                }

                const sizeBytes = payload.length;

                const saveSnapshot = (type) => {
                    const backupId = `${type}_${now}`;
                    const meta = { id: backupId, timestamp: now, type, compressed: isCompressed, sizeBytes };
                    try {
                        localStorage.setItem(this._dataKey(appId, backupId), payload);
                        manifest[type].unshift(meta);
                        MHCore.log(`[MHCore] Created new snapshot: [${type.toUpperCase()}] ${backupId}`, null, 1);
                    } catch (e) {
                        MHCore.log(`[MHCore] Quota exceeded. Failed to save ${type} snapshot.`, null, 0);
                    }
                };

                if (needsDaily) saveSnapshot('daily');
                if (needsHourly) saveSnapshot('hourly');
                if (needsRecent) saveSnapshot('recent');

                // Evaluate Pruning Restrictions
                const prune = (type, limit) => {
                    while (manifest[type].length > limit) {
                        const victim = manifest[type].pop();
                        localStorage.removeItem(this._dataKey(appId, victim.id));
                        MHCore.log(`[MHCore] Pruned aged-out snapshot: [${type.toUpperCase()}] ${victim.id}`, null, 1);
                    }
                };

                prune('recent', schedule.recent);
                prune('hourly', schedule.hourly);
                prune('daily', schedule.daily);

                MHCore.storage.set(this._manifestKey(appId), manifest);
            },

            list: function(appId) {
                const manifest = MHCore.storage.get(this._manifestKey(appId), { recent: [], hourly: [], daily: [], manual: [] });
                return [...(manifest.manual || []), ...(manifest.recent || []), ...(manifest.hourly || []), ...(manifest.daily || [])]
                    .sort((a, b) => b.timestamp - a.timestamp);
            },

            get: async function(appId, backupId) {
                const payload = localStorage.getItem(this._dataKey(appId, backupId));
                if (!payload) {
                    MHCore.log(`[MHCore] Backup missing from disk: ${backupId}`, null, 0);
                    return null;
                }
                try {
                    const manifest = MHCore.storage.get(this._manifestKey(appId), { recent: [], hourly: [], daily: [], manual: [] });
                    const meta = [...(manifest.manual || []), ...(manifest.recent || []), ...(manifest.hourly || []), ...(manifest.daily || [])].find(m => m.id === backupId);
                    
                    if (meta && meta.compressed) {
                        await this._loadLZ();
                        const decompressed = window.LZString.decompressFromUTF16(payload);
                        return JSON.parse(decompressed);
                    }
                    return JSON.parse(payload);
                } catch (err) {
                    MHCore.log(`[MHCore] Failed to parse/decompress backup: ${err.message}`, null, 0);
                    return null;
                }
            }
        },

        // ====================================================================
        // 9. DEVELOPER LOGGING
        // ====================================================================
        
        _logs: [],
        
        /**
         * Standardized internal logger that maintains a history buffer.
         * @param {string} msg - The log message.
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
