(() => {
  "use strict";
  const DB_NAME = "my-video-library";
  const DB_VERSION = 1;
  const STORE = "items";
  let db;
  let currentObjectUrl = null;
  let deferredInstallPrompt = null;
  let activePlayback = null; // { save(), stop(), startOver() } for whatever is open in the player
  let playSession = 0;       // guards async player setup against the modal being closed meanwhile
  const $ = id => document.getElementById(id);

  // ---- Watch position (resume) ----
  // Stored in localStorage (small JSON map) so we never rewrite large video blobs in IndexedDB.
  const POS_KEY = "my-video-library-positions";
  const MIN_RESUME = 5;     // seconds; below this, just start from the beginning
  const END_MARGIN = 10;    // seconds from the end that count as "finished" (capped at 10% for short clips)
  const endMargin = duration => Math.min(END_MARGIN, duration * 0.1);
  const SAVE_EVERY_MS = 5000;
  function loadPositions() {
    try { return JSON.parse(localStorage.getItem(POS_KEY)) || {}; } catch { return {}; }
  }
  function storePositions(all) {
    try { localStorage.setItem(POS_KEY, JSON.stringify(all)); } catch { /* storage full or blocked; resume is best-effort */ }
  }
  function getPosition(id) { return loadPositions()[id] || null; }
  function clearPosition(id) { const all = loadPositions(); delete all[id]; storePositions(all); }
  function setPosition(id, time, duration) {
    if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) return;
    const all = loadPositions();
    if (time < MIN_RESUME || time > duration - endMargin(duration)) delete all[id]; // near start or finished
    else all[id] = { time: Math.floor(time), duration: Math.floor(duration), updatedAt: Date.now() };
    storePositions(all);
  }
  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  }
  function loadYouTubeApi() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (!loadYouTubeApi.promise) {
      loadYouTubeApi.promise = new Promise((resolve, reject) => {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => { if (typeof prev === "function") prev(); resolve(window.YT); };
        const s = document.createElement("script");
        s.src = "https://www.youtube.com/iframe_api"; s.async = true;
        s.onerror = () => { loadYouTubeApi.promise = null; reject(new Error("YouTube API unavailable")); };
        document.head.appendChild(s);
      });
    }
    return loadYouTubeApi.promise;
  }
  function closePlayback() {
    playSession++;
    if (activePlayback) { activePlayback.save(); activePlayback.stop(); activePlayback = null; }
  }

  function toast(message) {
    const el = $("toast"); el.textContent = message; el.classList.add("show");
    clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 2600);
  }
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains(STORE)) {
          const store = database.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
          store.createIndex("createdAt", "createdAt");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function tx(mode = "readonly") { return db.transaction(STORE, mode).objectStore(STORE); }
  function allItems() {
    return new Promise((resolve, reject) => {
      const req = tx().getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
  }
  function saveItem(item) {
    return new Promise((resolve, reject) => {
      const req = tx("readwrite").add(item); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
  }
  function deleteItem(id) {
    return new Promise((resolve, reject) => {
      const req = tx("readwrite").delete(Number(id)); req.onsuccess = resolve; req.onerror = () => reject(req.error);
    });
  }
  function getYoutubeId(value) {
    try {
      const u = new URL(value.trim()); let id = "";
      if (["youtu.be", "www.youtu.be"].includes(u.hostname)) id = u.pathname.split("/").filter(Boolean)[0] || "";
      else if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(u.hostname)) {
        id = u.searchParams.get("v") || "";
        if (!id) { const p = u.pathname.split("/").filter(Boolean); if (["embed", "shorts", "live"].includes(p[0])) id = p[1] || ""; }
      }
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    } catch { return null; }
  }
  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"], i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
    return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
  }
  function safeText(s) {
    return String(s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  }
  function showTab(tab) {
    ["library", "add", "storage"].forEach(name => {
      $(`${name}Panel`).classList.toggle("hidden", name !== tab);
      document.querySelector(`[data-tab="${name}"]`).classList.toggle("active", name === tab);
    });
    if (tab === "storage") updateStorage();
  }
  async function renderLibrary() {
    const items = await allItems();
    const query = $("searchInput").value.trim().toLowerCase();
    const filtered = items.filter(x => (x.title || "").toLowerCase().includes(query));
    const positions = loadPositions();
    $("countBadge").textContent = items.length;
    $("emptyState").classList.toggle("hidden", filtered.length !== 0);
    $("libraryGrid").innerHTML = filtered.map(item => {
      const isFile = item.kind === "file";
      const thumb = item.kind === "youtube"
        ? `<img src="https://i.ytimg.com/vi/${encodeURIComponent(item.videoId)}/hqdefault.jpg" alt="" loading="lazy" onerror="this.remove()">`
        : `<span>▶</span>`;
      const pos = positions[item.id];
      const pct = pos && pos.duration ? Math.min(100, Math.max(0, pos.time / pos.duration * 100)) : 0;
      const resumeBar = pos ? `<div class="resume-bar" aria-hidden="true"><i style="width:${pct.toFixed(1)}%"></i></div>` : "";
      const playLabel = pos ? `Resume ${formatTime(pos.time)}` : (isFile ? "Play offline" : "Watch link");
      const leftText = pos ? ` · ${formatTime(pos.duration - pos.time)} left` : "";
      return `<article class="video-card">
        <div class="thumb">${thumb}<span class="type-pill">${isFile ? "OFFLINE FILE" : "YOUTUBE LINK"}</span>${resumeBar}</div>
        <div class="card-body"><div class="card-title" title="${safeText(item.title)}">${safeText(item.title)}</div>
        <div class="card-meta">${isFile ? `${formatBytes(item.size)} · Stored on this device` : "Streaming link · Internet required"}${leftText}</div>
        <div class="card-actions"><button class="button primary" data-action="play" data-id="${item.id}">${playLabel}</button><button class="button secondary" data-action="delete" data-id="${item.id}">Remove</button></div></div></article>`;
    }).join("");
    if (filtered.length === 0 && items.length > 0) {
      $("emptyState").classList.remove("hidden"); $("emptyState").querySelector("h3").textContent = "No matching videos";
      $("emptyState").querySelector("p").textContent = "Try a different search.";
      $("emptyState").querySelector("button").classList.add("hidden");
    } else {
      $("emptyState").querySelector("h3").textContent = "Your library is empty";
      $("emptyState").querySelector("p").textContent = "Add a video file for offline viewing or save a YouTube link to watch later.";
      $("emptyState").querySelector("button").classList.remove("hidden");
    }
  }
  async function playItem(id) {
    const item = (await allItems()).find(x => x.id === Number(id)); if (!item) return;
    closePlayback();
    const session = playSession;
    const saved = getPosition(item.id);
    const area = $("playerArea"); area.innerHTML = "";
    $("startOver").classList.add("hidden");
    $("playerTitle").textContent = item.title;
    $("playerType").textContent = item.kind === "file" ? "Offline video · Stored on this device" : "YouTube · Internet connection required";
    $("playerMessage").textContent = item.kind === "file" ? "This file is stored in this browser." : "This bookmark streams from YouTube; it is not an offline download.";
    $("openYoutube").classList.toggle("hidden", item.kind !== "youtube");
    if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
    if (item.kind === "file") {
      currentObjectUrl = URL.createObjectURL(item.blob);
      const video = document.createElement("video"); video.controls = true; video.playsInline = true; video.preload = "metadata"; video.src = currentObjectUrl;
      // Only start saving after the resume seek, so an early time of 0 can't wipe the saved position.
      let ready = false, lastSave = 0;
      const save = () => { if (ready) setPosition(item.id, video.currentTime, video.duration); };
      video.addEventListener("loadedmetadata", () => {
        if (saved && saved.time < video.duration - endMargin(video.duration)) {
          video.currentTime = saved.time;
          $("playerMessage").textContent = `Resumed at ${formatTime(saved.time)}.`;
          $("startOver").classList.remove("hidden");
        }
        ready = true;
      }, { once: true });
      video.addEventListener("timeupdate", () => { if (Date.now() - lastSave > SAVE_EVERY_MS) { lastSave = Date.now(); save(); } });
      video.addEventListener("pause", save);
      video.addEventListener("seeked", save);
      video.addEventListener("ended", () => clearPosition(item.id));
      activePlayback = {
        save,
        stop: () => video.pause(),
        startOver: () => { video.currentTime = 0; video.play().catch(() => {}); }
      };
      area.appendChild(video);
      video.play().catch(() => {});
    } else {
      const frame = document.createElement("iframe");
      const params = new URLSearchParams({ rel: "0", playsinline: "1", enablejsapi: "1" });
      if (location.protocol.startsWith("http")) params.set("origin", location.origin);
      if (saved) params.set("start", String(saved.time));
      frame.src = `https://www.youtube.com/embed/${encodeURIComponent(item.videoId)}?${params}`;
      frame.title = item.title;
      frame.referrerPolicy = "strict-origin-when-cross-origin";
      frame.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
      frame.allowFullscreen = true;
      area.appendChild(frame);
      if (saved) {
        $("playerMessage").textContent = `Resuming at ${formatTime(saved.time)}. Streams from YouTube; not an offline download.`;
        $("startOver").classList.remove("hidden");
      }
      $("openYoutube").onclick = () => {
        let t = 0;
        try { t = Math.floor(activePlayback?.currentTime?.() || 0); } catch { /* ignore */ }
        const at = t >= MIN_RESUME ? `&t=${t}s` : "";
        window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}${at}`, "_blank", "noopener");
      };
      // Track position through YouTube's official IFrame Player API, attached to our own iframe
      // so the referrer policy set above still applies. If the API can't load, playback still works.
      let player = null, started = false, timer = null;
      const read = () => { try { return player && started ? player.getCurrentTime() : NaN; } catch { return NaN; } };
      const save = () => { if (player && started) { try { setPosition(item.id, player.getCurrentTime(), player.getDuration()); } catch { /* ignore */ } } };
      activePlayback = {
        save,
        currentTime: read,
        stop: () => { clearInterval(timer); try { player && player.destroy(); } catch { /* ignore */ } },
        startOver: () => {
          if (player && player.seekTo) { player.seekTo(0, true); player.playVideo(); }
          else { frame.src = frame.src.replace(/([?&])start=\d+&?/, "$1"); }
          clearPosition(item.id);
        }
      };
      loadYouTubeApi().then(YT => {
        if (session !== playSession) return; // modal closed or another video opened
        player = new YT.Player(frame, {
          events: {
            onStateChange: e => {
              if (e.data === YT.PlayerState.PLAYING) started = true;
              if (e.data === YT.PlayerState.PAUSED) save();
              if (e.data === YT.PlayerState.ENDED) clearPosition(item.id);
            }
          }
        });
        timer = setInterval(save, SAVE_EVERY_MS);
      }).catch(() => { /* offline or blocked: watch position won't be tracked for this link */ });
    }
    $("playerModal").classList.remove("hidden");
  }
  async function updateStorage() {
    const items = await allItems(); const bytes = items.filter(x => x.kind === "file").reduce((n, x) => n + (x.size || 0), 0);
    $("storageUsed").textContent = formatBytes(bytes);
    if (navigator.storage?.estimate) {
      try {
        const est = await navigator.storage.estimate();
        const quota = est.quota || 0, usage = est.usage || 0;
        $("storageBar").style.width = quota ? `${Math.min(100, usage / quota * 100)}%` : "0%";
        $("storageDetails").textContent = `Browser storage used: ${formatBytes(usage)} of ${formatBytes(quota)} estimated. Your imported video files account for ${formatBytes(bytes)} in this app.`;
        if (navigator.storage.persist) {
          const persisted = await navigator.storage.persisted();
          $("storageDetails").textContent += persisted ? " Persistent storage is enabled." : " Storage may be cleared by the browser.";
        }
      } catch { $("storageDetails").textContent = `Imported files: ${formatBytes(bytes)}. Browser storage estimate unavailable.`; }
    } else $("storageDetails").textContent = `Imported files: ${formatBytes(bytes)}. Storage estimate is not supported by this browser.`;
  }
  async function importFile(file) {
    if (!file) return;
    if (!file.type.startsWith("video/") && !/\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name)) { toast("Please choose a video file."); return; }
    $("importProgress").classList.remove("hidden"); $("progressBar").style.width = "20%"; $("progressText").textContent = "Saving video into browser storage…";
    try {
      const title = file.name.replace(/\.[^.]+$/, "");
      await saveItem({ kind: "file", title, filename: file.name, blob: file, size: file.size, mime: file.type, createdAt: Date.now() });
      $("progressBar").style.width = "100%"; $("progressText").textContent = "Saved to this device.";
      $("videoFile").value = ""; await renderLibrary(); await updateStorage(); toast("Video saved for offline playback.");
      setTimeout(() => $("importProgress").classList.add("hidden"), 1500);
    } catch (err) {
      console.error(err); $("progressText").textContent = "Could not save. Browser storage may be full or the file may be too large."; toast("Import failed. Check available storage.");
    }
  }
  document.querySelectorAll("[data-tab]").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));
  document.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => showTab(b.dataset.go)));
  $("youtubeForm").addEventListener("submit", async e => {
    e.preventDefault(); const url = $("youtubeUrl").value.trim(), videoId = getYoutubeId(url);
    if (!videoId) { toast("Enter a valid YouTube video URL."); return; }
    const title = $("youtubeTitle").value.trim() || `YouTube video ${videoId}`;
    try {
      await saveItem({ kind: "youtube", title, url: `https://www.youtube.com/watch?v=${videoId}`, videoId, createdAt: Date.now() });
      $("youtubeUrl").value = ""; $("youtubeTitle").value = ""; await renderLibrary(); showTab("library"); toast("YouTube link saved.");
    } catch { toast("Could not save this link."); }
  });
  $("videoFile").addEventListener("change", e => importFile(e.target.files[0]));
  $("searchInput").addEventListener("input", renderLibrary);
  $("libraryGrid").addEventListener("click", async e => {
    const btn = e.target.closest("button[data-action]"); if (!btn) return;
    if (btn.dataset.action === "play") await playItem(btn.dataset.id);
    if (btn.dataset.action === "delete") {
      if (confirm("Remove this item from your library?")) { await deleteItem(btn.dataset.id); clearPosition(btn.dataset.id); await renderLibrary(); await updateStorage(); toast("Removed from library."); }
    }
  });
  $("closePlayer").addEventListener("click", () => {
    closePlayback();
    $("playerModal").classList.add("hidden"); $("playerArea").innerHTML = "";
    if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
    renderLibrary(); // refresh resume progress on the cards
  });
  $("startOver").addEventListener("click", () => {
    if (!activePlayback) return;
    activePlayback.startOver();
    $("startOver").classList.add("hidden");
    $("playerMessage").textContent = "Playing from the beginning.";
  });
  // Save when the app is backgrounded or closed (important on iPhone, where the page can be killed).
  document.addEventListener("visibilitychange", () => { if (document.hidden && activePlayback) activePlayback.save(); });
  window.addEventListener("pagehide", () => { if (activePlayback) activePlayback.save(); });
  $("estimateBtn").addEventListener("click", updateStorage);
  $("clearAllBtn").addEventListener("click", async () => {
    if (!confirm("Delete every imported offline video file? YouTube bookmarks will remain.")) return;
    const items = await allItems();
    for (const item of items) if (item.kind === "file") { await deleteItem(item.id); clearPosition(item.id); }
    await renderLibrary(); await updateStorage(); toast("Offline files deleted.");
  });
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredInstallPrompt = e; $("installBtn").classList.remove("hidden"); });
  $("installBtn").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; $("installBtn").classList.add("hidden");
  });
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch(err => console.warn("Service worker registration failed", err)));
  }
  openDb().then(async database => { db = database; await renderLibrary(); await updateStorage(); if (navigator.storage?.persist) navigator.storage.persist().catch(() => {}); })
    .catch(err => { console.error(err); toast("Local database unavailable. Try a current browser over HTTPS."); });
})();