// Procedural Web Audio SFX. No external audio assets. Respects mute + volume + reduced motion.
// Fails safe if the AudioContext is unavailable.

export type SfxName = "select" | "move" | "shot" | "hit" | "kill" | "hack" | "emp" | "deny" | "click" | "victory" | "defeat";

export interface AudioSettings {
  muted: boolean;
  volume: number; // 0..1
  reducedMotion: boolean;
}

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
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
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

function tone(freq: number, dur: number, type: OscillatorType, gain: number, when = 0) {
  const c = ac();
  if (!c) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, c.currentTime + when);
  g.gain.setValueAtTime(0.0001, c.currentTime + when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * settings.volume), c.currentTime + when + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + when + dur);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(c.currentTime + when);
  osc.stop(c.currentTime + when + dur + 0.02);
}

export function playSfx(name: SfxName): void {
  if (settings.muted) return;
  switch (name) {
    case "select":
      tone(660, 0.06, "triangle", 0.18);
      break;
    case "click":
      tone(440, 0.04, "square", 0.1);
      break;
    case "move":
      tone(300, 0.08, "sine", 0.08);
      tone(380, 0.06, "sine", 0.06, 0.05);
      break;
    case "shot":
      tone(880, 0.05, "square", 0.16);
      tone(220, 0.09, "sawtooth", 0.12, 0.01);
      break;
    case "hit":
      tone(160, 0.08, "sawtooth", 0.18);
      break;
    case "kill":
      tone(320, 0.12, "sawtooth", 0.16);
      tone(120, 0.22, "square", 0.14, 0.05);
      break;
    case "hack":
      tone(520, 0.05, "square", 0.12);
      tone(720, 0.05, "square", 0.12, 0.06);
      tone(980, 0.08, "square", 0.12, 0.12);
      break;
    case "emp":
      tone(90, 0.25, "sawtooth", 0.18);
      break;
    case "deny":
      tone(150, 0.1, "square", 0.14);
      break;
    case "victory":
      [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, "triangle", 0.14, i * 0.14));
      break;
    case "defeat":
      [392, 330, 262, 196].forEach((f, i) => tone(f, 0.28, "sawtooth", 0.14, i * 0.18));
      break;
  }
}
