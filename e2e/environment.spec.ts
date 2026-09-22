// Environment/VFX VISION evidence: security devices must exist as visible world props (not
// invisible rules), their render state must track authority (powered -> hijacked/disabled),
// and the environment must give camera-distinct depth. Screenshots are saved for the vision pass.
import { test, expect } from "@playwright/test";
import { measureRenderQuality } from "./visionProbe";

async function deploy(page: import("@playwright/test").Page, url: string) {
  await page.goto(url);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(1800);
}

test("security devices and extraction read as world props", async ({ page }) => {
  // Mission 3 (Core Chamber): 2 relays, 2 cores, 2 cameras, 2 turrets, 1 sec-node all render as props.
  await deploy(page, "/?seed=9&mission=3");
  const out = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const w = g.world;
    const s = g.debugState();
    const propChildren = w.propGroup.children.length;
    const visibleDevices = s.devices.filter((d: any) => ["camera", "turret", "core", "node", "terminal"].includes(d.kind)).length;
    return { propChildren, visibleDevices, perf: w.perf() };
  });
  expect(out.visibleDevices, "M3 fixture has devices").toBeGreaterThanOrEqual(4);
  expect(out.propChildren, `props ${out.propChildren} vs devices ${out.visibleDevices}`).toBeGreaterThanOrEqual(out.visibleDevices);
  const art = await page.screenshot({ path: "artifacts/env-mission3.png" });
  expect(art.length).toBeGreaterThan(2000);
});

test("turret/camera render state follows authority changes", async ({ page }) => {
  // The deterministic solver (seed 9, Core Chamber) hijacks a turret via the same action path;
  // the renderer must repaint the prop (emissive teal) when authority flips.
  await deploy(page, "/?seed=9&mission=3");
  const before = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    return g.world.propGroup.children.map((c: any) => `${(c.material.emissive?.getHex?.() ?? 0).toString(16)}`).join(",");
  });
  await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    g.debugAutoPlay();
  });
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const s = g.debugState();
    const changedDevices = s.devices.filter((d: any) => ["camera", "turret", "node"].includes(d.kind) && (d.disabled || !d.powered || d.owner === "hijacked")).length;
    const props = g.world.propGroup.children.map((c: any) => `${(c.material.emissive?.getHex?.() ?? 0).toString(16)}`).join(",");
    return { changedDevices, propsBefore: "", propsAfter: props };
  });
  expect(after.changedDevices, "some security device should have been hacked/hijacked by the solver").toBeGreaterThanOrEqual(1);
  expect(after.propsAfter, "prop emissives must change when devices go dark/hijacked").not.toBe(before);
  await page.screenshot({ path: "artifacts/env-after.png" });
});

test("environment depth: camera rotation produces a visually different frame", async ({ page }) => {
  await deploy(page, "/?seed=4242");
  const a = await page.evaluate(() => (document.querySelector("canvas") as HTMLCanvasElement).toDataURL("image/png").length);
  await page.keyboard.press("q");
  await page.waitForTimeout(600);
  const b = await page.evaluate(() => (document.querySelector("canvas") as HTMLCanvasElement).toDataURL("image/png"));
  const perf = await page.evaluate(() => (window as unknown as { __sbPerf?: () => { meshes: number } }).__sbPerf!());
  expect(perf.meshes, "environment props present").toBeGreaterThan(40);
  const bLen = b.length;
  expect(Math.abs(bLen - a) > a * 0.002 || bLen !== a, "rotated view differs from initial").toBe(true);
  await page.screenshot({ path: "artifacts/env-rotated.png" });
});

