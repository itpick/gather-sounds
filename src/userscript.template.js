// ==UserScript==
// @name         Gather Farts
// @namespace    lucas.local
// @version      1.15.0
// @description  Soundboard that plays through your microphone in Gather, so the whole room hears it.
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
// @updateURL    https://raw.githubusercontent.com/itpick/gather-sounds/main/gather-farts.user.js
// @downloadURL  https://raw.githubusercontent.com/itpick/gather-sounds/main/gather-farts.user.js
// ==/UserScript==

/*
 * How this works
 * --------------
 * At document-start we replace navigator.mediaDevices.getUserMedia. When Gather
 * asks for the microphone we hand back a synthetic audio track produced by a Web
 * Audio graph:
 *
 *     realMicSource --+
 *                     +--> MediaStreamAudioDestinationNode --> track Gather sends
 *     fxGain ---------+
 *
 * Anything routed into fxGain therefore travels out over WebRTC to everyone in
 * the room. Clicking a button plays a decoded AudioBuffer into fxGain (and, at a
 * lower level, into your own speakers so you can hear what you just did).
 *
 * The generated file is built by build.mjs -- edit this template, not the output.
 */

(() => {
  "use strict";

  // Injected by build.mjs: [{ id, label, mime, b64 }, ...]
  const SOUNDS = /*__SOUNDS__*/ [];

  // Sounds too numerous to embed live in a public repo and are fetched on
  // demand. 666 clips is ~17 MB, which as base64 would roughly triple this
  // file and reparse on every Gather page load.
  //
  // They are SEARCH-ONLY: never in the default button list, only surfaced once
  // you type. That keeps the panel usable — a 666-row list is not a soundboard.
  const REMOTE_MANIFEST =
    "https://raw.githubusercontent.com/itpick/gather-sounds/main/manifest.json";
  const REMOTE_BASE =
    "https://raw.githubusercontent.com/itpick/gather-sounds/main/";
  const MAX_RESULTS = 40; // rendering every match would rebuild 666 rows per keystroke

  /** @type {Array<{id,label,url,searchOnly:boolean}>} */ let remoteSounds = [];

  async function loadRemoteManifest() {
    try {
      const r = await fetch(REMOTE_MANIFEST, { cache: "no-cache" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const m = await r.json();
      const groups = m.groups || {};
      remoteSounds = (m.sounds || []).map((s) => ({
        id: s.id,
        label: s.label || s.id,
        url: REMOTE_BASE + s.file,
        sortKey: s.sortKey || s.id,
        searchOnly: !!(groups[s.group] && groups[s.group].searchOnly),
      }));
      log(
        "remote manifest:",
        remoteSounds.length,
        "sound(s),",
        remoteSounds.filter((s) => !s.searchOnly).length,
        "in the default list",
      );
    } catch (err) {
      // Non-fatal by design: the bundled sounds are the ones people reach for,
      // and they must keep working when GitHub is unreachable or blocked.
      log("remote manifest unavailable —", err.message, "(bundled sounds still work)");
      remoteSounds = [];
    }
  }

  // The default button list: the two embedded sounds plus every hosted sound
  // NOT marked searchOnly, merged back into one order by sortKey.
  //
  // Only wet-fart and rimshot are embedded now -- everything else is fetched.
  // Those two exist so the board is not dead when GitHub is blocked or down,
  // which is also why they are the ones you would actually reach for.
  function defaultList() {
    const merged = [
      ...SOUNDS.map((s) => ({ ...s, searchOnly: false })),
      ...remoteSounds.filter((s) => !s.searchOnly),
    ];
    return merged.sort((a, b) =>
      String(a.sortKey || a.id).localeCompare(String(b.sortKey || b.id)),
    );
  }

  // Every sound the search can see, default list plus the search-only ones.
  function searchable() {
    return [...defaultList(), ...remoteSounds.filter((s) => s.searchOnly)];
  }

  function matches(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/);
    return searchable()
      .filter((s) => {
        const hay = s.label.toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .sort((a, b) => {
        // Prefix matches first — typing "amer" should surface "America" above
        // a clip that merely contains the word.
        const ap = a.label.toLowerCase().startsWith(q) ? 0 : 1;
        const bp = b.label.toLowerCase().startsWith(q) ? 0 : 1;
        return ap - bp || a.label.length - b.label.length;
      });
  }

  const LS_KEY = "gatherFarts.ui";
  const MONITOR_GAIN = 0.35; // how loudly you hear your own farts locally
  const log = (...a) => console.log("%c[farts]", "color:#c084fc", ...a);

  // ---------------------------------------------------------------------------
  // Audio graph
  // ---------------------------------------------------------------------------

  /** @type {AudioContext|null} */ let ctx = null;
  /** @type {GainNode|null} */ let fxGain = null;

  // One destination node per live getUserMedia call. Each gets its own track so
  // that Gather stopping one (device switch, leaving a room) never kills the
  // others -- and never permanently kills our mixer.
  /** @type {Set<MediaStreamAudioDestinationNode>} */ const liveDests = new Set();

  const buffers = new Map(); // id -> AudioBuffer
  const decoding = new Map(); // id -> Promise<AudioBuffer>

  function ensureGraph() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    fxGain = ctx.createGain();
    fxGain.gain.value = 1.0;
    log("audio context created", ctx.sampleRate + "Hz");
  }

  function base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  // Bytes for a sound: embedded base64 for the bundled ones, a fetch for the
  // hosted ones. decodeAudioData wants an ArrayBuffer either way.
  //
  // The hosted clips are served with Access-Control-Allow-Origin: *, which is
  // why a plain fetch works here despite @grant none putting us in the page's
  // origin. No GM_xmlhttpRequest, no @connect.
  function bytesFor(sound) {
    if (sound.b64) return Promise.resolve(base64ToArrayBuffer(sound.b64));
    return fetch(sound.url, { cache: "force-cache" }).then((r) => {
      if (!r.ok) throw new Error(`fetch ${sound.id}: HTTP ${r.status}`);
      return r.arrayBuffer();
    });
  }

  function getBuffer(sound) {
    if (buffers.has(sound.id)) return Promise.resolve(buffers.get(sound.id));
    if (decoding.has(sound.id)) return decoding.get(sound.id);
    ensureGraph();
    const p = bytesFor(sound)
      .then((bytes) => ctx.decodeAudioData(bytes))
      .then((buf) => {
        buffers.set(sound.id, buf);
        decoding.delete(sound.id);
        return buf;
      })
      .catch((err) => {
        decoding.delete(sound.id);
        throw err;
      });
    decoding.set(sound.id, p);
    return p;
  }

  // Most recent playback per sound, so the loop toggle can reach into a sound
  // that is already running and the button can stop a loop.
  /** @type {Map<string, {src: AudioBufferSourceNode, monitor: GainNode}>} */
  const activeSources = new Map();

  async function play(sound, { loop = false } = {}) {
    ensureGraph();
    if (ctx.state === "suspended") await ctx.resume();

    const buf = await getBuffer(sound);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;

    // Out to the room.
    src.connect(fxGain);

    // And quietly to your own speakers so you know it fired.
    const monitor = ctx.createGain();
    monitor.gain.value = MONITOR_GAIN;
    src.connect(monitor);
    monitor.connect(ctx.destination);

    const handle = { src, monitor };
    src.onended = () => {
      try {
        src.disconnect();
        monitor.disconnect();
      } catch (_) {
        /* already torn down */
      }
      // Only clear if a newer playback hasn't already replaced us.
      if (activeSources.get(sound.id) === handle) activeSources.delete(sound.id);
      renderSound(sound.id);
    };
    src.start();
    activeSources.set(sound.id, handle);
    renderSound(sound.id);
    return buf.duration;
  }

  function stop(soundId) {
    const active = activeSources.get(soundId);
    if (!active) return;
    try {
      active.src.stop();
    } catch (_) {
      /* already stopped; onended will clean up */
    }
  }

  /** Retarget a live playback when the loop toggle flips mid-sound. */
  function setLoop(soundId, loop) {
    const active = activeSources.get(soundId);
    if (!active) return;
    // Turning loop off lets the current pass finish and end naturally rather
    // than cutting the audio off mid-word.
    active.src.loop = loop;
  }

  // ---------------------------------------------------------------------------
  // The microphone tap
  // ---------------------------------------------------------------------------

  function tapStream(realStream) {
    const realAudio = realStream.getAudioTracks();
    if (realAudio.length === 0) return realStream;

    ensureGraph();

    const dest = ctx.createMediaStreamDestination();
    const micSource = ctx.createMediaStreamSource(realStream);
    micSource.connect(dest);
    fxGain.connect(dest);
    liveDests.add(dest);

    const outTrack = dest.stream.getAudioTracks()[0];

    // When Gather stops our track, stop the real mic too -- otherwise the
    // browser's recording indicator stays lit forever.
    const origStop = outTrack.stop.bind(outTrack);
    outTrack.stop = () => {
      origStop();
      realAudio.forEach((t) => t.stop());
      try {
        micSource.disconnect();
        fxGain.disconnect(dest);
      } catch (_) {
        /* already disconnected */
      }
      liveDests.delete(dest);
      renderStatus();
      log("mic tap released");
    };

    // Destination-node tracks don't support real constraints; make sure a
    // hopeful applyConstraints() call from Gather can't reject and break a flow.
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
      log("navigator.mediaDevices.getUserMedia unavailable; nothing to patch");
      return;
    }
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async function (constraints) {
      const stream = await orig(constraints);
      if (!constraints || !constraints.audio) return stream; // video-only: untouched
      try {
        return tapStream(stream);
      } catch (err) {
        console.error("[farts] mic tap failed, passing the real stream through", err);
        return stream;
      }
    };
    log("getUserMedia patched");
  }

  installMicPatch();

  // ---------------------------------------------------------------------------
  // Outgoing audio quality
  // ---------------------------------------------------------------------------
  //
  // Gather negotiates Opus for the mic track and, being built for speech, ends
  // up around 32 kbps mono with DTX on. That is the ceiling everything we play
  // passes through, so raising it is the only thing that actually improves what
  // the room hears -- the source files are already better than the pipe.
  //
  // TWO DIRECTIONS, AND THEY ARE EASY TO CONFUSE:
  //
  //   `a=fmtp:111 maxaveragebitrate=...` in the SDP *we send* is a hint to the
  //   REMOTE encoder: "do not send me more than this". It does nothing to our
  //   own encoder. To raise what WE send we have to change the description we
  //   RECEIVE -- that is what our encoder is told it may produce -- so the
  //   munge below is applied in setRemoteDescription.
  //
  //   setParameters({encodings:[{maxBitrate}]}) is the direct, non-string way
  //   to say the same thing, and it survives renegotiation. We do both: SDP
  //   munging alone loses on re-offer, and setParameters alone is ignored by
  //   some stacks for audio.
  //
  // usedtx=0 matters more than it looks. DTX stops transmitting during
  // perceived silence, which is right for a talking head and wrong for sound
  // effects -- it swallows quiet intros and clips tails.
  //
  // Not forcing stereo: every clip here is mono (-ac 1) and so is the mic, so
  // sprop-stereo would spend bits carrying a duplicate channel.

  // DEFAULT OFF, deliberately.
  //
  // This rewrites the SDP of a live WebRTC negotiation. If Gather rejects the
  // result, the call fails and you lose ALL audio -- not just the soundboard,
  // but the mic and everyone else. An optional quality tweak must never be the
  // reason a meeting is silent, so it is opt-in and every failure path below
  // falls back to the untouched description.
  const QUALITY_DEFAULTS = { enabled: false, bitrate: 96000 };

  function qualityCfg() {
    const ui = loadUi();
    return {
      enabled: ui.hqEnabled === true,
      bitrate: typeof ui.hqBitrate === "number" ? ui.hqBitrate : QUALITY_DEFAULTS.bitrate,
    };
  }

  // Rewrite the Opus fmtp line, adding our params and overwriting any the far
  // end already set. Opus is found by payload type from the rtpmap, not by
  // assuming 111 -- the number is negotiated and Gather is free to change it.
  function mungeOpus(sdp, bitrate) {
    if (!sdp) return sdp;
    const pts = [...sdp.matchAll(/^a=rtpmap:(\d+)\s+opus\/48000/gim)].map((m) => m[1]);
    if (pts.length === 0) return sdp;

    const want = {
      maxaveragebitrate: String(bitrate),
      maxplaybackrate: "48000",
      usedtx: "0",
      useinbandfec: "1",
    };

    let out = sdp;
    for (const pt of pts) {
      const re = new RegExp(`^a=fmtp:${pt} (.*)$`, "im");
      if (re.test(out)) {
        out = out.replace(re, (_, params) => {
          const kv = new Map();
          for (const p of params.split(";")) {
            const i = p.indexOf("=");
            if (i > 0) kv.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
          }
          for (const [k, v] of Object.entries(want)) kv.set(k, v);
          return `a=fmtp:${pt} ${[...kv].map(([k, v]) => `${k}=${v}`).join(";")}`;
        });
      } else {
        // No fmtp for Opus at all -- add one right after its rtpmap.
        const rt = new RegExp(`^(a=rtpmap:${pt} opus/48000[^\\r\\n]*)$`, "im");
        const line = Object.entries(want).map(([k, v]) => `${k}=${v}`).join(";");
        out = out.replace(rt, `$1\r\na=fmtp:${pt} ${line}`);
      }
    }
    return out;
  }

  async function raiseSenderBitrate(pc, bitrate) {
    try {
      for (const sender of pc.getSenders()) {
        if (!sender.track || sender.track.kind !== "audio") continue;
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        for (const e of params.encodings) {
          e.maxBitrate = bitrate;
          e.networkPriority = "high";
        }
        await sender.setParameters(params);
      }
    } catch (err) {
      // Non-fatal: the SDP munge above is the primary mechanism.
      log("setParameters failed —", err.message);
    }
  }

  function installQualityPatch() {
    const PC = window.RTCPeerConnection;
    if (typeof PC !== "function") {
      log("RTCPeerConnection unavailable; audio quality left at Gather's default");
      return;
    }
    const origSetRemote = PC.prototype.setRemoteDescription;
    const origSetLocal = PC.prototype.setLocalDescription;

    // Never let munging break the call. If the rewrite throws, or if the
    // browser rejects the rewritten SDP, fall back to the original description
    // and carry on at Gather's default quality -- a quieter call beats a dead
    // one, and this is exactly how a "safe" enhancement turns into "nobody can
    // hear anything" if it is allowed to fail hard.
    function safeMunge(desc, bitrate) {
      try {
        if (!desc || !desc.sdp) return null;
        const sdp = mungeOpus(desc.sdp, bitrate);
        if (sdp === desc.sdp) return null;
        // RTCSessionDescription is read-only in some builds; pass a plain object.
        return { type: desc.type, sdp };
      } catch (err) {
        log("SDP munge failed, using the original —", err.message);
        return null;
      }
    }

    PC.prototype.setRemoteDescription = function (desc, ...rest) {
      const cfg = qualityCfg();
      const munged = cfg.enabled ? safeMunge(desc, cfg.bitrate) : null;
      if (!munged) return origSetRemote.call(this, desc, ...rest);

      log("raising outgoing Opus ceiling to", cfg.bitrate / 1000, "kbps, DTX off");
      return Promise.resolve(origSetRemote.call(this, munged, ...rest))
        .then(() => raiseSenderBitrate(this, cfg.bitrate))
        .catch((err) => {
          log("rejected the raised-bitrate SDP, retrying untouched —", err.message);
          return origSetRemote.call(this, desc, ...rest);
        });
    };

    // Also on the local side: this governs what the far end may send US, which
    // is what makes other people's audio better rather than just our own.
    PC.prototype.setLocalDescription = function (desc, ...rest) {
      const cfg = qualityCfg();
      const munged = cfg.enabled ? safeMunge(desc, cfg.bitrate) : null;
      if (!munged) return origSetLocal.call(this, desc, ...rest);
      return Promise.resolve(origSetLocal.call(this, munged, ...rest)).catch((err) => {
        log("rejected the raised-bitrate local SDP, retrying untouched —", err.message);
        return origSetLocal.call(this, desc, ...rest);
      });
    };

    log("RTCPeerConnection patched for audio quality");
  }

  installQualityPatch();

  // ---------------------------------------------------------------------------
  // "Can they actually hear it?"
  // ---------------------------------------------------------------------------
  //
  // The status line above only proves the mic was TAPPED -- that our track
  // reached Gather. It says nothing about whether audio is leaving the machine,
  // which is the thing you actually want to know and the thing colleagues are
  // least reliable about.
  //
  // WebRTC keeps that answer: getStats() exposes a `media-source` report for
  // the outgoing audio track with a live `audioLevel`, plus `outbound-rtp` with
  // bytesSent. If audioLevel moves when you press a button, the room is being
  // sent audio. Whether anyone admits to hearing it is then their problem.

  /** @type {Set<WeakRef<RTCPeerConnection>>} */ const peerConns = new Set();

  function installPcRegistry() {
    const PC = window.RTCPeerConnection;
    if (typeof PC !== "function") return;
    function Patched(...args) {
      const pc = new PC(...args);
      try {
        peerConns.add(new WeakRef(pc));
      } catch (_) {
        /* no WeakRef: skip the meter rather than leaking connections */
      }
      return pc;
    }
    Patched.prototype = PC.prototype;
    Object.setPrototypeOf(Patched, PC);
    window.RTCPeerConnection = Patched;
    if (window.webkitRTCPeerConnection === PC) window.webkitRTCPeerConnection = Patched;
    log("RTCPeerConnection registry installed");
  }

  installPcRegistry();

  // Peak outgoing audio level across every live connection, 0..1, plus the
  // send rate. Returns null when there is nothing to measure yet.
  let lastBytes = 0;
  let lastAt = 0;
  async function outboundAudio() {
    let level = null;
    let bytes = 0;
    let sawAudio = false;
    for (const ref of [...peerConns]) {
      const pc = ref.deref();
      if (!pc) {
        peerConns.delete(ref); // connection is gone; stop holding the slot
        continue;
      }
      if (pc.connectionState === "closed") continue;
      let stats;
      try {
        stats = await pc.getStats();
      } catch (_) {
        continue;
      }
      stats.forEach((r) => {
        if (r.type === "media-source" && r.kind === "audio") {
          sawAudio = true;
          if (typeof r.audioLevel === "number") level = Math.max(level ?? 0, r.audioLevel);
        }
        if (r.type === "outbound-rtp" && r.kind === "audio" && typeof r.bytesSent === "number") {
          sawAudio = true;
          bytes += r.bytesSent;
        }
      });
    }
    if (!sawAudio) return null;
    const now = performance.now();
    const kbps =
      lastAt && bytes >= lastBytes ? ((bytes - lastBytes) * 8) / ((now - lastAt) / 1000) / 1000 : null;
    lastBytes = bytes;
    lastAt = now;
    return { level, kbps };
  }

  // ---------------------------------------------------------------------------
  // Panel
  // ---------------------------------------------------------------------------

  const CSS = `
    :host { all: initial; }

    /* Docked: a 36px control that blends into Gather's bar, with the panel as a
       popover above it. Floating: the standalone draggable panel. */
    .toolbtn {
      all: unset; box-sizing: border-box; cursor: pointer;
      display: none; width: 36px; height: 36px;
      align-items: center; justify-content: center;
      border-radius: 8px; font-size: 19px; line-height: 1;
    }
    .toolbtn:hover { background: rgba(255,255,255,0.12); }
    .toolbtn.active { background: rgba(126,63,242,0.45); }
    .wrap.docked .toolbtn { display: flex; }
    .wrap.docked .panel { display: none; }
    .wrap.docked .panel.open { display: block; }
    .wrap.docked .head { cursor: default; }
    .wrap.docked .collapse { display: none; }
    .wrap.docked .panel.collapsed .body,
    .wrap.docked .panel.collapsed .status { display: grid; }
    .wrap.docked .panel.collapsed .status { display: flex; }

    .panel {
      position: fixed; z-index: 2147483647;
      font: 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #f4f1f7; background: rgba(28, 22, 38, 0.94);
      border: 1px solid rgba(192, 132, 252, 0.35);
      border-radius: 12px; box-shadow: 0 10px 32px rgba(0,0,0,0.45);
      width: 224px; overflow: hidden;
      backdrop-filter: blur(8px);
      user-select: none;
    }
    .head {
      display: flex; align-items: center; gap: 6px;
      padding: 7px 9px; cursor: grab;
      background: rgba(192, 132, 252, 0.12);
      border-bottom: 1px solid rgba(192, 132, 252, 0.22);
    }
    .head.dragging { cursor: grabbing; }
    .title { flex: 1; font-weight: 600; letter-spacing: .2px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; flex: none; }
    .dot.on { background: #34d399; box-shadow: 0 0 6px #34d399; }
    .iconbtn {
      all: unset; cursor: pointer; padding: 0 5px; border-radius: 5px;
      color: #cbb8e6; font-size: 14px; line-height: 1;
    }
    .iconbtn:hover { background: rgba(255,255,255,0.1); color: #fff; }
    .body { padding: 8px; display: grid; gap: 6px; max-height: 320px; overflow-y: auto; }
    .search {
      margin: 8px 8px 0; padding: 6px 8px; font: inherit; font-size: 12px;
      border-radius: 6px; border: 1px solid #4b3b63; background: #2a2136;
      color: #efe7fb; outline: none;
    }
    .search::placeholder { color: #9d8fb5; }
    .hq { display: flex; align-items: center; gap: 8px; margin: 8px 8px 0; }
    .hqbtn {
      font: inherit; font-size: 11px; font-weight: 600; cursor: pointer;
      padding: 4px 8px; border-radius: 6px; border: 1px solid #4b3b63;
      background: #2a2136; color: #b6a8cc;
    }
    .hqbtn.on { border-color: #c084fc; color: #efe7fb; }
    .hqnote { font-size: 10px; color: #9d8fb5; }
    .meter { display: flex; align-items: center; gap: 8px; margin: 8px 8px 0; }
    .meterbar {
      flex: 1; height: 6px; border-radius: 3px; background: #2a2136;
      border: 1px solid #4b3b63; overflow: hidden;
    }
    .meterfill {
      height: 100%; width: 0%; background: #6b5a86;
      transition: width .12s linear;
    }
    .meterfill.live { background: linear-gradient(90deg, #7e3ff2, #c084fc); }
    .metertxt { font-size: 10px; color: #9d8fb5; min-width: 92px; text-align: right; }
    .search:focus { border-color: #c084fc; }
    .panel.collapsed .body, .panel.collapsed .status { display: none; }
    .row { display: grid; grid-template-columns: 1fr 32px; gap: 4px; }
    .sound {
      all: unset; box-sizing: border-box; cursor: pointer; text-align: center;
      padding: 9px 8px; border-radius: 8px; font-weight: 600;
      background: linear-gradient(180deg, #7e3ff2 0%, #6429d6 100%);
      color: #fff; border: 1px solid rgba(255,255,255,0.14);
      /* Long labels wrap to a second line rather than being cut off. */
      overflow-wrap: break-word; hyphens: auto;
    }
    .sound:hover { filter: brightness(1.14); }
    .sound:active { transform: translateY(1px); filter: brightness(0.94); }
    .sound.playing { outline: 2px solid #34d399; outline-offset: -2px; }
    .sound.looping {
      background: linear-gradient(180deg, #0f9d76 0%, #0b7d5d 100%);
      outline: none;
    }
    .sound.looping::before { content: "\\25A0  "; font-size: 10px; vertical-align: 1px; }
    .loop {
      all: unset; box-sizing: border-box; cursor: pointer; text-align: center;
      border-radius: 8px; font-size: 15px; line-height: 1;
      padding: 9px 0; color: #b6a8cc;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
    }
    .loop:hover { color: #fff; background: rgba(255,255,255,0.12); }
    .loop.on {
      color: #16121f; background: #34d399; border-color: #34d399;
      box-shadow: 0 0 8px rgba(52, 211, 153, .5);
    }
    .status {
      padding: 6px 9px 8px; font-size: 11px; color: #b6a8cc;
      border-top: 1px solid rgba(255,255,255,0.07);
      display: flex; align-items: center; gap: 6px;
    }
    .status.warn { color: #fbbf24; }
    .reload {
      all: unset; cursor: pointer; color: #f4f1f7; text-decoration: underline;
      text-underline-offset: 2px;
    }
    .empty { padding: 4px 2px; color: #b6a8cc; font-size: 12px; }
  `;

  let statusEl = null;
  let dotEl = null;

  /** @type {Map<string, {btn: HTMLElement, toggle: HTMLElement, label: string}>} */
  const soundEls = new Map();
  /** Sound ids armed to repeat until stopped. Persisted. */
  let armedLoops = new Set();

  function renderSound(id) {
    const els = soundEls.get(id);
    if (!els) return;
    const active = activeSources.get(id);
    const looping = !!active && active.src.loop;
    const armed = armedLoops.has(id);
    els.btn.classList.toggle("looping", looping);
    els.btn.classList.toggle("playing", !!active && !looping);
    els.btn.title = looping ? "Playing on repeat — click to stop" : els.label;
    els.toggle.classList.toggle("on", armed);
    els.toggle.title = armed
      ? "Repeat is on — click to turn off"
      : "Repeat is off — click to loop until stopped";
  }

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
      /* private mode, storage disabled -- position just won't persist */
    }
  }

  function renderStatus() {
    if (!statusEl || !dotEl) return;
    const on = liveDests.size > 0;
    dotEl.classList.toggle("on", on);
    statusEl.classList.toggle("warn", !on);
    if (on) {
      statusEl.textContent = "mic tap active — unmute to be heard";
    } else {
      statusEl.textContent = "waiting for mic — ";
      const btn = document.createElement("button");
      btn.className = "reload";
      btn.textContent = "reload tab";
      btn.addEventListener("click", () => location.reload());
      statusEl.appendChild(btn);
    }
  }

  function makeDraggable(panel, handle) {
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
      const r = panel.getBoundingClientRect();
      baseLeft = r.left;
      baseTop = r.top;
      startX = e.clientX;
      startY = e.clientY;
      e.preventDefault();
    });

    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const w = panel.offsetWidth,
        h = panel.offsetHeight;
      const left = Math.min(Math.max(0, baseLeft + e.clientX - startX), window.innerWidth - w);
      const top = Math.min(Math.max(0, baseTop + e.clientY - startY), window.innerHeight - h);
      panel.style.left = left + "px";
      panel.style.top = top + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
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
      const r = panel.getBoundingClientRect();
      saveUi({ left: r.left, top: r.top });
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  /**
   * Find Gather's bottom control group.
   *
   * Anchoring on the Screen share button's aria-label rather than a class name:
   * the emotion-generated classes (css-1s0xrxv and friends) change on every
   * Gather deploy, but the accessible labels are stable. From the button we walk
   * up to the first `.Layout` ancestor holding more than one control, which is
   * the group containing screen-share, the status circle, and the reactions
   * smiley -- so our button lands right beside them.
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
    panelEl = null,
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
        panelEl.style.left = Math.min(ui.left, window.innerWidth - 60) + "px";
        panelEl.style.top = Math.min(ui.top, window.innerHeight - 40) + "px";
        panelEl.style.right = panelEl.style.bottom = "auto";
      } else {
        panelEl.style.left = panelEl.style.top = "auto";
        panelEl.style.right = "18px";
        panelEl.style.bottom = "96px";
      }
    }
    log(`mode: ${next}`);
  }

  function positionPopover() {
    if (mode !== "docked" || !panelEl.classList.contains("open")) return;
    const r = toolBtn.getBoundingClientRect();
    // Fixed rather than absolute: an ancestor with overflow:hidden would
    // otherwise clip the popover.
    panelEl.style.top = "auto";
    panelEl.style.right = "auto";
    panelEl.style.bottom = window.innerHeight - r.top + 10 + "px";
    const left = Math.min(
      Math.max(8, r.left + r.width / 2 - panelEl.offsetWidth / 2),
      window.innerWidth - panelEl.offsetWidth - 8,
    );
    panelEl.style.left = left + "px";
  }

  function closePopover() {
    panelEl.classList.remove("open");
    if (toolBtn) toolBtn.classList.remove("active");
  }

  function togglePopover() {
    const open = !panelEl.classList.contains("open");
    panelEl.classList.toggle("open", open);
    toolBtn.classList.toggle("active", open);
    if (open) positionPopover();
  }

  /**
   * Gather re-renders its toolbar (joining a room, leaving, resizing), which
   * drops our node. Re-check periodically and re-attach; fall back to floating
   * whenever the bar isn't present, so the panel is never simply gone.
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
    if (document.getElementById("gather-farts-root")) return;

    host = document.createElement("div");
    host.id = "gather-farts-root";
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
    toolBtn.setAttribute("aria-label", "Soundboard");
    toolBtn.title = "Soundboard";
    toolBtn.textContent = "\u{1F4A8}";
    toolBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePopover();
    });

    const panel = document.createElement("div");
    panelEl = panel;
    panel.className = "panel" + (ui.collapsed ? " collapsed" : "");

    const head = document.createElement("div");
    head.className = "head";
    dotEl = document.createElement("div");
    dotEl.className = "dot";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "\u{1F4A8} Farts";
    const collapse = document.createElement("button");
    collapse.className = "iconbtn collapse";
    collapse.title = "Collapse";
    collapse.textContent = ui.collapsed ? "▸" : "▾";
    collapse.addEventListener("click", () => {
      const nowCollapsed = !panel.classList.contains("collapsed");
      panel.classList.toggle("collapsed", nowCollapsed);
      collapse.textContent = nowCollapsed ? "▸" : "▾";
      saveUi({ collapsed: nowCollapsed });
    });
    head.append(dotEl, title, collapse);

    const body = document.createElement("div");
    body.className = "body";

    armedLoops = new Set(Array.isArray(ui.loops) ? ui.loops : []);

    function makeRow(sound) {
      const row = document.createElement("div");
      row.className = "row";

      const btn = document.createElement("button");
      btn.className = "sound";
      btn.textContent = sound.label;
      btn.title = sound.label; // transcripts run long; the button clips them

      const toggle = document.createElement("button");
      toggle.className = "loop";
      toggle.textContent = "⟳";

      soundEls.set(sound.id, { btn, toggle, label: sound.label });

      btn.addEventListener("click", async () => {
        // A looping sound's own button is its stop button.
        const active = activeSources.get(sound.id);
        if (active && active.src.loop) {
          stop(sound.id);
          return;
        }
        try {
          await play(sound, { loop: armedLoops.has(sound.id) });
          if (liveDests.size === 0) {
            statusEl.classList.add("warn");
            statusEl.textContent = "played locally only — mic not tapped yet, reload the tab";
          }
        } catch (err) {
          console.error("[farts] playback failed", err);
          statusEl.classList.add("warn");
          statusEl.textContent = "playback failed — see console";
          renderSound(sound.id);
        }
      });

      toggle.addEventListener("click", () => {
        const on = !armedLoops.has(sound.id);
        if (on) armedLoops.add(sound.id);
        else armedLoops.delete(sound.id);
        saveUi({ loops: [...armedLoops] });
        setLoop(sound.id, on); // takes effect on anything already playing
        renderSound(sound.id);
      });

      row.append(btn, toggle);
      return row;
    }

    // The list is rebuilt on every keystroke rather than shown/hidden, because
    // only a slice of the matches is ever in the DOM (MAX_RESULTS).
    function renderList(query) {
      soundEls.clear();
      body.textContent = "";

      const q = (query || "").trim();
      if (!q) {
        // Default view: embedded sounds plus the hosted non-searchOnly ones.
        // The 666 clips stay hidden until searched for.
        const list = defaultList();
        for (const s of list) body.appendChild(makeRow(s));
        if (list.length === 0) {
          const empty = document.createElement("div");
          empty.className = "empty";
          empty.textContent = "No sounds bundled. Add files to sounds/ and re-run build.mjs.";
          body.appendChild(empty);
        }
        list.forEach((s) => renderSound(s.id));
        return;
      }

      const hits = matches(q);
      for (const s of hits.slice(0, MAX_RESULTS)) body.appendChild(makeRow(s));

      if (hits.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = remoteSounds.length
          ? `No sound matches "${q}".`
          : `No sound matches "${q}". (The hosted set did not load — only bundled sounds are searchable.)`;
        body.appendChild(empty);
      } else if (hits.length > MAX_RESULTS) {
        const more = document.createElement("div");
        more.className = "empty";
        more.textContent = `…and ${hits.length - MAX_RESULTS} more — keep typing to narrow.`;
        body.appendChild(more);
      }
      hits.slice(0, MAX_RESULTS).forEach((s) => renderSound(s.id));
    }

    // HQ toggle. Deliberately requires a reconnect to take effect: the SDP is
    // negotiated once when the call is set up, so flipping this mid-call
    // changes nothing until Gather renegotiates. Saying so is better than a
    // toggle that appears to do nothing.
    // Outgoing-audio meter. Proof, not reassurance: it reads the same stats
    // chrome://webrtc-internals does.
    const meterRow = document.createElement("div");
    meterRow.className = "meter";
    const meterBar = document.createElement("div");
    meterBar.className = "meterbar";
    const meterFill = document.createElement("div");
    meterFill.className = "meterfill";
    meterBar.appendChild(meterFill);
    const meterTxt = document.createElement("span");
    meterTxt.className = "metertxt";
    meterTxt.textContent = "out: —";
    meterRow.append(meterBar, meterTxt);

    let peakSeen = 0;
    setInterval(async () => {
      const s = await outboundAudio();
      if (!s) {
        meterFill.style.width = "0%";
        meterTxt.textContent = "out: no call";
        return;
      }
      const lvl = s.level ?? 0;
      peakSeen = Math.max(peakSeen * 0.93, lvl); // slow decay so a blip stays visible
      meterFill.style.width = Math.min(100, Math.round(peakSeen * 140)) + "%";
      meterTxt.textContent =
        "out: " + (s.kbps != null ? s.kbps.toFixed(0) + " kbps" : "…") +
        (lvl > 0.01 ? " ▪ sending" : "");
      meterFill.classList.toggle("live", lvl > 0.01);
    }, 400);

    const hqRow = document.createElement("div");
    hqRow.className = "hq";
    const hqBtn = document.createElement("button");
    hqBtn.className = "hqbtn";
    const hqNote = document.createElement("span");
    hqNote.className = "hqnote";
    function paintHq() {
      const { enabled, bitrate } = qualityCfg();
      hqBtn.textContent = enabled ? `HQ audio: on (${bitrate / 1000}k)` : "HQ audio: off";
      hqBtn.classList.toggle("on", enabled);
      hqNote.textContent = "reload to apply";
    }
    hqBtn.addEventListener("click", () => {
      const cur = qualityCfg();
      saveUi({ hqEnabled: !cur.enabled });
      paintHq();
    });
    paintHq();
    hqRow.append(hqBtn, hqNote);

    const search = document.createElement("input");
    search.className = "search";
    search.type = "search";
    search.placeholder = "Search sounds…";
    search.autocomplete = "off";
    search.spellcheck = false;
    // Gather binds single-key shortcuts (x to dance, etc.) at the document
    // level, so typing "x" here would fire them. Stop the event before it
    // escapes the shadow root.
    for (const ev of ["keydown", "keyup", "keypress"]) {
      search.addEventListener(ev, (e) => e.stopPropagation());
    }
    search.addEventListener("input", () => renderList(search.value));
    search.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        search.value = "";
        renderList("");
        search.blur();
      }
    });

    statusEl = document.createElement("div");
    statusEl.className = "status warn";

    panel.append(head, meterRow, hqRow, search, body, statusEl);
    wrap.append(toolBtn, panel);
    root.appendChild(wrap);
    document.body.appendChild(host);

    makeDraggable(panel, head);
    renderList(""); // bundled sounds; also restores persisted loop arming
    renderStatus();

    // Fetch the hosted index in the background. Nothing waits on it: the panel
    // is usable immediately and search simply gains the hosted clips when it
    // lands (or does not, if GitHub is blocked).
    loadRemoteManifest().then(() => {
      // The default list itself now depends on the manifest, so redraw either
      // way -- not only when a search is active.
      renderList(search.value);
    });

    // Clicks inside the shadow root retarget to the host, so this only fires
    // for genuine outside clicks.
    document.addEventListener("click", (e) => {
      if (mode === "docked" && !host.contains(e.target)) closePopover();
    });
    window.addEventListener("resize", positionPopover);

    ensureMounted();
    setInterval(ensureMounted, 2000);
    log("panel mounted with", SOUNDS.length, "sound(s)");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountPanel, { once: true });
  } else {
    mountPanel();
  }
})();
