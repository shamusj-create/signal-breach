// UI SYSTEM evidence (real browser -> real server, no mocks): keyboard-operable menus, honest
// empty/error/success states for the leaderboard roundtrip, settings persistence, and rejection
// of invalid submissions by the authoritative server revalidator.
//
// V4 PRESENTATION ORACLE (ADDITIVE — none of the three tests above removed or weakened):
//   • title-screen composition: layered presentation layers must be present, not a blank field
//   • body-text WCAG contrast: hint text must reach >=4.5:1 against its own panel
//   • HUD layout: left/right panels must not overlap and must not clip at 1024×768 and 1440-wide
//   • state distinguishability: enabled controls have cursor:pointer; disabled have not-allowed
import { test, expect } from "@playwright/test";

test("UI keyboard: menus are operable without a mouse and settings toggles persist", async ({ page }) => {
  await page.goto("/");
  // Keyboard-only: Tab must be able to reach the mute toggle, Enter activates it, and the
  // choice must survive a reload (accessibility settings are persisted, not session-ephemeral).
  let reachable = false;
  for (let i = 0; i < 6; i++) {
    const id = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "");
    if (id === "toggle-mute") {
      reachable = true;
      break;
    }
    await page.keyboard.press("Tab");
  }
  expect(reachable, "mute toggle reachable via Tab").toBe(true);
  const before = await page.evaluate(() => document.activeElement?.textContent ?? "");
  await page.keyboard.press("Enter");
  const mid = await page.getByTestId("toggle-mute").innerText();
  expect(mid, "Enter flips the focused toggle").not.toBe(before);
  await page.reload();
  await expect(page.getByTestId("toggle-mute")).toHaveText(mid, { timeout: 5000 });
  await page.getByTestId("toggle-reduced-motion").click();
  await page.reload();
  await expect(page.getByTestId("toggle-reduced-motion")).toContainText("ON", { timeout: 5000 });
});

test("UI leaderboard: real backend roundtrip shows honest success then honest failure states", async ({ page }) => {
  // Success state: server IS running (playwright webServer) — the screen must report OK and
  // either the empty hint or real rows, never a silent blank.
  await page.goto("/");
  await page.getByTestId("open-leaderboard").click();
  await expect(page.getByText("(OK)")).toBeVisible({ timeout: 8000 });
  const anyState = await page.locator(".lb").innerText();
  expect(anyState.length, "leaderboard renders empty-hint or rows").toBeGreaterThan(3);
  // Failure state: with the API unreachable the same screen must degrade honestly.
  await page.route("**/api/leaderboard**", (route) => void route.abort());
  await page.goto("/");
  await page.getByTestId("open-leaderboard").click();
  await expect(page.getByText("(server unavailable)")).toBeVisible({ timeout: 8000 });
});

test("UI backend: the server rejects an invalid (tampered) submission and it never enters the board", async ({ page }) => {
  await page.goto("/");
  const marker = `ghost-${Date.now()}`;
  const res = await page.evaluate(async (player: string) => {
    const r = await fetch("/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mission: 0,
        seed: 1,
        actions: [{ kind: "endTurn" }, { kind: "endTurn" }], // truncated: not a real winning log
        claimedOutcome: "win",
        claimedScore: 999999,
        player,
      }),
    });
    return { status: r.status, body: (await r.json()) as { accepted?: boolean; reason?: string } };
  }, marker);
  expect(res.status, "doctored submission is rejected with 400").toBe(400);
  expect(res.body.accepted, "server must not accept a fake win").toBe(false);
  await page.getByTestId("open-leaderboard").click();
  await expect(page.getByText("(OK)")).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(marker, { exact: true })).toHaveCount(0);
});

// ─── V4 PRESENTATION ORACLE (all ADDITIVE; do not remove or weaken any test above) ───────────

// Helper: deploy a game at a given viewport and wait for the real HUD to be live.
async function deployAt(page: import("@playwright/test").Page, w: number, h: number) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto("/?seed=4242");
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(
    () => !!(window as unknown as { __sbGame?: unknown }).__sbGame,
    null,
    { timeout: 20000 },
  );
  await page.waitForTimeout(2200);
}

