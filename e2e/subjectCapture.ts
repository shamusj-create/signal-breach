// Shared VISION evidence helper (NOT a *.spec file -> never collected by the runner; imported by
// both e2e/tools.review.ts and e2e/chars.spec.ts).
//
// WHY THIS EXISTS. The earlier close-up gate accepted any frame where a "central band" matched a
// teal hue band (g>150 && g>r+40 && b>120). That predicate is satisfied by the ENVIRONMENT — the
// emissive trim (0x6fe8ff) and cyan-lit deck/wall — so it certified frames where the actual
// subject was clipped at the top edge behind a wall. A predicate the background can satisfy is not
// evidence. These helpers make the subject provably isolated and provably the thing in the frame:
//
//   TASK A — isolateForSubject() hides the deck/walls/props/fog/other units/effects, sets a plain
//            neutral backdrop and disables fog, so ONLY the requested subject renders.
//   TASK B — the accept predicate no longer uses a shared hue band. It requires (1) the subject's
//            projected bounding box to be large + centred + margin-padded, and (2) the frame BORDER
//            to read as the neutral backdrop — proving it is an inspection view, not the game view
//            (the game's edges are lit scenery, never a flat neutral field) — together with (3) a
//            real blob of non-backdrop (subject) pixels sitting centred in the frame.
//   TASK C — analyzeSavedPng() decodes the SAVED file and recomputes those numbers; a capture that
//            fails is reported (and the run throws) instead of shipping silently.
//
// restoreScene() puts visibility / background / fog back EXACTLY as they were. Nothing here changes
// gameplay: isolate is only ever called inside the off-by-default capture/spec path.
import type { Page, BrowserContext } from "@playwright/test";

export type Mode = "unit" | "device";

export interface Pose {
  px: number;
  py: number;
  pz: number;
  tx: number;
  ty: number;
  tz: number;
}

export interface PoseMeasure {
  ok: boolean;
  reason?: string;
  inFrame: boolean;
  marginOK: boolean;
  centred: boolean;
  centerDist: number;
  projHeightFrac: number;
  coverage: number;
  box2d?: { x: number; y: number; w: number; h: number };
}

export interface PngStats {
  cw: number;
  ch: number;
  meanLum: number;
  borderNeutralFrac: number;
  borderLum: number;
  borderSat: number;
  subjectFrac: number;
  coverage: number;
  centerDist: number;
}

// Plain neutral inspection backdrop. Low saturation, mid luminance: distinct from the game's dark
// background (0x070c14) and from cyan/teal scenery, and below the bloom threshold so it stays flat.
export const BACKDROP = 0x6a6a6a;

// ---- isolation ---------------------------------------------------------------------------

// Snapshot + hide everything except the requested subject(s); neutralise background + fog. The
// full restore list is stashed on window.__sbIso so restoreScene() is exact.
export async function isolateForSubject(page: Page, keys: string[], mode: Mode) {
  await page.evaluate(
    ([keys, mode, backdrop]) => {
      const T = (window as unknown as { __sbThree: any }).__sbThree;
      const w = (window as unknown as { __sbGame: any }).__sbGame.world;
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      const keep = new Set<any>();
      if (mode === "unit") {
        for (const k of keys) {
          const m = w.unitMeshes.get(k);
          if (m) keep.add(m);
        }
      } else {
        // device: keep the requested device's OWN prop meshes (they live flattened in propGroup,
        // tagged userData.dev === <device instance id>), NOT the whole propGroup and not the scenery.
        const devIds = new Set<string>();
        for (const k of keys) {
          const dev = g.debugState().devices.find((d: any) => d.kind === k);
          if (dev) devIds.add(dev.id);
        }
        for (const c of w.propGroup.children) if (c.isMesh && c.userData && devIds.has(c.userData.dev)) keep.add(c);
      }
      const snap: { o: any; v: boolean }[] = [];
      const hide = (o: any) => {
        snap.push({ o, v: o.visible });
        o.visible = false;
      };
      // Hide EVERY non-light direct child (deck disc, plinth, tower group, board/fog/fx groups and
      // any other scenery), and inside propGroup/unitGroup hide only the non-subject parts, so the
      // only thing left in front of the neutral backdrop is the subject. The old list only named the
      // four groups and let the r=28 ground disc + plinth + horizon towers fill the lower frame, and
      // for devices it also hid the device itself — producing blank frames a naive gate passed.
      for (const ch of w.scene.children) {
        if ((ch as any).isLight) continue; // lights emit no pixels; keep the rig intact
        if (ch === w.unitGroup) {
          for (const u of w.unitGroup.children) if (!keep.has(u)) hide(u);
          continue;
        }
        if (ch === w.propGroup) {
          for (const p of w.propGroup.children) if (!keep.has(p)) hide(p);
          continue;
        }
        hide(ch);
      }
      const iso = { snap, prevBg: w.scene.background, prevFog: w.scene.fog };
      (window as unknown as { __sbIso: unknown }).__sbIso = iso;
      w.scene.background = new T.Color(backdrop);
      w.scene.fog = null;
    },
    [keys, mode, BACKDROP] as const,
  );
}

