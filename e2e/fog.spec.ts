// Fog-of-war presentation contract (INTEGRATION-class evidence). Fog is PRESENTATION ONLY:
// the authoritative sim keeps computing full visibility; the renderer must (1) paint the 3-state
// fog from state.vis, (2) never render enemies outside the player squad's current line of sight,
// (3) never leak hidden-unit data into the DOM, and (4) never mutate simulation state.
import { test, expect } from "@playwright/test";

async function deploy(page: import("@playwright/test").Page, seed: number) {
  await page.goto(`/?seed=${seed}`);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(1800);
}

test("fog layers exist and track the authoritative 3-state visibility", async ({ page }) => {
  await deploy(page, 4242);
  const before = await page.evaluate(() => {
    const T = (window as unknown as { __sbThree: any }).__sbThree;
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const w = g.world;
    const dark = w.fogGroup.children.find((c: any) => c.isInstancedMesh && c.material.opacity > 0.8);
    const mem = w.fogGroup.children.find((c: any) => c.isInstancedMesh && c.material.opacity <= 0.8);
    if (!dark || !mem) return { ok: false, why: "no fog layers" };
    const s = g.debugState();
    let expectDark = 0;
    let expectMem = 0;
    for (let y = 0; y < 14; y++) {
      for (let x = 0; x < 14; x++) {
        const t = s.tiles[y * 14 + x];
        if (!t || t.terrain === "wall" || t.terrain === "pillar") continue;
        const v = s.vis[y * 14 + x];
        if (v === 0) expectDark++;
        else if (v === 1) expectMem++;
      }
    }
    const m = new T.Matrix4();
    const pos = new T.Vector3();
    const q = new T.Quaternion();
    const sc = new T.Vector3();
    const countShown = (mesh: any) => {
      let c = 0;
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        m.decompose(pos, q, sc);
        if (sc.x > 0.5) c++;
      }
      return c;
    };
    return { ok: true, expectDark, expectMem, shownDark: countShown(dark), shownMem: countShown(mem), unexploredTotal: s.vis.filter((v: number) => v === 0).length };
  });
  expect(before.ok, (before as { why?: string }).why || "fog present").toBe(true);
  expect(before.unexploredTotal, "the map must start mostly fogged").toBeGreaterThan(60);
  expect(before.shownDark, `dark quads ${before.shownDark}/${before.expectDark}`).toBeGreaterThanOrEqual(Math.round(before.expectDark * 0.95));
  const shot = await page.screenshot({ path: "artifacts/fog-initial.png" });
  expect(shot.length).toBeGreaterThan(2000);
});

test("rendering must not mutate the simulation (fog paints from a read copy)", async ({ page }) => {
  await deploy(page, 4242);
  const res = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const before = g.debugSerialize();
    // hammer the presentation path repeatedly; authoritative state must not budge
    for (let i = 0; i < 50; i++) {
      g.world.setFog(g.debugState().vis);
      g.world.syncUnits(g.debugState().units, { hidden: new Set(["e_sentry_1"]) });
    }
    const after = g.debugSerialize();
    return { equal: before === after };
  });
  expect(res.equal, "presentation must never mutate authoritative state").toBe(true);
});

test("hidden enemies do not leak into the DOM and are not rendered", async ({ page }) => {
  await deploy(page, 4242);
  // resolve two enemy phases to move guards around under fog
  await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    for (let i = 0; i < 2; i++) g.endTurn();
  });
  await page.waitForTimeout(400);
  const check = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const s = g.debugState();
    const body = document.body.innerText;
    const leaks: string[] = [];
    const foggedHidden: string[] = [];
    let fogged = 0;
    let hiddenButRendered = 0;
    for (const u of s.units) {
      if (!u.alive || u.side !== "enemy") continue;
      if (body.includes(u.id)) leaks.push(`id ${u.id} present in DOM text`);
      const vis2 = s.vis[u.pos.y * 14 + u.pos.x] === 2;
      if (!vis2) {
        fogged++;
        foggedHidden.push(`${u.id}@${u.pos.x},${u.pos.y}`);
        const m = g.world.unitMeshes.get(u.id);
        if (m && m.visible === true) hiddenButRendered++;
      }
    }
    // debug fields must not be exposed in default UI either
    if (body.includes("detState") || body.includes("searchPos")) leaks.push("debug fields in DOM");
    return { leaks, fogged, hiddenButRendered, foggedHidden };
  });
  expect(check.leaks, `DOM leaks: ${check.leaks.join("; ")}`).toEqual([]);
  expect(check.fogged, "seed 4242 should have fogged guards to hide").toBeGreaterThan(0);
  expect(check.hiddenButRendered, `fogged but rendered: ${check.foggedHidden.join(",")}`).toBe(0);
});

test("fog repaints after the enemy phase (presentation follows authoritative state)", async ({ page }) => {
  await deploy(page, 4242);
  const paintedBefore = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const dark = g.world.fogGroup.children.find((c: any) => c.isInstancedMesh && c.material.opacity > 0.8);
    return dark ? dark.instanceMatrix.version : 0;
  });
  await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    g.endTurn();
  });
  await page.waitForTimeout(300);
  const paintedAfter = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const dark = g.world.fogGroup.children.find((c: any) => c.isInstancedMesh && c.material.opacity > 0.8);
    return dark ? dark.instanceMatrix.version : 0;
  });
  expect(paintedBefore, "fog must be painted at deploy").toBeGreaterThan(0);
  expect(paintedAfter, "fog layer must repaint after state change").toBeGreaterThan(paintedBefore);
});
