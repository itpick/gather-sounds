# gather-sounds

The [Gather Farts](gather-farts.user.js) userscript and the audio it plays.
A soundboard that routes clips through your microphone in Gather, so the whole
room hears them.

## Install

Open this in a browser with Tampermonkey installed:

**https://raw.githubusercontent.com/itpick/gather-sounds/main/gather-farts.user.js**

It carries `@updateURL`/`@downloadURL`, so Tampermonkey will offer updates when
`@version` is bumped. That only works because this repo is public — Tampermonkey
fetches those URLs unauthenticated.

## Layout

| Path | What |
|---|---|
| `gather-farts.user.js` | the built script — install this, do not edit it |
| `src/userscript.template.js` | the source; **edit this** |
| `build.mjs` | embeds `sounds/` into the template as base64 |
| `sounds/` | the two clips embedded in the script |
| `core/` | clips fetched for the default button list |
| `trump/` | 666 clips, search-only |
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
