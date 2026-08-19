// ==UserScript==
// @name         Gather Mic DVR
// @namespace    lucas.local
// @version      1.3.0
// @description  Rolling recorder for a Gather call — your mic and/or everyone else. Scrub back through the last two minutes and re-send a chunk to the room.
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
// @updateURL    https://raw.githubusercontent.com/itpick/gather-sounds/main/gather-mic-dvr.user.js
// @downloadURL  https://raw.githubusercontent.com/itpick/gather-sounds/main/gather-mic-dvr.user.js
// ==/UserScript==

/*
 * How this works
 * --------------
 * Two interceptions, at document-start:
 *
 *   getUserMedia      -> your microphone
 *   RTCPeerConnection -> every remote participant's audio track
 *
 * Both feed a single recording bus through per-source gates, while a separate
 * output sink carries what Gather actually transmits:
 *
 *     micStream ---------> micGain ----+
 *     remote tracks -----> othersGain -+--> recordBus --> ring buffer
 *
 *     micStream ---+
 *     replayGain --+--> outDest --> track Gather sends over WebRTC
 *
 * Keeping replayGain out of recordBus is the whole trick: replays go to the room
 * but are never recorded, so a replay can't feed itself into a hall of mirrors.
 * The two gates are gain nodes rather than connect/disconnect calls, so the
 * checkboxes can't drift out of step with which nodes happen to exist yet.
 *
 * Audio lives in a plain Float32 ring buffer, not a MediaRecorder. Compressed
 * chunks are miserable to seek into; a ring buffer makes any scrub position a
 * simple array index, which is the entire point of this script.
 *
 * RECORDING OTHER PEOPLE: with "others" ticked this captures every participant
 * you can hear, not just you. Recording people generally requires telling them,
 * and in some places their consent. The panel therefore always shows a live REC
 * indicator and there is deliberately no hidden mode. The buffer is memory-only:
 * nothing is written to disk, nothing leaves the page, and it dies with the tab.
 *
 * NOTE: if the fart soundboard is also installed, whether its sounds land in
 * this recording depends on which script Tampermonkey patched first. That's
 * intentional and harmless -- the soundboard has its own buttons for re-firing.
 *
 * This script is standalone. There is no build step -- edit it directly.
 */

