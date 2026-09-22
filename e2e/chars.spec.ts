// Character-model VISION evidence: archetypes must be visually distinct at the scene level
// (silhouette/geometry + material identity), team colours must read at unit pixels, and threat
// telegraphs must be drawable. Scene facts are proxies; screenshots are saved for the vision pass.
import { test, expect } from "@playwright/test";
import { measureRenderQuality } from "./visionProbe";
import { captureIsolatedSubject } from "./subjectCapture";

async function deploy(page: import("@playwright/test").Page, url: string) {
  await page.goto(url);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(1800);
}

test("distinct silhouettes: each archetype has a unique render volume and material set", async ({ page }) => {
  // Mission 3 deploys every archetype: sentries, enforcer, hunters, warden (plus both turret props).
  await deploy(page, "/?seed=4242&mission=3");
  const art = await page.screenshot({ path: "artifacts/chars-deploy.png" });
  expect(art.length, "deploy screenshot captured").toBeGreaterThan(2000);
  const out = await page.evaluate(() => {
    const T = (window as unknown as { __sbThree: any }).__sbThree;
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const w = g.world;
    const s = g.debugState();
    const box = new T.Box3();
    const sizes: Record<string, { h: number; w: number; kids: number; side: string }> = {};
    for (const u of s.units) {
      const m = w.unitMeshes.get(u.id);
      if (!m) continue;
      box.setFromObject(m);
      const sz = box.getSize(new T.Vector3());
      sizes[`${u.archetype}:${u.id}`] = { h: +sz.y.toFixed(3), w: +Math.max(sz.x, sz.z).toFixed(3), kids: m.children.length, side: u.side };
    }
    const mats = new Set<string>();
    w.scene.traverse((o: any) => {
      if (o.isMesh) {
        const mm = o.material;
        if (mm && !Array.isArray(mm)) mats.add(`${(mm.color?.getHex?.() ?? 0).toString(16)}-${(mm.emissive?.getHex?.() ?? 0).toString(16)}-${mm.metalness}-${mm.roughness}`);
      }
    });
    return { sizes, materialVariants: mats.size };
  });
  const en = (p: string) => Object.entries(out.sizes).filter(([k]) => k.startsWith(`${p}:`));
  const warden = en("warden")[0];
  const sentry = en("sentry")[0];
  const hunter = en("hunter")[0];
  expect(warden, "warden present").toBeTruthy();
  expect(sentry, "sentry present").toBeTruthy();
  expect(hunter, "hunter present").toBeTruthy();
  // Warden is the tallest enemy silhouette; hunter is the only multi-part hull; enemy
  // archetype signatures (height+parts) do not collapse into one shared shape.
  const maxOtherH = Math.max(...Object.entries(out.sizes).filter(([k, v]) => v.side === "enemy" && !k.startsWith("warden")).map(([, v]) => v.h));
  expect(warden![1].h, `warden tallest (${warden![1].h} vs ${maxOtherH})`).toBeGreaterThan(maxOtherH);
  expect(hunter![1].kids, "hunter multi-part hull").toBeGreaterThanOrEqual(5);
  const enemySigs = new Set(Object.entries(out.sizes).filter(([k]) => k.startsWith("sentry") || k.startsWith("hunter")).map(([, v]) => `${v.h}`));
  expect(enemySigs.size, "archetype heights vary").toBeGreaterThanOrEqual(2);
  expect(out.materialVariants, `unique materials ${out.materialVariants}`).toBeGreaterThanOrEqual(10);
});

