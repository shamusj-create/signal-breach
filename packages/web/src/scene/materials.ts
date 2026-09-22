// Procedural environment materials (presentation only, no new dependency, no network fetch, no
// binary assets). All maps are generated at runtime on a Canvas2D and wrapped as THREE.CanvasTexture.
// Colour maps are flagged SRGBColorSpace so they do not read washed-out under ACES tone mapping;
// roughness maps stay linear. Wrap is RepeatWrapping with anisotropy so the deck/wall tiling stays
// sharp at the game camera distance instead of shimmering/aliasing.
import * as THREE from "three";

export interface EnvMats {
  deck: THREE.MeshStandardMaterial;
  deckAlt: THREE.MeshStandardMaterial;
  wall: THREE.MeshStandardMaterial;
  wallTop: THREE.MeshStandardMaterial;
  crate: THREE.MeshStandardMaterial;
  hazard: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  cable: THREE.MeshStandardMaterial;
}

const S = 256;

function canvas2d(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  return [c, c.getContext("2d") as CanvasRenderingContext2D];
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function colorTex(canvas: HTMLCanvasElement, aniso: number, rx: number, ry: number): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(rx, ry);
  t.needsUpdate = true;
  return t;
}

// Roughness/metalness data maps must remain linear (NoColorSpace) or they tint the surface.
function dataTex(canvas: HTMLCanvasElement, aniso: number, rx: number, ry: number): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.repeat.set(rx, ry);
  t.needsUpdate = true;
  return t;
}

function speckle(cx: CanvasRenderingContext2D, seed: number, n: number, darkAlpha: number, lightAlpha: number) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const x = r() * S;
    const y = r() * S;
    const rad = 3 + r() * 22;
    const dark = r() < 0.62;
    const grd = cx.createRadialGradient(x, y, 0, x, y, rad);
    const a = dark ? 0.06 + r() * darkAlpha : 0.04 + r() * lightAlpha;
    grd.addColorStop(0, dark ? `rgba(14,17,22,${a.toFixed(3)})` : `rgba(150,164,182,${(a * 0.7).toFixed(3)})`);
    grd.addColorStop(1, "rgba(0,0,0,0)");
    cx.fillStyle = grd;
    cx.beginPath();
    cx.arc(x, y, rad, 0, Math.PI * 2);
    cx.fill();
  }
}

function scratches(cx: CanvasRenderingContext2D, seed: number, n: number) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const x = r() * S;
    const y = r() * S;
    const len = 8 + r() * 60;
    const ang = (r() - 0.5) * 0.5;
    const light = r() < 0.5;
    cx.strokeStyle = light ? `rgba(170,184,200,${(0.03 + r() * 0.06).toFixed(3)})` : `rgba(12,15,20,${(0.05 + r() * 0.09).toFixed(3)})`;
    cx.lineWidth = 0.5 + r() * 1.1;
    cx.beginPath();
    cx.moveTo(x, y);
    cx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    cx.stroke();
  }
}

function rivet(cx: CanvasRenderingContext2D, x: number, y: number) {
  cx.fillStyle = "rgba(158,170,186,0.55)";
  cx.beginPath();
  cx.arc(x, y, 3.1, 0, Math.PI * 2);
  cx.fill();
  cx.fillStyle = "rgba(8,10,14,0.55)";
  cx.beginPath();
  cx.arc(x + 1, y + 1, 1.5, 0, Math.PI * 2);
  cx.fill();
}