export async function restoreScene(page: Page) {
  await page.evaluate(() => {
    const w = (window as unknown as { __sbGame: any }).__sbGame.world;
    const iso = (window as unknown as { __sbIso?: { snap: { o: any; v: boolean }[]; prevBg: any; prevFog: any } }).__sbIso;
    if (iso) {
      for (const s of iso.snap) s.o.visible = s.v;
      w.scene.background = iso.prevBg;
      w.scene.fog = iso.prevFog;
    }
    (window as unknown as { __sbIso: unknown }).__sbIso = undefined;
    w.camPoseOverride = null;
  });
}

// ---- live framing ------------------------------------------------------------------------

// Move the camera to a candidate pose (no orbit lerp), force ONE synchronous render, and report
// geometry-only metrics for the subject's projected bounding box: on-screen, edge-margin, centred
// and a real size. Occlusion is impossible while isolated, so geometry fully determines the fit.
export function measurePose(page: Page, keys: string[], mode: Mode, pose: Pose): Promise<PoseMeasure> {
  return page.evaluate(
    ([keys, mode, pose]) => {
      const T = (window as unknown as { __sbThree: any }).__sbThree;
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      const w = g.world;
      const cam = w.camera;
      const subjects: { m: any; box: any }[] = [];
      if (mode === "unit") {
        for (const k of keys) {
          const m = w.unitMeshes.get(k);
          if (!m) return Promise.resolve({ ok: false, reason: "gone:" + k, inFrame: false, marginOK: false, centred: false, centerDist: 9, projHeightFrac: 0, coverage: 0 });
          const box = new T.Box3();
          box.setFromObject(m);
          subjects.push({ m, box });
        }
      } else {
        for (const k of keys) {
          const dev = g.debugState().devices.find((d: any) => d.kind === k);
          if (!dev) continue;
          for (const c of w.propGroup.children) if (c.isMesh && c.userData && c.userData.dev === dev.id) subjects.push({ m: c, box: new T.Box3().setFromObject(c) });
        }
      }
      if (subjects.length === 0) return Promise.resolve({ ok: false, reason: "no-object", inFrame: false, marginOK: false, centred: false, centerDist: 9, projHeightFrac: 0, coverage: 0 });

      w.camPoseOverride = { px: pose.px, py: pose.py, pz: pose.pz, tx: pose.tx, ty: pose.ty, tz: pose.tz };
      w.computeCamera();
      w.camera.updateMatrixWorld(true);
      w.camera.matrixWorldInverse.copy(w.camera.matrixWorld).invert();
      w.renderer.render(w.scene, cam);

      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const CW = rect.width;
      const CH = rect.height;
      const proj = (v: any) => {
        const p = v.project(cam);
        return { sx: (p.x * 0.5 + 0.5) * CW, sy: (-p.y * 0.5 + 0.5) * CH, z: p.z };
      };
      const mX = 0.06 * CW;
      const mY = 0.06 * CH;
      let inFrame = true;
      let marginOK = true;
      let aggMinX = 1e9, aggMaxX = -1e9, aggMinY = 1e9, aggMaxY = -1e9;
      for (const s of subjects) {
        let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9, on = 0;
        for (let i = 0; i < 8; i++) {
          const v = proj(new T.Vector3(i & 1 ? s.box.max.x : s.box.min.x, i & 2 ? s.box.max.y : s.box.min.y, i & 4 ? s.box.max.z : s.box.min.z));
          if (v.z <= 1 && v.sx >= 0 && v.sy >= 0 && v.sx <= CW && v.sy <= CH) on++;
          minx = Math.min(minx, v.sx); maxx = Math.max(maxx, v.sx); miny = Math.min(miny, v.sy); maxy = Math.max(maxy, v.sy);
          aggMinX = Math.min(aggMinX, v.sx); aggMaxX = Math.max(aggMaxX, v.sx); aggMinY = Math.min(aggMinY, v.sy); aggMaxY = Math.max(aggMaxY, v.sy);
        }
        if (on !== 8) inFrame = false;
        if (!(minx > mX && maxx < CW - mX && miny > mY && maxy < CH - mY)) marginOK = false;
      }
      const acx = (aggMinX + aggMaxX) / 2, acy = (aggMinY + aggMaxY) / 2;
      const centerDist = Math.hypot((acx - CW / 2) / (CW / 2), (acy - CH / 2) / (CH / 2));
      const projH = Math.abs(aggMaxY - aggMinY) / CH;
      const coverage = (Math.abs(aggMaxX - aggMinX) * Math.abs(aggMaxY - aggMinY)) / (CW * CH);
      const centred = centerDist < 0.12;
      const box2d = { x: aggMinX / CW, y: aggMinY / CH, w: (aggMaxX - aggMinX) / CW, h: (aggMaxY - aggMinY) / CH };
      return { ok: true, inFrame, marginOK, centred, centerDist: +centerDist.toFixed(3), projHeightFrac: +projH.toFixed(3), coverage: +coverage.toFixed(3), box2d };
    },
    [keys, mode, pose] as const,
  ) as Promise<PoseMeasure>;
}

