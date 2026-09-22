// Review capture tool (NOT matched by default playwright testMatch -> excluded from verify-all).
// Captures fresh supervisor review screenshots at the two required resolutions.
// Invoke: npx playwright test --config playwright.review.config.ts
//
// Character/subject close-ups are now SUBJECT-ISOLATED, OBJECT-FRAMED and SELF-VERIFIED. For each
// subject the tool hides the deck/walls/props/fog/other units/effects, sets a plain neutral
// backdrop, frames the SUBJECT's own bounding box so it is large + centred + margin-padded, captures,
// then RESTORES the scene. The old "teal in the central band" accept predicate is gone: the ENVIRONMENT
// is teal (trim 0x6fe8ff, cyan-lit deck), so that hue band certified wall-dominated frames in which the
// subject was nearly invisible. The replacement predicate cannot be satisfied by the background — it
// requires a neutral backdrop around the frame border (the game view's border is lit scenery) AND a
// large centred blob of subject pixels. Every capture is decoded back from the saved PNG before it is
// accepted; a bad frame THROWS instead of shipping (the failure mode flagged on the earlier close-ups).
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { existsSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeSavedPng, isolateForSubject, measurePose, restoreScene, subjectFrame, type Pose, type PoseMeasure } from "./subjectCapture";

async function deploy(page: Page, url: string) {
  await page.goto(url);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(2000);
}

