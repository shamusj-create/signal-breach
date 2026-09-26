// VOICE evidence (BROWSER). Selecting a player operative must request a robotic line reading
// "<UnitName> at your service", distinct per unit, and it must produce non-silent audio via a
// sample buffer (never the old oscillator path). The oracle compares the REQUESTED text against the
// authoritative unit name read straight from game state (not a hardcoded name table that could
// drift), checks the lines differ between units, and decodes the requested asset to prove non-silence.
import { test, expect } from "@playwright/test";

async function deploy(page: import("@playwright/test").Page, seed = 4242) {
  await page.goto(`/?seed=${seed}`);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForFunction(() => !!(window as unknown as { __sbAudio?: unknown }).__sbAudio, null, { timeout: 10000 });
  await page.waitForTimeout(400);
}

interface SelResult {
  unitId: string;
  authoritativeName: string;
  requestedLine: string;
  asset: string;
}

test("VOICE — selecting each operative requests its own 'at your service' line with non-silent audio", async ({ page }) => {
  await deploy(page);

  // Instrument AudioContext before any selection so we can prove the selection path never oscillates
  // and that it does create buffer sources (real audio attempted).
  await page.evaluate(() => {
    const probe = { osc: 0, buf: 0 };
    (window as unknown as { __probe: unknown }).__probe = probe;
    const proto: any = (window as unknown as { AudioContext: { prototype: any } }).AudioContext.prototype;
    const oo = proto.createOscillator;
    const ob = proto.createBufferSource;
    proto.createOscillator = function (this: unknown) {
      (window as unknown as { __probe: typeof probe }).__probe.osc++;
      return (oo as () => unknown).call(this);
    };
    proto.createBufferSource = function (this: unknown) {
      (window as unknown as { __probe: typeof probe }).__probe.buf++;
      return (ob as () => unknown).call(this);
    };
  });

  // Select each living player operative through the real selection path, capturing the requested line.
  const results = await page.evaluate(async () => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const audio = (window as unknown as { __sbAudio: any }).__sbAudio;
    const players = g.debugState().units.filter((u: any) => u.alive && u.side === "player");
    const out: { unitId: string; authoritativeName: string; requestedLine: string; asset: string }[] = [];
    for (const u of players) {
      const before = audio.voiceLog().length;
      g.select(u.id); // real selection path: playSfx('select') + playVoice(unit.name)
      const log = audio.voiceLog();
      const entry = log[log.length - 1];
      // Only count a request if this selection actually pushed a voice line.
      if (log.length > before && entry) {
        out.push({ unitId: u.id, authoritativeName: u.name, requestedLine: entry.line, asset: entry.asset });
      }
    }
    // let the async fetch→decode→play chain begin before reading counters
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    const probe = { ...(window as unknown as { __probe: { osc: number; buf: number } }).__probe };
    return { out, probe };
  });

  const sel = results.out as SelResult[];
  expect(sel.length, `expected a voice line for each player operative; got ${sel.length}`).toBeGreaterThanOrEqual(3);

  // (a) the requested text matches "<authoritative name> at your service" for EACH selected unit,
  //     compared to the name read straight from state (not a lookup table).
  for (const s of sel) {
    expect(s.requestedLine, `requested line for ${s.authoritativeName}`).toBe(`${s.authoritativeName} at your service`);
  }

  // (b) the lines differ between units.
  const lines = sel.map((s) => s.requestedLine);
  expect(new Set(lines).size, `voice lines differ per unit (${lines.join(" | ")})`).toBe(sel.length);

  // (c) the audio actually produced is non-silent: decode the requested asset + prove a buffer was
  //     created at runtime and NO oscillator was created (selection/voice is sample-based).
  const silent = await page.evaluate(async (list) => {
    const ctx = new AudioContext();
    const bad: string[] = [];
    for (const item of list) {
      try {
        const resp = await fetch(item.asset);
        if (!resp.ok) {
          bad.push(`${item.authoritativeName}: HTTP ${resp.status}`);
          continue;
        }
        const bytes = await resp.arrayBuffer();
        const buf = await ctx.decodeAudioData(bytes.slice(0));
        const ch = buf.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < ch.length; i++) {
          const a = Math.abs(ch[i]);
          if (a > peak) peak = a;
        }
        if (!(peak > 0.05 && ch.length > 512)) bad.push(`${item.authoritativeName}: silent/undecodable peak=${peak.toFixed(4)}`);
      } catch (e) {
        bad.push(`${item.authoritativeName}: decode threw ${String(e)}`);
      }
    }
    return bad;
  }, sel);
  expect(silent, `each requested voice line decodes to non-silent audio; failures=${JSON.stringify(silent)}`).toEqual([]);

  expect(results.probe.osc, `no oscillator during selection (voice/sfx are sample-based); osc=${results.probe.osc}`).toBe(0);
  expect(results.probe.buf, `selection created sample buffer sources; buf=${results.probe.buf}`).toBeGreaterThanOrEqual(sel.length);
});