#!/usr/bin/env node
/**
 * Fetches CC0 clips via the Openverse API and encodes them to the repo's Opus
 * target. Writes sfx/_pending.json, which tools/merge-manifest.mjs folds into
 * manifest.json.
 *
 *   node tools/fetch-openverse.mjs --dry-run
 *   node tools/fetch-openverse.mjs --limit 100
 *
 * Why this exists alongside fetch-free-sounds.mjs (Wikimedia Commons): Commons
 * is a poor fit for a soundboard. Its audio is mostly long-form field
 * recordings, music and pronunciation clips, and a 110-candidate run yielded
 * 4 usable files. Openverse indexes Freesound's CC0 library, which is short
 * comedy stings and effects -- the actual material a soundboard wants -- and
 * needs no API key, so it also sidesteps registering a Freesound app.
 *
 * Two things make this cheaper than the Commons run:
 *
 *   - Search results carry `duration` in ms, so clips that are too long are
 *     dropped BEFORE any bytes move. The Commons tool could only measure after
 *     downloading, which is how it pulled three 120 MB FLAC masters.
 *   - Results carry the licence as a field, so filtering is exact rather than
 *     a guess from a title.
 *
 * Licence handling: CC0 only. Openverse also indexes CC-BY and PDM, but mixing
 * regimes means every future consumer has to work out which files carry
 * attribution obligations. CC0 is a public-domain dedication, so nothing here
 * requires attribution -- CREDITS.md records provenance anyway.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, "sfx");
const GROUP = "sfx";

const API = "https://api.openverse.org/v1/audio/";
const UA = "gather-sounds-curation/1.0 (https://github.com/itpick/gather-sounds)";

const THROTTLE_MS = 1200; // anonymous Openverse access is rate-limited
const MIN_BYTES = 1024;
const MAX_MS = 12000; // a soundboard button is a sting, not a track
const MIN_MS = 250; // sub-quarter-second results are usually fragments

const QUERIES = [
  // reaction stings -- the bucket Commons could not fill
  "rimshot", "sad trombone", "drum roll", "record scratch", "slide whistle",
  "boing", "cash register", "cymbal crash", "fanfare", "applause",
  "buzzer", "ding correct", "airhorn", "whoosh", "pop",
  "laugh track", "crickets", "party horn", "swoosh transition", "error beep",
  // foley and impacts
  "glass break", "explosion", "door slam", "punch impact", "thunder",
  "splash", "camera shutter", "typewriter", "keyboard click", "alarm clock",
  "siren", "footsteps", "paper crumple", "coin", "bell",
];

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const LIMIT = Number(argv[argv.indexOf("--limit") + 1]) || 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveFfmpeg() {
  for (const probe of [["ffmpeg"], ["nix", "run", "nixpkgs#ffmpeg", "--"]]) {
    try {
      execFileSync(probe[0], [...probe.slice(1), "-hide_banner", "-version"], {
        stdio: "ignore", timeout: 300_000,
      });
      return probe;
    } catch (_) { /* next */ }
  }
  throw new Error("No ffmpeg on PATH and `nix run nixpkgs#ffmpeg` failed.");
}

