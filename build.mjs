#!/usr/bin/env node
/**
 * Builds gather-farts.user.js by embedding every audio file in sounds/ into
 * src/userscript.template.js as base64.
 *
 *   node build.mjs
 *
 * The button label is derived from the filename, so renaming wet-fart.mp3 to
 * thunder.mp3 renames the button. Files are embedded verbatim -- if the script
 * gets uncomfortably large, shrink the sources first:
 *
 *   nix run nixpkgs#ffmpeg -- -i in.mp3 -ac 1 -ar 48000 -b:a 64k out.mp3
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, extname, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SOUNDS_DIR = join(ROOT, "sounds");
const TEMPLATE = join(ROOT, "src", "userscript.template.js");
const OUTPUT = join(ROOT, "gather-farts.user.js");
const MARKER = "/*__SOUNDS__*/ []";

const MIME = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
};

function labelFor(file) {
  return basename(file, extname(file))
    // "z-" / "zz-" are sort-position prefixes, not part of the name. Files are
    // ordered by filename, so anything that should sit BELOW the existing
    // sounds needs a prefix that sorts after them -- digits sort BEFORE
    // letters, so a "99-" prefix would put it first, which is the opposite.
    //
    //   z-   new sounds, appended after the originals
    //   zz-  diagnostics, last of all
    .replace(/^zz?-/, "")
    .replace(/[-_]?\d{4,}$/, "") // drop stock-library id suffixes
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

const files = readdirSync(SOUNDS_DIR)
  .filter((f) => MIME[extname(f).toLowerCase()])
  .sort();

if (files.length === 0) {
  console.error(`No audio files found in ${SOUNDS_DIR}`);
  console.error(`Supported extensions: ${Object.keys(MIME).join(", ")}`);
  process.exit(1);
}

// Bitrate, shown in the button label so it is obvious which sounds are worth
// listening to. Everything here passes through Gather's ~32 kbps Opus hop, so
// a 128k source and a 24k source are NOT equivalent even though both "work" --
// the label is how you tell them apart without playing them.
//
// ffprobe is optional: if it is not on PATH the labels simply omit the rate
// rather than failing the build.
let probeWorks = true;
function kbpsFor(path) {
  if (!probeWorks) return null;
  try {
    const out = execFileSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "a:0",
       "-show_entries", "format=bit_rate", "-of", "default=nw=1:nk=1", path],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const bps = Number(out);
    if (!Number.isFinite(bps) || bps <= 0) return null;
    return Math.round(bps / 1000);
  } catch (_) {
    probeWorks = false; // no ffprobe -- stop trying, build without rates
    return null;
  }
}

const sounds = files.map((file) => {
  const path = join(SOUNDS_DIR, file);
  const bytes = readFileSync(path);
  const kbps = kbpsFor(path);
  return {
    // sortKey is the raw filename stem, INCLUDING any z-/zz- prefix. The
    // default button list is a merge of these embedded sounds and the hosted
    // ones, and sorting the merged list by this key is what puts them back in
    // the intended order -- originals, then additions, then diagnostics.
    sortKey: basename(file, extname(file)),
    id: basename(file, extname(file)),
    label: kbps ? `${labelFor(file)} (${kbps}k)` : labelFor(file),
    mime: MIME[extname(file).toLowerCase()],
    b64: bytes.toString("base64"),
    rawSize: statSync(path).size,
  };
});

const literal =
  "[\n" +
  sounds
    .map(
      (s) =>
        `    { id: ${JSON.stringify(s.id)}, label: ${JSON.stringify(s.label)}, ` +
        `mime: ${JSON.stringify(s.mime)}, b64: "${s.b64}" },`,
    )
    .join("\n") +
  "\n  ]";

const template = readFileSync(TEMPLATE, "utf8");
if (!template.includes(MARKER)) {
  console.error(`Template is missing the '${MARKER}' marker — cannot inject sounds.`);
  process.exit(1);
}

writeFileSync(OUTPUT, template.replace(MARKER, literal), "utf8");

const kb = (n) => (n / 1024).toFixed(1) + " KB";
for (const s of sounds) {
  console.log(`  ${s.label.padEnd(24)} ${kb(s.rawSize).padStart(10)} raw -> ${kb(s.b64.length)} base64`);
}
console.log(`\nWrote ${OUTPUT} (${kb(statSync(OUTPUT).size)}, ${sounds.length} sound(s))`);