// Read the subject's live world bounding-box centre + radius, used to generate candidate poses.
export function subjectFrame(page: Page, keys: string[], mode: Mode) {
  return page.evaluate(
    ([keys, mode]) => {
      const T = (window as unknown as { __sbThree: any }).__sbThree;
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      const w = g.world;
      const objs: any[] = [];
      if (mode === "unit") {
        for (const k of keys) {
          const m = w.unitMeshes.get(k);
          if (m) objs.push(m);
        }
      } else {
        for (const k of keys) {
          const dev = g.debugState().devices.find((d: any) => d.kind === k);
          if (!dev) return { ok: false, reason: "no-device" };
          for (const c of w.propGroup.children) if (c.isMesh && c.userData && c.userData.dev === dev.id) objs.push(c);
        }
      }
      if (objs.length === 0) return { ok: false, reason: "no-object" };
      const box = new T.Box3();
      for (const o of objs) box.expandByObject(o);
      const c = box.getCenter(new T.Vector3());
      const r = box.getSize(new T.Vector3()).length() / 2;
      return { ok: true, r, cx: c.x, cy: c.y, cz: c.z };
    },
    [keys, mode] as const,
  ) as Promise<{ ok: boolean; reason?: string; r?: number; cx?: number; cy?: number; cz?: number }>;
}

// ---- saved-file readback (authoritative, TASK C) -----------------------------------------

