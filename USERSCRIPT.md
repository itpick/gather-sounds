# Gather Farts

A Tampermonkey soundboard for [Gather](https://gather.town) that plays sounds
**through your microphone**, so everyone in the room hears them — not just you.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome or Firefox.
2. Open `gather-farts.user.js`, select all, and paste it into a new Tampermonkey
   script. (Or drag the file onto the browser — Tampermonkey intercepts
   `*.user.js`.)
3. Save, make sure the script is enabled.
4. **Reload your Gather tab.** The patch has to be in place before Gather asks
   for the microphone, so an already-open tab won't work until it reloads.

A 💨 button appears in Gather's bottom control bar, right of the reactions
smiley. Click it for the soundboard. The Mic DVR adds a 🎧 button beside it.

If the control bar isn't there — you haven't joined a room yet, or Gather
changed its markup — both scripts fall back to a draggable floating panel
instead of vanishing, and re-dock automatically once the bar appears.

## Using it

Click a button. The sound is mixed into your outgoing mic feed and you hear a
quieter copy locally so you know it fired.

You must be **unmuted** in Gather. Gather mutes by disabling the very track we
hand it, so a muted mic silences the soundboard too — which is the correct and
safe behaviour, but does mean the button will look like it did nothing.

## How it works

At `document-start` the script replaces `navigator.mediaDevices.getUserMedia`.
When Gather requests audio, it gets back a synthetic track from a Web Audio
graph instead of the raw device track:

```
realMicSource --+
                +--> MediaStreamAudioDestinationNode --> track Gather sends over WebRTC
fxGain ---------+
```

Everything routed into `fxGain` goes out to the room. A button click decodes its
embedded audio into an `AudioBuffer` and plays it into `fxGain`.

Each `getUserMedia` call gets its own destination node, so Gather stopping one
track (device switch, leaving a room) can't kill the mixer. Stopping the
outgoing track also stops the underlying real mic track, so the browser's
recording indicator doesn't stay lit.

## Where the buttons live

Both scripts anchor on the **Screen share** button's `aria-label` and walk up to
the first `.Layout` ancestor holding more than one control. That's the group
containing screen-share, the status circle, and the reactions smiley — so the new
buttons land beside them.

Anchoring on the aria-label rather than a class name is deliberate: Gather's
emotion-generated classes (`css-1s0xrxv` and friends) change on every deploy,
while accessible labels are stable. Gather also re-renders that bar when you join
or leave a room, which drops our node, so both scripts re-check every 2 seconds
and re-attach.

If Gather ever restructures enough to break the heuristic, you can point it at
the right element by hand without editing code — in the console:

```js
const k = "gatherFarts.ui"; // or "gatherMicDvr.ui"
localStorage[k] = JSON.stringify({
  ...JSON.parse(localStorage[k] || "{}"),
  dockSelector: "<a CSS selector for the container>",
});
```

## Repeat

Each button has a `⟳` toggle beside it.

- **Off** (default) — a click fires the sound once. Clicking again layers another
  copy on top.
- **On** (glows green) — a click starts the sound repeating until you stop it.
  The button turns green, gains a `■`, and becomes its own stop button.

Flipping `⟳` while a sound is already playing takes effect immediately: arming it
makes the current playback keep going, and disarming lets the current pass finish
and end naturally rather than cutting off mid-word.

Which buttons are armed is remembered across reloads. Nothing starts on its own —
arming only changes what the *next* click does.

## Current sounds

| Button          | Length | Source                                                     |
| --------------- | ------ | ---------------------------------------------------------- |
| `Brah`          | 1.2s   | freesound "bruh sound effect 2"                            |
| `Captain On The Bridge` | 1.4s | Warcraft alliance ships                                |
| `I Love Blowin Things Up` | 1.3s | Warcraft II dwarven demolition squad                 |
| `Jeopardy`      | 33.0s  | Jeopardy think music                                       |
| `Laughter`      | 6.5s   | freesound "misc audience laughter noises"                  |
| `That Was Easy` | 1.3s   | **placeholder** — espeak-ng synthesis, swap for a real clip |
| `Wet Fart`      | 8.1s   | dragon studio wet fart                                     |
| `When My Work Is Finished` | 3.9s | Warcraft death knight                                 |
| `White Noise`   | 6.0s   | freesound white noise, trimmed from 30s — loop it instead   |

`That Was Easy` is still a robotic espeak stand-in, generated with:

```sh
nix run nixpkgs#espeak-ng -- -v en-us+m3 -s 145 -p 35 -a 190 "that was easy" -w sounds/that-was-easy.wav
```

Replacing it means dropping a real file into `sounds/` and rebuilding — no code
change. (Delete the `.wav` if the replacement has a different extension, or you
will end up with two buttons.)

## Adding or changing sounds

Drop files into `sounds/` and rebuild:

```sh
node build.mjs
```

Then reinstall the regenerated `gather-farts.user.js`.

The **filename becomes the button label** (`wet-fart.mp3` → "Wet Fart"), with
trailing stock-library id digits stripped. Supported: mp3, wav, ogg, m4a, aac,
flac, webm.

Files are embedded verbatim as base64, which inflates them by ~33%. If the
script gets unwieldy, shrink the sources first — a couple of seconds of mono
64 kbps audio is usually 10–20× smaller than the stock download:

```sh
nix run nixpkgs#ffmpeg -- -i sounds/in.mp3 -ac 1 -ar 48000 -b:a 64k sounds/out.mp3
```

## Testing without a meeting

```sh
python3 -m http.server 8777
```

Open <http://localhost:8777/test.html> — the userscript matches that origin too.
Click **Request microphone**, then click a fart button. The level meter reads the
stream *returned to the app*, so a spike proves the sound is in the outgoing
feed. The page also reports whether the track it received came from the tap or
from the raw device.

For a real end-to-end check, join your Gather room from a second browser profile
or your phone and listen.

## Second script: Mic DVR

`gather-mic-dvr.user.js` is a **separate, standalone userscript** — install it
the same way, alongside the soundboard or on its own. No build step; edit the
file directly.

It keeps a rolling **two-minute recording of the call** and gives you a
scrubbable waveform. Drag anywhere on the waveform to pick a point, press ▶, and
everything from there to now is re-sent to the room. Pressing ▶ without scrubbing
sends the last 5 seconds — "say that again".

`Live` snaps the playhead back to now, `Pause` stops capture without unloading,
`Clear` wipes the buffer.

### What gets recorded

Two checkboxes, both on by default, remembered across reloads:

- **me** — your microphone, tapped via `getUserMedia`.
- **others** — every remote participant, tapped via `RTCPeerConnection` track
  events.

**Recording other people.** With `others` ticked this captures everyone you can
hear. Recording people generally requires telling them, and in some places their
consent. The panel therefore always shows a live `REC` indicator and there is
deliberately no hidden mode. The buffer is memory-only: nothing is written to
disk, nothing leaves the page, and it dies with the tab.

### `Tab audio` — the fallback

If remote audio isn't showing up (Gather changes its WebRTC plumbing, or routes
around the `track` event), press `Tab audio` and share **this tab** with
*"Also share tab audio"* ticked. That captures the tab's own output, which
contains everyone regardless of how it got there.

