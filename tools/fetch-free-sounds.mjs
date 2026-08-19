#!/usr/bin/env node
/**
 * Fetches freely-licensed clips from Wikimedia Commons, encodes them to the
 * repo's Opus target, and prints manifest + CREDITS rows for them.
 *
 *   node tools/fetch-free-sounds.mjs --dry-run     # list candidates, download nothing
 *   node tools/fetch-free-sounds.mjs --limit 100   # fetch, encode, write into sfx/
 *
 * Why Commons and not a soundboard site: every file here carries machine-readable
 * licence metadata, so "is this redistributable" is a field we can filter on
 * rather than a guess. Anything that is not CC0 or public domain is dropped
 * before it is ever downloaded -- see KEEP_LICENCE.
 *
 * ffmpeg is not assumed to be installed. If it is missing from PATH the script
 * falls back to `nix run nixpkgs#ffmpeg --`, matching build.mjs.
 *
 * Two traps this guards against, both learned the hard way (see README):
 *
 *   - Rate limiting that returns 200. Requests are spaced by THROTTLE_MS and
 *     every output is hashed; identical hashes mean the source served you the
 *     same placeholder N times and the run is rejected.
 *   - Silent or truncated encodes. Any output under MIN_BYTES or whose measured
 *     duration is zero is discarded rather than committed.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, "sfx");
const GROUP = "sfx";

const API = "https://commons.wikimedia.org/w/api.php";
// Wikimedia asks for a descriptive UA with contact info; anonymous bulk hits
// from a generic agent get throttled or blocked outright.
const UA = "gather-sounds-curation/1.0 (https://github.com/itpick/gather-sounds)";

const THROTTLE_MS = 700; // README: ~0.7s between requests -- fine for the API
const DOWNLOAD_THROTTLE_MS = 2000; // upload.wikimedia.org needs much more room
const MIN_BYTES = 1024;
const MAX_SECONDS = 12; // a soundboard button is a sting, not a track

// Only these two. CC-BY would be usable with attribution, but mixing licence
// regimes in one folder means every future consumer has to re-derive which
// files carry obligations -- not worth it for sound effects.
const KEEP_LICENCE = /^(cc0|public domain)/i;

// Commons search is fuzzy over descriptions, so a term like "door slam" also
// matches Wiktionary's recording of the word "slums" and a Supreme Court
// argument in *Water Splash, Inc. v. Menon*. These are all correctly licensed
// -- they are just not sound effects. Dropped by title before download.
const DENY_TITLE = [
  /^LL-Q\d+/i,                                  // Wiktionary pronunciation set
  /\b(recording of the|pronunciation|spoken|audio of the word)\b/i,
  /\b(podcast|interview|lecture|sermon|speech|address|testimony)\b/i,
  /\b(opinions?|v\.|case \d|argument)\b/i,      // court audio
  /\b(qawwali|symphony|sonata|violin|piano|song|lagu|rendition|instrumental)\b/i,
  /\b(useless|test file|empty)\b/i,
];

// Three buckets, per the agreed mix. Commons search is fuzzy, so these are
// starting points -- the licence filter and the dedupe do the real work.
const QUERIES = {
  sting: [
    "rimshot", "drum roll", "record scratch", "slide whistle", "boing sound",
    "cash register sound", "trombone sound effect", "cymbal crash",
    "fanfare short", "applause", "laughter sound", "buzzer wrong",
    "bell ding", "whoosh sound effect", "pop sound effect",
  ],
  foley: [
    "glass breaking", "explosion sound", "door slam", "footsteps sound",
    "thunder sound", "splash water", "punch sound effect", "click sound",
    "beep electronic", "alarm sound", "siren sound", "typewriter sound",
    "camera shutter", "keyboard typing", "paper rustle",
  ],
  gov: [
    "NASA countdown", "Apollo 11", "space shuttle launch",
    "NASA mission audio", "moon landing audio",
  ],
};

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const LIMIT = Number(argv[argv.indexOf("--limit") + 1]) || 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ffmpeg, or nix's copy of it. Resolved once so a missing binary fails loudly
// at startup rather than 60 downloads in.
function resolveFfmpeg() {
  for (const probe of [["ffmpeg"], ["nix", "run", "nixpkgs#ffmpeg", "--"]]) {
    try {
      execFileSync(probe[0], [...probe.slice(1), "-hide_banner", "-version"], {
        stdio: "ignore",
        timeout: 300_000,
      });
      return probe;
    } catch (_) { /* try the next one */ }
  }
  throw new Error("No ffmpeg on PATH and `nix run nixpkgs#ffmpeg` failed.");
}

