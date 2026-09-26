// COMMENTARY criterion (c-commentary-e2e, BROWSER): a scrollable, tabbed top-right panel with a
// running play-by-play. Asserts (1) entries appear AS actions happen with the expected CONTENT (not
// merely that some text changed), (2) they are in chronological order, (3) the list genuinely
// scrolls (scrollHeight > clientHeight once there is enough history), (4) both tabs work, and (5)
// objectives + squad stay reachable after the re-layout. Commentary wording is player-facing — the
// last test scans it for developer markers / internal codes / test ids. No mocks.
import { test, expect } from "@playwright/test";

type Page = import("@playwright/test").Page;

const DEV_MARKERS: RegExp[] = [
  /\(OK\)/, /\(server unavailable\)/i, /\bTODO\b/, /\bFIXME\b/, /\bXXX\b/,
  /\bNaN\b/, /\bundefined\b/, /\[object /, /0x[0-9a-fA-F]{4,}/, /:\d{4}\b/,
  /\bERR_[A-Z_]+/, /Error:\s/,
];
const TESTID_LEAKS = ["server-status", "submit-status", "open-leaderboard", "hud-phase", "end-turn", "game-canvas", "new-campaign"];

async function deploy(page: Page, seed: number) {
  // Skip the first-run card so it never sits over the board while we drive the feed.
  await page.addInitScript(() => localStorage.setItem("sb.onboarding.seen.v2", "1"));
  await page.goto(`/?seed=${seed}`);
  await page.getByTestId("new-campaign").click();
  await page.getByTestId("deploy").click();
  await page.waitForFunction(() => !!(window as unknown as { __sbGame?: unknown }).__sbGame, null, { timeout: 20000 });
  await page.waitForTimeout(1400);
}

// Read the current commentary feed straight from the game (chronological, oldest first).
function feed(page: Page) {
  return page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.feed.map((f: any) => ({ seq: f.seq, text: f.text })));
}

// The rendered entries, in DOM order, with their sequence numbers (for order + newest checks).
function renderedEntries(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="commentary-pane"] [data-testid="cm-entry"]')).map((el) => ({
      seq: Number(el.getAttribute("data-seq")),
      text: (el.textContent || "").trim(),
    })),
  );
}

test("COMMENTARY — entries appear as actions happen with the expected content, newest at the bottom, chronological", async ({ page }) => {
  await deploy(page, 4242);
  await page.getByTestId("tab-commentary").click();
  const pane = page.getByTestId("commentary-pane");
  await expect(pane, "commentary pane is shown when its tab is active").toBeVisible();

  // The panel opens with a seeded line and is chronological from the start.
  const before = await renderedEntries(page);
  expect(before.length, "the feed starts non-empty (turn history is available)").toBeGreaterThan(0);

  // --- a player MOVE logs a move entry (expected content) and it lands at the bottom (newest) ---
  const beforeCount = (await renderedEntries(page)).length;
  const moved = await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    const s = g.debugState();
    const players = s.units.filter((x: any) => x.alive && x.side === "player");
    for (const u of players) {
      g.debugSelect(u.id);
      const fp = g.debugFarthestPath(u.id);
      if (fp.ok && fp.path && fp.path.length >= 2) {
        g.debugMove(u.id, fp.path);
        return { ok: true, name: u.name };
      }
    }
    return { ok: false };
  });
  expect(moved.ok, "fixture has a multi-step player move to log").toBe(true);
  await page.waitForTimeout(1600); // let the display tween settle so the move is committed
  let after = await renderedEntries(page);
  expect(after.length, "a new entry was appended for the move").toBeGreaterThan(beforeCount);
  const newRegion = after.slice(beforeCount).map((e) => e.text).join("\n");
  expect(newRegion, "the move was logged among the new (bottom) entries").toMatch(/moved\./);

  // --- an enemy PHASE logs the phase transition (expected content) and keeps chronological order ---
  const seqBeforePhase = after.map((e) => e.seq);
  await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.endTurn());
  await page.waitForTimeout(700);
  after = await renderedEntries(page);
  const texts = after.map((e) => e.text);
  expect(texts.join("\n"), "the enemy phase was logged").toMatch(/Enemy phase/);
  expect(texts.join("\n"), "the turn came back to the player and was logged").toMatch(/Your phase/);
  // chronological order: sequence numbers strictly increase top → bottom, newest entry is last.
  const seqs = after.map((e) => e.seq);
  expect(seqs.length, "entries exist").toBeGreaterThan(seqBeforePhase.length);
  let ordered = true;
  for (let i = 1; i < seqs.length; i++) if (seqs[i] <= seqs[i - 1]) ordered = false;
  expect(ordered, `entries are in chronological order (seq ${seqs.join(",")})`).toBe(true);
});

