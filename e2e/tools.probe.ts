// Visual FOUNDATION probe (tool only, NOT matched by default playwright testMatch).
// Measures mean luminance, percentile dynamic range and shadow-vs-lit contrast from the live
// canvas at fixed camera states, for A/B verification of render changes.
// Invoke: npx playwright test --config playwright.probe.config.ts
import { test } from "@playwright/test";

async function deploy(page: import("@playwright/test").Page, url: string) {
  await page.goto(url);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(2000);
}

function measure(page: import("@playwright/test").Page) {
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
        // window mean luminance around a canvas pixel, radius r
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
        // shadow-vs-lit pairs from wall/crate tiles + key light direction
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
          // lateral reference: perpendicular to shadow direction (same lit row, no blocker)
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
            // shadow probe: inside the blocker's shadow cone (pure along shadow direction,
            // lateral offset 0); reference: same row, 1.5 tiles perpendicular (unshadowed floor).
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
        const composerPasses = w.composer ? w.composer.passes.map((p: any) => p.constructor.name).join(",") : "none";
        return {
          viewport: `${cc.width}x${cc.height}@dpr${(cc.width / rect.width).toFixed(2)}`,
          meanLum: +(sum / n).toFixed(4),
          p05: +pct(0.05).toFixed(4),
          p50: +pct(0.5).toFixed(4),
          p95: +pct(0.95).toFixed(4),
          dynRange: +(pct(0.95) - pct(0.05)).toFixed(4),
          nearBlackFrac: +(nearBlack / n).toFixed(4),
          shadowPairs: pairs,
          composerPasses,
          perf: w.perf(),
        };
        })();
        resolve(done);
      };
      img.onerror = () => resolve({ error: "canvas read failed" });
      img.src = canvas.toDataURL("image/png");
    });
  });
}

async function probe(page: import("@playwright/test").Page, url: string) {
  await deploy(page, url);
  await page.evaluate(() => {
    const w = (window as unknown as { __sbGame: any }).__sbGame.world;
    w.setAngle(0);
    w.zoom = 0.98;
    (w as any).focus.set(0, 0, 0);
    w.shake = 0;
  });
  await page.waitForTimeout(1200);
  const a = await measure(page);
  console.log(`PROBE ${url} ${JSON.stringify(a)}`);
  await page.evaluate(() => {
    const w = (window as unknown as { __sbGame: any }).__sbGame.world;
    w.setAngle(2);
    (w as any).focus.set(0, 0, 0);
    w.shake = 0;
  });
  await page.waitForTimeout(900);
  const b = await measure(page);
  console.log(`PROBE2 ${url} ${JSON.stringify(b)}`);
}

test("probe mission1 @1280x720", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await probe(page, "/?seed=4242");
});

test("probe mission1 @1024x768", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await probe(page, "/?seed=4242");
});

test("probe mission3 @1280x720", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await probe(page, "/?seed=9&mission=3");
});

test("probe spec-res mission1 @1920x1080", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await probe(page, "/?seed=4242");
});

test("probe spec-res mission1 seed11 @1920x1080", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await probe(page, "/?seed=11");
});