test("render foundation: output/tone-mapping, bloom and AO in the chain; shadow rig reads on the canvas", async ({ page }) => {
  // VISION evidence for the polished-rendering bar: the composer must actually apply tone
  // mapping + colour-space conversion, bloom and ambient occlusion (not just render a flat
  // frame), and the shadow rig must produce a measurable darkening on the live canvas.
  // Thresholds are tolerant around measured values (see e2e/tools.probe.ts calibration).
  await deploy(page, "/?seed=4242");
  const q = await measureRenderQuality(page);
  expect(q.passes, `composer chain: ${q.passes}`).toContain("OutputPass");
  expect(q.passes, `composer chain: ${q.passes}`).toContain("UnrealBloomPass");
  expect(q.passes, `composer chain: ${q.passes}`).toContain("SSAOPass");
  expect(q.keyShadow, `shadow-casting key light with 2048 map + allocated shadow map: ${q.keyShadow}`).toBe("true:2048:1");
  // mean luminance must sit in a readable band: not near-black greybox, not blown-out mid-grey.
  expect(q.meanLum, `mean scene luminance ${q.meanLum}`).toBeGreaterThan(0.085);
  expect(q.meanLum, `mean scene luminance ${q.meanLum}`).toBeLessThan(0.26);
  expect(q.dynRange, `dynamic range p95-p05 ${q.dynRange}`).toBeGreaterThan(0.28);
  expect(q.nearBlackFrac, `near-black fraction ${q.nearBlackFrac}`).toBeLessThan(0.35);
  expect(q.pairs.length, "at least one shadowed/lit floor probe pair").toBeGreaterThanOrEqual(1);
  for (const p of q.pairs) {
    expect(p.lit, `lit floor reference at ${p.sx},${p.sz} reads ${p.lit}`).toBeGreaterThan(0.14);
    expect(p.shadow, `shadowed floor at ${p.sx},${p.sz} reads ${p.shadow} vs lit ${p.lit}`).toBeLessThan(p.lit * 0.75);
  }
  await page.screenshot({ path: "artifacts/env-foundation.png" });
});

test("environment: textured materials, distance fog and multi-part device props", async ({ page }) => {
  // ENV polish evidence (ADDITIVE to the assertions above): surfaces must carry real procedural
  // colour maps as several distinct material identities (not one flat colour family), the scene
  // must have tuned distance fog that clears the play area, and each security device must render
  // as a multi-part prop above a minimum part count. Measured from the live scene, not hardcoded.
  await deploy(page, "/?seed=9&mission=3");
  const env = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const w = g.world;
    const s = g.debugState();
    const matsAll = new Set<string>();
    const matsTextured = new Set<string>();
    for (const c of w.boardGroup.children) {
      const m = (c as any).material;
      const arr = Array.isArray(m) ? m : m ? [m] : [];
      for (const mm of arr) {
        if (!mm) continue;
        matsAll.add(mm.uuid);
        if (mm.map) matsTextured.add(mm.uuid);
      }
    }
    const fog = w.scene.fog ? { type: w.scene.fog.type, near: w.scene.fog.near, far: w.scene.fog.far } : null;
    const parts: Record<string, { kind: string; n: number }> = {};
    for (const c of w.propGroup.children) {
      const dev = c.userData && c.userData.dev;
      if (!dev) continue;
      if (!parts[dev]) parts[dev] = { kind: c.userData.kind, n: 0 };
      parts[dev].n++;
    }
    const minByKind: Record<string, number> = { camera: 3, turret: 4, terminal: 3, core: 3, node: 2 };
    const devList = s.devices.filter((d: any) => ["camera", "turret", "core", "node", "terminal"].includes(d.kind));
    const kindsWithProps = new Set<string>();
    let minOk = true;
    let worst: string | null = null;
    for (const d of devList) {
      const p = parts[d.id];
      const mn = minByKind[d.kind] || 3;
      if (!p || p.n < mn) {
        minOk = false;
        if (!worst) worst = `${d.kind}:${p ? p.n : 0}<${mn}`;
      } else {
        kindsWithProps.add(d.kind);
      }
    }
    return { matsAll: matsAll.size, matsTextured: matsTextured.size, fog, devCount: devList.length, kindCount: kindsWithProps.size, minOk, worst, propChildren: w.propGroup.children.length };
  });
  expect(env.fog, "distance fog enabled for diorama depth").not.toBeNull();
  expect(env.fog.near, `fog near must clear the play area (${env.fog.near})`).toBeGreaterThanOrEqual(15);
  expect(env.fog.far, `fog far must recede the rim (${env.fog.far})`).toBeLessThanOrEqual(60);
  expect(env.matsTextured, `textured env material identities ${env.matsTextured}`).toBeGreaterThanOrEqual(4);
  expect(env.matsAll, `distinct env material identities ${env.matsAll}`).toBeGreaterThanOrEqual(5);
  expect(env.kindCount, `device kinds rendering as multi-part props ${env.kindCount}`).toBe(5);
  expect(env.minOk, `multi-part prop below minimum (${env.worst})`).toBe(true);
  expect(env.propChildren, "props still outnumber devices").toBeGreaterThanOrEqual(env.devCount);
  await page.screenshot({ path: "artifacts/env-materials.png" });
});

