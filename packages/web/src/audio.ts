// Sample-based Web Audio SFX + robotic voice. Replaces the old procedural oscillator "beeps".
// Fails safe if the AudioContext (or the sample asset) is unavailable — it must never throw.
// Respects mute + volume, and persists those accessibility settings across sessions.
//
// WHY SAMPLES: Sean's feedback was to kill the procedural beeps. Every event now plays a
// licence-clean CC0 sample (Kenney packs; see docs/AUDIO_PROVENANCE.md). Each event maps to its
// OWN distinct sample set (pools are disjoint across events — a distinct sound per event). The
// oscillator path is gone: this file no longer calls createOscillator for ANY of the 11 events,
// which e2e/sfx-samples.spec.ts proves by instrumenting AudioContext (a log alone is not enough —
// the real decoded assets are checked for non-silence and the beep path for absence).

export type SfxName =
  | "select"
  | "move"
  | "shot"
  | "hit"
  | "kill"
  | "hack"
  | "emp"
  | "deny"
  | "click"
  | "victory"
  | "defeat";

export interface AudioSettings {
  muted: boolean;
  volume: number; // 0..1
  reducedMotion: boolean;
}

// event -> candidate sample files (served from /sfx). Chosen so each event reads distinctly and no
// file is reused across events. Mapping rationale (all Kenney CC0):
//   shot    laserSmall / laserRetro        — sci-fi laser discharge, reads as "a round left the gun"
//   hit     impactMetal_001 / impactGeneric_light — metallic / soft impact, the round landing on a body
//   kill    explosionCrunch / impactBell_heavy    — bigger destructive stinger for an incapacitation
//   move    footstep_concrete / footstep_wood     — footsteps, the only locomotion cue
//   click   click_001 / click_002                 — neutral UI tick for phase hand-off / button press
//   select  confirmation_001 / confirmation_002   — soft UI confirm when an operative is picked
//   deny    error_001 / error_002                 — UI error, an illegal target/action
//   hack    computerNoise / glitch                — electronic intrusion, hacking a device
//   emp     forceField x2                          — a wide electromagnetic field pulse
//   victory bong / confirmation_004                — an ascending, positive result sting
//   defeat  lowFrequency_explosion / impactPlate_heavy — a descending, heavy failure sting
export const SFX_FILES: Record<SfxName, string[]> = {
  select: ["confirmation_001.wav", "confirmation_002.wav"],
  click: ["click_001.wav", "click_002.wav"],
  move: ["footstep_concrete_001.wav", "footstep_wood_001.wav"],
  shot: ["laserSmall_001.wav", "laserRetro_001.wav"],
  hit: ["impactMetal_001.wav", "impactGeneric_light_001.wav"],
  kill: ["explosionCrunch_000.wav", "impactBell_heavy_000.wav"],
  hack: ["computerNoise_001.wav", "glitch_001.wav"],
  emp: ["forceField_000.wav", "forceField_001.wav"],
  deny: ["error_001.wav", "error_002.wav"],
  victory: ["bong_001.wav", "confirmation_004.wav"],
  defeat: ["lowFrequency_explosion_000.wav", "impactPlate_heavy_000.wav"],
};

// Every legal /sfx file, so the oracle can decode the ACTUAL shipped bytes (not a name log).
export const SFX_FILE_LIST: string[] = Object.values(SFX_FILES).flat();

let ctx: AudioContext | null = null;
let settings: AudioSettings = { muted: false, volume: 0.7, reducedMotion: false };

// Accessibility settings persist across sessions (muted/volume/reducedMotion).
const AUDIO_KEY = "signal-breach-audio-v1";
try {
  const raw = globalThis.localStorage?.getItem(AUDIO_KEY);
  if (raw) settings = { ...settings, ...(JSON.parse(raw) as Partial<AudioSettings>) };
} catch {
  /* storage unavailable: fall back to defaults */
}

