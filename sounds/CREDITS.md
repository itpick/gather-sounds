# Sound credits

Most sounds here are synthesised or pre-existing. Anything sourced externally
is listed with its licence.

| File | Source | Licence | Attribution required |
|---|---|---|---|
| `z-applause.ogg` | [277021 sandermotions applause-2.wav](https://commons.wikimedia.org/wiki/File:277021_sandermotions_applause-2.wav) via Wikimedia Commons, by Sandermotions | **CC0** | No — but credited anyway |
| `z-rimshot.ogg` | Synthesised (see git history) | n/a | n/a |
| `zz-quality-test-bells.ogg` | Synthesised | n/a | n/a |
| `zz-quality-test-sweep.ogg` | Synthesised | n/a | n/a |
| `sfx/drum-roll-intro.ogg` | [Drum Roll Intro.ogg](https://commons.wikimedia.org/wiki/File:Drum_Roll_Intro.ogg) via Wikimedia Commons, by Iwan Sounds and DIY | **CC0** | No |
| `sfx/scratching-ones-head.ogg` | [Scratching ones head.ogg](https://commons.wikimedia.org/wiki/File:Scratching_ones_head.ogg) via Wikimedia Commons, by ezwa | **Public domain** | No |
| `sfx/deep-twang-of-loose-bow-string.ogg` | [Deep twang of loose bow string.ogg](https://commons.wikimedia.org/wiki/File:Deep_twang_of_loose_bow_string.ogg) via Wikimedia Commons, by stephan | **Public domain** | No |
| `sfx/cash-register.ogg` | [Cash register.ogg](https://commons.wikimedia.org/wiki/File:Cash_register.ogg) via Wikimedia Commons, by Me | **Public domain** | No |

The `sfx/` rows were sourced by `tools/fetch-free-sounds.mjs`, which filters on
Commons' machine-readable licence field and never downloads anything outside
CC0 / public domain. Note that field is uploader-supplied, so it is a claim
rather than a guarantee — treat it as a filter, not an audit.

CC0 is a public-domain dedication, so no attribution is legally required for
the applause. It is recorded here so nobody has to re-derive where it came
from, and so the licence is auditable if this is ever redistributed.

Note the 666 clips in `itpick/gather-sounds` are a different matter: they are
recordings of broadcast material, carry no such licence, and are hosted for
personal use.