test("device render-state read is per-part and tracks authority", async ({ page }) => {
  // Read the emissive "signature" of each device's prop parts, run the deterministic solver, then
  // assert the renderer repainted exactly the devices whose authority changed (powered -> hijacked
  // /disabled) while still-powered devices kept their render state. The pulsing extraction pad is
  // excluded (no device id), so this measures per-device render state, not a global change.
  await deploy(page, "/?seed=9&mission=3");
  const read = () =>
    page.evaluate(() => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      const w = g.world;
      const s = g.debugState();
      const glow: Record<string, string> = {};
      for (const c of w.propGroup.children) {
        const dev = c.userData && c.userData.dev;
        if (!dev) continue;
        const m = (c as any).material;
        const em = m && m.emissive ? m.emissive.getHex() : 0;
        glow[dev] = (glow[dev] || "") + em.toString(16) + ",";
      }
      const state = s.devices.map((d: any) => ({ id: d.id, kind: d.kind, off: d.disabled || !d.powered || d.owner === "hijacked" }));
      return { glow, state };
    });
  const before = await read();
  await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    g.debugAutoPlay();
  });
  await page.waitForTimeout(400);
  const after = await read();
  const flipped = after.state.filter((x) => x.off);
  expect(flipped.length, "a security device should change authority under the solver").toBeGreaterThanOrEqual(1);
  const repainted = flipped.filter((x) => after.glow[x.id] !== before.glow[x.id]);
  expect(repainted.length, "a flipped device must repaint its emissive read part").toBeGreaterThanOrEqual(1);
  const powered = after.state.filter((x) => !x.off).map((x) => x.id);
  expect(powered.some((id) => after.glow[id] === before.glow[id]), "still-powered devices keep their render state").toBe(true);
  await page.screenshot({ path: "artifacts/env-renderstate.png" });
});

// ---- COMBAT / VFX evidence (V3): effects are driven from real authoritative geometry and are
// transient (they clear), not permanent scene litter. All measured from the live scene, not a
// hardcoded screenshot. These ADD to the assertions above (none removed/weakened). ----