test("players and enemies read in different team colours at their own pixels", async ({ page }) => {
  await deploy(page, "/?seed=11");
  // Advance the sim (real actions) until hostile sensors are drawn, then sample screen-space
  // pixels under each unit's projected bounding-box centre. Teal = friendly, warm = hostile.
  // The advance and the pixel read are separate evaluates so the renderer gets fresh frames
  // between them (the read samples the most recent painted canvas).
  const advance = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    let steps = 0;
    let visEnemies = 0;
    for (let i = 0; i < 20; i++) {
      g.debugTryOneAction();
      steps++;
      const st = g.debugState();
      visEnemies = st.units.filter((u: any) => u.alive && u.side === "enemy" && st.vis[u.pos.y * 14 + u.pos.x] === 2).length;
      if (visEnemies >= 2 || st.gameOver) break;
    }
    return { steps, visEnemies };
  });
  expect(advance.visEnemies, `visible enemies after ${advance.steps} steps`).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => {
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
        const data = cx.getImageData(0, 0, cc.width, cc.height).data;
        const rect = canvas.getBoundingClientRect();
        const dpr = canvas.width / rect.width;
        const near = (px: number, py: number, test: (r: number, g: number, b: number) => boolean, rad = 18) => {
          for (let dy = -rad; dy <= rad; dy++)
            for (let dx = -rad; dx <= rad; dx++) {
              const x = px + dx, y = py + dy;
              if (x < 0 || y < 0 || x >= cc.width || y >= cc.height) continue;
              const i = (y * cc.width + x) * 4;
              if (test(data[i], data[i + 1], data[i + 2])) return true;
            }
          return false;
        };
        const teal = (rr: number, gg: number, bb: number) => gg > 150 && gg > rr + 40 && bb > 120 && bb > rr;
        const warm = (rr: number, gg: number, bb: number) => rr > 170 && rr > gg + 50 && rr > bb + 30;
        const box = new T.Box3();
        const st = g.debugState();
        const sample = (u: any) => {
          const m = w.unitMeshes.get(u.id);
          if (!m || !m.visible) return { drawn: false };
          box.setFromObject(m);
          const c = box.getCenter(new T.Vector3());
          const v = new T.Vector3(c.x, c.y, c.z);
          v.project(w.camera);
          const px = Math.round((v.x * 0.5 + 0.5) * rect.width * dpr);
          const py = Math.round((-v.y * 0.5 + 0.5) * rect.height * dpr);
          const onScreen = px >= 0 && py >= 0 && px < cc.width && py < cc.height && v.z < 1;
          const hit = onScreen ? (u.side === "player" ? near(px, py, teal) : near(px, py, warm)) : false;
          return { drawn: true, onScreen, hit };
        };
        const players = st.units.filter((u: any) => u.alive && u.side === "player").map(sample);
        const enemies = st.units.filter((u: any) => u.alive && u.side === "enemy" && st.vis[u.pos.y * 14 + u.pos.x] === 2).map(sample);
        resolve({
          playerHits: players.filter((p: any) => p.onScreen && p.hit).length,
          playerTotal: players.length,
          enemySeen: enemies.filter((p: any) => p.drawn).length,
          enemyHits: enemies.filter((p: any) => p.onScreen && p.hit).length,
        });
      };
      img.src = canvas.toDataURL("image/png");
    });
  });
  const any = r as { playerHits: number; playerTotal: number; enemySeen: number; enemyHits: number };
  expect(any.playerHits, `players teal ${any.playerHits}/${any.playerTotal}`).toBeGreaterThanOrEqual(3);
  expect(any.enemySeen, "at least two enemies rendered").toBeGreaterThanOrEqual(2);
  expect(any.enemyHits, `warm ${any.enemyHits}/${any.enemySeen}`).toBeGreaterThanOrEqual(any.enemySeen - 1);
  await page.screenshot({ path: "artifacts/chars-colors.png" });
});

test("detection cones draw for alerted enemies during a live run", async ({ page }) => {
  await deploy(page, "/?seed=11");
  const seen = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    let maxCones = 0;
    let maxAlert = 0;
    for (let i = 0; i < 60; i++) {
      g.debugTryOneAction();
      const st = g.debugState();
      const cones = g.world.fxGroup.children.filter((c: any) => c.name === "threat").length;
      if (cones > maxCones) maxCones = cones;
      if (st.alert > maxAlert) maxAlert = st.alert;
      if (st.gameOver) break;
    }
    return { maxCones, maxAlert };
  });
  expect(seen.maxAlert, `alert escalated to ${seen.maxAlert}`).toBeGreaterThanOrEqual(1);
  expect(seen.maxCones, `cone telegraphs drawn (${seen.maxCones})`).toBeGreaterThanOrEqual(1);
  await page.screenshot({ path: "artifacts/chars-cones.png" });
});

