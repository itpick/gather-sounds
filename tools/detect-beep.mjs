#!/usr/bin/env node
/**
 * Finds where speech actually starts in each clip, and records it as startMs in
 * manifest.json so the userscript can seek past a leading beep.
 *
 *   node tools/detect-beep.mjs --dry-run        # report only
 *   node tools/detect-beep.mjs --group trump    # write startMs into manifest
 *
 * Why detection rather than a fixed offset: the source clips are not uniform.
 * A flat 2s skip was the first idea and it is unsurvivable -- 68 of the 666
 * trump clips are shorter than 2s outright and 198 are under 3s, so it would
 * delete a third of the library. made-money.ogg is typical of the ones that DO
 * have a beep:
 *
 *     0.00-0.32s  digital silence
 *     0.32-0.72s  a ~400 Hz tone (the beep)
 *     0.72-1.00s  silence
 *     1.00s ->    speech
 *
 * so its correct offset is ~1.0s, and a clip without a beep needs 0.
 *
 * How a beep is told apart from speech: zero-crossing rate. A pure tone has an
 * almost constant ZCR (made-money sits at ~800 Hz for the whole burst) while
 * speech swings widely frame to frame. So the first loud segment is classified
 * by the VARIANCE of its ZCR, not by its loudness or position.
 *
 * Nothing here rewrites audio. The files are untouched; only a manifest field
 * is added, which is reversible and costs no re-encode.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST = join(ROOT, "manifest.json");

const SR = 16000;
const FRAME = Math.floor(SR * 0.02); // 20 ms
const SILENCE_RMS = 200; // below this a frame counts as silence
// Tonality is measured with median-absolute-deviation, not standard deviation,
// and the run's first frames are skipped. A beep's attack transient spikes ZCR
// for ~1 frame (made-money jumps to 3150 Hz before settling at ~800), and a
// single outlier like that drags SD past any sane threshold -- an earlier
// version used SD and missed the very clip this was built for.
const ATTACK_FRAMES = 2; // ignore the onset transient when judging tonality

// Tonality is the median FRAME-TO-FRAME change in ZCR, not its spread about a
// mean. Some beeps are two-tone chimes: we-need-money holds ZCR at 1650 Hz then
// steps to 1100 Hz, and both halves are perfectly steady. Deviation-about-a-
// median sees that step as noise (MAD 250) and calls it speech, which is how
// that clip was missed. Consecutive-difference stays near zero through both
// halves and spikes only at the single transition, so it reads what matters:
// is the pitch HOLDING, wherever it happens to sit.
const TONE_ZCR_STEP = 150; // median |zcr[i]-zcr[i-1]| under this == tonal
const MIN_GAP_FRAMES = 3; // a beep is followed by a pause before content
const MAX_BEEP_S = 0.8; // a leading tone longer than this is probably content
const PREROLL_S = 0.04; // start a hair early so the first phoneme is intact

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const GROUP = argv.includes("--group") ? argv[argv.indexOf("--group") + 1] : "trump";

function ffmpegCmd() {
  for (const probe of [["ffmpeg"], ["nix", "run", "nixpkgs#ffmpeg", "--"]]) {
    try {
      execFileSync(probe[0], [...probe.slice(1), "-hide_banner", "-version"], {
        stdio: "ignore", timeout: 300_000,
      });
      return probe;
    } catch (_) { /* next */ }
  }
  throw new Error("no ffmpeg available");
}

function frames(ff, path) {
  const buf = execFileSync(ff[0], [
    ...ff.slice(1), "-v", "error", "-i", path,
    "-ar", String(SR), "-ac", "1", "-f", "s16le", "-",
  ], { maxBuffer: 1 << 28 });
  const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));

  const out = [];
  for (let s = 0; s + FRAME <= pcm.length; s += FRAME) {
    let sum = 0, zc = 0;
    for (let i = s; i < s + FRAME; i++) {
      sum += pcm[i] * pcm[i];
      if (i > s && (pcm[i - 1] < 0) !== (pcm[i] < 0)) zc++;
    }
    out.push({ rms: Math.sqrt(sum / FRAME), zcr: zc / (FRAME / SR) });
  }
  return { frames: out, duration: pcm.length / SR };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};


/**
 * Returns { startMs, reason }. startMs is 0 when no leading beep is found --
 * the common case, and the safe default.
 */
