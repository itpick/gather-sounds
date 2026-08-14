# gather-sounds

Audio clips loaded on demand by the [gather-farts](https://github.com/itpick) userscript,
which plays sounds through your microphone in Gather so the whole room hears them.

## Why these are here rather than in the userscript

The userscript embeds its audio as base64 in a single file. That is fine for a
handful of sounds, but this set is 666 clips / 17 MB, which would make the script
roughly 20 MB and slow to parse on every page load. Hosting them here keeps the
script small and lets it fetch a clip only when someone actually plays it.

## Layout

- `manifest.json` — the index the userscript reads: `id`, `label`, `file`, `group`.
  `groups.trump.searchOnly` is what keeps these out of the default button row;
  they appear only once you type in the search box.
- `trump/` — 666 Opus clips.

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
