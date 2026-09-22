// Standalone effect-vs-idle difference measurer for supervisor review (NOT a product/test oracle).
// Decodes two saved PNGs in headless Chromium and reports the fraction of pixels whose luminance
// changed beyond a delta, plus mean absolute luminance change. Run: node scripts/fxdiff.mjs
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";

const pairs = [
  ["artifacts/review-1280x720-fx-fire-idle.png", "artifacts/review-1280x720-fx-fire.png", 1280, 720],
  ["artifacts/review-1024x768-fx-fire-idle.png", "artifacts/review-1024x768-fx-fire.png", 1024, 768],
  ["artifacts/review-1280x720-fx-impact-idle.png", "artifacts/review-1280x720-fx-impact.png", 1280, 720],
  ["artifacts/review-1024x768-fx-impact-idle.png", "artifacts/review-1024x768-fx-impact.png", 1024, 768],
];

const browser = await chromium.launch();
const ctx = await browser.newContext();
for (const [aPath, bPath, w, h] of pairs) {
  if (!existsSync(aPath) || !existsSync(bPath)) { console.log(`MISSING ${aPath} <-> ${bPath}`); continue; }
  const aB = readFileSync(aPath).toString("base64");
  const bB = readFileSync(bPath).toString("base64");
  const p = await ctx.newPage();
  await p.setViewportSize({ width: w, height: h });
  await p.setContent(`<body style="margin:0"><img id="a" src="data:image/png;base64,${aB}"><img id="b" src="data:image/png;base64,${bB}"></body>`, { waitUntil: "load" });
  await p.waitForFunction(() => {
    const a = document.getElementById("a");
    const b = document.getElementById("b");
    return a && b && a.complete && b.complete && a.naturalWidth > 0 && b.naturalWidth > 0;
  }, null, { timeout: 15000 });
  const s = await p.evaluate(() => {
    const ia = document.getElementById("a");
    const ib = document.getElementById("b");
    const cw = ia.naturalWidth, ch = ia.naturalHeight;
    const ca = document.createElement("canvas"); ca.width = cw; ca.height = ch;
    const xa = ca.getContext("2d"); xa.drawImage(ia, 0, 0);
    const da = xa.getImageData(0, 0, cw, ch).data;
    const cb = document.createElement("canvas"); cb.width = cw; cb.height = ch;
    const xb = cb.getContext("2d"); xb.drawImage(ib, 0, 0);
    const db = xb.getImageData(0, 0, cw, ch).data;
    const lum = (d, i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    let changed16 = 0, changed8 = 0, changed4 = 0, sumDelta = 0, maxDelta = 0, sumA = 0, sumB = 0;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = (y * cw + x) * 4;
        const la = lum(da, i), lb = lum(db, i);
        sumA += la; sumB += lb;
        const d = Math.abs(lb - la);
        sumDelta += d;
        if (d > maxDelta) maxDelta = d;
        if (d > 0.02) changed4++;
        if (d > 0.04) changed8++;
        if (d > 0.16) changed16++;
      }
    }
    const n = cw * ch;
    return {
      cw, ch, n,
      changedFrac16: +(changed16 / n).toFixed(6),
      changedPct4: +(100 * changed4 / n).toFixed(4),
      changedPct8: +(100 * changed8 / n).toFixed(4),
      changedPct16: +(100 * changed16 / n).toFixed(4),
      meanAbsDelta: +(sumDelta / n).toFixed(5),
      maxDelta: +maxDelta.toFixed(4),
      meanLumA: +(sumA / n).toFixed(4),
      meanLumB: +(sumB / n).toFixed(4),
    };
  });
  await p.close();
  console.log(`${bPath.replace("artifacts/", "")} vs idle: changedPx@4=${s.changedPct4}% @8=${s.changedPct8}% @16=${s.changedPct16}% (frac16=${s.changedFrac16}) meanAbsDelta=${s.meanAbsDelta} maxDelta=${s.maxDelta} lumA=${s.meanLumA} lumB=${s.meanLumB}`);
}
await browser.close();