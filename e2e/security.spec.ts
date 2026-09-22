// SECURITY NETWORK browser journey (INTEGRATION-class evidence).
//
// The security network is a real subsystem wired into the page, not invisible rules. A turret is a
// powered device on a labelled cluster; while the board is COVERT (alert < 1) a security turret must
// hold fire, but once its authority flips to "hijacked" it turns on the very guards it defended, and
// gunfire escalates the alarm while a silenced shot keeps the board covert.
//
// Every check is a two-run CONTRAST with a single variable changed, and the enemy-HP is read from the
// AUTHORITATIVE state (nothing in the sim damages an enemy except turret fire, so a guard losing HP
// is unambiguously "a turret shot it"). Non-superficial: it would fail if turrets never fired, if
// covert turrets preempted, or if a silenced shot escalated the alarm.
import { test, expect } from "@playwright/test";

async function deploy(page: import("@playwright/test").Page, url: string) {
  await page.goto(url);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 15000 });
  await page.waitForTimeout(1800);
}

// Build a fresh single-guard scene inside the real Core Chamber (mission 3) so turret fire is the
// ONLY possible source of enemy damage: all other enemies are made dead and the lone guard cannot
// move (moveLeft=0), then run ONE authoritative enemy phase. `mode` flips the turret's authority.
function turretScene(page: import("@playwright/test").Page, mode: "security" | "hijacked") {
  return page.evaluate((m) => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const s = g.debugState();
    const turret = s.devices.find((d: any) => d.kind === "turret");
    if (!turret) return { ok: false, why: "no turret in fixture" };
    // Isolate: one target guard, frozen in place, walked into the turret's firing arc.
    const others = s.units.filter((u: any) => u.alive && u.side === "enemy" && u.archetype === "sentry" && u.hp > 0);
    const guard = others[0];
    if (!guard) return { ok: false, why: "no guard" };
    for (const u of s.units) if (u.alive && u.side === "enemy" && u.id !== guard.id) u.alive = false;
    guard.pos = { x: turret.x - 1, y: turret.y, h: 0 };
    guard.moveLeft = 0;
    turret.owner = m === "hijacked" ? "hijacked" : "security";
    turret.powered = true;
    turret.disabled = false;
    s.alert = 0;
    const before = guard.hp;
    g.endTurn();
    const after = g.debugState().units.find((u: any) => u.id === guard.id);
    return { ok: true, netId: turret.netId as string, before, after: after ? after.hp : 0, alertAfter: g.debugState().alert };
  }, mode);
}

test("a covert security turret holds fire, but a hijacked turret turns on its own guards", async ({ page }) => {
  // COVERT CONTRAST: identical scene, turret is a powered security device and the board is quiet.
  await deploy(page, "/?seed=4242&mission=3");
  const covert = await turretScene(page, "security");
  expect(covert.ok, `setup: ${(covert as any).why}`).toBe(true);
  expect(covert.netId, "turret belongs to a labelled security cluster").toMatch(/^net_/);
  expect(covert.after, `covert turret must NOT preempt a guard (hp ${covert.before}->${covert.after})`).toBe(covert.before);

  // HIJACK CONTRAST: the ONLY change is authority -> now the network's own turret shoots the guard.
  await page.reload();
  await deploy(page, "/?seed=4242&mission=3");
  const hijacked = await turretScene(page, "hijacked");
  expect(hijacked.ok, `setup: ${(hijacked as any).why}`).toBe(true);
  expect(hijacked.after, `hijacked turret did not shoot its guard (hp ${hijacked.before}->${hijacked.after})`).toBeLessThan(hijacked.before);
  await page.screenshot({ path: "artifacts/sec-turret.png" });
});

test("loud gunfire escalates the board alarm; a silenced shot keeps the board covert", async ({ page }) => {
  // Isolate the noise/alarm rule with the camera network switched OFF, then take a single shot at an
  // isolated guard. LOUD = Vanguard (pulse rifle, noise 6); QUIET = Ghost (silenced shot, noise 1).
  const shot = async (url: string, sniperId: string) => {
    await deploy(page, url);
    return page.evaluate((sniper) => {
      const g = (window as unknown as { __sbGame: any }).__sbGame;
      const s = g.debugState();
      for (const d of s.devices) if (d.kind === "camera") { d.owner = "disabled"; d.powered = false; }
      s.alert = 0;
      const target = s.units.find((u: any) => u.alive && u.side === "enemy" && u.archetype === "sentry");
      const neighbor = s.units.find((u: any) => u.alive && u.side === "enemy" && u.archetype === "hunter");
      target.pos = { x: 1, y: 6, h: 0 };
      if (neighbor) neighbor.pos = { x: 1, y: 8, h: 0 };
      const sniperUnit = s.units.find((u: any) => u.id === sniper);
      sniperUnit.pos = { x: 1, y: 3, h: 0 };
      const attack = { kind: "attack" as const, unitId: sniper, ability: sniperUnit.defaultAttack as string, targetUnitId: target.id };
      g.debugAttack(sniper, target.id);
      const st = g.debugState();
      const t = st.units.find((u: any) => u.id === target.id);
      void attack;
      return { alert: st.alert, targetDet: t ? t.detState : "gone", targetHp: t ? t.hp : 0, defaultAttack: sniperUnit.defaultAttack as string };
    }, sniperId);
  };

  const loud = await shot("/?seed=4242&mission=3", "p_vanguard_0");
  expect(loud.defaultAttack, "vanguard default shot must be the loud pulse rifle").toBe("pulse_rifle");
  expect(loud.targetHp, "the loud shot must have hit the target").toBeLessThan(12);
  expect(loud.alert, `loud gunfire must raise the alarm (alert=${loud.alert})`).toBeGreaterThanOrEqual(1);

  // QUIET run: identical setup; only the weapon changes, so any alarm change is attributable to it.
  await page.reload();
  const quiet = await shot("/?seed=4242&mission=3", "p_ghost_1");
  expect(quiet.defaultAttack, "ghost default shot must be the silenced shot").toBe("silenced_shot");
  expect(quiet.targetHp, "the silenced shot must have hit the target").toBeLessThan(12);
  expect(quiet.alert, `a silenced shot must NOT escalate (alert=${quiet.alert})`).toBe(0);
  expect(quiet.targetDet, "a silenced hit must not wake the target").not.toBe("alerted");
  await page.screenshot({ path: "artifacts/sec-alarm.png" });
});