// ==UserScript==
// @name         Celebforum downloader
// @namespace    http://tampermonkey.net/
// @version      2026-10-16
// @description  try to take over the world!
// @author       You
// @match        https://celebforum.cc/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=celebforum.cc
// @grant        none
// @connect      celebforum.cc
// @run-at       document-idle
// ==/UserScript==


(function () {
    // CAMBIO: acepta cualquier documento (la actual o una página traída con fetch) y resuelve el href a absoluto
    function collect(root = document) {
        const set = new Set();
        root.querySelectorAll('a[href*="/attachments/"]').forEach(a => {
            const u = new URL(a.getAttribute('href'), location.origin).href;
            if (/\/attachments\/[^/]+\.\d+\/?$/.test(u)) set.add(u);
        });
        return [...set];
    }

    // NUEVO: primera línea de texto de un .bbWrapper (no usa innerText: no funciona en documentos traídos con fetch)
    function firstLine(w) {
        const c = w.cloneNode(true);
        c.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
        c.querySelectorAll('div,p,li').forEach(e => e.append('\n'));
        return c.textContent.split('\n').map(s => s.trim()).find(Boolean) || '';
    }

    // nombre del set = primera línea con texto de un .bbWrapper
    function cleanName(s) {
        return s
            .replace(/[\\/:*?"<>|]/g, '_')   // caracteres no válidos en Windows
            .replace(/[. ]+$/, '')           // sin punto ni espacio al final
            .slice(0, 100);
    }

    // CAMBIO: el slug del hilo sale de cualquier ruta, no solo de la página actual (la cola procesa otros hilos)
    const fallbackOf = path => (path.match(/\/threads\/([^/]+)/) || [])[1] || 'set';
    const threadFallback = fallbackOf(location.pathname);

    // nombre de la carpeta del hilo = .threadTitle (o el título de XenForo / el slug de la URL)
    function threadName() {
        const el = document.querySelector('.threadTitle') || document.querySelector('.p-title-value');
        const t = (el ? el.textContent : '').replace(/\s+/g, ' ').trim();
        return cleanName(t) || cleanName(threadFallback);
    }

    // un grupo (carpeta) por cada post con .bbWrapper y adjuntos
    // ctx = { seenUrls, usedNames } se comparte entre páginas para no repetir URLs ni carpetas
    // CAMBIO: fallback = slug del hilo al que pertenece el documento
    // NUEVO: paso 1 — posts de UNA página tal cual (sin deduplicar entre páginas); es lo que se guarda en caché
    function extractPosts(doc) {
        const out = [];
        doc.querySelectorAll('.bbWrapper').forEach((w, i) => {
            // los adjuntos de XenForo suelen estar fuera del .bbWrapper, dentro del mismo post
            const root = w.closest('article.message') || w.closest('.message-body') || w.parentElement;
            const urls = collect(root);
            if (!urls.length) return;
            // datos del post para el manifest.json
            const postId = ((root.dataset && root.dataset.content) || '').replace(/^post-/, '');
            out.push({
                i, urls, title: firstLine(w),
                postId: postId ? `post-${postId}` : '',
                postUrl: postId ? `${location.origin}/posts/${postId}/` : ''
            });
        });
        if (!out.length) { // sin .bbWrapper con adjuntos: todo en una sola carpeta
            const urls = collect(doc);
            if (urls.length) out.push({ i: 0, urls, title: '', postId: '', postUrl: '', whole: true });
        }
        return out;
    }

    // NUEVO: paso 2 — deduplica URLs y asigna nombres de carpeta únicos entre páginas
    // ctx = { seenUrls, usedNames } se comparte entre páginas para no repetir URLs ni carpetas
    function applyCtx(raw, ctx, fallback) {
        const out = [];
        raw.forEach(p => {
            const urls = p.urls.filter(u => !ctx.seenUrls.has(u));
            if (!urls.length) return;
            urls.forEach(u => ctx.seenUrls.add(u));
            const base = p.whole ? fallback : (cleanName(p.title) || `${fallback}-${p.i + 1}`);
            let name = base;
            let n = 2;
            while (ctx.usedNames.has(name)) name = `${base} (${n++})`;
            ctx.usedNames.add(name);
            out.push({ name, urls, title: p.title, postId: p.postId, postUrl: p.postUrl });
        });
        return out;
    }

    // un grupo (carpeta) por cada post con .bbWrapper y adjuntos
    // CAMBIO: fallback = slug del hilo al que pertenece el documento
    function groups(doc, ctx, fallback = threadFallback) {
        return applyCtx(extractPosts(doc), ctx, fallback);
    }

    // paginado — base del hilo, página actual y última página
    const threadBase = location.pathname.replace(/\/page-\d+\/?$/, '').replace(/\/$/, '');
    const currentPage = Number((location.pathname.match(/\/page-(\d+)/) || [])[1] || 1);
    const pageUrl = (tb, p) => `${location.origin}${tb}/` + (p > 1 ? `page-${p}` : ''); // CAMBIO: recibe el hilo
    function lastPage() {
        const nums = [...document.querySelectorAll('.pageNav-main a, .pageNav-page a')]
            .map(a => parseInt(a.textContent, 10)).filter(Number.isFinite);
        return Math.max(currentPage, ...nums, 1);
    }

    // NUEVO: descriptor de un hilo para procesarlo (el actual o uno guardado en la cola)
    const mkThread = (tb, title, url, pages) => ({
        threadBase: tb, title: title || cleanName(fallbackOf(tb)), url, pages,
        fallback: fallbackOf(tb), isCurrent: tb === threadBase
    });
    const curThread = pages => mkThread(threadBase, threadName(), `${location.origin}${threadBase}/`, pages);

    // ===== persistencia =====

    // Espera que no se frena en segundo plano: los timers de la pestaña se limitan a ~1/min tras 5 min oculta,
    // pero los de un Worker no. Si el sitio bloquea el Worker (CSP), cae a setTimeout normal.
    const sleep = (() => {
        let w = null, id = 0;
        const pend = new Map();
        const flush = () => { pend.forEach(r => r()); pend.clear(); w = null; };
        try {
            w = new Worker(URL.createObjectURL(new Blob(['onmessage=e=>setTimeout(()=>postMessage(e.data.id),e.data.ms)'])));
            w.onmessage = e => { const r = pend.get(e.data); if (r) { pend.delete(e.data); r(); } };
            w.onerror = flush;
        } catch (e) { w = null; }
        return ms => new Promise(res => {
            if (!w) return setTimeout(res, ms);
            const i = ++id;
            pend.set(i, res);
            w.postMessage({ id: i, ms });
            setTimeout(() => { if (pend.delete(i)) res(); }, ms + 3000); // red de seguridad
        });
    })();

    // IndexedDB: guarda el handle de la carpeta base para no volver a elegirla tras recargar
    const idb = () => new Promise((res, rej) => {
        const r = indexedDB.open('cfdl', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
    const idbGet = async k => { const db = await idb(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); };
    const idbSet = async (k, v) => { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); };

    const idbDel = async k => { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); };

    // NUEVO: caché del escaneo por hilo (IndexedDB): qué páginas ya se leyeron y qué adjuntos tenían
    const scanKey = tb => `scan:${tb}`;
    const SCAN_TTL = 3 * 24 * 3600 * 1000; // pasado este tiempo se vuelve a leer (el hilo pudo cambiar)

    // CAMBIO: claves por hilo (parámetro) para poder trabajar con cualquier hilo de la cola
    const jobKey = tb => `cfdl_job:${tb}`;   // localStorage: trabajo pendiente del hilo
    const baseKey = tb => `base:${tb}`;      // IndexedDB: carpeta base usada por el hilo
    const loadJob = tb => { try { return JSON.parse(localStorage.getItem(jobKey(tb))); } catch (e) { return null; } };

    // cola guardada (orden de llegada) para sobrevivir a caídas; una sola clave para todos los hilos
    const QUEUE_KEY = 'cfdl_queue';
    const loadQueue = () => { try { const q = JSON.parse(localStorage.getItem(QUEUE_KEY)); return Array.isArray(q) ? q : []; } catch (e) { return []; } };
    const storeQueue = q => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) { /* sin storage */ } };
    const queueAdd = T => {
        const q = loadQueue();
        const i = q.findIndex(x => x.threadBase === T.threadBase);
        const entry = { threadBase: T.threadBase, url: T.url, title: T.title, pages: T.pages, ts: i >= 0 ? q[i].ts : Date.now() };
        if (i >= 0) q[i] = entry; else q.push(entry); // si ya estaba, conserva su lugar
        storeQueue(q);
    };
    const queueRemove = tb => storeQueue(loadQueue().filter(x => x.threadBase !== tb));
    // NUEVO: sincroniza cfdl_queue (orden) con las claves cfdl_job:* (trabajos reales).
    // Los trabajos son la fuente de verdad: uno sin entrada en la cola se agrega al final; una entrada sin trabajo se quita.
    function reconcileQueue() {
        const jobs = new Map();
        try {
            Object.keys(localStorage).filter(k => k.startsWith('cfdl_job:')).forEach(k => {
                try {
                    const j = JSON.parse(localStorage.getItem(k));
                    if (j && j.threadBase && Array.isArray(j.pages) && j.pages.length) jobs.set(j.threadBase, j);
                } catch (e) { /* clave dañada: se ignora */ }
            });
        } catch (e) { return; }
        const q = loadQueue();
        let changed = false;
        jobs.forEach((j, tb) => {
            const e = q.find(x => x.threadBase === tb);
            if (e) {
                // el título guardado en el trabajo manda sobre uno provisional de la cola
                if (j.title && e.title !== j.title) { e.title = j.title; changed = true; }
                return;
            }
            // trabajos antiguos sin título: provisional = nombre del hilo en la URL; se corrige cuando el hilo se abre o se procesa
            q.push({ threadBase: tb, url: j.url || `${location.origin}${tb}/`, title: j.title || cleanName(fallbackOf(tb)), pages: j.pages, ts: Date.now() });
            changed = true;
        });
        const kept = q.filter(x => jobs.has(x.threadBase));
        if (kept.length !== q.length) changed = true;
        if (changed) storeQueue(kept);
    }

    // NUEVO: manda un hilo al final de la cola guardada (al pausarlo para pasar a otro)
    const moveToEnd = tb => {
        const q = loadQueue();
        const i = q.findIndex(x => x.threadBase === tb);
        if (i < 0) return;
        q.push(q.splice(i, 1)[0]);
        storeQueue(q);
    };

    const saveJob = T => {
        // CAMBIO: conserva el progreso ya guardado si es el mismo trabajo (al reanudar no se pone a cero)
        const prev = loadJob(T.threadBase);
        const same = prev && JSON.stringify(prev.pages) === JSON.stringify(T.pages);
        try { localStorage.setItem(jobKey(T.threadBase), JSON.stringify({ threadBase: T.threadBase, title: T.title, url: T.url, pages: T.pages, progress: same ? prev.progress : undefined })); } catch (e) { /* sin storage */ }
        queueAdd(T);
    };
    // NUEVO: resumen de progreso en localStorage (visible desde la consola y en el panel)
    const saveProgress = (tb, patch) => {
        const job = loadJob(tb);
        if (!job) return;
        job.progress = Object.assign(job.progress || {}, patch, { updatedAt: Date.now() });
        try { localStorage.setItem(jobKey(tb), JSON.stringify(job)); } catch (e) { /* sin storage */ }
    };
    const progressText = (job, np) => {
        const p = job && job.progress;
        if (!p) return '';
        // con total conocido: "470/1284 img"; si aún está leyendo páginas: "1284+ img" (hasta ahora)
        return ` · leídas ${p.pagesRead || 0}/${p.pagesTotal || np}`
            + (p.imgTotal ? ` · ${p.imgOk || 0}/${p.imgTotal} img` : (p.imgFound ? ` · ${p.imgFound}+ img` : ''));
    };
    const clearJob = tb => {
        try { localStorage.removeItem(jobKey(tb)); } catch (e) { /* sin storage */ }
        queueRemove(tb);
        idbDel(scanKey(tb)).catch(() => { /* sin caché que borrar */ }); // terminó o se canceló: la caché ya no sirve
    };

    // candados entre pestañas (Web Locks)
    const threadLock = tb => `cfdl-thread:${tb}`; // el mismo hilo no puede correr dos veces
    const GLOBAL_LOCK = 'cfdl-global';             // cola global: una descarga a la vez en todo el sitio
    async function withLocks(T, fn, onQueued) {
        if (!navigator.locks) { await onQueued(); return fn(); } // sin Web Locks: sin cola
        return navigator.locks.request(threadLock(T.threadBase), { ifAvailable: true }, async tl => {
            if (!tl) throw new Error('THREAD_BUSY');
            await onQueued();
            return navigator.locks.request(GLOBAL_LOCK, fn); // espera su turno en orden de llegada
        });
    }
    async function isThreadBusy(tb) {
        if (!navigator.locks) return false;
        const q = await navigator.locks.query();
        return [...q.held, ...q.pending].some(l => l.name === threadLock(tb));
    }

    // Wake Lock (evita que la pantalla/equipo se suspenda por inactividad)
    let running = false, wakeLock = null;
    let stopReq = null; // NUEVO: null | 'next' (pausar este y pasar al siguiente) | 'all' (pausar todo)
    async function lockOn() {
        try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* no soportado o denegado */ }
    }
    function lockOff() {
        try { if (wakeLock) wakeLock.release(); } catch (e) { /* ya liberado */ }
        wakeLock = null;
    }
    // el Wake Lock se libera solo al ocultar la pestaña: se vuelve a pedir al volver
    document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') lockOn(); });
    // aviso antes de cerrar/recargar mientras corre
    window.addEventListener('beforeunload', e => { if (running) { e.preventDefault(); e.returnValue = ''; } });

    // fetch que pausa y reintenta si Cloudflare muestra el desafío o el foro redirige a /captcha_verify/
    const isBlocked = r => r.headers.get('cf-mitigated') === 'challenge' || /\/captcha_verify/.test(r.url); // fetch sigue la redirección: r.url es la final

    // CAMBIO: un solo aviso a la vez, sin window.open ni alert (el navegador bloquea las ventanas emergentes sin gesto).
    // Se muestra un enlace en la página; al resolver el captcha se detecta solo y se reanuda.
    let gate = null; // promesa del desafío en curso: todos los que choquen con él esperan la misma
    function waitForChallenge(url, blockedRes) {
        if (gate) return gate;
        const cap = /\/captcha_verify/.test(blockedRes.url);
        gate = (async () => {
            noticeLink.href = cap ? blockedRes.url : url;
            noticeText.textContent = cap
                ? 'El foro pide un captcha. Ábrelo, resuélvelo y vuelve: continúa solo.'
                : 'Cloudflare pide verificación. Ábrela, resuélvela y vuelve: continúa solo.';
            notice.style.display = '';
            btnAll.textContent = '⚠ Captcha pendiente (esperando que lo resuelvas)';
            for (;;) {
                await sleep(6000); // sondeo suave: una petición cada 6 s
                if (stopReq) break; // pausa pedida: deja de esperar el captcha
                try {
                    const r = await fetch(url, { credentials: 'include' });
                    try { if (r.body) r.body.cancel(); } catch (e) { /* no importa */ }
                    if (!isBlocked(r)) break;
                } catch (e) { /* sin red: sigue esperando */ }
            }
            notice.style.display = 'none';
        })().finally(() => { gate = null; });
        return gate;
    }

    async function fetchRetry(url) {
        let res = await fetch(url, { credentials: 'include' });
        while (isBlocked(res)) {
            if (stopReq) throw new Error('PAUSED');
            await waitForChallenge(url, res);
            if (stopReq) throw new Error('PAUSED');
            res = await fetch(url, { credentials: 'include' });
        }
        return res;
    }

    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;display:flex;flex-direction:column;gap:6px';
    const btn = document.createElement('button');    // página actual (el de siempre)
    const btnAll = document.createElement('button'); // hilo completo / rango de páginas
    const btnQueue = document.createElement('button');   // NUEVO: procesar la cola guardada desde esta pestaña
    const btnResume = document.createElement('button');  // reanudar trabajo pendiente
    const btnDiscard = document.createElement('button'); // descartar trabajo pendiente
    const btnSkip = document.createElement('button'); // NUEVO: pausar este hilo y pasar al siguiente de la tanda
    const btnStop = document.createElement('button'); // NUEVO: pausar todo
    [btn, btnAll, btnSkip, btnStop, btnQueue, btnResume, btnDiscard].forEach(b => { b.style.cssText = 'padding:8px 12px'; box.appendChild(b); });
    btnSkip.style.display = btnStop.style.display = btnQueue.style.display = btnResume.style.display = btnDiscard.style.display = 'none';
    const SKIP_LABEL = '⏭ Pausar este y pasar al siguiente', STOP_LABEL = '⏹ Pausar todo';
    const resetPauseButtons = () => { btnSkip.disabled = btnStop.disabled = false; btnSkip.textContent = SKIP_LABEL; btnStop.textContent = STOP_LABEL; };
    const requestPause = mode => {
        stopReq = mode;
        btnSkip.disabled = btnStop.disabled = true;
        (mode === 'next' ? btnSkip : btnStop).textContent = 'Pausando… (termina la imagen en curso)';
    };
    btnSkip.onclick = () => requestPause('next');
    btnStop.onclick = () => requestPause('all');
    resetPauseButtons();
    // NUEVO: interruptor — al terminar un hilo, continuar solo con la cola guardada (se recuerda entre sesiones; por defecto activado)
    const autoBox = document.createElement('label');
    autoBox.style.cssText = 'display:flex;gap:6px;align-items:center;max-width:320px;padding:6px 10px;font:12px sans-serif;background:#222;color:#eee;border-radius:6px;cursor:pointer';
    const autoChk = document.createElement('input');
    autoChk.type = 'checkbox';
    try { autoChk.checked = localStorage.getItem('cfdl_auto') !== '0'; } catch (e) { autoChk.checked = true; }
    autoChk.onchange = () => { try { localStorage.setItem('cfdl_auto', autoChk.checked ? '1' : '0'); } catch (e) { /* sin storage */ } };
    autoBox.append(autoChk, 'Continuar con la cola guardada al terminar');
    box.appendChild(autoBox);
    btnDiscard.textContent = 'Descartar descarga pendiente';
    // panel con el orden de la cola global (visible en todas las pestañas)
    const panel = document.createElement('div');
    panel.style.cssText = 'display:none;max-width:320px;padding:8px 12px;font:12px/1.4 sans-serif;background:#222;color:#eee;border-radius:6px;white-space:pre-wrap';
    box.appendChild(panel);
    // NUEVO: aviso visible cuando el foro/Cloudflare pide verificación (reemplaza a window.open + alert)
    const notice = document.createElement('div');
    notice.style.cssText = 'display:none;max-width:320px;padding:10px 12px;font:13px/1.4 sans-serif;background:#b45309;color:#fff;border-radius:6px';
    const noticeText = document.createElement('div');
    const noticeLink = document.createElement('a');
    noticeLink.target = '_blank'; noticeLink.textContent = 'Abrir verificación ↗';
    noticeLink.style.cssText = 'display:inline-block;margin-top:6px;color:#fff;font-weight:bold';
    notice.append(noticeText, noticeLink);
    box.prepend(notice);
    document.body.appendChild(box);

    let myId = null;   // mi clientId de Web Locks (se conoce al entrar a la cola)
    let active = null; // NUEVO: hilo que esta pestaña está procesando ahora
    const bc = (() => { try { return new BroadcastChannel('cfdl-status'); } catch (e) { return null; } })();
    const peers = new Map(); // clientId -> { title, text, tb, seen }: lo que cada pestaña anuncia de sí misma
    if (bc) bc.onmessage = e => {
        const m = e.data;
        if (!m || !m.me) return;
        if (m.gone) peers.delete(m.me); else peers.set(m.me, { title: m.title, text: m.text, tb: m.tb, seen: Date.now() });
    };
    const announce = () => { if (bc && myId && active) bc.postMessage({ me: myId, tb: active.threadBase, title: active.title, text: btnAll.textContent }); };

    // hilos guardados en la cola que ninguna pestaña (ni esta) está atendiendo ahora
    function candidates() {
        const live = new Set();
        peers.forEach(p => { if (Date.now() - p.seen < 10000 && p.tb) live.add(p.tb); });
        if (active) live.add(active.threadBase);
        return loadQueue().filter(x => !live.has(x.threadBase));
    }

    // NUEVO: reordenar la cola guardada (solo afecta a los pendientes sin pestaña; el orden de la cola viva no se puede cambiar)
    function moveInQueue(tb, dir) {
        const q = loadQueue();
        const cand = new Set(candidates().map(x => x.threadBase));
        const i = q.findIndex(x => x.threadBase === tb);
        if (i < 0) return;
        let j = i + dir;
        while (j >= 0 && j < q.length && !cand.has(q[j].threadBase)) j += dir; // salta los que están en curso
        if (j < 0 || j >= q.length) return;
        [q[i], q[j]] = [q[j], q[i]];
        storeQueue(q);
    }
    function sortQueueByPages(asc) {
        const q = loadQueue();
        const cand = new Set(candidates().map(x => x.threadBase));
        const slots = q.map((x, i) => (cand.has(x.threadBase) ? i : -1)).filter(i => i >= 0);
        const sorted = slots.map(i => q[i]).sort((a, b) => ((a.pages || []).length - (b.pages || []).length) * (asc ? 1 : -1));
        slots.forEach((qi, k) => { q[qi] = sorted[k]; });
        storeQueue(q);
    }

    async function renderQueue() {
        reconcileQueue(); // NUEVO: el panel siempre refleja lo que hay en localStorage
        let held = [], pend = [];
        if (navigator.locks) {
            try {
                const s = await navigator.locks.query();
                held = s.held.filter(l => l.name === GLOBAL_LOCK);
                pend = s.pending.filter(l => l.name === GLOBAL_LOCK);
            } catch (e) { /* sin consulta de cola */ }
        }
        const cands = candidates();
        const saved = cands; // CAMBIO: incluye el hilo actual para poder reordenarlo o cancelarlo desde la lista

        // NUEVO: botón para procesar toda la cola guardada desde esta pestaña
        btnQueue.style.display = (!running && cands.length) ? '' : 'none';
        btnQueue.textContent = `Procesar cola guardada (${cands.length} ${cands.length === 1 ? 'hilo' : 'hilos'})`;

        if (!held.length && !pend.length && !saved.length) { panel.style.display = 'none'; return; }

        const info = l => {
            const p = peers.get(l.clientId);
            const fresh = p && Date.now() - p.seen < 10000; // anuncio reciente
            const mine = l.clientId === myId;
            return {
                name: mine ? `${active ? active.title : threadName()} (esta pestaña)` : (fresh ? p.title : 'otra pestaña'),
                text: mine ? btnAll.textContent : (fresh ? p.text : '')
            };
        };
        const frag = document.createDocumentFragment();
        const add = text => { const d = document.createElement('div'); d.textContent = text; frag.appendChild(d); return d; };
        if (held.length || pend.length) {
            add('Cola de descargas').style.fontWeight = 'bold';
            held.forEach(l => { const x = info(l); add(`▶ ${x.name}${x.text ? ' — ' + x.text : ''}`); });
            pend.forEach((l, i) => add(`${i + 1}. ${info(l).name}`));
        }
        if (saved.length) {
            // NUEVO: total general de imágenes de los pendientes (solo los que ya tienen el total conocido)
            let imgAll = 0, imgDone = 0, unknown = 0;
            saved.forEach(x => {
                const p = (loadJob(x.threadBase) || {}).progress;
                if (p && p.imgTotal) { imgAll += p.imgTotal; imgDone += p.imgOk || 0; } else unknown++;
            });
            const h = add(`Pendientes guardados (${saved.length}) · ${imgDone}/${imgAll} img${unknown ? ` (+${unknown} sin contar)` : ''} — abre el hilo o usa "Procesar cola":`);
            h.style.fontWeight = 'bold';
            if (held.length || pend.length) h.style.marginTop = '6px';
            // enlace-acción pequeño (▲ ▼ ✕ y orden por páginas)
            const act = (txt, title, fn, color) => {
                const l = document.createElement('a');
                l.href = '#'; l.textContent = txt; l.title = title;
                l.style.cssText = `color:${color || '#ccc'};text-decoration:none;margin-left:6px`;
                l.onclick = ev => { ev.preventDefault(); fn(); renderQueue(); };
                return l;
            };
            if (saved.length > 1) {
                const s = document.createElement('div');
                s.append('Ordenar por páginas:',
                    act('menos primero ▲', 'De menos a más páginas', () => sortQueueByPages(true), '#8cf'),
                    act('más primero ▼', 'De más a menos páginas', () => sortQueueByPages(false), '#8cf'));
                frag.appendChild(s);
            }
            saved.forEach((x, i) => {
                const d = document.createElement('div');
                const a = document.createElement('a');
                a.href = x.url; a.target = '_blank'; a.style.color = '#8cf'; // pestaña nueva: no interrumpe una descarga en curso
                const np = (x.pages || []).length;
                a.textContent = `${i + 1}. ${x.title || x.threadBase}${x.threadBase === threadBase ? ' (este hilo)' : ''} — ${np} ${np === 1 ? 'pág' : 'págs'}${progressText(loadJob(x.threadBase), np)}`;
                d.append(
                    a,
                    act('▲', 'Subir en la cola', () => moveInQueue(x.threadBase, -1)),
                    act('▼', 'Bajar en la cola', () => moveInQueue(x.threadBase, +1)),
                    act('✕', 'Quitar de la cola (cancelar)', () => {
                        clearJob(x.threadBase);
                        if (x.threadBase === threadBase) btnResume.style.display = btnDiscard.style.display = 'none';
                    }, '#f88')
                );
                frag.appendChild(d);
            });
        }
        panel.replaceChildren(frag);
        panel.style.display = '';
    }
    renderQueue();
    setInterval(renderQueue, 2000);

    let last = '';
    const refresh = () => {
        const g = groups(document, { seenUrls: new Set(), usedNames: new Set() });
        const txt = `Descargar página ${currentPage}: ${g.reduce((s, x) => s + x.urls.length, 0)} adjuntos (${g.length} sets)`;
        if (txt !== last) { last = txt; btn.textContent = txt; }
        if (!running) btnAll.textContent = `Descargar hilo completo (${lastPage()} págs)`;
    };
    refresh();
    setTimeout(refresh, 3000); // una segunda pasada cuando termina la carga diferida

    // CAMBIO: el trabajo recibe el hilo T (actual o de la cola) en vez de leer la página abierta
    async function doRun(base, T) {
        const pages = T.pages;
        btnAll.textContent = 'Iniciando...';
        let threadDir = null, manifest = null;
        // escribe manifest.json en la carpeta del hilo
        const writeManifest = async () => {
            manifest.updatedAt = new Date().toISOString();
            manifest.sets.forEach(s => s.files.sort((a, b) => a.file.localeCompare(b.file)));
            const fh = await threadDir.getFileHandle('manifest.json', { create: true });
            const w = await fh.createWritable();
            await w.write(JSON.stringify(manifest, null, 2));
            await w.close();
        };
        try {
            // carpeta del hilo dentro de la carpeta elegida; los sets van dentro de ella
            threadDir = await base.getDirectoryHandle(cleanName(T.title) || cleanName(T.fallback), { create: true });
            // si ya hay un manifest.json de ejecuciones anteriores, se combina con el nuevo
            try {
                manifest = JSON.parse(await (await (await threadDir.getFileHandle('manifest.json')).getFile()).text());
            } catch (e) { manifest = null; }
            if (!manifest || typeof manifest !== 'object') manifest = {};
            manifest.thread = {
                title: T.title,
                url: T.url,
                pages: [...new Set([...((manifest.thread && manifest.thread.pages) || []), ...pages])].sort((a, b) => a - b)
            };
            if (!Array.isArray(manifest.sets)) manifest.sets = [];
            const ctx = { seenUrls: new Set(), usedNames: new Set() };
            const all = [];
            // NUEVO: caché del escaneo — las páginas ya leídas en una ejecución anterior no se vuelven a pedir
            let scan = null;
            try { scan = await idbGet(scanKey(T.threadBase)); } catch (e) { /* sin IndexedDB */ }
            if (!scan || !scan.pages || Date.now() - scan.ts > SCAN_TTL) scan = { ts: Date.now(), pages: {} };
            for (const p of pages) {
                if (stopReq) throw new Error('PAUSED');
                let raw = scan.pages[p];
                if (raw) {
                    btnAll.textContent = `Página ${p} ya leída (caché)`;
                } else {
                    btnAll.textContent = `Leyendo página ${p}...`;
                    let doc = document;
                    if (!(T.isCurrent && p === currentPage)) {
                        try {
                            const res = await fetchRetry(pageUrl(T.threadBase, p));
                            if (!res.ok) { console.warn('[adjuntos] página fallo', p, res.status); continue; } // no se cachea: se reintenta al reanudar
                            doc = new DOMParser().parseFromString(await res.text(), 'text/html');
                        } catch (e) {
                            console.error('[adjuntos] error página', p, e);
                            continue;
                        }
                        await sleep(1500);
                    }
                    raw = extractPosts(doc);
                    scan.pages[p] = raw;
                    try { await idbSet(scanKey(T.threadBase), scan); } catch (e) { /* sin IndexedDB */ }
                }
                all.push(...applyCtx(raw, ctx, T.fallback));
                // imgFound = adjuntos encontrados hasta ahora (el total real se conoce al leer todas las páginas)
                saveProgress(T.threadBase, { pagesRead: pages.filter(q => scan.pages[q]).length, pagesTotal: pages.length, imgFound: all.reduce((s, x) => s + x.urls.length, 0) });
            }
            const total = all.reduce((s, x) => s + x.urls.length, 0);
            let ok = 0;
            // NUEVO: progreso de imágenes en localStorage (cada 10, y al cerrar cada set)
            const tick = force => { if (force || ok % 10 === 0) saveProgress(T.threadBase, { imgOk: ok, imgTotal: total, setsTotal: all.length }); };
            tick(true);
            const failed = []; // imágenes que no se pudieron guardar tras los reintentos
            for (const { name: setFolder, urls, title, postId, postUrl } of all) {
                const dir = await threadDir.getDirectoryHandle(setFolder, { create: true });
                // entrada del set en el manifest (se reutiliza si ya existía)
                let entry = manifest.sets.find(s => s.folder === setFolder);
                if (!entry) { entry = { folder: setFolder, files: [] }; manifest.sets.push(entry); }
                Object.assign(entry, { postId, postUrl, title });
                const mark = (file, sourceUrl, status) => {
                    const f = entry.files.find(x => x.file === file);
                    if (f) { f.sourceUrl = sourceUrl; f.status = status; } else entry.files.push({ file, sourceUrl, status });
                };
                const pad = Math.max(3, String(urls.length).length); // ancho del número (001, 002, ...)
                for (const [i, url] of urls.entries()) {
                    if (stopReq) throw new Error('PAUSED'); // NUEVO: pausa pedida; el trabajo queda pendiente
                    // nombre según el orden de aparición en el post
                    const fileName = `${String(i + 1).padStart(pad, '0')}.jpg`;
                    // retomar — si el archivo ya existe y no está vacío, se salta
                    try {
                        const f = await (await dir.getFileHandle(fileName)).getFile();
                        if (f.size > 0) { mark(fileName, url, 'ok'); btnAll.textContent = `Guardados ${++ok}/${total}`; tick(); continue; }
                    } catch (e) { /* no existe todavía */ }

                    // hasta 3 intentos con espera creciente
                    let saved = false;
                    for (let attempt = 1; attempt <= 3 && !saved && !stopReq; attempt++) {
                        try {
                            // si Cloudflare muestra el desafío, abrir la imagen en una pestaña, esperar y reintentar
                            const res = await fetchRetry(url);
                            const type = res.headers.get('content-type') || '';

                            if (!res.ok || !type.startsWith('image/')) {
                                console.warn(`[adjuntos] fallo (intento ${attempt})`, res.status, type, url);
                            } else {
                                const fh = await dir.getFileHandle(fileName, { create: true });
                                const w = await fh.createWritable();
                                await w.write(await res.blob());
                                await w.close();
                                mark(fileName, url, 'ok');
                                btnAll.textContent = `Guardados ${++ok}/${total}`;
                                tick();
                                saved = true;
                            }
                        } catch (e) {
                            console.error(`[adjuntos] error (intento ${attempt})`, url, e);
                        }
                        if (!saved && attempt < 3) await sleep(2000 * attempt);
                    }
                    if (!saved && stopReq) throw new Error('PAUSED'); // se pausó a mitad de los intentos: no cuenta como fallo
                    if (!saved) { mark(fileName, url, 'failed'); failed.push({ carpeta: setFolder, archivo: fileName, url }); }
                    await sleep(800);
                }
                tick(true);
                await writeManifest(); // se actualiza al terminar cada set
            }
            await writeManifest();
            btnAll.textContent = `Listo: ${ok}/${total} en ${all.length} carpetas` + (failed.length ? ` — ${failed.length} fallaron (ver consola)` : '');
            if (failed.length) console.table(failed);
            clearJob(T.threadBase); // terminó con normalidad: ya no hay nada pendiente
        } catch (e) {
            if (e && e.message === 'PAUSED') {
                try { if (manifest && threadDir) await writeManifest(); } catch (e2) { /* mejor esfuerzo */ }
                btnAll.textContent = 'Pausado: queda pendiente (ver "Pendientes guardados")';
                return;
            }
            // error inesperado (p. ej. permiso de carpeta): el trabajo queda pendiente para reanudar
            console.error('[adjuntos] detenido', e);
            try { if (manifest && threadDir) await writeManifest(); } catch (e2) { /* mejor esfuerzo */ }
            btnAll.textContent = 'Detenido (ver consola). Recarga y pulsa Reanudar';
        }
    }

    // NUEVO: procesa UN hilo dentro de los candados (cola global + candado del hilo)
    async function runOne(T, b) {
        // recordar la carpeta para reanudar (por hilo) y como punto de partida del próximo selector
        try { await idbSet(baseKey(T.threadBase), b); await idbSet('base:last', b); } catch (e) { /* sin IndexedDB */ }
        active = T;
        let poll = null, announceTimer = null;
        const stopPoll = () => { if (poll) clearInterval(poll); poll = null; };
        try {
            await withLocks(
                T,
                async () => { stopPoll(); return doRun(b, T); },
                async () => {
                    saveJob(T); // queda registrado desde que entra a la cola
                    btnAll.textContent = 'En cola: esperando a otra descarga...';
                    try {
                        // mi clientId = quien tiene el candado de este hilo (solo yo lo tengo)
                        const me = ((await navigator.locks.query()).held.find(l => l.name === threadLock(T.threadBase)) || {}).clientId;
                        myId = me || null;
                        announce();
                        announceTimer = setInterval(announce, 2000);
                        poll = setInterval(async () => {
                            try {
                                const pend = (await navigator.locks.query()).pending.filter(l => l.name === GLOBAL_LOCK);
                                const idx = pend.findIndex(l => l.clientId === me);
                                if (idx >= 0) btnAll.textContent = `En cola: posición ${idx + 1} de ${pend.length} (esperando turno)`;
                            } catch (e) { /* sin consulta de cola */ }
                        }, 2000);
                    } catch (e) { /* sin posición: queda el mensaje genérico */ }
                }
            );
        } finally {
            stopPoll();
            if (announceTimer) clearInterval(announceTimer);
            if (bc && myId) bc.postMessage({ me: myId, gone: true }); // me retiro del panel de las demás pestañas
            myId = null;
            active = null;
        }
    }

    // NUEVO: procesa hilos uno tras otro. El primero viene dado; los siguientes se toman de la cola guardada EN ORDEN
    // en el momento de necesitarlos, así ▲ ▼ ✕ y "ordenar por páginas" afectan también a lo que falta de la tanda.
    // continueQueue = seguir con la cola al terminar cada hilo (botón "Procesar cola"); si no, solo si la casilla está activada.
    async function processThreads(first, base, continueQueue = false) {
        if (running) return;
        running = true;
        const attempted = new Set(); // evita repetir un hilo que quedó pendiente por un error en esta misma cadena
        stopReq = null;
        resetPauseButtons();
        btnQueue.style.display = btnResume.style.display = btnDiscard.style.display = 'none';
        btnSkip.style.display = btnStop.style.display = ''; // controles de pausa mientras corre
        lockOn();
        // el título de la pestaña refleja el estado (cola / progreso) para verlo sin abrirla
        const baseTitle = document.title;
        const titleTimer = setInterval(() => { document.title = `${btnAll.textContent} · ${baseTitle}`; }, 1000);
        const pickNext = () => {
            const x = candidates().find(c => !attempted.has(c.threadBase) && c.pages && c.pages.length);
            return x ? mkThread(x.threadBase, x.title, x.url, x.pages) : null;
        };
        let done = 0;
        try {
            let T = first;
            while (T) {
                attempted.add(T.threadBase);
                let b = base;
                if (done > 0) {
                    // a partir del segundo, cada hilo usa su propia carpeta si el navegador aún conserva el permiso
                    try {
                        const h = await idbGet(baseKey(T.threadBase));
                        if (h && (await h.queryPermission({ mode: 'readwrite' })) === 'granted') b = h;
                    } catch (e) { /* usa la carpeta de la tanda */ }
                }
                try {
                    await runOne(T, b);
                } catch (e) {
                    if (e && e.message === 'THREAD_BUSY') console.warn('[adjuntos] hilo ya en curso en otra pestaña, se omite:', T.title);
                    else console.error('[adjuntos] error', T.title, e);
                }
                done++;
                if (stopReq === 'all') break; // los hilos que faltan quedan pendientes en la cola guardada
                if (stopReq === 'next') { // este hilo pasa al final de la cola y sigue el siguiente
                    moveToEnd(T.threadBase);
                    stopReq = null;
                    resetPauseButtons();
                }
                T = (continueQueue || autoChk.checked) ? pickNext() : null;
            }
            if (done > 1 && stopReq !== 'all') btnAll.textContent = `Tanda terminada (${done} hilos)`;
        } finally {
            stopReq = null;
            btnSkip.style.display = btnStop.style.display = 'none';
            clearInterval(titleTimer);
            document.title = baseTitle;
            running = false;
            lockOff();
        }
    }

    // recibe la lista de páginas a procesar y, al reanudar, el handle guardado
    // fresh = inicio manual: se descarta la caché para releer el hilo (puede tener posts nuevos); reanudar la conserva
    async function run(pages, handle, fresh = false) {
        if (running) return;
        // aviso temprano si este hilo ya corre (o está en cola) en otra pestaña
        if (await isThreadBusy(threadBase)) {
            alert('Este hilo ya se está descargando (o está en cola) en otra pestaña.');
            return;
        }
        let base = handle;
        if (!base) {
            // elegir carpeta base (antes de cualquier await largo, para conservar el gesto del usuario)
            try {
                let startIn;
                try { startIn = await idbGet('base:last'); } catch (e) { /* sin IndexedDB */ }
                base = await window.showDirectoryPicker(startIn ? { mode: 'readwrite', startIn } : { mode: 'readwrite' });
            } catch (e) {
                console.warn('[adjuntos] carpeta no elegida', e);
                return;
            }
        }
        if (fresh) { try { await idbDel(scanKey(threadBase)); } catch (e) { /* sin caché */ } }
        return processThreads(curThread(pages), base);
    }

    btn.onclick = () => run([currentPage], undefined, true);

    btnAll.onclick = () => {
        // el selector de carpeta necesita el clic reciente: se pide el rango dentro de run() solo si hace falta
        const max = lastPage();
        const input = prompt(`Páginas a procesar (ej. 1-${max}, 3-5 o 4):`, `1-${max}`);
        if (!input) return;
        const m = input.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
        if (!m) { alert('Formato no válido. Usa 1-5 o 4.'); return; }
        const from = Number(m[1]);
        const to = Number(m[2] || m[1]);
        const pages = [];
        for (let p = Math.min(from, to); p <= Math.max(from, to); p++) pages.push(p);
        run(pages, undefined, true);
    };

    // NUEVO: procesar toda la cola guardada desde esta pestaña, en el orden guardado
    btnQueue.onclick = async () => {
        if (running) return;
        const list = candidates()
            .filter(x => x.pages && x.pages.length)
            .map(x => mkThread(x.threadBase, x.title, x.url, x.pages));
        if (!list.length) return;
        // carpeta de la tanda (con el clic hay gesto de usuario): la del primer hilo si se puede, o se elige una
        let base = null;
        try {
            const h = (await idbGet(baseKey(list[0].threadBase))) || (await idbGet('base:last'));
            if (h) {
                let perm = await h.queryPermission({ mode: 'readwrite' });
                if (perm !== 'granted') perm = await h.requestPermission({ mode: 'readwrite' });
                if (perm === 'granted') base = h;
            }
        } catch (e) { /* se elige una carpeta */ }
        if (!base) {
            try { base = await window.showDirectoryPicker({ mode: 'readwrite' }); }
            catch (e) { console.warn('[adjuntos] carpeta no elegida', e); return; }
        }
        processThreads(list[0], base, true);
    };

    // reanudar o descartar el trabajo pendiente del hilo (si lo hay)
    btnDiscard.onclick = () => { clearJob(threadBase); btnResume.style.display = btnDiscard.style.display = 'none'; };

    (async () => {
        const job = loadJob(threadBase);
        if (!job || job.threadBase !== threadBase || !job.pages || !job.pages.length) return;
        // NUEVO: al abrir un hilo con trabajo pendiente, se guarda su título real (también en trabajos antiguos que no lo tenían)
        const realTitle = threadName();
        if (job.title !== realTitle) {
            job.title = realTitle;
            job.url = `${location.origin}${threadBase}/`;
            try { localStorage.setItem(jobKey(threadBase), JSON.stringify(job)); } catch (e) { /* sin storage */ }
        }
        queueAdd(curThread(job.pages)); // crea o actualiza la entrada (conserva su lugar en la cola)
        btnResume.textContent = `Reanudar descarga (págs ${job.pages[0]}-${job.pages[job.pages.length - 1]})${progressText(job, job.pages.length)}`;
        btnResume.style.display = btnDiscard.style.display = '';

        let handle = null;
        try { handle = await idbGet(baseKey(threadBase)); } catch (e) { /* sin IndexedDB */ }

        btnResume.onclick = async () => {
            try {
                // con el clic hay gesto de usuario: se puede pedir permiso otra vez sobre la carpeta guardada
                if (handle && (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
                    if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') handle = null;
                }
            } catch (e) { handle = null; }
            run(job.pages, handle || undefined); // sin handle válido, vuelve a abrir el selector de carpeta
        };

        // si el navegador ya conserva el permiso, reanuda sola; con varias pestañas entran a la cola global
        try {
            if (handle && (await handle.queryPermission({ mode: 'readwrite' })) === 'granted') run(job.pages, handle);
        } catch (e) { /* pide permiso con el botón */ }
    })();
})();
