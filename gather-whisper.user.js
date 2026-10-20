// ==UserScript==
// @name         Gather Whisper
// @namespace    lucas.local
// @version      0.4.0
// @description  Live captions, a meeting transcript and keyword-triggered sounds for a Gather call. Whisper runs in your browser -- no audio leaves the page.
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
// @updateURL    https://raw.githubusercontent.com/itpick/gather-sounds/main/gather-whisper.user.js
// @downloadURL  https://raw.githubusercontent.com/itpick/gather-sounds/main/gather-whisper.user.js
// ==/UserScript==

/*
 * How this works
 * --------------
 * The same two interceptions as the Mic DVR, at document-start:
 *
 *   getUserMedia      -> your microphone
 *   RTCPeerConnection -> every remote participant's audio track
 *
 * Each source feeds a "channel": a ScriptProcessor that downsamples to 16 kHz
 * and runs a small energy-based voice activity detector. While someone is
 * speaking the channel sends a partial transcription request about once a
 * second (captions), and a final one when they stop (transcript).
 *
 *     mic ------------> channel "Me" ---------+
 *     remote track 1 -> channel "Guest 1" ----+--> worker (Whisper) --> captions,
 *     remote track 2 -> channel "Guest 2" ----+                          transcript,
 *                                                                        keyword rules
 *     "Me vs Them" mode routes every remote track into one "Them" channel instead.
 *
 * Keyword sounds go either to the room (mixed into the track Gather sends, like
 * the soundboard) or only to you. Room sounds are injected AFTER the mic tap, so
 * your own channel never hears them and can't re-trigger itself.
 *
 * Loading Whisper under Gather's CSP
 * ----------------------------------
 * Gather's script-src allows blob: and 'wasm-unsafe-eval' but not jsDelivr,
 * and sets no connect-src. So the worker fetch()es transformers.min.js (the
 * build that bundles onnxruntime -- the .web build has a bare import a blob
 * can't resolve) and imports it from a blob: URL. Weights come from the Hugging
 * Face CDN and are cached by the browser after the first load.
 *
 * WebGPU detection rejects fallback (software / SwiftShader) adapters: those
 * are ~30x slower than plain WASM. Without a real GPU, use tiny.en on WASM.
 *
 * PRIVACY: this transcribes everyone you can hear. The panel shows a live
 * indicator and there is no hidden mode. The transcript is memory-only until
 * you press Download, and dies with the tab -- unless "save to logs/" is
 * ticked (off by default), which appends each line to logs/ in this repo via
 * tools/transcript-log-server.mjs.
 *
 * Standalone, no build step -- edit it directly.
 */