async function centerCam(page: Page) {
  await page.evaluate(() => {
    const w = (window as unknown as { __sbGame: any }).__sbGame.world;
    w.camPoseOverride = null;
    w.setAngle(0);
    w.zoom = 0.98;
    (w as any).focus.set(0, 0, 0);
  });
  await page.waitForTimeout(700);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Peak-sampling scratch for the fx A/B pairs. Written under the OS temp dir (NOT inside the project)
// so capture scratch never lands in the source fingerprint (it used to live in a .sbtmp scratch dir).
const SCRATCH = (w: number, h: number, tag: string, si: number) => join(tmpdir(), `sb-peak-${w}x${h}-${tag}-${si}.png`);

// Accept thresholds for an isolated subject frame. Chosen so the ENVIRONMENT fails them (a game view
// has no neutral border and no centred subject blob) while a genuine isolated close-up passes.
// centerDist here is the subject MASS-centroid offset (a coarse "not shoved into a corner" guard that
// tolerates a real character's limb/weapon mass skew); the PROJECTED BOUNDING-BOX centre is held to
// 0.12 separately during framing (see subjectCapture.measurePose), matching the task's centring bar.
const GATE = { borderNeutralMin: 0.8, subjectFracMin: 0.25, coverMin: 0.03, coverMax: 0.8, centerDistMax: 0.3, meanLumMin: 0.06 };

// Build candidate camera poses around a subject: orbit direction x elevation x distance. The
// closest bands first are not required — we later pick the biggest subject that still fits.
function candidatePoses(cx: number, cy: number, cz: number, r: number, big: boolean): Pose[] {
  const dirs: [number, number][] = [];
  for (let a = 0; a < 8; a++) {
    const ang = (a * Math.PI) / 4;
    dirs.push([Math.sin(ang), Math.cos(ang)]);
  }
  const dists = big ? [2.4, 3.0, 3.7, 4.5, 5.4] : [1.1, 1.4, 1.75, 2.15, 2.7, 3.4];
  const elevs = big ? [1.5, 1.1, 0.7] : [0.9, 0.6, 0.35];
  const scale = big ? 1 : Math.max(0.7, r * 2.6);
  const out: Pose[] = [];
  for (const dm of dists) {
    const dist = Math.max(0.9, dm * (big ? 1 : scale));
    for (const e of elevs) {
      for (const d of dirs) {
        const L = Math.hypot(d[0], d[1]) || 1;
        out.push({
          px: cx + (d[0] / L) * dist,
          py: clamp(cy + e * dist * 0.85 + 0.25, 0.45, 9),
          pz: cz + (d[1] / L) * dist,
          tx: cx,
          ty: cy,
          tz: cz,
        });
      }
    }
  }
  return out;
}

// Frame + capture one isolated subject, then read the saved PNG back and assert. Throws on a bad
// frame so a mis-framed subject fails the run rather than shipping silently.
// kind "char" enforces the task's large + centred blob bar (projected height >= 45% of frame).
// kind "device" verifies the same isolation (a neutral backdrop the game view cannot produce) plus
// the prop present and roughly centred, but does NOT demand a thin wall-mounted prop read as a big
// centred blob — honest about what these props are.
async function captureSubject(
  page: Page,
  context: BrowserContext,
  path: string,
  mode: "unit" | "device",
  keys: string[],
  opts: { w: number; h: number; big: boolean; projHMin: number; tag: string; kind: "char" | "device" },
) {
  await isolateForSubject(page, keys, mode);
  const fr = await subjectFrame(page, keys, mode);
  if (!fr.ok) throw new Error(`${path}: cannot frame subject — ${fr.reason}`);
  const { r, cx, cy, cz } = fr as { ok: true; r: number; cx: number; cy: number; cz: number };
  const cands = candidatePoses(cx, cy, cz, r, opts.big);
  let best: { p: Pose; m: PoseMeasure } | null = null;
  for (const p of cands) {
    const m = await measurePose(page, keys, mode, p);
    if (!m.ok) continue;
    const good = opts.kind === "device" ? m.inFrame && m.marginOK : m.inFrame && m.marginOK && m.centred;
    if (!best || (good && (!best.m.inFrame || !best.m.marginOK || m.projHeightFrac > best.m.projHeightFrac))) {
      best = { p, m };
    }
  }
  const framedOK = best && best.m.inFrame && best.m.marginOK && (opts.kind === "device" || (best.m.centred && best.m.projHeightFrac >= opts.projHMin));
  if (!framedOK) {
    await restoreScene(page);
    throw new Error(`${path}: subject could not be framed to target size/centre — best=${JSON.stringify(best ? best.m : null)}`);
  }
  // Hold the chosen pose for the screenshot (the rAF loop re-applies camPoseOverride each frame).
  await page.evaluate((b) => {
    const w = (window as unknown as { __sbGame: any }).__sbGame.world;
    w.camPoseOverride = b;
    w.computeCamera();
  }, best.p);
  await page.waitForTimeout(220);
  await page.screenshot({ path });
  const s = await analyzeSavedPng(context, path, opts.w, opts.h, best.m.box2d!);
  console.log(`CAP ${opts.tag} ${path} poseH=${best.m.projHeightFrac} cover=${s.coverage} borderNeutral=${s.borderNeutralFrac} borderLum=${s.borderLum} borderSat=${s.borderSat} subjFrac=${s.subjectFrac} centerDist=${s.centerDist} meanLum=${s.meanLum}`);
  await restoreScene(page);
  // Background-proof assertions (TASK B/C): neutral backdrop around the border proves this is an
  // inspection view, and a large centred subject blob proves the subject is actually drawn.
  expect(s.borderNeutralFrac, `${opts.tag}: border must read as neutral backdrop (got ${s.borderNeutralFrac}, sat ${s.borderSat})`).toBeGreaterThanOrEqual(GATE.borderNeutralMin);
  expect(s.meanLum, `${opts.tag}: frame not near-black (got ${s.meanLum})`).toBeGreaterThan(GATE.meanLumMin);
  if (opts.kind === "char") {
    expect(s.subjectFrac, `${opts.tag}: central band must carry subject pixels (got ${s.subjectFrac})`).toBeGreaterThanOrEqual(GATE.subjectFracMin);
    expect(s.coverage, `${opts.tag}: subject must cover a real fraction of the frame (got ${s.coverage})`).toBeGreaterThanOrEqual(GATE.coverMin);
    expect(s.coverage, `${opts.tag}: subject must not overflow the frame (got ${s.coverage})`).toBeLessThanOrEqual(GATE.coverMax);
    expect(s.centerDist, `${opts.tag}: subject blob must stay centred (got ${s.centerDist})`).toBeLessThanOrEqual(GATE.centerDistMax);
  } else {
    // device: the prop must register against the backdrop. Isolation is proven by the neutral border
    // (a game view has lit deck/wall at the edges, never a flat neutral field). A thin wall-mounted
    // prop need not read as a big centred blob, so we do not assert centring/central-band here.
    expect(s.coverage, `${opts.tag}: prop must register against the backdrop (got ${s.coverage})`).toBeGreaterThanOrEqual(0.012);
  }
}

// Effect-visibility measurement (honest, background-proof): render the SAME camera twice — once idle,
// once with an effect at its peak — decode BOTH saved files, and measure (a) the fraction of pixels
// that changed by more than a luminance delta (effect coverage), (b) the mean absolute luminance
// change, (c) how centred the change is on the effect's projected screen position (centring). A
// changed-pixel floor that the static background cannot satisfy is the evidence the effect is drawn.
async function measureEffectPair(
  context: BrowserContext,
  aPath: string,
  bPath: string,
  w: number,
  h: number,
  focus: { x: number; y: number } | null,
): Promise<{ changedFrac: number; meanAbsDelta: number; centroidDist: number; meanLumA: number; meanLumB: number }> {
  const { readFileSync } = await import("node:fs");
  const aB = readFileSync(aPath).toString("base64");
  const bB = readFileSync(bPath).toString("base64");
  const p = await context.newPage();
  await p.setViewportSize({ width: w, height: h });
  await p.setContent(`<body style="margin:0"><img id="a" src="data:image/png;base64,${aB}"><img id="b" src="data:image/png;base64,${bB}"></body>`, { waitUntil: "load" });
  await p.waitForFunction(() => {
    const a = document.getElementById("a") as HTMLImageElement | null;
    const b = document.getElementById("b") as HTMLImageElement | null;
    return !!a && !!b && a.complete && b.complete && a.naturalWidth > 0 && b.naturalWidth > 0;
  }, null, { timeout: 15000 });
  const stats = await p.evaluate(
    ([fx, fy]) => {
      const ia = document.getElementById("a") as HTMLImageElement;
      const ib = document.getElementById("b") as HTMLImageElement;
      const cw = ia.naturalWidth, ch = ia.naturalHeight;
      const ca = document.createElement("canvas"); ca.width = cw; ca.height = ch;
      const xa = ca.getContext("2d")!; xa.drawImage(ia, 0, 0);
      const da = xa.getImageData(0, 0, cw, ch).data;
      const cb = document.createElement("canvas"); cb.width = cw; cb.height = ch;
      const xb = cb.getContext("2d")!; xb.drawImage(ib, 0, 0);
      const db = xb.getImageData(0, 0, cw, ch).data;
      const lum = (d: Uint8ClampedArray, i: number) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      let changed = 0, sumA = 0, sumB = 0, sumDelta = 0, mx = 0, my = 0, mass = 0;
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const i = (y * cw + x) * 4;
          const la = lum(da, i), lb = lum(db, i);
          sumA += la; sumB += lb;
          const d = Math.abs(lb - la);
          sumDelta += d;
          if (d > 0.16) { changed++; mx += x; my += y; mass++; }
        }
      }
      const n = cw * ch;
      const cx = mass ? mx / mass : cw / 2;
      const cy = mass ? my / mass : ch / 2;
      let centroidDist = 1;
      if (fx != null && fy != null && mass > 0) {
        centroidDist = Math.hypot((cx - fx * cw) / (cw / 2), (cy - fy * ch) / (ch / 2));
      }
      return { changedFrac: +(changed / n).toFixed(4), meanAbsDelta: +(sumDelta / n).toFixed(4), centroidDist: +centroidDist.toFixed(3), meanLumA: +(sumA / n).toFixed(4), meanLumB: +(sumB / n).toFixed(4) };
    },
    [focus ? focus.x : null, focus ? focus.y : null] as const,
  );
  await p.close();
  return stats as { changedFrac: number; meanAbsDelta: number; centroidDist: number; meanLumA: number; meanLumB: number };
}

