#!/usr/bin/env bash
# Creates a dedicated audio sink so the Spotify desktop app (or anything else)
# can be captured by gather-music.user.js and sent to a Gather room.
#
#   ./tools/spotify-bridge.sh          # set up
#   ./tools/spotify-bridge.sh --down   # tear down
#   ./tools/spotify-bridge.sh --status
#
# Why a dedicated sink rather than capturing the default one: the default sink's
# monitor carries EVERYTHING, including Gather's own output. Capturing that
# sends every remote participant's voice straight back to them, which is a
# feedback loop that gets worse the more people are in the room.
#
# PipeWire/PulseAudio modules do not survive a reboot, so re-run this after one.
set -euo pipefail

SINK=gather_music

have_module() {
  pactl list short modules 2>/dev/null | grep -q "$1"
}

status() {
  echo "sink:"
  pactl list short sinks 2>/dev/null | grep "$SINK" || echo "  (absent)"
  echo "capture source:"
  pactl list short sources 2>/dev/null | grep "$SINK" || echo "  (absent)"
  echo "streams currently on this sink:"
  pactl list sink-inputs 2>/dev/null \
    | grep -B20 "Sink: $(pactl list short sinks | grep "$SINK" | awk '{print $1}' 2>/dev/null || echo __none__)" \
    | grep "application.name" || echo "  (none)"
}

down() {
  # Unload loopback first; it holds the monitor open.
  for m in $(pactl list short modules 2>/dev/null | grep "module-loopback" | grep "$SINK" | awk '{print $1}'); do
    pactl unload-module "$m" && echo "unloaded loopback $m"
  done
  for m in $(pactl list short modules 2>/dev/null | grep "sink_name=$SINK" | awk '{print $1}'); do
    pactl unload-module "$m" && echo "unloaded sink $m"
  done
  echo "torn down."
}

up() {
  if have_module "sink_name=$SINK"; then
    echo "sink already present"
  else
    pactl load-module module-null-sink \
      sink_name="$SINK" \
      sink_properties=device.description=GatherMusic >/dev/null
    echo "created sink '$SINK'"
  fi

  # Loopback back to the real output, so you still hear what you are sending.
  # Without it a null sink is a black hole: the room hears Spotify and you do not.
  if pactl list short modules 2>/dev/null | grep "module-loopback" | grep -q "$SINK"; then
    echo "loopback already present"
  else
    pactl load-module module-loopback \
      source="$SINK.monitor" sink=@DEFAULT_SINK@ latency_msec=40 >/dev/null
    echo "created loopback -> default output"
  fi

  cat <<EOF

Done. Two things left, both manual:

1. Point Spotify at the sink. Start playing something, then either use
   pavucontrol (Playback tab -> set Spotify's output to "GatherMusic"), or:

     pactl list short sink-inputs        # find Spotify's stream id
     pactl move-sink-input <id> $SINK

   Spotify has to be PLAYING before its stream exists to be moved.

2. In Gather, open the music panel's Spotify tab, pick "$SINK.monitor"
   (Monitor of GatherMusic) in the device list, and hit Start capture.

Tear down with: $0 --down
EOF
}

case "${1:-up}" in
  --down|down) down ;;
  --status|status) status ;;
  *) up ;;
esac