export function setAudio(s: Partial<AudioSettings>): void {
  settings = { ...settings, ...s };
  try {
    globalThis.localStorage?.setItem(AUDIO_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}
export function getAudio(): AudioSettings {
  return { ...settings };
}

// Read AudioContext dynamically so a test can instrument it (wrap createOscillator/createBufferSource)
// before the first play; a captured reference would hide the wrapper.
function ac(): AudioContext | null {
  if (settings.muted) return null;
  if (!ctx) {
    const AC = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") {
    try {
      void ctx.resume();
    } catch {
      /* ignore */
    }
  }
  return ctx;
}

// Decoded-asset cache keyed by url. A miss kicks off fetch -> decodeAudioData once and shares the
// resulting AudioBuffer (and its failure state) so repeat events do not refetch. Decoding is async,
// so play() may return before playback begins; that is fine for a non-blocking game cue.
const bufferCache = new Map<string, Promise<AudioBuffer | null>>();

function ensureBuffer(url: string): Promise<AudioBuffer | null> {
  const hit = bufferCache.get(url);
  if (hit) return hit;
  const c = ctx;
  const p = (async (): Promise<AudioBuffer | null> => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const bytes = await resp.arrayBuffer();
      if (bytes.byteLength === 0) return null;
      if (!c) return null;
      return await new Promise<AudioBuffer | null>((resolve) => {
        // Two-arg form for broad compatibility; onerror resolves null (fail safe).
        ctx!.decodeAudioData(
          bytes,
          (buf) => resolve(buf),
          () => resolve(null),
        );
      });
    } catch {
      return null;
    }
  })();
  bufferCache.set(url, p);
  return p;
}

function playUrl(url: string, gain: number): void {
  const c = ac();
  if (!c) return;
  void ensureBuffer(url).then((buf) => {
    if (!buf) return;
    const live = ac();
    if (!live) return;
    try {
      const src = live.createBufferSource();
      const g = live.createGain();
      src.buffer = buf;
      g.gain.value = Math.max(0.0001, Math.min(1, gain * settings.volume));
      src.connect(g);
      g.connect(live.destination);
      src.onended = () => {
        try {
          src.disconnect();
          g.disconnect();
        } catch {
          /* ignore */
        }
      };
      src.start();
    } catch {
      /* ignore: playback is best-effort, never fatal */
    }
  });
}

const variantCounter = new Map<string, number>();
function pickFile(name: SfxName): string {
  const pool = SFX_FILES[name];
  const i = variantCounter.get(name) ?? 0;
  variantCounter.set(name, i + 1);
  return pool[i % pool.length];
}

// ---- SFX (sample-based; NO oscillator is ever created here) -------------------------------

export function playSfx(name: SfxName): void {
  if (settings.muted) return;
  const file = pickFile(name);
  playUrl(`/sfx/${file}`, 0.9);
}

// ---- VOICE (robotic flite lines, one per unit name) ----------------------------------------

// The robotic lines are pre-generated with flite (8 kHz mono, licence-cleared):
//   flite -t "<Name> at your service" -o <Name>_at_your_service.wav
// Generated in-repo by scripts/gen-audio.sh from the AUTHORITATIVE unit names (see the provenance
// file) so the shipped set never drifts from state. At runtime we key on the unit's ACTUAL name,
// not a hardcoded lookup: playVoice(name) requests the matching asset for whatever name it is given.
export const VOICE_TEMPLATE = (name: string): string => `${name} at your service`;
export function voiceAsset(name: string): string {
  return `/voice/${name.replace(/[^A-Za-z0-9]/g, "_")}_at_your_service.wav`;
}

export interface VoiceReq {
  seq: number;
  unitName: string;
  line: string;
  asset: string;
  ts: number;
}
const voiceLog: VoiceReq[] = [];
let voiceSeq = 0;

// Record + play the robotic line for a selected unit. Fails safe if AudioContext is unavailable —
// it still records the requested line (so the oracle can assert the requested text even with no
// audio backend) but does nothing audible. Distinct per unit because the asset is keyed by name.
export function playVoice(unitName: string): void {
  const asset = voiceAsset(unitName);
  const entry: VoiceReq = {
    seq: voiceSeq++,
    unitName,
    line: VOICE_TEMPLATE(unitName),
    asset,
    ts: typeof performance !== "undefined" ? performance.now() : Date.now(),
  };
  voiceLog.push(entry);
  if (voiceLog.length > 200) voiceLog.shift();
  if (settings.muted) return;
  playUrl(asset, 0.95);
}

export function getVoiceLog(): VoiceReq[] {
  return voiceLog.map((v) => ({ ...v }));
}