function analyse(fr) {
  const loud = (i) => fr[i] && fr[i].rms > SILENCE_RMS;

  let i = 0;
  while (i < fr.length && !loud(i)) i++;      // skip leading silence
  if (i >= fr.length) return { startMs: 0, reason: "silent" };

  let j = i;
  while (j < fr.length && loud(j)) j++;        // first loud run
  const runS = (j - i) * 0.02;

  // Too long to be a beep -> this run is already the content.
  if (runS > MAX_BEEP_S) return { startMs: 0, reason: "no beep (long onset)" };

  const body = fr.slice(i + ATTACK_FRAMES, j).map((f) => f.zcr);
  if (body.length < 3) return { startMs: 0, reason: "run too short to judge" };
  const steps = body.slice(1).map((z, n) => Math.abs(z - body[n]));
  const dev = median(steps);
  if (dev > TONE_ZCR_STEP) return { startMs: 0, reason: `no beep (zcr step ${dev | 0})` };

  // Tonal run confirmed. Speech is the next loud run after it.
  let k = j;
  while (k < fr.length && !loud(k)) k++;
  if (k >= fr.length) return { startMs: 0, reason: "beep but nothing after" };

  // A beep is followed by a pause. Requiring one guards against clipping the
  // front of a clip that simply opens on a held vowel or a sustained note --
  // those run straight into the rest of the audio with no gap.
  if (k - j < MIN_GAP_FRAMES) {
    return { startMs: 0, reason: `tonal but no gap after (${k - j} frames)` };
  }

  const startS = Math.max(0, k * 0.02 - PREROLL_S);
  return {
    startMs: Math.round(startS * 1000),
    reason: `beep ${(i * 0.02).toFixed(2)}-${(j * 0.02).toFixed(2)}s, zcr mad ${dev | 0}`,
  };
}

const ff = ffmpegCmd();
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const targets = manifest.sounds.filter((s) => s.group === GROUP);
console.log(`analysing ${targets.length} clips in "${GROUP}"\n`);

let withBeep = 0, failed = 0;
const found = [];
for (const s of targets) {
  let res;
  try {
    const { frames: fr, duration } = frames(ff, join(ROOT, s.file));
    res = analyse(fr);
    // Never seek so far in that little is left.
    if (res.startMs > 0 && res.startMs / 1000 > duration * 0.6) {
      res = { startMs: 0, reason: "offset would eat the clip" };
    }
  } catch (err) {
    failed++;
    continue;
  }
  if (res.startMs > 0) {
    withBeep++;
    found.push({ id: s.id, startMs: res.startMs, reason: res.reason });
    s.startMs = res.startMs;
  } else if (s.startMs) {
    delete s.startMs;
  }
}

found.sort((a, b) => b.startMs - a.startMs);
for (const f of found.slice(0, 25)) {
  console.log(`  ${String(f.startMs).padStart(5)}ms  ${f.id.slice(0, 44).padEnd(44)} ${f.reason}`);
}
if (found.length > 25) console.log(`  … and ${found.length - 25} more`);

console.log(`\nbeep detected: ${withBeep} of ${targets.length}` +
  (failed ? ` (${failed} failed to decode)` : ""));

if (found.length) {
  const offs = found.map((f) => f.startMs).sort((a, b) => a - b);
  const pct = (p) => offs[Math.min(offs.length - 1, Math.floor(offs.length * p))];
  console.log(
    `offset ms: min ${offs[0]}  p25 ${pct(0.25)}  median ${pct(0.5)}` +
    `  p75 ${pct(0.75)}  p95 ${pct(0.95)}  max ${offs[offs.length - 1]}`,
  );

  // What the offset costs: how much of each clip is left after seeking.
  const byId = new Map(targets.map((s) => [s.id, s]));
  const left = found
    .map((f) => {
      const ms = byId.get(f.id)?.ms;
      return ms ? { id: f.id, remain: ms - f.startMs } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.remain - b.remain);
  console.log(
    `remaining audio after seek: under 500ms on ${left.filter((x) => x.remain < 500).length}` +
    ` clips, under 1s on ${left.filter((x) => x.remain < 1000).length}`,
  );
  for (const x of left.slice(0, 5)) {
    console.log(`  tightest: ${x.remain}ms left  ${x.id.slice(0, 50)}`);
  }
}

if (DRY) {
  console.log("--dry-run: manifest not written.");
} else {
  const ser = (o) => JSON.stringify(o, null, 1)
    .replace(/[-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  writeFileSync(MANIFEST, ser(manifest), "utf8");
  console.log(`manifest.json updated with startMs on ${withBeep} entries.`);
}