(() => {
  "use strict";

  const TJS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js";
  const MANIFEST_URL = "https://raw.githubusercontent.com/itpick/gather-sounds/main/manifest.json";
  const SOUND_BASE = "https://raw.githubusercontent.com/itpick/gather-sounds/main/";
  const LS_KEY = "gatherWhisper.ui";
  // tools/transcript-log-server.mjs -- writes transcripts into logs/.
  const LOG_SERVER = "http://127.0.0.1:8779";

  const MODELS = [
    { id: "onnx-community/whisper-tiny.en", label: "tiny.en (fastest)", english: true },
    { id: "onnx-community/whisper-base.en", label: "base.en", english: true },
    { id: "onnx-community/whisper-small.en", label: "small.en (GPU default)", english: true },
    { id: "onnx-community/whisper-large-v3-turbo", label: "large-v3-turbo (big download)", english: false },
  ];

  const SR = 16000; // Whisper's input rate
  const PROCESSOR_SIZE = 4096;
  const PREROLL_S = 0.3; // audio kept from before speech was detected
  const HANGOVER_S = 0.6; // silence that ends an utterance
  const MIN_SPEECH_S = 0.35; // shorter blips are ignored
  const MAX_SEGMENT_S = 12; // force a cut so captions keep moving
  const PARTIAL_EVERY_S = 1.0;
  const MONITOR_GAIN = 0.5; // how loudly you hear a room sound yourself

  const log = (...a) => console.log("%c[whisper]", "color:#a78bfa", ...a);

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

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
      /* storage disabled -- settings just won't persist */
    }
  }

  const saved = loadUi();
  const settings = {
    enabled: saved.enabled !== false,
    model: saved.model || "auto", // "auto" or a MODELS id
    mode: saved.mode === "me-them" ? "me-them" : "per-person",
    transcribeMe: saved.transcribeMe !== false,
    captions: saved.captions !== false,
    // Off unless ticked: writes transcripts to disk via the local log server.
    logToDisk: saved.logToDisk === true,
    /** @type {{id:string, phrase:string, sound:string, dest:"room"|"me", who:"others"|"anyone", match?:"exact"|"fuzzy"}[]} */
    rules: Array.isArray(saved.rules) ? saved.rules : [],
    // Names typed into the speaker boxes. Remote tracks carry no stable
    // identity across reloads, so this is a pick-list, not an auto-mapping.
    /** @type {string[]} */
    names: Array.isArray(saved.names) ? saved.names : [],
  };

  // ---------------------------------------------------------------------------
  // Audio graph
  // ---------------------------------------------------------------------------

  /** @type {AudioContext|null} */ let ctx = null;
  /** Everything mixed in here reaches the room (keyword sounds). */
  /** @type {GainNode|null} */ let roomGain = null;
  let micLive = false;

  function ensureGraph() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    roomGain = ctx.createGain();
    // A context created before any user gesture starts suspended.
    const resume = () => ctx.state === "suspended" && ctx.resume();
    document.addEventListener("click", resume, true);
    document.addEventListener("keydown", resume, true);
    log("audio graph ready @", ctx.sampleRate, "Hz");
  }

  // ---------------------------------------------------------------------------
  // Channels: one VAD + segmenter per speaker (or per "Them" mix)
  // ---------------------------------------------------------------------------

  /** @type {Map<string, Channel>} */
  const channels = new Map();
  let guestCount = 0;

  class Channel {
    constructor(id, label, kind) {
      this.id = id;
      this.label = label;
      this.kind = kind; // "me" | "remote" | "them"
      this.input = ctx.createGain();
      this.proc = ctx.createScriptProcessor(PROCESSOR_SIZE, 1, 1);
      this.input.connect(this.proc);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      this.proc.connect(sink);
      sink.connect(ctx.destination); // a ScriptProcessor only runs when connected
      this.sink = sink;

      this.ratio = ctx.sampleRate / SR;
      this.carry = 0; // fractional resampling position
      this.pre = []; // preroll chunks
      this.preLen = 0;
      this.seg = null; // Float32Array chunks of the current utterance
      this.segLen = 0;
      this.silence = 0;
      this.floor = 0.002;
      this.lastPartialAt = 0;
      this.inflight = false;
      this.segId = 0;
      this.fired = new Set(); // rule ids already fired in this utterance
      this.speaking = false;
      this.partial = "";

      this.proc.onaudioprocess = (e) => {
        if (!settings.enabled || (this.kind === "me" && !settings.transcribeMe)) return;
        this.push(this.downsample(e.inputBuffer.getChannelData(0)));
      };
    }

    downsample(input) {
      // Box-filter decimation: average the input samples that fall into each
      // output sample. Crude, but speech below 8 kHz survives it fine.
      const outLen = Math.floor((input.length - this.carry) / this.ratio);
      const out = new Float32Array(Math.max(0, outLen));
      let pos = this.carry;
      for (let i = 0; i < out.length; i++) {
        const a = Math.floor(pos);
        const b = Math.min(input.length, Math.floor(pos + this.ratio));
        let sum = 0;
        for (let j = a; j < b; j++) sum += input[j];
        out[i] = b > a ? sum / (b - a) : 0;
        pos += this.ratio;
      }
      this.carry = pos - input.length;
      if (this.carry < 0) this.carry = 0;
      return out;
    }

    push(chunk) {
      if (chunk.length === 0) return;
      let sq = 0;
      for (let i = 0; i < chunk.length; i++) sq += chunk[i] * chunk[i];
      const rms = Math.sqrt(sq / chunk.length);
      const threshold = Math.max(0.008, this.floor * 3);
      const loud = rms > threshold;
      const secs = chunk.length / SR;

      if (!this.seg) {
        if (!loud) {
          this.floor = this.floor * 0.95 + rms * 0.05;
          this.pre.push(chunk);
          this.preLen += chunk.length;
          while (this.preLen - this.pre[0].length > PREROLL_S * SR) this.preLen -= this.pre.shift().length;
          return;
        }
        this.seg = this.pre;
        this.segLen = this.preLen;
        this.pre = [];
        this.preLen = 0;
        this.silence = 0;
        this.segId++;
        this.fired = new Set();
        this.speaking = true;
        this.lastPartialAt = performance.now();
      }

      this.seg.push(chunk);
      this.segLen += chunk.length;
      this.silence = loud ? 0 : this.silence + secs;

      const dur = this.segLen / SR;
      if (this.silence >= HANGOVER_S || dur >= MAX_SEGMENT_S) {
        this.finish();
      } else if (!this.inflight && performance.now() - this.lastPartialAt > PARTIAL_EVERY_S * 1000 && dur - this.silence >= MIN_SPEECH_S) {
        this.lastPartialAt = performance.now();
        this.inflight = true;
        const segId = this.segId;
        transcribe(this.audio(), false).then((text) => {
          this.inflight = false;
          if (text != null && this.segId === segId && this.seg) onText(this, text, false, segId);
        });
      }
    }

    audio() {
      const out = new Float32Array(this.segLen);
      let o = 0;
      for (const c of this.seg) {
        out.set(c, o);
        o += c.length;
      }
      return out;
    }

    finish() {
      if (!this.seg) return;
      const speech = this.segLen / SR - this.silence;
      const audio = this.audio();
      const segId = this.segId;
      const at = new Date(Date.now() - (this.segLen / SR) * 1000);
      this.seg = null;
      this.segLen = 0;
      this.speaking = false;
      if (speech < MIN_SPEECH_S) {
        this.partial = "";
        renderCaptions();
        return;
      }
      transcribe(audio, true).then((text) => {
        if (text != null) onText(this, text, true, segId, at);
      });
    }

    destroy() {
      this.finish();
      try {
        this.input.disconnect();
        this.proc.disconnect();
        this.sink.disconnect();
      } catch (_) {
        /* already torn down */
      }
      this.proc.onaudioprocess = null;
    }
  }

  function getChannel(id, label, kind) {
    let ch = channels.get(id);
    if (!ch) {
      ch = new Channel(id, label, kind);
      channels.set(id, ch);
      renderSpeakers();
    }
    return ch;
  }

  // ---------------------------------------------------------------------------
  // The microphone tap
  // ---------------------------------------------------------------------------

  function tapStream(realStream) {
    const realAudio = realStream.getAudioTracks();
    if (realAudio.length === 0) return realStream;
    ensureGraph();

    const source = ctx.createMediaStreamSource(realStream);
    const outDest = ctx.createMediaStreamDestination();
    source.connect(outDest);
    roomGain.connect(outDest);
    source.connect(getChannel("me", "Me", "me").input);
    micLive = true;

    const outTrack = outDest.stream.getAudioTracks()[0];
    const origStop = outTrack.stop.bind(outTrack);
    outTrack.stop = () => {
      origStop();
      realAudio.forEach((t) => t.stop());
      try {
        source.disconnect();
        roomGain.disconnect(outDest);
      } catch (_) {
        /* already torn down */
      }
      micLive = false;
      renderStatus();
      log("mic tap stopped");
    };
    outTrack.applyConstraints = () => Promise.resolve();

    const out = new MediaStream();
    out.addTrack(outTrack);
    realStream.getVideoTracks().forEach((t) => out.addTrack(t));
    renderStatus();
    log("mic tapped", realStream.id);
    return out;
  }

  {
    const md = navigator.mediaDevices;
    if (md && typeof md.getUserMedia === "function") {
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = async function (constraints) {
        const stream = await orig(constraints);
        if (!constraints || !constraints.audio) return stream;
        try {
          return tapStream(stream);
        } catch (err) {
          console.error("[whisper] mic tap failed, passing the real stream through", err);
          return stream;
        }
      };
      log("getUserMedia patched");
    }
  }

  // ---------------------------------------------------------------------------
  // Everyone else
  // ---------------------------------------------------------------------------

  /**
   * Remote track id -> { track, src, key }. `key` is the channel id: the
   * Gather player when known, so a person whose track is torn down and
   * re-consumed (walking in and out of range, mute, reconnect) stays one
   * speaker instead of becoming Guest 2, 3, 4...
   */
  const remotes = new Map();
  const guestLabels = new Map(); // channel key -> "Guest N", stable per key

  function keyFor(trackId) {
    const player = trackPlayer.get(trackId);
    return player ? "p:" + player : "t:" + trackId;
  }

  function defaultLabel(key) {
    const name = key.startsWith("p:") && nameFor(key.slice(2));
    if (name) return name;
    if (!guestLabels.has(key)) guestLabels.set(key, `Guest ${++guestCount}`);
    return guestLabels.get(key);
  }

  function dropChannelIfUnused(key) {
    if ([...remotes.values()].some((r) => r.key === key)) return;
    const ch = channels.get(key);
    if (ch && ch.kind === "remote") {
      ch.destroy();
      channels.delete(key);
    }
  }

  function routeRemote(trackId) {
    const r = remotes.get(trackId);
    if (!r) return;
    try {
      r.src.disconnect();
    } catch (_) {
      /* not connected yet */
    }
    if (settings.mode === "me-them") {
      r.src.connect(getChannel("them", "Them", "them").input);
    } else {
      r.src.connect(getChannel(r.key, defaultLabel(r.key), "remote").input);
    }
  }

  // A name or a track->player link arrived: move tracks onto their player's
  // channel and put real names on channels nobody has renamed by hand.
  function relabelRemotes() {
    for (const [trackId, r] of remotes) {
      const key = keyFor(trackId);
      if (key === r.key) continue;
      const old = r.key;
      r.key = key;
      routeRemote(trackId);
      dropChannelIfUnused(old);
    }
    for (const ch of channels.values()) {
      if (ch.kind !== "remote" || ch.renamed || !ch.id.startsWith("p:")) continue;
      const name = nameFor(ch.id.slice(2));
      if (name) ch.label = name;
    }
    renderSpeakers();
  }

  // Gather doesn't always end a track it stops consuming; sweep dead ones.
  setInterval(() => {
    let changed = false;
    for (const [trackId, r] of remotes) {
      if (r.track.readyState !== "ended") continue;
      detachRemote(trackId);
      changed = true;
    }
    if (changed) {
      renderSpeakers();
      renderStatus();
    }
  }, 5000);

  function detachRemote(trackId) {
    const r = remotes.get(trackId);
    if (!r) return;
    try {
      r.src.disconnect();
    } catch (_) {
      /* already disconnected */
    }
    remotes.delete(trackId);
    dropChannelIfUnused(r.key);
  }

  function applyMode() {
    // Finish whatever is mid-utterance, then rebuild the remote channels.
    for (const [id, ch] of channels) {
      if (ch.kind === "me") continue;
      ch.destroy();
      channels.delete(id);
    }
    for (const id of remotes.keys()) routeRemote(id);
    renderSpeakers();
  }

  function attachRemote(track) {
    if (remotes.has(track.id)) return;
    ensureGraph();
    const key = keyFor(track.id);
    remotes.set(track.id, { track, src: ctx.createMediaStreamSource(new MediaStream([track])), key });
    routeRemote(track.id);
    log("remote track", track.id, "->", key, (channels.get(key) || {}).label || "");
    renderStatus();
    track.addEventListener("ended", () => {
      detachRemote(track.id);
      renderSpeakers();
      renderStatus();
    });
  }

  {
    const Orig = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (Orig) {
      function Patched(...args) {
        const pc = new Orig(...args);
        pc.addEventListener("track", (ev) => {
          if (ev.track && ev.track.kind === "audio") attachRemote(ev.track);
        });
        return pc;
      }
      Patched.prototype = Orig.prototype;
      Object.setPrototypeOf(Patched, Orig);
      window.RTCPeerConnection = Patched;
      if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Patched;
      log("RTCPeerConnection patched");
    }
  }

  // ---------------------------------------------------------------------------
  // Who is who: Gather player names for remote tracks
  // ---------------------------------------------------------------------------
  //
  // A remote track carries no identity, but two of Gather's sockets do, and
  // both are readable from a WebSocket patch:
  //
  //   SFU (socket.io JSON)   42N["consume",{zodData:{srcId:<player>}}]
  //                          43N[{id:<consumer id>, ...}]       <- ack N
  //     mediasoup uses the consumer id as the remote track's id, so this
  //     gives track id -> player id. The player id is a UserAccount id.
  //
  //   game (msgpack binary)  {patches:[{op, model:"SpaceUser",
  //                                     data:{name, userAccountId}}]}
  //                          {patches:[{model:"UserAccount",
  //                                     data:{id, externalUserDisplayName}}]}
  //     gives player id -> the name shown in the space.
  //
  // Read from Gather 2.0 (app.v2.gather.town) traffic. If Gather changes
  // either format the maps stay empty and speakers fall back to "Guest N".

  /** consumer (= remote track) id -> player id */
  const trackPlayer = new Map();
  /** player (UserAccount) id -> in-space name */
  const playerName = new Map();
  /** player id -> account display name (fallback when no SpaceUser name) */
  const accountName = new Map();
  const pendingConsume = new Map(); // socket.io ack id -> player id

  function nameFor(playerId) {
    const space = playerName.get(playerId);
    // Gather shows "Anonymous" for members who never set a space name.
    if (space && space !== "Anonymous") return space;
    return accountName.get(playerId) || space || null;
  }

  // Just enough msgpack to read Gather's patches. Ext types (Gather's dates
  // and nulls) decode to null; we only need strings.
  function unpack(buf) {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const td = new TextDecoder();
    let p = 0;
    const str = (n) => td.decode(buf.subarray(p, (p += n)));
    const arr = (n) => {
      const a = new Array(n);
      for (let i = 0; i < n; i++) a[i] = read();
      return a;
    };
    const map = (n) => {
      const o = {};
      for (let i = 0; i < n; i++) {
        const k = read();
        o[k] = read();
      }
      return o;
    };
    const ext = (n) => ((p += 1 + n), null);
    function read() {
      const b = buf[p++];
      if (b <= 0x7f) return b;
      if (b <= 0x8f) return map(b & 0x0f);
      if (b <= 0x9f) return arr(b & 0x0f);
      if (b <= 0xbf) return str(b & 0x1f);
      if (b >= 0xe0) return b - 0x100;
      let r;
      switch (b) {
        case 0xc0: return null;
        case 0xc2: return false;
        case 0xc3: return true;
        case 0xc4: return (r = buf[p]), (p += 1 + r), null;
        case 0xc5: return (r = v.getUint16(p)), (p += 2 + r), null;
        case 0xc6: return (r = v.getUint32(p)), (p += 4 + r), null;
        case 0xc7: return (r = buf[p]), (p += 1), ext(r);
        case 0xc8: return (r = v.getUint16(p)), (p += 2), ext(r);
        case 0xc9: return (r = v.getUint32(p)), (p += 4), ext(r);
        case 0xca: return (r = v.getFloat32(p)), (p += 4), r;
        case 0xcb: return (r = v.getFloat64(p)), (p += 8), r;
        case 0xcc: return buf[p++];
        case 0xcd: return (r = v.getUint16(p)), (p += 2), r;
        case 0xce: return (r = v.getUint32(p)), (p += 4), r;
        case 0xcf: return (r = Number(v.getBigUint64(p))), (p += 8), r;
        case 0xd0: return (r = v.getInt8(p)), (p += 1), r;
        case 0xd1: return (r = v.getInt16(p)), (p += 2), r;
        case 0xd2: return (r = v.getInt32(p)), (p += 4), r;
        case 0xd3: return (r = Number(v.getBigInt64(p))), (p += 8), r;
        case 0xd4: return ext(1);
        case 0xd5: return ext(2);
        case 0xd6: return ext(4);
        case 0xd7: return ext(8);
        case 0xd8: return ext(16);
        case 0xd9: return (r = buf[p++]), str(r);
        case 0xda: return (r = v.getUint16(p)), (p += 2), str(r);
        case 0xdb: return (r = v.getUint32(p)), (p += 4), str(r);
        case 0xdc: return (r = v.getUint16(p)), (p += 2), arr(r);
        case 0xdd: return (r = v.getUint32(p)), (p += 4), arr(r);
        case 0xde: return (r = v.getUint16(p)), (p += 2), map(r);
        case 0xdf: return (r = v.getUint32(p)), (p += 4), map(r);
        default: throw new Error("msgpack: bad byte 0x" + b.toString(16));
      }
    }
    return read();
  }

  // Most game frames are movement; only decode ones that mention a model we read.
  const NEEDLES = ["SpaceUser", "UserAccount"].map((s) => new TextEncoder().encode(s));
  function mentions(buf) {
    for (const n of NEEDLES) {
      for (let i = buf.indexOf(n[0]); i !== -1 && i <= buf.length - n.length; i = buf.indexOf(n[0], i + 1)) {
        let j = 1;
        while (j < n.length && buf[i + j] === n[j]) j++;
        if (j === n.length) return true;
      }
    }
    return false;
  }

  function onGameFrame(buf) {
    if (!mentions(buf)) return;
    let msg;
    try {
      msg = unpack(buf);
    } catch (_) {
      return; // not msgpack, or a format we don't know
    }
    let changed = false;
    for (const list of [msg && msg.patches, msg && msg.fullStatePatches]) {
      if (!Array.isArray(list)) continue;
      for (const patch of list) {
        const d = patch && patch.data;
        if (!d) continue;
        if (patch.model === "SpaceUser" && typeof d.name === "string" && d.name && d.userAccountId) {
          changed = playerName.get(d.userAccountId) !== d.name || changed;
          playerName.set(d.userAccountId, d.name);
        } else if (patch.model === "UserAccount" && d.id && typeof d.externalUserDisplayName === "string" && d.externalUserDisplayName) {
          changed = accountName.get(d.id) !== d.externalUserDisplayName || changed;
          accountName.set(d.id, d.externalUserDisplayName);
        }
      }
    }
    if (changed) relabelRemotes();
  }

  // socket.io v4 over engine.io: "42" event, "43" ack, optional "/nsp," and ack id.
  const SIO = /^4([23])(?:\/[^,]*,)?(\d*)(\[[\s\S]*)$/;

  function onSfuSent(text) {
    const m = SIO.exec(text);
    if (!m || m[1] !== "2" || !m[2] || !m[3].startsWith('["consume"')) return;
    try {
      const [, payload] = JSON.parse(m[3]);
      const data = (payload && payload.zodData) || payload;
      if (data && data.srcId) pendingConsume.set(m[2], data.srcId);
    } catch (_) {
      /* not ours */
    }
  }

  function onSfuReceived(text) {
    const m = SIO.exec(text);
    if (!m || m[1] !== "3" || !pendingConsume.has(m[2])) return;
    const player = pendingConsume.get(m[2]);
    pendingConsume.delete(m[2]);
    try {
      const [res] = JSON.parse(m[3]);
      if (res && res.id && (!res.kind || res.kind === "audio")) {
        trackPlayer.set(res.id, player);
        if (remotes.has(res.id)) relabelRemotes();
      }
    } catch (_) {
      /* not ours */
    }
  }

  {
    const OrigWS = window.WebSocket;
    if (OrigWS) {
      const toBytes = (data) =>
        data instanceof ArrayBuffer ? Promise.resolve(new Uint8Array(data))
          : ArrayBuffer.isView(data) ? Promise.resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
            : data instanceof Blob ? data.arrayBuffer().then((b) => new Uint8Array(b))
              : null;
      function PatchedWS(...args) {
        const ws = new OrigWS(...args);
        ws.addEventListener("message", (ev) => {
          try {
            if (typeof ev.data === "string") onSfuReceived(ev.data);
            else {
              const p = toBytes(ev.data);
              if (p) p.then(onGameFrame).catch(() => {});
            }
          } catch (_) {
            /* never break Gather's socket */
          }
        });
        const send = ws.send;
        ws.send = function (data) {
          try {
            if (typeof data === "string") onSfuSent(data);
          } catch (_) {
            /* never break Gather's socket */
          }
          return send.apply(this, arguments);
        };
        return ws;
      }
      PatchedWS.prototype = OrigWS.prototype;
      Object.setPrototypeOf(PatchedWS, OrigWS);
      window.WebSocket = PatchedWS;
      log("WebSocket patched (speaker names)");
    }
  }

  // ---------------------------------------------------------------------------
  // Whisper worker
  // ---------------------------------------------------------------------------

  const WORKER_SRC = `
    let asr = null, english = true;
    const send = (m) => postMessage(m);

    async function pickBackend() {
      try {
        const ad = self.navigator.gpu && await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        if (ad && !ad.info?.isFallbackAdapter) {
          return { device: "webgpu", f16: ad.features.has("shader-f16"),
                   adapter: [ad.info?.vendor, ad.info?.architecture].filter(Boolean).join(" ") || "gpu" };
        }
        if (ad) return { device: "wasm", adapter: "software GPU ignored" };
      } catch (_) {}
      return { device: "wasm", adapter: "no WebGPU" };
    }

    async function init({ tjsUrl, model }) {
      const be = await pickBackend();
      if (model === "auto") model = be.device === "webgpu" ? "onnx-community/whisper-small.en" : "onnx-community/whisper-tiny.en";
      english = model.endsWith(".en");
      let dtype;
      if (be.device === "wasm") dtype = "q8";
      else if (model.includes("large")) dtype = { encoder_model: be.f16 ? "fp16" : "fp32", decoder_model_merged: "q4" };
      else dtype = be.f16 ? "fp16" : "fp32";
      send({ type: "backend", ...be, model, dtype: JSON.stringify(dtype) });

      const src = await (await fetch(tjsUrl)).text();
      const { pipeline, env } = await import(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
      env.allowLocalModels = false;
      asr = await pipeline("automatic-speech-recognition", model, {
        device: be.device, dtype,
        progress_callback: (p) => { if (p.status === "progress") send({ type: "progress", file: p.file, loaded: p.loaded, total: p.total }); },
      });
      // First run compiles shaders; do it now rather than on someone's first words.
      await asr(new Float32Array(16000));
      send({ type: "ready" });
    }

    self.onmessage = async ({ data }) => {
      if (data.type === "init") {
        try { await init(data); } catch (e) { send({ type: "error", error: String(e && e.message || e) }); }
        return;
      }
      if (data.type === "transcribe") {
        try {
          const t0 = performance.now();
          const out = await asr(data.audio, english ? {} : { language: "english", task: "transcribe" });
          send({ type: "result", id: data.id, text: out.text || "", ms: Math.round(performance.now() - t0) });
        } catch (e) {
          send({ type: "result", id: data.id, text: null, error: String(e && e.message || e) });
        }
      }
    };
    send({ type: "booted" });
  `;

  let worker = null;
  let workerState = "off"; // off | loading | ready | error
  let backend = null;
  let loadError = "";
  const progress = new Map(); // file -> {loaded,total}
  const pending = new Map(); // request id -> resolve
  let nextId = 1;
  let lastMs = 0;

  function startWorker() {
    stopWorker();
    workerState = "loading";
    loadError = "";
    backend = null;
    progress.clear();
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
    worker = new Worker(url, { type: "module" });
    worker.onmessage = ({ data }) => {
      switch (data.type) {
        case "booted":
          worker.postMessage({ type: "init", tjsUrl: TJS_URL, model: settings.model });
          break;
        case "backend":
          backend = data;
          log("backend", data);
          break;
        case "progress":
          progress.set(data.file, { loaded: data.loaded, total: data.total });
          break;
        case "ready":
          workerState = "ready";
          log("model ready");
          break;
        case "error":
          workerState = "error";
          loadError = data.error;
          console.error("[whisper] model load failed:", data.error);
          break;
        case "result": {
          const resolve = pending.get(data.id);
          pending.delete(data.id);
          if (data.ms) lastMs = data.ms;
          if (data.error) console.warn("[whisper] transcribe failed:", data.error);
          if (resolve) resolve(data.text);
          break;
        }
      }
      renderStatus();
    };
    worker.onerror = (e) => {
      workerState = "error";
      loadError = e.message || "worker crashed";
      renderStatus();
    };
    renderStatus();
  }

  function stopWorker() {
    if (worker) worker.terminate();
    worker = null;
    workerState = "off";
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
  }

  /** Resolves to text, or null when the model isn't ready / the request failed. */
  function transcribe(audio, final) {
    if (workerState !== "ready") return Promise.resolve(null);
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      worker.postMessage({ type: "transcribe", id, audio, final }, [audio.buffer]);
    });
  }

  // ---------------------------------------------------------------------------
  // Text: captions, transcript, keyword rules
  // ---------------------------------------------------------------------------

  // Whisper's favourite things to "hear" in noise.
  const HALLUCINATION = /^\s*(\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|you\.?|thank you\.?|thanks for watching[.!]?|bye\.?|\.+|-+)\s*$/i;

  /** @type {{at: Date, who: string, text: string}[]} */
  const transcript = [];

  function clean(text) {
    const t = (text || "").replace(/\s+/g, " ").trim();
    return HALLUCINATION.test(t) ? "" : t;
  }

  function norm(s) {
    return " " + s.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim() + " ";
  }

  // ---- local log server ----
  // One file per page load. The room is the last path segment of the Gather
  // URL (/app/<space id>/<room name>).
  const ROOM = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "room");
  const SESSION = (() => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${ROOM}`;
  })();
  const logQueue = [];
  let logState = "unknown"; // unknown | on | offline
  let flushing = false;

  async function flushLog() {
    if (flushing || !logQueue.length) return;
    flushing = true;
    const batch = logQueue.slice(0, 200);
    try {
      const r = await fetch(LOG_SERVER + "/transcript", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: SESSION, room: ROOM, lines: batch }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      logQueue.splice(0, batch.length);
      logState = "on";
    } catch (_) {
      logState = "offline"; // keep the lines; retried below
    }
    flushing = false;
    renderStatus();
    if (logState === "on" && logQueue.length) flushLog();
  }

  setInterval(flushLog, 10000);

  function logLine(entry) {
    if (!settings.logToDisk) return;
    logQueue.push({ time: fmtTime(entry.at), who: entry.who, text: entry.text });
    if (logQueue.length > 5000) logQueue.splice(0, logQueue.length - 5000);
    flushLog();
  }

  function onText(ch, raw, final, segId, at) {
    const text = clean(raw);
    if (final) {
      ch.partial = "";
      if (text) {
        const entry = { at: at || new Date(), who: ch.label, text };
        transcript.push(entry);
        logLine(entry);
        renderTranscript();
      }
    } else {
      ch.partial = text;
    }
    if (text) checkRules(ch, text, segId);
    renderCaptions();
  }

  // Fuzzy matching, for Whisper's near-misses ("profanaty", "you're" for
  // "your", "sun flower" for "sunflower"). Spaces are dropped before comparing
  // so split and merged words cost nothing; windows one word shorter and
  // longer than the phrase catch the same thing at the word level.
  const FUZZY_MIN_SIM = 0.8; // ~1 wrong letter per 5
  const FUZZY_MIN_CHARS = 6; // shorter phrases match exactly: "money" ≠ "honey"

  function levenshtein(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  /** The words in `hay` (already norm()ed) that match `phrase`, or null. */
  function fuzzyFind(hay, phrase) {
    const p = norm(phrase).trim().split(" ");
    const target = p.join("").replace(/'/g, "");
    if (target.length < FUZZY_MIN_CHARS) return hay.includes(norm(phrase)) ? phrase : null;
    const words = hay.trim().split(" ");
    const slack = Math.floor(target.length * (1 - FUZZY_MIN_SIM));
    for (let n = Math.max(1, p.length - 1); n <= p.length + 1; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const cand = words.slice(i, i + n).join("").replace(/'/g, "");
        if (Math.abs(cand.length - target.length) > slack) continue;
        if (1 - levenshtein(cand, target) / Math.max(cand.length, target.length) >= FUZZY_MIN_SIM) return words.slice(i, i + n).join(" ");
      }
    }
    return null;
  }

  const lastFire = new Map(); // rule id -> timestamp
  const RULE_COOLDOWN_MS = 4000;

  function checkRules(ch, text, segId) {
    const hay = norm(text);
    for (const rule of settings.rules) {
      if (!rule.phrase) continue;
      if (rule.who !== "anyone" && ch.kind === "me") continue;
      if (ch.segId === segId && ch.fired.has(rule.id)) continue;
      const heard = rule.match === "fuzzy" ? fuzzyFind(hay, rule.phrase) : hay.includes(norm(rule.phrase)) && rule.phrase;
      if (!heard) continue;
      if (Date.now() - (lastFire.get(rule.id) || 0) < RULE_COOLDOWN_MS) continue;
      if (ch.segId === segId) ch.fired.add(rule.id);
      lastFire.set(rule.id, Date.now());
      log(`rule "${rule.phrase}" fired on ${ch.label}${heard !== rule.phrase ? ` (heard "${heard}")` : ""} -> ${rule.sound} (${rule.dest})`);
      playSound(rule.sound, rule.dest).catch((e) => console.warn("[whisper] sound failed", e));
      flashRule(rule.id);
    }
  }

  // ---------------------------------------------------------------------------
  // Sounds
  // ---------------------------------------------------------------------------

  const BUILTIN = {
    "builtin:ding": "Ding (built-in)",
    "builtin:beep": "Double beep (built-in)",
  };
  /** @type {{id:string,label:string,url:string}[]} */
  let library = [];
  let groupOrder = [];
  let groupTitles = {};
  const buffers = new Map();

  fetch(MANIFEST_URL, { cache: "no-cache" })
    .then((r) => r.json())
    .then((m) => {
      library = (m.sounds || []).map((s) => ({ id: s.id, label: s.label.replace(/\s*\(\d+k\)$/, ""), url: SOUND_BASE + s.file, group: s.group || "" }));
      library.sort((a, b) => a.label.localeCompare(b.label));
      // Default-list groups (core) first, search-only ones (sfx, trump) after.
      const groups = m.groups || {};
      groupOrder = Object.keys(groups).sort((a, b) => !!groups[a].searchOnly - !!groups[b].searchOnly);
      groupTitles = Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, g.title || k]));
      log(`sound library: ${library.length} clips`);
      renderRules();
    })
    .catch((e) => log("sound manifest unavailable:", e.message, "(built-in sounds still work)"));

  function synth(kind) {
    const dur = kind === "builtin:beep" ? 0.36 : 0.7;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / ctx.sampleRate;
      if (kind === "builtin:beep") {
        const on = t < 0.14 || (t > 0.2 && t < 0.34);
        d[i] = on ? 0.25 * Math.sin(2 * Math.PI * 1000 * t) : 0;
      } else {
        d[i] = 0.35 * Math.exp(-5 * t) * (Math.sin(2 * Math.PI * 880 * t) + 0.4 * Math.sin(2 * Math.PI * 1760 * t));
      }
    }
    return buf;
  }

  async function getBuffer(soundId) {
    if (buffers.has(soundId)) return buffers.get(soundId);
    let buf;
    if (soundId.startsWith("builtin:")) {
      buf = synth(soundId);
    } else {
      const s = library.find((x) => x.id === soundId);
      if (!s) throw new Error(`unknown sound ${soundId}`);
      const bytes = await (await fetch(s.url, { cache: "force-cache" })).arrayBuffer();
      buf = await ctx.decodeAudioData(bytes);
    }
    buffers.set(soundId, buf);
    return buf;
  }

  async function playSound(soundId, dest) {
    ensureGraph();
    if (ctx.state === "suspended") await ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = await getBuffer(soundId);
    if (dest === "room") {
      if (!micLive) log("room sound with no mic tap yet -- only you will hear it");
      src.connect(roomGain);
      const monitor = ctx.createGain();
      monitor.gain.value = MONITOR_GAIN;
      src.connect(monitor);
      monitor.connect(ctx.destination);
      src.onended = () => monitor.disconnect();
    } else {
      src.connect(ctx.destination);
    }
    src.start();
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  const CSS = `
    :host { all: initial; }
    .toolbtn {
      all: unset; box-sizing: border-box; cursor: pointer;
      display: none; width: 36px; height: 36px;
      align-items: center; justify-content: center;
      border-radius: 8px; font-size: 18px; line-height: 1;
    }
    .toolbtn:hover { background: rgba(255,255,255,0.12); }
    .toolbtn.active { background: rgba(167,139,250,0.45); }
    .wrap.docked .toolbtn { display: flex; }
    .wrap.docked .panel { display: none; }
    .wrap.docked .panel.open { display: block; }
    .wrap.docked .head { cursor: default; }

    .panel {
      position: fixed; z-index: 2147483646;
      font: 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #f1eefb; background: rgba(22, 18, 36, 0.95);
      border: 1px solid rgba(167, 139, 250, 0.35);
      border-radius: 12px; box-shadow: 0 10px 32px rgba(0,0,0,0.45);
      width: 380px; max-height: 70vh; display: flex; flex-direction: column;
      backdrop-filter: blur(8px);
    }
    .wrap.docked .panel.open { display: flex; }
    .wrap.docked .panel:not(.open) { display: none; }
    .head {
      display: flex; align-items: center; gap: 7px; padding: 7px 9px; cursor: grab;
      background: rgba(167, 139, 250, 0.12); border-bottom: 1px solid rgba(167, 139, 250, 0.22);
      border-radius: 12px 12px 0 0; user-select: none;
    }
    .title { flex: 1; font-weight: 600; }
    .live { display: flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 700; letter-spacing: .5px; color: #64748b; }
    .live .bulb { width: 8px; height: 8px; border-radius: 50%; background: #475569; }
    .live.on { color: #c4b5fd; }
    .live.on .bulb { background: #a78bfa; box-shadow: 0 0 7px #a78bfa; animation: pulse 1.6s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
    .body { padding: 9px; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
    .status { font-size: 11px; color: #a89cc4; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .status b { color: #f1eefb; font-weight: 600; }
    .status .err { color: #f87171; }
    .bar { height: 4px; border-radius: 2px; background: rgba(255,255,255,0.1); overflow: hidden; }
    .bar > div { height: 100%; background: #a78bfa; width: 0; transition: width .2s; }
    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
    select, input[type=text] {
      font: inherit; font-size: 12px; color: #f1eefb; background: rgba(0,0,0,0.35);
      border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 3px 6px;
    }
    input[type=text] { flex: 1; min-width: 0; }
    .check { display: flex; align-items: center; gap: 5px; cursor: pointer; }
    .check input { accent-color: #a78bfa; margin: 0; }
    .txtbtn {
      all: unset; cursor: pointer; font-size: 11px; color: #c9bfe0;
      padding: 4px 7px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.14);
    }
    .txtbtn:hover { color: #fff; background: rgba(255,255,255,0.1); }
    h4 { margin: 4px 0 0; font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: #8b7fa8; }
    .speakers { display: flex; flex-wrap: wrap; gap: 6px; }
    .speakers input { flex: 0 1 110px; }
    .speakers .talk { outline: 2px solid #a78bfa; }
    .log {
      flex: 0 0 auto; min-height: 140px; max-height: 220px; overflow: auto; background: rgba(0,0,0,0.3); border-radius: 8px;
      padding: 6px 8px; font-size: 12px; line-height: 1.45; user-select: text;
    }
    .log .t { color: #7d7196; font-family: ui-monospace, monospace; font-size: 10px; }
    .log .w { color: #c4b5fd; font-weight: 600; }
    .log .empty { color: #7d7196; font-style: italic; }
    .rules { display: flex; flex-direction: column; gap: 4px; }
    .rule { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 3px 5px; border-radius: 6px; background: rgba(255,255,255,0.04); }
    .rule .p { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rule .m { color: #a89cc4; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 170px; }
    .rule.fired { background: rgba(167,139,250,0.5); transition: background 0s; }
    .rule { transition: background 1.2s; }
    .rule.editing { outline: 1px solid #a78bfa; }
    .names { display: flex; flex-wrap: wrap; gap: 4px; }
    .chip { font-size: 11px; color: #c9bfe0; padding: 1px 2px 1px 7px; border-radius: 10px; background: rgba(255,255,255,0.06); }
    .x { all: unset; cursor: pointer; color: #8b7fa8; padding: 0 4px; }
    .x:hover { color: #f87171; }
    .add input[type=text] { flex: 1 0 100%; }
    .add select { flex: 1 1 0; min-width: 0; }
    .hint { font-size: 11px; color: #7d7196; }
  `;

  const CAPTION_CSS = `
    :host { all: initial; }
    .cap {
      position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%);
      z-index: 2147483645; pointer-events: none; max-width: min(900px, 90vw);
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      font: 600 18px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .line {
      background: rgba(10, 8, 18, 0.82); color: #fff; padding: 4px 12px; border-radius: 8px;
      text-shadow: 0 1px 2px #000; max-width: 100%;
    }
    .line .who { color: #c4b5fd; margin-right: 6px; }
    .line.partial .txt { color: #ddd6f3; font-style: italic; }
  `;

  let host = null, wrap = null, toolBtn = null, panel = null, mode = null;
  let statusEl = null, barEl = null, liveEl = null, speakersEl = null, namesEl = null, logEl = null, rulesEl = null;
  let capRoot = null;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmtTime(d) {
    return d.toTimeString().slice(0, 8);
  }

  function renderStatus() {
    if (!statusEl) return;
    liveEl.className = "live" + (settings.enabled && (micLive || remotes.size) ? " on" : "");
    liveEl.lastChild.textContent = settings.enabled ? (micLive || remotes.size ? "TRANSCRIBING" : "WAITING") : "OFF";

    let total = 0, loaded = 0;
    for (const p of progress.values()) {
      if (p.total) {
        total += p.total;
        loaded += p.loaded || 0;
      }
    }
    const pct = total ? Math.round((loaded / total) * 100) : 0;
    barEl.style.width = workerState === "ready" ? "100%" : pct + "%";
    barEl.parentElement.style.display = workerState === "loading" ? "block" : "none";

    const be = backend ? `${backend.device}${backend.adapter ? " · " + backend.adapter : ""}` : "detecting…";
    const model = backend ? backend.model.split("/").pop() : "";
    statusEl.innerHTML = "";
    const line1 = el("div");
    line1.innerHTML = `<b>${be}</b>${model ? " · " + model : ""}`;
    const line2 = el("div");
    if (workerState === "error") {
      line2.className = "err";
      line2.textContent = "load failed: " + loadError;
    } else if (workerState === "loading") {
      line2.textContent = total ? `loading model ${pct}% (${(loaded / 1e6) | 0}/${(total / 1e6) | 0} MB)` : "loading model…";
    } else if (workerState === "ready") {
      const people = new Set([...remotes.values()].map((r) => r.key)).size;
      const who = [micLive ? "mic" : null, people ? `${people} remote` : null].filter(Boolean).join(" + ") || "no audio yet — reload if Gather was already live";
      line2.textContent = `ready · ${who}${lastMs ? ` · last ${lastMs} ms` : ""}`;
    } else {
      line2.textContent = "off";
    }
    const line3 = el("div");
    line3.textContent = !settings.logToDisk
      ? "log: off"
      : logState === "on"
        ? `log: logs/${SESSION}.md`
        : logState === "offline"
          ? `log: server not running (${logQueue.length} queued) — node tools/transcript-log-server.mjs`
          : "log: waiting for first line";
    statusEl.append(line1, line2, line3);
  }

  function renderSpeakers() {
    if (!speakersEl) return;
    speakersEl.innerHTML = "";
    for (const ch of channels.values()) {
      const input = el("input");
      input.type = "text";
      input.value = ch.label;
      input.title = ch.kind === "remote" ? "Rename this speaker; names you use are saved for next time" : ch.label;
      input.disabled = ch.kind !== "remote";
      input.setAttribute("list", "gw-names");
      if (ch.speaking) input.classList.add("talk");
      input.addEventListener("change", () => {
        ch.label = input.value.trim() || ch.label;
        ch.renamed = true; // keep it over the Gather name from here on
        if (!/^Guest \d+$/.test(ch.label)) rememberName(ch.label);
      });
      speakersEl.appendChild(input);
    }
    if (!channels.size) speakersEl.appendChild(el("span", "hint", "No audio yet."));
    renderNames();
  }

  function rememberName(name) {
    if (settings.names.includes(name)) return;
    settings.names.push(name);
    settings.names.sort((a, b) => a.localeCompare(b));
    saveUi({ names: settings.names });
    renderNames();
  }

  function renderNames() {
    if (!namesEl) return;
    const list = host.shadowRoot.getElementById("gw-names");
    list.innerHTML = "";
    namesEl.innerHTML = "";
    for (const name of settings.names) {
      list.appendChild(new Option(name));
      const chip = el("span", "chip", name);
      const x = el("button", "x", "✕");
      x.title = "Forget this name";
      x.addEventListener("click", () => {
        settings.names = settings.names.filter((n) => n !== name);
        saveUi({ names: settings.names });
        renderNames();
      });
      chip.appendChild(x);
      namesEl.appendChild(chip);
    }
    if (!settings.names.length) namesEl.appendChild(el("span", "hint", "Names you give speakers are saved here."));
  }

  function renderTranscript() {
    if (!logEl) return;
    const stick = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
    logEl.innerHTML = "";
    if (!transcript.length) logEl.appendChild(el("div", "empty", "Transcript appears here."));
    for (const e of transcript.slice(-300)) {
      const line = el("div");
      line.append(el("span", "t", fmtTime(e.at) + " "), el("span", "w", e.who + ": "), document.createTextNode(e.text));
      logEl.appendChild(line);
    }
    if (stick) logEl.scrollTop = logEl.scrollHeight;
  }

  const recent = []; // finished caption lines, briefly kept on screen
  function renderCaptions() {
    if (!capRoot) return;
    const box = capRoot.querySelector(".cap");
    box.innerHTML = "";
    if (!settings.enabled || !settings.captions) return;
    const now = Date.now();
    while (recent.length && now - recent[0].shown > 5000) recent.shift();
    const lines = [];
    const lastFinal = transcript[transcript.length - 1];
    if (lastFinal && (!recent.length || recent[recent.length - 1].entry !== lastFinal)) recent.push({ entry: lastFinal, shown: now });
    for (const r of recent.slice(-2)) lines.push({ who: r.entry.who, text: r.entry.text, partial: false });
    for (const ch of channels.values()) if (ch.partial) lines.push({ who: ch.label, text: ch.partial, partial: true });
    for (const l of lines.slice(-3)) {
      const d = el("div", "line" + (l.partial ? " partial" : ""));
      d.append(el("span", "who", l.who), el("span", "txt", l.text));
      box.appendChild(d);
    }
  }

  function flashRule(id) {
    if (!rulesEl) return;
    const row = rulesEl.querySelector(`[data-id="${id}"]`);
    if (!row) return;
    row.classList.add("fired");
    setTimeout(() => row.classList.remove("fired"), 60);
  }

  function soundLabel(id) {
    return BUILTIN[id] || (library.find((s) => s.id === id) || {}).label || id;
  }

  function soundOptions(select, selected) {
    select.innerHTML = "";
    for (const [id, label] of Object.entries(BUILTIN)) select.appendChild(new Option(label, id, false, id === selected));
    // One <optgroup> per manifest group, so the handful of Bundled clips sit
    // above the hundreds of search-only ones instead of being lost among them.
    const order = [...groupOrder, ...new Set(library.map((s) => s.group).filter((g) => !groupOrder.includes(g)))];
    for (const g of order) {
      const og = el("optgroup");
      og.label = groupTitles[g] || g || "Other";
      for (const s of library) if (s.group === g) og.appendChild(new Option(s.label, s.id, false, s.id === selected));
      if (og.children.length) select.appendChild(og);
    }
    // Manifest not loaded (yet): keep a rule's hosted sound selectable, or
    // editing it would quietly swap it for the first option.
    if (selected && select.value !== selected) select.appendChild(new Option(soundLabel(selected), selected, false, true));
  }

  function renderRules() {
    if (!rulesEl) return;
    rulesEl.innerHTML = "";
    for (const rule of settings.rules) {
      const row = el("div", "rule");
      row.dataset.id = rule.id;
      const test = el("button", "x", "▶");
      test.title = "Test this sound";
      test.addEventListener("click", () => playSound(rule.sound, rule.dest).catch((e) => console.warn(e)));
      const edit = el("button", "x", "✎");
      edit.title = "Edit rule";
      edit.addEventListener("click", () => editRule(rule.id));
      const del = el("button", "x", "✕");
      del.title = "Delete rule";
      del.addEventListener("click", () => {
        settings.rules = settings.rules.filter((r) => r !== rule);
        saveUi({ rules: settings.rules });
        if (editingId === rule.id) editRule(null);
        renderRules();
      });
      if (rule.id === editingId) row.classList.add("editing");
      row.append(
        el("span", "p", `${rule.match === "fuzzy" ? "~" : ""}"${rule.phrase}"`),
        el("span", "m", `${soundLabel(rule.sound)} → ${rule.dest === "room" ? "room" : "me"} · ${rule.who === "anyone" ? "anyone" : "others"}`),
        test,
        edit,
        del,
      );
      rulesEl.appendChild(row);
    }
    if (!settings.rules.length) rulesEl.appendChild(el("div", "hint", "No keyword rules yet."));
    const sel = host && host.shadowRoot.querySelector(".add .snd");
    if (sel) soundOptions(sel, sel.value || "builtin:ding");
  }

  // The add form doubles as the editor: editRule(id) loads that rule into it
  // and Save writes back in place, keeping the id (and so its cooldown).
  let editingId = null;
  let ruleForm = null; // { phrase, snd, dest, who, addBtn, cancel }

  function editRule(id) {
    const rule = id && settings.rules.find((r) => r.id === id);
    editingId = rule ? id : null;
    const f = ruleForm;
    if (rule) {
      f.phrase.value = rule.phrase;
      soundOptions(f.snd, rule.sound);
      f.dest.value = rule.dest;
      f.who.value = rule.who;
      f.match.value = rule.match === "fuzzy" ? "fuzzy" : "exact";
      f.phrase.focus();
    } else {
      f.phrase.value = "";
      f.match.value = "fuzzy";
    }
    f.addBtn.textContent = rule ? "Save" : "Add";
    f.cancel.style.display = rule ? "" : "none";
    renderRules();
  }

  function download() {
    const day = new Date().toISOString().slice(0, 10);
    const md = [`# Gather transcript ${day}`, ""]
      .concat(transcript.map((e) => `**[${fmtTime(e.at)}] ${e.who}:** ${e.text}  `))
      .join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([md + "\n"], { type: "text/markdown" }));
    a.download = `gather-transcript-${day}-${fmtTime(new Date()).replace(/:/g, "")}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function findDock() {
    const btn =
      document.querySelector('button[aria-label="Screen share" i]') ||
      document.querySelector('button[aria-label*="screen share" i]') ||
      document.querySelector('button[aria-label="Camera" i]') ||
      document.querySelector('button[aria-label="Microphone" i]');
    if (!btn) return null;
    let e = btn.parentElement;
    for (let i = 0; i < 6 && e; i++) {
      if (e.classList.contains("Layout") && e.children.length >= 2) return e;
      e = e.parentElement;
    }
    return null;
  }

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    wrap.className = "wrap " + next;
    if (next === "floating") {
      panel.classList.remove("open");
      toolBtn.classList.remove("active");
      const ui = loadUi();
      if (typeof ui.left === "number" && typeof ui.top === "number") {
        panel.style.left = Math.min(ui.left, window.innerWidth - 80) + "px";
        panel.style.top = Math.min(ui.top, window.innerHeight - 40) + "px";
        panel.style.right = panel.style.bottom = "auto";
      } else {
        panel.style.top = panel.style.left = "auto";
        panel.style.right = "18px";
        panel.style.bottom = "96px";
      }
    }
  }

  function positionPopover() {
    if (mode !== "docked" || !panel.classList.contains("open")) return;
    const r = toolBtn.getBoundingClientRect();
    panel.style.top = panel.style.right = "auto";
    panel.style.bottom = window.innerHeight - r.top + 10 + "px";
    panel.style.left = Math.min(Math.max(8, r.left + r.width / 2 - panel.offsetWidth / 2), window.innerWidth - panel.offsetWidth - 8) + "px";
  }

  function ensureMounted() {
    const dock = findDock();
    if (dock) {
      if (host.parentElement !== dock) dock.appendChild(host);
      setMode("docked");
    } else {
      if (host.parentElement !== document.body) document.body.appendChild(host);
      setMode("floating");
    }
    if (capRoot && capRoot.host.parentElement !== document.body) document.body.appendChild(capRoot.host);
  }

  function makeDraggable(target, handle) {
    let sx = 0, sy = 0, bl = 0, bt = 0, drag = false;
    handle.addEventListener("pointerdown", (e) => {
      if (mode === "docked" || e.target.closest("button")) return;
      drag = true;
      handle.setPointerCapture(e.pointerId);
      const r = target.getBoundingClientRect();
      bl = r.left; bt = r.top; sx = e.clientX; sy = e.clientY;
      e.preventDefault();
    });
    handle.addEventListener("pointermove", (e) => {
      if (!drag) return;
      target.style.left = Math.min(Math.max(0, bl + e.clientX - sx), window.innerWidth - target.offsetWidth) + "px";
      target.style.top = Math.min(Math.max(0, bt + e.clientY - sy), window.innerHeight - 40) + "px";
      target.style.right = target.style.bottom = "auto";
    });
    const end = () => {
      if (!drag) return;
      drag = false;
      const r = target.getBoundingClientRect();
      saveUi({ left: r.left, top: r.top });
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  function check(label, value, onChange) {
    const l = el("label", "check");
    const box = el("input");
    box.type = "checkbox";
    box.checked = value;
    box.addEventListener("change", () => onChange(box.checked));
    l.append(box, document.createTextNode(label));
    return l;
  }

  function mount() {
    if (document.getElementById("gather-whisper-root")) return;

    host = el("div");
    host.id = "gather-whisper-root";
    const root = host.attachShadow({ mode: "open" });
    root.appendChild(el("style", null, CSS));

    wrap = el("div", "wrap floating");
    toolBtn = el("button", "toolbtn", "\u{1F4AC}");
    toolBtn.type = "button";
    toolBtn.title = "Gather Whisper";
    toolBtn.setAttribute("aria-label", "Gather Whisper");
    toolBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !panel.classList.contains("open");
      panel.classList.toggle("open", open);
      toolBtn.classList.toggle("active", open);
      if (open) positionPopover();
    });

    panel = el("div", "panel");
    const head = el("div", "head");
    liveEl = el("div", "live");
    liveEl.append(el("span", "bulb"), document.createTextNode("OFF"));
    head.append(el("div", "title", "\u{1F4AC} Whisper"), liveEl);

    const body = el("div", "body");
    statusEl = el("div", "status");
    const bar = el("div", "bar");
    barEl = el("div");
    bar.appendChild(barEl);

    // Model + mode
    const modelSel = el("select");
    modelSel.appendChild(new Option("Auto (GPU: small.en, else tiny.en)", "auto", false, settings.model === "auto"));
    for (const m of MODELS) modelSel.appendChild(new Option(m.label, m.id, false, settings.model === m.id));
    modelSel.addEventListener("change", () => {
      settings.model = modelSel.value;
      saveUi({ model: settings.model });
      if (settings.enabled) startWorker();
    });
    const modeSel = el("select");
    modeSel.append(
      new Option("Per person", "per-person", false, settings.mode === "per-person"),
      new Option("Me vs Them", "me-them", false, settings.mode === "me-them"),
    );
    modeSel.title = "Per person transcribes each remote track separately; Me vs Them mixes everyone else into one (lighter)";
    modeSel.addEventListener("change", () => {
      settings.mode = modeSel.value;
      saveUi({ mode: settings.mode });
      applyMode();
    });
    const row1 = el("div", "row");
    row1.append(modelSel, modeSel);

    const row2 = el("div", "row");
    row2.append(
      check("on", settings.enabled, (v) => {
        settings.enabled = v;
        saveUi({ enabled: v });
        if (v) startWorker();
        else stopWorker();
        renderCaptions();
        renderStatus();
      }),
      check("transcribe me", settings.transcribeMe, (v) => {
        settings.transcribeMe = v;
        saveUi({ transcribeMe: v });
      }),
      check("captions", settings.captions, (v) => {
        settings.captions = v;
        saveUi({ captions: v });
        renderCaptions();
      }),
      check("save to logs/", settings.logToDisk, (v) => {
        settings.logToDisk = v;
        saveUi({ logToDisk: v });
        if (!v) logQueue.length = 0; // unticking drops anything not yet written
        logState = "unknown";
        renderStatus();
      }),
    );

    speakersEl = el("div", "speakers");
    namesEl = el("div", "names");
    const namesList = el("datalist");
    namesList.id = "gw-names";

    logEl = el("div", "log");
    const row3 = el("div", "row");
    const dl = el("button", "txtbtn", "Download .md");
    dl.addEventListener("click", download);
    const clr = el("button", "txtbtn", "Clear");
    clr.addEventListener("click", () => {
      transcript.length = 0;
      recent.length = 0;
      renderTranscript();
      renderCaptions();
    });
    row3.append(dl, clr);

    // Keyword rules
    rulesEl = el("div", "rules");
    const add = el("div", "row add");
    const phrase = el("input");
    phrase.type = "text";
    phrase.placeholder = "word or phrase";
    const snd = el("select", "snd");
    soundOptions(snd, "builtin:ding");
    const dest = el("select");
    dest.append(new Option("→ me", "me"), new Option("→ room", "room"));
    const who = el("select");
    who.append(new Option("others say it", "others"), new Option("anyone says it", "anyone"));
    // Rules saved before fuzzy existed have no `match` and stay exact.
    const match = el("select");
    match.append(new Option("fuzzy", "fuzzy"), new Option("exact", "exact"));
    match.title = "Fuzzy also fires on near-misses (~1 wrong letter in 5); phrases under 6 letters always match exactly";
    const addBtn = el("button", "txtbtn", "Add");
    const cancel = el("button", "txtbtn", "Cancel");
    cancel.style.display = "none";
    cancel.addEventListener("click", () => editRule(null));
    addBtn.addEventListener("click", () => {
      const p = phrase.value.trim();
      if (!p) return;
      const fields = { phrase: p, sound: snd.value, dest: dest.value, who: who.value, match: match.value };
      const existing = editingId && settings.rules.find((r) => r.id === editingId);
      if (existing) Object.assign(existing, fields);
      else settings.rules.push({ id: Math.random().toString(36).slice(2, 10), ...fields });
      saveUi({ rules: settings.rules });
      editRule(null);
    });
    phrase.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addBtn.click();
      else if (e.key === "Escape" && editingId) editRule(null);
    });
    add.append(phrase, snd, dest, who, match, addBtn, cancel);
    ruleForm = { phrase, snd, dest, who, match, addBtn, cancel };

    body.append(
      statusEl, bar, row1, row2,
      el("h4", null, "Speakers"), speakersEl, namesEl, namesList,
      el("h4", null, "Transcript"), logEl, row3,
      el("h4", null, "Keyword sounds"), rulesEl, add,
      el("div", "hint", "Runs Whisper in this tab; no audio leaves the page. Transcript is memory-only until downloaded."),
    );
    panel.append(head, body);
    wrap.append(toolBtn, panel);
    root.appendChild(wrap);
    document.body.appendChild(host);
    makeDraggable(panel, head);

    // Caption overlay, separate so it stays visible with the panel closed.
    const capHost = el("div");
    capHost.id = "gather-whisper-captions";
    capRoot = capHost.attachShadow({ mode: "open" });
    capRoot.append(el("style", null, CAPTION_CSS), el("div", "cap"));
    document.body.appendChild(capHost);

    document.addEventListener("click", (e) => {
      if (mode === "docked" && !host.contains(e.target)) {
        panel.classList.remove("open");
        toolBtn.classList.remove("active");
      }
    });
    window.addEventListener("resize", positionPopover);

    ensureMounted();
    setInterval(ensureMounted, 2000);
    setInterval(() => {
      renderCaptions();
      if (speakersEl) {
        // Cheap: only the "talking" outline changes between full renders.
        const inputs = speakersEl.querySelectorAll("input");
        [...channels.values()].forEach((ch, i) => inputs[i] && inputs[i].classList.toggle("talk", ch.speaking));
      }
    }, 250);

    renderStatus();
    renderSpeakers();
    renderTranscript();
    renderRules();
    if (settings.enabled) startWorker();
    log("panel mounted");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }

  // Console hooks for poking at it.
  window.gatherWhisper = { settings, channels, remotes, transcript, playSound, download, trackPlayer, playerName, accountName };
})();
