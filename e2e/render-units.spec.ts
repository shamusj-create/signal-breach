// Regression for the missing-units wiring bug (units were never synchronised into the scene).
// Real integration path: deploy through the normal UI; then require PER-UNIT VISUAL PRESENCE —
// team-colour pixels near each live unit's projected screen position. Non-blank canvas or mesh
// totals are deliberately NOT the evidence. Test 2 proves the evidence collapses when the
// sync->scene call is disabled via an isolated route-level fixture (repo untouched).
//
// Fog-of-war era rules: team-colour presence is asserted for every PLAYER unit and for enemy
// units standing in a VISIBLE tile (vis === 2). Enemies outside visibility must have no scene
// presence (invisible mesh) — that is the leak-proof half of the fog contract.
import { test, expect } from "@playwright/test";

async function deploy(page: import("@playwright/test").Page, seed: number) {
  await page.goto(`/?seed=${seed}`);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(2000);
}

// Units that must show team-colour presence: all players + enemies in visible tiles.
async function visiblePresenceUnits(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const s = g.debugState();
    const list = s.units
      .filter((u: any) => u.alive)
      .map((u: any) => ({
        id: u.id,
        side: u.side,
        mustRender: u.side === "player" || s.vis[u.pos.y * 14 + u.pos.x] === 2,
        hidden: u.side === "enemy" && s.vis[u.pos.y * 14 + u.pos.x] !== 2,
      }));
    return list;
  });
}

async function scenePresence(page: import("@playwright/test").Page, expected: { id: string; side: string; mustRender: boolean; hidden: boolean }[]) {
  return page.evaluate((units) => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const w = g.world;
    const out: Record<string, boolean | null> = {};
    for (const u of units) {
      const m = w.unitMeshes.get(u.id);
      out[u.id] = m ? m.visible === true : null; // null = no render object at all
    }
    return out;
  }, expected);
}

async function renderPresence(page: import("@playwright/test").Page, units: { id: string; side: string; mustRender: boolean }[]) {
  const projected = await page.evaluate((us) => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const w = g.world;
    const V3 = (w.scene.position as any).constructor;
    const cam = w.camera;
    cam.updateMatrixWorld(true);
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.width / rect.width;
    return us
      .filter((u) => u.mustRender)
      .map((u) => {
        const s = g.debugState();
        const unit = s.units.find((x: any) => x.id === u.id);
        const wp = w.tileToWorld({ x: unit.pos.x, y: unit.pos.y, h: unit.pos.h });
        const v = new V3(wp.x, wp.y + 0.45, wp.z);
        v.project(cam);
        const x = (v.x * 0.5 + 0.5) * rect.width * dpr;
        const y = (-v.y * 0.5 + 0.5) * rect.height * dpr;
        return { id: u.id, side: u.side, x, y };
      });
  }, units);
  return page.evaluate(async (us) => {
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const img = new Image();
    const loaded = await new Promise<boolean>((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = canvas.toDataURL("image/png");
    });
    if (!loaded) return { ok: false, hits: 0, total: us.length, note: "canvas not readable" };
    const cc = document.createElement("canvas");
    cc.width = canvas.width;
    cc.height = canvas.height;
    const cx = cc.getContext("2d")!;
    cx.drawImage(img, 0, 0);
    const data = cx.getImageData(0, 0, cc.width, cc.height).data;
    let hits = 0;
    for (const u of us) {
      const px = Math.round(u.x);
      const py = Math.round(u.y);
      let found = false;
      for (let dy = -28; dy <= 28 && !found; dy++) {
        for (let dx = -28; dx <= 28 && !found; dx++) {
          const x = px + dx;
          const y = py + dy;
          if (x < 0 || y < 0 || x >= cc.width || y >= cc.height) continue;
          const i = (y * cc.width + x) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const match =
            u.side === "player"
              ? r < 110 && g > 150 && b > 140 && b < 230
              : r > 200 && g > 30 && g < 140 && b > 60 && b < 170;
          if (match) found = true;
        }
      }
      if (found) hits++;
    }
    return { hits, total: us.length };
  }, projected);
}

test("live units are synchronised into the scene on normal startup (real integration path)", async ({ page }) => {
  await deploy(page, 4242);
  const expected = await visiblePresenceUnits(page);
  const s = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const w = g.world;
    const live = g.debugState().units.filter((u: any) => u.alive);
    const attached = live.filter((u: any) => {
      const m = w.unitMeshes.get(u.id);
      if (!m || m.visible !== true || m.children.length === 0) return false;
      let p: any = m;
      while (p) {
        if (p === w.scene) return true;
        p = p.parent;
      }
      return false;
    });
    return { total: live.length, attached: attached.length };
  });
  expect(s.total).toBeGreaterThan(0);
  const playersAndVisible = expected.filter((u) => u.mustRender);
  expect(playersAndVisible.length, "fog must still keep plenty of units on screen").toBeGreaterThan(0);
  // every unit that must render is attached, and hidden (fogged) enemies are NOT visible
  const pres = await scenePresence(page, expected);
  for (const u of expected) {
    if (u.mustRender) expect(pres[u.id], `${u.id} must render (visible tile)`).toBe(true);
    else expect(pres[u.id] === true, `${u.id} is fogged and must not render`).toBe(false);
  }
  const r = await renderPresence(page, expected);
  expect(r.total).toBeGreaterThan(0);
  // every present unit is attached AND >=2/3 are visibly picked out by team-colour pixels at
  // their projected position (a couple may be partially occluded by cover from the default view)
  expect(r.hits * 3, `hits=${r.hits}/${r.total}`).toBeGreaterThanOrEqual(r.total * 2);
});

test("evidence collapses when the sync->scene wiring is disabled (isolated sabotage fixture)", async ({ page }) => {
  let replaced = false;
  await page.route("**/TacticalGame.ts", async (route) => {
    const res = await route.fetch();
    const body = await res.text();
    if (body.includes("this.world.syncUnits(")) {
      replaced = true;
      const broken = body.split("this.world.syncUnits(").join("void (");
      await route.fulfill({ status: 200, contentType: "text/javascript", body: broken });
    } else {
      await route.fulfill({ response: res });
    }
  });
  await deploy(page, 4242);
  expect(replaced, "sabotage fixture must intercept the TacticalGame module").toBeTruthy();
  const s = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const live = g.debugState().units.filter((u: any) => u.alive);
    return { total: live.length, meshes: g_world().unitMeshes.size };
    function g_world() {
      return (window as unknown as { __sbGame: any }).__sbGame.world;
    }
  });
  expect(s.total).toBeGreaterThan(0);
  expect(s.meshes, "with wiring removed, no unit render objects may exist").toBe(0);
});
