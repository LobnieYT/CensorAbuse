(function() {
    "use strict"
    const ADDON_NAME = "CensorAbuse";
    const CODE_VERSION = "1.9.19"; // видна в консоли на старте: по ней проверяем что код обновился
    function log(...args) {
        console.debug("[" + ADDON_NAME + "]", ...args);
    }

    /* == получение метода require из webpack == */
    const webpackGlobal = window.webpackChunk_N_E;
    let appRequire = null;

    webpackGlobal.push([[Symbol("requireGetter__" + ADDON_NAME)],
        {},
        (internalRequire) => {
            appRequire = internalRequire;
        }
    ]);
    webpackGlobal.pop();

    if (!appRequire) {
        console.error("Failed to get appRequire func");
        return;
    }


    // получение DI модуля (оно хранит все синглтоны необходимые для работы плагина)
    function findModule(...requiredStrings) {
        for (const id in appRequire.m) {
            try {
                const mod = appRequire(id);
                const moduleStr = Object.keys(mod);
                if (requiredStrings.every(str => moduleStr.includes(str))) {
                    return mod;
                }
            } catch(e) {
                log(`Ошибка при поиске модуля ${id}`, e);
            }
        }
        return null;
    }

    const diModule = findModule("Dt", "P9", "Gr", "do");
    if (!diModule?.Dt) {
        console.error("Failed to find DI module. Wait for plugin update!");
        return;
    }

    
    const di = diModule.Dt;
    const originalDiGet = di.prototype.get;

    // хук получения DI — НИКОГДА не должен ронять приложение:
    // любая ошибка внутри глушится, оригинал вызывается как есть
    let hooked = false;
    di.prototype.get = function(_) {
        let result;
        try {
            result = originalDiGet.apply(this, arguments);
        } catch (e) {
            throw e;
        }

        if (!hooked) {
            try {
                const shared = this && this.shared;
                const gfir = shared && shared.get ? shared.get("GetFileInfoResource") : null;
                if (gfir) {
                    hooked = true;
                    di.prototype.get = originalDiGet;
                    try { hookMethods(gfir); } catch (e) { log("hookMethods failed", e); }
                }
            } catch (_) {}
        }

        return result;
    };

    let _notificationComponentsCache = null;
    function getNotificationComponents() {
        if (_notificationComponentsCache) return _notificationComponentsCache;

        const notificationManager = findModule("Notification", "notification", "dismiss")
        const React = findModule("createElement", "cacheSignal", "createContext", "createRef", "forwardRef")
        const NotificationComponent = findModule("$W", "NX", "fJ", "cp", "hT", "OM", "DZ")
        const Typography = findModule("Caption", "Heading")
        const PaperComponent = findModule("Paper").Paper
        const styles = findModule("message", "cover", "image", "text")

        _notificationComponentsCache = {
            notificationManager: notificationManager,
            React: React,
            NotificationComponent: NotificationComponent,
            Typography: Typography,
            PaperComponent: PaperComponent,
            styles: styles
        }
        return _notificationComponentsCache;
    }

    function postNotification(caption, image = null) {
        const { notificationManager, React, NotificationComponent, Typography, PaperComponent, styles } = getNotificationComponents();
        const children = [];

        if (image) {
          const img = React.createElement(NotificationComponent.BW, {
            className: styles.image,
            src: image,
            alt: "cover",
            size: 100,
            fit: "cover",
            withAvatarReplace: true
          });

          const paper = React.createElement(PaperComponent, {
            className: styles.cover,
            radius: "s",
          }, img);

          children.push(paper);
        }

        const text = React.createElement(Typography.Caption, {
          className: styles.text,
          variant: "div",
          type: "controls",
          size: "m",
          "aria-hidden": true
        }, caption);

        children.push(text);

        const content = React.createElement("div", {
          className: styles.message
        }, ...children);

        const ctr = React.createElement(NotificationComponent.$W, { 
          message: content 
        });

        notificationManager.notification({
          message: ctr,
          options: { autoClose: 2e3, closeOnClick: true, pauseOnHover: true, draggable: false, single: true, containerId: "INFO"},
        });
    }

    function postNotificationWithCover(caption, trackId) {
        let coverUri = null;
        try {
            const currentTrack = window.pulsesyncApi?.getCurrentTrack?.();
            coverUri = currentTrack && currentTrack.id == trackId ? currentTrack.coverUri : null;
        } catch (_) {}
        try { postNotification(caption, coverUri); } catch (_) {}
    }

    // основной код плагина, выполняется после инициализации DI
    function hookMethods(gfir) {
        try {
            const originalGetFileInfo = gfir.getLocalFileDownloadInfo;
            if (typeof originalGetFileInfo !== "function") return;
            gfir.getLocalFileDownloadInfo = async function(trackId) {
                try {
                    // DECOY-путь: натив играет decoyID, а отдать надо реальное аудио RKN-трека.
                    // Сервер в логах видит decoyID, клиент слышит замену. Один плеер.
                    try {
                        if (typeof getActiveDecoyCover === "function") {
                            const cover = getActiveDecoyCover(String(trackId));
                            if (cover) {
                                let realUrl = null;
                                try { realUrl = await getReplacedUrl(cover.rknId); } catch (_) {}
                                if (realUrl) {
                                    log("Decoy cover: native asked " + trackId + ", serving real audio of " + cover.rknId);
                                    try { hlog("hook serve " + trackId + "<-" + cover.rknId); } catch (_) {}
                                    try {
                                        coverServedAt = Date.now();
                                        // натив взял подмену себе — свой Audio глушим чтобы не двоило
                                        if (antiAudio && !antiAudio.paused && String(antiTrackId) === String(cover.rknId)) {
                                            try { antiAudio.pause(); } catch (_) {}
                                            try { hlog("native took over " + cover.rknId); } catch (_) {}
                                            try { setHudErr("-"); } catch (_) {}
                                        }
                                        // честный клиент: вслух фиксируем, ЧТО слушаешь и ЧТО видит сервер.
                                        // Названия в интерфейсе при этом не трогаем.
                                        try {
                                            if (claimDecoyNotify("takeover-" + cover.rknId)) {
                                                const realT = titleForTrackId(cover.rknId) || ("трек " + cover.rknId);
                                                const decoyT = titleForTrackId(trackId) || ("трек " + trackId);
                                                postNotification("Слушаешь: " + realT + " · Сервер видит: " + decoyT);
                                            }
                                        } catch (_) {}
                                    } catch (_) {}
                                    return { trackId: trackId, urls: [realUrl] };
                                }
                                // decoy активен, но файла замены нет — не падать, отдать нативу как есть
                                log("Decoy cover active but no real file for " + cover.rknId);
                            }
                        }
                    } catch (_) {}
                    const replacedTrack = getReplaced(trackId);

                    if (replacedTrack && replacedTrack.src !== "remote_exception") {
                        let url = replacedTrack.url;

                        if (replacedTrack.src === "local" && !replacedTrack.url) {
                            url = await getLocalTrackUrl(trackId);
                        }

                        if (url) {
                            log("Replacing track " + trackId + " with url " + url);
                            return {
                                trackId: trackId,
                                urls: [url]
                            };
                        }
                    }
                } catch (e) {
                    log("getLocalFileDownloadInfo hook failed, fallback to original", e);
                }
                return originalGetFileInfo.apply(this, arguments);
            };
        } catch (e) { log("patch getLocalFileDownloadInfo failed", e); }

        try {
            const originalIsDownloaded = gfir.isTrackDownloaded;
            if (typeof originalIsDownloaded !== "function") return;
            gfir.isTrackDownloaded = async function(trackId, _) {
                try {
                    try {
                        if (typeof getActiveDecoyCover === "function" && getActiveDecoyCover(String(trackId))) {
                            return true;
                        }
                    } catch (_) {}
                    const replacedTrack = getReplaced(trackId);
                    if (replacedTrack && replacedTrack.src !== "remote_exception") {
                        return true;
                    }
                } catch (e) {
                    log("isTrackDownloaded hook failed, fallback to original", e);
                }
                return originalIsDownloaded.apply(this, arguments);
            };
        } catch (e) { log("patch isTrackDownloaded failed", e); }
    }

    // === хранение подменных треков ===
    /* из базы данных */
    let localTracksUrlCache = {};
    let localTrackIds = [];

    async function getLocalTrackUrl(trackId) {
        if (localTracksUrlCache[trackId]) return localTracksUrlCache[trackId];

        const db = await openDB();
        // ключ мог сохраниться строкой или числом — пробуем варианты
        const variants = [trackId, String(trackId)];
        try {
            const n = Number(trackId);
            if (!isNaN(n)) variants.push(n);
        } catch (_) {}
        for (const key of variants) {
            try {
                const url = await new Promise((resolve, reject) => {
                    const tx = db.transaction("tracks", 'readonly');
                    const store = tx.objectStore("tracks");
                    const request = store.get(key);

                    request.onsuccess = () => {
                        if (request.result && request.result.data) {
                            const url = URL.createObjectURL(request.result.data);
                            localTracksUrlCache[trackId] = url;
                            resolve(url);
                        } else {
                            resolve(null);
                        }
                    };
                    request.onerror = () => reject(request.error);
                });
                if (url) return url;
            } catch (_) {}
        }
        return null;
    }

    // открытие базы данных
    let dbPromise = null;
    const DB_VERSION = 4;
    function openDB() {
        if (!dbPromise) {
            dbPromise = new Promise((resolve, reject) => {
                const request = indexedDB.open(ADDON_NAME + "Data", DB_VERSION);

                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains("tracks")) {
                        db.createObjectStore("tracks", { keyPath: "id" });
                    }

                    if (!db.objectStoreNames.contains("remote_exceptions")) {
                        db.createObjectStore("remote_exceptions", { keyPath: "id" });
                    }

                    if (!db.objectStoreNames.contains("reported_tracks")) {
                        db.createObjectStore("reported_tracks", { keyPath: "id" });
                    }

                    // RKN-decoy: ручные оверрайды заглушки {id: rknId, decoyId}
                    if (!db.objectStoreNames.contains("decoy_overrides")) {
                        db.createObjectStore("decoy_overrides", { keyPath: "id" });
                    }
                };

                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        }
        return dbPromise;
    }

    // первоначальная загрузка треков из базы данных
    function reloadLocalTracks() {
        return openDB().then(db => new Promise((resolve) => {
            try {
                const tx = db.transaction("tracks", 'readonly');
                const store = tx.objectStore("tracks");
                const request = store.getAllKeys();

                request.onsuccess = () => {
                    localTrackIds = request.result;
                    log("Loaded ", Object.keys(localTrackIds).length, "local tracks");
                    resolve();
                };
                request.onerror = () => resolve();
            } catch (_) { resolve(); }
        }));
    }

    // переезд со старых имён базы: FckCensor -> AntiCensor -> CensorAbuse.
    // Без миграции плагин не видит локальные подмены из "FckCensorData"/"AntiCensorData"
    function migrateLegacyDB() {
        const LEGACIES = ["FckCensorData", "AntiCensorData"].filter(n => n !== (ADDON_NAME + "Data"));
        const migrateOne = (LEGACY) => new Promise((resolve) => {
            let legacy = null;
            try {
                const openReq = indexedDB.open(LEGACY);
                openReq.onsuccess = () => {
                    legacy = openReq.result;
                    const finish = () => { try { legacy && legacy.close(); } catch (_) {} resolve(); };
                    openDB().then(async (db) => {
                        try {
                            for (const storeName of ["tracks", "remote_exceptions", "reported_tracks"]) {
                                try {
                                    if (!legacy.objectStoreNames.contains(storeName)) continue;
                                    if (!db.objectStoreNames.contains(storeName)) continue;
                                    const items = await new Promise((res) => {
                                        try {
                                            const tx = legacy.transaction(storeName, 'readonly');
                                            const rq = tx.objectStore(storeName).getAll();
                                            rq.onsuccess = () => res(rq.result || []);
                                            rq.onerror = () => res([]);
                                        } catch (_) { res([]); }
                                    });
                                    if (items && items.length) {
                                        await new Promise((done) => {
                                            try {
                                                const tx = db.transaction(storeName, 'readwrite');
                                                const st = tx.objectStore(storeName);
                                                items.forEach(it => { try { st.put(it); } catch (_) {} });
                                                tx.oncomplete = () => done();
                                                tx.onerror = () => done();
                                                tx.onabort = () => done();
                                            } catch (_) { done(); }
                                        });
                                        log("Migrated " + items.length + " records from legacy store " + storeName);
                                    }
                                } catch (_) {}
                            }
                        } catch (_) {}
                        finish();
                    }).catch(() => finish());
                };
                openReq.onerror = () => resolve(); // старой базы нет — нечего мигрировать
                openReq.onblocked = () => { try { openReq.result && openReq.result.close(); } catch (_) {} resolve(); };
            } catch (_) { resolve(); }
        });
        return LEGACIES.reduce((p, name) => p.then(() => migrateOne(name)), Promise.resolve());
    }

    openDB()
        .then(() => migrateLegacyDB())
        .then(() => reloadLocalTracks())
        .then(() => loadDecoyOverrides())
        .then(() => { try { addReplacedMarks(); } catch (_) {} })
        .catch(() => {});

    /* из папки assets */
    let assetsTracks = {};
    function updateAssetsTracks() {
        fetch("http://localhost:2007/assets?name=" + ADDON_NAME)
            .then(response => response.json())
            .then(data => {
                Object.keys(data.files).forEach(file => {
                    const id = file.split(".")[0]
                    const url = "http://localhost:2007/assets/" + file + "?name=" + ADDON_NAME + "&"
                    assetsTracks[id] = url;
                });
                log("Tracks from assets:", assetsTracks);
            })
            .catch(() => {}); // локального asset-сервера может не быть — это нормально
    }

    updateAssetsTracks();

    /* из репозитория */
    let remoteTracks = {};
    let remoteExceptions = [];

    fetch("https://raw.githubusercontent.com/Hazzz895/FckCensorData/refs/heads/main/list.json")
        .then(response => response.json())
        .then(data => {
            remoteTracks = data.tracks;
            log("Tracks from remote repository:", remoteTracks);
            openDB().then(db => {
                const tx = db.transaction("remote_exceptions", 'readonly');
                const store = tx.objectStore("remote_exceptions");
                const request = store.getAll();

                request.onsuccess = () => {
                    remoteExceptions = request.result.map(item => item.id);
                };
            });
        })
        .catch(err => {
            console.error(`[${ADDON_NAME}] Ошибка при попытке получить список треков с удалённого репозитория: `, err)
        });

    // получение ссылки на трек
    function getReplaced(trackId) {
        if (!trackId) return null;
        trackId = String(trackId);
        let url = null;
        let src = null;
        if  (localTrackIds.map(String).includes(trackId)) {
            url = localTracksUrlCache[trackId];
            src = "local";
        }
        else if (assetsTracks[trackId]) {
            url = assetsTracks[trackId];
            src = "assets";
        }
        else if (remoteExceptions.includes(trackId)) {
            url = null;
            src = "remote_exception";
        }
        else if (remoteTracks[trackId]) {
            url = remoteTracks[trackId];
            src = "remote";
        }
        return url || src ? { url, src } : null;
    }

    function isReplaced(trackId) {
        const replacedData = getReplaced(trackId);
        return !!(replacedData && replacedData.src !== "remote_exception");
    }

    /* === RKN-decoy: сервер видит заглушку, клиент слышит реальный трек ===
       activeCover живёт только пока играет cover-сессия:
       { rknId, decoyId, ts }. Хук getLocalFileDownloadInfo(decoyId)
       отдаёт realAudio(rknId). Оверрайды — в IndexedDB decoy_overrides. */
    let activeCover = null;
    let coverServedAt = 0; // когда хук реально отдал подмену под decoyID: натив играет, свой Audio не нужен
    let decoyOverrides = {}; // rknId(String) -> decoyId(String)
    let autoDecoyCache = {}; // rknId(String) -> decoyId(String)

    function getActiveDecoyCover(nativeTrackId) {
        try {
            if (!activeCover) return null;
            if (Date.now() - (activeCover.ts || 0) > 1000 * 60 * 90) { activeCover = null; return null; }
            if (String(nativeTrackId) === String(activeCover.decoyId)) return activeCover;
            return null;
        } catch (_) { return null; }
    }
    function setActiveCover(rknId, decoyId) {
        activeCover = { rknId: String(rknId), decoyId: String(decoyId), ts: Date.now() };
        try { touchRknSession(); } catch (_) {}
        try { hlog("decoy cover " + rknId + " -> " + decoyId); } catch (_) {}
        log("Decoy cover set: RKN " + rknId + " served as " + decoyId);
    }
    function clearActiveCover(reason) {
        if (!activeCover) return;
        log("Decoy cover cleared (" + (reason || "?") + ")");
        activeCover = null;
        try { coverServedAt = 0; } catch (_) {}
        try { endRknSession(reason || "cover end"); } catch (_) {}
        try { updatePlayerbarReplacedMark(); } catch (_) {}
    }

    // Circuit breaker: один и тот же RKN-трек не долбим бесконечно.
    // Связка "модалка -> dismiss -> decoy-клик -> модалка" иначе уходит
    // в вечный цикл: синтетические клики, уведомления, сессии — и виснет страница.
    const decoyAttemptTs = {}; // rknId -> [ts...]
    const decoyNotifyTs = {};  // rknId -> lastTs
    function pruneTs(arr, windowMs) {
        try {
            const now = Date.now();
            return (arr || []).filter(t => (now - t) < windowMs);
        } catch (_) { return []; }
    }
    // не чаще 3 попыток в 60с на трек; вызов фиксирует попытку
    function claimDecoyAttempt(rknId) {
        try {
            rknId = String(rknId);
            const arr = pruneTs(decoyAttemptTs[rknId], 60000);
            if (arr.length >= 3) { try { hlog("decoy breaker BLOCK " + rknId); } catch (_) {} try { setHudErr("BREAKER"); } catch (_) {} return false; }
            arr.push(Date.now());
            decoyAttemptTs[rknId] = arr;
            return true;
        } catch (_) { return true; }
    }
    // уведомление о заглушке — не чаще раза в 30с на трек (защита от спама в цикле)
    function claimDecoyNotify(rknId) {
        try {
            rknId = String(rknId);
            const now = Date.now();
            if (now - (decoyNotifyTs[rknId] || 0) < 30000) return false;
            decoyNotifyTs[rknId] = now;
            return true;
        } catch (_) { return true; }
    }

    function loadDecoyOverrides() {
        return openDB().then(db => new Promise((resolve) => {
            try {
                if (!db.objectStoreNames.contains("decoy_overrides")) { resolve(); return; }
                const tx = db.transaction("decoy_overrides", 'readonly');
                const rq = tx.objectStore("decoy_overrides").getAll();
                rq.onsuccess = () => {
                    try {
                        decoyOverrides = {};
                        (rq.result || []).forEach(it => { if (it && it.id != null && it.decoyId) decoyOverrides[String(it.id)] = String(it.decoyId); });
                        log("Loaded decoy overrides:", decoyOverrides);
                    } catch (_) {}
                    resolve();
                };
                rq.onerror = () => resolve();
            } catch (_) { resolve(); }
        }));
    }
    function saveDecoyOverride(rknId, decoyId) {
        rknId = String(rknId); decoyId = String(decoyId);
        decoyOverrides[rknId] = decoyId;
        autoDecoyCache[rknId] = decoyId;
        return openDB().then(db => new Promise((resolve) => {
            try {
                const tx = db.transaction("decoy_overrides", 'readwrite');
                tx.objectStore("decoy_overrides").put({ id: rknId, decoyId });
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
                tx.onabort = () => resolve();
            } catch (_) { resolve(); }
        }));
    }
    function removeDecoyOverride(rknId) {
        rknId = String(rknId);
        delete decoyOverrides[rknId];
        delete autoDecoyCache[rknId];
        return openDB().then(db => new Promise((resolve) => {
            try {
                const tx = db.transaction("decoy_overrides", 'readwrite');
                tx.objectStore("decoy_overrides").delete(rknId);
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
                tx.onabort = () => resolve();
            } catch (_) { resolve(); }
        }));
    }

    // вытащить из fiber-узла не только id, но и albumId/доступность если есть
    function getTrackInfoFromNode(node) {
        const id = (() => { try { return getTrackIdFromNode(node); } catch (_) { return null; } })();
        let albumId = null, available = null, title = null;
        try {
            const reactFiberProp = node && typeof node === "object"
                ? Object.keys(node).find(key => key.startsWith("__reactFiber"))
                : null;
            const fiber = reactFiberProp ? node[reactFiberProp] : null;
            const children = fiber && fiber.memoizedProps && fiber.memoizedProps.children;
            const list = children ? (Array.isArray(children) ? children : [children]) : [];
            for (const child of list) {
                const t = child && child.props && child.props.track;
                if (t && (String(t.id) === String(id) || (!id && t.id))) {
                    try { albumId = t.albumId || t.album?.id || t.albums?.[0]?.id || albumId; } catch (_) {}
                    try { if (typeof t.available === "boolean") available = t.available; } catch (_) {}
                    try { title = t.title || title; } catch (_) {}
                    break;
                }
            }
        } catch (_) {}
        return { id: id ? String(id) : null, albumId: albumId ? String(albumId) : null, available, title };
    }

    function isRowDisabled(ctr) {
        try {
            if (ctr.classList?.contains("CommonTrack_root__vDyCm") || ctr.classList?.contains("CommonTrack_root_disabled__vDyCm")) return true;
            if (ctr.querySelector(".Meta_root_disabled__Dpx_M, .CommonControlsBar_controls_disabled__0RmLo")) return true;
            if ((ctr.getAttribute?.("aria-label") || "").includes("Воспроизведение недоступно")) return true;
            return false;
        } catch (_) { return false; }
    }

    // авто-заглушка: тот же альбом если опознался, иначе первый доступный трек на странице.
    // Никогда не возвращаем сам RKN-id, disabled-строки и remote_exception.
    function resolveAutoDecoy(rknId, hintRow) {
        rknId = String(rknId);
        try {
            if (autoDecoyCache[rknId]) {
                const c = autoDecoyCache[rknId];
                if (c !== rknId) return c;
            }
        } catch (_) {}
        if (typeof document === "undefined" || !document.querySelectorAll) return null;
        let hintAlbum = null;
        try { hintAlbum = hintRow ? getTrackInfoFromNode(hintRow.closest?.(".CommonTrack_root__i6shE") || hintRow).albumId : null; } catch (_) {}
        let candidates = [];
        try {
            document.querySelectorAll(".CommonTrack_root__i6shE").forEach(ctr => {
                let info = null;
                try { info = getTrackInfoFromNode(ctr); } catch (_) {}
                const tid = info && info.id;
                if (!tid || tid === rknId) return;
                if (isRowDisabled(ctr)) return;
                try { if (remoteExceptions.includes(tid)) return; } catch (_) {}
                candidates.push({ tid, albumId: info.albumId, ctr });
            });
        } catch (_) {}
        if (!candidates.length) return null;
        let pool = candidates;
        if (hintAlbum) {
            const same = candidates.filter(c => c.albumId && String(c.albumId) === String(hintAlbum));
            if (same.length) pool = same;
        }
        const decoy = pool[0].tid;
        autoDecoyCache[rknId] = decoy;
        return decoy;
    }

    function getDecoyFor(rknId, hintRow) {
        rknId = String(rknId);
        if (decoyOverrides[rknId]) return decoyOverrides[rknId];
        return resolveAutoDecoy(rknId, hintRow);
    }

    // апи для отправки заблюренных треков
    const api = {
        API_URL: "https://pzomqvgckpgkshxhpite.supabase.co/rest/v1/",
        KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6b21xdmdja3Bna3NoeGhwaXRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNTgzNDEsImV4cCI6MjA5MDYzNDM0MX0.ggCxM-ver3gDWUBWyhSBfy3n7rpdW8jtlxRQVCXkhNg",
        report(trackId, replaced) {
            if (!trackId) return;
            trackId = Number(trackId);
            if (isNaN(trackId) || this.reportedTracks.includes(trackId)) return;

            const targetTable = "reported_tracks";
            const body = {
                track_id: trackId,
                replaced
            }

            fetch(`${this.API_URL}${targetTable}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "apikey": this.KEY,
                    "Authorization": `Bearer ${this.KEY}`,
                },
                body: JSON.stringify(body)
            })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`Failed to report track. Status: ${response.status}`);
                }
                this.reportedTracks.push(trackId);
                openDB().then(db => {
                    const tx = db.transaction(targetTable, 'readwrite');
                    const store = tx.objectStore(targetTable);
                    store.put({ id: trackId });
                });
                log("Reported track " + trackId);
            })
            .catch(err => {
                console.error(`[${ADDON_NAME}] Failed to report track`, err);
            });
        },
        reportedTracks: [],
        loadReportedTracks() {
            openDB().then(db => {
                const tx = db.transaction("reported_tracks", 'readonly');
                const store = tx.objectStore("reported_tracks");
                const request = store.getAll();

                request.onsuccess = () => {
                    this.reportedTracks = request.result.map(item => item.id);
                };
            });
        },
        isReported(trackId) {
            if (!trackId) return;
            trackId = Number(trackId);
            return !isNaN(trackId) && this.reportedTracks.includes(trackId);
        }
    }

    api.loadReportedTracks();

    /* === контекстное меню подмены (сохранение в indexeddb) === */
    function onContextMenuReplaceClick(trackId, item) {
        const replaced = getReplaced(trackId);

        function reloadPlayer() { 
            const e = window.sonataState?.queueState?.currentEntity?.value?.entity;
            const mediaPlayer = window.sonataState?.currentMediaPlayer?.value?.currentMediaPlayer;
            if (e && mediaPlayer && e.entityData?.meta?.id == trackId) {
                mediaPlayer.reload(e);
                log("Player reloaded");
            }
        }

        function onSuccess() {
            reloadPlayer();
            updateReplaceItem(trackId, item);
            addReplacedMarks();
        }

        function notificate(replaced) {
            const text = !replaced ? "Трек успешно подменён" : "Трек восстановлен к оригиналу"
            postNotificationWithCover(text, trackId);
        }

        // если трек НЕ подменен, то открывается пикер файлов и затем он сохраняется в бд
        if (!replaced) {
            window.showOpenFilePicker({
                types:
                [
                    {
                        description: 'Аудио-файлы',
                        accept: { 'audio/*': ['.mp3', '.wav', '.ogg', '.flac'] }
                    }
                ],
                multiple: false 
            })
            .then(async (fileHandles) => {
                const fileHandle = fileHandles[0];

                const file = await fileHandle.getFile();
                if (!file.type.startsWith("audio/")) {
                    postNotification("Выбранный файл не является аудио-файлом.");
                    return;
                }
                const db = await openDB();

                localTrackIds.push(trackId)
                localTracksUrlCache[trackId] = URL.createObjectURL(file);

                const tx = db.transaction("tracks", 'readwrite');
                const store = tx.objectStore("tracks");
                
                store.put({ id: trackId, data: file });
                api.report(trackId, true);
                onSuccess();
                notificate(true);
                log("Added track " + trackId + " to local tracks");
            })
            .catch(err => {
                if (err.name !== 'AbortError') {
                    postNotification("Ошибка во время выбора файла, посмотрите консоль для подробной информации.")
                    console.error(`[${ADDON_NAME}] Ошибка при выборе файла:`, err);
                }
            });
        }
        // если трек есть в базе данных, то удаление
        else if (replaced.src == "local") {
            localTrackIds = localTrackIds.filter(id => id != trackId);
            
            if (localTracksUrlCache[trackId]) {
                URL.revokeObjectURL(localTracksUrlCache[trackId]);
                delete localTracksUrlCache[trackId];
            }
            
            openDB().then(db => {
                const tx = db.transaction("tracks", 'readwrite');
                const store = tx.objectStore("tracks");
                store.delete(trackId);
                onSuccess();
                notificate(false);
                log("Removed track " + trackId + " from local tracks");
            });
        }
        // если трек подменен из репозитория, то добавление в исключения
        else if (replaced.src == "remote") {
            remoteExceptions.push(trackId);
            openDB().then(db => {
                const tx = db.transaction("remote_exceptions", 'readwrite');
                const store = tx.objectStore("remote_exceptions");
                store.add({ id: trackId });
                onSuccess();
                notificate(true);
                log("Added track " + trackId + " to remote exceptions");
            });
        }
        // если трек в исключениях, то удаление оттуда
        else if (replaced.src == "remote_exception") {
            remoteExceptions = remoteExceptions.filter(id => id != trackId);
            openDB().then(db => {
                const tx = db.transaction("remote_exceptions", 'readwrite');
                const store = tx.objectStore("remote_exceptions");
                store.delete(trackId);
                onSuccess();
                notificate(false);
                log("Removed track " + trackId + " from remote exceptions");
            });
        }
        else {
            return;
        }
    }

    function updateReplaceItem(trackId, item) {
        const span = item.querySelector('span')
        const replaced = isReplaced(trackId);

        span.childNodes[0].firstElementChild.setAttribute("xlink:href", "/icons/sprite.svg#" + (replaced ? "close" : "edit") + "_xxs");
        span.childNodes[1].nodeValue = replaced ? "Удалить замену" : "Подменить трек";

        const ymTrackDownloadItem = item.parentElement?.querySelector('[data-test-id="CONTEXT_MENU_DOWNLOAD_BUTTON"]');
        if (ymTrackDownloadItem) {
            ymTrackDownloadItem.style.display = replaced ? "none" : "";
        }

        updateReportItem(trackId, item.parentElement?.querySelector('[data-test-id="CONTEXT_MENU_REPORT_BUTTON"]'))
        try { updateDecoyItem(trackId, item.parentElement?.querySelector('[data-test-id="CONTEXT_MENU_DECOY_BUTTON"]')); } catch (_) {}
    }

    function updateReportItem(trackId, item, forcedValue = undefined) {
        if (!item || !trackId) return;
        item.style.display = (forcedValue !== undefined && forcedValue !== null ? forcedValue : (api.isReported(trackId) || getReplaced(trackId))) ? "none" : "";
    }

    function updateDecoyItem(trackId, item) {
        if (!item || !trackId) return;
        try {
            const span = item.querySelector("span");
            const ov = decoyOverrides[String(trackId)];
            let auto = null;
            try { auto = getDecoyFor(String(trackId), null); } catch (_) {}
            const label = ov
                ? "Заглушка: " + ov + " (сбросить)"
                : "Заглушка: авто" + (auto ? " (" + auto + ")" : " (нет)");
            if (span && span.childNodes[1]) span.childNodes[1].nodeValue = label;
        } catch (_) {}
    }

    function onDecoyItemClick(trackId, item) {
        trackId = String(trackId);
        try {
            const ov = decoyOverrides[trackId];
            if (ov) {
                removeDecoyOverride(trackId).then(() => {
                    try { updateDecoyItem(trackId, item); } catch (_) {}
                    postNotification("Заглушка сброшена на авто");
                });
                return;
            }
            let current = null;
            try { current = getDecoyFor(trackId, null); } catch (_) {}
            if (typeof prompt !== "function") { try { postNotification("Выбор заглушки недоступен в этом окружении"); } catch (_) {} return; }
            const val = prompt("ID трека-заглушки для серверов (тот же альбом, доступный).\nПусто = оставить авто.", current || "");
            if (val === null) return; // отмена
            const clean = String(val || "").trim();
            if (!clean) {
                removeDecoyOverride(trackId).then(() => {
                    try { updateDecoyItem(trackId, item); } catch (_) {}
                    postNotification("Заглушка: авто");
                });
                return;
            }
            if (!/^\d+$/.test(clean)) { postNotification("Нужен числовой ID трека"); return; }
            if (clean === trackId) { postNotification("Заглушка не может совпадать с самим треком"); return; }
            saveDecoyOverride(trackId, clean).then(() => {
                try { updateDecoyItem(trackId, item); } catch (_) {}
                postNotification("Заглушка сохранена: серверы увидят трек " + clean);
            });
        } catch (e) { log("decoy click failed", e); }
    }

    // Дебаунс тяжёлого прохода меток: мутации сыплются постоянно
    // (прогресс, анимации), полный обход строк — не чаще раза в 400мс.
    let marksTimer = 0;
    function scheduleMarks() {
        try {
            if (marksTimer) return;
            marksTimer = setTimeout(() => {
                marksTimer = 0;
                try { addReplacedMarks(document.body || document.documentElement); } catch (_) {}
            }, 400);
        } catch (_) {}
    }

    // следим за dom-изменениями
    const observer = new MutationObserver(mutations => {
        try {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (!(node instanceof HTMLElement)) return;
                // появилось ли контекстное меню трека?
                const trackMenu = node?.querySelector("[data-test-id='TRACK_CONTEXT_MENU']:not(:has([data-test-id='CONTEXT_MENU_REPLACE_BUTTON']))");
                if (trackMenu) {
                    const button = (trackMenu.parentElement?.ariaLabelledByElements || trackMenu.ariaLabelledByElements)?.[0];
                    if (button) {
                        function createItems(trackId) {
                            const replaced = getReplaced(trackId);
                            if (trackId && replaced?.src != "assets") {
                                const downloadItem = trackMenu.querySelector('[data-test-id="CONTEXT_MENU_DOWNLOAD_BUTTON"]')
                                if (downloadItem) {
                                    // создаем кнопку подмены
                                    const replaceItem = downloadItem.cloneNode(true)
                                    replaceItem.setAttribute('data-test-id', 'CONTEXT_MENU_REPLACE_BUTTON');
                                    replaceItem.addEventListener('click', () => onContextMenuReplaceClick(trackId, replaceItem));

                                    downloadItem.parentElement.insertBefore(replaceItem, downloadItem.nextSibling);
                                    updateReplaceItem(trackId, replaceItem);

                                    // создаем кнопку репорта блюра
                                    const reportItem = downloadItem.cloneNode(true)
                                    reportItem.setAttribute('data-test-id', 'CONTEXT_MENU_REPORT_BUTTON');

                                    const span = reportItem.querySelector("span");
                                    span.childNodes[0].firstElementChild.setAttribute("xlink:href", "/icons/sprite.svg#" + "attention_xxxl");
                                    span.childNodes[1].nodeValue = "Сообщить о цензуре";

                                    reportItem.addEventListener('click', () => {
                                        api.report(trackId, false);
                                        updateReportItem(trackId, reportItem, true)
                                        postNotificationWithCover("Спасибо! Трек скоро будет добавлен в список автоматически заменяемых", trackId)
                                    });

                                    downloadItem.parentElement.insertBefore(reportItem, replaceItem.nextSibling);
                                    updateReportItem(trackId, reportItem)
                                    // Кнопка фиксированной заглушки УБРАНА (v1.7.0):
                                    // backend-подмена теперь случайным ID на сетевом слое,
                                    // один жертвенный трек больше не рискуем.
                                }
                            }
                        }
                        // а относится ли контекстное меню к плееру?
                        if (button.matches("[data-test-id='PLAYERBAR_DESKTOP_CONTEXT_MENU_BUTTON'], [data-test-id='FULLSCREEN_PLAYER_CONTEXT_MENU_BUTTON']") || closestPlayerBar(button)) {
                            const entity = window.pulsesyncApi?.getCurrentTrack();
                            createItems(entity?.id)
                        }
                        else {
                            const source = button.closest('.CommonTrack_root__i6shE');
                            if (source) {
                                const trackId = getTrackIdFromNode(source);
                                if (trackId) {
                                    createItems(trackId)
                                }
                            }
                        }
                    }
                }
            })
            
            // marks-скан только если реально добавились узлы, а не на каждую мутацию
            try {
                let hasAdded = false;
                for (const m of mutations) { if (m.addedNodes && m.addedNodes.length) { hasAdded = true; break; } }
                if (hasAdded) scheduleMarks();
            } catch (_) {}
        });
        } catch (_) {}
    });
    try {
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        } else {
            document.addEventListener("DOMContentLoaded", () => {
                try { observer.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
                try { addReplacedMarks(); } catch (_) {}
            });
        }
    } catch (_) {}

    /* === иконка подмены === */
    function createMark(node) {
        const metaCtr = node.querySelector(".Meta_titleContainer__gDuXr:not(:has(.Meta_replacedMarkContainer))")
        if (!metaCtr) return;
        const span = document.createElement("span");

        span.classList.add("Meta_replacedMarkContainer", "Meta_explicitMarkContainer__BxMQg")
        span.innerHTML = 
        `<svg 
            class="ExplicitMarkIcon_explicitMark__0BPeQ Meta_explicitMark__ocnCV Rkdd2vKC_3xa1eUdRdHP" 
            focusable="false" 
            aria-label="Трек подменен плагином ${ADDON_NAME}" 
            data-test-id="REPLACED_MARK_ICON">
                <use xlink:href="/icons/sprite.svg#edit_xxs">
                </use>
        </svg>`

        const trackOptionsButton = metaCtr.querySelector(`div:has([data-test-id="PLAYERBAR_DESKTOP_CONTEXT_MENU_BUTTON"])`);
        if (trackOptionsButton) {
            metaCtr.insertBefore(span, trackOptionsButton);
        }
        else {
            metaCtr.appendChild(span)
        }

        span.addEventListener("mouseenter", (ev) => {
            removeTooltip();
            const tooltip = document.createElement("div");
            tooltip.id = "AntiCensorTooltip";
            const bounding = ev.target.getBoundingClientRect();
            tooltip.innerHTML = 
            `<div 
                class="QhR4J536RmNHBB5bZYwF TooltipWithTitle_root__7jLY3" 
                data-test-id="TOOLTIP_WITH_TITLE" 
                tabindex="-1"
                role="tooltip" 
                style="position: absolute; left: 0px; top: 0px; visibility: visible; transform: translate(${bounding.left}px, ${bounding.top + bounding.height}px);">
                <div 
                    class="_MWOVuZRvUQdXKTMcOPx Ai2iRN9elHpk_u5splD6 _3_Mxw7Si7j2g4kWjlpR Fqg1VWCJUfasVVxqICeO">
                    <div 
                        class="TooltipWithTitle_text__ElBtq">
                        <span 
                            class="_MWOVuZRvUQdXKTMcOPx Ai2iRN9elHpk_u5splD6 ZYV27jeWd30QDXu4GhaH TooltipWithTitle_description__HsGcR"
                            >${ev.target.firstElementChild.ariaLabel}</span>
                    </div>
                </div>
                </div>`
            document.body.appendChild(tooltip);
            tooltip.addEventListener("mouseenter", (ev) => ev.target.remove());
        });
        span.addEventListener("mouseleave", (_) => removeTooltip());
    }

    function removeTooltip() {
        document.getElementById("AntiCensorTooltip")?.remove();
    }

    function getTrackIdFromNode(node) {
        try {
            if (!node || typeof node !== "object") return null;
            let trackId = null;
            const reactFiberProp = Object.keys(node).find(key => key.startsWith("__reactFiber"));
            if (reactFiberProp) {
                const fiber = node[reactFiberProp];
                const children = fiber && fiber.memoizedProps && fiber.memoizedProps.children;
                if (children) {
                    const list = Array.isArray(children) ? children : [children];
                    for (const child of list) {
                        trackId = child?.props?.track?.id;
                        if (trackId) break;
                    }
                }
            }

            if (!trackId) {
                const intersection = node.dataset && node.dataset.intersectionPropertyId;
                trackId = intersection?.match(/track_(\d+)/)?.[1];
            }
            return trackId || null;
        } catch (_) {
            return null;
        }
    }

    /* === RKN bypass: снятие disabled + чистка disclaimer === */
    function enableRknRow(ctr, trackId) {
        if (!ctr || !trackId) return;
        if (!isReplaced(trackId)) return;
        try {
            ctr.classList.remove("CommonTrack_root_disabled__vDyCm");
            const aria = ctr.getAttribute("aria-label");
            if (aria && aria.includes("Воспроизведение недоступно")) {
                ctr.setAttribute("aria-label", aria.replace("Воспроизведение недоступно ", ""));
            }
            ctr.querySelectorAll(".Meta_root_disabled__Dpx_M, .CommonControlsBar_controls_disabled__0RmLo").forEach(n => {
                n.classList.remove("Meta_root_disabled__Dpx_M", "CommonControlsBar_controls_disabled__0RmLo");
            });
            // NB: объекты треков в fiber ПРОПСАХ больше не трогаем — запись
            // внутрь React-инternals давала риск рассинхрона reconciler,
            // а на проигрывание (идёт своим Audio) не влияет.
        } catch (e) {
            log("enableRknRow failed", e);
        }
    }

    function addReplacedMarks(node = document.body) {
        const trackContainers = node.querySelectorAll ? node.querySelectorAll('.CommonTrack_root__i6shE') : [];
        trackContainers.forEach(ctr => {
            const trackId = getTrackIdFromNode(ctr);
            if (trackId) {
                const replaced = isReplaced(trackId);
                if (replaced) {
                    enableRknRow(ctr, trackId);
                    createMark(ctr);
                }
                else {
                    ctr.querySelector(".Meta_replacedMarkContainer")?.remove()
                }
            }
        })
        // одиночный контейнер (mutation.target может быть самой строкой трека)
        if (node.classList && node.classList.contains("CommonTrack_root__i6shE")) {
            const trackId = getTrackIdFromNode(node);
            if (trackId && isReplaced(trackId)) {
                enableRknRow(node, trackId);
                createMark(node);
            }
        }
        updatePlayerbarReplacedMark(node);
    }

    function updatePlayerbarReplacedMark(node = document.body) {
        try {
            if (!node || !node.querySelectorAll) return;
            const playerContainers = queryPlayerBars(node);
            if (playerContainers.length == 0) return;
            const entity = window.pulsesyncApi?.getCurrentTrack?.();
            const replaced = isReplaced(entity?.id);
            // decoy-сессия: натив играет decoyId, а показать надо реальный RKN-трек
            let cover = null;
            try { cover = entity?.id ? getActiveDecoyCover(String(entity.id)) : (typeof activeCover !== "undefined" ? activeCover : null); } catch (_) {}
            playerContainers.forEach(ctr => {
                if (cover) {
                    // cover-сессия: DOM плеербара НЕ трогаем вообще.
                    // Запись textContent/вставка span в живой React-узел плеербара
                    // роняет reconciler на каждом ререндере (прогресс) — страница виснет.
                    // Что реально играет: уведомление + HUD + MediaSession (уровень ОС).
                    try { setupDecoyMediaSession(cover.rknId, cover.decoyId); } catch (_) {}
                    createMark(ctr);
                }
                else if (replaced) {
                    createMark(ctr);
                }
                else {
                    ctr.querySelectorAll(".Meta_replacedMarkContainer").forEach(rpctr => {
                        rpctr.remove();
                    })
                }
            })
        }
        catch (e) {
            console.error(e)
        }
    }

    // Метаданные ОС-уровня для cover-сессии: только чтение DOM + MediaSession.
    // Никаких записей в React-узлы — безопасно вызывать хоть каждую секунду.
    // Принцип честного клиента: названия и обложки треков НЕ переписываем нигде.
    // Что звучит и что видит сервер — сообщаем уведомлением и MediaSession.
    const decoyTitleCache = {};
    function titleForTrackId(trackId) {
        try {
            trackId = String(trackId);
            if (decoyTitleCache[trackId]) return decoyTitleCache[trackId];
            const rows = document.querySelectorAll(".CommonTrack_root__i6shE");
            for (const r of rows) {
                let tid = null;
                try { tid = getTrackIdFromNode(r); } catch (_) {}
                if (tid && String(tid) === trackId) {
                    let t = null;
                    try { t = trackTitleFromRow(r); } catch (_) {}
                    if (t) { try { decoyTitleCache[trackId] = t; } catch (_) {} return t; }
                    break;
                }
            }
            // из строки не вышло — берём из кэша API-метаданных
            try {
                const mc = metaCacheGet(trackId);
                if (mc && mc.title) { try { decoyTitleCache[trackId] = mc.title; } catch (_) {} return mc.title; }
            } catch (_) {}
        } catch (_) {}
        return null;
    }
    function setupDecoyMediaSession(rknId, decoyId) {
        try {
            if (!("mediaSession" in navigator) || !navigator.mediaSession) return;
            rknId = String(rknId);
            const realTitle = titleForTrackId(rknId);
            try {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: realTitle || ("Трек " + rknId),
                    artist: "AntiCensor",
                    album: "Разблокировано (сервер видит " + decoyId + ")"
                });
            } catch (_) {}
        } catch (_) {}
    }

    /* === RKN: безусловная глушилка модалки ===
       Ставится ДО всего остального и не зависит от isReplaced/list.json:
       если модалка про Роскомнадзор — она сносится сразу, без мигания. */
    let lastRknForceTs = 0;
    let rknCssTimer = null;
    let rknCssHold = false;
    let antiAudio = null;
    let antiTrackId = null;
    let lastAntiTrackId = null; // для сброса таймера при смене трека
    let pendingRknTrackId = null;
    // Метка программных кликов (silenceNative/dismiss): наши document-слушатели
    // такие события игнорируют, иначе доверенный .click() по нативной кнопке
    // re-enter'ится в handleRknPress, обновляет lastTrackClick fiber-id плеербара
    // и убивает своё же аудио через pauseOwnAudio. Нативные обработчики идут штатно.
    let programmaticClickTs = 0;
    function markProgrammaticClick() { try { programmaticClickTs = Date.now(); } catch (_) {} }
    function isProgrammaticClick() {
        try { return (Date.now() - programmaticClickTs) < 800; } catch (_) { return false; }
    }

    try { console.log("[CensorAbuse] " + CODE_VERSION + " loaded"); } catch (_) {}

    // Счётчик ЛЮБЫХ кликов в документе: доказывает, доходят ли нажатия
    // до нашего документа вообще (или музыкальный UI живёт отдельно).
    function countAnyClick() {
        try { if (isProgrammaticClick()) return; } catch (_) {}
        try { hudState.clicks++; updateHud(); } catch (_) {}
    }
    try { document.addEventListener("pointerdown", countAnyClick, true); } catch (_) {}

    /* === Бортовой самописец: консоль летит слишком быстро, а сюда падает
       только последнее состояние. HUD клики пропускает (pointer-events:none),
       состояние также доступно через window.__antiCensorDump() в консоли. */
    const antiLog = [];
    let hudEl = null;
    const hudState = { clicks: 0, press: "-", play: "-", modals: 0, blocked: 0, sess: 0, err: "-", aud: 0 };
    // видимая строка последней ошибки прямо в HUD — для слепой отладки без консоли
    function setHudErr(msg) {
        try {
            hudState.err = String(msg || "-").slice(0, 24);
            updateHud();
        } catch (_) {}
    }
    function hlog(msg) {
        try {
            antiLog.push(new Date().toISOString().slice(11, 19) + " " + String(msg).slice(0, 160));
            if (antiLog.length > 200) antiLog.splice(0, antiLog.length - 200);
        } catch (_) {}
        updateHud();
    }
    try {
        window.__antiCensorLog = antiLog;
        window.__antiCensorDump = () => { try { return antiLog.join("\n"); } catch (_) { return ""; } };
        window.__antiCensorDiag = function() { try { return collectDiag(); } catch (e) { return { err: String((e && e.message) || e) }; } };
        window.__antiCensorDecoy = {
            cover: () => { try { return activeCover; } catch (_) { return null; } },
            overrides: () => { try { return { ...decoyOverrides }; } catch (_) { return {}; } },
            for: (rknId) => { try { return getDecoyFor(String(rknId), null); } catch (_) { return null; } },
            clear: () => { try { clearActiveCover("manual"); } catch (_) {} },
        };
    } catch (_) {}
    // Диагностика окружения: какие методы реально есть у плеера.
    // Вывод — через window.__antiCensorDiag() в консоли, текстом можно прислать разработчику.
    function safeKeys(obj, limit) {
        try {
            if (!obj) return null;
            if (typeof obj !== "object" && typeof obj !== "function") return String(obj).slice(0, 80);
            return Object.keys(obj).slice(0, limit || 60);
        } catch (_) { return "?"; }
    }
    function collectDiag() {
        const out = {};
        try { out.href = String(location.href).slice(0, 120); } catch (_) {}
        try { out.apiKeys = safeKeys(window.pulsesyncApi); } catch (_) {}
        try {
            const api = window.pulsesyncApi || {};
            out.apiFns = ["play", "playTrack", "playTrackById", "startTrack", "setTrack", "getCurrentTrack", "_waitForPlayer"].map(n => {
                try { return n + ":" + typeof api[n]; } catch (_) { return n + ":?"; }
            });
        } catch (_) {}
        try { out.sonataKeys = safeKeys(window.sonataState, 40); } catch (_) {}
        try {
            const s = window.sonataState || {};
            const mp = s.currentMediaPlayer && s.currentMediaPlayer.value && s.currentMediaPlayer.value.currentMediaPlayer;
            out.mediaPlayerKeys = safeKeys(mp, 60);
            out.queueKeys = safeKeys(s.queueState, 40);
        } catch (_) {}
        try { out.apiDump = window.__antiCensorApi || null; } catch (_) {}
        try { out.current = window.pulsesyncApi?.getCurrentTrack?.() || null; } catch (e) { out.currentErr = String((e && e.message) || e); }
        try { out.cover = activeCover; } catch (_) {}
        try { out.overrides = decoyOverrides; } catch (_) {}
        try {
            const rows = document.querySelectorAll(".CommonTrack_root__i6shE");
            out.rows = rows.length;
            let dis = 0;
            rows.forEach(r => { try { if (isRowDisabled(r)) dis++; } catch (_) {} });
            out.disabledRows = dis;
        } catch (_) {}
        try { out.fetchWrapped = !!window.__antiCensorFetchWrapped; } catch (_) {}
        try { out.xhrWrapped = !!window.__antiCensorXhrWrapped; } catch (_) {}
        try { out.backendPoolSize = backendPool.size; out.backendPool = [...backendPool].slice(0, 30); } catch (_) {}
        try { out.netSeen = netSeen; } catch (_) {}
        try { out.spoofWrite = BACKEND_SPOOF_WRITE; } catch (_) {}
        try { out.logTail = antiLog.slice(-40); } catch (_) {}
        return out;
    }
    // HUD полностью выпилен по требованию: никакого видимого оверлея.
    // Функции оставлены пустышками, чтобы не трогать десятки мест вызова.
    function updateHud() {}
    function ensureHud() {
        // заодно сносим плашку от старых версий, если осталась в DOM
        try { document.getElementById("AntiCensorHud")?.remove(); } catch (_) {}
    }
    try { ensureHud(); } catch (_) {}

    // CSS-страховка: React пересоздаёт снесённые узлы быстрее, чем их видит
    // MutationObserver. Пока взведён класс — оверлей и модалка скрыты стилями,
    // их перерисовка ни на что не влияет.
    function ensureRknCss() {
        try {
            if (document.getElementById("AntiCensorRknCss")) return;
            const st = document.createElement("style");
            st.id = "AntiCensorRknCss";
            st.textContent = 'html.anticensor-rkn [class*="DisclaimerModal_overlay"],html.anticensor-rkn [data-test-id="DISCLAIMER_MODAL"]{display:none!important;pointer-events:none!important;opacity:0!important}';
            (document.head || document.documentElement).appendChild(st);
        } catch (_) {}
    }
    function armRknCss(ms) {
        try {
            ensureRknCss();
            document.documentElement.classList.add("anticensor-rkn");
            if (rknCssTimer) { try { clearTimeout(rknCssTimer); } catch (_) {} rknCssTimer = null; }
            if (!rknCssHold) {
                rknCssTimer = setTimeout(() => {
                    try { if (!rknCssHold) document.documentElement.classList.remove("anticensor-rkn"); } catch (_) {}
                }, typeof ms === "number" ? ms : 3000);
            }
        } catch (_) {}
    }
    // пока играет наша подмена — класс не снимаем, иначе React перерисует
    // оверлей поверх страницы
    function setRknCssHold(on) {
        rknCssHold = !!on;
        try {
            if (on) {
                armRknCss();
            } else {
                if (rknCssTimer) { try { clearTimeout(rknCssTimer); } catch (_) {} rknCssTimer = null; }
                rknCssTimer = setTimeout(() => {
                    try { document.documentElement.classList.remove("anticensor-rkn"); } catch (_) {}
                }, 2000);
            }
        } catch (_) {}
    }
    try { ensureRknCss(); } catch (_) {}

    function unlockBodyScroll() {
        try {
            if (document.body && document.body.style && document.body.style.overflow === "hidden") {
                document.body.style.overflow = "";
            }
        } catch (_) {}
        try {
            if (document.documentElement && document.documentElement.style && document.documentElement.style.overflow === "hidden") {
                document.documentElement.style.overflow = "";
            }
        } catch (_) {}
    }

    // Поиск модалок-дисклеймеров по нескольким селекторам: test-id и классы
    // в актуальных сборках отличаются. Возвращает [{root, text}].
    function findDisclaimerModals() {
        const found = [];
        const seen = new Set();
        let roots = [];
        try {
            roots = roots.concat([...document.querySelectorAll('[data-test-id="DISCLAIMER_MODAL"]')]);
        } catch (_) {}
        try {
            roots = roots.concat([...document.querySelectorAll('[class*="DisclaimerModal_root"]')]);
        } catch (_) {}
        try {
            [...document.querySelectorAll('[data-test-id="DISCLAIMER_CONTENT"]')].forEach(c => {
                let d = null;
                try { d = c.closest('[role="dialog"]') || c; } catch (_) { d = c; }
                if (d) roots.push(d);
            });
        } catch (_) {}
        roots.forEach(root => {
            try {
                if (!root || seen.has(root)) return;
                seen.add(root);
                let title = "", desc = "";
                try { title = root.querySelector('[data-test-id="DISCLAIMER_TITLE"]')?.textContent || ""; } catch (_) {}
                try { desc = root.querySelector('[data-test-id="DISCLAIMER_DESCRIPTION"]')?.textContent || ""; } catch (_) {}
                if (!title && !desc) {
                    try {
                        const h = root.querySelector("h4");
                        title = (h && h.textContent) || "";
                    } catch (_) {}
                    if (title) {
                        try { desc = root.textContent || ""; } catch (_) {}
                    }
                }
                if (title || desc) found.push({ root, text: (title + " " + desc) });
            } catch (_) {}
        });
        return found;
    }

    // Заблокированный трек, а не возрастной дисклеймер: узнаём по смыслу.
    function isBlockedTrackText(text) {
        try {
            const s = String(text || "");
            if (/роскомнадзор/i.test(s)) return true;
            if (/не получится послушать/i.test(s)) return true;
            if (/недоступен/i.test(s) && /требованию/i.test(s)) return true;
            if (/unavailable/i.test(s) && /request/i.test(s)) return true;
            return false;
        } catch (_) { return false; }
    }
    // прямой modal.remove() ломает reconciler (NotFoundError в removeChild ->
    // экран "Что-то пошло не так"). Клик по "Понятно" даёт React размонтировать
    // модалку самому, а CSS-класс прячет её мгновенно без мигания.
    // RKN-сессия: от первого форсированного включения до клика по обычному
    // треку (или 90с тишины). Пока сессия жива — держим CSS-холд, чтобы
    // осиротевший оверлей (React его не размонтировал) не стал невидимой
    // кликопоглощающей стеной на весь экран — это и есть "намертво встало".
    let rknSessionActive = false;
    let rknSessionTimer = 0;
    function touchRknSession() {
        rknSessionActive = true;
        try { if (rknSessionTimer) clearTimeout(rknSessionTimer); } catch (_) {}
        try {
            rknSessionTimer = setTimeout(() => {
                rknSessionActive = false;
                try { setRknCssHold(false); } catch (_) {}
                try { hlog("rkn session expired"); } catch (_) {}
            }, 90000);
        } catch (_) {}
        try { setRknCssHold(true); } catch (_) {}
    }
    function endRknSession(reason) {
        if (!rknSessionActive && !antiTrackId) return;
        rknSessionActive = false;
        try { if (rknSessionTimer) { clearTimeout(rknSessionTimer); rknSessionTimer = null; } } catch (_) {}
        try { setRknCssHold(false); } catch (_) {}
        try { hlog("rkn session end: " + reason); } catch (_) {}
    }

    // Анти-шторм: если модалка переоткрывается быстрее, чем мы её закрываем
    // (плеер упёрся в блок), не долбим кнопку бесконечно — только прячем.
    let dismissTimes = [];
    let dismissCooldownUntil = 0;
    const modalDismissBySig = {}; // подпись модалки -> {n, start}: cap залипших dismiss
    function dismissAllowed() {
        try {
            const now = Date.now();
            if (now < dismissCooldownUntil) return false;
            dismissTimes = dismissTimes.filter(t => now - t < 5000);
            if (dismissTimes.length >= 6) {
                dismissCooldownUntil = now + 15000;
                try { hlog("dismiss storm: cooldown 15s"); } catch (_) {}
                return false;
            }
            dismissTimes.push(now);
            return true;
        } catch (_) { return true; }
    }
    function dismissRknModal(modal) {
        try { armRknCss(); } catch (_) {}
        if (!dismissAllowed()) return false;
        try {
            const btn = modal.querySelector('[data-test-id="DISCLAIMER_REJECT_BUTTON"]')
                || modal.querySelector("button");
            if (btn) { try { markProgrammaticClick(); } catch (_) {} try { btn.click(); } catch (_) {} return true; }
        } catch (_) {}
        return false;
    }

    // Троттлинг свипа: observer дёргается на каждую мутацию страницы
    // (аудио-прогресс, анимации), дорогой проход — не чаще раза в 250мс.
    let lastRknSweep = 0;
    function killRknModals(force) {
        try {
            const now = Date.now();
            if (!force && (now - lastRknSweep) < 250) return;
            lastRknSweep = now;
        } catch (_) {}
        let found = [];
        try { found = findDisclaimerModals(); } catch (_) { return; }
        if (!found.length) {
            let overlayPresent = false;
            try { overlayPresent = !!document.querySelector('[class*="DisclaimerModal_overlay"]'); } catch (_) {}
            if (!overlayPresent) return;
            // остаточное затемнение: узел чужой — только прячем стилями,
            // чужие (не-RKN) оверлеи не трогаем
            try {
                if (pendingRknTrackId || (Date.now() - lastRknForceTs < 5000) || rknCssHold) {
                    armRknCss();
                    unlockBodyScroll();
                }
            } catch (_) {}
            return;
        }
        let killedRkn = false;
        let otherModal = false;
        found.forEach(({ root, text }) => {
            try {
                if (isBlockedTrackText(text)) {
                    // per-track cap: залипшую модалку (натив не уходит с трека)
                    // не дёргаем бесконечно — иначе вечный цикл dismiss/reopen вешает страницу.
                    // Просто держим CSS-холд чтобы оверлей не жрал клики.
                    let capped = false;
                    try {
                        const sig = String(text || "").slice(0, 80);
                        const now = Date.now();
                        let rec = modalDismissBySig[sig] || { n: 0, start: now };
                        if (now - rec.start > 60000) { rec = { n: 0, start: now }; }
                        if (rec.n >= 4) { capped = true; }
                        else { rec.n++; modalDismissBySig[sig] = rec; }
                        if (Object.keys(modalDismissBySig).length > 20) {
                            try {
                                for (const k of Object.keys(modalDismissBySig)) {
                                    if (now - modalDismissBySig[k].start > 60000) delete modalDismissBySig[k];
                                }
                            } catch (_) {}
                        }
                    } catch (_) {}
                    if (capped) {
                        try { hlog("modal dismiss CAP, css hold only"); } catch (_) {}
                        try { setHudErr("MODAL CAP"); } catch (_) {}
                        try { armRknCss(); } catch (_) {}
                        try { unlockBodyScroll(); } catch (_) {}
                        killedRkn = true;
                        return;
                    }
                    log("Killing DISCLAIMER_MODAL");
                    dismissRknModal(root);
                    killedRkn = true;
                    try { hudState.modals++; hlog("modal killed"); } catch (_) {}
                    try { handleShownRknModal(root); } catch (_) {}
                } else {
                    otherModal = true;
                }
            } catch (_) {
                try { armRknCss(); killedRkn = true; } catch (_) {}
            }
        });
        const activeWindow = pendingRknTrackId || (Date.now() - lastRknForceTs < 5000) || rknCssHold;
        if (killedRkn || activeWindow || rknSessionActive) {
            let overlayPresent = false;
            try { overlayPresent = !!document.querySelector('[class*="DisclaimerModal_overlay"]'); } catch (_) {}
            if (killedRkn || rknSessionActive || (overlayPresent && !otherModal)) {
                // оверлей — отдельный React-узел: не вырываем, только прячем
                // стилями, иначе страница остаётся затемнённой и клики мертвы
                try { armRknCss(); } catch (_) {}
                unlockBodyScroll();
            }
        }
    }
    // страховка интервалом: если React перерисовал оверлей между мутациями —
    // добьём по таймеру.
    try { setInterval(() => { try { killRknModals(false); } catch (_) {} }, 1200); } catch (_) {}

    try {
        // ВАЖНО: колбэк обёрнут и НЕ принимает mutations как force.
        // Раньше сюда передавался сам killRknModals: observer подставлял
        // массив мутаций первым аргументом, троттлинг 250мс отключался,
        // и ПОЛНЫЙ проход по документу шёл на КАЖДУЮ мутацию страницы
        // (прогресс, анимации — десятки раз в секунду). Так и вешало вкладку.
        const rknModalObserver = new MutationObserver(() => { try { killRknModals(false); } catch (_) {} });
        rknModalObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
    try { killRknModals(); } catch (_) {}

    /* === RKN bypass: прямое проигрывание подмены, без нативного плеера ===
       Нативная проверка блокировки срабатывает раньше getLocalFileDownloadInfo,
       поэтому        disabled-строки перехватываем в capture-фазе (pointerdown/mousedown/click)
       и играем URL замены своим Audio-элементом. */
    // (antiAudio/antiTrackId/pendingRknTrackId объявлены выше, до первого использования)

    // Медиа-клавиши и системный оверлей (пауза/плей + название) для нашей
    // подмены: нативный плеербар подменить нельзя, но ОС-уровень — можно.
    // Канал 1 для Discord RPC: MediaSession (читают ArRPC/Vesktop/мосты) +
    // канал 2: document.title (читают скреперы заголовка). Оба — только факты
    // о выбранном треке, ничего лишнего.
    let origDocTitle = null;
    function rpcNowPlaying(trackId) {
        try {
            const m = ownedMeta && String(ownedMeta.trackId) === String(trackId) ? ownedMeta : null;
            const title = (m && m.title) || ("Трек " + trackId);
            const artist = (m && m.artist) || "CensorAbuse";
            const album = (m && m.albumTitle) || "";
            try {
                if (("mediaSession" in navigator) && navigator.mediaSession) {
                    const md = { title, artist };
                    if (album) md.album = album;
                    try {
                        if (m && m.cover) md.artwork = [{ src: m.cover, sizes: "512x512", type: "image/jpeg" }];
                    } catch (_) {}
                    try { navigator.mediaSession.metadata = new MediaMetadata(md); } catch (_) {}
                    try { navigator.mediaSession.playbackState = "playing"; } catch (_) {}
                }
            } catch (_) {}
            // document.title — второй канал
            try {
                if (origDocTitle == null) origDocTitle = document.title;
                const t = artist ? (artist + " – " + title) : title;
                if (document.title !== t) document.title = t;
            } catch (_) {}
            try { console.log("[CensorAbuse] rpc playing: " + title); } catch (_) {}
        } catch (_) {}
    }
    function rpcPaused() {
        try {
            if (("mediaSession" in navigator) && navigator.mediaSession) {
                try { navigator.mediaSession.playbackState = "paused"; } catch (_) {}
            }
        } catch (_) {}
    }
    function rpcStopped() {
        try {
            if (("mediaSession" in navigator) && navigator.mediaSession) {
                try { navigator.mediaSession.playbackState = "none"; } catch (_) {}
            }
        } catch (_) {}
        try {
            if (origDocTitle != null && document.title !== origDocTitle) document.title = origDocTitle;
        } catch (_) {}
    }
    function setupMediaSession(trackId, row) {
        try {
            if (!("mediaSession" in navigator) || !navigator.mediaSession) return;
            const title = (row ? trackTitleFromRow(row) : null) || ("Трек " + trackId);
            try {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: title,
                    artist: "CensorAbuse",
                    album: "CensorAbuse"
                });
            } catch (_) {}
            try { navigator.mediaSession.setActionHandler("play", () => { try { ensureAntiAudio().play(); } catch (_) {} }); } catch (_) {}
            try { navigator.mediaSession.setActionHandler("pause", () => { try { ensureAntiAudio().pause(); } catch (_) {} }); } catch (_) {}
            try { navigator.mediaSession.setActionHandler("previoustrack", () => { try { advanceVisibleList("prev"); } catch (_) {} }); } catch (_) {}
            try { navigator.mediaSession.setActionHandler("nexttrack", () => { try { advanceVisibleList("next"); } catch (_) {} }); } catch (_) {}
        } catch (_) {}
    }

    // Слушатели вынесены из ensureAntiAudio в именованные функции:
    // при замене элемента (фолбэк EQ) новый получает то же поведение.
    function onAntiEnded() {
        let finishedId = null;
        try { finishedId = antiTrackId; } catch (_) {}
        let finishedCtx = null;
        try { finishedCtx = ownedMeta && String(ownedMeta.trackId) === String(finishedId) ? ownedMeta.playContainer : null; } catch (_) {}
        antiTrackId = null;
        try { setRknCssHold(false); } catch (_) {}
        try { clearOwnedMeta(); } catch (_) {}
        try { restorePlayIcons(); } catch (_) {}
        try { rpcStopped(); } catch (_) {}
        // авто-переход унифицирован: тот же сосед по видимому списку,
        // что и у кнопок next/prev (там же контекст альбома)
        try {
            if (!finishedId) return;
            if (Date.now() < manualPauseUntil) return;
            advanceVisibleList("next", finishedId, finishedCtx);
        } catch (_) {}
    }
    function onAntiPause() {
        // снимаем подсветку disabled-строки при паузе
        if (antiTrackId) markAntiPlaying(antiTrackId, false);
        try { setRknCssHold(false); } catch (_) {}
        try { rpcPaused(); } catch (_) {}
    }
    function onAntiPlay() {
        if (antiTrackId) markAntiPlaying(antiTrackId, true);
        try { setRknCssHold(true); } catch (_) {}
        try { if (antiTrackId) rpcNowPlaying(antiTrackId); } catch (_) {}
    }
    function wireAntiAudio(el) {
        try {
            if (!el || el.__antiWired) return el;
            el.__antiWired = true;
            el.addEventListener("ended", onAntiEnded);
            el.addEventListener("pause", onAntiPause);
            el.addEventListener("play", onAntiPlay);
        } catch (_) {}
        return el;
    }
    function ensureAntiAudio() {
        if (!antiAudio) {
            antiAudio = new Audio();
            antiAudio.preload = "auto";
            wireAntiAudio(antiAudio);
        }
        return antiAudio;
    }

    /* === Эквалайзер на наш Audio (R4) ===
       Нативный EQ крутит чужой (невидимый) тракт, наш Audio его не слышит.
       Поэтому при не-flat настройках строим свой граф:
         MediaElementSource -> 10×peaking(Q=1) -> preamp Gain -> destination.
       Частоты парсим из aria-label ползунков ("на частоте 60", "1k"->1000).
       Безопасность вслепую:
       - граф строим ТОЛЬКО при не-flat (иначе прямой тракт, ноль риска);
       - crossOrigin ставим только в ветке графа и только до загрузки;
       - AudioContext без жеста (suspended + нет активации) — только прямой тракт;
       - любая ошибка сборки/загрузки — свежий прямой элемент, звук не рвётся. */
    let eqCtx = null;       // {ac, el, src, filters:Map, pre} | null
    let eqWasOn = false;    // для лога переходов
    let eqCorsDead = false; // CORS уже ронял загрузку — граф больше не строим
    let eqNoSlidersLogged = false;
    let eqTaintLogged = false;
    // Поиск по всем документам СКВОЗЬ открытые shadow roots:
    // doc.querySelectorAll тень не пробивает, а панель EQ живёт именно там.
    function queryAllDeep(selector, limit) {
        const found = [];
        const max = limit || 50;
        try {
            collectDocs().forEach(doc => {
                if (found.length >= max) return;
                try {
                    findInShadows(doc, selector, max - found.length).forEach(n => {
                        if (found.length < max) found.push(n);
                    });
                } catch (_) {}
            });
        } catch (_) {}
        return found;
    }
    function readEqSettings() {
        try {
            const sliders = queryAllDeep('input[data-test-id="EQUALIZER_FREQUENCY_SLIDER"]', 30);
            const bands = [];
            sliders.forEach(s => {
                try {
                    const aria = s.getAttribute("aria-label") || "";
                    const m = aria.match(/частоте\s+([\d.,]+)\s*(k?)/i);
                    if (!m) return;
                    let f = parseFloat(String(m[1]).replace(",", "."));
                    if (!isFinite(f)) return;
                    if (m[2] && /k/i.test(m[2])) f *= 1000;
                    const g = parseFloat(s.value);
                    bands.push({ freq: f, gain: isFinite(g) ? g : 0 });
                } catch (_) {}
            });
            if (!bands.length) return null;
            // дедуп по частоте: две копии панели (мини+фулскрин) иначе дали бы
            // двойные фильтры и удвоенный гейн
            try {
                const seen = new Set();
                for (let i = bands.length - 1; i >= 0; i--) {
                    const k = Math.round(bands[i].freq);
                    if (seen.has(k)) bands.splice(i, 1);
                    else seen.add(k);
                }
            } catch (_) {}
            let preamp = 1;
            try {
                const pre = queryAllDeep('input[data-test-id="EQUALIZER_PREAMP_SLIDER"]', 1)[0] || null;
                if (pre) { const v = parseFloat(pre.value); if (isFinite(v)) preamp = v; }
            } catch (_) {}
            const flat = bands.every(b => Math.abs(b.gain) < 1e-9) && Math.abs(preamp - 1) < 1e-9;
            return { bands, preamp, flat };
        } catch (_) { return null; }
    }
    function applyEqSettings(st) {
        try {
            if (!eqCtx) return false;
            (st.bands || []).forEach(b => {
                try {
                    const n = eqCtx.filters.get(Math.round(b.freq));
                    if (n) n.gain.value = b.gain;
                } catch (_) {}
            });
            try { if (eqCtx.pre) eqCtx.pre.gain.value = st.pre; } catch (_) {}
            return true;
        } catch (_) { return false; }
    }
    function buildEqChain(srcNode, st) {
        try {
            const ac = eqCtx.ac;
            try { srcNode.disconnect(); } catch (_) {}
            const filters = new Map();
            let head = srcNode;
            st.bands.forEach(b => {
                try {
                    const f = ac.createBiquadFilter();
                    f.type = "peaking";
                    f.frequency.value = b.freq;
                    f.Q.value = 1;
                    f.gain.value = b.gain;
                    head.connect(f);
                    head = f;
                    filters.set(Math.round(b.freq), f);
                } catch (_) {}
            });
            const pre = ac.createGain();
            try { pre.gain.value = st.pre; } catch (_) {}
            head.connect(pre);
            // лимитер в конце: соседние полосы по +12дБ дают под +20дБ суммарно,
            // без него — жёсткий клиппинг. На обычном материале прозрачен.
            const comp = ac.createDynamicsCompressor();
            try {
                comp.threshold.value = -6;
                comp.ratio.value = 12;
                comp.attack.value = 0.003;
                comp.release.value = 0.25;
            } catch (_) {}
            pre.connect(comp);
            comp.connect(ac.destination);
            eqCtx.src = srcNode;
            eqCtx.el = antiAudio;
            eqCtx.filters = filters;
            eqCtx.pre = pre;
            return true;
        } catch (_) { return false; }
    }
    function swapAntiAudioDirect(reason) {
        try {
            try { if (antiAudio && !antiAudio.paused) antiAudio.pause(); } catch (_) {}
            try { if (antiAudio) antiAudio.removeAttribute("src"); } catch (_) {}
            try { if (antiAudio) antiAudio.load(); } catch (_) {}
            eqCtx = null;
            eqWasOn = false;
            eqCorsDead = true;
            const el = new Audio();
            try { el.preload = "auto"; } catch (_) {}
            wireAntiAudio(el);
            antiAudio = el;
            try { console.log("[CensorAbuse] eq fail → direct (" + reason + ")"); } catch (_) {}
        } catch (_) {}
        return true;
    }
    function onEqMediaError() {
        try { swapAntiAudioDirect("eq media error (CORS?)"); } catch (_) {}
    }
    function onEqSliderInput(e) {
        try {
            const t = e.target;
            if (!t || t.tagName !== "INPUT" || t.type !== "range") return;
            let tid = "";
            try { tid = t.getAttribute("data-test-id") || ""; } catch (_) {}
            if (tid !== "EQUALIZER_FREQUENCY_SLIDER" && tid !== "EQUALIZER_PREAMP_SLIDER") return;
            // графа нет — строим только на чистом элементе: если в элемент уже
            // загружен звук без CORS, привязка источника даст тишину (tainted).
            // Тогда честно ждём следующий трек (там ensureEqGraph отработает до src).
            if (!eqCtx) {
                let loaded = false;
                try { loaded = !!(antiAudio && antiAudio.currentSrc); } catch (_) {}
                if (loaded) {
                    try {
                        if (!eqTaintLogged) { eqTaintLogged = true; console.log("[CensorAbuse] eq applies from next track"); }
                    } catch (_) {}
                    return;
                }
                try { ensureEqGraph(); } catch (_) {}
                if (!eqCtx) return;
            }
            if (tid === "EQUALIZER_PREAMP_SLIDER") {
                try {
                    const v = parseFloat(t.value);
                    if (isFinite(v) && eqCtx.pre) eqCtx.pre.gain.value = v;
                } catch (_) {}
                return;
            }
            try {
                const aria = t.getAttribute("aria-label") || "";
                const m = aria.match(/частоте\s+([\d.,]+)\s*(k?)/i);
                if (!m) return;
                let f = parseFloat(String(m[1]).replace(",", "."));
                if (!isFinite(f)) return;
                if (m[2] && /k/i.test(m[2])) f *= 1000;
                const node = eqCtx.filters.get(Math.round(f));
                if (node) {
                    const g = parseFloat(t.value);
                    if (isFinite(g)) node.gain.value = g;
                }
            } catch (_) {}
        } catch (_) {}
    }
    // Активен ли граф ПРЯМО СЕЙЧАС (для видимой подписи в уведомлении)
    function eqActiveNow() {
        try {
            return !!(eqCtx && eqCtx.el && eqCtx.filters && eqCtx.filters.size);
        } catch (_) { return false; }
    }
    // true = можно играть antiAudio (граф активен или прямой тракт ок).
    // Вызывать ДО установки src (crossOrigin должен стоять раньше загрузки).
    // Полностью синхронно — жест для autoplay не теряется.
    function ensureEqGraph() {
        try {
            // зеркало ползунков — ВСЕГДА (даже если слайдеров пока нет):
            // иначе открытая позже панель никогда не подцепится
            try {
                collectDocs().forEach(d => {
                    try {
                        if (d.__antiEqMirror) return;
                        d.__antiEqMirror = true;
                        d.addEventListener("input", onEqSliderInput, true);
                        d.addEventListener("change", onEqSliderInput, true);
                    } catch (_) {}
                });
            } catch (_) {}
            const st = readEqSettings();
            if (!st) {
                // один раз в консоль: видно, нашёл ли вообще панель (тень/фрейм/закрыта)
                try {
                    if (!eqNoSlidersLogged) {
                        eqNoSlidersLogged = true;
                        console.log("[CensorAbuse] eq: sliders not found");
                    }
                } catch (_) {}
                return true; // слайдеров нет — прямой тракт
            }
            if (st.flat) {
                if (eqCtx) { try { applyEqSettings(st); } catch (_) {} }
                if (eqWasOn) { eqWasOn = false; try { console.log("[CensorAbuse] eq off (flat)"); } catch (_) {} }
                return true;
            }
            if (eqCorsDead) return true; // CORS уже ронял — только прямой тракт
            const el = ensureAntiAudio();
            if (eqCtx && eqCtx.el === el) {
                let same = false;
                try {
                    const a = [...eqCtx.filters.keys()].sort((x, y) => x - y).join(",");
                    const b = st.bands.map(x => Math.round(x.freq)).sort((x, y) => x - y).join(",");
                    same = a === b;
                } catch (_) {}
                if (same) {
                    try { applyEqSettings(st); } catch (_) {}
                    if (!eqWasOn) { eqWasOn = true; try { console.log("[CensorAbuse] eq on (" + st.bands.length + " bands)"); } catch (_) {} }
                    return true;
                }
                try { if (eqCtx.src) eqCtx.src.disconnect(); } catch (_) {}
                if (!buildEqChain(eqCtx.src, st)) {
                    return swapAntiAudioDirect("eq rebuild failed");
                }
                if (!eqWasOn) { eqWasOn = true; try { console.log("[CensorAbuse] eq on (" + st.bands.length + " bands)"); } catch (_) {} }
                return true;
            }
            let AC = null;
            try { AC = window.AudioContext || window.webkitAudioContext; } catch (_) {}
            if (typeof AC !== "function") return true;
            let ac = null;
            try {
                if (eqCtx && eqCtx.ac) { ac = eqCtx.ac; }
                else {
                    ac = new AC();
                    eqCtx = { ac, el: null, filters: new Map(), pre: null, src: null };
                }
            } catch (_) { return true; }
            try {
                const pr = ac.resume();
                if (pr && typeof pr.catch === "function") pr.catch(() => {});
            } catch (_) {}
            let active = false;
            try { active = (navigator.userActivation && navigator.userActivation.isActive) || ac.state === "running"; } catch (_) {}
            if (!active && ac.state !== "running") return true; // без жеста контекст висит — только прямой тракт
            try {
                if (el.__antiEqSource && (!eqCtx || eqCtx.el !== el)) return true;
            } catch (_) {}
            try { el.crossOrigin = "anonymous"; } catch (_) {}
            try {
                const src = ac.createMediaElementSource(el);
                el.__antiEqSource = true;
                if (!buildEqChain(src, st)) {
                    return swapAntiAudioDirect("eq build failed");
                }
                try { el.addEventListener("error", onEqMediaError); } catch (_) {}
                eqWasOn = true;
                try { console.log("[CensorAbuse] eq on (" + st.bands.length + " bands)"); } catch (_) {}
            } catch (e) {
                return swapAntiAudioDirect("eq build failed");
            }
            return true;
        } catch (_) { return true; }
    }

    function markAntiPlaying(trackId, playing) {
        try {
            document.querySelectorAll(".CommonTrack_root__i6shE").forEach(ctr => {
                let id = null;
                try { id = getTrackIdFromNode(ctr); } catch (_) {}
                if (id && String(id) === String(trackId)) {
                    ctr.classList.toggle("CensorAbuse_playing", !!playing);
                }
            });
        } catch (_) {}
    }

    let lastNativePauseTs = 0;
    function pauseNativePlayer() {
        try {
            // не чаще раза в 2с: не ввязываемся в пинг-понг с движком,
            // если он решает сам себя разбудить
            const now = Date.now();
            if (now - lastNativePauseTs < 2000) return;
            lastNativePauseTs = now;
            // паузим нативный <audio> (ищем везде: DOM, shadow, iframe),
            // чтобы не играли два источника сразу
            try {
                listAllAudios().forEach(a => {
                    try { if (a !== antiAudio && !a.paused) a.pause(); } catch (_) {}
                });
            } catch (_) {
                try {
                    document.querySelectorAll("audio").forEach(a => {
                        if (a !== antiAudio && !a.paused) a.pause();
                    });
                } catch (_) {}
            }
            // не кликаем pauseBtn принудительно — достаточно паузы audio,
            // иначе ломаем очередь обычных треков
        } catch (_) {}
    }

    async function getReplacedUrl(trackId) {
        const r = getReplaced(trackId);
        if (!r || r.src === "remote_exception") return null;
        if (r.src === "local" && !r.url) {
            try { return await getLocalTrackUrl(trackId); } catch (_) { return null; }
        }
        return r.url || null;
    }

    function trackTitleFromRow(row) {
        try {
            const byTestId = row.querySelector('[data-test-id="TRACK_TITLE"]')?.textContent?.trim();
            if (byTestId) return byTestId;
        } catch (_) {}
        try {
            const byClass = row.querySelector('[class*="Meta_title__"]')?.textContent?.trim();
            if (byClass) return byClass;
        } catch (_) {}
        try {
            const link = row.querySelector('a[href*="/track/"]')?.textContent?.trim();
            if (link) return link;
        } catch (_) {}
        return null;
    }
    function rowArtistFromRow(row) {
        try {
            const el = row.querySelector('[class*="Meta_artistCaption__"]');
            const t = el?.textContent?.trim();
            return t || null;
        } catch (_) { return null; }
    }
    function rowCoverFromRow(row) {
        try {
            const img = row.querySelector("img");
            if (img && img.src) return img.src;
        } catch (_) {}
        // обложки div'ами с background-image (в строке может не быть <img>)
        try {
            const els = row.querySelectorAll("div, span");
            let n = 0;
            for (const el of els) {
                if (n++ > 40) break;
                let bg = "";
                try { bg = (el.style && el.style.backgroundImage) || ""; } catch (_) {}
                if (!bg || bg === "none") {
                    try { bg = getComputedStyle(el).backgroundImage || ""; } catch (_) {}
                }
                const m = String(bg || "").match(/url\(["']?(https?:[^"')]+)["']?\)/i);
                if (m) return m[1];
            }
        } catch (_) {}
        return null;
    }

    /* === Что звучит из нашего Audio — помним метаданные выбранной строки,
       чтобы плеербар показывал именно выбранную песню (название/артист/обложка). === */
    let ownedMeta = null;
    // Штамп подмены хранится прямо на элементе (__antiCoverFor = trackId),
    // поэтому отдельного множества не нужно.
    function captureOwnedMeta(trackId, row) {
        try {
            try { restorePlayIcons(); } catch (_) {}
            const mc = metaCacheGet(trackId);
            const rowTitle = (() => { try { return row ? trackTitleFromRow(row) : null; } catch (_) { return null; } })();
            const rowArtist = (() => { try { return row ? rowArtistFromRow(row) : null; } catch (_) { return null; } })();
            const rowCover = (() => { try { return row ? rowCoverFromRow(row) : null; } catch (_) { return null; } })();
            let cover = rowCover || null;
            let coverGuessed = false;
            if (!cover && mc && mc.cover) {
                cover = coverUrlFromUri(mc.cover);
                coverGuessed = !!cover;
            }
            // контекст старта: где включили (контейнер = тот же альбом),
            // чтобы next/prev/ended ходили здесь, а не в очереди натива
            let playContainer = null, playAlbumId = null, playHref = null;
            try {
                if (row && row.parentElement) playContainer = row.parentElement;
            } catch (_) {}
            try {
                if (row) playAlbumId = getTrackInfoFromNode(row).albumId || null;
            } catch (_) {}
            try { playHref = String(location.href).slice(0, 120); } catch (_) {}
            ownedMeta = {
                trackId: String(trackId),
                title: rowTitle || (mc && mc.title) || null,
                artist: rowArtist || (mc && mc.artist) || null,
                cover,
                coverGuessed,
                coverApplied: false,
                albumTitle: (mc && mc.albumTitle) || null,
                albumCover: (mc && mc.albumCover) || null,
                playContainer,
                playAlbumId,
                playHref,
                ts: Date.now()
            };
        } catch (_) {}
    }
    function clearOwnedMeta() { try { ownedMeta = null; } catch (_) {} }
    // Самовосстановление меты: если её зачистили, а звук наш и играет —
    // перезахватываем (строка последнего клика -> скан строк по id -> кэш API).
    function healOwnedMeta() {
        try {
            if (ownedMeta || !antiAudio || !antiTrackId) return;
            if (antiAudio.paused) return;
            const tid = String(antiTrackId);
            let row = null;
            try {
                const c = lastTrackClick;
                if (c && c.row && String(c.trackId) === tid) row = c.row;
            } catch (_) {}
            if (!row) {
                try {
                    document.querySelectorAll(".CommonTrack_root__i6shE").forEach(ctr => {
                        if (row) return;
                        try { if (String(getTrackIdFromNode(ctr)) === tid) row = ctr; } catch (_) {}
                    });
                } catch (_) {}
            }
            try { captureOwnedMeta(tid, row); } catch (_) {}
            try { if (ownedMeta) hlog("meta healed " + tid); } catch (_) {}
        } catch (_) {}
    }
    function ruPlural(n, forms) {
        try {
            n = Math.abs(Math.floor(n)) % 100;
            const d = n % 10;
            if (n > 10 && n < 20) return forms[2];
            if (d > 1 && d < 5) return forms[1];
            if (d === 1) return forms[0];
            return forms[2];
        } catch (_) { return forms[2]; }
    }
    function fmtRuTime(sec) {
        try {
            const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
            return m + " " + ruPlural(m, ["минута", "минуты", "минут"]) + ", " + s + " " + ruPlural(s, ["секунда", "секунды", "секунд"]);
        } catch (_) { return ""; }
    }

    /* === UI-синк: плеербар показывает наш трек ===
       Пишем только текстовые/атрибутные значения и только если отличаются
       (без вставки узлов — структуру React не трогаем). Натив зависший,
       свои ререндеры прогресса не делает, поэтому записи держатся.
        Обложку пишем один раз за сессию (src с разными размерами иначе мигает). */
    // СТРОГО два элемента и ничего больше: мини-обложка и постер фулскрина.
    // Ищем по контейнерам из живой разметки, внутри берём img (там только он).
    // Никаких "первый видимый img" и широких cover__ — они и меняли все картинки.
    function findExactCovers() {
        let mini = null, fs = null;
        try {
            const docs = collectDocs();
            for (const doc of docs) {
                if (mini && fs) break;
                try {
                    if (!mini) {
                        const mc = doc.querySelector('[data-test-id="PLAYERBAR_DESKTOP_COVER_CONTAINER"]')
                            || doc.querySelector('[class*="PlayerBarDesktopWithBackgroundProgressBar_coverContainer"]');
                        if (mc) {
                            try {
                                const im = mc.querySelector("img");
                                if (im) mini = im;
                            } catch (_) {}
                        }
                    }
                } catch (_) {}
                try {
                    if (!fs) {
                        const fc = doc.querySelector('[data-test-id="FULLSCREEN_PLAYER_POSTER_CONTENT"]')
                            || doc.querySelector('[class*="FullscreenPlayerDesktopPoster_root"]');
                        if (fc) {
                            try {
                                const im = fc.querySelector("img");
                                if (im) fs = im;
                            } catch (_) {}
                        }
                    }
                } catch (_) {}
            }
        } catch (_) {}
        return [mini, fs].filter(Boolean);
    }
    function setPlayerCover(img, url) {
        try {
            if (!img || !url) return false;
            if (img.src === url) return true;
            try { img.removeAttribute("srcset"); } catch (_) {}
            try { img.src = url; } catch (_) { return false; }
            return true;
        } catch (_) { return false; }
    }
    // Запись видимого времени без ломки структуры: текст — во внутренний
    // span[aria-hidden], если есть (наружный несёт tabindex/role/aria-label).
    // Писать textContent наружного = снести внутренний узел = уронить reconciler.
    function writeTimeText(el, str) {
        try {
            if (!el || str == null) return false;
            let target = el;
            try {
                const inner = el.querySelector("span[aria-hidden]");
                if (inner) target = inner;
            } catch (_) {}
            const now = (() => { try { return (target.textContent || "").trim(); } catch (_) { return null; } })();
            if (now !== str) { try { target.textContent = str; } catch (_) { return false; } }
            return true;
        } catch (_) { return false; }
    }
    function fmtClock(s) {
        try { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); } catch (_) { return ""; }
    }
    // Иконка play/pause в плеербаре: отражаем состояние НАШЕГО Audio.
    // Меняем только подстроку play<->pause в use-href (суффиксы размера целы).
    // Метка __antiIconHref защищает от silenceNative: нашу подмену не трогаем.
    const iconTouched = new Set();
    function useHrefOf(btn) {
        try {
            const use = btn.querySelector("use");
            if (!use) return null;
            return use.getAttribute("href") || use.getAttribute("xlink:href") || null;
        } catch (_) { return null; }
    }
    function setUseHref(btn, href) {
        try {
            const use = btn.querySelector("use");
            if (!use || !href) return false;
            let touched = false;
            try {
                if (use.getAttribute("href") != null) { use.setAttribute("href", href); touched = true; }
            } catch (_) {}
            try {
                if (use.getAttribute("xlink:href") != null) { use.setAttribute("xlink:href", href); touched = true; }
            } catch (_) {}
            if (!touched) {
                try { use.setAttribute("href", href); touched = true; } catch (_) {}
            }
            return touched;
        } catch (_) { return false; }
    }
    function swapPlayPauseHref(href, wantPlaying) {
        try {
            if (!href) return null;
            const low = String(href).toLowerCase();
            const isPause = low.includes("pause") || low.includes("пауза");
            const isPlay = !isPause && (low.includes("play") || low.includes("играть") || low.includes("слушать"));
            if (wantPlaying && isPause) return href;
            if (!wantPlaying && isPlay) return href;
            if (wantPlaying && isPlay) return href.replace(/play/gi, "pause");
            if (!wantPlaying && isPause) return href.replace(/pause/gi, "play");
            return null;
        } catch (_) { return null; }
    }
    function syncPlayIcon(bar) {
        try {
            if (!antiAudio || !antiTrackId) return;
            const playing = !antiAudio.paused;
            let btns = null;
            try { btns = bar.querySelectorAll("button, [role='button']"); } catch (_) { return; }
            btns.forEach(b => {
                try {
                    if (classifyPlayerButton(b) !== "playpause" && playStateOfButton(b) == null) return;
                    const cur = useHrefOf(b);
                    if (!cur) return;
                    const want = swapPlayPauseHref(cur, playing);
                    if (!want || want === cur) return;
                    if (b.__antiIconOrig == null) {
                        try { b.__antiIconOrig = cur; } catch (_) {}
                        try { iconTouched.add(b); } catch (_) {}
                    }
                    if (setUseHref(b, want)) { try { b.__antiIconHref = want; } catch (_) {} }
                } catch (_) {}
            });
        } catch (_) {}
    }
    function restorePlayIcons() {
        try {
            iconTouched.forEach(b => {
                try {
                    if (b.__antiIconOrig != null) setUseHref(b, b.__antiIconOrig);
                } catch (_) {}
                try { b.__antiIconHref = null; b.__antiIconOrig = null; } catch (_) {}
            });
            try { iconTouched.clear(); } catch (_) {}
        } catch (_) {}
    }
    let doubleLogged = false; // переход DOUBLE уже залогирован
    let sliderHeld = false;
    function syncPlayerUI() {
        try {
            if (!antiAudio || !antiTrackId) return;
            if (!ownedMeta) {
                try { healOwnedMeta(); } catch (_) {}
                if (!ownedMeta) return;
            }
            if (antiAudio.paused) return; // на паузе UI не дёргаем
            // давим фоновый натив каждый тик: пока он играет, его ререндеры
            // перетирают наши записи в плеербаре (название/прогресс).
            // Переходы DOUBLE — в консоль (HUD выпилен).
            try {
                if (nativePlayingSeen()) {
                    try { setHudErr("DOUBLE"); } catch (_) {}
                    try {
                        if (!doubleLogged) { doubleLogged = true; console.log("[CensorAbuse] DOUBLE on"); }
                    } catch (_) {}
                    try { silenceNative(); } catch (_) {}
                } else {
                    try { if (hudState.err === "DOUBLE") setHudErr("-"); } catch (_) {}
                    try {
                        if (doubleLogged) { doubleLogged = false; console.log("[CensorAbuse] DOUBLE off"); }
                    } catch (_) {}
                }
            } catch (_) {}
            const bars = [];
            try {
                collectDocs().forEach(doc => {
                    try { collectSyncScopes(doc).forEach(b => bars.push(b)); } catch (_) {}
                });
            } catch (_) {}
            if (!bars.length) return;
            const dur = antiAudio.duration;
            const cur = antiAudio.currentTime || 0;
            // Обложка: строго два элемента (мини + фулскрин, см. findExactCovers).
            // Штамп per-track прямо на элементе: новый трек — новая запись,
            // тот же трек — пропуск. Поздно смонтированные подхватываются тиком.
            if (ownedMeta.cover) {
                try {
                    findExactCovers().forEach(target => {
                        try {
                            if (target.__antiCoverFor === ownedMeta.trackId) return;
                            if (ownedMeta.coverGuessed) {
                                // угаданный URL — через предзагрузку; штамп сразу,
                                // чтобы не плодить пробы каждый тик до onload
                                const myTid = ownedMeta.trackId;
                                const myUrl = ownedMeta.cover;
                                try { target.__antiCoverFor = myTid; } catch (_) {}
                                const probe = new Image();
                                probe.onload = () => {
                                    try {
                                        if (!ownedMeta || ownedMeta.trackId !== myTid) return;
                                        if (setPlayerCover(target, myUrl)) {
                                            try { console.log("[CensorAbuse] cover applied " + myTid); } catch (_) {}
                                        }
                                    } catch (_) {}
                                };
                                probe.onerror = () => {
                                    // битый URL — штамп стоит, больше не долбим этот трек
                                };
                                probe.src = myUrl;
                            } else {
                                if (setPlayerCover(target, ownedMeta.cover)) {
                                    try { target.__antiCoverFor = ownedMeta.trackId; } catch (_) {}
                                    try { console.log("[CensorAbuse] cover applied " + ownedMeta.trackId); } catch (_) {}
                                }
                            }
                        } catch (_) {}
                    });
                } catch (_) {}
            }
            bars.forEach(bar => {
                try {
                    try { syncPlayIcon(bar); } catch (_) {}
                    if (ownedMeta.title) {
                        bar.querySelectorAll('[class*="Meta_title__"]').forEach(el => {
                            try {
                                const now = el.textContent?.trim();
                                if (now !== ownedMeta.title) el.textContent = ownedMeta.title;
                            } catch (_) {}
                        });
                    }
                    if (ownedMeta.artist) {
                        bar.querySelectorAll('[class*="Meta_artistCaption__"]').forEach(el => {
                            try {
                                const now = el.textContent?.trim();
                                if (now !== ownedMeta.artist) el.textContent = ownedMeta.artist;
                            } catch (_) {}
                        });
                    }
                    // (обложка пишется выше, строго в два элемента — см. findExactCovers)
                    try {
                        const sl = bar.querySelector('input[data-test-id="TIMECODE_SLIDER"]');
                        if (sl && isVisibleEl(sl) && isFinite(dur) && dur > 0 && !sliderHeld) {
                            const max = Math.round(dur);
                            try { if (String(sl.max) !== String(max)) sl.max = String(max); } catch (_) {}
                            const val = Math.floor(cur);
                            try { if (String(sl.value) !== String(val)) sl.value = String(val); } catch (_) {}
                            // style пишем только при сдвиге >0.5%: иначе наши мутации
                            // сами плодят observer-каскады и видимый тик
                            const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
                            let lastPct = null;
                            try { lastPct = sl.__antiLastPct; } catch (_) {}
                            if (lastPct == null || Math.abs(pct - lastPct) > 0.5) {
                                try { sl.__antiLastPct = pct; } catch (_) {}
                                try { sl.style.setProperty("--seek-before-width", pct + "%"); } catch (_) {}
                                try { sl.style.backgroundSize = pct + "% 100%"; } catch (_) {}
                                try {
                                    const wrap = sl.closest('[data-test-id="TIMECODE_WRAPPER"]');
                                    if (wrap) wrap.style.setProperty("--track-progress", pct + "%");
                                } catch (_) {}
                            }
                            try {
                                let buffered = 100;
                                try {
                                    const b = antiAudio.buffered;
                                    if (b && b.length) buffered = Math.min(100, (b.end(b.length - 1) / dur) * 100);
                                } catch (_) {}
                                let lastBuf = null;
                                try { lastBuf = sl.__antiLastBuf; } catch (_) {}
                                if (lastBuf == null || Math.abs(buffered - lastBuf) > 1) {
                                    try { sl.__antiLastBuf = buffered; } catch (_) {}
                                    try { sl.style.setProperty("--buffered-width", buffered + "%"); } catch (_) {}
                                }
                            } catch (_) {}
                            try { sl.setAttribute("aria-valuetext", " " + fmtRuTime(cur) + "."); } catch (_) {}
                            try { syncThumb(bar, pct / 100, sl); } catch (_) {}
                        }
                    } catch (_) {}
                    // видимое время: точные слоты по test-id (порядок в DOM врёт).
                    // Фолбэк — старый подбор по значению, если test-id нет.
                    try {
                        if (isFinite(dur) && dur > 0) {
                            const elStr = fmtClock(cur), duStr = fmtClock(dur);
                            const startEl = bar.querySelector('[data-test-id="TIMECODE_TIME_START"]');
                            const endEl = bar.querySelector('[data-test-id="TIMECODE_TIME_END"]');
                            if (startEl || endEl) {
                                if (startEl) {
                                    writeTimeText(startEl, elStr);
                                    try { startEl.setAttribute("aria-label", " " + fmtRuTime(cur) + "."); } catch (_) {}
                                }
                                if (endEl) {
                                    writeTimeText(endEl, duStr);
                                    try { endEl.setAttribute("aria-label", " " + fmtRuTime(dur) + "."); } catch (_) {}
                                }
                            } else {
                                const times = [...bar.querySelectorAll("span")].filter(el => {
                                    try { return /^\d{1,3}:\d{2}$/.test((el.textContent || "").trim()); } catch (_) { return false; }
                                });
                                if (times.length >= 2) {
                                    const toSec = (t) => {
                                        try {
                                            const m = String(t || "").trim().match(/^(\d{1,3}):(\d{2})$/);
                                            return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : null;
                                        } catch (_) { return null; }
                                    };
                                    let elapsedEl = times[0], totalEl = times[times.length - 1];
                                    try {
                                        const vals = times.map(el => { try { return toSec(el.textContent); } catch (_) { return null; } });
                                        let best = -1, bestDiff = 2;
                                        vals.forEach((v, i) => {
                                            if (v == null) return;
                                            const d = Math.abs(v - dur);
                                            if (d <= bestDiff) { bestDiff = d; best = i; }
                                        });
                                        if (best >= 0) {
                                            totalEl = times[best];
                                            elapsedEl = times[best === 0 ? 1 : 0];
                                        }
                                    } catch (_) {}
                                    writeTimeText(elapsedEl, elStr);
                                    writeTimeText(totalEl, duStr);
                                }
                            }
                        }
                    } catch (_) {}
                } catch (_) {}
            });
        } catch (_) {}
    }
    // Быстрый тик 250мс только для позиции ползунка: точка следует за прогрессом.
    // Натив коммитит своё значение каждый ререндер — выигрываем частотой.
    // Быстрый тик 250мс только для позиции ползунка: точка следует за прогрессом.
    // Натив коммитит своё значение каждый ререндер. Заметив борьбу (два тика
    // подряд наше значение сбито), проводим его через нативный сеттер + событие
    // input: тогда React принимает значение в свой стейт и борьба кончается.
    function setSliderValueNative(sl, val) {
        try {
            const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
            if (desc && typeof desc.set === "function") {
                desc.set.call(sl, String(val));
            } else {
                sl.value = String(val);
            }
            try { sl.__antiOwnEvent = Date.now(); } catch (_) {}
            try { sl.dispatchEvent(new Event("input", { bubbles: true })); } catch (_) {}
            // часть хендлеров коммитит только на change — шлём оба
            try { sl.dispatchEvent(new Event("change", { bubbles: true })); } catch (_) {}
            return true;
        } catch (_) { return false; }
    }
    // Видимость без offsetParent: у position:fixed он всегда null.
    function isVisibleEl(el) {
        try {
            if (!el || !el.getClientRects || !el.getClientRects().length) return false;
            const cs = getComputedStyle(el);
            return cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity || "1") > 0;
        } catch (_) { return false; }
    }
    let sliderSessStats = { sess: null, total: 0, visible: 0, logged: false };
    // Точка-thumb: отдельный div, input.value его не двигает. Двигаем прямо:
    // CSS-переменные наследуются на обёртку (нулевой риск), затем left%/translateX
    // только при однозначном маппинге. Остальное пропускаем — лучше пропуск, чем сломанная вёрстка.
    function syncThumb(scope, frac, sliderEl) {
        try {
            if (!scope || !scope.querySelectorAll) return;
            if (!(frac >= 0)) return;
            frac = Math.min(1, Math.max(0, frac));
            const pct = frac * 100;
            const thumbs = [...scope.querySelectorAll('div[class*="thumb" i]')].slice(0, 3);
            if (!thumbs.length) return;
            let width = 0;
            try {
                const r = sliderEl ? sliderEl.getBoundingClientRect() : null;
                width = r ? r.width : 0;
            } catch (_) {}
            thumbs.forEach(th => {
                try {
                    if (!isVisibleEl(th)) return;
                    let last = null;
                    try { last = th.__antiThumbPct; } catch (_) {}
                    if (last != null && Math.abs(pct - last) < 1) return;
                    const cs = getComputedStyle(th);
                    const left = String((cs && cs.left) || "");
                    if (/%$/.test(left)) {
                        th.style.left = pct + "%";
                        try { th.__antiThumbPct = pct; } catch (_) {}
                        return;
                    }
                    const tr = String((cs && cs.transform) || "");
                    const m = tr.match(/^matrix\(([^)]+)\)$/);
                    if (m && width > 0) {
                        const parts = m[1].split(",").map(x => parseFloat(x));
                        // только чистая трансляция: центрирующий ty сохраняем, tx ведём за прогрессом
                        if (parts.length === 6 && parts[0] === 1 && parts[1] === 0 && parts[2] === 0 && parts[3] === 1) {
                            const ty = isFinite(parts[5]) ? parts[5] : 0;
                            th.style.transform = "translateX(" + (frac * width) + "px) translateY(" + ty + "px)";
                            try { th.__antiThumbPct = pct; } catch (_) {}
                        }
                    }
                } catch (_) {}
            });
        } catch (_) {}
    }
    function syncSliderFast() {
        try {
            if (!antiAudio || !antiTrackId || antiAudio.paused) return;
            const dur = antiAudio.duration;
            if (!isFinite(dur) || dur <= 0) return;
            if (sliderHeld) return;
            try {
                if (sliderSessStats.sess !== antiTrackId) {
                    sliderSessStats = { sess: antiTrackId, total: 0, visible: 0, logged: false };
                }
            } catch (_) {}
            const val = Math.floor(antiAudio.currentTime || 0);
            const scopes = [];
            try {
                collectDocs().forEach(doc => {
                    try { collectSyncScopes(doc).forEach(s => scopes.push(s)); } catch (_) {}
                });
            } catch (_) {}
            scopes.forEach(scope => {
                try {
                    scope.querySelectorAll('input[data-test-id="TIMECODE_SLIDER"]').forEach(sl => {
                        try {
                            try {
                                if (sl.__antiSess !== antiTrackId) {
                                    sl.__antiSess = antiTrackId;
                                    sl.__antiFight = 0; sl.__antiAdopted = false;
                                    sl.__antiStableLogged = false; sl.__antiPersistLogged = false;
                                    sl.__antiMismatchN = 0; sl.__antiAdoptLogTs = 0; sl.__antiStableN = 0;
                                    try {
                                        sliderSessStats.total++;
                                        if (isVisibleEl(sl)) sliderSessStats.visible++;
                                    } catch (_) {}
                                }
                            } catch (_) {}
                            // скрытые дубликаты (display:none шаблоны) не трогаем:
                            // записи уходят в невидимую копию, а точка стоит
                            try { if (!isVisibleEl(sl)) return; } catch (_) {}
                            let cur = null;
                            try { cur = String(sl.value); } catch (_) {}
                            if (cur === String(val)) {
                                try { sl.__antiFight = 0; } catch (_) {}
                                try {
                                    if (sl.__antiAdopted && !sl.__antiStableLogged) {
                                        sl.__antiStableN = (sl.__antiStableN || 0) + 1;
                                        if (sl.__antiStableN >= 5) {
                                            sl.__antiStableLogged = true;
                                            try { sl.__antiMismatchN = 0; } catch (_) {}
                                            try { console.log("[CensorAbuse] slider stable"); } catch (_) {}
                                        }
                                    }
                                } catch (_) {}
                                return;
                            }
                            try { sl.__antiMismatchN = (sl.__antiMismatchN || 0) + 1; } catch (_) {}
                            let fight = 0;
                            try { fight = sl.__antiFight || 0; } catch (_) {}
                            if (fight >= 2) {
                                // борьба: натив сбивает второй тик подряд — проводим через его стейт
                                try { sl.__antiFight = 0; } catch (_) {}
                                try { sl.__antiAdopted = true; sl.__antiStableN = 0; } catch (_) {}
                                try {
                                    const now = Date.now();
                                    if (now - (sl.__antiAdoptLogTs || 0) > 10000) {
                                        sl.__antiAdoptLogTs = now;
                                        console.log("[CensorAbuse] slider adopted");
                                    }
                                } catch (_) {}
                                setSliderValueNative(sl, val);
                                try {
                                    if (!sl.__antiPersistLogged && (sl.__antiMismatchN || 0) >= 40) {
                                        sl.__antiPersistLogged = true;
                                        console.log("[CensorAbuse] slider fight persists");
                                    }
                                } catch (_) {}
                            } else {
                                try { sl.__antiFight = fight + 1; } catch (_) {}
                                sl.value = String(val);
                            }
                        } catch (_) {}
                    });
                } catch (_) {}
            });
            try {
                if (!sliderSessStats.logged) {
                    sliderSessStats.logged = true;
                    console.log("[CensorAbuse] sliders visible " + sliderSessStats.visible + " of " + sliderSessStats.total);
                }
            } catch (_) {}
        } catch (_) {}
    }
    // Своя ли это модалка/шапка: ищем /track/ ссылки в ближайшем контейнере.
    // Чужие страницы (другой альбом) не трогаем: пишем только если ссылок нет
    // вообще или хоть одна ведёт на наш трек.
    function modalScopeOk(el, trackId) {
        try {
            let root = null;
            try { root = el.closest('[role="dialog"],[class*="Modal"],[class*="TrackModal"],[class*="PageHeader"],[class*="BlockHeader"]'); } catch (_) {}
            if (!root) return true;
            let anyLink = false, ours = false;
            try {
                root.querySelectorAll('a[href*="/track/"]').forEach(a => {
                    try {
                        const m = (a.getAttribute("href") || "").match(/\/track\/(\d+)/);
                        if (m) { anyLink = true; if (String(m[1]) === String(trackId)) ours = true; }
                    } catch (_) {}
                });
            } catch (_) {}
            if (!anyLink) return true;
            return ours;
        } catch (_) { return true; }
    }
    // СТРОГИЙ гейт для шапок (PageHeader/BlockHeader): писать только внутри
    // модалки/диалога либо при явной ссылке на наш трек. Иначе (чужая страница
    // альбома, где в шапке нет ссылок) — default-deny, иначе название трека
    // затирает название чужого альбома.
    function modalScopeStrict(el, trackId) {
        try {
            let dlg = null;
            try { dlg = el.closest('[role="dialog"],[class*="Modal"],[class*="TrackModal"]'); } catch (_) {}
            if (dlg) return modalScopeOk(el, trackId);
            let node = null;
            try { node = el.closest('[class*="PageHeader"],[class*="BlockHeader"]'); } catch (_) {}
            if (!node) return false;
            let ours = false;
            try {
                node.querySelectorAll('a[href*="/track/"]').forEach(a => {
                    try {
                        const m = (a.getAttribute("href") || "").match(/\/track\/(\d+)/);
                        if (m && String(m[1]) === String(trackId)) ours = true;
                    } catch (_) {}
                });
            } catch (_) {}
            return ours;
        } catch (_) { return false; }
    }
    // Синк модалки трека/альбома: название, артист, альбом, обложка.
    // Только текст/атрибуты при отличии, структуру не трогаем.
    let modalLogSess = null;
    function syncTrackModal() {
        try {
            if (!antiAudio || !antiTrackId || !ownedMeta) return;
            const tid = String(antiTrackId);
            let wrote = false;
            const docs = collectDocs();
            docs.forEach(doc => {
                try {
                    if (ownedMeta.title) {
                        doc.querySelectorAll('[class*="PageHeaderTitle_title__"], [class*="TrackModalTitle_title__"]').forEach(el => {
                            try {
                                if (!modalScopeStrict(el, tid)) return;
                                const now = (el.textContent || "").trim();
                                if (now && now !== ownedMeta.title) { el.textContent = ownedMeta.title; wrote = true; }
                            } catch (_) {}
                        });
                    }
                    if (ownedMeta.artist) {
                        doc.querySelectorAll('[class*="TrackModalTitle_artistCaption__"]').forEach(el => {
                            try {
                                if (!modalScopeStrict(el, tid)) return;
                                const now = (el.textContent || "").trim();
                                if (now && now !== ownedMeta.artist) { el.textContent = ownedMeta.artist; wrote = true; }
                            } catch (_) {}
                        });
                    }
                    if (ownedMeta.albumTitle) {
                        doc.querySelectorAll('[class*="BlockHeader_heading__"]').forEach(el => {
                            try {
                                if (!modalScopeStrict(el, tid)) return;
                                const now = (el.textContent || "").trim();
                                if (now && now !== ownedMeta.albumTitle) {
                                    el.textContent = ownedMeta.albumTitle;
                                    try { el.setAttribute("title", ownedMeta.albumTitle); } catch (_) {}
                                    wrote = true;
                                }
                            } catch (_) {}
                        });
                    }
                    const albC = ownedMeta.albumCover ? coverUrlFromUri(ownedMeta.albumCover) : null;
                    if (albC) {
                        doc.querySelectorAll('img[data-test-id="BLOCK_HEADER_COVER"]').forEach(im => {
                            try {
                                if (!modalScopeStrict(im, tid)) return;
                                if (setPlayerCover(im, albC)) wrote = true;
                            } catch (_) {}
                        });
                    }
                } catch (_) {}
            });
            try {
                if (wrote && modalLogSess !== tid) {
                    modalLogSess = tid;
                    console.log("[CensorAbuse] modal sync " + tid);
                }
            } catch (_) {}
        } catch (_) {}
    }
    try { setInterval(() => { try { syncPlayerUI(); } catch (_) {} try { syncTrackModal(); } catch (_) {} try { installFrameBridges(); } catch (_) {} }, 1000); } catch (_) {}
    try { setInterval(() => { try { syncSliderFast(); } catch (_) {} }, 250); } catch (_) {}

    /* === Управление нашим Audio из плеера: seek и громкость ===
       Программная установка .value событий не даёт — петель нет.
       Нативное событие не глушим: пустому движку мотать нечего. */
    function handlePlayerSliderInput(e) {
        try {
            try { if (isProgrammaticClick()) return; } catch (_) {}
            const t = e.target;
            if (!t || t.tagName !== "INPUT" || t.type !== "range") return;
            // наше собственное событие синхронизации (бой за точку) — не обрабатываем
            try { if (Date.now() - (t.__antiOwnEvent || 0) < 1000) return; } catch (_) {}
            if (e.type === "change") { try { sliderHeld = false; } catch (_) {} }
            const testId = (() => { try { return t.getAttribute("data-test-id") || ""; } catch (_) { return ""; } })();
            const cls = (() => { try { return t.className || ""; } catch (_) { return ""; } })();
            const isTimecode = /TIMECODE/i.test(testId) || /timecode/i.test(String(cls));
            // таймкод специфичен — принимаем где угодно; громкость — тоже
            // (поповер может быть порталом вне бара), но только пока звучим мы
            if (isTimecode) {
                // перемотка нашего Audio
                try {
                    if (antiAudio && antiTrackId && isFinite(antiAudio.duration) && antiAudio.duration > 0) {
                        const min = parseFloat(t.min || "0") || 0;
                        const max = parseFloat(t.max || "0") || 0;
                        if (max > min) {
                            const frac = (parseFloat(t.value) - min) / (max - min);
                            antiAudio.currentTime = Math.min(Math.max(frac, 0), 1) * antiAudio.duration;
                            try { hlog("bridge seek " + Math.round(antiAudio.currentTime) + "s"); } catch (_) {}
                        }
                    }
                } catch (_) {}
                return;
            }
            // любой другой range считаем громкостью — КРОМЕ слайдеров эквалайзера:
            // иначе движение EQ-полосы дёргало бы antiAudio.volume (полоса +12 =
            // громкость 100%, полоса -12 = мут) и EQ звучал бы "как громкость".
            // EQ-слайдерами владеет только onEqSliderInput.
            let isEqSlider = false;
            try {
                const etid = t.getAttribute("data-test-id") || "";
                const ecls = String(t.className || "");
                let eari = "";
                try { eari = t.getAttribute("aria-label") || ""; } catch (_) {}
                isEqSlider = etid === "EQUALIZER_FREQUENCY_SLIDER" || etid === "EQUALIZER_PREAMP_SLIDER"
                    || /equalizer/i.test(ecls)
                    || /децибел|предусил|частот/i.test(eari);
            } catch (_) {}
            if (isEqSlider) return;
            try {
                if (antiAudio && antiTrackId) {
                    const max = parseFloat(t.max || "100") || 100;
                    const v = parseFloat(t.value);
                    if (isFinite(v)) {
                        antiAudio.volume = Math.min(Math.max(max > 1 ? v / max : v, 0), 1);
                        try { hlog("bridge vol " + Math.round(antiAudio.volume * 100)); } catch (_) {}
                    }
                }
            } catch (_) {}
        } catch (_) {}
    }
    try {
        ["input", "change"].forEach(ev => {
            try { document.addEventListener(ev, handlePlayerSliderInput, true); } catch (_) {}
        });
        document.addEventListener("pointerdown", (e) => {
            try {
                const t = e.target?.closest?.('input[data-test-id="TIMECODE_SLIDER"]');
                if (t && closestPlayerBar(t)) sliderHeld = true;
            } catch (_) {}
            // драг за саму точку-thumb тоже блокирует наши записи
            try {
                const th = e.target?.closest?.('div[class*="thumb" i]');
                if (th && closestPlayerBar(th)) sliderHeld = true;
            } catch (_) {}
        }, true);
        ["pointerup", "pointercancel"].forEach(ev => {
            try { document.addEventListener(ev, () => { try { sliderHeld = false; } catch (_) {} }, true); } catch (_) {}
        });
        // страховка: зависший флаг сам снимется
        setInterval(() => { try { sliderHeld = false; } catch (_) {} }, 10000);
    } catch (_) {}

    // Видимый старт в консоли (HUD выпилен): id + наличие меты + громкость. Только факты.
    function logPlayStart(trackId) {
        try {
            const m = ownedMeta && String(ownedMeta.trackId) === String(trackId) ? ownedMeta : null;
            const flags = m ? ((m.title ? "T" : "t") + (m.artist ? "A" : "a") + (m.cover ? "C" : "c")) : "-";
            let vol = "?";
            try {
                if (antiAudio) vol = (antiAudio.muted ? "m" : "") + Math.round((antiAudio.volume ?? 1) * 100);
            } catch (_) {}
            console.log("[CensorAbuse] play " + trackId + " meta:" + flags + " vol:" + vol);
            if (m && !m.cover) console.log("[CensorAbuse] cover: no url for " + trackId);
        } catch (_) {}
    }
    function playUrlNow(trackId, url, row) {
        // вызывается СИНХРОННО из хендлера жеста — иначе браузер режет autoplay
        pauseNativePlayer();
        try { ensureEqGraph(); } catch (_) {}
        const audio = ensureAntiAudio();
        // toggle повторным кликом
        if (antiTrackId && String(antiTrackId) === String(trackId) && !audio.paused) {
            audio.pause();
            antiTrackId = null;
            return null;
        }
        if (audio.src !== url) audio.src = url;
        antiTrackId = String(trackId);
        // мета для синка UI: fast-path возвращается раньше got-url блока,
        // без этого remote-треки играли бы вообще без меты (название/обложка/время)
        try { captureOwnedMeta(trackId, row); } catch (_) {}
        try { setupMediaSession(trackId, row); } catch (_) {}
        // громкость плеера СРАЗУ (fast-path иначе стартует на 100%)
        try {
            const pv = capturePlayerVolume();
            if (pv.volume != null) { try { audio.volume = pv.volume; } catch (_) {} }
            if (pv.muted != null) { try { audio.muted = pv.muted; } catch (_) {} }
        } catch (_) {}
        const p = audio.play();
        if (p && p.catch) {
            p.then(() => {
                const title = row ? trackTitleFromRow(row) : null;
                log("CensorAbuse playing replaced track " + trackId + " via direct audio");
                hudState.play = "EXT " + trackId;
                hlog("play OK ext-audio " + trackId); try { setHudErr("EXT" + (lastNativeFail ? "/" + lastNativeFail : "")); } catch (_) {}
                try { logPlayStart(trackId); } catch (_) {}
                try { postNotificationWithCover("Играет подмена" + (title ? ": " + title : "") + (eqActiveNow() ? " · EQ" : ""), trackId); } catch (_) {}
            }).catch(e => {
                console.error(`[${ADDON_NAME}] direct play failed`, e);
                hudState.play = "FAIL autoplay";
                hlog("play FAIL autoplay " + trackId);
                try { setHudErr("AUTOPLAY"); } catch (_) {}
                try { postNotification("Браузер заблокировал автоплей — кликни ещё раз"); } catch (_) {}
            });
        }
        return p;
    }

    /* === Игра через нативный <audio>: пауза/seek/громкость/прогресс работают из UI ===
       Отдельный antiAudio звучит "вне плеера" — кнопки плеербара его не касаются.
       Поэтому подмену первым делом льём в тот <audio>, которым рулит натив:
       плеербар при этом показывает выбранный трек, всё честно. */
    let lastNativeFail = ""; // почему не взлетел нативный элемент: NOEL / ELFAIL
    const wiredAudios = new Set(); // элементы с нашими слушателями (чистим флаги дёшево, без скана DOM)
    // Полный поиск <audio>: обычный DOM + shadow roots + same-origin iframes.
    // Хост-шим сам не находит плеер ("Player element not found") — ищем везде.
    // Все доступные документы: главный + same-origin фреймы (плеер может жить там).
    // Кросс-доменные молча пропускаются. Кэш 10с чтобы не дёргать DOM постоянно.
    let docsCache = { t: 0, docs: null };
    function collectDocs() {
        try {
            const now = Date.now();
            if (docsCache.docs && (now - docsCache.t) < 10000) return docsCache.docs;
            const out = [document];
            try {
                document.querySelectorAll("iframe").forEach(f => {
                    try { const d = f.contentDocument; if (d && !out.includes(d)) out.push(d); } catch (_) {}
                });
            } catch (_) {}
            try {
                for (let i = 0; i < window.frames.length; i++) {
                    try { const d = window.frames[i].document; if (d && !out.includes(d)) out.push(d); } catch (_) {}
                }
            } catch (_) {}
            docsCache = { t: now, docs: out };
            return out;
        } catch (_) { return [document]; }
    }
    // Ставим мост в доступные фреймы: клики/слайдеры плеера могут быть не в главном документе
    function installFrameBridges() {
        try {
            collectDocs().forEach(d => {
                try {
                    if (d === document || d.__antiBridged) return;
                    d.__antiBridged = true;
                    d.addEventListener("click", handlePlayerbarPress, true);
                    d.addEventListener("input", handlePlayerSliderInput, true);
                    d.addEventListener("change", handlePlayerSliderInput, true);
                    try { hlog("bridge installed in frame"); } catch (_) {}
                } catch (_) {}
            });
        } catch (_) {}
    }
    function listAllAudios() {
        const seen = [];
        const rootsSeen = new Set();
        const push = (a) => {
            try { if (a && a.tagName === "AUDIO" && !seen.includes(a)) seen.push(a); } catch (_) {}
        };
        const walk = (root, depth) => {
            if (!root || depth > 3) return;
            try { root.querySelectorAll("audio").forEach(push); } catch (_) {}
            if (depth >= 3) return;
            let all = null;
            try { all = root.querySelectorAll("*"); } catch (_) {}
            if (!all) return;
            all.forEach(n => {
                try {
                    const sr = n.shadowRoot;
                    if (sr && !rootsSeen.has(sr)) { rootsSeen.add(sr); walk(sr, depth + 1); }
                } catch (_) {}
                try {
                    if (n.tagName === "IFRAME" && !rootsSeen.has(n)) {
                        rootsSeen.add(n);
                        const d = n.contentDocument;
                        if (d) walk(d, depth + 1);
                    }
                } catch (_) {}
            });
        };
        try {
            collectDocs().forEach(d => { try { walk(d, 0); } catch (_) {} });
        } catch (_) {}
        try { hudState.aud = seen.length; } catch (_) {}
        return seen;
    }
    function findNativeAudio() {
        try {
            const cands = listAllAudios().filter(a => a && a !== antiAudio);
            if (!cands.length) return null;
            // предпочитаем живой элемент: играющий, затем с src, иначе первый
            const playing = cands.find(a => { try { return !a.paused && !a.ended; } catch (_) { return false; } });
            if (playing) return playing;
            const withSrc = cands.find(a => { try { return !!(a.currentSrc || a.src); } catch (_) { return false; } });
            if (withSrc) return withSrc;
            return cands[0];
        } catch (_) { return null; }
    }
    function clearOtherOwnership(el) {
        try {
            wiredAudios.forEach(a => {
                try { if (a !== el && a.__antiOwned) a.__antiOwned = null; } catch (_) {}
                try { if (!a.isConnected) wiredAudios.delete(a); } catch (_) {}
            });
        } catch (_) {}
    }
    function wireNativeAudio(el) {
        try {
            if (!el || el.__antiWired) return;
            el.__antiWired = true;
            try { wiredAudios.add(el); } catch (_) {}
            // натив перезаписал src своим (битым для blocked) — возвращаем подмену, максимум 3 раза
            el.addEventListener("error", () => {
                try {
                    const own = el.__antiOwned;
                    if (!own) return;
                    own.tries = (own.tries || 0) + 1;
                    if (own.tries > 3) {
                        try { hlog("native-el give up " + own.trackId); } catch (_) {}
                        try { setHudErr("EL GIVEUP"); } catch (_) {}
                        el.__antiOwned = null;
                        return;
                    }
                    setTimeout(() => {
                        try {
                            if (el.__antiOwned !== own) return;
                            el.src = own.url;
                            const pr = el.play();
                            if (pr && typeof pr.catch === "function") pr.catch(() => {});
                            try { hlog("native-el re-applied " + own.trackId); } catch (_) {}
                        } catch (_) {}
                    }, 300);
                } catch (_) {}
            });
            el.addEventListener("ended", () => {
                try {
                    if (el.__antiOwned) {
                        el.__antiOwned = null;
                        try { setRknCssHold(false); } catch (_) {}
                    }
                } catch (_) {}
            });
        } catch (_) {}
    }
    // Возвращает Promise<boolean>: true — звучит через элемент плеера
    function playViaNativeElement(el, trackId, url, row) {
        return (async () => {
            try {
                trackId = String(trackId);
                wireNativeAudio(el);
                clearOtherOwnership(el);
                el.__antiOwned = { trackId, url, tries: 0, ts: Date.now() };
                antiTrackId = null;
                try { if (antiAudio && !antiAudio.paused) antiAudio.pause(); } catch (_) {}
                try { setupMediaSession(trackId, row); } catch (_) {}
                try { if (el.src !== url) el.src = url; } catch (_) {}
                await el.play();
                let title = null;
                try { title = row ? trackTitleFromRow(row) : null; } catch (_) {}
                log("AntiCensor playing replaced track " + trackId + " via native audio element");
                try { hudState.play = "OKN " + trackId; hlog("play OK native-el " + trackId); } catch (_) {}
                try { setHudErr("-"); } catch (_) {}
                try { postNotificationWithCover("Играет подмена" + (title ? ": " + title : "") + (eqActiveNow() ? " · EQ" : ""), trackId); } catch (_) {}
                return true;
            } catch (e) {
                try { if (el) el.__antiOwned = null; } catch (_) {}
                return false;
            }
        })();
    }

    // Считываем громкость/мьют плеера, чтобы стартовать с его настройками,
    // а не "как по кайфу" (дефолт 100%).
    // Слайдер громкости (CHANGE_VOLUME_SLIDER, шкала max=1) часто живёт в портале
    // ВНЕ баров — ищем глобально по всем документам, бары лишь запасной вариант.
    function findVolumeSliderAnywhere() {
        try {
            const docs = collectDocs();
            // сначала сквозь shadow roots (doc.querySelector их не пробивает),
            // поповер громкости часто именно в тени
            for (const doc of docs) {
                try {
                    const hit = findInShadows(doc, 'input[data-test-id="CHANGE_VOLUME_SLIDER"]', 1)[0];
                    if (hit) return hit;
                } catch (_) {}
            }
            for (const doc of docs) {
                try {
                    const scopes = collectSyncScopes(doc);
                    for (const bar of scopes) {
                        try {
                            const sliders = [...bar.querySelectorAll('input[type="range"]')].filter(t => {
                                try {
                                    const tid = t.getAttribute("data-test-id") || "";
                                    if (/TIMECODE/i.test(tid) || /timecode/i.test(t.className || "")) return false;
                                    // EQ-слайдеры — не громкость (иначе полоса +12 дала бы volume 100%)
                                    let eari = "";
                                    try { eari = t.getAttribute("aria-label") || ""; } catch (_) {}
                                    if (tid === "EQUALIZER_FREQUENCY_SLIDER" || tid === "EQUALIZER_PREAMP_SLIDER") return false;
                                    if (/equalizer/i.test(t.className || "")) return false;
                                    if (/децибел|предусил|частот/i.test(eari)) return false;
                                    return true;
                                } catch (_) { return true; }
                            });
                            if (sliders.length) return sliders[0];
                        } catch (_) {}
                    }
                } catch (_) {}
            }
        } catch (_) {}
        return null;
    }
    function capturePlayerVolume() {
        const out = { volume: null, muted: null };
        try {
            try {
                const s = findVolumeSliderAnywhere();
                if (s) {
                    const max = parseFloat(s.max || "100") || 100;
                    const v = parseFloat(s.value);
                    if (isFinite(v)) out.volume = Math.min(Math.max(max > 1 ? v / max : v, 0), 1);
                }
            } catch (_) {}
            try {
                const bars = [];
                try {
                    collectDocs().forEach(doc => {
                        try { collectSyncScopes(doc).forEach(b => bars.push(b)); } catch (_) {}
                    });
                } catch (_) {}
                for (const bar of bars) {
                    try {
                        const btns = [...bar.querySelectorAll("button, [role='button']")];
                        let seenVol = false;
                        for (const b of btns) {
                            let s = "";
                            try {
                                const use = b.querySelector("use");
                                if (use) s = String((use.getAttribute("href") || "") + " " + (use.getAttribute("xlink:href") || "")).toLowerCase();
                            } catch (_) {}
                            if (!s.trim()) continue;
                            if (/mute|volume[-_]off/.test(s)) { out.muted = true; break; }
                            if (s.includes("volume")) seenVol = true;
                        }
                        if (out.muted == null && seenVol) out.muted = false;
                    } catch (_) {}
                    if (out.muted != null) break;
                }
            } catch (_) {}
        } catch (_) {}
        return out;
    }
    async function playReplacedDirectly(trackId, row) {
        pendingRknTrackId = String(trackId);
        // ручная пауза с плеербара подавляет авторестарт модальным циклом
        try {
            if (Date.now() < manualPauseUntil) { log("play suppressed by manual pause"); return; }
        } catch (_) {}
        try { markRknForced(trackId); } catch (_) {}
        try { touchRknSession(); } catch (_) {}
        lastRknForceTs = Date.now();
        try { killRknModals(); } catch (_) {}
        // fast-path: remote/assets/кэш уже в памяти — играем без await,
        // play() должен вызваться в том же таске, что и клик
        try {
            const fast = getReplaced(trackId);
            if (fast && fast.url && fast.src !== "remote_exception") {
                playUrlNow(trackId, fast.url, row);
                pendingRknTrackId = null;
                return;
            }
        } catch (_) {}
        const url = await getReplacedUrl(trackId);
        if (String(pendingRknTrackId) !== String(trackId)) return; // кликнули другой трек
        if (!url) {
            log("RKN play: NO replacement file for trackId=" + trackId);
            hudState.play = "NO FILE";
            hlog("play NO FILE " + trackId);
            try { setHudErr("NO FILE"); } catch (_) {}
            postNotification("Нет файла замены для этого трека");
            pendingRknTrackId = null;
            return;
        }
        log("RKN play: got url for trackId=" + trackId);
        // другой трек, чем в прошлый раз, — мотаем в начало перед стартом
        try {
            if (String(lastAntiTrackId || "") !== String(trackId)) {
                try { ensureAntiAudio().currentTime = 0; } catch (_) {}
            }
            lastAntiTrackId = String(trackId);
        } catch (_) {}
        // стартуем с громкости/мьюта плеера, а не с дефолта
        try {
            const pv = capturePlayerVolume();
            const ae = ensureAntiAudio();
            if (pv.volume != null) { try { ae.volume = pv.volume; } catch (_) {} }
            if (pv.muted != null) { try { ae.muted = pv.muted; } catch (_) {} }
        } catch (_) {}
        // запоминаем метаданные выбранной строки: плеербар покажет именно её
        try { captureOwnedMeta(trackId, row); } catch (_) {}
        // один источник звука: гасим фоновый натив до старта своего
        try { silenceNative(); } catch (_) {}
        // 1) льём подмену в нативный <audio>: плеербар/pауза/seek/громкость работают,
        // показывают выбранный трек. 2) Фолбэк — свой Audio (вне плеера, в HUD метка EXT).
        try { lastNativeFail = ""; } catch (_) {}
        try {
            const nel = findNativeAudio();
            if (!nel) {
                try { lastNativeFail = "NOEL"; hlog("native-el not found, aud=" + hudState.aud); } catch (_) {}
            } else {
                const okEl = await playViaNativeElement(nel, trackId, url, row);
                if (okEl) { pendingRknTrackId = null; return; }
                try { lastNativeFail = "ELFAIL"; } catch (_) {}
            }
        } catch (_) { try { if (!lastNativeFail) lastNativeFail = "ELFAIL"; } catch (_) {} }
        // сразу убиваем модалку, если натив успел её создать
        try { killRknModals(); } catch (_) {}
        pauseNativePlayer();
        try { ensureEqGraph(); } catch (_) {}
        const audio = ensureAntiAudio();
        try {
            // toggle: повторный клик по играющему — пауза/продолжить
            if (antiTrackId && String(antiTrackId) === String(trackId) && !audio.paused) {
                audio.pause();
                pendingRknTrackId = null;
                return;
            }
            if (audio.src !== url) audio.src = url;
            antiTrackId = String(trackId);
            try { setupMediaSession(trackId, row); } catch (_) {}
            await audio.play();
            const title = row ? trackTitleFromRow(row) : null;
            log("CensorAbuse playing replaced track " + trackId + " via direct audio");
            hudState.play = "EXT " + trackId;
            hlog("play OK ext-audio " + trackId); try { setHudErr("EXT" + (lastNativeFail ? "/" + lastNativeFail : "")); } catch (_) {}
            try { postNotificationWithCover("Играет подмена" + (title ? ": " + title : "") + (eqActiveNow() ? " · EQ" : ""), trackId); } catch (_) {}
        } catch (e) {
            console.error(`[${ADDON_NAME}] direct play failed`, e);
            hudState.play = "FAIL";
            hlog("play FAIL " + trackId);
            try { setHudErr("PLAY FAIL"); } catch (_) {}
            postNotification("Не получилось проиграть замену, смотри консоль");
        } finally {
            pendingRknTrackId = null;
        }
    }

    // === Decoy playback: один нативный плеер ===
    // Флаг чтобы наш собственный синтетический клик по decoy-строке
    // не перехватывался handleRknPress повторно.
    let allowDecoyPassthroughId = null;
    let allowDecoyPassthroughTs = 0;

    function findDecoyRow(decoyId) {
        try {
            const rows = [...document.querySelectorAll(".CommonTrack_root__i6shE")];
            for (const ctr of rows) {
                let tid = null;
                try { tid = getTrackIdFromNode(ctr); } catch (_) {}
                if (tid && String(tid) === String(decoyId)) return ctr;
            }
        } catch (_) {}
        return null;
    }

    function clickDecoyRow(decoyId) {
        const row = findDecoyRow(decoyId);
        if (!row) return false;
        try {
            allowDecoyPassthroughId = String(decoyId);
            allowDecoyPassthroughTs = Date.now();
            // кликаем по кнопке/строке, но НЕ по ссылке <a> — чтобы не увести навигацию
            let target = null;
            try { target = row.querySelector('button') || row.querySelector('[data-test-id="TRACK_TITLE"]') || row; } catch (_) { target = row; }
            const canSynthetic = (typeof MouseEvent === "function") && target && typeof target.dispatchEvent === "function";
            if (!canSynthetic) { allowDecoyPassthroughId = null; return false; }
            try { markProgrammaticClick(); } catch (_) {}
            ["pointerdown", "mousedown", "click"].forEach(type => {
                try {
                    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
                    target.dispatchEvent(ev);
                } catch (_) {}
            });
            // страховка: если натив не подхватил за 1.5с — флаг тухнет сам
            setTimeout(() => {
                try {
                    if (allowDecoyPassthroughId && Date.now() - allowDecoyPassthroughTs > 1200) allowDecoyPassthroughId = null;
                } catch (_) {}
            }, 1500);
            return true;
        } catch (_) { return false; }
    }

    // глушим своё аудио только по явному клику юзера по другому треку
    // (глобальный слушатель 'play' давал friendly-fire: паузил нашу подмену
    // при любом чихе нативного движка и дёргался в горячем цикле)
    function pauseOwnAudio(reason) {
        try {
            if (antiAudio && !antiAudio.paused) { antiAudio.pause(); }
            antiTrackId = null;
            try { rpcStopped(); } catch (_) {}
            // смена трека — таймер сбрасываем: повтор стартует с начала
            try { if (antiAudio) antiAudio.currentTime = 0; } catch (_) {}
            try { lastAntiTrackId = null; } catch (_) {}
            try { clearOwnedMeta(); } catch (_) {}
            try { restorePlayIcons(); } catch (_) {}
            try { hudState.play = "-"; } catch (_) {}
            // снимаем владение со всех нативных элементов: юзер ушёл на обычный трек,
            // иначе stale-подмена вернётся при первой же ошибке стрима
            try {
                wiredAudios.forEach(a => {
                    try { a.__antiOwned = null; } catch (_) {}
                    try { if (!a.isConnected) wiredAudios.delete(a); } catch (_) {}
                });
            } catch (_) {}
            try { clearActiveCover(reason || "user track"); } catch (_) {}
            endRknSession(reason || "user track");
        } catch (_) {}
    }

    /* === Привязка к плееру: в этой сборке у плеербара НЕТ data-test-id,
       только хэшированные классы вида PlayerBarDesktopWithBackgroundProgressBar_*.
       Поэтому ищем по подстроке класса, иначе мост/метки молча не срабатывают. */
    const PLAYERBAR_SELECTORS = [
        '[data-test-id="PLAYERBAR_DESKTOP"]',
        '[class*="PlayerBarDesktop"]',
        '[class*="PlayerbarDesktop"]',
        '[data-test-id="FULLSCREEN_PLAYER_FULLSCREEN_CONTENT"]',
        '[class*="FullscreenPlayer"]',
        '[class*="Fullscreenplayer"]',
        '[class*="FullScreenPlayer"]'
    ];
    const PLAYERBAR_SELECTOR = PLAYERBAR_SELECTORS.join(",");
    function queryPlayerBars(root) {
        try {
            const scope = root && root.querySelectorAll ? root : document;
            return [...scope.querySelectorAll(PLAYERBAR_SELECTOR)];
        } catch (_) { return []; }
    }
    function closestPlayerBar(node) {
        try {
            if (!node || !node.closest) return null;
            return node.closest(PLAYERBAR_SELECTOR);
        } catch (_) { return null; }
    }
    // Скопы синка: бары + фулскрин-корни по якорям (постер/таймкод вне баров).
    // Строки треков сюда попасть не могут — вандализма списков нет.
    function collectSyncScopes(doc) {
        const out = [];
        const push = (n) => { try { if (n && !out.includes(n)) out.push(n); } catch (_) {} };
        try { queryPlayerBars(doc).forEach(push); } catch (_) {}
        try {
            const scope = doc && doc.querySelectorAll ? doc : document;
            scope.querySelectorAll('img[data-test-id="ENTITY_COVER_IMAGE"]').forEach(img => {
                try {
                    const root = img.closest('[class*="Fullscreen"],[class*="Player"],[role="dialog"]');
                    push(root || img.parentElement);
                } catch (_) {}
            });
            scope.querySelectorAll('[data-test-id="TIMECODE_WRAPPER"]').forEach(w => {
                try {
                    const root = w.closest('[class*="Fullscreen"],[class*="Player"],[role="dialog"]');
                    push(root || w.parentElement);
                } catch (_) {}
            });
        } catch (_) {}
        return out;
    }
    // Поиск сквозь открытые shadow roots (doc.querySelector их не пробивает)
    function findInShadows(doc, selector, limit) {
        const found = [];
        const max = limit || 5;
        try {
            const walk = (root, depth) => {
                if (!root || depth > 4 || found.length >= max) return;
                try {
                    root.querySelectorAll(selector).forEach(n => {
                        if (found.length < max) found.push(n);
                    });
                } catch (_) {}
                if (found.length >= max || depth >= 4) return;
                let all = null;
                try { all = root.querySelectorAll("*"); } catch (_) {}
                if (!all) return;
                all.forEach(n => {
                    if (found.length >= max) return;
                    try {
                        const sr = n.shadowRoot;
                        if (sr) walk(sr, depth + 1);
                    } catch (_) {}
                });
            };
            walk(doc || document, 0);
        } catch (_) {}
        return found;
    }

    /* === Мост кнопок плеера: aud=0, элемента нет — звук идёт из своего Audio,
       и кнопки плеербара его не касаются. Зеркалим play/pause/next/prev. ===
       Seek/volume-слайдеры (input) не трогаем. Нативное событие НЕ глушим. */
    let manualPauseUntil = 0; // ручная пауза подавляет авторестарт модальным циклом
    function classifyPlayerButton(btn) {
        try {
            let strong = "";
            try { strong += " " + (btn.getAttribute("aria-label") || ""); } catch (_) {}
            try { strong += " " + (btn.title || ""); } catch (_) {}
            try {
                const use = btn.querySelector("use");
                if (use) strong += " " + (use.getAttribute("href") || "") + " " + (use.getAttribute("xlink:href") || "");
            } catch (_) {}
            strong = strong.toLowerCase();
            if (!strong.trim()) return null; // по одним test-id не гадаем (там "player" даёт ложные play)
            const has = (...words) => words.some(w => strong.includes(w));
            // кнопки, которые точно не медиаконтролы
            if (has("context", "menu", "download", "like", "dislike", "lyric", "queue", "очередь", "текст", "скачать", "нравится", "repeat", "повтор", "shuffle", "перемешать", "cast", "airplay", "expand", "развернуть", "close", "закрыть")) return null;
            // мьют имеет приоритет над общим "volume" (иконка volume_xs сама по себе — null)
            if (has("mute", "muted", "выключить звук", "включить звук", "unmute", "volume-off", "volume-mute", "mute_xs", "volume_mute")) return "mutebtn";
            if (has("volume", "громко")) return null;
            if (has("next", "следующ", "forward", "skip-forward", "track-next")) return "next";
            if (has("prev", "previous", "предыдущ", "назад", "backward", "rewind", "skip-back", "track-prev")) return "prev";
            if (has("pause", "пауза", "suspend")) return "playpause";
            if (has("play", "играть", "слушать", "воспроизв", "продолжить", "resume", "start")) return "playpause";
            return null;
        } catch (_) { return null; }
    }
    // Состояние кнопки play/pause: "playing" = сейчас играет (клик поставит на паузу)
    // Состояние кнопки play/pause: СНАЧАЛА иконка (use href), потом aria/title.
    // У PLAY_BUTTON aria статична ("Воспроизведение") — ей верить нельзя,
    // состояние несёт только иконка: pause_* = играет, play_* = на паузе.
    function playStateOfButton(btn) {
        try {
            let icon = "";
            try {
                const use = btn.querySelector("use");
                if (use) icon = String((use.getAttribute("href") || "") + " " + (use.getAttribute("xlink:href") || "")).toLowerCase();
            } catch (_) {}
            if (icon.trim()) {
                if (icon.includes("pause") || icon.includes("пауза")) return "playing";
                if (icon.includes("play") || icon.includes("играть") || icon.includes("слушать")) return "paused";
                return null;
            }
            let s = "";
            try { s += " " + (btn.getAttribute("aria-label") || ""); } catch (_) {}
            try { s += " " + (btn.title || ""); } catch (_) {}
            s = s.toLowerCase();
            if (!s.trim()) return null;
            const has = (...w) => w.some(x => s.includes(x));
            if (has("pause", "пауза", "suspend")) return "playing";
            if (has("play", "играть", "слушать", "продолжить", "resume", "start")) return "paused";
            return null;
        } catch (_) { return null; }
    }
    // Глушим фоновый звук натива доверенным кликом по его же кнопке паузы.
    // Элементов не видно (aud=0), иначе паузили бы напрямую. Только если играет.
    // Плюс минимальный зазор между кликами: toggle-кнопку нельзя дёргать каждую
    // секунду, иначе она начнёт включать вместо выключения.
    let lastSilenceTs = 0;
    // Видит ли натив СЕБЯ играющим (кнопка в состоянии pause), исключая наши
    // подмены иконок. true = фоновая музыка натива + наша = двойной звук.
    function nativePlayingSeen() {
        try {
            const bars = [];
            try {
                collectDocs().forEach(doc => {
                    try { collectSyncScopes(doc).forEach(b => bars.push(b)); } catch (_) {}
                });
            } catch (_) {}
            for (const bar of bars) {
                let btns = null;
                try { btns = bar.querySelectorAll("button, [role='button']"); } catch (_) { continue; }
                for (const b of btns) {
                    try {
                        if (b.__antiIconHref) {
                            const ch = useHrefOf(b);
                            if (ch && ch === b.__antiIconHref) continue;
                        }
                    } catch (_) {}
                    try { if (playStateOfButton(b) === "playing") return true; } catch (_) {}
                }
            }
        } catch (_) {}
        return false;
    }
    // Точные test-id кнопок плеера (фулскрин; для мини — эвристики как фолбэк)
    function findPlayerButton(kind) {
        try {
            const ids = kind === "play" ? ["PLAY_BUTTON"]
                : kind === "prev" ? ["PREVIOUS_TRACK_BUTTON"]
                : kind === "next" ? ["NEXT_TRACK_BUTTON"] : [];
            if (!ids.length) return null;
            const scopes = [];
            try {
                collectDocs().forEach(doc => {
                    try { collectSyncScopes(doc).forEach(s => scopes.push(s)); } catch (_) {}
                });
            } catch (_) {}
            if (!scopes.length) scopes.push(document);
            for (const scope of scopes) {
                for (const id of ids) {
                    try {
                        const el = scope.querySelector('[data-test-id="' + id + '"]');
                        if (el) return el;
                    } catch (_) {}
                }
            }
        } catch (_) {}
        return null;
    }
    // Одна попытка глушения через конкретную кнопку (с защитой нашей иконки)
    function trySilenceButton(b) {
        try {
            if (!b) return false;
            try {
                if (b.__antiIconHref) {
                    const ch = useHrefOf(b);
                    if (ch && ch === b.__antiIconHref) return false;
                    try { b.__antiIconHref = null; } catch (_) {}
                }
            } catch (_) {}
            if (playStateOfButton(b) !== "playing") return false;
            try { markProgrammaticClick(); } catch (_) {}
            b.click();
            try { lastSilenceTs = Date.now(); } catch (_) {}
            try { hlog("silenced native"); } catch (_) {}
            return true;
        } catch (_) { return false; }
    }
    function silenceNative() {
        try {
            if (Date.now() - lastSilenceTs < 2500) return false;
            // сначала точная кнопка PLAY_BUTTON по скопам
            try {
                if (trySilenceButton(findPlayerButton("play"))) return true;
            } catch (_) {}
            const bars = [];
            try {
                collectDocs().forEach(doc => {
                    try { collectSyncScopes(doc).forEach(b => bars.push(b)); } catch (_) {}
                });
            } catch (_) {}
            for (const bar of bars) {
                let btns = null;
                try { btns = bar.querySelectorAll("button, [role='button']"); } catch (_) { continue; }
                for (const b of btns) {
                    try {
                        if (trySilenceButton(b)) return true;
                    } catch (_) {}
                }
            }
        } catch (_) {}
        return false;
    }
    // Шаг по ВИДИМОМУ списку (альбом на экране), а не по внутренней очереди
    // натива (там может быть лайкнутое). Возвращает true если кликнули:
    // доступный играет натив, заблокированный с заменой подхватит modal-path.
    function advanceVisibleList(direction, trackIdOverride, containerOverride) {
        try {
            const selfId = trackIdOverride ? String(trackIdOverride) : (antiTrackId ? String(antiTrackId) : null);
            if (!selfId) return false;
            // сначала контейнер старта (тот же альбом, даже если юзер ушёл со страницы
            // и видимый список теперь другой); иначе — видимые строки как раньше
            let ctxRows = null;
            try {
                const pc = containerOverride
                    || (ownedMeta && String(ownedMeta.trackId) === selfId ? ownedMeta.playContainer : null);
                if (pc && pc.isConnected) {
                    const list = [...pc.querySelectorAll(":scope > .CommonTrack_root__i6shE")];
                    if (list.some(r => { try { return String(getTrackIdFromNode(r)) === selfId; } catch (_) { return false; } })) {
                        ctxRows = list;
                    }
                }
            } catch (_) {}
            const rows = ctxRows || [...document.querySelectorAll(".CommonTrack_root__i6shE")];
            let idx = -1;
            rows.forEach((r, i) => {
                if (idx >= 0) return;
                try { if (String(getTrackIdFromNode(r)) === selfId) idx = i; } catch (_) {}
            });
            if (idx < 0) return false;
            let target = null;
            try {
                const container = rows[idx].parentElement;
                if (container) {
                    const siblings = [...container.querySelectorAll(":scope > .CommonTrack_root__i6shE")];
                    const pos = siblings.indexOf(rows[idx]);
                    const np = direction === "prev" ? pos - 1 : pos + 1;
                    if (pos >= 0 && np >= 0 && np < siblings.length) target = siblings[np];
                }
            } catch (_) {}
            if (!target) {
                try {
                    const ni = direction === "prev" ? idx - 1 : idx + 1;
                    if (ni >= 0 && ni < rows.length && rows[ni].parentElement === rows[idx].parentElement) target = rows[ni];
                } catch (_) {}
            }
            if (!target) return false;
            let nid = null;
            try { nid = getTrackIdFromNode(target); } catch (_) {}
            try { manualPauseUntil = 0; } catch (_) {}
            try { markProgrammaticClick(); } catch (_) {}
            try {
                if (nid) lastTrackClick = { row: target, trackId: String(nid), ts: Date.now() };
            } catch (_) {}
            try { target.click(); } catch (_) { return false; }
            // своё глушим: дальше ведёт натив (или modal-path для заблокированного)
            try { pauseOwnAudio("advance " + direction); } catch (_) {}
            try { hlog("advance " + direction + " in list"); } catch (_) {}
            return true;
        } catch (_) { return false; }
    }
    function handlePlayerbarPress(e) {
        try {
            try { if (isProgrammaticClick()) return; } catch (_) {}
            const btn = e.target?.closest?.("button, [role='button'], input");
            if (!btn) return;
            try { if (btn.tagName === "INPUT") return; } catch (_) {}
            // сначала точный test-id (aria у PLAY_BUTTON статична и врёт)
            let kind = null;
            try {
                const dtid = btn.getAttribute("data-test-id") || "";
                if (dtid === "PLAY_BUTTON") kind = "playpause";
                else if (dtid === "PREVIOUS_TRACK_BUTTON") kind = "prev";
                else if (dtid === "NEXT_TRACK_BUTTON") kind = "next";
            } catch (_) {}
            if (!kind) kind = classifyPlayerButton(btn);
            if (!kind) return;
            // мьют зеркалим где угодно (поповер громкости часто в портале вне бара)
            if (kind === "mutebtn") {
                let mutedDone = false;
                try {
                    if (antiAudio && antiTrackId) {
                        antiAudio.muted = !antiAudio.muted;
                        try { hlog("bridge mute " + antiAudio.muted); } catch (_) {}
                        mutedDone = true;
                    }
                } catch (_) {}
                if (mutedDone) {
                    try { e.stopImmediatePropagation(); } catch (_) {}
                    try { e.preventDefault(); } catch (_) {}
                    try { e.stopPropagation(); } catch (_) {}
                }
                return;
            }
            // остальное — только внутри плеербара (иначе заденем кнопки строк)
            const bar = closestPlayerBar(e.target);
            if (!bar) return;
            if (kind === "next" || kind === "prev") {
                // пока звучим мы — ходим по ВИДИМОМУ списку (альбом на экране),
                // а не по внутренней очереди натива (там может быть лайкнутое).
                // Иначе — глушим своё и отдаём дальше штатно.
                let walked = false;
                try {
                    if (antiAudio && antiTrackId) {
                        if (kind === "prev") {
                            let cur = 0;
                            try { cur = antiAudio.currentTime || 0; } catch (_) {}
                            if (cur > 3) {
                                try { antiAudio.currentTime = 0; } catch (_) {}
                                try { hlog("bridge restart"); } catch (_) {}
                                walked = true;
                            }
                        }
                        if (!walked) walked = advanceVisibleList(kind);
                    }
                } catch (_) {}
                if (walked) {
                    try { e.stopImmediatePropagation(); } catch (_) {}
                    try { e.preventDefault(); } catch (_) {}
                    try { e.stopPropagation(); } catch (_) {}
                    return;
                }
                try { pauseOwnAudio("playerbar " + kind); } catch (_) {}
                try { hlog("bridge stop (" + kind + ")"); } catch (_) {}
                return;
            }
            // play/pause: дёргаем свой Audio только если звучим МЫ (antiTrackId выставлен).
            // play/pause: дёргаем свой Audio только если звучим МЫ (antiTrackId выставлен).
            // Тогда же режем событие нативу: иначе его хендлер дёрнет заблокированный
            // трек и перезапустит цикл модалок.
            let handled = false;
            try {
                if (antiAudio && antiTrackId) {
                    if (!antiAudio.paused) {
                        antiAudio.pause();
                        try { silenceNative(); } catch (_) {}
                        try { hudState.play = "|| " + antiTrackId; } catch (_) {}
                        try { manualPauseUntil = Date.now() + 5000; } catch (_) {}
                        try { hlog("bridge pause"); } catch (_) {}
                        try { syncPlayIcon(bar); } catch (_) {}
                        handled = true;
                    } else {
                        try {
                            if (antiAudio.src || antiAudio.currentSrc) {
                                const pr = antiAudio.play();
                                if (pr && typeof pr.catch === "function") pr.catch(() => {});
                                try { hudState.play = "EXT " + antiTrackId; } catch (_) {}
                                try { manualPauseUntil = 0; } catch (_) {}
                                try { hlog("bridge resume"); } catch (_) {}
                                try { syncPlayIcon(bar); } catch (_) {}
                                handled = true;
                            }
                        } catch (_) {}
                    }
                    try { updateHud(); } catch (_) {}
                }
            } catch (_) {}
            if (handled) {
                try { e.stopImmediatePropagation(); } catch (_) {}
                try { e.preventDefault(); } catch (_) {}
                try { e.stopPropagation(); } catch (_) {}
            }
        } catch (_) {}
    }

    // Попытка запустить натив на decoyID разными способами.
    // Возвращает true если хоть один способ выстрелил (или запланирован).
    function tryNativePlayDecoy(decoyId, rknId) {
        // 1) pulsesyncApi: поискать play-методы динамически (имена меняются между сборками)
        try {
            const api = window.pulsesyncApi;
            if (api) {
                const candidates = ["play", "playTrack", "playTrackById", "startTrack", "setTrack"];
                for (const name of candidates) {
                    try {
                        if (typeof api[name] === "function") {
                            api[name](decoyId);
                            log("Decoy: played via pulsesyncApi." + name);
                            try { hlog("decoy via api." + name + " " + decoyId); } catch (_) {}
                            return true;
                        }
                    } catch (e) { try { hlog("decoy api." + name + " threw"); } catch (_) {} }
                }
                try { hlog("decoy: no api.play method, trying DOM"); } catch (_) {}
            } else {
                try { hlog("decoy: no pulsesyncApi, trying DOM"); } catch (_) {}
            }
        } catch (_) {}
        // 2) sonataState / очередь
        try {
            const s = window.sonataState;
            const mp = s?.currentMediaPlayer?.value?.currentMediaPlayer;
            const q = s?.queueState;
            // у некоторых сборок есть play(entity) на медиаплеере
            if (mp) {
                for (const name of ["play", "playEntity", "setEntityAndPlay"]) {
                    try { if (typeof mp[name] === "function") { mp[name]({ id: decoyId }); log("Decoy: played via mediaPlayer." + name); return true; } } catch (_) {}
                }
            }
            void q;
        } catch (_) {}
        // 3) DOM-клик по строке заглушки (самый совместимый путь:
        // натив сам построит очередь/статистику как для обычного трека)
        try {
            if (clickDecoyRow(decoyId)) { log("Decoy: clicked row " + decoyId); return true; }
        } catch (_) {}
        return false;
    }

    async function playRknViaDecoy(rknId, row) {
        rknId = String(rknId);
        // breaker первым делом: зацикленную модалку не разгоняем
        try {
            if (!claimDecoyAttempt(rknId)) {
                try { armRknCss(); } catch (_) {}
                try { killRknModals(); } catch (_) {}
                return false;
            }
        } catch (_) {}
        try { markRknForced(rknId); } catch (_) {}
        try { touchRknSession(); } catch (_) {}
        lastRknForceTs = Date.now();
        try { killRknModals(); } catch (_) {}
        try { armRknCss(); } catch (_) {}

        // нужен файл замены — иначе decoy-путь бессмысленен
        let realUrl = null;
        try {
            const fast = getReplaced(rknId);
            realUrl = fast ? fast.url : null;
            if (fast && fast.src === "local" && !realUrl) realUrl = await getLocalTrackUrl(rknId);
        } catch (_) {}
        if (!realUrl) {
            try {
                realUrl = await getReplacedUrl(rknId);
            } catch (_) {}
        }
        if (!realUrl) {
            log("Decoy play: NO replacement file for RKN track " + rknId);
            try { hudState.play = "NO FILE"; hlog("decoy NO FILE " + rknId); } catch (_) {} try { setHudErr("NO FILE"); } catch (_) {}
            try { postNotification("Нет файла замены для этого трека"); } catch (_) {}
            return false;
        }

        let decoyId = null;
        try { decoyId = getDecoyFor(rknId, row); } catch (_) {}
        if (!decoyId || String(decoyId) === rknId) {
            log("Decoy play: no decoy found for " + rknId + ", fallback to direct audio");
            try { hlog("decoy MISS " + rknId); } catch (_) {} try { setHudErr("NO DECOY"); } catch (_) {}
            try { const p = playReplacedDirectly(rknId, row); if (p && typeof p.catch === "function") p.catch(e => log("decoy miss fallback failed", e)); } catch (_) {}
            return false;
        }

        // свой Audio НЕ глушим заранее: если натив не возьмёт заглушку,
        // тишина вместо звука — ровно тот баг, что чиним. Глушение — только
        // по факту (хук отдал аудио под decoyID, см. takeover в хуке).
        try { pauseNativePlayer(); } catch (_) {}
        try { setActiveCover(rknId, decoyId); } catch (e) { log("setActiveCover failed", e); }
        try { coverServedAt = 0; } catch (_) {}
        try { hudState.play = "DECOY " + rknId + "->" + decoyId; hlog("decoy " + rknId + "->" + decoyId); } catch (_) {}

        let ok = false;
        try { ok = tryNativePlayDecoy(decoyId, rknId); } catch (e) { log("tryNativePlayDecoy threw", e); ok = false; }
        if (!ok) {
            log("Decoy play: native start failed, fallback to direct audio");
            try { hlog("decoy START FAIL " + rknId); } catch (_) {} try { setHudErr("START FAIL"); } catch (_) {}
            try { clearActiveCover("native failed"); } catch (_) {}
            try { const p = playReplacedDirectly(rknId, row); if (p && typeof p.catch === "function") p.catch(e => log("decoy fallback failed", e)); } catch (_) {}
            return false;
        }
        let title = null;
        try { title = row ? trackTitleFromRow(row) : null; } catch (_) {}
        log("Decoy play: native plays " + decoyId + ", client hears RKN " + rknId);
        // плеербар перепатчим когда натив переключит currentEntity
        setTimeout(() => { try { updatePlayerbarReplacedMark(); } catch (_) {} }, 600);
        setTimeout(() => { try { updatePlayerbarReplacedMark(); } catch (_) {} }, 2000);
        try { if (claimDecoyNotify(rknId)) postNotificationWithCover("Играет подмена через заглушку" + (title ? ": " + title : ""), rknId); } catch (_) {}
        // Верификация НЕ через getCurrentTrack (шим хоста сломан:
        // "Player element not found in DOM" каждую секунду), а через факт
        // отдачи аудио хуком: coverServedAt ставят в момент, когда натив
        // реально запросил файл под decoyID. Взял — звучит натив, свой Audio
        // не трогаем (а если он уже играет — хук сам его припаузит, takeover).
        // Не взял за 1.2с — включаем direct-audio сами. Cover при этом НЕ
        // сбрасываем: возьмёт позже — хук отдаст и припаузит свой Audio.
        try {
            setTimeout(() => {
                try {
                    if (!activeCover || String(activeCover.rknId) !== String(rknId)) return; // сессию уже закрыли
                    if (coverServedAt) {
                        try { hlog("decoy verify OK (hook served) " + decoyId); } catch (_) {}
                        try { setHudErr("-"); } catch (_) {}
                        try { updatePlayerbarReplacedMark(); } catch (_) {}
                        return;
                    }
                    try { hlog("decoy verify: native idle, direct audio"); } catch (_) {}
                    try {
                        const p = playReplacedDirectly(rknId, row);
                        if (p && typeof p.catch === "function") p.catch(e => log("decoy verify fallback failed", e));
                    } catch (_) {}
                } catch (_) {}
            }, 1200);
        } catch (_) {}
        return true;
    }

    let lastPressId = null;
    let lastPressTs = 0;
    // последний клик по любой строке трека — нужен чтобы сматчить всплывшую
    // RKN-модалку на трек. Подъём по родителям вместо жёсткого селектора:
    // в актуальных сборках строка может быть размечена иначе.
    let lastTrackClick = null;
    // последняя нативная попытка получить file-info (id треков + время):
    // натив сам сообщает, что пытался включить — разметка вообще не нужна
    let lastFetchAttempt = null;

    /* === Отвязка попыток РКН-треков от серверов Яндекса ===
       Нативный запрос get-file-info по форсируемому заблокированному id режем
       локально как AbortError (приложение такое проглатывает молча — как
       отмену при навигации). Режем ТОЛЬКО если в запросе исключительно наши
       форсированные id; смешанные батчи с соседними треками пропускаем. */
    const rknForceIds = new Map(); // id(String) -> ts
    function markRknForced(trackId) {
        try {
            if (!trackId) return;
            rknForceIds.set(String(trackId), Date.now());
            if (rknForceIds.size > 50) {
                const cutoff = Date.now() - 120000;
                rknForceIds.forEach((ts, id) => { if (ts < cutoff) rknForceIds.delete(id); });
            }
        } catch (_) {}
    }
    // id треков из URL query И из POST-body: file-info ходит и как
    // GET get-file-info/batch?trackIds=..., и как POST с телом
    function getRequestTrackIds(url, init) {
        const ids = [];
        const push = (x) => {
            try {
                x = String(x).trim().replace(/^["']|["'\]]$/g, "");
                if (x && /^\d+$/.test(x) && !ids.includes(x)) ids.push(x);
            } catch (_) {}
        };
        try {
            const m = String(url || "").match(/trackIds?=([^&#]*)/);
            if (m) decodeURIComponent(m[1]).split(",").forEach(push);
        } catch (_) {}
        try {
            const body = init && init.body;
            if (typeof body === "string" && body) {
                const m2 = body.match(/trackIds?=([^&#\s"'}\]]*)/);
                if (m2) { try { decodeURIComponent(m2[1]).split(",").forEach(push); } catch (_) { m2[1].split(",").forEach(push); } }
                const m3 = body.match(/"trackIds?"\s*:\s*\[([^\]]*)\]/);
                if (m3) { try { (m3[1].match(/\d+/g) || []).forEach(push); } catch (_) {} }
            }
        } catch (_) {}
        return ids;
    }
    function isRknForcedRequest(url, init) {
        try {
            const s = String(url || "");
            if (!s.includes("get-file-info")) return false;
            const ids = getRequestTrackIds(url, init);
            if (!ids.length) return false;
            const now = Date.now();
            return ids.every(id => {
                const ts = rknForceIds.get(String(id));
                if (!(ts && (now - ts) < 120000)) return false;
                // у трека есть замена — file-info ему НУЖЕН (ответ перепишем под неё).
                // Давим только безнадёжные запросы без замены.
                try { if (isReplaced(String(id))) return false; } catch (_) {}
                return true;
            });
        } catch (_) { return false; }
    }
    function installFetchGuard() {
        try {
            if (window.__antiCensorFetchWrapped) return;
            const originalFetch = window.fetch && window.fetch.bind(window);
            if (typeof originalFetch !== "function") return;
            window.__antiCensorFetchWrapped = true;
            window.fetch = function(input, init) {
                // backend-spoof (за флагом): подмена ID до запроса
                try {
                    if (typeof input === "string") {
                        const sp = maybeSpoofBackendRequest(input, init);
                        if (sp) { input = sp.url; init = sp.init; }
                    }
                } catch (_) {}
                let outPromise = null;
                try {
                    const url = typeof input === "string" ? input : (input && input.url);
                    // learn-mode: какие эндпоинты несут ID треков (для выбора целей спуфа)
                    try {
                        if (typeof url === "string" && /(trackIds=|\/tracks|file-info|statistic|scrobble|history|radio|\/play)/i.test(url)) {
                            noteNetSeen(url, getRequestTrackIds(url, init));
                        }
                    } catch (_) {}
                    if (typeof url === "string" && url.includes("get-file-info")) {
                        try {
                            const ids = getRequestTrackIds(url, init);
                            if (ids.length) noteFetchAttempt(ids);
                        } catch (_) {}
                    }
                    if (url && isRknForcedRequest(url, init)) {
                        log("Blocked get-file-info attempt for forced RKN track");
                        try { hudState.blocked++; hlog("netcut get-file-info"); } catch (_) {}
                        let err;
                        try { err = new DOMException("aborted", "AbortError"); }
                        catch (_) { err = new Error("aborted"); err.name = "AbortError"; }
                        return Promise.reject(err);
                    }
                } catch (_) {}
                // явный вызов (файл в strict mode: arguments не алиасит параметры)
                try { outPromise = originalFetch.call(this, input, init); } catch (e) { throw e; }
                // сбор пула доступных ID из метаданных треков (фоном, ответ не трогаем)
                try {
                    const u2 = typeof input === "string" ? input : (input && input.url);
                    if (typeof u2 === "string" && outPromise && typeof outPromise.then === "function") {
                        const kind = classifyPatchTarget(u2);
                        if (kind) {
                            // harvest — с оригинала, patch — новой Response; исходник не трогаем
                            return outPromise.then(resp => {
                                try { harvestBackendPoolFromResponse(u2, resp); } catch (_) {}
                                return patchApiResponse(u2, resp);
                            });
                        }
                        if (/\/tracks\?/.test(u2)) {
                            outPromise.then(resp => { try { harvestBackendPoolFromResponse(u2, resp); } catch (_) {} }).catch(() => {});
                        }
                    }
                } catch (_) {}
                return outPromise;
            };
        } catch (_) {}
    }
    try { installFetchGuard(); } catch (_) {}

    /* === Backend-spoof v2: случайный ID вместо одного жертвенного трека ===
       Клиент всегда играет и показывает выбранный трек как есть.
       Серверу в запросах-статистиках подставляется СЛУЧАЙНЫЙ доступный ID
       из самособранного пула (метаданные /tracks + видимые строки).
       Перезапись выключена флагом BACKEND_SPOOF_WRITE: пока идёт только
       сбор пула и learn-лог эндпоинтов (netSeen в diag). Цели включим,
       когда узнаем имена stat-эндпоинтов из вкладки Network. */
    const BACKEND_SPOOF_WRITE = false;
    const BACKEND_SPOOF_URL_PARTS = [];
    const backendPool = new Set();
    const netSeen = {};
    function noteNetSeen(url, ids) {
        try {
            const path = String(url || "").split("?")[0].slice(-80);
            if (!path) return;
            const rec = netSeen[path] || { n: 0, sample: "" };
            rec.n++;
            if (!rec.sample && ids && ids.length) rec.sample = ids.slice(0, 5).join(",");
            netSeen[path] = rec;
        } catch (_) {}
    }
    function poolAdd(id) {
        try {
            id = String(id);
            if (!id || !/^\d+$/.test(id)) return;
            backendPool.add(id);
            if (backendPool.size > 500) {
                const f = backendPool.values().next().value;
                backendPool.delete(f);
            }
        } catch (_) {}
    }
    // кэш метаданных из API-ответов: title/artist/cover по id.
    // Нужен когда из строки DOM название не вытащить, а API его отдавал.
    const metaCache = {};
    function metaCacheStore(t) {
        try {
            if (!t || typeof t !== "object") return;
            const id = t.id ?? t.trackId;
            if (id == null) return;
            let artist = null;
            try {
                if (Array.isArray(t.artists) && t.artists.length) artist = t.artists.map(a => (a && a.name) || "").filter(Boolean).join(", ") || null;
                else if (typeof t.artist === "string") artist = t.artist;
                else if (t.artist && t.artist.name) artist = t.artist.name;
            } catch (_) {}
            let cover = null;
            let albumTitle = null, albumCover = null;
            try {
                // у треков Яндекса обложка часто только в альбоме, а не в треке
                try {
                    const alb = (Array.isArray(t.albums) && t.albums[0]) || t.album || null;
                    if (alb) {
                        try {
                            if (typeof alb.title === "string" && alb.title) albumTitle = alb.title;
                        } catch (_) {}
                        try {
                            const araw = alb.coverUri ?? alb.cover ?? alb.ogImage ?? null;
                            if (typeof araw === "string" && araw) albumCover = araw;
                            else if (araw && typeof araw === "object" && typeof araw.uri === "string") albumCover = araw.uri;
                        } catch (_) {}
                        if ((t.coverUri ?? t.cover ?? t.ogImage) == null && albumCover) {
                            t = { ...t, coverUri: albumCover };
                        }
                    }
                } catch (_) {}
                const raw = t.coverUri ?? t.cover ?? t.ogImage ?? null;
                if (typeof raw === "string" && raw) cover = raw;
                else if (raw && typeof raw === "object" && typeof raw.uri === "string") cover = raw.uri;
            } catch (_) {}
            const prev = metaCache[String(id)] || {};
            metaCache[String(id)] = {
                title: (typeof t.title === "string" && t.title) || prev.title || null,
                artist: artist || prev.artist || null,
                cover: cover || prev.cover || null,
                albumTitle: albumTitle || prev.albumTitle || null,
                albumCover: albumCover || prev.albumCover || null
            };
            const keys = Object.keys(metaCache);
            if (keys.length > 1000) { try { delete metaCache[keys[0]]; } catch (_) {} }
        } catch (_) {}
    }
    function metaCacheGet(id) {
        try { return metaCache[String(id)] || null; } catch (_) { return null; }
    }
    function coverUrlFromUri(u) {
        try {
            const s = String(u || "");
            if (/^https?:/i.test(s)) return s;
            if (/^[a-z0-9.-]+\//i.test(s)) return "https://" + s.replace("%%", "400x400");
            return null;
        } catch (_) { return null; }
    }
    function harvestBackendPoolFromResponse(url, resp) {
        try {
            if (!resp || typeof resp.clone !== "function") return;
            resp.clone().json().then(data => {
                try {
                    // shape ответа один раз в консоль: узнаём реальные ключи метаданных
                    try {
                        if (!window.__antiShapeLogged) {
                            window.__antiShapeLogged = true;
                            const list0 = Array.isArray(data) ? data : (data && (data.result || data.tracks || data.items)) || [];
                            const first = Array.isArray(list0) && list0.length ? list0[0] : null;
                            let keys = "?";
                            try { keys = first && typeof first === "object" ? Object.keys(first).slice(0, 25).join(",") : String(typeof first); } catch (_) {}
                            console.log("[CensorAbuse] tracks shape: keys=[" + keys + "]");
                        }
                    } catch (_) {}
                    const list = Array.isArray(data) ? data : (data && (data.result || data.tracks || data.items)) || [];
                    (Array.isArray(list) ? list : []).forEach(t => {
                        try {
                            const id = t && (t.id ?? t.trackId);
                            if (id == null) return;
                            try { metaCacheStore(t); } catch (_) {}
                            if (t.available === false) return; // заблокированные в пул не берём
                            poolAdd(id);
                        } catch (_) {}
                    });
                } catch (_) {}
            }).catch(() => {});
        } catch (_) {}
    }
    function seedPoolFromDom() {
        try {
            document.querySelectorAll(".CommonTrack_root__i6shE").forEach(ctr => {
                let tid = null;
                try { tid = getTrackIdFromNode(ctr); } catch (_) {}
                if (!tid) return;
                try { if (isRowDisabled(ctr)) return; } catch (_) {}
                poolAdd(tid);
            });
        } catch (_) {}
    }
    function pickRandomBackendId(excludeId) {
        try {
            seedPoolFromDom();
            const arr = [...backendPool].filter(id => id && String(id) !== String(excludeId));
            if (!arr.length) return null;
            return arr[Math.floor(Math.random() * arr.length)];
        } catch (_) { return null; }
    }
    function shouldSpoofBackend(url) {
        try {
            const s = String(url || "");
            if (!BACKEND_SPOOF_WRITE || !BACKEND_SPOOF_URL_PARTS.length) return false;
            return BACKEND_SPOOF_URL_PARTS.some(p => s.includes(p));
        } catch (_) { return false; }
    }
    // Меняем ТОЛЬКО id треков с заменой (цензура/RKN), остальные не трогаем.
    // Ответы stat-запросов — обычные ack, их не правим.
    function maybeSpoofBackendRequest(url, init) {
        try {
            if (typeof url !== "string" || !shouldSpoofBackend(url)) return null;
            const ids = getRequestTrackIds(url, init);
            if (!ids.length) return null;
            const swap = {};
            ids.forEach(id => {
                try {
                    if (isReplaced(id)) {
                        const rnd = pickRandomBackendId(id);
                        if (rnd && rnd !== String(id)) swap[String(id)] = rnd;
                    }
                } catch (_) {}
            });
            const keys = Object.keys(swap);
            if (!keys.length) return null;
            // замена строго по границам числа, чтобы не задеть подписи и чужие цифры
            const reOf = (k) => { try { return new RegExp("(?<!\\d)" + k + "(?!\\d)", "g"); } catch (_) { return null; } };
            let newUrl = url;
            keys.forEach(k => { try { const re = reOf(k); if (re) newUrl = newUrl.replace(re, swap[k]); } catch (_) {} });
            let newInit = init;
            try {
                if (init && typeof init.body === "string" && init.body) {
                    let b = init.body;
                    keys.forEach(k => { try { const re = reOf(k); if (re) b = b.replace(re, swap[k]); } catch (_) {} });
                    if (b !== init.body) newInit = { ...init, body: b };
                }
            } catch (_) {}
            try { hlog("spoof backend " + keys.length + " id(s)"); } catch (_) {}
            try { setHudErr("SPOOF"); } catch (_) {}
            return { url: newUrl, init: newInit };
        } catch (_) { return null; }
    }

    /* XHR-хук: половина API ходит через axios/XHR, а не fetch.
       Ответы НЕ трогаем (проблема порядка обработчиков), только learn-лог
       и body-rewrite за флагом. Query переписать после open() нельзя чисто —
       для XHR поддерживается только body-rewrite. */
    function installXhrGuard() {
        try {
            if (window.__antiCensorXhrWrapped) return;
            const XHR = window.XMLHttpRequest;
            if (!XHR || !XHR.prototype) return;
            const origOpen = XHR.prototype.open;
            const origSend = XHR.prototype.send;
            if (typeof origOpen !== "function" || typeof origSend !== "function") return;
            window.__antiCensorXhrWrapped = true;
            XHR.prototype.open = function(method, url) {
                try { this.__antiUrl = typeof url === "string" ? url : (url && url.toString ? url.toString() : ""); } catch (_) {}
                // слушатель вешаем ЗДЕСЬ (до обработчиков axios): иначе patch ответа опоздает
                try {
                    this.__antiPatchKind = classifyPatchTarget(this.__antiUrl);
                    if (this.__antiPatchKind && !this.__antiPatchHooked) {
                        this.__antiPatchHooked = true;
                        this.addEventListener("load", function() {
                            try { patchXhrResponse(this); } catch (_) {}
                        });
                    }
                } catch (_) {}
                return origOpen.apply(this, arguments);
            };
            XHR.prototype.send = function(body) {
                let outBody = body;
                try {
                    const url = this.__antiUrl || "";
                    if (url && /(trackIds=|\/tracks|file-info|statistic|scrobble|history|radio|\/play)/i.test(url)) {
                        try {
                            noteNetSeen(url, getRequestTrackIds(url, { body: typeof body === "string" ? body : null }));
                        } catch (_) {}
                    }
                    try {
                        if (shouldSpoofBackend(url) && typeof body === "string" && body) {
                            const sp = maybeSpoofBackendRequest(url, { body });
                            if (sp && sp.init && typeof sp.init.body === "string" && sp.init.body !== body) {
                                outBody = sp.init.body;
                            }
                        }
                    } catch (_) {}
                } catch (_) {}
                return origSend.call(this, outBody);
            };
        } catch (_) {}
    }
    try { installXhrGuard(); } catch (_) {}

    /* === MITM ответов API: трек как будто не удаляли ===
       Натив целиком ведёт воспроизведение (плеербар, прогресс, seek, очередь,
       статистика), мы только правим JSON по дороге, сверхоборонительно:
       непонятная структура = ответ не трогаем, работают старые фолбэки.
       - tracks/with-tracks: available:false -> true для треков с заменой
         (серые строки оживают, модалки нет, очередь штатная);
       - disclaimers: выкидываем записи, привязанные к нашим ID;
       - get-file-info: URL потоков меняем на файл замены (натив качает наше,
         сервер видит обычный запрос как за неудалённый трек).
       Названия/обложки/артисты НЕ трогаем никогда. Не-JSON и неуспешные
       статусы не трогаем никогда. */
    function classifyPatchTarget(url) {
        try {
            const s = String(url || "");
            if (!s.includes("api.music.yandex.net")) return null;
            if (!hasAnyReplacements()) return null;
            if (s.includes("get-file-info")) return "fileinfo";
            const path = s.split("?")[0];
            if (path.includes("/disclaimers")) return "disclaimers";
            if (/\/tracks(\?|$)/.test(path) || /\/albums\/\d+\/with-tracks/.test(path)) return "tracks";
            return null;
        } catch (_) { return null; }
    }
    function hasAnyReplacements() {
        try {
            if (localTrackIds && localTrackIds.length) return true;
            if (assetsTracks && Object.keys(assetsTracks).length) return true;
            if (remoteTracks && Object.keys(remoteTracks).length) return true;
            return false;
        } catch (_) { return false; }
    }
    function nodeTrackId(node) {
        try {
            if (!node || typeof node !== "object") return null;
            if (typeof node.id === "number") return node.id;
            if (typeof node.trackId === "number") return node.trackId;
            if (typeof node.track_id === "number") return node.track_id;
            return null;
        } catch (_) { return null; }
    }
    function nodeHasUrlish(node) {
        try {
            for (const k of Object.keys(node)) {
                if (!/^(urls?|files?|streams?|src|download\w*|stream\w*|file\w*|direct\w*)$/i.test(k)) continue;
                const v = node[k];
                if (typeof v === "string" && v) return true;
                if (Array.isArray(v) && v.length) return true;
            }
            return false;
        } catch (_) { return false; }
    }
    // трекоподобные объекты любых известных форм (плейлисты, альбомы-volumes, file-info)
    function collectTrackLikes(root) {
        const out = [];
        const seen = new Set();
        let count = 0;
        const walk = (node, depth) => {
            if (!node || depth > 6 || count > 5000) return;
            if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return; }
            if (typeof node !== "object") return;
            if (seen.has(node)) return;
            seen.add(node);
            count++;
            const tid = nodeTrackId(node);
            if (tid != null && (
                typeof node.title === "string" ||
                typeof node.durationMs === "number" ||
                typeof node.duration === "number" ||
                ("available" in node) ||
                nodeHasUrlish(node)
            )) {
                out.push(node);
            }
            let keys = null;
            try { keys = Object.keys(node); } catch (_) { return; }
            for (const k of keys) {
                try { const v = node[k]; if (v && typeof v === "object") walk(v, depth + 1); } catch (_) {}
            }
        };
        try { walk(root, 0); } catch (_) {}
        return out;
    }
    function isMediaUrl(v) {
        try {
            const s = String(v);
            if (!/^(https?:|blob:)/i.test(s)) return false;
            return /\.(mp3|flac|aac|ogg|oga|wav|m4a|mp4|opus|webm)(\?|#|$)/i.test(s)
                || /(get-?mp3|get-?file|stream|audio|download|\/file)/i.test(s);
        } catch (_) { return false; }
    }
    // синхронная ссылка на замену (local — из прогретого кэша; remote/assets всегда синхронны)
    function getReplacementUrlSync(trackId) {
        try {
            const r = getReplaced(trackId);
            if (!r || r.src === "remote_exception") return null;
            if (r.src === "local") return localTracksUrlCache[String(trackId)] || null;
            return r.url || null;
        } catch (_) { return null; }
    }
    // прогрев кэша локальных URL заранее (на клике/модалке), чтобы к file-info был готов
    function warmReplacementUrl(trackId) {
        try {
            if (!trackId) return;
            const p = getReplacedUrl(String(trackId));
            if (p && typeof p.catch === "function") p.catch(() => {});
        } catch (_) {}
    }
    function patchApiResponseData(kind, data) {
        try {
            if (kind === "tracks") {
                const tracks = collectTrackLikes(data);
                let changed = false;
                tracks.forEach(t => {
                    try {
                        const id = nodeTrackId(t);
                        if (id == null || !isReplaced(String(id))) return;
                        // минимум: только флаг доступности. Премиум/регион-флаги не трогаем.
                        if (t.available === false) { t.available = true; changed = true; }
                    } catch (_) {}
                });
                return { data, changed };
            }
            if (kind === "disclaimers") {
                const arr = Array.isArray(data) ? data : (data && Array.isArray(data.result) ? data.result : null);
                if (!arr) return { data, changed: false };
                const kept = arr.filter(entry => {
                    try {
                        const s = JSON.stringify(entry);
                        const nums = s.match(/\d{5,}/g) || [];
                        for (let i = 0; i < Math.min(nums.length, 20); i++) {
                            try { if (isReplaced(nums[i])) return false; } catch (_) {}
                        }
                        return true;
                    } catch (_) { return true; }
                });
                if (kept.length === arr.length) return { data, changed: false };
                if (Array.isArray(data)) return { data: kept, changed: true };
                return { data: { ...data, result: kept }, changed: true };
            }
            if (kind === "fileinfo") {
                const likes = collectTrackLikes(data);
                let changed = false;
                likes.forEach(t => {
                    try {
                        const id = nodeTrackId(t);
                        if (id == null || !isReplaced(String(id))) return;
                        const url = getReplacementUrlSync(String(id));
                        if (!url) return; // кэш не прогрет — ответ не трогаем, сработает direct-фолбэк
                        for (const k of Object.keys(t)) {
                            if (!/^(urls?|files?|streams?|src|download\w*|stream\w*|file\w*|direct\w*)$/i.test(k)) continue;
                            const v = t[k];
                            if (typeof v === "string" && isMediaUrl(v)) { t[k] = url; changed = true; }
                            else if (Array.isArray(v) && v.length) {
                                let touched = false;
                                const nv = v.map(item => {
                                    if (typeof item === "string" && isMediaUrl(item)) { touched = true; return url; }
                                    if (item && typeof item === "object" && typeof item.url === "string" && isMediaUrl(item.url)) {
                                        touched = true;
                                        const cp = {};
                                        try { Object.keys(item).forEach(kk => { cp[kk] = item[kk]; }); } catch (_) {}
                                        cp.url = url;
                                        return cp;
                                    }
                                    return item;
                                });
                                if (touched) { t[k] = nv; changed = true; }
                            }
                        }
                    } catch (_) {}
                });
                return { data, changed };
            }
        } catch (_) {}
        return { data, changed: false };
    }
    async function patchApiResponse(url, resp) {
        try {
            if (!resp || typeof resp.clone !== "function") return resp;
            const kind = classifyPatchTarget(url);
            if (!kind) return resp;
            let ct = "";
            try { ct = resp.headers.get("content-type") || ""; } catch (_) {}
            if (!/json/i.test(ct)) return resp; // байты/стримы не трогаем
            if (resp.status < 200 || resp.status >= 300) return resp;
            let data = null;
            try { data = await resp.clone().json(); } catch (_) { return resp; }
            if (data == null || typeof data !== "object") return resp;
            const out = patchApiResponseData(kind, data);
            if (!out || !out.changed) return resp;
            const body = JSON.stringify(out.data);
            const headers = new Headers();
            try {
                resp.headers.forEach((v, k) => {
                    try {
                        const lk = String(k).toLowerCase();
                        if (lk === "content-length" || lk === "content-encoding") return; // тело пересобрано
                        headers.append(k, v);
                    } catch (_) {}
                });
            } catch (_) {}
            try { headers.set("content-type", "application/json;charset=utf-8"); } catch (_) {}
            try { hlog("api patch " + kind); } catch (_) {}
            return new Response(body, { status: resp.status, statusText: resp.statusText, headers });
        } catch (_) { return resp; }
    }
    function patchXhrResponse(xhr) {
        try {
            const kind = xhr.__antiPatchKind;
            if (!kind || !hasAnyReplacements()) return;
            let ct = "";
            try { ct = xhr.getResponseHeader("Content-Type") || ""; } catch (_) {}
            if (!/json/i.test(ct)) return;
            const rawGetter = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "responseText").get;
            if (typeof rawGetter !== "function") return;
            const raw = rawGetter.call(xhr);
            let data = null;
            try { data = JSON.parse(raw); } catch (_) { return; }
            const out = patchApiResponseData(kind, data);
            if (!out || !out.changed) return;
            const text = JSON.stringify(out.data);
            try { Object.defineProperty(xhr, "responseText", { value: text, configurable: true, writable: true }); } catch (_) {}
            try {
                const rt = xhr.responseType;
                if (!rt || rt === "text") Object.defineProperty(xhr, "response", { value: text, configurable: true, writable: true });
                else if (rt === "json") Object.defineProperty(xhr, "response", { value: out.data, configurable: true, writable: true });
            } catch (_) {}
            try { hlog("xhr patch " + kind); } catch (_) {}
        } catch (_) {}
    }

    function recordTrackClick(e) {
        try {
            let t = e && e.target;
            if (!t) return;
            for (let i = 0; i < 12 && t; i++) {
                if (t === document || t === document.documentElement) break;
                let tid = null;
                try { tid = getTrackIdFromNode(t); } catch (_) {}
                if (!tid) {
                    try {
                        const ip = t.dataset && t.dataset.intersectionPropertyId;
                        const m = ip && ip.match(/track_(\d+)/);
                        tid = m && m[1];
                    } catch (_) {}
                }
                if (!tid) {
                    // ссылки вида /track/12345 — ещё один независимый источник id
                    try {
                        const href = (t.getAttribute && t.getAttribute("href")) || t.href || "";
                        const m = String(href).match(/\/track\/(\d+)/);
                        tid = m && m[1];
                    } catch (_) {}
                }
                let isRow = false;
                try { isRow = !!(t.matches && t.matches(".CommonTrack_root__i6shE, [data-test-id='TRACK_ALBUM']")); } catch (_) {}
                if (tid || isRow) {
                    lastTrackClick = { row: t, trackId: tid ? String(tid) : null, ts: Date.now() };
                    try {
                        let src = "?";
                        try { const r = tid ? getReplaced(tid) : null; src = r ? r.src : "orig"; } catch (_) {}
                        hudState.press = tid ? (tid + "/" + src) : "row?";
                        hlog("click tid=" + tid);
                        updateHud();
                    } catch (_) {}
                    return;
                }
                try { t = t.parentElement || t.parentNode || null; } catch (_) { return; }
                try { if (t && t.nodeType && t.nodeType !== 1) t = t.parentNode || null; } catch (_) { return; }
            }
        } catch (_) {}
    }

    function noteFetchAttempt(ids) {
        try {
            if (ids && ids.length) lastFetchAttempt = { ids: ids.map(String), ts: Date.now() };
        } catch (_) {}
    }

    // RKN-модалка уже на экране: если она вылезла сразу после клика по
    // подменённому треку — сносим её и насильно включаем подмену.
    // Возвращает true если модалка была RKN.
    function handleShownRknModal(modal) {
        try {
            const c = lastTrackClick;
            let tid = null;
            let useRow = null;
            if (c && (Date.now() - c.ts) <= 2000) {
                tid = c.trackId;
                useRow = c.row || null;
                if (!tid && useRow) { try { tid = getTrackIdFromNode(useRow); } catch (_) {} }
            }
            if (!tid) {
                // запасной сигнал: натив сам запросил file-info по id —
                // берём свежий запрос с подменённым треком
                try {
                    const f = lastFetchAttempt;
                    if (f && (Date.now() - f.ts) < 3000) {
                        for (const fid of f.ids) {
                            let ok = false;
                            try { ok = isReplaced(fid); } catch (_) {}
                            if (ok) { tid = String(fid); break; }
                        }
                    }
                } catch (_) {}
            }
            if (!tid) return true;
            let rep = false;
            try { rep = isReplaced(tid); } catch (_) {}
            if (!rep) return true;
            try { warmReplacementUrl(tid); } catch (_) {}
            log("RKN modal after click on replaced track " + tid + " — force playing");
            lastTrackClick = null;
            try { killRknModals(); } catch (_) {}
            try { armRknCss(); } catch (_) {}
            setTimeout(() => { try { const p = playReplacedDirectly(String(tid), useRow); if (p && typeof p.catch === "function") p.catch(e => log("decoy modal replay failed", e)); } catch (_) {} }, 0);
        } catch (_) {}
        return true;
    }

    function handleRknPress(e) {
        try { if (isProgrammaticClick()) return; } catch (_) {}
        try { ensureHud(); } catch (_) {}
        try { recordTrackClick(e); } catch (_) {}
        // наш собственный клик по decoy-строке — пропускаем без перехвата
        try {
            if (allowDecoyPassthroughId && (Date.now() - allowDecoyPassthroughTs) < 1500) {
                let tid = null;
                try { tid = e.target?.closest?.(".CommonTrack_root__i6shE") ? getTrackIdFromNode(e.target.closest(".CommonTrack_root__i6shE")) : null; } catch (_) {}
                if (!tid || String(tid) === String(allowDecoyPassthroughId)) {
                    allowDecoyPassthroughId = null;
                    // cover-сессию НЕ трогаем: это наш decoy, натив должен играть штатно
                    return; // дальше штатно: натив сам включит заглушку
                }
            }
        } catch (_) {}
        let row = null;
        try { row = e.target?.closest?.(".CommonTrack_root__i6shE, [data-test-id='TRACK_ALBUM']"); } catch (_) {}
        if (!row) {
            // closest не нашёл (другая разметка) — берём строку из только
            // что записанного клика с подъёмом по родителям
            try {
                const c = lastTrackClick;
                if (c && c.row && (Date.now() - c.ts) < 1000) row = c.row;
            } catch (_) {}
        }
        if (!row) return;
        // свежий клик по строке = новое намерение: снимаем ручную паузу,
        // иначе модальный цикл не сможет ничего включить после bridge-паузы
        try { manualPauseUntil = 0; } catch (_) {}
        const trackRoot = row.closest?.(".CommonTrack_root__i6shE") || row;
        let trackId = null;
        try { trackId = getTrackIdFromNode(trackRoot); } catch (_) {}
        // fallback: recordTrackClick выше мог вытащить id из ссылки /track/ID
        // или intersection-id, а fiber-разбор — нет. Без id клик по
        // disabled-строке глотается молча: ни decoy, ни direct-аудио.
        if (!trackId) {
            try {
                const c = lastTrackClick;
                if (c && c.trackId && (Date.now() - c.ts) < 1500) trackId = String(c.trackId);
            } catch (_) {}
        }
        let replaced = false;
        try { replaced = trackId ? isReplaced(trackId) : false; } catch (_) {}
        // ВАЖНО: фиксируем исходное disabled-состояние ДО enableRknRow —
        // чистка классов/aria ниже иначе делает проверку бессмысленной и
        // подменённый РКН-трек уходит в нативный плеер, где его режет блок.
        let disabled = false;
        try {
            disabled =
                trackRoot.classList?.contains("CommonTrack_root_disabled__vDyCm") ||
                !!trackRoot.querySelector(".Meta_root_disabled__Dpx_M, .CommonControlsBar_controls_disabled__0RmLo") ||
                (trackRoot.getAttribute?.("aria-label") || "").includes("Воспроизведение недоступно");
        } catch (_) {}
        if (trackId && replaced) {
            try { enableRknRow(trackRoot, trackId); } catch (_) {}
        }
        if (!disabled) {
            // обычный трек: глушим своё аудио, закрываем cover-сессию, дальше штатно.
            // Если это наш decoy из активной cover-сессии — cover НЕ сбрасываем.
            try {
                const cur = window.pulsesyncApi?.getCurrentTrack?.();
                void cur;
            } catch (_) {}
            // cover живёт только в окне синтетической последовательности (~2.5с после setActiveCover).
            // Позже клик по decoy — осознанное действие юзера (хочет послушать сам decoy):
            // cover сбрасываем, иначе хук вечно отдавал бы чужое аудио за этот ID.
            let isDecoyClick = false;
            try {
                isDecoyClick = !!(activeCover && trackId && String(trackId) === String(activeCover.decoyId)
                    && (Date.now() - (activeCover.ts || 0)) < 2500);
            } catch (_) {}
            if (!isDecoyClick) {
                try { pauseOwnAudio("normal track"); } catch (_) {}
            }
            return;
        }
        // disabled-строка: событие НЕ режем — пусть натив попробует сам.
        // Тогда его currentEntity встанет на выбранный трек (плеербар честно
        // покажет именно его), вылезет модалка, мы её прибьём в modal-path
        // и вольём подмену в ЕГО audio-элемент: пауза/seek/громкость из UI.
        // Дедуп: один клик даёт pointerdown+mousedown+click — дальше раз в 700мс.
        try {
            const now = Date.now();
            if (trackId && lastPressId && String(lastPressId) === String(trackId) && (now - lastPressTs) < 700) {
                return; // повторный tick того же клика
            }
            lastPressId = trackId;
            lastPressTs = now;
            lastRknForceTs = now;
        } catch (_) {}
        // свежий запуск трека: при старте мотнём в начало (сторожевое lastAntiTrackId)
        try { lastAntiTrackId = null; } catch (_) {}
        try { markRknForced(trackId); } catch (_) {}
        try { touchRknSession(); } catch (_) {}
        try { armRknCss(); } catch (_) {}
        try {
            const probe = trackId ? getReplaced(trackId) : null;
            log("RKN press pass-through trackId=" + trackId + " replaced=" + (probe ? probe.src : "none"));
            hudState.press = String(trackId) + "/" + (probe ? probe.src : "none");
            hlog("press " + trackId + " " + (probe ? probe.src : "none"));
            // греем кэш локального URL заранее, чтобы file-info-патчеру хватило синхронного чтения
            try { if (probe) warmReplacementUrl(trackId); } catch (_) {}
        } catch (_) {}
        // страховка: если модалка так и не появилась (натив молча сдался) —
        // играем сами через modal-path функцию напрямую
        if (trackId) {
            try {
                const myId = String(trackId);
                const seenModals = hudState.modals;
                setTimeout(() => {
                    try {
                        if (hudState.modals !== seenModals) return; // модалка была — modal-path уже работает
                        let busy = false;
                        try { busy = !!(antiAudio && !antiAudio.paused); } catch (_) {}
                        if (busy) return;
                        let owned = false;
                        try {
                            wiredAudios.forEach(a => {
                                try { if (a.__antiOwned && String(a.__antiOwned.trackId) === myId) owned = true; } catch (_) {}
                            });
                        } catch (_) {}
                        if (owned) return; // уже звучит через нативный элемент
                        const p = playReplacedDirectly(myId, trackRoot);
                        if (p && typeof p.catch === "function") p.catch(e => log("disabled fallback failed", e));
                    } catch (_) {}
                }, 1500);
            } catch (_) {}
        }
        return; // дальше штатно, без preventDefault: натив ведёт очередь и плеербар
    }
    ["pointerdown", "mousedown", "click"].forEach(t => {
        try { document.addEventListener(t, handleRknPress, true); } catch (_) {}
    });
    try { document.addEventListener("click", handlePlayerbarPress, true); } catch (_) {}

    try {
        window.pulsesyncApi._waitForPlayer(player => {
            try { updatePlayerbarReplacedMark(); } catch (_) {}
            // один раз фиксируем реальную поверхность API плеера — пригодится для починки decoy
            try {
                if (!window.__antiCensorApi) {
                    const s = window.sonataState || {};
                    const mp = s.currentMediaPlayer && s.currentMediaPlayer.value && s.currentMediaPlayer.value.currentMediaPlayer;
                    window.__antiCensorApi = {
                        apiKeys: safeKeys(window.pulsesyncApi),
                        playerKeys: safeKeys(player),
                        mediaPlayerKeys: safeKeys(mp, 60),
                        queueKeys: safeKeys(s.queueState, 40),
                    };
                    hlog("api surface saved, use __antiCensorDiag()");
                }
            } catch (_) {}
            try { player.state?.queueState?.currentEntity?.onChange(() => {
                try {
                    // ушли с decoy на другой трек — cover-сессия закрыта
                    const cur = window.pulsesyncApi?.getCurrentTrack?.();
                    if (activeCover && cur && String(cur.id) !== String(activeCover.decoyId)) {
                        clearActiveCover("entity change");
                    }
                } catch (_) {}
                try { updatePlayerbarReplacedMark(); } catch (_) {}
            }); } catch (_) {}
        });
    } catch (_) {}

    try { addReplacedMarks(); } catch (e) { log("initial addReplacedMarks failed", e); }
})();