test("COMMENTARY — the log genuinely scrolls and carries the full action vocabulary in chronological order", async ({ page }) => {
  await deploy(page, 4242);
  await page.getByTestId("tab-commentary").click();
  await page.waitForTimeout(200);

  // Flood real play through the authoritative action path (moves + shots + enemy phases) so there is
  // enough history that the list must scroll and the full vocabulary appears.
  await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    for (let turn = 0; turn < 16; turn++) {
      const s = g.debugState();
      if (s.gameOver) break;
      for (const u of s.units.filter((x: any) => x.alive && x.side === "player")) {
        const fp = g.debugFarthestPath(u.id);
        if (fp.ok && fp.path && fp.path.length >= 2) g.debugMove(u.id, fp.path);
      }
      const s2 = g.debugState();
      for (const u of s2.units.filter((x: any) => x.alive && x.side === "player")) {
        const en = s2.units.find(
          (e: any) => e.alive && e.side === "enemy" && Math.max(Math.abs(e.pos.x - u.pos.x), Math.abs(e.pos.y - u.pos.y)) <= (u.atkRange ?? 3),
        );
        if (en && u.energy >= 3) g.debugAttack(u.id, en.id);
      }
      g.endTurn();
    }
  });
  await page.waitForTimeout(400);

  // It genuinely scrolls: content height exceeds the visible height once there is enough history.
  const box = await page.getByTestId("commentary-pane").evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(box.clientHeight, "the commentary pane has a visible height").toBeGreaterThan(40);
  expect(box.scrollHeight, `commentary scrolls (scrollH ${box.scrollHeight} > clientH ${box.clientHeight})`).toBeGreaterThan(box.clientHeight);

  // Chronological order holds across the whole list, and the vocabulary is present (not just "some
  // text changed"): moves, shots and hits/damage, plus phase/turn transitions.
  const after = await renderedEntries(page);
  const seqs = after.map((e) => e.seq);
  let ordered = true;
  for (let i = 1; i < seqs.length; i++) if (seqs[i] <= seqs[i - 1]) ordered = false;
  expect(ordered, "the whole log stays chronological").toBe(true);
  const all = after.map((e) => e.text).join("\n");
  expect(all, "moves are logged").toMatch(/moved\./);
  expect(all, "shots and/or hits/damage are logged").toMatch(/shot at|was hit for|fired|Hit for/);
  expect(all, "phase/turn transitions are logged").toMatch(/Enemy phase/);

  // Scrollable back through history: jumping to the top reveals the earliest lines.
  await page.getByTestId("commentary-pane").evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(100);
  const topTexts = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="commentary-pane"] [data-testid="cm-entry"]')).slice(0, 3).map((el) => el.textContent || ""),
  );
  expect(topTexts.join(" ").toLowerCase(), "the earliest history is reachable at the top").toContain("turn 1");
});

test("COMMENTARY — both tabs work and objectives + squad stay reachable after the re-layout", async ({ page }) => {
  await deploy(page, 4242);

  // Objectives tab is the default and carries objectives + squad.
  const objTab = page.getByTestId("tab-objectives");
  await expect(objTab, "objectives tab defaults to active").toHaveAttribute("aria-selected", "true");
  const objectives = page.getByTestId("objectives-pane");
  await expect(objectives, "objectives pane is visible by default").toBeVisible();
  await expect(objectives, "objective progress count is present").toContainText(/Relays \d+ of \d+/);
  const objText = await objectives.innerText();
  expect(objText, "objective states are reachable").toMatch(/Ready|Sealed|Done|Breach|Idle/);
  expect(objText, "squad is kept in the same tab").toMatch(/SQUAD/);
  expect(objText, "squad health lines are still reachable").toMatch(/HP \d+\/\d+/);

  // Switch to Commentary, then back to Objectives: both tabs work and re-show their content.
  await page.getByTestId("tab-commentary").click();
  await expect(page.getByTestId("commentary-pane"), "commentary tab shows its pane").toBeVisible();
  await expect(page.getByTestId("objectives-pane"), "objectives content is hidden while on commentary").toHaveCount(0);

  await page.getByTestId("tab-objectives").click();
  await expect(page.getByTestId("objectives-pane"), "objectives are reachable again after re-layout").toBeVisible();
  await expect(page.getByTestId("objectives-pane"), "squad content is reachable again").toContainText(/HP \d+\/\d+/);
  await expect(page.getByTestId("obj-progress")).toContainText(/Relays \d+ of \d+/);
});