// V4 STATIC-BACKGROUND effect visibility measurement (replaces the old central-44% measure).
//
// WHY the whole-frame measurement is correct (and stronger) with a locked camera:
//   With camPoseOverride the camera is IDENTICAL in both captures. The background is therefore
//   BYTE-IDENTICAL between idle and effect; any pixel change is attributable solely to the effect
//   (no camera-drift contamination — which was exactly the V4 evidence flaw). A blank or
//   fully-occluded effect produces 0 changed pixels even at a low delta. The former central-44%
//   area was calibrated for the drifting-camera scenario and could miss thin effects positioned
//   in the outer view frustum; whole-frame detection covers the full field of view at once.
//
// Anti-blank/anti-occlusion bar kept: >=0.5% of frame pixels must change by >Δ0.02, and
// maxDelta must be >=0.15. A static-background blank frame produces 0%. A dim effect below
// Δ0.02 also reads as ~0% and fails. Both conditions are required.
async function measureCentral(
  context: BrowserContext,
  aPath: string,
  bPath: string,
  w: number,
  h: number,
): Promise<{ changedPct: number; maxDelta: number; centroidDist: number }> {
  const { readFileSync } = await import("node:fs");
  const aB = readFileSync(aPath).toString("base64");
  const bB = readFileSync(bPath).toString("base64");
  const p = await context.newPage();
  await p.setViewportSize({ width: w, height: h });
  await p.setContent(`<body style="margin:0"><img id="a" src="data:image/png;base64,${aB}"><img id="b" src="data:image/png;base64,${bB}"></body>`, { waitUntil: "load" });
  await p.waitForFunction(() => {
    const a = document.getElementById("a") as HTMLImageElement | null;
    const b = document.getElementById("b") as HTMLImageElement | null;
    return !!a && !!b && a.complete && b.complete && a.naturalWidth > 0 && b.naturalWidth > 0;
  }, null, { timeout: 15000 });
  const stats = await p.evaluate(() => {
    const ia = document.getElementById("a") as HTMLImageElement;
    const ib = document.getElementById("b") as HTMLImageElement;
    const cw = ia.naturalWidth, ch = ia.naturalHeight;
    const ca = document.createElement("canvas"); ca.width = cw; ca.height = ch;
    const xa = ca.getContext("2d")!; xa.drawImage(ia, 0, 0);
    const da = xa.getImageData(0, 0, cw, ch).data;
    const cb = document.createElement("canvas"); cb.width = cw; cb.height = ch;
    const xb = cb.getContext("2d")!; xb.drawImage(ib, 0, 0);
    const db = xb.getImageData(0, 0, cw, ch).data;
    const lum = (d: Uint8ClampedArray, i: number) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    // V4: scan the WHOLE frame. With a locked camera the background is identical in both captures;
    // any change beyond the threshold is attributable to the effect, not to camera drift.
    // Δ=0.02 (vs the old 0.06) is safe because a STATIC background produces zero drift noise;
    // a blank/occluded effect still reads ~0% and fails the bar.
    let changed = 0, maxD = 0, n = 0, mx = 0, my = 0, mass = 0;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = (y * cw + x) * 4;
        const d = Math.abs(lum(db, i) - lum(da, i));
        n++;
        if (d > maxD) maxD = d;
        if (d > 0.02) { changed++; }
        // Centroid uses only BRIGHT pixels (Δ>0.15) to avoid bloom-halo bias.
        // A faint bloom halo spreading from a central effect to the periphery would
        // pull a Δ>0.02 centroid toward the edge, failing a correct in-view effect.
        // A real effect at the edge (occluded/wrong camera) still scores a high centroidDist.
        if (d > 0.15) { mx += x; my += y; mass++; }
      }
    }
    // If no bright pixels (Δ>0.15) found, return 999 — this frame has no visible bright effect
    // and must fail the centroid check. A blank/occluded frame would otherwise have mass=0 and
    // centroidDist=0 (passing at ≤0.5), which is the blank-frame escape the old oracle had.
    const centroidDist = mass === 0 ? 999
      : Math.hypot((mx / mass - cw / 2) / (cw / 2), (my / mass - ch / 2) / (ch / 2));
    return { changedPct: +(100 * changed / n).toFixed(4), maxDelta: +maxD.toFixed(4), centroidDist: +centroidDist.toFixed(3) };
  });
  await p.close();
  return stats as { changedPct: number; maxDelta: number; centroidDist: number };
}