While it's active the per-track taps are disconnected, so nobody is recorded
twice, and replay monitoring is muted, because tab capture would otherwise record
the replay and feed it back into the buffer.

### Design notes

The mic source fans out to two places: an output sink that Gather transmits (mic
+ replays) and a recording bus (mic + others, never replays). Keeping replays out
of the recording is what stops a replay from feeding itself.

The two checkboxes are **gain gates**, not connect/disconnect calls, so toggling
can't drift out of step with which nodes happen to exist yet.

Audio goes into a plain `Float32Array` ring rather than a `MediaRecorder`,
because compressed chunks are miserable to seek into and a ring buffer makes any
scrub position a simple array index. Capture uses a deprecated
`ScriptProcessorNode` on purpose: an `AudioWorklet` needs `addModule()` with a
`blob:` URL, which Gather's CSP may refuse.

If both scripts are installed, whether soundboard hits appear in the DVR
recording depends on which one Tampermonkey patched first. That's intentional and
harmless — the DVR is for replaying what *you said*, and the soundboard already
has buttons for re-firing sounds.

## Layout

```
sounds/                    audio files you supply
src/userscript.template.js the real source — edit this
build.mjs                  embeds sounds/ into the template
gather-farts.user.js       generated; this is what you install
gather-mic-dvr.user.js     the DVR — standalone, no build step
test.html                  local loopback harness
```

Never hand-edit `gather-farts.user.js`; `build.mjs` overwrites it.
`gather-mic-dvr.user.js` is the opposite — it *is* the source.

## Troubleshooting

**Dot stays grey / "waiting for mic".** The script loaded after Gather grabbed
the mic. Reload the tab. If it persists, check Tampermonkey has the script
enabled for `app.gather.town` and that `@run-at document-start` survived.

**Buttons play locally but nobody hears them.** You're muted in Gather, or the
dot is grey.

**Nothing at all, no panel.** Open the console and look for `[farts]` lines —
the script logs when it patches `getUserMedia` and when it mounts the panel.
