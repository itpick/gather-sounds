#!/usr/bin/env node
/**
 * Merges sfx/_pending.json (written by fetch-free-sounds.mjs) into manifest.json.
 *
 *   node tools/merge-manifest.mjs [--dry-run]
 *
 * manifest.json is 677 entries and hand-formatted in a specific way: one-space
 * indent, non-ASCII escaped as \uXXXX, and NO trailing newline. Plain
 * JSON.stringify matches none of that, so writing it back naively turns a
 * four-line addition into a 5000-line reformat. serialize() reproduces the
 * original conventions exactly -- there is a self-check below that refuses to
 * write if a no-op round-trip is not byte-identical.
 *
 * Existing entries are never touched. In particular the 666 `trump` entries
 * carry no sortKey, and backfilling one would be a large diff for no benefit,
 * so new entries are appended rather than the list being re-sorted.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST = join(ROOT, "manifest.json");
const PENDING = join(ROOT, "sfx", "_pending.json");
const GROUP = "sfx";
const DRY = process.argv.includes("--dry-run");

// Non-ASCII to \uXXXX, matching how manifest.json was originally written.
function serialize(obj) {
  return JSON.stringify(obj, null, 1).replace(
    /[-￿]/g,
    (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

function labelFor(id) {
  return id
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

const raw = readFileSync(MANIFEST, "utf8");
const manifest = JSON.parse(raw);

// Refuse to touch the file unless a no-op round-trip is byte-identical. If the
// formatting convention ever changes, this fails loudly rather than silently
// rewriting all 677 entries.
if (serialize(manifest) !== raw) {
  console.error("Round-trip is not byte-identical -- refusing to write.");
  console.error("manifest.json formatting has changed; update serialize().");
  process.exit(1);
}

if (!existsSync(PENDING)) {
  console.error(`No ${PENDING}. Run tools/fetch-free-sounds.mjs first.`);
  process.exit(1);
}

const pending = JSON.parse(readFileSync(PENDING, "utf8"));
manifest.groups[GROUP] ??= { title: "Sound Effects", searchOnly: true };

let added = 0;
for (const clip of pending) {
  if (manifest.sounds.some((s) => s.id === clip.id)) continue;
  manifest.sounds.push({
    id: clip.id,
    sortKey: clip.id,
    label: `${labelFor(clip.id)} (24k)`,
    file: clip.file,
    group: GROUP,
    kbps: 24,
  });
  added++;
  console.log(`  + ${clip.id}  [${clip.licence}]`);
}

if (DRY) {
  console.log(`\n--dry-run: would add ${added} entries.`);
} else {
  writeFileSync(MANIFEST, serialize(manifest), "utf8");
  console.log(`\nAdded ${added} entries. manifest.json now has ${manifest.sounds.length}.`);
}
