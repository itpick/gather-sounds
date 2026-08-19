// ==UserScript==
// @name         Gather Music
// @namespace    lucas.local
// @version      1.0.0
// @description  Play music into a Gather call — to yourself, to the room, or both. Plus a Spotify remote for your own playback.
// @author       Lucas
// @match        https://app.gather.town/*
// @match        https://*.gather.town/*
// @match        http://localhost:8777/*
// @run-at       document-start
// @grant        none
// @homepageURL  https://github.com/itpick/gather-sounds
// @supportURL   https://github.com/itpick/gather-sounds/issues
// Auto-update. These only work because the script lives in a PUBLIC repo --
// Tampermonkey fetches them unauthenticated. Bump @version or Tampermonkey
// will not take the new build.
// @updateURL    https://raw.githubusercontent.com/itpick/gather-sounds/main/gather-music.user.js
// @downloadURL  https://raw.githubusercontent.com/itpick/gather-sounds/main/gather-music.user.js
// ==/UserScript==

/*
 * How this works
 * --------------
 * Same trick as the soundboard: at document-start we replace
 * navigator.mediaDevices.getUserMedia, so the track Gather sends over WebRTC is
 * ours rather than the raw device track.
 *
 *     realMic ------> micSource --+
 *                                 +--> dest --> the track Gather transmits
 *     <audio> --> srcNode --> roomGain -+
 *                     |
 *                     +-------> meGain --> ctx.destination (your speakers)
 *
 * roomGain and meGain are independent, which is what makes "to me" and "to the
 * room" separate checkboxes rather than one switch. Muting yourself locally does
 * not stop the room hearing it, and vice versa.
 *
 * Coexisting with the other two scripts
 * -------------------------------------
 * gather-farts and gather-mic-dvr each patch getUserMedia too. Patches chain:
 * whoever runs last wraps the others, and the stream flows through every tap in
 * turn. That already works today between the soundboard and the DVR, so this
 * script deliberately does the same thing rather than trying to share a bus --
 * a shared global would couple three independently-versioned scripts together.
 *
 * What Spotify can and cannot do here
 * -----------------------------------
 * The Spotify tab is a REMOTE, not a source. Spotify's Web Playback SDK decodes
 * through EME/Widevine, so its samples live in the browser's protected media
 * path: createMediaElementSource() on it returns silence and captureStream()
 * returns nothing. There is no way to route Spotify audio into the graph above,
 * and that is what the DRM is for. So the tab controls playback on whatever
 * device you already own, and the room hears nothing from it.
 *
 * To feed the room, use the Local tab -- files you pick, or a direct audio URL.
 */