// upload.wikimedia.org rate-limits far more aggressively than the API does:
// THROTTLE_MS is fine for search but earned 22 straight 429s on file fetches.
// Downloads get their own slower pace plus exponential backoff, and a 429 that
// survives every retry is reported rather than swallowed -- a run that quietly
// skipped half its candidates is worse than one that says it was throttled.
async function download(url, attempt = 0) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 429 || res.status === 503) {
    if (attempt >= 4) throw new Error(`HTTP ${res.status} after ${attempt} retries`);
    const retryAfter = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : DOWNLOAD_THROTTLE_MS * 2 ** (attempt + 1);
    console.log(`    throttled, waiting ${(wait / 1000).toFixed(1)}s`);
    await sleep(wait);
    return download(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function api(params) {
  const url = `${API}?${new URLSearchParams({ format: "json", ...params })}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Commons API ${res.status} for ${params.gsrsearch || ""}`);
  return res.json();
}

// Commons returns licence data per-file in extmetadata. Everything that is not
// clearly CC0/PD is dropped here, before any bytes are transferred.
async function search(term, bucket) {
  const data = await api({
    action: "query",
    generator: "search",
    gsrsearch: `filetype:audio ${term}`,
    gsrnamespace: "6",
    gsrlimit: "20",
    prop: "imageinfo",
    iiprop: "url|extmetadata|mime|size",
    iiextmetadatafilter: "LicenseShortName|Artist|LicenseUrl|UsageTerms",
  });

  const pages = Object.values(data?.query?.pages ?? {});
  return pages.flatMap((page) => {
    const info = page.imageinfo?.[0];
    if (!info) return [];
    const meta = info.extmetadata ?? {};
    const licence = strip(meta.LicenseShortName?.value);
    if (!KEEP_LICENCE.test(licence)) return [];
    const title = page.title.replace(/^File:/, "");
    if (DENY_TITLE.some((re) => re.test(title))) return [];
    // Commons counts MIDI as audio; ffmpeg cannot render it without a soundfont,
    // so a .mid "rimshot" encodes to a few hundred bytes of silence. Filter by
    // container rather than trusting filetype:audio.
    if (!/\.(ogg|oga|opus|mp3|wav|flac|m4a)$/i.test(title)) return [];
    return [{
      bucket,
      title,
      url: info.url,
      descriptionurl: info.descriptionurl,
      licence,
      author: strip(meta.Artist?.value) || "unknown",
      bytes: info.size ?? 0,
    }];
  });
}

// Commons metadata fields are HTML fragments, not plain text.
function strip(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function slug(title) {
  return title
    .replace(/\.[a-z0-9]+$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// ffprobe ships in the same package as ffmpeg, so if one resolved so did the
// other. An earlier version of this parsed `ffmpeg -f null -` stderr instead,
// which silently never worked: ffmpeg EXITS ZERO on a valid file, so the parse
// lived in an unreachable catch and every clip came back with no duration. The
// gate looked active and filtered nothing -- three-minute jazz recordings sailed
// into a sound-effects folder. Returning null here must therefore mean "unknown",
// and unknown is treated as a rejection by the caller, not a pass.
function durationOf(ffmpeg, path) {
  const probe = ffmpeg[0] === "ffmpeg"
    ? ["ffprobe"]
    : [...ffmpeg.slice(0, -1), "nixpkgs#ffmpeg", "-c", "ffprobe"];
  try {
    const out = execFileSync(probe[0], [
      ...probe.slice(1),
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1", path,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 120_000 }).trim();
    const seconds = Number(out);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch (_) {
    return null;
  }
}

async function main() {
  const ffmpeg = DRY ? null : resolveFfmpeg();
  if (!DRY) mkdirSync(OUT_DIR, { recursive: true });

  // --- discover ---------------------------------------------------------
  const seen = new Set();
  const candidates = [];
  for (const [bucket, terms] of Object.entries(QUERIES)) {
    for (const term of terms) {
      if (candidates.length >= LIMIT) break;
      let hits = [];
      try {
        hits = await search(term, bucket);
      } catch (err) {
        console.warn(`  ! ${term}: ${err.message}`);
      }
      for (const hit of hits) {
        if (seen.has(hit.title) || candidates.length >= LIMIT) continue;
        seen.add(hit.title);
        candidates.push(hit);
      }
      console.log(`  ${bucket.padEnd(6)} ${term.padEnd(24)} +${hits.length} (${candidates.length} total)`);
      await sleep(THROTTLE_MS);
    }
  }

  console.log(`\n${candidates.length} freely-licensed candidates.`);
  if (DRY) {
    for (const c of candidates) console.log(`  ${c.licence.padEnd(14)} ${c.title}`);
    return;
  }

  // --- fetch + encode ---------------------------------------------------
  const hashes = new Map();
  const kept = [];
  for (const c of candidates) {
    const id = slug(c.title);
    const out = join(OUT_DIR, `${id}.ogg`);
    if (existsSync(out)) { console.log(`  = ${id} (exists)`); continue; }

    // Declared outside the try so the finally can always reach it. Sources are
    // frequently 100 MB+ FLAC masters and every rejection path here is a
    // `continue`, so leaving cleanup inside the try leaks the whole download --
    // an earlier run left 370 MB of intermediates behind in this folder.
    const tmp = join(OUT_DIR, `.tmp-${id}`);
    try {
      const raw = await download(c.url);
      writeFileSync(tmp, raw);

      // Unknown duration is a rejection, not a pass. A clip we cannot measure
      // is a clip we cannot vouch for, and the cost of being wrong is a
      // three-minute track wired to a soundboard button.
      const seconds = durationOf(ffmpeg, tmp);
      if (seconds === null) {
        console.log(`  - ${id} (duration unreadable)`);
        continue;
      }
      if (seconds > MAX_SECONDS) {
        console.log(`  - ${id} (${seconds.toFixed(1)}s, too long)`);
        continue;
      }

      execFileSync(ffmpeg[0], [
        ...ffmpeg.slice(1), "-y", "-i", tmp,
        "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "24k",
        out,
      ], { stdio: "ignore", timeout: 120_000 });

      const size = statSync(out).size;
      if (size < MIN_BYTES) throw new Error(`encoded to ${size} bytes`);

      // The rate-limit trap: a source that serves one placeholder for every
      // request produces N byte-identical outputs, all of which look valid.
      const hash = createHash("md5").update(readFileSync(out)).digest("hex");
      if (hashes.has(hash)) throw new Error(`identical to ${hashes.get(hash)}`);
      hashes.set(hash, id);

      kept.push({ ...c, id, file: `${GROUP}/${id}.ogg`, size });
      console.log(`  + ${id.padEnd(44)} ${(size / 1024).toFixed(1)} KB`);
    } catch (err) {
      console.warn(`  ! ${id}: ${err.message}`);
    } finally {
      rmSync(tmp, { force: true });
    }
    await sleep(DOWNLOAD_THROTTLE_MS);
  }

  writeFileSync(
    join(OUT_DIR, "_pending.json"),
    JSON.stringify(kept, null, 2),
    "utf8",
  );
  console.log(`\nKept ${kept.length} clips. Wrote ${GROUP}/_pending.json.`);
  console.log(`Next: node tools/merge-manifest.mjs`);
}

main().catch((err) => { console.error(err); process.exit(1); });
