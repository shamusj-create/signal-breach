// Shared VISION evidence helper (NOT a *.spec file -> never collected by the runner).
//
// WHY THIS EXISTS. A hue/luminance band predicate can be satisfied by the ENVIRONMENT (the lit deck /
// emissive trim), so "something changed somewhere in the middle of the frame" is not evidence that a
// specific FEATURE rendered. measureAbDelta compares two SAVED PNGs taken from an IDENTICAL, camera-
// locked pose, and reports the mean absolute per-channel change in a small window centred on each
// named tile. Because the only intended difference between the two frames is the feature's markers
// (camera locked, idle animation frozen via reduced-motion, no live combat), a control tile that must
// NOT light is required to read ~zero. That "lit tiles changed, dark tiles did not" pairing is the
// thing the background cannot satisfy on its own. Numbers are reported so the operator can judge
// appearance; the assertions are on measured numbers, never on a live-canvas predicate.
import type { BrowserContext } from "@playwright/test";

export interface AbPoint {
  label: string;
  // normalised canvas coords (fraction of the canvas rect, 0..1)
  nx: number;
  ny: number;
}

export interface AbResult {
  label: string;
  nx: number;
  ny: number;
  delta: number; // mean absolute per-channel diff over the window, /255 (0 = identical frames)
}

// meanAbsDelta over a square window of half-side rFrac*min(W,H) centred at each point.
export async function measureAbDelta(
  context: BrowserContext,
  pathA: string,
  pathB: string,
  pts: AbPoint[],
  rFrac: number,
): Promise<AbResult[]> {
  const { readFileSync } = await import("node:fs");
  const a64 = readFileSync(pathA).toString("base64");
  const b64 = readFileSync(pathB).toString("base64");
  const p = await context.newPage();
  await p.setContent(`<body style="margin:0"><img id="a" src="data:image/png;base64,${a64}"><img id="b" src="data:image/png;base64,${b64}" style="position:absolute;left:0;top:0"></body>`, { waitUntil: "load" });
  await p.waitForFunction(() => {
    const a = document.getElementById("a") as HTMLImageElement | null;
    const b = document.getElementById("b") as HTMLImageElement | null;
    return !!a && !!b && a.complete && b.complete && a.naturalWidth > 0 && b.naturalWidth > 0;
  }, null, { timeout: 20000 });
  const res = await p.evaluate(
    ([pts, r]) => {
      const A = document.getElementById("a") as HTMLImageElement;
      const B = document.getElementById("b") as HTMLImageElement;
      const W = A.naturalWidth;
      const H = A.naturalHeight;
      const ca = document.createElement("canvas");
      ca.width = W;
      ca.height = H;
      const xa = ca.getContext("2d")!;
      xa.drawImage(A, 0, 0, W, H);
      const da = xa.getImageData(0, 0, W, H).data;
      const cb = document.createElement("canvas");
      cb.width = W;
      cb.height = H;
      const xb = cb.getContext("2d")!;
      xb.drawImage(B, 0, 0, W, H);
      const db = xb.getImageData(0, 0, W, H).data;
      const R = Math.max(2, Math.round(r * Math.min(W, H)));
      return pts.map((pt) => {
        const cxp = Math.round(pt.nx * W);
        const cyp = Math.round(pt.ny * H);
        let sum = 0;
        let n = 0;
        for (let dy = -R; dy <= R; dy++)
          for (let dx = -R; dx <= R; dx++) {
            const x = cxp + dx;
            const y = cyp + dy;
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            const i = (y * W + x) * 4;
            sum += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
            n += 3;
          }
        return { label: pt.label, nx: pt.nx, ny: pt.ny, delta: +(n ? sum / n / 255 : 0).toFixed(4) };
      });
    },
    [pts, rFrac] as const,
  );
  await p.close();
  return res as AbResult[];
}

// Freeze the scene for an A/B pair: disable idle motion, lock the camera to a fixed overhead pose, and
// force one synchronous render. Both frames of a pair reuse the SAME pose, so any per-tile delta is
// the feature under test, not camera drift. Nothing here touches rules.
export async function lockOverhead(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    g.world.reducedMotion = true;
    g.world.shake = 0;
    g.world.camPoseOverride = { px: 0, py: 20, pz: 0.001, tx: 0, ty: 0, tz: 0 };
    g.world.computeCamera();
  });
  await page.waitForTimeout(250);
}

export interface Proj {
  label: string;
  nx: number;
  ny: number;
  ok: boolean;
}

// Project a list of {label,x,y} tile centres to normalised canvas coords through the CURRENT camera.
// ok=false means the tile centre is off-screen (excluded from the A/B assertion, not silently passed).
export function projectTiles(
  page: import("@playwright/test").Page,
  tiles: { label: string; x: number; y: number }[],
): Promise<Proj[]> {
  return page.evaluate(
    ([tiles]) => {
      const T = (window as unknown as { __sbThree: any }).__sbThree;
      const w = (window as unknown as { __sbGame: any }).__sbGame.world;
      const cam = w.camera;
      cam.updateMatrixWorld(true);
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      return tiles.map((t) => {
        const v = new T.Vector3(t.x - 6.5, 0.45, t.y - 6.5);
        const p = v.project(cam);
        const nx = (p.x * 0.5 + 0.5);
        const ny = (-p.y * 0.5 + 0.5);
        const ok = p.z < 1 && nx > 0.02 && nx < 0.98 && ny > 0.02 && ny < 0.98;
        void rect;
        return { label: t.label, nx: +nx.toFixed(4), ny: +ny.toFixed(4), ok };
      });
    },
    [tiles] as const,
  ) as Promise<Proj[]>;
}