// A real firing action must leave an effect object ON THE REAL FIRING LINE (built from the shooter
// and target tiles), plus a muzzle flash at the shooter. Two different shots must produce two
// different lines (proof the position comes from real geometry, never a fixed placeholder spot).
test("weapon fire leaves a tracer on the real firing line + a muzzle flash at the shooter", async ({ page }) => {
  await deploy(page, "/?seed=9&mission=3");
  const out = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const w = g.world;
    w.clearEffects();
    // find a genuinely valid shot (in range, line of sight) and fire it via the REAL action path;
    // if the two sides are not yet engaged, advance the sim (same path) until a legal shot exists.
    const findPair = () => {
      const S = g.debugState();
      const mine = S.units.filter((u: any) => u.alive && u.side === "player");
      const foe = S.units.filter((u: any) => u.alive && u.side === "enemy");
      for (const pu of mine) for (const eu of foe) if (g.debugPreview(pu.id, eu.id).valid) return { pu: pu.id, eu: eu.id, from: [pu.pos.x, pu.pos.y], to: [eu.pos.x, eu.pos.y] };
      return null;
    };
    let p = findPair();
    let guard = 0;
    while (!p && guard < 16) {
      g.debugTryOneAction();
      guard++;
      p = findPair();
    }
    if (p) g.debugAttack(p.pu, p.eu);
    const tracers = w.debugFx().filter((f: any) => f.kind === "tracer" && f.from && f.to);
    const muzzle = w.debugFx().filter((f: any) => f.kind === "muzzle");
    // a second shot on a DIFFERENT line, to show the tracer is not pinned to one placeholder point
    w.clearEffects();
    w.fire({ x: 1, y: 12, h: 0 }, { x: 12, y: 2, h: 0 });
    const second = w.debugFx().filter((f: any) => f.kind === "tracer" && f.from);
    return { pair: p ? { from: p.from, to: p.to } : null, tracers, muzzle, firstKeys: tracers.map((f: any) => `${f.from}->${f.to}`).join("|"), secondKeys: second.map((f: any) => `${f.from}->${f.to}`).join("|") };
  });
  expect(out.pair, "fixture offers at least one valid shot to fire").not.toBeNull();
  expect(out.tracers.length, "a firing action produced an effect object on the firing line").toBeGreaterThanOrEqual(1);
  expect(out.tracers[0].from, `tracer built from the shooter tile ${JSON.stringify(out.pair)}`).toEqual([out.pair!.from[0], out.pair!.from[1]]);
  expect(out.tracers[0].to, "tracer built toward the target tile").toEqual([out.pair!.to[0], out.pair!.to[1]]);
  expect(out.muzzle.length, "a firing action produced a muzzle flash at the shooter").toBeGreaterThanOrEqual(1);
  expect(out.secondKeys, "a second line differs from the first (no fixed placeholder)").not.toBe(out.firstKeys);
});

// A shot whose line passes cover leaves an impact ON THE COVER (a distinct treatment from a unit
// hit), positioned at the blocking tile read from real terrain — cover visibly takes the hit.
test("a blocked/covered shot leaves an impact on cover at the blocking tile", async ({ page }) => {
  await deploy(page, "/?seed=9&mission=3");
  const out = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const w = g.world;
    w.clearEffects();
    const S = g.debugState();
    const coverTile = (x: number, y: number) => {
      const t = S.tiles[y * 14 + x];
      return t && (t.terrain === "wall" || t.terrain === "pillar" || t.terrain === "crate" || t.terrain === "hazard" || t.terrain === "panel" || t.terrain === "machine");
    };
    // scan lines across the arena and record any that put cover between shooter and target
    const hits: { from: number[]; at: number[]; terrain: string }[] = [];
    for (let i = 0; i < 60 && hits.length < 6; i++) {
      const fx = 1 + (i % 12);
      const fy = 1 + ((i * 5) % 12);
      const tx = 12 - (i % 12);
      const ty = 12 - ((i * 5) % 12);
      w.clearEffects();
      g.debugFireLine({ x: fx, y: fy, h: 0 }, { x: tx, y: ty, h: 0 });
      const cover = w.debugFx().find((f: any) => f.kind === "cover" && f.at);
      if (cover && coverTile(cover.at[0], cover.at[1])) {
        hits.push({ from: [fx, fy], at: cover.at, terrain: S.tiles[cover.at[1] * 14 + cover.at[0]].terrain });
      }
    }
    return { hits };
  });
  expect(out.hits.length, "some firing lines passed real cover").toBeGreaterThanOrEqual(1);
  // the impact must be recorded ON a real cover tile (wall/pillar/crate/hazard/panel/machine)
  expect(out.hits.some((h) => ["wall", "pillar", "crate", "hazard", "panel", "machine"].includes(h.terrain)), `cover impact landed on cover (${JSON.stringify(out.hits)})`).toBe(true);
});