async function search(term) {
  const url = `${API}?${new URLSearchParams({
    q: term, license: "cc0", page_size: "20",
  })}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 429) throw new Error("rate limited");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json.results || [])
    // duration is milliseconds and is present in the search payload, so the
    // length gate runs before any download rather than after.
    .filter((r) => r.url && r.license === "cc0")
    .filter((r) => {
      const d = Number(r.duration);
      return Number.isFinite(d) && d >= MIN_MS && d <= MAX_MS;
    })
    .map((r) => ({
      term,
      id: r.id,
      title: r.title || r.id,
      url: r.url,
      creator: r.creator || "unknown",
      licence: `${r.license} ${r.license_version || ""}`.trim(),
      landing: r.foreign_landing_url || "",
      durationMs: Number(r.duration),
    }));
}

function slug(title) {
  return title
    .replace(/\.[a-z0-9]+$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "clip";
}

async function download(url, attempt = 0) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 429 || res.status === 503) {
    if (attempt >= 4) throw new Error(`HTTP ${res.status} after ${attempt} retries`);
    const wait = THROTTLE_MS * 2 ** (attempt + 1);
    console.log(`    throttled, waiting ${(wait / 1000).toFixed(1)}s`);
    await sleep(wait);
    return download(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const ffmpeg = DRY ? null : resolveFfmpeg();
  if (!DRY) mkdirSync(OUT_DIR, { recursive: true });

  const seen = new Set();
  const candidates = [];
  for (const term of QUERIES) {
    if (candidates.length >= LIMIT) break;
    let hits = [];
    try {
      hits = await search(term);
    } catch (err) {
      console.warn(`  ! ${term}: ${err.message}`);
      await sleep(THROTTLE_MS * 2);
      continue;
    }
    let added = 0;
    for (const hit of hits) {
      const id = slug(hit.title);
      if (seen.has(id) || candidates.length >= LIMIT) continue;
      seen.add(id);
      candidates.push({ ...hit, slug: id });
      added++;
    }
    console.log(`  ${term.padEnd(20)} ${String(hits.length).padStart(3)} hits, +${added} (${candidates.length} total)`);
    await sleep(THROTTLE_MS);
  }

  console.log(`\n${candidates.length} CC0 candidates within ${MIN_MS}-${MAX_MS}ms.`);
  if (DRY) {
    for (const c of candidates) {
      console.log(`  ${String(c.durationMs).padStart(6)}ms  ${c.title.slice(0, 56)}`);
    }
    return;
  }

  const existing = existsSync(join(OUT_DIR, "_pending.json"))
    ? JSON.parse(readFileSync(join(OUT_DIR, "_pending.json"), "utf8"))
    : [];
  const hashes = new Map();
  const kept = [...existing];
  const haveIds = new Set(existing.map((e) => e.id));

  for (const c of candidates) {
    const out = join(OUT_DIR, `${c.slug}.ogg`);
    if (existsSync(out) || haveIds.has(c.slug)) { console.log(`  = ${c.slug} (exists)`); continue; }

    const tmp = join(OUT_DIR, `.tmp-${c.slug}`);
    try {
      writeFileSync(tmp, await download(c.url));
      execFileSync(ffmpeg[0], [
        ...ffmpeg.slice(1), "-y", "-i", tmp,
        "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "24k",
        out,
      ], { stdio: "ignore", timeout: 120_000 });

      const size = statSync(out).size;
      if (size < MIN_BYTES) throw new Error(`encoded to ${size} bytes`);

      const hash = createHash("md5").update(readFileSync(out)).digest("hex");
      if (hashes.has(hash)) throw new Error(`identical to ${hashes.get(hash)}`);
      hashes.set(hash, c.slug);

      kept.push({
        id: c.slug,
        title: c.title,
        file: `${GROUP}/${c.slug}.ogg`,
        licence: c.licence,
        author: c.creator,
        descriptionurl: c.landing,
        size,
      });
      console.log(`  + ${c.slug.padEnd(46)} ${(size / 1024).toFixed(1)} KB`);
    } catch (err) {
      console.warn(`  ! ${c.slug}: ${err.message}`);
      rmSync(out, { force: true }); // never leave a half-written clip behind
    } finally {
      rmSync(tmp, { force: true });
    }
    await sleep(THROTTLE_MS);
  }

  writeFileSync(join(OUT_DIR, "_pending.json"), JSON.stringify(kept, null, 2), "utf8");
  console.log(`\nKept ${kept.length - existing.length} new (${kept.length} total). Wrote ${GROUP}/_pending.json.`);
  console.log("Next: node tools/merge-manifest.mjs");
}

main().catch((err) => { console.error(err); process.exit(1); });