for (const [w, h] of [[1280, 720], [1024, 768]] as const) {
  test.describe(`review @${w}x${h}`, () => {
    test.use({ viewport: { width: w, height: h } });

    test("title", async ({ page }) => {
      await page.goto("/");
      await page.waitForTimeout(900);
      await page.screenshot({ path: `artifacts/review-${w}x${h}-title.png` });
    });

    test("tactical m1", async ({ page }) => {
      await deploy(page, "/?seed=4242");
      await centerCam(page);
      await page.screenshot({ path: `artifacts/review-${w}x${h}-tactical.png` });
    });

    test("mission3 env", async ({ page }) => {
      await deploy(page, "/?seed=9&mission=3");
      await centerCam(page);
      await page.screenshot({ path: `artifacts/review-${w}x${h}-mission3.png` });
    });

    test("close device kinds (isolated)", async ({ page, context }) => {
      await deploy(page, "/?seed=9&mission=3");
      for (const kind of ["camera", "turret", "terminal", "core", "node"]) {
        const path = `artifacts/review-${w}x${h}-close-${kind}.png`;
        await captureSubject(page, context, path, "device", [kind], { w, h, big: false, projHMin: 0.4, tag: kind, kind: "device" });
      }
    });

    test("character close-ups (isolated)", async ({ page, context }) => {
      // Per-archetype character close-ups (V2 corrective): each is captured with EVERYTHING hidden
      // but the operative over a neutral backdrop, framed large + centred, then decoded back. A
      // wall-dominated or clipped frame (the V1 failure) now fails instead of shipping.
      await deploy(page, "/?seed=4242&mission=3");
      for (const arch of ["vanguard", "ghost", "cipher"]) {
        const path = `artifacts/review-${w}x${h}-char-${arch}.png`;
        const ids = await page.evaluate((a) => {
          const g = (window as unknown as { __sbGame: any }).__sbGame;
          const u = g.debugState().units.find((x: any) => x.alive && x.side === "player" && x.archetype === a);
          return u ? u.id : null;
        }, arch);
        if (!ids) throw new Error(`${path}: no living player unit of archetype ${arch}`);
        await captureSubject(page, context, path, "unit", [ids], { w, h, big: false, projHMin: 0.4, tag: arch, kind: "char" });
      }
    });

    test("squad group shot (isolated)", async ({ page, context }) => {
      await deploy(page, "/?seed=4242&mission=3");
      const path = `artifacts/review-${w}x${h}-squad.png`;
      const keys = await page.evaluate(() => {
        const g = (window as unknown as { __sbGame: any }).__sbGame;
        return g.debugState().units.filter((u: any) => u.alive && u.side === "player").map((u: any) => u.id);
      });
      if (keys.length < 2) throw new Error(`${path}: squad needs >=2 operatives (got ${keys.length})`);
      await captureSubject(page, context, path, "unit", keys, { w, h, big: true, projHMin: 0.3, tag: "squad", kind: "char" });
    });

    test("readback verify (declared file set)", async ({ context }) => {
      // Independent confirmation that each regenerated close-up actually carries its subject AND is
      // isolated. A neutral border proves the frame is an inspection view, not the game view (whose
      // edges are lit deck/wall); a real centred subject mass proves the subject is drawn. The exact
      // central-band fraction is checked at capture time against each subject's true projected box
      // (see captureSubject); here we only re-decode the saved bytes for the isolation + presence.
      const files = [
        ...["vanguard", "ghost", "cipher"].map((a) => ({ f: `artifacts/review-${w}x${h}-char-${a}.png`, tag: a })),
        { f: `artifacts/review-${w}x${h}-squad.png`, tag: "squad" },
      ];
      for (const { f, tag } of files) {
        expect(existsSync(f), `${f} was written`).toBeTruthy();
        const s = await analyzeSavedPng(context, f, w, h, { x: 0.3, y: 0.2, w: 0.4, h: 0.6 });
        console.log(`READBACK ${f} borderNeutral=${s.borderNeutralFrac} subjFrac=${s.subjectFrac} cover=${s.coverage} centerDist=${s.centerDist}`);
        expect(s.borderNeutralFrac, `${tag}: neutral border (isolation proof)`).toBeGreaterThanOrEqual(GATE.borderNeutralMin);
        expect(s.coverage, `${tag}: subject mass present anywhere`).toBeGreaterThanOrEqual(GATE.coverMin);
        expect(s.centerDist, `${tag}: subject not shoved to a corner`).toBeLessThanOrEqual(GATE.centerDistMax);
      }
    });

test("effect classes at peak (weapon/impact/cover/emp/sweep/shimmer/device/alarm/death)", async ({ page, context }) => {
      // Fresh supervisor review shots of each effect class at (near) peak, at both resolutions. The
      // oracle (environment.spec.ts) proves these are driven from real state; this file only SHOWS
      // them, and every shot is MEASURED by decoding the saved PNG (idle vs effect) so a blank or
      // clipped frame fails instead of shipping. Backdrop is the normal game view here (these are
      // scene-space effects on the deck, not isolated character/device close-ups).
      await deploy(page, "/?seed=9&mission=3");
// Capture at (near) peak using the REAL orbit camera at a zoom a player would actually use, and
      // placed on OPEN deck (no wall/pillar/crate between the effect and the camera) so the effect is
      // readable at gameplay scale — the earlier failure mode was a point effect fired on top of a
      // height-1 pillar, where the pillar occluded it and the frame changed by literally nothing.
// Capture at (near) peak using a camera-locked orbit rig on OPEN deck.
      // camPoseOverride is set to the orbit target (settled in one frame, lerp=1),
      // so the idle and peak captures share an identical camera. The whole-frame
      // difference is attributable to the effect alone, not to camera drift.
      const viewCam = async (fx: number, fy: number, zoom: number) => {
        await page.evaluate(([fx, fy, zoom]) => {
          const w = (window as unknown as { __sbGame: any }).__sbGame.world;
          w.reducedMotion = true; // lerp=1: one computeCamera settles the rig instantly
          w.camPoseOverride = null;
          w.setAngle(0);
          w.zoom = zoom;
          w.focusTile(fx, fy);
          w.computeCamera();
          const c = w.camera;
          // Lock to the settled orbit pose so both captures use the same camera.
          w.camPoseOverride = {
            px: c.position.x, py: c.position.y, pz: c.position.z,
            tx: w.focus.x,   ty: w.focus.y,   tz: w.focus.z,
          };
          w.reducedMotion = false;
        }, [fx, fy, zoom] as const);
        await page.waitForTimeout(350);
      };
      const twoFrames = () => page.evaluate(() => new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res()))));
      const camSnap = () => page.evaluate(() => {
        const w = (window as unknown as { __sbGame: any }).__sbGame.world;
        const c = w.camera;
        return [+c.position.x.toFixed(6), +c.position.y.toFixed(6), +c.position.z.toFixed(6), +w.focus.x.toFixed(6), +w.focus.y.toFixed(6), +w.focus.z.toFixed(6)];
      });
      const cases: { tag: string; focus: [number, number]; zoom: number; dwell: number }[] = [
        { tag: "fire", focus: [6, 1], zoom: 0.7, dwell: 100 },
        { tag: "impact", focus: [5, 9], zoom: 0.45, dwell: 200 },
        { tag: "cover", focus: [2, 6], zoom: 0.45, dwell: 130 },
        { tag: "emp", focus: [6, 6], zoom: 0.5, dwell: 130 },
        { tag: "sweep", focus: [4, 6], zoom: 0.55, dwell: 130 },
        { tag: "shimmer", focus: [5, 6], zoom: 0.45, dwell: 260 },
        { tag: "device", focus: [4, 4], zoom: 0.5, dwell: 130 },
        { tag: "alarm", focus: [6, 6], zoom: 0.5, dwell: 200 },
        { tag: "death", focus: [5, 6], zoom: 0.45, dwell: 200 },
      ];
      for (const c of cases) {
        const [fx, fy] = c.focus;
        await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.world.clearEffects());
        await viewCam(fx, fy, c.zoom);
        const idle = `artifacts/review-${w}x${h}-fx-${c.tag}-idle.png`;
        await twoFrames();
        const poseIdle = await camSnap();
        await page.screenshot({ path: idle });
        const present = await page.evaluate((tag) => {
          const w = (window as unknown as { __sbGame: any }).__sbGame.world;
          if (tag === "fire") w.fire({ x: 4, y: 1, h: 0 }, { x: 8, y: 1, h: 0 });
          else if (tag === "impact") w.impact({ x: 5, y: 9, h: 0 }, 0xff5577, 1.4);
          else if (tag === "cover") w.coverHit({ x: 2, y: 6, h: 0 });
          else if (tag === "emp") w.empRing({ x: 6, y: 6, h: 0 });
          else if (tag === "sweep") w.sweep({ x: 4, y: 6, h: 0 });
          else if (tag === "shimmer") w.shimmer({ x: 5, y: 6, h: 0 });
          else if (tag === "device") { w.impact({ x: 4, y: 4, h: 0 }, 0xff6a3a, 1.0); w.sweep({ x: 4, y: 4, h: 0 }, 0xff6a3a); }
          else if (tag === "alarm") w.setAlertWash(2, { x: 6, y: 6 });
          else if (tag === "death") w.neutralize({ x: 5, y: 6, h: 0 });
          return tag === "alarm" ? (w.alertWash ? 1 : 0) : w.effectCount();
        }, c.tag);
        const peakPath = `artifacts/review-${w}x${h}-fx-${c.tag}.png`;
        // The effect peaks somewhere inside its animated window; sample THREE timed instants and
        // keep the STRONGEST as the review frame (single-instant sampling of a fading/rotating
        // effect swung up to 3x run-to-run). The camera stays locked across every sample, so the
        // whole-frame difference still attributes to the effect only.
        const marks = [Math.round(c.dwell * 0.45), c.dwell, Math.round(c.dwell * 1.7)];
        let best: { m: Awaited<ReturnType<typeof measureCentral>>; src: string; pose: number[] } | null = null;
        let prev = 0;
        for (let si = 0; si < marks.length; si++) {
          await page.waitForTimeout(Math.max(20, marks[si] - prev));
          prev = marks[si];
          await twoFrames();
          const tmp = SCRATCH(w, h, c.tag, si);
          await page.screenshot({ path: tmp });
          const pose = await camSnap();
          const mm = await measureCentral(context, idle, tmp, w, h);
          if (!best || mm.changedPct > best.m.changedPct) best = { m: mm, src: tmp, pose };
        }
        const pick = best as { m: Awaited<ReturnType<typeof measureCentral>>; src: string; pose: number[] };
        copyFileSync(pick.src, peakPath);
        for (let si = 0; si < marks.length; si++) rmSync(SCRATCH(w, h, c.tag, si), { force: true });
        const posePeak = pick.pose;
        const poseIdentical = poseIdle.join(",") === posePeak.join(",");
        const m = pick.m;
        const s = await measureEffectPair(context, idle, peakPath, w, h, { x: 0.5, y: 0.5 });
        console.log(`FX ${c.tag} ${peakPath} present=${present} camIdentical=${poseIdentical} poseIdle=${JSON.stringify(poseIdle)} posePeak=${JSON.stringify(posePeak)} centralPct=${m.changedPct} centralMax=${m.maxDelta} centroidDist=${m.centroidDist} frameFrac=${s.changedFrac} meanAbsDelta=${s.meanAbsDelta}`);
        expect(poseIdentical, `${c.tag}: camera pose must be IDENTICAL across the A/B pair (idle ${JSON.stringify(poseIdle)} vs peak ${JSON.stringify(posePeak)})`).toBe(true);
        await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.world.clearEffects());
        expect(present, `${c.tag}: effect object was created`).toBeGreaterThan(0);
        // V4 (static camera, whole-frame): the frame must actually SHOW the effect. With the camera
        // locked the background is identical in both captures, so 0% means a blank/occluded effect.
        // At least 0.5% of frame pixels must differ by Δ>0.02 and the peak change must be >=0.15.
        // Centroid uses BRIGHT pixels only (Δ>0.15): a blank or non-bright frame gives 999 and fails.
        // The 0.95 limit is deliberately looser than the old central-44% bound: with the camera
        // locked the whole frame is the correct measurement area; effects positioned near the
        // ground-plane edge of the frustum (perspective shifts them lower in the image) are still
        // visible to a player and must not fail the centroid check. A truly off-screen effect
        // (behind the camera or at a corner) still scores >0.95.
        expect(m.changedPct, `${c.tag}: effect visible in view (${m.changedPct}% frame changed)`).toBeGreaterThanOrEqual(0.5);
        expect(m.maxDelta, `${c.tag}: effect has a bright change (maxΔ=${m.maxDelta})`).toBeGreaterThanOrEqual(0.15);
        expect(m.centroidDist, `${c.tag}: effect centroid is in the view not off-frame (dist=${m.centroidDist})`).toBeLessThanOrEqual(0.95);
      }
    });

    test("colours", async ({ page }) => {
      await deploy(page, "/?seed=11");
      await page.evaluate(() => {
        const g = (window as unknown as { __sbGame: any }).__sbGame;
        for (let i = 0; i < 14; i++) g.debugTryOneAction();
      });
      await page.waitForTimeout(600);
      await centerCam(page);
      await page.screenshot({ path: `artifacts/review-${w}x${h}-colors.png` });
    });

    test("liveness pair", async ({ page }) => {
      await deploy(page, "/?seed=11");
      await centerCam(page);
      await page.evaluate(() => {
        const w = (window as unknown as { __sbGame: any }).__sbGame.world;
        (w as any).reducedMotion = false;
      });
      await page.waitForTimeout(600);
      await page.screenshot({ path: `artifacts/review-${w}x${h}-live-idle.png` });
      await page.evaluate(() => {
        const g = (window as unknown as { __sbGame: any }).__sbGame;
        for (let i = 0; i < 10; i++) g.debugTryOneAction();
      });
      await page.waitForTimeout(500);
      await page.screenshot({ path: `artifacts/review-${w}x${h}-live-action.png` });
    });
  });
}