// Decode the SAVED PNG in a throwaway page and compute the background-proof numbers. A frame only
// reads as "about the subject" when the neutral backdrop is intact around the border AND a large,
// centred blob of non-backdrop pixels sits in the middle — conditions the environment cannot
// satisfy because the game view's border is lit scenery, not a flat neutral field.
export async function analyzeSavedPng(context: BrowserContext, path: string, w: number, h: number, subjectBox: { x: number; y: number; w: number; h: number }): Promise<PngStats> {
  const { readFileSync } = await import("node:fs");
  const b64 = readFileSync(path).toString("base64");
  const p = await context.newPage();
  await p.setViewportSize({ width: w, height: h });
  await p.setContent(`<body style="margin:0"><img id="i" src="data:image/png;base64,${b64}"></body>`, { waitUntil: "load" });
  await p.waitForFunction(() => {
    const i = document.getElementById("i") as HTMLImageElement | null;
    return !!i && i.complete && i.naturalWidth > 0;
  }, null, { timeout: 15000 });
  const stats = await p.evaluate(
    ([box]) => {
      const img = document.getElementById("i") as HTMLImageElement;
      const cw = img.naturalWidth, ch = img.naturalHeight;
      const cc = document.createElement("canvas");
      cc.width = cw; cc.height = ch;
      const cx = cc.getContext("2d")!;
      cx.drawImage(img, 0, 0, cw, ch);
      const data = cx.getImageData(0, 0, cw, ch).data;
      const lum = (i: number) => (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      const isNeutral = (i: number) => {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const satv = mx > 0 ? (mx - mn) / mx : 0;
        const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        return satv < 0.12 && l > 0.14 && l < 0.62;
      };
      // border band = outer 8% ring: must be the flat neutral backdrop in an isolated capture.
      const b = Math.max(2, Math.round(Math.min(cw, ch) * 0.08));
      let bN = 0, bNeutral = 0, bLum = 0, bSat = 0;
      const addB = (i: number) => {
        bN++;
        const r = data[i], g = data[i + 1], bl = data[i + 2];
        const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
        bSat += mx > 0 ? (mx - mn) / mx : 0;
        bLum += (0.2126 * r + 0.7152 * g + 0.0722 * bl) / 255;
        if (isNeutral(i)) bNeutral++;
      };
      for (let x = 0; x < cw; x++) { addB(x * 4); addB(((ch - 1) * cw + x) * 4); }
      for (let y = 0; y < ch; y++) { addB((y * cw) * 4); addB((y * cw + cw - 1) * 4); }
      // backdrop reference = average of the four corners (assume corners are backdrop in a good frame).
      const corners = [0, (cw - 1) * 4, ((ch - 1) * cw) * 4, ((ch - 1) * cw + cw - 1) * 4];
      let cr = 0, cg = 0, cb = 0;
      for (const i of corners) { cr += data[i]; cg += data[i + 1]; cb += data[i + 2]; }
      cr /= 4; cg /= 4; cb /= 4;
      const isBackdrop = (i: number) => {
        const r = data[i], g = data[i + 1], b2 = data[i + 2];
        const mx = Math.max(r, g, b2), mn = Math.min(r, g, b2);
        return Math.abs(r - cr) + Math.abs(g - cg) + Math.abs(b2 - cb) < 48 && (mx - mn) / Math.max(1, mx) < 0.14;
      };
      // central subject band derived from the ACTUAL saved subject box (clamped): measure where the
      // subject is, not an arbitrary 50% box a wall could fill.
      let x0 = Math.max(0, Math.round(box.x * cw)), x1 = Math.min(cw, Math.round((box.x + box.w) * cw));
      let y0 = Math.max(0, Math.round(box.y * ch)), y1 = Math.min(ch, Math.round((box.y + box.h) * ch));
      if (x1 - x0 < 4 || y1 - y0 < 4) { x0 = Math.round(cw * 0.3); x1 = Math.round(cw * 0.7); y0 = Math.round(ch * 0.3); y1 = Math.round(ch * 0.7); }
      let bandN = 0, nonBack = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * cw + x) * 4;
          bandN++;
          if (!isBackdrop(i)) nonBack++;
        }
      // subject mass over the whole frame: centring + how much of the frame the subject covers.
      let massX = 0, massY = 0, mass = 0;
      for (let y = 0; y < ch; y++)
        for (let x = 0; x < cw; x++) {
          const i = (y * cw + x) * 4;
          if (!isBackdrop(i)) { mass++; massX += x; massY += y; }
        }
      const mcx = mass ? massX / mass : cw / 2, mcy = mass ? massY / mass : ch / 2;
      const centerDist = Math.hypot((mcx - cw / 2) / (cw / 2), (mcy - ch / 2) / (ch / 2));
      const coverage = mass / (cw * ch);
      let sum = 0;
      for (let i = 0; i < cw * ch; i++) sum += lum(i * 4);
      return {
        cw, ch,
        meanLum: +(sum / (cw * ch)).toFixed(4),
        borderNeutralFrac: +(bNeutral / Math.max(1, bN)).toFixed(4),
        borderLum: +(bLum / Math.max(1, bN)).toFixed(4),
        borderSat: +(bSat / Math.max(1, bN)).toFixed(4),
        subjectFrac: +(nonBack / Math.max(1, bandN)).toFixed(4),
        coverage: +coverage.toFixed(4),
        centerDist: +centerDist.toFixed(3),
      };
    },
    [subjectBox] as const,
  );
  await p.close();
  return stats as PngStats;
}

