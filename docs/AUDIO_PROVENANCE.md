# Audio Provenance — Signal Breach (SFX samples + robotic voice)

Licence position for every shipped audio asset. This file is the audit record: it pins the source
packs, their licence, the exact subset taken, and how the voice lines were made. Rebuild everything
with `bash scripts/gen-audio.sh` (it re-downloads the pinned packs, verifies their sha256, curates
the subset, and regenerates the voice lines).

## Sound effects — Kenney CC0 packs

All SFX are taken verbatim from Kenney "audio" packs, licensed **CC0 1.0 (Creative Commons Zero)**
— public domain / free for commercial use, **no attribution required** (see each pack's `License.txt`
inside the zip). Four pinned zips were downloaded and each `sha256` was checked against the values
below before any file was curated (the values are the ones recorded by the operator).

| pack | pinned URL | sha256 | audio files in pack |
|------|------------|--------|---------------------|
| Sci-Fi Sounds | https://kenney.nl/media/pages/assets/sci-fi-sounds/6b296f9ecf-1677589334/kenney_sci-fi-sounds.zip | 119340f351a5098ad814f78719438c0da355a9ce8a4c8a3af6a8d48aa3d49e04 | 73 |
| Interface Sounds | https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip | f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232 | 100 |
| Impact Sounds | https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip | 029d734af1582474edf3a694d1b0cebc97c1c152f2f39fa34d4c2bafc5de77f8 | 130 |
| UI Audio | https://kenney.nl/media/pages/assets/ui-audio/490d233f68-1677590494/kenney_ui-audio.zip | 946fc23a63d535d693eb31b2eabb80c8c28d6351e2186b344ceb71b2cb1d5eb6 | 52 |

A SMALL subset (22 files) was curated into `packages/web/public/sfx/` and converted to mono 16-bit
PCM `.wav` (`ffmpeg -ac 1 -sample_fmt s16`) so the Web Audio decoder accepts them without a
Vorbis dependency. The source `.ogg` name maps 1:1 to the shipped `.wav` name. Each in-game event
maps to a DISTINCT, disjoint pool of samples (no sample is shared across events) — the mapping and
the per-event rationale live in `packages/web/src/audio.ts` (`SFX_FILES`).

Exact shipped file set (event → files; pools are pairwise disjoint):
- select    → confirmation_001.wav, confirmation_002.wav        (Interface / UI)
- click     → click_001.wav, click_002.wav                        (Interface)
- move      → footstep_concrete_001.wav, footstep_wood_001.wav    (Impact)
- shot      → laserSmall_001.wav, laserRetro_001.wav              (Sci-Fi)
- hit       → impactMetal_001.wav, impactGeneric_light_001.wav    (Sci-Fi / Impact)
- kill      → explosionCrunch_000.wav, impactBell_heavy_000.wav   (Sci-Fi / Impact)
- hack      → computerNoise_001.wav, glitch_001.wav               (Sci-Fi / Interface)
- emp       → forceField_000.wav, forceField_001.wav              (Sci-Fi)
- deny      → error_001.wav, error_002.wav                         (Interface)
- victory   → bong_001.wav, confirmation_004.wav                   (Interface)
- defeat    → lowFrequency_explosion_000.wav, impactPlate_heavy_000.wav (Sci-Fi / Impact)

## Robotic voice lines — flite (CMS Flite, MIT-style licensed engine)

Selection voice lines ("Vanguard at your service", etc.) are generated with **flite** (the CMU Flite
engine, `2.2`, installed at `/opt/homebrew/bin/flite`), whose voice/diphone data is BSD-style
licensed and free to use. Each line is rendered 8 kHz mono and saved next to the SFX:

    flite -t "<Name> at your service" -o "<Name>_at_your_service.wav"

Generated for the player squad archetypes' actual display names (Vanguard, Ghost, Cipher). At
runtime the module keys on the unit's LIVE `name` (not a hardcoded lookup), so the request follows
authoritative state. Ships one `.wav` per generated name under `packages/web/public/voice/`.

No third-party audio is used anywhere else. The old procedural oscillator path was removed.