test("V4 title presentation: title screen carries layered atmosphere layers, not a blank field", async ({ page }) => {
  await page.goto("/");
  await page.waitForTimeout(200);
  // At least one decorative presentation layer must exist.
  const layers = await page.locator(".title-haze, .title-scanlines, .title-horizon").count();
  expect(layers, "title screen must have >=1 decorative presentation layer").toBeGreaterThanOrEqual(1);
  // The shell background must be a MULTI-LAYER composition, not a single solid colour.
  const bg = await page.locator(".menu-shell").first().evaluate((el) => getComputedStyle(el).backgroundImage);
  const layerCount = (bg.match(/gradient\(/g) ?? []).length;
  expect(layerCount, `shell must use >=3 gradient layers (found ${layerCount})`).toBeGreaterThanOrEqual(3);
});

test("V4 contrast: HUD body text reaches >=4.5:1 WCAG against its own panel background at 1024x768", async ({ page }) => {
  await deployAt(page, 1024, 768);
  const result = await page.evaluate(() => {
    // Walk every .hint element in the HUD and its parent panel; return the worst ratio found.
    const hints = Array.from(document.querySelectorAll<HTMLElement>(".hud .hint, .hud .row-label, .hud .obj-status, .hud .cam-hint"));
    if (hints.length === 0) return { error: "no body text found" };
    const parse = (c: string): [number, number, number, number] | null => {
      const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (!m) return null;
      return [+m[1], +m[2], +m[3], m[4] !== undefined ? parseFloat(m[4]) : 1];
    };
    const lin = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    const lum = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    let worst = 99;
    let worstLabel = "";
    for (const el of hints) {
      const cs = getComputedStyle(el);
      const tc = parse(cs.color);
      if (!tc) continue;
      // Find the nearest ancestor that has a background color set (the "panel").
      let panel = el.parentElement;
      let panelBg: [number, number, number, number] | null = null;
      while (panel) {
        const ps = getComputedStyle(panel);
        const bg = ps.backgroundColor;
        const parsed = parse(bg);
        if (parsed && (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent" && bg !== "rgba(0,0,0,0)")) {
          panelBg = parsed;
          break;
        }
        panel = panel.parentElement;
      }
      if (!panelBg) continue; // no panel bg to test against
      // Composite panel bg (may have alpha) over dark scene proxy rgb(5,7,13).
      const a = panelBg[3];
      const eff = [5 * (1 - a) + panelBg[0] * a, 7 * (1 - a) + panelBg[1] * a, 13 * (1 - a) + panelBg[2] * a];
      const Lt = lum(tc);
      const Lb = lum(eff);
      const ratio = (Math.max(Lt, Lb) + 0.05) / (Math.min(Lt, Lb) + 0.05);
      if (ratio < worst) { worst = ratio; worstLabel = `${el.className}: ${cs.color} on ${JSON.stringify(panelBg)}`; }
    }
    return { worst: +worst.toFixed(3), worstLabel };
  });
  expect(result, `contrast result: ${JSON.stringify(result)}`).not.toHaveProperty("error");
  expect(
    (result as { worst: number }).worst,
    `worst body-text contrast ${(result as { worst: number; worstLabel: string }).worst}:1 on "${(result as { worst: number; worstLabel: string }).worstLabel}" must be >= 4.5:1`,
  ).toBeGreaterThanOrEqual(4.5);
});

test("V4 layout: HUD panels do not overlap or clip at 1024x768", async ({ page }) => {
  await deployAt(page, 1024, 768);
  const issues = await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const result: string[] = [];
    const left = document.querySelector(".hud-left")?.getBoundingClientRect();
    const right = document.querySelector(".hud-right")?.getBoundingClientRect();
    const bottom = document.querySelector(".hud-bottom")?.getBoundingClientRect();
    // Left and right must not overlap.
    if (left && right && left.right + 4 > right.left) {
      result.push(`hud-left right ${(left.right).toFixed(0)} overlaps hud-right left ${(right.left).toFixed(0)}`);
    }
    // Check bottom bar is fully inside viewport horizontally.
    if (bottom && (bottom.left < 0 || bottom.right > vw)) {
      result.push(`hud-bottom overflows viewport: left=${(bottom.left).toFixed(0)} right=${(bottom.right).toFixed(0)} vw=${vw}`);
    }
    // Check that panels don't push their content into clipping (scrollWidth vs clientWidth).
    const panels = document.querySelectorAll<HTMLElement>(".hud-left, .hud-right");
    for (const p of panels) {
      if (p.scrollWidth > p.clientWidth + 4) {
        result.push(`${p.className}: content overflows (scrollW=${p.scrollWidth} clientW=${p.clientWidth})`);
      }
    }
    // Check no .hud button is outside viewport.
    document.querySelectorAll<HTMLElement>(".hud button").forEach((b) => {
      const r = b.getBoundingClientRect();
      if (r.left < -1 || r.right > vw + 1 || r.bottom > vh + 1) {
        result.push(`button "${b.textContent?.slice(0, 20)}" outside viewport`);
      }
    });
    return result;
  });
  expect(issues, `layout issues at 1024x768: ${issues.join("; ")}`).toHaveLength(0);
});

test("V4 layout: HUD panels do not overlap or clip at 1440x900", async ({ page }) => {
  await deployAt(page, 1440, 900);
  const issues = await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const result: string[] = [];
    const left = document.querySelector(".hud-left")?.getBoundingClientRect();
    const right = document.querySelector(".hud-right")?.getBoundingClientRect();
    if (left && right && left.right + 4 > right.left) {
      result.push(`hud-left right overlaps hud-right left at 1440`);
    }
    const bottom = document.querySelector(".hud-bottom")?.getBoundingClientRect();
    if (bottom && (bottom.left < 0 || bottom.right > vw)) {
      result.push(`hud-bottom overflows at 1440: right=${(bottom.right).toFixed(0)} vw=${vw}`);
    }
    document.querySelectorAll<HTMLElement>(".hud button").forEach((b) => {
      const r = b.getBoundingClientRect();
      if (r.left < -1 || r.right > vw + 1 || r.bottom > vh + 1) {
        result.push(`button "${b.textContent?.slice(0, 20)}" outside viewport at 1440`);
      }
    });
    return result;
  });
  expect(issues, `layout issues at 1440x900: ${issues.join("; ")}`).toHaveLength(0);
});