// Metal deck plates: panel seam around the tile, brushed streaks, grime and roughness break-up.
function deckMaps(aniso: number, rx: number, ry: number) {
  const [cc, cx] = canvas2d();
  const g = cx.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, "#3a4553");
  g.addColorStop(0.5, "#333e4b");
  g.addColorStop(1, "#2b3542");
  cx.fillStyle = g;
  cx.fillRect(0, 0, S, S);
  speckle(cx, 1337, 22, 0.16, 0.09);
  scratches(cx, 9001, 46);
  cx.strokeStyle = "rgba(10,13,17,0.6)";
  cx.lineWidth = 6;
  cx.strokeRect(3, 3, S - 6, S - 6);
  cx.strokeStyle = "rgba(128,140,158,0.22)";
  cx.lineWidth = 1.4;
  cx.strokeRect(8, 8, S - 16, S - 16);
  for (const [x, y] of [[14, 14], [S - 14, 14], [14, S - 14], [S - 14, S - 14], [S / 2, 9], [9, S / 2], [S - 9, S / 2], [S / 2, S - 9]]) rivet(cx, x, y);

  const [rc, rg] = canvas2d();
  rg.fillStyle = "#bdbdbd";
  rg.fillRect(0, 0, S, S);
  speckle(rg, 2468, 30, 0.5, 0.4);
  rg.strokeStyle = "#6d6d6d";
  rg.lineWidth = 6;
  rg.strokeRect(3, 3, S - 6, S - 6);
  return { map: colorTex(cc, aniso, rx, ry), rough: dataTex(rc, aniso, rx, ry) };
}

// Panelled armour: two-tone panels with bevel edges, bolt rows, seams between panels.
function wallMaps(aniso: number, rx: number, ry: number) {
  const [cc, cx] = canvas2d();
  cx.fillStyle = "#41536a";
  cx.fillRect(0, 0, S, S);
  const cell = S / 2;
  const r = rng(4242);
  for (let py = 0; py < 2; py++) {
    for (let px = 0; px < 2; px++) {
      const x = px * cell;
      const y = py * cell;
      const shade = 0.86 + r() * 0.22;
      cx.fillStyle = `rgb(${Math.round(70 * shade)},${Math.round(90 * shade)},${Math.round(116 * shade)})`;
      cx.fillRect(x + 5, y + 5, cell - 10, cell - 10);
      cx.strokeStyle = "rgba(16,20,26,0.5)";
      cx.lineWidth = 3;
      cx.strokeRect(x + 5, y + 5, cell - 10, cell - 10);
      cx.strokeStyle = "rgba(150,166,186,0.25)";
      cx.lineWidth = 1.2;
      cx.strokeRect(x + 8, y + 8, cell - 16, cell - 16);
      for (const [bx, by] of [[x + 14, y + 14], [x + cell - 14, y + 14], [x + 14, y + cell - 14], [x + cell - 14, y + cell - 14]]) rivet(cx, bx, by);
    }
  }
  speckle(cx, 555, 14, 0.12, 0.05);

  const [rc, rg] = canvas2d();
  rg.fillStyle = "#a9a9a9";
  rg.fillRect(0, 0, S, S);
  rg.strokeStyle = "#767676";
  rg.lineWidth = 4;
  rg.beginPath();
  rg.moveTo(cell, 0);
  rg.lineTo(cell, S);
  rg.moveTo(0, cell);
  rg.lineTo(S, cell);
  rg.stroke();
  return { map: colorTex(cc, aniso, rx, ry), rough: dataTex(rc, aniso, rx, ry) };
}

// Ribbed metal crate: plank ridges + darker corner banding, distinct from the deck.
function crateMaps(aniso: number) {
  const [cc, cx] = canvas2d();
  cx.fillStyle = "#7a5630";
  cx.fillRect(0, 0, S, S);
  for (let i = 0; i < 5; i++) {
    const x = (i + 0.5) * (S / 5);
    cx.fillStyle = "rgba(40,26,12,0.35)";
    cx.fillRect(x - 7, 0, 14, S);
    cx.fillStyle = "rgba(190,150,96,0.18)";
    cx.fillRect(x + 7, 0, 3, S);
  }
  cx.fillStyle = "rgba(28,18,8,0.5)";
  cx.fillRect(0, 0, S, 10);
  cx.fillRect(0, S - 10, S, 10);
  speckle(cx, 777, 16, 0.12, 0.06);
  const [rc, rx] = canvas2d();
  rx.fillStyle = "#cfcfcf";
  rx.fillRect(0, 0, S, S);
  speckle(rx, 888, 20, 0.4, 0.3);
  return { map: colorTex(cc, aniso, 1, 1), rough: dataTex(rc, aniso, 1, 1) };
}