test("COMMENTARY — the feed wording is player-facing (no developer markers, internal codes or test ids)", async ({ page }) => {
  await deploy(page, 4242);
  await page.getByTestId("tab-commentary").click();
  // Generate a real history (moves + shots + phases) so there is wording to scan.
  await page.evaluate(() => {
    const g = (window as unknown as { __sbGame: any }).__sbGame;
    for (let turn = 0; turn < 10; turn++) {
      const s = g.debugState();
      if (s.gameOver) break;
      for (const u of s.units.filter((x: any) => x.alive && x.side === "player")) {
        const fp = g.debugFarthestPath(u.id);
        if (fp.ok && fp.path && fp.path.length >= 2) g.debugMove(u.id, fp.path);
      }
      const s2 = g.debugState();
      for (const u of s2.units.filter((x: any) => x.alive && x.side === "player")) {
        const en = s2.units.find((e: any) => e.alive && e.side === "enemy" && Math.max(Math.abs(e.pos.x - u.pos.x), Math.abs(e.pos.y - u.pos.y)) <= (u.atkRange ?? 3));
        if (en && u.energy >= 3) g.debugAttack(u.id, en.id);
      }
      g.endTurn();
    }
  });
  await page.waitForTimeout(400);
  const text = await page.getByTestId("commentary-pane").innerText();
  expect(text.length, "there is commentary text to scan").toBeGreaterThan(10);
  const hits: string[] = [];
  for (const m of DEV_MARKERS) { const h = text.match(m); if (h) hits.push(`${m}:${h[0]}`); }
  for (const id of TESTID_LEAKS) if (text.includes(id)) hits.push(`testid:${id}`);
  expect(hits, `commentary leaks developer markers: ${hits.join(" | ")}`).toHaveLength(0);
});

test("COMMENTARY — objective changes are logged in the feed as they happen, in plain language", async ({ page }) => {
  await deploy(page, 4242);
  await page.getByTestId("tab-commentary").click();
  await expect(page.getByTestId("commentary-pane"), "commentary pane is shown").toBeVisible();

  // Before playing, the feed carries only seeded/deploy history — no objective-progress line yet.
  const beforeFeed = await feed(page);
  expect(
    beforeFeed.map((f) => f.text).join("\n"),
    "objective-progress wording is not fabricated before an objective actually changes",
  ).not.toMatch(/hacked|Core is open|Extraction is open|mission complete/i);

  // Drive a REAL playthrough through the authoritative action path until the mission completes. This
  // exercises the same act()/endTurn() pipeline a pointer uses, so the objective-progress entries are
  // produced by genuine objective transitions, not by a mock.
  const play = await page.evaluate(() => (window as unknown as { __sbGame: any }).__sbGame.debugPlaythroughLogged());
  expect(play.victory, "the fixture playthrough reaches Extraction (so the terminal line is valid evidence)").toBe(true);
  await page.waitForTimeout(250);

  const after = await feed(page);
  const texts = after.map((e) => e.text);

  // (1) The objective entries actually appear, and they are NOT the deploy/seed lines — they were
  // appended while objectives changed (so the count of new entries is non-zero and they are present).
  expect(after.length, "new feed entries were appended as objectives changed").toBeGreaterThan(beforeFeed.length);
  const joined = texts.join("\n");
  expect(joined, "a relay being hacked is logged with the running relay count").toMatch(/hacked — \d of 2 relays\./);
  expect(joined, "the second relay opens the Core (both-relay line)").toContain("Both relays hacked — the Core is open.");
  expect(joined, "breaching the Core opens Extraction").toContain("Core breached — Extraction is open.");
  expect(joined, "reaching Extraction ends the mission").toContain("Extraction reached — mission complete.");

  // (2) There are at least four distinct objective-progress entries (relay(s) + Core-open + Core-breach
  // + Extraction), each a separate line — not one lumped line.
  const objLines = texts.filter((t) => /hacked|Core is open|Extraction is open|mission complete/i.test(t));
  expect(objLines.length, `objective-progress entries = ${objLines.length}`).toBeGreaterThanOrEqual(4);

  // (3) They sit inside the running feed in chronological order (sequence strictly increases top→bottom),
  // proving they are integrated into the same play-by-play, not a separate panel.
  const seqs = after.map((e) => e.seq);
  let ordered = true;
  for (let i = 1; i < seqs.length; i++) if (seqs[i] <= seqs[i - 1]) ordered = false;
  expect(ordered, `objective entries stay chronological (seq ${seqs.join(",")})`).toBe(true);

  // (4) They render in the Commentary PANE (feed UI), and the wording is player-facing (no dev markers
  // / internal codes / test ids), same discipline as the rest of the feed.
  const paneText = await page.getByTestId("commentary-pane").innerText();
  for (const line of ["Both relays hacked — the Core is open.", "Core breached — Extraction is open.", "Extraction reached — mission complete."]) {
    expect(paneText, `the pane renders "${line}"`).toContain(line);
  }
  const leaks: string[] = [];
  for (const m of DEV_MARKERS) { const h = paneText.match(m); if (h) leaks.push(`${m}:${h[0]}`); }
  for (const id of TESTID_LEAKS) if (paneText.includes(id)) leaks.push(`testid:${id}`);
  expect(leaks, `objective entries leak developer markers: ${leaks.join(" | ")}`).toHaveLength(0);
});