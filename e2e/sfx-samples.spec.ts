// SFX evidence (BROWSER). Sean's feedback: kill the procedural beeps, use real CC0 samples, one
// DISTINCT sound per event. Three independent claims, none of which reads the implementing accessor
// back to itself:
//   1. DISTINCTNESS — the event→sample map is a partition: no sample is shared between two events.
//   2. NON-SILENCE — the ACTUAL shipped bytes decode to audio with real amplitude (not a silent
//      buffer, and not a correct-looking cue name with no audio behind it).
//   3. OSCILLATOR-GONE — with AudioContext instrumented, NO oscillator node is created when every
//      event is played (the beep path is physically gone), while buffer sources ARE created (samples
//      play). Driven through the real playSfx path, not a cue log.
import { test, expect } from "@playwright/test";

const EVENTS = ["select", "move", "shot", "hit", "kill", "hack", "emp", "deny", "click", "victory", "defeat"] as const;

async function deploy(page: import("@playwright/test").Page, seed = 4242) {
  await page.goto(`/?seed=${seed}`);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForFunction(() => !!(window as unknown as { __sbAudio?: unknown }).__sbAudio, null, { timeout: 10000 });
  await page.waitForTimeout(400);
}

test("SFX-1 — every event maps to a DISTINCT, non-silent sample (checked against the decoded bytes)", async ({ page }) => {
  await deploy(page);
  const res = await page.evaluate(async () => {
    const audio = (window as unknown as { __sbAudio: any }).__sbAudio;
    const map: Record<string, string[]> = audio.map;
    // Claim 1: the pools are disjoint — flatten and compare against the per-event sum.
    const union = new Set<string>();
    const overlaps: string[] = [];
    for (const ev of Object.keys(map)) for (const f of map[ev]) {
      if (union.has(f)) overlaps.push(`${ev}:${f}`);
      union.add(f);
    }
    // Claim 2: decode every shipped file and measure amplitude. A silent/undecodable file fails.
    const ctx = new AudioContext();
    const decodePeak = async (file: string): Promise<{ ok: boolean; peak: number; len: number }> => {
      try {
        const resp = await fetch(`/sfx/${file}`);
        if (!resp.ok) return { ok: false, peak: 0, len: 0 };
        const bytes = await resp.arrayBuffer();
        const buf = await ctx.decodeAudioData(bytes.slice(0));
        const ch = buf.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < ch.length; i++) {
          const a = Math.abs(ch[i]);
          if (a > peak) peak = a;
        }
        return { ok: true, peak: +peak.toFixed(4), len: ch.length };
      } catch {
        return { ok: false, peak: 0, len: 0 };
      }
    };
    const perFile: Record<string, { ok: boolean; peak: number; len: number }> = {};
    for (const f of union) perFile[f] = await decodePeak(f);
    return { events: Object.keys(map), overlaps, perFile, unionCount: union.size };
  });

  expect(res.events.length, "11 events mapped").toBe(11);
  expect(res.overlaps, `no sample shared across events (${res.overlaps.join(", ")})`).toEqual([]);
  // every distinct file decodes and is non-silent
  const silent = Object.entries(res.perFile).filter(([, v]) => !v.ok || v.peak < 0.05 || v.len < 512);
  expect(silent, `non-silent decoded audio for every sample; failures=${JSON.stringify(silent)}`).toEqual([]);
});

test("SFX-2 — playing every event creates ZERO oscillator nodes but DOES play samples (beep path gone)", async ({ page }) => {
  await deploy(page);
  const res = await page.evaluate(async () => {
    const audio = (window as unknown as { __sbAudio: any }).__sbAudio;
    // Instrument BEFORE any play: count oscillator + buffer-source creations on every AudioContext.
    const probe = { osc: 0, buf: 0 };
    (window as unknown as { __probe: unknown }).__probe = probe;
    const proto: any = (window as unknown as { AudioContext: { prototype: any } }).AudioContext.prototype;
    const origOsc = proto.createOscillator;
    const origBuf = proto.createBufferSource;
    proto.createOscillator = function (this: unknown) {
      (window as unknown as { __probe: typeof probe }).__probe.osc++;
      return (origOsc as () => unknown).call(this);
    };
    proto.createBufferSource = function (this: unknown) {
      (window as unknown as { __probe: typeof probe }).__probe.buf++;
      return (origBuf as () => unknown).call(this);
    };
    // Trigger every event through the real playSfx path.
    for (const ev of ["select", "move", "shot", "hit", "kill", "hack", "emp", "deny", "click", "victory", "defeat"]) {
      audio.sfx(ev as never);
    }
    // Allow the async fetch→decode→play chain to settle (bounded; not a frame-count).
    await new Promise<void>((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        if ((window as unknown as { __probe: typeof probe }).__probe.buf >= 11 || performance.now() - t0 > 8000) resolve();
        else setTimeout(tick, 40);
      };
      tick();
    });
    const out = { ...probe };
    proto.createOscillator = origOsc;
    proto.createBufferSource = origBuf;
    return out;
  });

  expect(res.osc, `no oscillator node created for ANY event (beep path gone); osc=${res.osc}`).toBe(0);
  expect(res.buf, `each event played a sample buffer (buffer sources created); buf=${res.buf}`).toBeGreaterThanOrEqual(11);
});