// Shared VISION evidence helper (not a *.spec file -> never collected by the test runner).
// Reads the LIVE canvas and measures rendering-quality signals instead of mere presence:
// mean luminance, percentile dynamic range, near-black fraction, and shadowed-vs-lit floor
// contrast probed one tile down-shadow from a blocker against a perpendicular lit reference.
// Thresholds are deliberately tolerant; calibration lives in e2e/tools.probe.ts.
import type { Page } from "@playwright/test";

export interface RenderQuality {
  passes: string;
  keyShadow: string;
  meanLum: number;
  dynRange: number;
  nearBlackFrac: number;
  pairs: { shadow: number; lit: number; sx: number; sz: number }[];
  perf: { fps: number; drawCalls: number; tris: number; meshes: number; shadows: number };
}

export async function measureRenderQuality(page: Page): Promise<RenderQuality> {
  return page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const w = g.world;
    const T = (window as unknown as { __sbThree: any }).__sbThree;
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const cc = document.createElement("canvas");
    cc.width = canvas.width;
    cc.height = canvas.height;
    const cx = cc.getContext("2d")!;
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        cx.drawImage(img, 0, 0);
        const done = (() => {
          const data = cx.getImageData(0, 0, cc.width, cc.height).data;
          const n = cc.width * cc.height;
          const lums = new Float32Array(n);
          for (let i = 0; i < n; i++) {
            lums[i] = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255;
          }
          let sum = 0;
          let nearBlack = 0;
          for (let i = 0; i < n; i++) {
            sum += lums[i];
            if (lums[i] < 0.04) nearBlack++;
          }
          const sorted = Float32Array.from(lums).sort();
          const pct = (p: number) => sorted[Math.min(n - 1, Math.floor(n * p))];
          const win = (px: number, py: number, r: number) => {
            let s = 0;
            let c = 0;
            for (let dy = -r; dy <= r; dy++)
              for (let dx = -r; dx <= r; dx++) {
                const x = Math.round(px + dx);
                const y = Math.round(py + dy);
                if (x < 0 || y < 0 || x >= cc.width || y >= cc.height) continue;
                s += lums[y * cc.width + x];
                c++;
              }
            return c ? s / c : -1;
          };
          let key: any = null;
          w.scene.traverse((o: any) => {
            if (o.isDirectionalLight && o.castShadow) key = o;
          });
          const rect = canvas.getBoundingClientRect();
          const dpr = canvas.width / rect.width;
          const proj = (x: number, z: number) => {
            const v = new T.Vector3(x, 0.14, z);
            v.project(w.camera);
            const px = Math.round((v.x * 0.5 + 0.5) * rect.width * dpr);
            const py = Math.round((-v.y * 0.5 + 0.5) * rect.height * dpr);
            if (px < 4 || py < 4 || px >= cc.width - 4 || py >= cc.height - 4 || v.z > 1) return null;
            return { px, py };
          };
          const pairs: { shadow: number; lit: number; sx: number; sz: number }[] = [];
          if (key) {
            const lx = key.position.x;
            const lz = key.position.z;
            const sl = Math.hypot(lx, lz);
            const sdx = -lx / sl;
            const sdz = -lz / sl;
            const pl = Math.hypot(sdz, -sdx) || 1;
            const perpx = sdz / pl;
            const perpz = -sdx / pl;
            const s = g.debugState();
            const occupied = new Set(s.units.filter((u: any) => u.alive).map((u: any) => `${u.pos.x},${u.pos.y}`));
            const isFloor = (x: number, y: number) => {
              if (x < 0 || y < 0 || x >= 14 || y >= 14) return false;
              const t = s.tiles[y * 14 + x];
              return t && t.terrain !== "wall" && t.terrain !== "pillar" && !occupied.has(`${x},${y}`) && s.vis[y * 14 + x] === 2;
            };
            for (const t of s.tiles) {
              if (pairs.length >= 8) break;
              if (t.terrain !== "wall" && t.terrain !== "crate") continue;
              const cx0 = t.x - 6.5;
              const cz0 = t.y - 6.5;
              const shx = cx0 + sdx * 0.75;
              const shz = cz0 + sdz * 0.75;
              const ltx = shx + perpx * 1.5;
              const ltz = shz + perpz * 1.5;
              const shTile = { x: Math.round(shx + 6.5), y: Math.round(shz + 6.5) };
              const ltTile = { x: Math.round(ltx + 6.5), y: Math.round(ltz + 6.5) };
              if (!isFloor(shTile.x, shTile.y) || !isFloor(ltTile.x, ltTile.y)) continue;
              const hasBlockerNear = (x: number, y: number) => {
                for (let dy = -1; dy <= 1; dy++)
                  for (let dx = -1; dx <= 1; dx++) {
                    const tt = s.tiles[(y + dy) * 14 + (x + dx)];
                    if (tt && (tt.terrain === "wall" || tt.terrain === "pillar")) return true;
                  }
                return false;
              };
              if (hasBlockerNear(ltTile.x, ltTile.y)) continue;
              const shPt = proj(shx, shz);
              const ltPt = proj(ltx, ltz);
              if (!shPt || !ltPt) continue;
              const shadow = win(shPt.px, shPt.py, 2);
              const lit = win(ltPt.px, ltPt.py, 2);
              if (shadow < 0 || lit < 0) continue;
              pairs.push({ shadow: +shadow.toFixed(4), lit: +lit.toFixed(4), sx: t.x, sz: t.y });
            }
          }
          return {
            passes: w.composer ? w.composer.passes.map((p: any) => p.constructor.name).join(",") : "none",
            keyShadow: key ? `${key.castShadow}:${key.shadow.mapSize.x}:${key.shadow.map ? 1 : 0}` : "none",
            meanLum: +(sum / n).toFixed(4),
            dynRange: +(pct(0.95) - pct(0.05)).toFixed(4),
            nearBlackFrac: +(nearBlack / n).toFixed(4),
            pairs,
            perf: w.perf(),
          };
        })();
        resolve(done);
      };
      img.onerror = () => resolve({ passes: "unreadable", keyShadow: "unreadable", meanLum: -1, dynRange: -1, nearBlackFrac: -1, pairs: [], perf: { fps: 0, drawCalls: 0, tris: 0, meshes: 0, shadows: 0 } });
      img.src = canvas.toDataURL("image/png");
    });
  }) as Promise<RenderQuality>;
}