(function () {
  "use strict";

  const TAG = "[music]";
  const LS_UI = "gather-music.ui";
  const LS_SPOTIFY = "gather-music.spotify";

  const log = (...a) => console.log(TAG, ...a);

  const loadJSON = (key, fallback) => {
    try {
      return { ...fallback, ...JSON.parse(localStorage.getItem(key) || "{}") };
    } catch (_) {
      return { ...fallback };
    }
  };
  const saveJSON = (key, val) => {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (_) {
      /* private mode, quota -- non-fatal */
    }
  };

  const loadUi = () => loadJSON(LS_UI, { toRoom: true, toMe: true, volume: 0.8 });

  // ---------------------------------------------------------------------------
  // Audio graph
  // ---------------------------------------------------------------------------

  /** @type {AudioContext|null} */ let ctx = null;
  /** @type {GainNode|null} */ let roomGain = null; // -> outgoing WebRTC track
  /** @type {GainNode|null} */ let meGain = null; // -> your speakers

  /** @type {Set<MediaStreamAudioDestinationNode>} */ const liveDests = new Set();

  // One <audio> element reused for every track. Recreating it per track would
  // mean a new MediaElementSourceNode each time, and an element can only ever be
  // connected to ONE source node for the life of the page -- calling
  // createMediaElementSource twice on the same element throws.
  /** @type {HTMLAudioElement|null} */ let audioEl = null;
  /** @type {MediaElementAudioSourceNode|null} */ let srcNode = null;

  function ensureGraph() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    roomGain = ctx.createGain();
    meGain = ctx.createGain();

    const ui = loadUi();
    roomGain.gain.value = ui.toRoom ? ui.volume : 0;
    meGain.gain.value = ui.toMe ? ui.volume * 0.6 : 0; // monitor a little quieter

    meGain.connect(ctx.destination);

    audioEl = new Audio();
    audioEl.preload = "metadata";
    // Must be set BEFORE src, and the server must actually send CORS headers.
    // Without this a cross-origin file taints the element and the source node
    // emits silence -- no error, just nothing. Blob URLs are same-origin so
    // local files are unaffected either way.
    audioEl.crossOrigin = "anonymous";

    srcNode = ctx.createMediaElementSource(audioEl);
    srcNode.connect(roomGain);
    srcNode.connect(meGain);

    audioEl.addEventListener("timeupdate", renderTransport);
    audioEl.addEventListener("durationchange", renderTransport);
    audioEl.addEventListener("play", renderTransport);
    audioEl.addEventListener("pause", renderTransport);
    audioEl.addEventListener("ended", renderTransport);
    audioEl.addEventListener("error", () => {
      const err = audioEl.error;
      setNote(
        `Could not play that: ${err ? err.message || "code " + err.code : "unknown error"}.` +
          " Cross-origin URLs need CORS headers; local files always work.",
        true,
      );
    });

    log("audio context created", ctx.sampleRate + "Hz");
  }

  function applyGains() {
    if (!ctx) return;
    const ui = loadUi();
    roomGain.gain.value = ui.toRoom ? ui.volume : 0;
    meGain.gain.value = ui.toMe ? ui.volume * 0.6 : 0;
  }

  // ---------------------------------------------------------------------------
  // Mic patch
  // ---------------------------------------------------------------------------

  function tapStream(realStream) {
    const realAudio = realStream.getAudioTracks();
    if (realAudio.length === 0) return realStream;

    ensureGraph();

    const dest = ctx.createMediaStreamDestination();
    const micSource = ctx.createMediaStreamSource(realStream);
    micSource.connect(dest);
    roomGain.connect(dest);
    liveDests.add(dest);

    const outTrack = dest.stream.getAudioTracks()[0];

    const origStop = outTrack.stop.bind(outTrack);
    outTrack.stop = () => {
      origStop();
      realAudio.forEach((t) => t.stop());
      try {
        micSource.disconnect();
        roomGain.disconnect(dest);
      } catch (_) {
        /* already disconnected */
      }
      liveDests.delete(dest);
      renderStatus();
    };

    outTrack.applyConstraints = () => Promise.resolve();

    const out = new MediaStream();
    out.addTrack(outTrack);
    realStream.getVideoTracks().forEach((t) => out.addTrack(t));

    log("mic tap installed on stream", realStream.id);
    renderStatus();
    return out;
  }

  function installMicPatch() {
    const md = navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== "function") {
      log("getUserMedia unavailable; nothing to patch");
      return;
    }
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async function (constraints) {
      const stream = await orig(constraints);
      if (!constraints || !constraints.audio) return stream;
      try {
        return tapStream(stream);
      } catch (err) {
        console.error(TAG, "mic tap failed, passing the real stream through", err);
        return stream;
      }
    };
    log("getUserMedia patched");
  }

  installMicPatch();

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------

  /** @type {{name: string, url: string, revoke: boolean}[]} */ let playlist = [];
  let current = -1;

  function playIndex(i) {
    if (i < 0 || i >= playlist.length) return;
    ensureGraph();
    if (ctx.state === "suspended") ctx.resume();
    current = i;
    audioEl.src = playlist[i].url;
    audioEl.play().catch((err) => setNote(`Playback blocked: ${err.message}`, true));
    renderPlaylist();
  }

  function addFiles(fileList) {
    for (const file of fileList) {
      playlist.push({
        name: file.name,
        url: URL.createObjectURL(file),
        revoke: true,
      });
    }
    renderPlaylist();
    if (current === -1 && playlist.length) setNote(`${playlist.length} track(s) ready.`);
  }

  function addUrl(url) {
    playlist.push({ name: url.split("/").pop() || url, url, revoke: false });
    renderPlaylist();
  }

  function removeTrack(i) {
    const t = playlist[i];
    if (t && t.revoke) URL.revokeObjectURL(t.url);
    playlist.splice(i, 1);
    if (i === current) {
      audioEl && audioEl.pause();
      current = -1;
    } else if (i < current) current--;
    renderPlaylist();
  }

  // ---------------------------------------------------------------------------
  // Spotify remote (control only -- see the header comment)
  // ---------------------------------------------------------------------------

  const SPOTIFY_SCOPES =
    "user-read-playback-state user-modify-playback-state user-read-currently-playing";

  const spotifyCfg = () => loadJSON(LS_SPOTIFY, { clientId: "", token: "", expires: 0 });

  function spotifyRedirectUri() {
    // Must match a Redirect URI registered on the Spotify app exactly. Origin
    // only -- no path, no query -- so it stays stable across Gather's routes.
    return location.origin + "/";
  }

  async function pkceChallenge() {
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    const verifier = Array.from(bytes, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return { verifier, challenge };
  }

  async function spotifyConnect() {
    const cfg = spotifyCfg();
    if (!cfg.clientId) {
      setNote("Enter your Spotify app's Client ID first.", true);
      return;
    }
    const { verifier, challenge } = await pkceChallenge();
    sessionStorage.setItem("gather-music.verifier", verifier);

    const url =
      "https://accounts.spotify.com/authorize?" +
      new URLSearchParams({
        client_id: cfg.clientId,
        response_type: "code",
        redirect_uri: spotifyRedirectUri(),
        code_challenge_method: "S256",
        code_challenge: challenge,
        scope: SPOTIFY_SCOPES,
      });

    // Popup rather than navigating the tab: navigating away would tear down the
    // Gather call. The popup lands back on our own origin, so we can read its
    // location and lift the code out without any server of our own.
    const popup = window.open(url, "spotify-auth", "width=480,height=720");
    if (!popup) {
      setNote("Popup blocked — allow popups for Gather and retry.", true);
      return;
    }

    const poll = setInterval(async () => {
      let code = null;
      try {
        if (popup.closed) {
          clearInterval(poll);
          return;
        }
        // Throws while the popup is on accounts.spotify.com (cross-origin);
        // succeeds once it redirects back to our origin.
        const q = new URLSearchParams(popup.location.search);
        code = q.get("code");
        if (!code && !q.get("error")) return;
        if (q.get("error")) {
          clearInterval(poll);
          popup.close();
          setNote(`Spotify refused: ${q.get("error")}`, true);
          return;
        }
      } catch (_) {
        return; // still cross-origin, keep waiting
      }
      clearInterval(poll);
      popup.close();
      await spotifyExchange(code, verifier);
    }, 400);
  }

  async function spotifyExchange(code, verifier) {
    const cfg = spotifyCfg();
    try {
      const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: spotifyRedirectUri(),
          client_id: cfg.clientId,
          code_verifier: verifier,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_description || data.error || res.status);
      saveJSON(LS_SPOTIFY, {
        ...cfg,
        token: data.access_token,
        refresh: data.refresh_token || "",
        expires: Date.now() + (data.expires_in || 3600) * 1000,
      });
      setNote("Spotify connected.");
      spotifyPoll();
    } catch (err) {
      setNote(`Token exchange failed: ${err.message}`, true);
    }
  }

  async function spotifyApi(path, method = "GET") {
    const cfg = spotifyCfg();
    if (!cfg.token) throw new Error("not connected");
    const res = await fetch("https://api.spotify.com/v1" + path, {
      method,
      headers: { Authorization: "Bearer " + cfg.token },
    });
    if (res.status === 204) return null; // nothing playing
    if (res.status === 401) throw new Error("token expired — reconnect");
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.status === 202 ? null : res.json().catch(() => null);
  }

  let spotifyTimer = null;
  async function spotifyPoll() {
    clearTimeout(spotifyTimer);
    try {
      const state = await spotifyApi("/me/player");
      renderSpotify(state);
    } catch (err) {
      renderSpotify(null, err.message);
    }
    spotifyTimer = setTimeout(spotifyPoll, 5000);
  }

  async function spotifyCmd(cmd) {
    const map = {
      play: ["/me/player/play", "PUT"],
      pause: ["/me/player/pause", "PUT"],
      next: ["/me/player/next", "POST"],
      prev: ["/me/player/previous", "POST"],
    };
    const [path, method] = map[cmd];
    try {
      await spotifyApi(path, method);
      setTimeout(spotifyPoll, 300);
    } catch (err) {
      setNote(`Spotify: ${err.message}`, true);
    }
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  const CSS = `
    :host { all: initial; }
    .wrap { font: 13px/1.4 system-ui, sans-serif; color: #e8e8ea; }
    .toolbtn {
      display: none; align-items: center; justify-content: center;
      width: 40px; height: 40px; border-radius: 10px; cursor: pointer;
      background: transparent; border: none; font-size: 19px; color: inherit;
    }
    .toolbtn:hover { background: rgba(255,255,255,.12); }
    .toolbtn.active { background: rgba(255,255,255,.2); }
    .wrap.docked .toolbtn { display: flex; }
    .wrap.docked .panel { display: none; position: fixed; z-index: 2147483647; }
    .wrap.docked .panel.open { display: block; }
    .panel {
      position: fixed; right: 18px; bottom: 96px; width: 330px;
      background: #1e1f24; border: 1px solid #34363d; border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,.55); z-index: 2147483647; overflow: hidden;
    }
    .head {
      display: flex; align-items: center; gap: 8px; padding: 9px 11px;
      background: #26272e; border-bottom: 1px solid #34363d; cursor: move;
      font-weight: 600;
    }
    .head .sp { flex: 1; }
    .tabs { display: flex; border-bottom: 1px solid #34363d; }
    .tab {
      flex: 1; padding: 7px; text-align: center; cursor: pointer;
      background: #212229; border: none; color: #9a9ba3; font: inherit;
    }
    .tab.on { background: #1e1f24; color: #e8e8ea; font-weight: 600; }
    .body { padding: 11px; display: none; max-height: 46vh; overflow-y: auto; }
    .body.on { display: block; }
    .row { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
    .row label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
    input[type=text] {
      flex: 1; min-width: 0; background: #14151a; border: 1px solid #3a3c44;
      color: #e8e8ea; border-radius: 6px; padding: 5px 7px; font: inherit;
    }
    button.act {
      background: #3a3c44; border: none; color: #e8e8ea; border-radius: 6px;
      padding: 5px 10px; cursor: pointer; font: inherit;
    }
    button.act:hover { background: #4a4d57; }
    .list { margin: 0; padding: 0; list-style: none; }
    .list li {
      display: flex; align-items: center; gap: 6px; padding: 4px 6px;
      border-radius: 6px; cursor: pointer;
    }
    .list li:hover { background: #2a2c33; }
    .list li.on { background: #34455c; }
    .list li .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .list li .x { opacity: .5; }
    .list li .x:hover { opacity: 1; }
    .note { padding: 7px 11px; font-size: 12px; color: #9a9ba3; border-top: 1px solid #34363d; }
    .note.err { color: #ff9c9c; }
    .seek { width: 100%; }
    .muted { color: #9a9ba3; font-size: 12px; }
    .np { font-weight: 600; margin-bottom: 2px; }
  `;

  let host = null, wrap = null, panelEl = null, toolBtn = null, mode = null;
  let noteEl = null, listEl = null, transportEl = null, spotifyEl = null;

  function setNote(msg, isErr) {
    if (!noteEl) return;
    noteEl.textContent = msg;
    noteEl.className = "note" + (isErr ? " err" : "");
  }

  function renderStatus() {
    if (!toolBtn) return;
    toolBtn.title = liveDests.size
      ? "Gather Music — mic tap active"
      : "Gather Music — waiting for Gather to request the mic";
  }

  function fmt(s) {
    if (!Number.isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    return m + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  }

  function renderTransport() {
    if (!transportEl || !audioEl) return;
    const cur = audioEl.currentTime, dur = audioEl.duration;
    transportEl.querySelector(".time").textContent = `${fmt(cur)} / ${fmt(dur)}`;
    transportEl.querySelector(".pp").textContent = audioEl.paused ? "▶" : "⏸";
    const seek = transportEl.querySelector(".seek");
    if (Number.isFinite(dur) && dur > 0 && document.activeElement !== seek) {
      seek.max = String(dur);
      seek.value = String(cur);
    }
  }

  function renderPlaylist() {
    if (!listEl) return;
    listEl.textContent = "";
    if (!playlist.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "No tracks. Add files or a URL above.";
      listEl.appendChild(li);
      return;
    }
    playlist.forEach((t, i) => {
      const li = document.createElement("li");
      if (i === current) li.classList.add("on");
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = t.name;
      nm.onclick = () => playIndex(i);
      const x = document.createElement("span");
      x.className = "x";
      x.textContent = "✕";
      x.onclick = (e) => { e.stopPropagation(); removeTrack(i); };
      li.append(nm, x);
      listEl.appendChild(li);
    });
  }

  function renderSpotify(state, err) {
    if (!spotifyEl) return;
    const np = spotifyEl.querySelector(".np");
    const sub = spotifyEl.querySelector(".sub");
    if (err) { np.textContent = "—"; sub.textContent = err; return; }
    if (!state || !state.item) { np.textContent = "Nothing playing"; sub.textContent = ""; return; }
    np.textContent = state.item.name || "—";
    const who = (state.item.artists || []).map((a) => a.name).join(", ");
    sub.textContent = [who, state.device && state.device.name].filter(Boolean).join(" · ");
  }

  function findDock() {
    const btn =
      document.querySelector('button[aria-label="Screen share" i]') ||
      document.querySelector('button[aria-label*="screen share" i]') ||
      document.querySelector('button[aria-label="Camera" i]') ||
      document.querySelector('button[aria-label="Microphone" i]');
    if (!btn) return null;
    let el = btn.parentElement;
    for (let i = 0; i < 6 && el; i++) {
      if (el.classList.contains("Layout") && el.children.length >= 2) return el;
      el = el.parentElement;
    }
    return null;
  }

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    wrap.className = "wrap " + next;
    if (next === "docked") panelEl.classList.remove("open");
  }

  function ensureMounted() {
    if (!host) return;
    const dock = findDock();
    if (dock) {
      if (host.parentElement !== dock) dock.appendChild(host);
      setMode("docked");
    } else {
      if (host.parentElement !== document.body) document.body.appendChild(host);
      setMode("floating");
    }
  }

  function el(tag, props, ...kids) {
    const n = Object.assign(document.createElement(tag), props || {});
    kids.flat().forEach((k) => n.append(k));
    return n;
  }

  function mountPanel() {
    if (document.getElementById("gather-music-root")) return;

    host = el("div", { id: "gather-music-root" });
    const root = host.attachShadow({ mode: "open" });
    root.append(el("style", { textContent: CSS }));

    wrap = el("div", { className: "wrap floating" });

    toolBtn = el("button", { className: "toolbtn", textContent: "🎵" });
    toolBtn.onclick = () => {
      panelEl.classList.toggle("open");
      toolBtn.classList.toggle("active", panelEl.classList.contains("open"));
    };

    panelEl = el("div", { className: "panel" });

    // --- header
    panelEl.append(
      el("div", { className: "head" },
        el("span", { textContent: "🎵 Gather Music" }),
        el("span", { className: "sp" }),
      ),
    );

    // --- tabs
    const tabLocal = el("button", { className: "tab on", textContent: "Local" });
    const tabSpotify = el("button", { className: "tab", textContent: "Spotify" });
    panelEl.append(el("div", { className: "tabs" }, tabLocal, tabSpotify));

    // --- local body
    const bodyLocal = el("div", { className: "body on" });

    const ui = loadUi();
    const cbRoom = el("input", { type: "checkbox", checked: ui.toRoom });
    const cbMe = el("input", { type: "checkbox", checked: ui.toMe });
    const vol = el("input", { type: "range", min: "0", max: "1", step: "0.01", value: String(ui.volume) });

    const persist = () => {
      saveJSON(LS_UI, { toRoom: cbRoom.checked, toMe: cbMe.checked, volume: Number(vol.value) });
      applyGains();
    };
    cbRoom.onchange = cbMe.onchange = vol.oninput = persist;

    bodyLocal.append(
      el("div", { className: "row" },
        el("label", {}, cbRoom, el("span", { textContent: "To the room" })),
        el("label", {}, cbMe, el("span", { textContent: "To me" })),
      ),
      el("div", { className: "row" }, el("span", { textContent: "Vol" }), vol),
    );

    const fileInput = el("input", { type: "file", accept: "audio/*", multiple: true });
    fileInput.style.display = "none";
    fileInput.onchange = () => { addFiles(fileInput.files); fileInput.value = ""; };
    const pick = el("button", { className: "act", textContent: "Add files" });
    pick.onclick = () => fileInput.click();

    const urlBox = el("input", { type: "text", placeholder: "https://… direct audio URL" });
    const addBtn = el("button", { className: "act", textContent: "Add" });
    addBtn.onclick = () => {
      const v = urlBox.value.trim();
      if (!v) return;
      addUrl(v);
      urlBox.value = "";
    };

    bodyLocal.append(
      el("div", { className: "row" }, pick, fileInput),
      el("div", { className: "row" }, urlBox, addBtn),
    );

    // transport
    transportEl = el("div", {});
    const pp = el("button", { className: "act pp", textContent: "▶" });
    pp.onclick = () => {
      if (!audioEl || current === -1) { if (playlist.length) playIndex(0); return; }
      if (ctx && ctx.state === "suspended") ctx.resume();
      audioEl.paused ? audioEl.play() : audioEl.pause();
    };
    const seek = el("input", { type: "range", className: "seek", min: "0", max: "100", value: "0", step: "0.1" });
    seek.oninput = () => { if (audioEl) audioEl.currentTime = Number(seek.value); };
    transportEl.append(
      el("div", { className: "row" }, pp, el("span", { className: "time muted", textContent: "0:00 / 0:00" })),
      seek,
    );
    bodyLocal.append(transportEl);

    listEl = el("ul", { className: "list" });
    bodyLocal.append(listEl);

    // --- spotify body
    const bodySpotify = el("div", { className: "body" });
    const cfg = spotifyCfg();
    const idBox = el("input", { type: "text", placeholder: "Spotify Client ID", value: cfg.clientId || "" });
    const connect = el("button", { className: "act", textContent: "Connect" });
    connect.onclick = () => {
      saveJSON(LS_SPOTIFY, { ...spotifyCfg(), clientId: idBox.value.trim() });
      spotifyConnect();
    };

    spotifyEl = el("div", {},
      el("div", { className: "np", textContent: "Not connected" }),
      el("div", { className: "sub muted", textContent: "" }),
    );

    const mk = (t, cmd) => {
      const b = el("button", { className: "act", textContent: t });
      b.onclick = () => spotifyCmd(cmd);
      return b;
    };

    bodySpotify.append(
      el("div", { className: "row" }, idBox, connect),
      spotifyEl,
      el("div", { className: "row" }, mk("⏮", "prev"), mk("▶", "play"), mk("⏸", "pause"), mk("⏭", "next")),
      el("div", { className: "muted", textContent:
        "Controls playback on your own Spotify device. Its audio cannot reach the room — " +
        "Spotify decodes through DRM, so the Web Audio graph never sees it. Use the Local tab for that." }),
    );

    tabLocal.onclick = () => {
      tabLocal.classList.add("on"); tabSpotify.classList.remove("on");
      bodyLocal.classList.add("on"); bodySpotify.classList.remove("on");
    };
    tabSpotify.onclick = () => {
      tabSpotify.classList.add("on"); tabLocal.classList.remove("on");
      bodySpotify.classList.add("on"); bodyLocal.classList.remove("on");
      if (spotifyCfg().token) spotifyPoll();
    };

    noteEl = el("div", { className: "note", textContent: "Ready." });

    panelEl.append(bodyLocal, bodySpotify, noteEl);
    wrap.append(toolBtn, panelEl);
    root.append(wrap);
    document.body.appendChild(host);

    renderPlaylist();
    renderStatus();
    ensureMounted();
    setInterval(ensureMounted, 2000);
    log("panel mounted");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountPanel);
  } else {
    mountPanel();
  }
})();