// Hazard striping: diagonal caution chevrons used for emissive floor accents (tasteful).
function stripeTex(aniso: number): THREE.CanvasTexture {
  const [cc, cx] = canvas2d();
  cx.fillStyle = "#2a3040";
  cx.fillRect(0, 0, S, S);
  cx.strokeStyle = "rgba(255,120,50,0.85)";
  cx.lineWidth = 26;
  for (let i = -S; i < S * 2; i += 52) {
    cx.beginPath();
    cx.moveTo(i, -20);
    cx.lineTo(i + S, S + 20);
    cx.stroke();
  }
  return colorTex(cc, aniso, 1, 1);
}

// Thin emissive trim gradient for edge runs (reads as a lit conduit, not flat paint).
function trimTex(aniso: number): THREE.CanvasTexture {
  const [cc, cx] = canvas2d();
  const g = cx.createLinearGradient(0, 0, S, 0);
  g.addColorStop(0, "rgba(60,180,220,0.15)");
  g.addColorStop(0.5, "rgba(120,230,255,0.9)");
  g.addColorStop(1, "rgba(60,180,220,0.15)");
  cx.fillStyle = g;
  cx.fillRect(0, 0, S, S);
  return colorTex(cc, aniso, 1, 1);
}

// ---- character (operative) materials, V5 --------------------------------------------------------
// Built ONCE per World (shared across the three operatives) and reused as .map/.roughnessMap on the
// armour/cloth parts, so the characters stop being flat single-colour boxes. Same runtime-Canvas2D
// recipe as the V1 environment materials: no new dependency, no network fetch, no binary assets.
export interface CharTex {
  armourMap: THREE.CanvasTexture;
  armourRough: THREE.CanvasTexture;
  clothMap: THREE.CanvasTexture;
}

// Beabelled armour plate: a two-tone panel grid with lighter bevel lips on each panel edge, a
// scattered bolt row, a worn faction stripe and light edge-scuffing. Multiplied over a gunmetal
// albedo it reads as layered plate rather than one flat slab.
function armourMaps(aniso: number): { map: THREE.CanvasTexture; rough: THREE.CanvasTexture } {
  const [cc, cx] = canvas2d();
  const g = cx.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, "#8b98a8");
  g.addColorStop(0.5, "#79879a");
  g.addColorStop(1, "#657183");
  cx.fillStyle = g;
  cx.fillRect(0, 0, S, S);
  const cell = S / 2;
  const r = rng(20260922);
  for (let py = 0; py < 2; py++) {
    for (let px = 0; px < 2; px++) {
      const x = px * cell;
      const y = py * cell;
      const shade = 0.9 + r() * 0.18;
      cx.fillStyle = `rgb(${Math.round(120 * shade)},${Math.round(134 * shade)},${Math.round(150 * shade)})`;
      cx.fillRect(x + 6, y + 6, cell - 12, cell - 12);
      // bevel: dark recess then a light lip toward the panel centre
      cx.strokeStyle = "rgba(24,30,38,0.55)";
      cx.lineWidth = 3;
      cx.strokeRect(x + 6, y + 6, cell - 12, cell - 12);
      cx.strokeStyle = "rgba(190,202,218,0.42)";
      cx.lineWidth = 1.4;
      cx.strokeRect(x + 9, y + 9, cell - 18, cell - 18);
      for (const [bx, by] of [[x + 16, y + 16], [x + cell - 16, y + 16], [x + 16, y + cell - 16], [x + cell - 16, y + cell - 16]]) rivet(cx, bx, by);
    }
  }
  // worn faction stripe (kept low-chroma so the team hue still reads through it)
  cx.fillStyle = "rgba(150,180,170,0.16)";
  cx.fillRect(0, S * 0.46, S, 10);
  scratches(cx, 5150, 30);
  speckle(cx, 3131, 12, 0.10, 0.05);

  const [rc, rg] = canvas2d();
  rg.fillStyle = "#9a9a9a";
  rg.fillRect(0, 0, S, S);
  rg.strokeStyle = "#5c5c5c";
  rg.lineWidth = 4;
  rg.strokeRect(6, 6, cell - 12, cell - 12);
  rg.strokeRect(cell + 6, 6, cell - 12, cell - 12);
  rg.strokeRect(6, cell + 6, cell - 12, cell - 12);
  rg.strokeRect(cell + 6, cell + 6, cell - 12, cell - 12);
  speckle(rg, 7272, 18, 0.35, 0.28);
  return { map: colorTex(cc, aniso, 1, 1), rough: dataTex(rc, aniso, 1, 1) };
}