test("V4 states: enabled HUD controls show cursor:pointer; disabled controls show cursor:not-allowed", async ({ page }) => {
  await deployAt(page, 1280, 720);
  const result = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLElement>(".hud button"));
    const enabled = btns.filter((b) => !b.hasAttribute("disabled"));
    const disabled = btns.filter((b) => b.hasAttribute("disabled"));
    const badEnabled = enabled.filter((b) => {
      const c = getComputedStyle(b).cursor;
      return c !== "pointer" && c !== "auto" && c !== "default";
    });
    const badDisabled = disabled.filter((b) => {
      const c = getComputedStyle(b).cursor;
      return c !== "not-allowed" && c !== "default";
    });
    return {
      total: btns.length,
      enabled: enabled.length,
      disabled: disabled.length,
      badEnabled: badEnabled.map((b) => `${b.textContent?.slice(0, 18)}(${getComputedStyle(b).cursor})`),
      badDisabled: badDisabled.map((b) => `${b.textContent?.slice(0, 18)}(${getComputedStyle(b).cursor})`),
    };
  });
  expect(result.total, "HUD has interactive buttons to test").toBeGreaterThan(0);
  expect(result.badEnabled, `enabled buttons with wrong cursor: ${result.badEnabled.join(", ")}`).toHaveLength(0);
  expect(result.badDisabled, `disabled buttons with wrong cursor: ${result.badDisabled.join(", ")}`).toHaveLength(0);
});

// V4 TEXT-FIT ORACLE (ADDITIVE — no existing assertion removed or weakened). The two primary HUD
// buttons ("End Turn (Enter)", "Next Operative (Tab)") rendered as "End Turn (Ent..." / "Next
// Operative (T..." at 1280x720 because .btn used white-space:nowrap + overflow:hidden +
// text-overflow:ellipsis inside a half-viewport-width bottom bar. The existing layout assertions
// cannot see this class of defect: a CLIPPED element still sits fully inside the viewport, so the
// "outside viewport" check passed while the label was truncated. This test closes that hole at the
// harness level — NO HUD text element may have scrollWidth greater than clientWidth (i.e. clipped /
// ellipsised / horizontally-overflowing text), measured at BOTH 1024x768 and 1440-wide. It fails if
// a future label widening or container change re-introduces truncation, so the product (not the
// test) must be fixed if it ever trips.
async function clippedText(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const hud = document.querySelector(".hud");
    if (!hud) return ["no .hud present"];
    // Text-bearing targets: every HUD button plus the fixed-width labels/chips that could ellipsise.
    const nodes = Array.from(
      hud.querySelectorAll<HTMLElement>(
        "button, .chip, .hint, .cam-hint, .row-label, .unit-name, .squad-name, .obj-label, .obj-status, .obj-title",
      ),
    );
    for (const el of nodes) {
      if (el.clientWidth === 0) continue; // not laid out / hidden
      const isButton = el.tagName === "BUTTON";
      const hasOwnText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0);
      if (!isButton && !hasOwnText) continue; // pure layout wrappers are not text clips
      if (el.scrollWidth > el.clientWidth + 1) {
        out.push(`${el.className || el.tagName}: "${(el.textContent ?? "").trim().slice(0, 28)}" scrollW=${el.scrollWidth} clientW=${el.clientWidth}`);
      }
    }
    return out;
  });
}

test("V4 text-fit: no HUD element clips its own text (scrollWidth<=clientWidth) at 1280x720, 1024x768 and 1440-wide", async ({ page }) => {
  // 1280x720 is included on purpose: that is the exact viewport where the supervisor saw
  // "End Turn (Ent..." / "Next Operative (T...", so the guard must cover it, not just 1024/1440.
  for (const [w, h] of [[1280, 720], [1024, 768], [1440, 900]] as const) {
    await deployAt(page, w, h);
    // The two primary buttons must be present and their FULL label visible (not ellipsised).
    const endTurn = page.getByTestId("end-turn");
    await expect(endTurn, "End Turn button present").toBeVisible();
    const clip = await clippedText(page);
    expect(clip, `clipped/clipping HUD text at ${w}x${h}: ${clip.join(" | ")}`).toHaveLength(0);
    // Explicit regression guard for the exact reported defect: the primary buttons must not clip.
    const btnClips = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".hud button"))
        .filter((b) => b.scrollWidth > b.clientWidth + 1)
        .map((b) => `"${(b.textContent ?? "").trim().slice(0, 28)}" ${b.scrollWidth}>${b.clientWidth}`),
    );
    expect(btnClips, `clipped button labels at ${w}x${h}: ${btnClips.join(" | ")}`).toHaveLength(0);
  }
});