test("character grounding: the render foundation is measurable, not just present", async ({ page }) => {
  // VISION evidence for the polished-rendering bar on the character side: units must sit on a
  // lit, tonemapped stage with AO and a working shadow rig. Measured from the live canvas:
  // composer chain contents, shadow casters, luminance band and shadow-vs-lit contrast.
  await deploy(page, "/?seed=11");
  const q = await measureRenderQuality(page);
  expect(q.passes, `composer chain: ${q.passes}`).toContain("OutputPass");
  expect(q.passes, `composer chain: ${q.passes}`).toContain("SSAOPass");
  expect(q.passes, `composer chain: ${q.passes}`).toContain("UnrealBloomPass");
  // Units are shadow casters; a visible rig needs enough of them plus the 2048 key shadow map.
  expect(q.perf.shadows, `scene shadow casters ${q.perf.shadows}`).toBeGreaterThan(20);
  expect(q.keyShadow, `key light shadow rig: ${q.keyShadow}`).toBe("true:2048:1");
  // Characters must read against a lit band, not a near-black backdrop (greybox failure mode).
  expect(q.meanLum, `mean scene luminance ${q.meanLum}`).toBeGreaterThan(0.085);
  expect(q.meanLum, `mean scene luminance ${q.meanLum}`).toBeLessThan(0.26);
  expect(q.dynRange, `dynamic range p95-p05 ${q.dynRange}`).toBeGreaterThan(0.28);
  // Shadowed floor probes adjacent to blockers must be measurably darker than lit reference.
  expect(q.pairs.length, "at least one shadowed/lit floor probe pair").toBeGreaterThanOrEqual(1);
  for (const p of q.pairs) {
    expect(p.lit, `lit floor reference at ${p.sx},${p.sz} reads ${p.lit}`).toBeGreaterThan(0.14);
    expect(p.shadow, `shadowed floor at ${p.sx},${p.sz} reads ${p.shadow} vs lit ${p.lit}`).toBeLessThan(p.lit * 0.75);
  }
  await page.screenshot({ path: "artifacts/chars-foundation.png" });
});

// ---- CHARACTERS (polish slice V2) — added evidence. These strengthen the oracle: a plain pawn
// cylinder would be a single Mesh with a single shared material, no rig child, no emissive bloom,
// and a frozen transform, so all four assertions below would fail. ----

test("squad operatives are multi-part rigs: distinct silhouettes, per-part materials, emissive bloom", async ({ page }) => {
  // Mission 3 deploys the whole squad (vanguard breacher, ghost infiltrator, cipher tech).
  await deploy(page, "/?seed=4242&mission=3");
  await page.waitForTimeout(300);
  const out = await page.evaluate(() => {
    const T = (window as unknown as { __sbThree: any }).__sbThree;
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const w = g.world;
    const s = g.debugState();
    const box = new T.Box3();
    const res: Record<string, any> = {};
    for (const u of s.units) {
      if (u.side !== "player" || !u.alive) continue;
      const m = w.unitMeshes.get(u.id);
      if (!m || !m.userData.rig) {
        res[u.archetype] = { missing: true };
        continue;
      }
      const rig = m.userData.rig;
      let meshes = 0;
      const mats = new Set<string>();
      let maxEmissive = 0;
      let emissiveNonFlat = false;
      rig.traverse((o: any) => {
        if (o.isMesh) {
          meshes++;
          const one = Array.isArray(o.material) ? o.material[0] : o.material;
          if (one) {
            mats.add(one.uuid);
            const ei = one.emissiveIntensity ?? 0;
            const eh = one.emissive?.getHex?.() ?? 0;
            if (ei >= 0.8 && eh !== 0) emissiveNonFlat = true;
            if (ei > maxEmissive) maxEmissive = ei;
          }
        }
      });
      box.setFromObject(rig);
      const sz = box.getSize(new T.Vector3());
      res[u.archetype] = { meshes, mats: mats.size, emissiveNonFlat, maxEmissive: +maxEmissive.toFixed(2), w: +sz.x.toFixed(3), h: +sz.y.toFixed(3) };
    }
    return res;
  });
  const sig: string[] = [];
  for (const a of ["vanguard", "ghost", "cipher"]) {
    const r = (out as any)[a];
    expect(r && !r.missing, `${a} carries a rig group`).toBeTruthy();
    expect(r.meshes, `${a} multi-part rig (${r.meshes} parts)`).toBeGreaterThanOrEqual(3);
    expect(r.mats, `${a} per-part materials (${r.mats})`).toBeGreaterThanOrEqual(2);
    expect(r.emissiveNonFlat, `${a} has a blooming emissive material (peak ${r.maxEmissive})`).toBe(true);
    sig.push(`${r.w}x${r.h}`);
  }
  // The three archetypes must not collapse into one shared silhouette.
  expect(new Set(sig).size, `distinct bounding signatures ${sig.join(", ")}`).toBeGreaterThanOrEqual(3);
  await page.screenshot({ path: "artifacts/chars-squad.png" });
});

