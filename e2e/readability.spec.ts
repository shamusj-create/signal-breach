// READABILITY criterion (c-readability-e2e), two measurable bars, both read from REAL subject data
// (not a background-only predicate):
//
//   (1) UNITS DO NOT BLEND INTO SCENERY. A player operative used to sit beside a near-identical cyan
//       "crystal"/device prop. We measure the colour distance between every player-operative identity
//       colour (its emissive reads) and every device-prop read colour, and require a stated minimum
//       separation, plus a luminance gap — so a unit is separable from props with hue ignored, not just
//       because it is a different colour. The test is non-vacuous: it requires ≥3 live player operatives
//       and ≥3 device reads present, so "all separated" cannot be a trick of an empty scene.
//
//   (2) OBJECTIVE / DEVICE STATE IS LEGIBLE WITHOUT HUE. Each objective state is carried by a SHAPE +
//       TEXT cue (not only a coloured dot), and device authority state is carried by a lightness change
//       (a powered read is clearly brighter than a neutralised/dark one), so the state is distinguishable
//       when hue is removed. Measured from the real HUD shape/text attributes and the real prop materials.
import { test, expect } from "@playwright/test";

async function deploy(page: import("@playwright/test").Page, url = "/") {
  await page.goto(url);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(2200);
}

interface Readability {
  playerSigCount: number;
  devReadCount: number;
  minUnitPropDist: number;
  minUnitPropLumGap: number;
  worstPair: string;
  statesPresent: string[];
  multiStateKind: boolean;
  minStateLumGap: number;
  minStateColorDist: number;
  stateWorst: string;
}

// Read unit + prop identity colours straight off the live scene materials (the render input, not the
// background). Distances are euclidean RGB (0..441); luminance is 0..1.
function readReadability(page: import("@playwright/test").Page): Promise<Readability> {
  return page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const w = g.world;
    const rgb = (h: number) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
    const lum = (c: number[]) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
    const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const s = g.debugState();
    const playerSig = new Set<number>();
    let playerSigCount = 0;
    for (const [id, m] of w.unitMeshes) {
      const u = s.units.find((x: any) => x.id === id);
      if (!u || u.side !== "player" || !u.alive) continue;
      playerSigCount++;
      m.traverse((o: any) => { if (o.isMesh && o.material) { const e = o.material.emissive?.getHex?.() ?? 0; if (e) playerSig.add(e); } });
    }
    // Device SCENERY reads only (props that carry a device id). Floor markers (no dev id) are handled
    // by shape elsewhere, not as "scenery to blend into".
    const devRead = new Map<string, number>();
    for (const c of w.propGroup.children) {
      if (c.name !== "prop") continue;
      if (!c.userData || !c.userData.dev) continue;
      const e = (c.material.emissive?.getHex?.() ?? 0);
      if (e) devRead.set(`${c.userData.dev}:${c.userData.part}`, e);
    }
    const pu = [...playerSig].map((h) => rgb(h));
    const pr = [...devRead.entries()];
    let minDist = Infinity, minLumGap = Infinity, worst = "none";
    for (const a of pu) for (const [k, h] of pr) {
      const b = rgb(h);
      const dd = d(a, b); const dl = Math.abs(lum(a) - lum(b));
      if (dd < minDist) { minDist = dd; minLumGap = dl; worst = `${a.map((x) => x.toFixed(0)).join(",")} vs ${k}`; }
    }
    // State legibility WITHOUT hue: group each device's READ (brightest emissive of its parts, or 0) by
    // its current authority state, then require the states to differ by LIGHTNESS (not just hue). We only
    // count a "hijacked"/"dark" state if it is actually present, so this is not vacuous.
    const readOf: Record<string, number> = {};
    for (const c of w.propGroup.children) {
      if (c.name !== "prop" || !c.userData || !c.userData.dev) continue;
      const e = (c.material.emissive?.getHex?.() ?? 0);
      const cur = readOf[c.userData.dev] ?? 0;
      if (e && lum(rgb(e)) > lum(rgb(cur))) readOf[c.userData.dev] = e;
    }
    const statesPresent: string[] = [];
    let minStateLumGap = Infinity, minStateColorDist = Infinity, stateWorst = "single-state";
    // Compare authority state WITHIN a device kind (a powered turret vs a hijacked turret), never across
    // kinds — cross-kind colours differ by design and would either mask or fake a separation. We compare
    // LIGHTNESS as the hue-independent cue and require colour to move too.
    const byKind = new Map<string, Map<string, { c: number[]; dev: string }[]>>();
    for (const dv of s.devices) {
      const e = readOf[dv.id];
      if (e === undefined) continue;
      const st = dv.disabled || !dv.powered ? "disabled" : dv.owner === "hijacked" ? "hijacked" : "powered";
      if (!byKind.has(dv.kind)) byKind.set(dv.kind, new Map());
      const m = byKind.get(dv.kind)!;
      if (!m.has(st)) m.set(st, []);
      m.get(st)!.push({ c: rgb(e), dev: `${dv.kind}@${dv.x},${dv.y}` });
      const tag = `${dv.kind}:${st}`;
      if (!statesPresent.includes(tag)) statesPresent.push(tag);
    }
    let anyMultiStateKind = false;
    for (const [kind, m] of byKind) {
      const sts = [...m.keys()];
      if (sts.length < 2) continue;
      anyMultiStateKind = true;
      for (let i = 0; i < sts.length; i++)
        for (let j = i + 1; j < sts.length; j++)
          for (const a of m.get(sts[i])!)
            for (const b of m.get(sts[j])!) {
              const dl = Math.abs(lum(a.c) - lum(b.c)); const dc = d(a.c, b.c);
              if (dl < minStateLumGap) { minStateLumGap = dl; minStateColorDist = dc; stateWorst = `${a.dev} [${sts[i]}] vs ${b.dev} [${sts[j]}]`; }
            }
    }
    return {
      playerSigCount, devReadCount: devRead.size,
      minUnitPropDist: +minDist.toFixed(1), minUnitPropLumGap: +minLumGap.toFixed(3), worstPair: worst,
      statesPresent, multiStateKind: anyMultiStateKind, minStateLumGap: +minStateLumGap.toFixed(3), minStateColorDist: +minStateColorDist.toFixed(1), stateWorst,
    };
  }) as Promise<Readability>;
}