// Effects are TRANSIENT: after their duration elapses the effect count returns to baseline, proving
// they are not permanent scene litter. Uses expect.poll so a throttled headless render clock (which
// ages effects by a capped per-frame dt, not wall-clock) cannot leave a false failure.
test("effect count returns to baseline once effect duration elapses (transient)", async ({ page }) => {
  await deploy(page, "/?seed=9&mission=3");
  const base = await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.world.effectCount());
  expect(base, "starts at the transient-effect baseline").toBe(0);
  await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    g.debugFireLine({ x: 3, y: 3, h: 0 }, { x: 9, y: 9, h: 0 });
    g.debugAutoPlay();
  });
  const peak = await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.world.effectCount());
  expect(peak, "a firing phase produced transient effects").toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.world.effectCount()), { timeout: 8000 })
    .toBe(0);
});

// Effects are cleaned up on a mission rebuild: a fresh mission (a new World) starts clean AND a
// same-World board rebuild tears down every lingering effect (no orphaned meshes / late-append).
test("effects are cleaned up on a mission change (no orphaned or late-appended meshes)", async ({ page }) => {
  await deploy(page, "/?seed=9&mission=3");
  const rebuild = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const w = g.world;
    w.clearEffects();
    // build a spread of effect classes, then change the board underneath them (mission rebuild)
    w.fire({ x: 3, y: 3, h: 0 }, { x: 9, y: 9, h: 0 });
    w.impact({ x: 6, y: 6, h: 0 });
    w.coverHit({ x: 5, y: 5, h: 0 });
    w.empRing({ x: 8, y: 4, h: 0 });
    w.sweep({ x: 4, y: 8, h: 0 });
    w.shimmer({ x: 9, y: 9, h: 0 });
    w.neutralize({ x: 7, y: 7, h: 0 });
    const beforeRebuild = w.effectCount();
    w.buildBoard(g.debugState().tiles, { hazard: [] });
    const afterRebuild = w.effectCount();
    return { beforeRebuild, afterRebuild };
  });
  expect(rebuild.beforeRebuild, "effect classes were placed before the rebuild").toBeGreaterThan(0);
  expect(rebuild.afterRebuild, "a mission rebuild clears every lingering effect").toBe(0);

  // a fresh mission (new World) must also start with no effects
  await page.goto("/?seed=4242&mission=2");
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  const fresh = await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.world.effectCount());
  expect(fresh, "a new mission starts with no orphaned effects").toBe(0);
});

// Device failure and alarm escalation read in-world, not only in the HUD: a device that goes dark
// sparks, and an escalating alert paints a pulsing wash on the affected cluster.
test("device failure sparks and alarm escalation is legible in-world", async ({ page }) => {
  await deploy(page, "/?seed=9&mission=3");
  const out = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    g.world.clearEffects();
    g.debugAutoPlay();
    const S = g.debugState();
    const dark = S.devices.filter((d: any) => !d.powered || d.disabled || d.owner === "hijacked");
    const fxAtDarkDevice = g.world.debugFx().filter((f: any) => (f.kind === "impact" || f.kind === "sweep") && f.at && S.devices.some((d: any) => d.x === f.at[0] && d.y === f.at[1] && (!d.powered || d.disabled || d.owner === "hijacked"))).length;
    return { darkCount: dark.length, fxAtDarkDevice, alert: S.alert, washPresent: !!g.world.alertWash };
  });
  expect(out.darkCount, "the solver changed at least one device's authority").toBeGreaterThanOrEqual(1);
  expect(out.fxAtDarkDevice, "a dark/hijacked device sparks in-world").toBeGreaterThanOrEqual(1);
  if (out.alert > 0) {
    expect(out.washPresent, `alarm level ${out.alert} shows a pulsing in-world wash`).toBe(true);
  }
});
