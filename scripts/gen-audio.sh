#!/usr/bin/env bash
# Reproduce the shipped SFX + voice assets from their pinned, licence-cleared sources.
#
# This is the audit-reproducible recipe behind docs/AUDIO_PROVENANCE.md. It is NOT part of the
# default verify chain (scripts/verify-all.sh) — run it manually to regenerate audio assets. It
# re-downloads the four pinned Kenney CC0 zips, FAILS if any sha256 differs from the recorded value
# (so a silent upstream change cannot sneak in), converts a small curated subset to mono PCM wav,
# and regenerates the robotic selection lines with flite.
#
# Requirements: curl, shasum, unzip, ffmpeg, flite. Network access. The zips + intermediates are
# written to a throwaway temp dir; only the curated .wav files land in the repo.
set -euo pipefail
cd "$(dirname "$0")/.."
WEB=packages/web
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fetch() { # name url sha256
  local name="$1" url="$2" sha="$3"
  echo "== fetch $name =="
  curl -sSL --max-time 180 -o "$WORK/$name.zip" "$url"
  local got
  got=$(shasum -a 256 "$WORK/$name.zip" | awk '{print $1}')
  if [ "$got" != "$sha" ]; then echo "SHA MISMATCH $name: got $got want $sha"; exit 1; fi
  echo "ok sha $name"
  unzip -o -q "$WORK/$name.zip" -d "$WORK/$name"
}

fetch kenney_sci-fi-sounds  "https://kenney.nl/media/pages/assets/sci-fi-sounds/6b296f9ecf-1677589334/kenney_sci-fi-sounds.zip"   119340f351a5098ad814f78719438c0da355a9ce8a4c8a3af6a8d48aa3d49e04
fetch kenney_interface-sounds "https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip" f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232
fetch kenney_impact-sounds  "https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip"     029d734af1582474edf3a694d1b0cebc97c1c152f2f39fa34d4c2bafc5de77f8
fetch kenney_ui-audio       "https://kenney.nl/media/pages/assets/ui-audio/490d233f68-1677590494/kenney_ui-audio.zip"                946fc23a63d535d693eb31b2eabb80c8c28d6351e2186b344ceb71b2cb1d5eb6

mkdir -p "$WEB/public/sfx" "$WEB/public/voice"

convert() { # <pack>/<file.ogg>  -> packages/web/public/sfx/<file>.wav (mono pcm16)
  local rel="$1"
  local base
  base=$(basename "$rel")
  local out="$WEB/public/sfx/${base%.ogg}.wav"
  if [ ! -f "$WORK/$rel" ]; then echo "MISSING $rel"; exit 1; fi
  ffmpeg -v error -y -i "$WORK/$rel" -ac 1 -sample_fmt s16 "$out"
}

# Curated subset (disjoint per event; see audio.ts SFX_FILES for the event mapping).
convert kenney_interface-sounds/Audio/confirmation_001.ogg
convert kenney_interface-sounds/Audio/confirmation_002.ogg
convert kenney_interface-sounds/Audio/confirmation_004.ogg
convert kenney_interface-sounds/Audio/click_001.ogg
convert kenney_interface-sounds/Audio/click_002.ogg
convert kenney_interface-sounds/Audio/error_001.ogg
convert kenney_interface-sounds/Audio/error_002.ogg
convert kenney_interface-sounds/Audio/bong_001.ogg
convert kenney_interface-sounds/Audio/glitch_001.ogg
convert kenney_sci-fi-sounds/Audio/laserSmall_001.ogg
convert kenney_sci-fi-sounds/Audio/laserRetro_001.ogg
convert kenney_sci-fi-sounds/Audio/impactMetal_001.ogg
convert kenney_sci-fi-sounds/Audio/explosionCrunch_000.ogg
convert kenney_sci-fi-sounds/Audio/computerNoise_001.ogg
convert kenney_sci-fi-sounds/Audio/forceField_000.ogg
convert kenney_sci-fi-sounds/Audio/forceField_001.ogg
convert kenney_sci-fi-sounds/Audio/lowFrequency_explosion_000.ogg
convert kenney_impact-sounds/Audio/footstep_concrete_001.ogg
convert kenney_impact-sounds/Audio/footstep_wood_001.ogg
convert kenney_impact-sounds/Audio/impactGeneric_light_001.ogg
convert kenney_impact-sounds/Audio/impactBell_heavy_000.ogg
convert kenney_impact-sounds/Audio/impactPlate_heavy_000.ogg

# Robotic selection lines from the AUTHORITATIVE player display names.
for name in Vanguard Ghost Cipher; do
  flite -t "$name at your service" -o "$WEB/public/voice/${name}_at_your_service.wav"
done

echo "generated $(ls -1 "$WEB/public/sfx" | wc -l | tr -d ' ') sfx + $(ls -1 "$WEB/public/voice" | wc -l | tr -d ' ') voice files"