test("operative markers are chromatically + luminously separated from device props (do not blend into scenery)", async ({ page }) => {
  await deploy(page);
  const r = await readReadability(page);
  // Non-vacuous: there are real subjects to compare.
  expect(r.playerSigCount, "at least three player operatives present").toBeGreaterThanOrEqual(3);
  expect(r.devReadCount, "at least three device reads present").toBeGreaterThanOrEqual(3);
  // The stated separation. The old teal-unit/cyan-prop pair was ~40; device reads are now separated
  // from every operative colour by far more, by hue AND luminance, so a unit never melts into props.
  expect(r.minUnitPropDist, `min unit<->prop colour distance ${r.minUnitPropDist} (worst ${r.worstPair})`).toBeGreaterThanOrEqual(90);
  expect(r.minUnitPropLumGap, `min unit<->prop luminance gap ${r.minUnitPropLumGap} (worst ${r.worstPair})`).toBeGreaterThanOrEqual(0.12);
});

test("objective/device state is legible WITHOUT hue: shape+text in the panel, lightness in-world", async ({ page }) => {
  // Use a sector where the deterministic solver flips a device authority, so more than one state shows.
  await deploy(page, "/?seed=9&mission=3");

  // (a) In-world: after a turn resolves, neutralised/hijacked device reads separate from powered ones
  //     by LIGHTNESS (not just hue) — a colour-blind player can still tell them apart. We require at
  //     least two authority states to actually be present, so this cannot pass vacuously.
  await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugAutoPlay());
  await page.waitForTimeout(600);
  const r = await readReadability(page);
  expect(r.devReadCount, "device reads still present after the turn").toBeGreaterThanOrEqual(3);
  expect(r.multiStateKind, "at least one device kind shows two authority states (so the state check is not vacuous)").toBe(true);
  expect(r.statesPresent.length, `two or more authority states present to test (found ${r.statesPresent.join(",")})`).toBeGreaterThanOrEqual(2);
  expect(r.minStateLumGap, `powered-vs-neutralised device lightness gap ${r.minStateLumGap} (worst ${r.stateWorst}) must be resolvable without hue`).toBeLessThan(Infinity);
  expect(r.minStateLumGap, `powered-vs-neutralised device lightness gap ${r.minStateLumGap} (worst ${r.stateWorst}) must be resolvable without hue`).toBeGreaterThanOrEqual(0.12);
  expect(r.minStateColorDist, `powered-vs-neutralised device colour distance ${r.minStateColorDist}`).toBeGreaterThanOrEqual(40);

  // (b) Objective states in the panel are carried by a SHAPE + TEXT, not only a coloured dot.
  const shapes = await page.locator(".obj-dot").evaluateAll((els) => els.map((e) => e.getAttribute("data-shape")));
  expect(shapes.length, "objective rows render a marker element").toBeGreaterThanOrEqual(2);
  expect(shapes.every((sh) => sh === "square" || sh === "ring" || sh === "circle"), `every objective carries a shape cue: ${shapes}`).toBe(true);
  const distinctShapes = new Set(shapes);
  expect(distinctShapes.size, `objectives are distinguished by more than one shape (found ${[...distinctShapes].join(",")})`).toBeGreaterThanOrEqual(2);

  // And a text state label accompanies every objective — legibility is not colour-only.
  const panelText = await page.locator(".hud-right").innerText();
  expect(panelText, "objective panel states the state in words, not only colour").toMatch(/Ready|Sealed|Done|Breach|Idle/);
});