test("squad rigs are observably live while idle: rig transforms change with no input", async ({ page }) => {
  await deploy(page, "/?seed=4242&mission=3");
  await page.waitForTimeout(400);
  const sample = () =>
    page.evaluate(() => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      const w = g.world;
      const s = g.debugState();
      const out: Record<string, { ry: number; by: number; bs: number }> = {};
      for (const u of s.units) {
        if (u.side !== "player" || !u.alive) continue;
        const m = w.unitMeshes.get(u.id);
        const rig = m?.userData.rig;
        const breath = m?.userData.breath;
        if (!rig || !breath) continue;
        out[u.archetype] = { ry: +rig.rotation.y.toFixed(4), by: +breath.position.y.toFixed(4), bs: +breath.scale.y.toFixed(4) };
      }
      return out;
    });
  const t0 = await sample();
  await page.waitForTimeout(650); // several rendered frames, NO action dispatched
  const t1 = await sample();
  for (const a of ["vanguard", "ghost", "cipher"]) {
    const a0 = (t0 as any)[a];
    const a1 = (t1 as any)[a];
    expect(a0 && a1, `${a} present in both samples`).toBeTruthy();
    const d = Math.max(Math.abs(a0.ry - a1.ry), Math.abs(a0.by - a1.by), Math.abs(a0.bs - a1.bs));
    expect(d, `${a} idle transform delta ${d}`).toBeGreaterThan(1e-4);
  }
  await page.screenshot({ path: "artifacts/chars-idle.png" });
});

// ---- V2 corrective — background-proof subject evidence (added, nothing removed) ----------------
// The earlier close-up gate accepted a frame merely because a central-band pixel matched a teal hue
// band (g>150 && g>r+40 && b>120). That is TRUE OF THE ENVIRONMENT (trim 0x6fe8ff, cyan-lit deck), so
// it certified wall-dominated frames in which the operative was nearly invisible. This test removes
// that hole at the HARNESS level: each operative is captured SUBJECT-ISOLATED — deck/walls/props/
// fog/other units/effects hidden over a plain neutral backdrop — and accepted only if (a) the frame
// border reads as the neutral backdrop (a game view's edges are lit scenery, never a flat neutral
// field, so the environment CANNOT satisfy it) and (b) a large centred blob of the subject's own
// pixels is present with real projected coverage. If an angle genuinely cannot be framed, the helper
// throws rather than shipping a bad frame.
test("isolated subject evidence: each operative reads as a centred subject over a neutral backdrop", async ({ page, context }) => {
  await deploy(page, "/?seed=4242&mission=3");
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  const report: Record<string, unknown> = {};
  for (const arch of ["vanguard", "ghost", "cipher"]) {
    const id = await page.evaluate((a) => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      const u = g.debugState().units.find((x: any) => x.alive && x.side === "player" && x.archetype === a);
      return u ? u.id : null;
    }, arch);
    expect(id, `${arch}: a living player unit of this archetype must exist to frame`).toBeTruthy();
    const path = `artifacts/chars-${arch}-isolated.png`;
    const { stats, pose } = await captureIsolatedSubject(page, context, path, "unit", [id as string], { w: vp.width, h: vp.height, big: false, projHMin: 0.4, tag: arch });
    report[arch] = { borderNeutral: stats.borderNeutralFrac, subjFrac: stats.subjectFrac, cover: stats.coverage, centerDist: stats.centerDist, poseH: pose.projHeightFrac, poseCov: pose.coverage };
    // (a) isolation proof: the neutral border cannot be produced by the game view.
    expect(stats.borderNeutralFrac, `${arch}: border must be the neutral backdrop, not scenery (got ${stats.borderNeutralFrac})`).toBeGreaterThanOrEqual(0.8);
    // (b) subject proof: the operative's own pixels form a centred blob of real size (non-backdrop).
    expect(stats.subjectFrac, `${arch}: central band must carry the subject's own pixels (got ${stats.subjectFrac})`).toBeGreaterThanOrEqual(0.25);
    expect(stats.coverage, `${arch}: subject mass fraction of the frame (got ${stats.coverage})`).toBeGreaterThanOrEqual(0.05);
    expect(stats.centerDist, `${arch}: subject mass must stay centred (got ${stats.centerDist})`).toBeLessThanOrEqual(0.3);
    // (c) framing proof, derived from the subject's own projected bounding box.
    expect(pose.projHeightFrac, `${arch}: projected height >= 0.4 of frame (got ${pose.projHeightFrac})`).toBeGreaterThanOrEqual(0.4);
    expect(pose.coverage, `${arch}: projected bbox coverage of the frame (got ${pose.coverage})`).toBeGreaterThanOrEqual(0.08);
    // the three archetypes must not collapse into one identical measurement (guards a frozen/blank rig).
  }
  const sigs = new Set(Object.values(report).map((v: any) => `${v.subjFrac}:${v.cover}:${v.centerDist}`));
  expect(sigs.size, `distinct per-archetype measurements ${JSON.stringify(report)}`).toBeGreaterThanOrEqual(2);
  console.log("CHAR-ISOLATED " + JSON.stringify(report));
});

