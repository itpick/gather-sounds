# gather-sounds

Two Gather userscripts and the audio they play.

[Gather Farts](gather-farts.user.js) is a soundboard that routes clips through
your microphone, so the whole room hears them. [Gather Mic DVR](gather-mic-dvr.user.js)
is a rolling recorder for the same call — scrub back through the last two
minutes of your mic or everyone else's, and re-send a chunk to the room.

## Install

Open either of these in a browser with Tampermonkey installed:

- Soundboard — **https://raw.githubusercontent.com/itpick/gather-sounds/main/gather-farts.user.js**
- Mic DVR — **https://raw.githubusercontent.com/itpick/gather-sounds/main/gather-mic-dvr.user.js**

They are independent; install one or both. The soundboard adds a 💨 button to
Gather's bottom control bar and the DVR adds a 🎧 beside it.

Both carry `@updateURL`/`@downloadURL`, so Tampermonkey will offer updates when
`@version` is bumped. That only works because this repo is public — Tampermonkey
fetches those URLs unauthenticated.

If you installed either script from a local file before it was hosted here,
reinstall once from the URL above. Tampermonkey only follows the update URL of
the copy it actually installed, so the old local copy will never see updates.

## Layout

| Path | What |
|---|---|
| `gather-farts.user.js` | the built soundboard — install this, do not edit it |
| `src/userscript.template.js` | the soundboard source; **edit this** |
| `build.mjs` | embeds `sounds/` into the template as base64 |
| `gather-mic-dvr.user.js` | the DVR — standalone, no build step, edit it directly |
| `sounds/` | the two clips embedded in the script |
| `core/` | clips fetched for the default button list |
| `trump/` | 666 clips, search-only |
| `sfx/` | 112 CC0 / public-domain effects, search-only ([credits](sfx/CREDITS.md)) |
| `tools/` | sourcing and maintenance scripts — see below |
| `manifest.json` | the index the script reads at startup |
| `test.html` | loopback harness on localhost:8777 |

## Why the split

The script embeds only `wet-fart` and `rimshot`. Everything else is fetched.

Audio was 97% of the script and logic 3%, so embedding all of it made a 1.2 MB
file that reparsed on every Gather page load; hosting it brings that to ~175 KB.
Those two stay embedded so a blocked or unreachable GitHub degrades the board to
two sounds rather than none — and they are the two you would actually reach for.

The default list is a merge of embedded and hosted clips sorted by `sortKey`
(the raw filename stem, including any `z-`/`zz-` prefix), so the split is
invisible in the UI.

## Adding sounds

Drop a file in `core/` (default list) or `trump/` (search-only), add an entry to
`manifest.json`, push. Nothing needs rebuilding — the script reads the manifest
at startup. Only changing `sounds/` or `src/` requires `node build.mjs` and a
version bump.

Filenames set both label and order. `z-` and `zz-` are sort-position prefixes
stripped from the label: plain names first, `z-` after them, `zz-` last. Digits
sort *before* letters, so a `99-` prefix would put a sound first, not last.

## Tools

| Script | What it does |
|---|---|
| `tools/fetch-openverse.mjs` | Sources CC0 clips via Openverse (indexes Freesound). No API key. |
| `tools/fetch-free-sounds.mjs` | Same, from Wikimedia Commons. Low yield — see below. |
| `tools/merge-manifest.mjs` | Folds `sfx/_pending.json` into `manifest.json`. |
| `tools/detect-beep.mjs` | Measures the leading beep on sourced clips, writes `startMs`. |

All of them shell out to ffmpeg and fall back to `nix run nixpkgs#ffmpeg` when
it isn't on PATH.

**Openverse is the source that works.** Commons was tried first and returned 4
usable clips from 110 candidates: its audio is mostly long-form field
recordings, music and pronunciation clips, so almost nothing survives a
12-second gate. Openverse surfaces Freesound's CC0 library, which is short
effects by design — 108 of 110 survived. It also returns `duration` in the
search payload, so over-length results are dropped before any bytes move.

**`startMs` skips a leading beep.** Many of the sourced clips open with a tone
from the site they came from. `detect-beep.mjs` measures where it ends per clip
and records it; the userscript seeks past it at playback. Nothing is
re-encoded — note that `-ss` with `-c copy` on Ogg Opus does *not* trim audio,
it only rewrites the container duration, so a trim would mean a real re-encode
and a lost generation.

## Encoding

Opus, mono, 48 kHz, 24 kbps.

That is deliberately matched to the delivery path rather than to the source
files. The userscript mixes clips into a `MediaStreamAudioDestinationNode` that
Gather sends over WebRTC, and WebRTC encodes it as Opus at roughly 32 kbps mono.
Storing anything higher is discarded at that hop, and storing MP3 would mean
encoding lossy audio twice — MP3 artifacts fed into an Opus encoder — which
sounds worse than Opus at the same bitrate. Sources were ~70 MB.

## Adding more

Drop the files in a folder, add entries to `manifest.json`, push. The userscript
reads the manifest at startup, so nothing needs rebuilding.

## A trap worth knowing about

The first bulk download of these clips silently produced **415 identical
files**: the source site rate-limits, and instead of failing it serves a
~92 KB / 6.5 s clip saying "please refresh the page". `curl` returns 200, the
file is a valid MP3, and nothing looks wrong until you play it.

If you re-fetch this set, throttle it (about 0.7 s between requests) and
verify afterwards:

    md5sum *.mp3 | awk '{print $1}' | sort | uniq -c | sort -rn | head

Any hash appearing more than once is the placeholder, not a real clip. Every
file in this repo has a unique hash.