// Tropic-weave cloth: a fabric base with darker camo blobs and fine vertical thread lines, used for
// the torso/coat/legs so the fabric has pattern instead of one flat colour.
function clothMaps(aniso: number): THREE.CanvasTexture {
  const [cc, cx] = canvas2d();
  const g = cx.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, "#5a7d74");
  g.addColorStop(0.5, "#4d6f68");
  g.addColorStop(1, "#42615c");
  cx.fillStyle = g;
  cx.fillRect(0, 0, S, S);
  const r = rng(97531);
  for (let i = 0; i < 14; i++) {
    const x = r() * S;
    const y = r() * S;
    const rad = 12 + r() * 34;
    const grd = cx.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, `rgba(30,44,42,${(0.2 + r() * 0.22).toFixed(3)})`);
    grd.addColorStop(1, "rgba(0,0,0,0)");
    cx.fillStyle = grd;
    cx.beginPath();
    cx.arc(x, y, rad, 0, Math.PI * 2);
    cx.fill();
  }
  cx.strokeStyle = "rgba(150,180,172,0.10)";
  cx.lineWidth = 1;
  for (let x = 0; x < S; x += 3) {
    cx.beginPath();
    cx.moveTo(x, 0);
    cx.lineTo(x, S);
    cx.stroke();
  }
  return colorTex(cc, aniso, 1, 1);
}

export function buildEnvMaterials(aniso: number): EnvMats {
  const deck = deckMaps(aniso, 14, 14);
  const deckAlt = deckMaps(aniso, 4, 4);
  const wall = wallMaps(aniso, 2, 1);
  const crate = crateMaps(aniso);
  const hazard = stripeTex(aniso);
  const trim = trimTex(aniso);

  const deckMat = new THREE.MeshStandardMaterial({ color: 0xd8dfe8, map: deck.map, roughnessMap: deck.rough, metalness: 0.22, roughness: 0.78 });
  const deckAltMat = new THREE.MeshStandardMaterial({ color: 0xc2ccd6, map: deckAlt.map, roughnessMap: deckAlt.rough, metalness: 0.2, roughness: 0.72 });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xd8dfe8, map: wall.map, roughnessMap: wall.rough, metalness: 0.3, roughness: 0.62 });
  const wallTopMat = new THREE.MeshStandardMaterial({ color: 0x35434f, metalness: 0.4, roughness: 0.55, emissive: 0x0c1620, emissiveIntensity: 0.35 });
  const crateMat = new THREE.MeshStandardMaterial({ color: 0xd8dfe8, map: crate.map, roughnessMap: crate.rough, metalness: 0.15, roughness: 0.74 });
  const hazardMat = new THREE.MeshStandardMaterial({ color: 0x2a3040, map: hazard, emissive: 0xff5a2c, emissiveIntensity: 0.32, emissiveMap: hazard, metalness: 0.1, roughness: 0.7, transparent: true, opacity: 0.62, depthWrite: false });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: trim, emissive: 0x6fe8ff, emissiveIntensity: 0.6, emissiveMap: trim, metalness: 0.2, roughness: 0.5, transparent: true, opacity: 0.7, depthWrite: false });
  const cableMat = new THREE.MeshStandardMaterial({ color: 0x1a222c, metalness: 0.65, roughness: 0.45 });

  return { deck: deckMat, deckAlt: deckAltMat, wall: wallMat, wallTop: wallTopMat, crate: crateMat, hazard: hazardMat, trim: trimMat, cable: cableMat };
}

// Character-side procedural maps, built once per World and shared by every operative rig (so the
// per-unit rig materials can reference them without rebuilding a canvas per unit or per frame).
export function buildCharTextures(aniso: number): CharTex {
  const armour = armourMaps(aniso);
  return {
    armourMap: armour.map,
    armourRough: armour.rough,
    clothMap: clothMaps(aniso),
  };
}