(() => {
  "use strict";

  const RING_SECONDS = 120; // how far back you can scrub
  const BUCKET_MS = 100; // waveform resolution
  const MONITOR_GAIN = 0.5; // how loudly you hear your own replay
  const PROCESSOR_SIZE = 4096;
  const LS_KEY = "gatherMicDvr.ui";

  const log = (...a) => console.log("%c[dvr]", "color:#38bdf8", ...a);

  // ---------------------------------------------------------------------------
  // Ring buffer
  // ---------------------------------------------------------------------------

  /** @type {AudioContext|null} */ let ctx = null;
  /** @type {GainNode|null} */ let replayGain = null;
  /** Everything that should end up in the recording connects here. */
  /** @type {GainNode|null} */ let recordBus = null;
  /** Per-source gates driven by the two checkboxes. */
  /** @type {GainNode|null} */ let micGain = null;
  /** @type {GainNode|null} */ let othersGain = null;
  let recMe = true;
  let recOthers = true;
  /** Remote participant audio, keyed by track id. */
  const remoteSources = new Map();
  /** Active getDisplayMedia tab-audio capture, if the fallback is in use. */
  let tabAudio = null;

  let ring = null; // Float32Array of raw mono samples
  let ringLen = 0;
  let writePos = 0; // next sample index to write
  let filled = 0; // how much of the ring holds real audio
  let rate = 48000;

  let peaks = null; // Float32Array, one absolute peak per BUCKET_MS
  let peakLen = 0;
  let peakWrite = 0;
  let peakFilled = 0;
  let bucketSize = 0; // samples per peak bucket
  let bucketAcc = 0; // running max within the current bucket
  let bucketCount = 0;

  let capturing = false; // graph is live
  let paused = false; // user pressed pause

  function ensureGraph() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    replayGain = ctx.createGain();
    replayGain.gain.value = 1.0;
    rate = ctx.sampleRate;

    ringLen = Math.floor(rate * RING_SECONDS);
    ring = new Float32Array(ringLen);
    bucketSize = Math.max(1, Math.floor((rate * BUCKET_MS) / 1000));
    peakLen = Math.ceil(ringLen / bucketSize);
    peaks = new Float32Array(peakLen);

    // One recording bus for every source: your mic, every remote participant,
    // and the tab-audio fallback. Replays deliberately never reach it.
    //
    // The two checkboxes are gain gates rather than connect/disconnect, so
    // toggling can't get out of step with which nodes happen to exist yet.
    recordBus = ctx.createGain();
    micGain = ctx.createGain();
    othersGain = ctx.createGain();
    micGain.gain.value = recMe ? 1 : 0;
    othersGain.gain.value = recOthers ? 1 : 0;
    micGain.connect(recordBus);
    othersGain.connect(recordBus);
    const proc = ctx.createScriptProcessor(PROCESSOR_SIZE, 1, 1);
    proc.onaudioprocess = (e) => {
      if (!paused) writeSamples(e.inputBuffer.getChannelData(0));
    };
    recordBus.connect(proc);
    // A ScriptProcessor only runs while connected to a destination; route it
    // through a muted gain so it pumps without being audible.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    proc.connect(sink);
    sink.connect(ctx.destination);

    log(`ring ready: ${RING_SECONDS}s @ ${rate}Hz (${((ringLen * 4) / 1e6) | 0}MB)`);
  }

  function writeSamples(input) {
    for (let i = 0; i < input.length; i++) {
      const s = input[i];
      ring[writePos] = s;
      writePos = writePos + 1 === ringLen ? 0 : writePos + 1;
      if (filled < ringLen) filled++;

      const a = s < 0 ? -s : s;
      if (a > bucketAcc) bucketAcc = a;
      if (++bucketCount >= bucketSize) {
        peaks[peakWrite] = bucketAcc;
        peakWrite = peakWrite + 1 === peakLen ? 0 : peakWrite + 1;
        if (peakFilled < peakLen) peakFilled++;
        bucketAcc = 0;
        bucketCount = 0;
      }
    }
  }

  function clearRing() {
    if (!ring) return;
    ring.fill(0);
    peaks.fill(0);
    writePos = filled = peakWrite = peakFilled = bucketAcc = bucketCount = 0;
    playhead = 1;
    render();
  }

  /** Copy the window from `frac` of the buffer through to the live edge. */
  function readWindow(frac) {
    const offset = Math.floor(frac * filled);
    const length = filled - offset;
    if (length <= 0) return null;
    const start = (writePos - filled + offset + ringLen) % ringLen;
    const out = new Float32Array(length);
    const firstRun = Math.min(length, ringLen - start);
    out.set(ring.subarray(start, start + firstRun), 0);
    if (firstRun < length) out.set(ring.subarray(0, length - firstRun), firstRun);
    return out;
  }

  // ---------------------------------------------------------------------------
  // The microphone tap
  // ---------------------------------------------------------------------------

  function tapStream(realStream) {
    const realAudio = realStream.getAudioTracks();
    if (realAudio.length === 0) return realStream;

    ensureGraph();

    const source = ctx.createMediaStreamSource(realStream);

    // What Gather sends: your mic plus anything we replay.
    const outDest = ctx.createMediaStreamDestination();
    source.connect(outDest);
    replayGain.connect(outDest);

    // And into the recording. Replays are excluded on purpose -- that's what
    // stops a replay from feeding itself.
    source.connect(micGain);

    capturing = true;
    render();

    const outTrack = outDest.stream.getAudioTracks()[0];
    const origStop = outTrack.stop.bind(outTrack);
    outTrack.stop = () => {
      origStop();
      realAudio.forEach((t) => t.stop());
      try {
        source.disconnect();
        replayGain.disconnect(outDest);
      } catch (_) {
        /* already torn down */
      }
      capturing = false;
      render();
      log("capture stopped");
    };
    outTrack.applyConstraints = () => Promise.resolve();

    const out = new MediaStream();
    out.addTrack(outTrack);
    realStream.getVideoTracks().forEach((t) => out.addTrack(t));

    log("capture started on stream", realStream.id);
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
        console.error("[dvr] capture failed, passing the real stream through", err);
        return stream;
      }
    };
    log("getUserMedia patched");
  }

  // Restore the checkbox state before any capture can start -- getUserMedia can
  // fire long before the panel mounts, and the gates must already be correct.
  {
    const saved = loadUi();
    recMe = saved.recMe !== false;
    recOthers = saved.recOthers !== false;
  }

  installMicPatch();

  // ---------------------------------------------------------------------------
  // Everyone else's audio
  // ---------------------------------------------------------------------------

  /**
   * Remote participants arrive as `track` events on Gather's peer connections,
   * so we wrap the RTCPeerConnection constructor and listen on every one that
   * gets built. Each remote audio track is isolated into its own MediaStream --
   * feeding the shared stream would double-count anyone carrying two tracks.
   */
  /**
   * Tab audio already contains every remote participant, so the per-track taps
   * must stand down while it's running or everyone gets recorded twice.
   */
  function syncRemoteRouting() {
    for (const src of remoteSources.values()) {
      try {
        if (tabAudio) src.disconnect(othersGain);
        else src.connect(othersGain);
      } catch (_) {
        /* already in the desired state */
      }
    }
  }

  function attachRemote(track) {
    if (remoteSources.has(track.id)) return;
    ensureGraph();
    try {
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      if (!tabAudio) src.connect(othersGain);
      remoteSources.set(track.id, src);
      log("recording remote track", track.id, `(${remoteSources.size} live)`);
    } catch (err) {
      console.error("[dvr] could not attach remote track", err);
      return;
    }
    const drop = () => {
      const src = remoteSources.get(track.id);
      if (!src) return;
      try {
        src.disconnect();
      } catch (_) {
        /* already disconnected */
      }
      remoteSources.delete(track.id);
      render();
    };
    track.addEventListener("ended", drop);
    track.addEventListener("mute", () => {}); // mute is transient; keep the node
    render();
  }

  function installRtcPatch() {
    const Orig = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (!Orig) {
      log("RTCPeerConnection unavailable; remote audio will not be recorded");
      return;
    }
    function Patched(...args) {
      const pc = new Orig(...args);
      pc.addEventListener("track", (ev) => {
        if (ev.track && ev.track.kind === "audio") attachRemote(ev.track);
      });
      return pc;
    }
    Patched.prototype = Orig.prototype;
    Object.setPrototypeOf(Patched, Orig); // carry statics like generateCertificate
    window.RTCPeerConnection = Patched;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Patched;
    log("RTCPeerConnection patched");
  }

  installRtcPatch();

  /**
   * Fallback for when Gather's plumbing defeats the RTCPeerConnection tap:
   * capture the tab's own audio output instead. Chrome only offers tab audio
   * alongside video, so we ask for both and drop the video track immediately.
   */
  async function captureTabAudio() {
    if (tabAudio) {
      tabAudio.track.stop();
      return; // the track's 'ended' handler tears the rest down
    }
    ensureGraph();
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    } catch (err) {
      log("tab capture cancelled", err && err.name);
      return;
    }
    stream.getVideoTracks().forEach((t) => t.stop());
    const track = stream.getAudioTracks()[0];
    if (!track) {
      alert('No audio was shared.\n\nPick "This tab" and tick "Also share tab audio".');
      return;
    }
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    src.connect(othersGain);
    tabAudio = { src, track };
    syncRemoteRouting();
    track.addEventListener("ended", () => {
      try {
        src.disconnect();
      } catch (_) {
        /* already disconnected */
      }
      tabAudio = null;
      syncRemoteRouting();
      render();
      log("tab capture stopped");
    });
    render();
    log("tab capture started");
  }

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------

  let playhead = 1; // 0 = oldest sample, 1 = live edge
  /** @type {AudioBufferSourceNode|null} */ let playSrc = null;

  const DEFAULT_REPLAY_SECONDS = 5;

  async function playFromPlayhead() {
    ensureGraph();
    if (ctx.state === "suspended") await ctx.resume();
    if (filled === 0) return;

    // Sitting at the live edge selects nothing. Rather than no-op, treat it as
    // "say that again" and grab the last few seconds -- moving the playhead so
    // the waveform shows what's about to be sent.
    const minSamples = Math.floor(rate * 0.2);
    if (filled - Math.floor(playhead * filled) < minSamples) {
      const want = Math.min(filled, Math.floor(rate * DEFAULT_REPLAY_SECONDS));
      playhead = (filled - want) / filled;
    }

    const samples = readWindow(playhead);
    if (!samples || samples.length === 0) return;

    stopPlayback();

    const buf = ctx.createBuffer(1, samples.length, rate);
    buf.copyToChannel(samples, 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(replayGain); // out to the room

    // Normally you also hear your own replay. Not while tab audio is being
    // captured -- that capture includes this tab's output, so monitoring would
    // record the replay and feed it straight back into the buffer.
    let monitor = null;
    if (!tabAudio) {
      monitor = ctx.createGain();
      monitor.gain.value = MONITOR_GAIN;
      src.connect(monitor);
      monitor.connect(ctx.destination);
    }

    src.onended = () => {
      try {
        src.disconnect();
        if (monitor) monitor.disconnect();
      } catch (_) {
        /* already torn down */
      }
      if (playSrc === src) playSrc = null;
      render();
    };
    src.start();
    playSrc = src;
    render();
  }

  function stopPlayback() {
    if (!playSrc) return;
    try {
      playSrc.stop();
    } catch (_) {
      /* already stopped; onended cleans up */
    }
    playSrc = null;
  }

  // ---------------------------------------------------------------------------
  // Panel
  // ---------------------------------------------------------------------------

  const CSS = `
    :host { all: initial; }

    /* Docked: a 36px control matching Gather's bar, with the panel as a popover
       above it. Floating: the standalone draggable panel. */
    .toolbtn {
      all: unset; box-sizing: border-box; cursor: pointer;
      display: none; width: 36px; height: 36px;
      align-items: center; justify-content: center;
      border-radius: 8px; font-size: 18px; line-height: 1;
    }
    .toolbtn:hover { background: rgba(255,255,255,0.12); }
    .toolbtn.active { background: rgba(56,189,248,0.45); }
    .wrap.docked .toolbtn { display: flex; }
    .wrap.docked .panel { display: none; }
    .wrap.docked .panel.open { display: block; }
    .wrap.docked .head { cursor: default; }
    .wrap.docked .iconbtn { display: none; }
    .wrap.docked .panel.collapsed .body { display: block; }

    .panel {
      position: fixed; z-index: 2147483646;
      font: 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #eef6fb; background: rgba(16, 26, 38, 0.94);
      border: 1px solid rgba(56, 189, 248, 0.35);
      border-radius: 12px; box-shadow: 0 10px 32px rgba(0,0,0,0.45);
      width: 320px; overflow: hidden;
      backdrop-filter: blur(8px); user-select: none;
    }
    .head {
      display: flex; align-items: center; gap: 7px;
      padding: 7px 9px; cursor: grab;
      background: rgba(56, 189, 248, 0.12);
      border-bottom: 1px solid rgba(56, 189, 248, 0.22);
    }
    .head.dragging { cursor: grabbing; }
    .title { flex: 1; font-weight: 600; letter-spacing: .2px; }
    .rec {
      display: flex; align-items: center; gap: 5px;
      font-size: 10px; font-weight: 700; letter-spacing: .5px; color: #64748b;
    }
    .rec .bulb { width: 8px; height: 8px; border-radius: 50%; background: #475569; }
    .rec.on { color: #f87171; }
    .rec.on .bulb { background: #ef4444; box-shadow: 0 0 7px #ef4444; animation: pulse 1.6s infinite; }
    .rec.paused { color: #fbbf24; }
    .rec.paused .bulb { background: #fbbf24; }
    @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
    .iconbtn {
      all: unset; cursor: pointer; padding: 0 5px; border-radius: 5px;
      color: #9fb6c9; font-size: 14px; line-height: 1;
    }
    .iconbtn:hover { background: rgba(255,255,255,0.1); color: #fff; }
    .body { padding: 9px; }
    .panel.collapsed .body { display: none; }
    .wave {
      display: block; width: 100%; height: 56px; border-radius: 8px;
      background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.09);
      cursor: crosshair; touch-action: none;
    }
    .controls { display: flex; align-items: center; gap: 8px; margin-top: 9px; }
    .play {
      all: unset; box-sizing: border-box; cursor: pointer; text-align: center;
      width: 44px; padding: 8px 0; border-radius: 8px; font-size: 14px;
      background: linear-gradient(180deg, #0ea5e9 0%, #0369a1 100%);
      color: #fff; border: 1px solid rgba(255,255,255,0.14);
    }
    .play:hover { filter: brightness(1.14); }
    .play.stop { background: linear-gradient(180deg, #f87171 0%, #b91c1c 100%); }
    .play:disabled { opacity: .4; cursor: default; filter: none; }
    .time {
      flex: 1; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px; color: #9fb6c9;
    }
    .time b { color: #eef6fb; font-weight: 600; }
    .txtbtn {
      all: unset; cursor: pointer; font-size: 11px; color: #9fb6c9;
      padding: 4px 7px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.12);
    }
    .txtbtn:hover { color: #fff; background: rgba(255,255,255,0.1); }
    .sources {
      display: flex; align-items: center; gap: 12px; margin-top: 9px;
      font-size: 11px; color: #7e93a6;
    }
    .check { display: flex; align-items: center; gap: 5px; cursor: pointer; color: #cfe0ec; }
    .check input { accent-color: #ef4444; margin: 0; cursor: pointer; }
    .hint { margin-top: 8px; font-size: 11px; color: #7e93a6; }
  `;

  let panel = null,
    canvas = null,
    playBtn = null,
    timeEl = null,
    recEl = null,
    pauseBtn = null,
    tabBtn = null;

  function loadUi() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY)) || {};
    } catch (_) {
      return {};
    }
  }

  function saveUi(patch) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ ...loadUi(), ...patch }));
    } catch (_) {
      /* storage disabled -- position just won't persist */
    }
  }

  function fmt(seconds) {
    const s = Math.max(0, Math.round(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function drawWave() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth,
      h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const mid = h / 2;

    // Baseline.
    g.strokeStyle = "rgba(255,255,255,0.12)";
    g.beginPath();
    g.moveTo(0, mid);
    g.lineTo(w, mid);
    g.stroke();

    if (peakFilled > 0) {
      const start = (peakWrite - peakFilled + peakLen) % peakLen;
      g.fillStyle = "#38bdf8";
      for (let x = 0; x < w; x++) {
        // Each pixel column takes the loudest bucket it covers, so short
        // transients stay visible instead of being averaged away.
        const from = Math.floor((x / w) * peakFilled);
        const to = Math.max(from + 1, Math.floor(((x + 1) / w) * peakFilled));
        let peak = 0;
        for (let i = from; i < to; i++) {
          const v = peaks[(start + i) % peakLen];
          if (v > peak) peak = v;
        }
        const bar = Math.max(1, peak * (h - 4));
        g.fillRect(x, mid - bar / 2, 1, bar);
      }

      // Everything left of the playhead is what a replay would skip.
      const px = playhead * w;
      g.fillStyle = "rgba(0,0,0,0.45)";
      g.fillRect(0, 0, px, h);

      g.strokeStyle = "#fbbf24";
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(px, 0);
      g.lineTo(px, h);
      g.stroke();
      g.lineWidth = 1;
    }
  }

  function render() {
    if (!panel) return;

    const secs = filled / rate;
    const behind = (1 - playhead) * secs;

    const live = capturing || remoteSources.size > 0 || !!tabAudio;
    recEl.className = "rec" + (live ? (paused ? " paused" : " on") : "");
    recEl.lastChild.textContent = live ? (paused ? "PAUSED" : "REC") : "IDLE";

    const active = [];
    if (capturing && recMe) active.push("me");
    if (recOthers) {
      if (tabAudio) active.push("tab audio");
      else if (remoteSources.size) active.push(`${remoteSources.size} others`);
    }
    const what = active.length ? active.join(" + ") : "nothing selected";

    timeEl.innerHTML = live
      ? `<b>-${fmt(behind)}</b> of ${fmt(secs)} &middot; ${what}`
      : `waiting for mic — <b>reload the tab</b> if Gather is already live`;

    tabBtn.textContent = tabAudio ? "Stop tab" : "Tab audio";
    tabBtn.title = tabAudio
      ? "Stop capturing this tab's audio"
      : "Fallback: capture this tab's own output if remote audio isn't being picked up";

    playBtn.disabled = filled === 0;
    playBtn.textContent = playSrc ? "■" : "▶";
    playBtn.className = "play" + (playSrc ? " stop" : "");
    playBtn.title = playSrc
      ? "Stop"
      : behind < 0.2
        ? `Send the last ${DEFAULT_REPLAY_SECONDS}s to the room`
        : `Send the last ${fmt(behind)} to the room`;

    pauseBtn.textContent = paused ? "Resume" : "Pause";

    drawWave();
  }

  function makeDraggable(el, handle) {
    let startX = 0,
      startY = 0,
      baseLeft = 0,
      baseTop = 0,
      dragging = false;

    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".iconbtn")) return;
      dragging = true;
      handle.classList.add("dragging");
      handle.setPointerCapture(e.pointerId);
      const r = el.getBoundingClientRect();
      baseLeft = r.left;
      baseTop = r.top;
      startX = e.clientX;
      startY = e.clientY;
      e.preventDefault();
    });

    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const left = Math.min(Math.max(0, baseLeft + e.clientX - startX), window.innerWidth - el.offsetWidth);
      const top = Math.min(Math.max(0, baseTop + e.clientY - startY), window.innerHeight - el.offsetHeight);
      el.style.left = left + "px";
      el.style.top = top + "px";
      el.style.right = "auto";
      el.style.bottom = "auto";
    });

    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("dragging");
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* pointer already gone */
      }
      const r = el.getBoundingClientRect();
      saveUi({ left: r.left, top: r.top });
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  /**
   * Find Gather's bottom control group.
   *
   * Anchored on the Screen share button's aria-label, not a class name: the
   * emotion-generated classes change on every Gather deploy, but the accessible
   * labels are stable. From the button we walk up to the first `.Layout`
   * ancestor holding more than one control -- the group with screen-share, the
   * status circle and the reactions smiley.
   */
  function findDock() {
    const override = loadUi().dockSelector;
    if (override) {
      const el = document.querySelector(override);
      if (el) return el;
    }
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

  let host = null,
    wrap = null,
    toolBtn = null,
    mode = null;

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    wrap.className = "wrap " + next;
    if (next === "floating") {
      closePopover();
      const ui = loadUi();
      if (typeof ui.left === "number" && typeof ui.top === "number") {
        panel.style.left = Math.min(ui.left, window.innerWidth - 80) + "px";
        panel.style.top = Math.min(ui.top, window.innerHeight - 40) + "px";
        panel.style.right = panel.style.bottom = "auto";
      } else {
        panel.style.top = panel.style.right = "auto";
        panel.style.left = "18px";
        panel.style.bottom = "96px";
      }
    }
    log(`mode: ${next}`);
  }

  function positionPopover() {
    if (mode !== "docked" || !panel.classList.contains("open")) return;
    const r = toolBtn.getBoundingClientRect();
    // Fixed, not absolute: an ancestor with overflow:hidden would clip it.
    panel.style.top = "auto";
    panel.style.right = "auto";
    panel.style.bottom = window.innerHeight - r.top + 10 + "px";
    panel.style.left =
      Math.min(
        Math.max(8, r.left + r.width / 2 - panel.offsetWidth / 2),
        window.innerWidth - panel.offsetWidth - 8,
      ) + "px";
  }

  function closePopover() {
    if (panel) panel.classList.remove("open");
    if (toolBtn) toolBtn.classList.remove("active");
  }

  function togglePopover() {
    const open = !panel.classList.contains("open");
    panel.classList.toggle("open", open);
    toolBtn.classList.toggle("active", open);
    if (open) positionPopover();
  }

  /**
   * Gather re-renders its toolbar and drops our node. Re-check periodically and
   * re-attach, falling back to floating whenever the bar isn't there, so the
   * panel is never simply missing.
   */
  function ensureMounted() {
    if (!host) return;
    const dock = findDock();
    if (dock) {
      if (host.parentElement !== dock) {
        dock.appendChild(host);
        log("docked into Gather's control bar");
      }
      setMode("docked");
    } else {
      if (host.parentElement !== document.body) document.body.appendChild(host);
      setMode("floating");
    }
  }

  function mountPanel() {
    if (document.getElementById("gather-mic-dvr-root")) return;

    host = document.createElement("div");
    host.id = "gather-mic-dvr-root";
    const root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);

    const ui = loadUi();

    wrap = document.createElement("div");
    wrap.className = "wrap floating";

    toolBtn = document.createElement("button");
    toolBtn.className = "toolbtn";
    toolBtn.type = "button";
    toolBtn.setAttribute("aria-label", "Mic DVR");
    toolBtn.title = "Mic DVR";
    toolBtn.textContent = "\u{1F3A7}";
    toolBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePopover();
    });

    panel = document.createElement("div");
    panel.className = "panel" + (ui.collapsed ? " collapsed" : "");
    if (typeof ui.left === "number" && typeof ui.top === "number") {
      panel.style.left = Math.min(ui.left, window.innerWidth - 80) + "px";
      panel.style.top = Math.min(ui.top, window.innerHeight - 40) + "px";
    } else {
      panel.style.left = "18px";
      panel.style.bottom = "96px";
    }

    const head = document.createElement("div");
    head.className = "head";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "\u{1F3A7} Mic DVR";
    recEl = document.createElement("div");
    recEl.className = "rec";
    const bulb = document.createElement("span");
    bulb.className = "bulb";
    recEl.append(bulb, document.createTextNode("IDLE"));
    const collapse = document.createElement("button");
    collapse.className = "iconbtn";
    collapse.textContent = ui.collapsed ? "▸" : "▾";
    collapse.title = "Collapse";
    collapse.addEventListener("click", () => {
      const now = !panel.classList.contains("collapsed");
      panel.classList.toggle("collapsed", now);
      collapse.textContent = now ? "▸" : "▾";
      saveUi({ collapsed: now });
    });
    head.append(title, recEl, collapse);

    const body = document.createElement("div");
    body.className = "body";

    canvas = document.createElement("canvas");
    canvas.className = "wave";

    const scrubTo = (e) => {
      const r = canvas.getBoundingClientRect();
      playhead = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      render();
    };
    let scrubbing = false;
    canvas.addEventListener("pointerdown", (e) => {
      scrubbing = true;
      canvas.setPointerCapture(e.pointerId);
      scrubTo(e);
    });
    canvas.addEventListener("pointermove", (e) => scrubbing && scrubTo(e));
    const endScrub = (e) => {
      scrubbing = false;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* pointer already gone */
      }
    };
    canvas.addEventListener("pointerup", endScrub);
    canvas.addEventListener("pointercancel", endScrub);

    const controls = document.createElement("div");
    controls.className = "controls";

    playBtn = document.createElement("button");
    playBtn.className = "play";
    playBtn.textContent = "▶";
    playBtn.addEventListener("click", () => (playSrc ? stopPlayback() : playFromPlayhead()));

    timeEl = document.createElement("div");
    timeEl.className = "time";

    const liveBtn = document.createElement("button");
    liveBtn.className = "txtbtn";
    liveBtn.textContent = "Live";
    liveBtn.title = "Jump the playhead back to now";
    liveBtn.addEventListener("click", () => {
      playhead = 1;
      render();
    });

    pauseBtn = document.createElement("button");
    pauseBtn.className = "txtbtn";
    pauseBtn.title = "Stop capturing into the buffer";
    pauseBtn.addEventListener("click", () => {
      paused = !paused;
      render();
    });

    tabBtn = document.createElement("button");
    tabBtn.className = "txtbtn";
    tabBtn.addEventListener("click", captureTabAudio);

    const clearBtn = document.createElement("button");
    clearBtn.className = "txtbtn";
    clearBtn.textContent = "Clear";
    clearBtn.title = "Wipe the buffer";
    clearBtn.addEventListener("click", clearRing);

    controls.append(playBtn, timeEl, liveBtn, pauseBtn, tabBtn, clearBtn);

    const sources = document.createElement("div");
    sources.className = "sources";
    const mkCheck = (label, initial, onChange) => {
      const wrap = document.createElement("label");
      wrap.className = "check";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = initial;
      box.addEventListener("change", () => onChange(box.checked));
      wrap.append(box, document.createTextNode(label));
      return wrap;
    };
    sources.append(
      document.createTextNode("record:"),
      mkCheck("me", recMe, (on) => {
        recMe = on;
        if (micGain) micGain.gain.value = on ? 1 : 0;
        saveUi({ recMe: on });
        render();
      }),
      mkCheck("others", recOthers, (on) => {
        recOthers = on;
        if (othersGain) othersGain.gain.value = on ? 1 : 0;
        saveUi({ recOthers: on });
        render();
      }),
    );

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent =
      "Drag to scrub, Play re-sends from there to the room. Memory only, never saved.";

    body.append(canvas, controls, sources, hint);
    panel.append(head, body);
    wrap.append(toolBtn, panel);
    root.appendChild(wrap);
    document.body.appendChild(host);

    makeDraggable(panel, head);

    // Clicks inside the shadow root retarget to the host, so this only fires on
    // genuine outside clicks.
    document.addEventListener("click", (e) => {
      if (mode === "docked" && !host.contains(e.target)) closePopover();
    });
    window.addEventListener("resize", positionPopover);

    ensureMounted();
    setInterval(ensureMounted, 2000);
    render();

    // The waveform grows continuously while capturing, so repaint on a timer
    // rather than only on interaction. 10fps is plenty and costs nothing.
    setInterval(() => {
      if (!panel.classList.contains("collapsed")) render();
    }, 100);

    log("panel mounted");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountPanel, { once: true });
  } else {
    mountPanel();
  }
})();