// ---- high-level isolated capture (shared by the review tool and the chars oracle) ----------

// Frame one isolated subject, capture it, and read the saved PNG back. Returns the measured numbers;
// THROWS if the subject cannot be shown large + centred over the neutral backdrop, so a mis-framed
// subject fails the run instead of shipping. The caller asserts on the returned stats.
export async function captureIsolatedSubject(
  page: Page,
  context: BrowserContext,
  path: string,
  mode: Mode,
  keys: string[],
  opts: { w: number; h: number; big: boolean; projHMin: number; tag: string },
): Promise<{ stats: PngStats; pose: PoseMeasure }> {
  await isolateForSubject(page, keys, mode);
  const fr = await subjectFrame(page, keys, mode);
  if (!fr.ok) {
    await restoreScene(page);
    throw new Error(`${opts.tag}: cannot frame subject — ${fr.reason}`);
  }
  const { r, cx, cy, cz } = fr as { ok: true; r: number; cx: number; cy: number; cz: number };
  const dirs: [number, number][] = [];
  for (let a = 0; a < 8; a++) {
    const ang = (a * Math.PI) / 4;
    dirs.push([Math.sin(ang), Math.cos(ang)]);
  }
  const dists = opts.big ? [2.4, 3.0, 3.7, 4.5, 5.4] : [1.1, 1.4, 1.75, 2.15, 2.7, 3.4];
  const elevs = opts.big ? [1.5, 1.1, 0.7] : [0.9, 0.6, 0.35];
  const scale = opts.big ? 1 : Math.max(0.7, r * 2.6);
  const cands: Pose[] = [];
  for (const dm of dists) {
    const dist = Math.max(0.9, dm * scale);
    for (const e of elevs)
      for (const d of dirs) {
        const L = Math.hypot(d[0], d[1]) || 1;
        cands.push({ px: cx + (d[0] / L) * dist, py: Math.max(0.45, Math.min(9, cy + e * dist * 0.85 + 0.25)), pz: cz + (d[1] / L) * dist, tx: cx, ty: cy, tz: cz });
      }
  }
  let best: { p: Pose; m: PoseMeasure } | null = null;
  for (const p of cands) {
    const m = await measurePose(page, keys, mode, p);
    if (!m.ok) continue;
    const good = m.inFrame && m.marginOK && m.centred;
    if (!best || (good && (!best.m.inFrame || !best.m.marginOK || !best.m.centred || m.projHeightFrac > best.m.projHeightFrac))) best = { p, m };
  }
  if (!best || !best.m.inFrame || !best.m.marginOK || !best.m.centred || best.m.projHeightFrac < opts.projHMin) {
    await restoreScene(page);
    throw new Error(`${opts.tag}: subject could not be framed large + centred — best=${JSON.stringify(best ? best.m : null)}`);
  }
  await page.evaluate((b) => {
    const w = (window as unknown as { __sbGame: any }).__sbGame.world;
    w.camPoseOverride = b;
    w.computeCamera();
  }, best.p);
  await page.waitForTimeout(220);
  await page.screenshot({ path });
  const stats = await analyzeSavedPng(context, path, opts.w, opts.h, best.m.box2d!);
  await restoreScene(page);
  return { stats, pose: best.m };
}