// ---- V5 MATERIAL POLISH (ADDITIVE — nothing above removed or weakened) -------------------------
// The supervisor's read of the isolated captures was "flat-shaded box assemblies". The bar now is
// that a plain pawn (single shared material, no texture) is REJECTED: each operative must carry a
// varied material set (>= 4 distinct materials) with AT LEAST ONE procedurally textured part (a
// material exposing a .map — armour/cloth/gear, not flat colour), an emissive element, and it must
// STILL be measurably distinct from the other two archetypes (the bounding signatures must not
// collapse toward one shared shape). If a future change flattens the materials back to a single
// shared colour, or merges the three silhouettes, this test fails and the product must be fixed.
test("V5 materials: each operative carries a varied material set including a textured part", async ({ page }) => {
  await deploy(page, "/?seed=4242&mission=3");
  await page.waitForTimeout(300);
  const out = await page.evaluate(() => {
    const T = (window as unknown as { __sbThree: any }).__sbThree;
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const w = g.world;
    const s = g.debugState();
    const box = new T.Box3();
    const res: Record<string, any> = {};
    for (const u of s.units) {
      if (u.side !== "player" || !u.alive) continue;
      const m = w.unitMeshes.get(u.id);
      if (!m || !m.userData.rig) {
        res[u.archetype] = { missing: true };
        continue;
      }
      const rig = m.userData.rig;
      let meshes = 0;
      const mats = new Set<string>();
      let textured = 0;
      let emissiveNonFlat = false;
      rig.traverse((o: any) => {
        if (o.isMesh) {
          meshes++;
          const one = Array.isArray(o.material) ? o.material[0] : o.material;
          if (one) {
            mats.add(one.uuid);
            if (one.map) textured++;
            const ei = one.emissiveIntensity ?? 0;
            const eh = one.emissive?.getHex?.() ?? 0;
            if (ei >= 0.8 && eh !== 0) emissiveNonFlat = true;
          }
        }
      });
      box.setFromObject(rig);
      const sz = box.getSize(new T.Vector3());
      res[u.archetype] = { meshes, mats: mats.size, textured, emissiveNonFlat, w: +sz.x.toFixed(3), h: +sz.y.toFixed(3) };
    }
    return res;
  });
  const sig: string[] = [];
  for (const a of ["vanguard", "ghost", "cipher"]) {
    const r = (out as any)[a];
    expect(r && !r.missing, `${a} carries a rig group`).toBeTruthy();
    expect(r.meshes, `${a} multi-part rig (${r.meshes} parts)`).toBeGreaterThanOrEqual(3);
    expect(r.mats, `${a} distinct materials (${r.mats})`).toBeGreaterThanOrEqual(4);
    expect(r.textured, `${a} textured (map-bearing) parts (${r.textured})`).toBeGreaterThanOrEqual(1);
    expect(r.emissiveNonFlat, `${a} has a blooming emissive material`).toBe(true);
    sig.push(`${r.w}x${r.h}`);
  }
  // The three archetypes must not collapse into one shared silhouette (distinctness preserved).
  expect(new Set(sig).size, `distinct bounding signatures ${sig.join(", ")}`).toBe(3);
  await page.screenshot({ path: "artifacts/chars-materials-v5.png" });
});
