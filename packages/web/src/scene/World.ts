// Three.js presentation layer. Pure rendering; never mutates or reads simulation rules beyond
// the read-only GameState handed to it. Determinism is unaffected by rendering (see sim tests).
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { buildEnvMaterials, buildCharTextures, type EnvMats, type CharTex } from "./materials.ts";

export const TILE = 1;
export const GRID = 14;

const COLORS = {
  ground: 0x33465c,
  groundAlt: 0x2a3b4f,
  wall: 0x48607a,
  wallTop: 0x4a6480,
  crate: 0x7a5630,
  hazard: 0xff5a2c,
  extraction: 0x28f0a0,
  terminal: 0x2bd7ff,
  core: 0xb14bff,
  cell: 0xffb020,
  player: 0x25e0c0,
  enemy: 0xff4d6d,
  selection: 0x8affff,
  path: 0x2bd7ff,
  range: 0xff9a3c,
  trail: 0xffb020,
  hoverRange: 0x2bd7ff,
  hoverOutline: 0xb6ff3a,
};

export interface CameraState {
  angle: number; // 0..3 quarters
  zoom: number;
  target: THREE.Vector3;
}

interface Particle {
  points: THREE.Points;
  life: number;
  max: number;
  vel: Float32Array;
}

// One transient effect instance: its mesh, how long it has lived, its total duration and an
// optional per-frame update driven by the 0..1 life fraction. tick must not allocate.
interface EffectRec {
  obj: THREE.Object3D;
  kind: string;
  t: number;
  dur: number;
  tick?: (o: THREE.Object3D, f: number) => void;
}

// A travelling projectile: a presentation-only flight path from a source tile to a target tile. It
// eases + arcs along that path, drags a fading trail, and resolves with an impact beat at the
// target. Its live head position is read back by flight-path.spec.ts across frames, so "it travels"
// is provable against screen geometry rather than a boolean flag. NEVER reads or mutates rules.
interface Projectile {
  head: THREE.Group;
  from: THREE.Vector3;
  to: THREE.Vector3;
  arc: number;
  t: number;
  dur: number;
  impactFired: boolean;
  fromKey: string;
  toKey: string;
}

export class World {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer | null = null;
  container: HTMLElement;
  boardGroup = new THREE.Group();
  unitGroup = new THREE.Group();
  fxGroup = new THREE.Group();
  fogGroup = new THREE.Group();
  // Procedurally-built environment materials (built once per World, shared across all board tiles
  // and props so material identities are stable and cheap to re-measure).
  envMats!: EnvMats;
  // Procedurally-built character maps (armour + cloth), shared across the three operatives so rig
  // surfaces are textured rather than flat colour. Built once per World in the constructor.
  charTex!: CharTex;
  private sharedMats = new Set<THREE.Material>();
  // 3-state fog quads: memory layer (dim) + unexplored layer (dark). Presentation only.
  private fogCells: { x: number; y: number; yTop: number }[] = [];
  private fogMem: THREE.InstancedMesh | null = null;
  private fogDark: THREE.InstancedMesh | null = null;
  unitMeshes = new Map<string, THREE.Group>();
  particles: Particle[] = [];
  // Transient combat/VFX objects. Every entry's mesh lives in fxGroup under name "fx" and is
  // removed (and disposed) when its timer expires or the board is rebuilt — so no effect can
  // linger past its duration or survive a mission change (no orphaned / late-appended objects).
  effects: EffectRec[] = [];
  // Traveling projectile effects (presentation-only flight paths). Separate from `effects` so their
  // per-frame travel can be stepped + sampled independently, but torn down the same way.
  projectiles: Projectile[] = [];
  projectileGroup = new THREE.Group();
  // Persistent (per-selection / per-hover) ability-target highlight layer, kept OUT of fxGroup so
  // clearMarkers()/clearEffects() never wipe it — it is cleared only explicitly. Presentation only.
  targetGroup = new THREE.Group();
  // Display-only time multiplier for the flight path (like tweenScale): raises it so a test yields many
  // sampled frames across one projectile. Presentational only; never touches authoritative state.
  flightScale = 1;
  // Reused scratch vectors so the render loop does NOT allocate per frame (see computeCamera).
  private _cv1 = new THREE.Vector3();
  private _cv2 = new THREE.Vector3();
  private _cv3 = new THREE.Vector3();
  // Shared geometry for cheap additive quads (muzzle/ping/etc). Geometry is shared, never disposed
  // per effect; only the per-effect material is disposed on expiry.
  private _quad = new THREE.PlaneGeometry(1, 1);
  alertWash: THREE.Mesh | null = null;
  shake = 0;
  animClock = 0;
  reducedMotion = false;
  // Display-only time multiplier for the move tween (default 1 = production speed). A test may raise
  // it so even a loaded machine yields many sampled frames across the tween. Purely presentational:
  // it only stretches the RENDER easing duration and never touches authoritative state. Reduced motion
  // still snaps (beginMove returns before any tween is created).
  tweenScale = 1;
  // Display-only movement tween. Eases a unit's RENDERED position along its real path so movement
  // reads as motion, not a snap (both sides). Never touches authoritative state; with reducedMotion
  // on, positions snap instead (beginMove/beginAutoStep no-op and syncUnits keeps its snap path).
  private moveTween = new Map<string, { pts: THREE.Vector3[]; cum: number[]; total: number; dur: number; t0: number }>();
  fpsValue = 0;
  fpsCount = 0;
  fpsAccum = 0;
  private raf = 0;
  private last = 0;
  private clock = new THREE.Clock();
  selectionRing: THREE.Group;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  // ---- last-move TRAIL (presentation of authoritative movement history) ----
  // One trail per unit: the tiles it travelled on its MOST RECENT move. Replaced (never appended)
  // when that unit moves again, kept separate per unit, cleared on board rebuild. Marker children are
  // named "trail" and live in their own group, so clearMarkers() (which removes "marker") never
  // touches them and the transient-effect teardown never does either. renderTrails is a CAPTURE-ONLY
  // toggle (default true) used to produce an isolated A/B of the trail against an otherwise-identical
  // frame; it gates rendering, never the recorded history. Presentation only; never read for rules.
  private trailGroup = new THREE.Group();
  private trailKeys = new Map<string, string[]>();
  renderTrails = true;

  // ---- HOVER visual: outline + max-move RANGE for the hovered piece (any side) ----
  // Clear on unhover / state change. Marker children named "hover-range"/"hover-outline".
  private hoverGroup = new THREE.Group();
  hoverUnit: string | null = null;
  hoverRange = new Set<string>();

  constructor(container: HTMLElement) {
    this.container = container;
    const w = container.clientWidth || 1024;
    const h = container.clientHeight || 768;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070c14);
    // Diorama depth: distance fog keeps the far rim receding, but the near plane sits past the
    // play area (camera ~13.4 units back, board half-diagonal ~10) so tiles, units and markers
    // in the play space read clear. Tuned with e2e/tools.probe.ts so HUD/luminance bands hold.
    this.scene.fog = new THREE.Fog(0x0a121c, 21, 44);

    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 220);
    this.camera.up.set(0, 1, 0);

    // Lighting rig: ambient + hemisphere fill + warm key (shadows) + cool/magenta rim accents.
    // The key is aimed from camera-right/far-side so ground shadows fall TOWARD the camera and
    // stay visible instead of hiding behind every blocker; albedo/ambient are raised so shadowed
    // surfaces still resolve (a too-dark deck made cast shadows indistinguishable from the floor).
    this.scene.add(new THREE.AmbientLight(0x35506b, 0.9));
    const hemi = new THREE.HemisphereLight(0x8fb4e8, 0x2a3946, 1.05);
    hemi.position.set(0, 22, 0);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffe6c4, 2.55);
    key.position.set(11, 17, -13);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 80;
    const s = 16;
    key.shadow.camera.left = -s;
    key.shadow.camera.right = s;
    key.shadow.camera.top = s;
    key.shadow.camera.bottom = -s;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x46688f, 0.55);
    fill.position.set(-13, 8, 12);
    this.scene.add(fill);
    const rimA = new THREE.PointLight(0x2bd7ff, 1.1, 70);
    rimA.position.set(2, 9, 17);
    this.scene.add(rimA);
    const rimB = new THREE.PointLight(0xff3a7a, 0.6, 70);
    rimB.position.set(-16, 7, -10);
    this.scene.add(rimB);

    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.envMats = buildEnvMaterials(aniso);
    for (const m of Object.values(this.envMats)) this.sharedMats.add(m);
    this.charTex = buildCharTextures(aniso);

    // Backdrop: a dim ground disc + a stone plinth slab so the diorama reads solid, not floating.
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(28, 64),
      new THREE.MeshStandardMaterial({ color: 0x1c2a3a, roughness: 0.95, metalness: 0 }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -0.06;
    disc.receiveShadow = true;
    this.scene.add(disc);
    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(GRID + 3.5, 1.4, GRID + 3.5),
      new THREE.MeshStandardMaterial({ color: 0x233243, roughness: 0.92, metalness: 0.05 }),
    );
    plinth.position.set(0, -0.7, 0);
    plinth.receiveShadow = true;
    this.scene.add(plinth);

    // Distant facility silhouettes beyond the plinth: horizon depth cue, pure backdrop. These are
    // tagged (name "backdrop") and held in `backdropGroup` so the framing contract can prove they
    // never intrude into the central foreground region, and so they can never be mistaken for cover.
    // They sit OUTSIDE the 14x14 footprint (inner radius >= 17.5) and are kept short so a gameplay
    // pitch projects them into the outer rim, never the middle of the frame.
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x22303f, roughness: 0.95, metalness: 0.1 });
    const N = 20;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + 0.19;
      const r = 17.5 + ((i * 37) % 5) * 1.1;
      const h = 0.9 + ((i * 53) % 6) * 0.22;
      const tw = 1.0 + ((i * 29) % 4) * 0.4;
      const t = new THREE.Mesh(new THREE.BoxGeometry(tw, h, tw * 0.65), towerMat);
      t.position.set(Math.sin(a) * r, h / 2 - 0.05, Math.cos(a) * r);
      t.name = "backdrop";
      t.userData = { backdrop: true };
      this.backdropGroup.add(t);
    }
    this.scene.add(this.backdropGroup);

    this.scene.add(this.boardGroup);
    this.scene.add(this.propGroup);
    this.scene.add(this.fogGroup);
    this.scene.add(this.unitGroup);
    this.trailGroup.name = "trailLayer";
    this.hoverGroup.name = "hoverLayer";
    this.scene.add(this.trailGroup);
    this.scene.add(this.hoverGroup);
    this.projectileGroup.name = "projectileLayer";
    this.scene.add(this.projectileGroup);
    this.targetGroup.name = "targetLayer";
    this.targetGroup.renderOrder = 7;
    this.scene.add(this.targetGroup);

    // selection reticle: outer + inner ring for an unmistakable marker at gameplay zoom.
    this.selectionRing = new THREE.Group();
    const mkRing = (r0: number, r1: number) => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(r0, r1, 36),
        new THREE.MeshBasicMaterial({ color: COLORS.selection, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }),
      );
      m.rotation.x = -Math.PI / 2;
      return m;
    };
    this.selectionRing.add(mkRing(0.3, 0.46));
    this.selectionRing.add(mkRing(0.52, 0.6));
    this.selectionRing.visible = false;
    this.fxGroup.add(this.selectionRing);

    this.initComposer();
    this.setAngle(0);
    this.start();
  }

  private initComposer() {
    try {
      const w = this.container.clientWidth || 1024;
      const h = this.container.clientHeight || 768;
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      // Subtle ambient occlusion from three's own examples (no new dependency). Multiplies a
      // contact-darkening mask over the beauty buffer so props/characters stop looking ungrounded.
      // Small kernel radius + short distance window keeps it under the threshold of "washed out".
      const ao = new SSAOPass(this.scene, this.camera, w, h);
      ao.kernelRadius = 5;
      ao.minDistance = 0.004;
      ao.maxDistance = 0.05;
      this.composer.addPass(ao);
      // Bloom threshold sits below emissive design levels (unit glows ~1.0-2.1, trim/markers
      // ~0.3-0.8 linear luminance) so teal/hazard accents read, without dragging the floor up.
      const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.5, 0.7, 0.42);
      this.composer.addPass(bloom);
      // OutputPass: applies tone mapping + sRGB conversion that the composer path otherwise skips.
      this.composer.addPass(new OutputPass());
    } catch {
      this.composer = null;
    }
  }


  private disposeGroup(g: THREE.Group) {
    const done = new Set<THREE.Material>();
    const kill = (m: THREE.Material | THREE.Material[] | undefined) => {
      const arr = Array.isArray(m) ? m : m ? [m] : [];
      for (const mat of arr) if (mat && !this.sharedMats.has(mat) && !done.has(mat)) {
        done.add(mat);
        mat.dispose();
      }
    };
    for (const child of [...g.children]) {
      g.remove(child);
      if (child instanceof THREE.Mesh || child instanceof THREE.InstancedMesh) {
        child.geometry.dispose();
        kill(child.material as THREE.Material | THREE.Material[]);
      }
    }
    g.clear();
  }

  // Restrained perimeter dressing: a raised cable/pipe conduit tray with an emissive trim line that
  // runs along the outer wall ring (diorama depth cue). Kept above the play plane so it can never
  // hide tiles, units or markers.
  private addConduit() {
    const M = this.envMats;
    const ring = GRID + 0.6;
    const yTop = 1.55;
    const run = (x: number, z: number, sx: number, sz: number) => {
      const tray = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.12, sz), M.cable);
      tray.position.set(x, yTop, z);
      tray.castShadow = true;
      this.boardGroup.add(tray);
      const line = new THREE.Mesh(new THREE.BoxGeometry(sx * 0.98, 0.03, sz * 0.98), M.trim);
      line.position.set(x, yTop + 0.09, z);
      this.boardGroup.add(line);
    };
    run(0, -ring / 2 + 0.4, ring, 0.25);
    run(0, ring / 2 - 0.4, ring, 0.25);
    run(-ring / 2 + 0.4, 0, 0.25, ring);
    run(ring / 2 - 0.4, 0, 0.25, ring);
    for (const [x, z] of [[-ring / 2 + 0.4, -ring / 2 + 0.4], [ring / 2 - 0.4, -ring / 2 + 0.4], [-ring / 2 + 0.4, ring / 2 - 0.4], [ring / 2 - 0.4, ring / 2 - 0.4]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.5, 0.3), M.cable);
      post.position.set(x, 0.75, z);
      post.castShadow = true;
      this.boardGroup.add(post);
    }
  }

  // Build the static board for a mission. Disposes previous. Floors become a single textured deck
  // plate mesh (seams + grime from the tiling deck map) so the arena is not one flat colour family;
  // walls/crates/pillars/props each get a distinct roughness/metalness/emissive material.
  buildBoard(tiles: { x: number; y: number; height: number; terrain: string }[], opts: { hazard: [number, number][] }) {
    void opts;
    // A board rebuild is a mission change: drop any lingering transient effects + particle bursts +
    // the alert wash so nothing is orphaned or late-appended against the new board. Trails + hover
    // are per-mission presentation state too, so they are wiped here (no trail survives a rebuild).
    this.clearEffects();
    this.clearProjectiles();
    this.clearTrails();
    this.clearHover();
    this.buildFog(tiles);
    this.disposeGroup(this.boardGroup);
    const M = this.envMats;

    // Continuous deck: one textured mesh. The panel-seam + grime pattern is the tiling deck map.
    const deck = new THREE.Mesh(new THREE.BoxGeometry(GRID, 0.16, GRID), M.deck);
    deck.position.set(0, 0.08, 0);
    deck.receiveShadow = true;
    this.boardGroup.add(deck);

    const hazardCells: { x: number; z: number }[] = [];
    for (const t of tiles) {
      const isWall = t.terrain === "wall" || t.terrain === "pillar";
      const wx = (t.x - 6.5) * TILE;
      const wz = (t.y - 6.5) * TILE;
      if (isWall) {
        const h = 1.7;
        const b = new THREE.Mesh(new THREE.BoxGeometry(TILE * 0.98, h, TILE * 0.98), t.terrain === "wall" ? M.wall : M.wallTop);
        b.position.set(wx, h / 2 - 0.05, wz);
        b.castShadow = true;
        b.receiveShadow = true;
        this.boardGroup.add(b);
        if (t.terrain === "pillar") {
          const cap = new THREE.Mesh(new THREE.BoxGeometry(TILE * 0.6, 0.06, TILE * 0.6), M.trim);
          cap.position.set(wx, h + 0.01, wz);
          this.boardGroup.add(cap);
        }
      } else if (t.terrain === "crate") {
        const b = new THREE.Mesh(new THREE.BoxGeometry(TILE * 0.9, 0.66, TILE * 0.9), M.crate);
        b.position.set(wx, 0.35, wz);
        b.castShadow = true;
        b.receiveShadow = true;
        this.boardGroup.add(b);
      } else if (t.terrain === "hazard") {
        hazardCells.push({ x: wx, z: wz });
      } else if (t.height > 0) {
        const th = Math.min(0.55, 0.16 + t.height * 0.5);
        const b = new THREE.Mesh(new THREE.BoxGeometry(TILE * 0.94, th, TILE * 0.94), M.deckAlt);
        b.position.set(wx, 0.16 + th / 2 - 0.02, wz);
        b.receiveShadow = true;
        this.boardGroup.add(b);
      }
    }

    // Hazard striping as ONE instanced emissive layer (cheap; sits under unit/marker height).
    if (hazardCells.length > 0) {
      const geo = new THREE.PlaneGeometry(TILE * 0.86, TILE * 0.86);
      const inst = new THREE.InstancedMesh(geo, M.hazard, hazardCells.length);
      const d = new THREE.Object3D();
      d.rotation.x = -Math.PI / 2;
      hazardCells.forEach((c, i) => {
        d.position.set(c.x, 0.17, c.z);
        d.updateMatrix();
        inst.setMatrixAt(i, d.matrix);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.renderOrder = 2;
      this.boardGroup.add(inst);
    }

    this.addConduit();
    this.renderer.shadowMap.needsUpdate = true;
  }

  // Rebuild the two fog quad layers for a fresh board (one InstancedMesh per state).
  private buildFog(tiles: { x: number; y: number; height: number; terrain: string }[]) {
    for (const child of [...this.fogGroup.children]) {
      this.fogGroup.remove(child);
      const mesh = child as THREE.InstancedMesh;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.fogCells = [];
    for (const t of tiles) {
      if (t.terrain === "wall" || t.terrain === "pillar") continue;
      this.fogCells.push({ x: t.x, y: t.y, yTop: 0.16 + t.height * 0.5 });
    }
    const n = this.fogCells.length;
    if (n === 0) {
      this.fogMem = null;
      this.fogDark = null;
      return;
    }
    const geo = new THREE.PlaneGeometry(TILE * 0.94, TILE * 0.94);
    const memMat = new THREE.MeshBasicMaterial({ color: 0x3b4c63, transparent: true, opacity: 0.35, depthWrite: false });
    const darkMat = new THREE.MeshBasicMaterial({ color: 0x05070d, transparent: true, opacity: 0.9, depthWrite: false });
    this.fogMem = new THREE.InstancedMesh(geo, memMat, n);
    this.fogDark = new THREE.InstancedMesh(geo.clone(), darkMat, n);
    this.fogMem.frustumCulled = false;
    this.fogDark.frustumCulled = false;
    this.fogMem.renderOrder = 3;
    this.fogDark.renderOrder = 4;
    this.fogGroup.add(this.fogMem);
    this.fogGroup.add(this.fogDark);
    this.setFog(null);
  }

  // Paint the 3-state fog. vis: 0 unexplored, 1 memory, 2 visible. Never mutates input.
  setFog(vis: Uint8Array | number[] | null) {
    if (!this.fogMem || !this.fogDark || this.fogCells.length === 0) return;
    const dummy = new THREE.Object3D();
    dummy.rotation.x = -Math.PI / 2;
    const zero = 1e-5;
    for (let i = 0; i < this.fogCells.length; i++) {
      const c = this.fogCells[i];
      const y = c.yTop + 0.06;
      const state = vis ? vis[c.y * GRID + c.x] : 0;
      dummy.position.set((c.x - 6.5) * TILE, y, (c.y - 6.5) * TILE);
      dummy.scale.setScalar(state === 1 ? 1 : zero);
      dummy.updateMatrix();
      this.fogMem.setMatrixAt(i, dummy.matrix);
      dummy.scale.setScalar(state === 0 ? 1 : zero);
      dummy.updateMatrix();
      this.fogDark.setMatrixAt(i, dummy.matrix);
    }
    this.fogMem.instanceMatrix.needsUpdate = true;
    this.fogDark.instanceMatrix.needsUpdate = true;
  }

  private makeUnitMesh(kind: string, side: "player" | "enemy"): THREE.Group {
    const g = new THREE.Group();
    const base = side === "player" ? COLORS.player : COLORS.enemy;
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      g.add(m);
      return m;
    };
    if (side === "enemy") {
      // ENEMY silhouettes are unchanged (they are the acceptance baseline for this criterion); the
      // only change is that the circular team marker now lives here so the squad can carry a
      // different SHAPE (chevron) and ownership reads without relying on colour alone.
      const bodyMat = new THREE.MeshStandardMaterial({ color: base, metalness: 0.4, roughness: 0.42, emissive: base, emissiveIntensity: 0.42 });
      const darkMat = new THREE.MeshStandardMaterial({ color: 0x26303c, metalness: 0.55, roughness: 0.55 });
      const glowMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: base, emissiveIntensity: 1.7 });
      const ringMat = new THREE.MeshStandardMaterial({ color: base, emissive: base, emissiveIntensity: 0.35, roughness: 0.4 });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.48, 28), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.015;
      g.add(ring);
      // Distinct silhouettes per archetype so threats read at a glance.
      if (kind === "sentry" || kind === "turret_drone") {
        // angular turret drone with a tracking eye
        add(new THREE.CylinderGeometry(0.3, 0.36, 0.5, 8), darkMat, 0, 0.24, 0);
        add(new THREE.ConeGeometry(0.36, 0.8, 6), bodyMat, 0, 0.62, 0);
        add(new THREE.SphereGeometry(0.12, 10, 10), glowMat, 0.2, 0.66, 0.05);
        g.userData.spin = true;
      } else if (kind === "hunter") {
        // low fast hull with swept fins and an orange thrust glow
        add(new THREE.BoxGeometry(0.66, 0.26, 0.5), darkMat, 0, 0.2, 0);
        add(new THREE.BoxGeometry(0.5, 0.5, 0.3), bodyMat, 0, 0.5, 0);
        add(new THREE.BoxGeometry(0.72, 0.08, 0.22), bodyMat, 0.18, 0.62, 0.16);
        add(new THREE.BoxGeometry(0.72, 0.08, 0.22), bodyMat, 0.18, 0.62, -0.16);
        const thrust = new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0xff9a3c, emissiveIntensity: 2.1, roughness: 0.4 });
        add(new THREE.SphereGeometry(0.1, 10, 10), thrust, -0.34, 0.3, 0);
      } else if (kind === "enforcer") {
        // squat armored box with a forward shield slab
        add(new THREE.BoxGeometry(0.78, 0.6, 0.7), darkMat, 0, 0.3, 0);
        add(new THREE.ConeGeometry(0.42, 0.62, 6), bodyMat, 0, 0.85, 0);
        const shieldMat = new THREE.MeshStandardMaterial({ color: 0x8d99a8, metalness: 0.7, roughness: 0.35 });
        add(new THREE.BoxGeometry(0.1, 0.72, 0.86), shieldMat, 0.44, 0.5, 0);
      } else {
        // warden: tall sensor pillar with a white shield halo
        add(new THREE.CylinderGeometry(0.26, 0.32, 1.0, 8), darkMat, 0, 0.5, 0);
        add(new THREE.ConeGeometry(0.3, 0.5, 8), bodyMat, 0, 1.15, 0);
        const haloMat = new THREE.MeshStandardMaterial({ color: 0xf2f6ff, emissive: 0xbfd4ff, emissiveIntensity: 1.4, transparent: true, opacity: 0.85 });
        const halo = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.05, 8, 24), haloMat);
        halo.rotation.x = Math.PI / 2;
        halo.position.y = 0.95;
        halo.castShadow = true;
        g.add(halo);
        g.userData.spin = true;
      }
      g.userData.side = "enemy";
      g.scale.setScalar(1.22);
      return g;
    }

    // ---- PLAYER operatives: distinct massing + per-part materials + emissive accents ----
    // Each archetype is a multi-part assembly on a child "rig" group. The rig is animated
    // procedurally in the render loop (idle breathing/sway + move-lean + fire/hit poses), so
    // nothing here is a static mesh. Forward is +x; the base chevron points forward.
    // V5: the flat single-colour "box assembly" look is broken with (a) bevelled/tapered geometry
    // (RoundedBoxGeometry + capsules + cones), (b) layered plating + silhouette gear (pauldrons,
    // packs, hoses, coat tail, blades) and (c) procedural armour/cloth maps shared from charTex so
    // no operative surface is a flat colour. Maps are built once per World, never per frame.
    const rig = new THREE.Group();
    g.add(rig);
    const C = this.charTex;
    // Bright teal team-colour cloth for the central torso/coat/legs. Deliberately NO texture map: the
    // team-colour oracle samples the team hue at each operative's own pixels, and a darkening cloth
    // texture pushed those pixels below the hue band. Textured gear (armour) is pushed to the sides
    // and back instead, so surfaces are still not flat colour while the teal core reads clearly.
    const cloth = new THREE.MeshStandardMaterial({ color: 0x1fc7b0, metalness: 0.1, roughness: 0.74 });
    const coat = new THREE.MeshStandardMaterial({ color: 0x18a293, metalness: 0.08, roughness: 0.8 });
    const armour = new THREE.MeshStandardMaterial({ color: 0x9fb0c2, map: C.armourMap, roughnessMap: C.armourRough, metalness: 0.72, roughness: 0.5 });
    const plate = new THREE.MeshStandardMaterial({ color: 0x70849a, metalness: 0.62, roughness: 0.4 });
    const plateDark = new THREE.MeshStandardMaterial({ color: 0x28313b, metalness: 0.5, roughness: 0.52 });
    const strap = new THREE.MeshStandardMaterial({ color: 0x14181e, metalness: 0.1, roughness: 0.8 });
    const optic = new THREE.MeshStandardMaterial({ color: 0x07242a, emissive: 0x25e0c0, emissiveIntensity: 1.3, metalness: 0.3, roughness: 0.35 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x07242a, emissive: 0x39ffe6, emissiveIntensity: 1.9, metalness: 0.2, roughness: 0.42 });
    const core = new THREE.MeshStandardMaterial({ color: 0x0a2a26, emissive: 0x2fe6c4, emissiveIntensity: 1.15, metalness: 0.1, roughness: 0.5 });
    const weaponMat = new THREE.MeshStandardMaterial({ color: 0x1b232c, metalness: 0.74, roughness: 0.42 });
    const weaponTrim = new THREE.MeshStandardMaterial({ color: 0x0a1a22, emissive: 0x25e0c0, emissiveIntensity: 0.85, metalness: 0.3, roughness: 0.4 });
    const markerMat = new THREE.MeshStandardMaterial({ color: base, emissive: base, emissiveIntensity: 0.55, roughness: 0.4 });

    // Facing chevron (angular wedge). Distinct SHAPE vs the enemy ring; a shape-difference so
    // ownership is legible without colour, and it points forward so facing reads too.
    const chev = new THREE.Group();
    chev.name = "marker";
    chev.position.y = 0.02;
    const bar = new THREE.BoxGeometry(0.32, 0.02, 0.08);
    const b1 = new THREE.Mesh(bar, markerMat);
    b1.position.set(0.17, 0, 0.15);
    b1.rotation.y = 0.7;
    const b2 = new THREE.Mesh(bar, markerMat);
    b2.position.set(0.17, 0, -0.15);
    b2.rotation.y = -0.7;
    chev.add(b1, b2);
    g.add(chev);

    const toRig = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      rig.add(m);
      return m;
    };

    // Bevelled plate helper (segmented RoundedBoxGeometry) + rounded/tapered limb helper. Clamped
    // so the bevel radius can never exceed half the smallest dimension.
    const RB = (w: number, h: number, d: number, r = 0.045) => new RoundedBoxGeometry(w, h, d, 2, Math.max(0.01, Math.min(r, Math.min(w, h, d) / 2.2)));
    const CAP = (rad: number, len: number, seg = 8) => new THREE.CapsuleGeometry(rad, len, 3, seg);

    let breath: THREE.Mesh;
    let servo: THREE.Mesh;
    let weapon: THREE.Mesh;
    if (kind === "vanguard") {
      // HEAVY BREACHER — broad, layered plating, shield + pauldrons + pack, wide stance. Kept
      // COMPACT and left/right balanced (shield z+, weapon z−) so the projected centre stays on the
      // teal body; the frontmost element is the emissive teal core so the team hue reads at gameplay
      // zoom. Textured armour lives on the pack, shoulders and the shield (not the flat central core).
      breath = toRig(RB(0.52, 0.6, 0.5, 0.07), cloth, 0, 0.7, 0); // teal torso (breath) — central read
      toRig(RB(0.06, 0.2, 0.24, 0.02), core, 0.28, 0.66, 0); // emissive teal chest core (frontmost)
      toRig(RB(0.24, 0.4, 0.4, 0.05), armour, -0.24, 0.66, 0); // textured backpack (centred, back)
      toRig(CAP(0.05, 0.18, 6), plateDark, -0.4, 0.72, 0.12); // pack hose L
      toRig(CAP(0.05, 0.18, 6), plateDark, -0.4, 0.72, -0.12); // pack hose R
      toRig(RB(0.13, 0.22, 0.24, 0.05), armour, 0, 0.94, 0.32); // pauldron L (side, symmetric)
      toRig(RB(0.13, 0.22, 0.24, 0.05), armour, 0, 0.94, -0.32); // pauldron R (side, symmetric)
      servo = toRig(RB(0.28, 0.24, 0.28, 0.05), plateDark, 0.02, 1.06, 0); // helmet
      toRig(RB(0.05, 0.09, 0.18, 0.02), optic, 0.18, 1.07, 0); // emissive visor slit (face)
      toRig(new THREE.SphereGeometry(0.045, 10, 10), accent, -0.15, 1.13, 0); // crest accent
      // shield on the LEFT, weapon on the RIGHT: balanced left/right so the mass stays centred.
      toRig(RB(0.05, 0.5, 0.42, 0.04), armour, 0.2, 0.56, 0.28); // shield (textured)
      toRig(RB(0.04, 0.34, 0.28, 0.03), plate, 0.24, 0.56, 0.28); // shield boss
      weapon = toRig(RB(0.32, 0.12, 0.1, 0.04), weaponMat, 0.3, 0.52, -0.26);
      toRig(new THREE.CylinderGeometry(0.04, 0.04, 0.34, 8), weaponMat, 0.48, 0.54, -0.26).rotation.z = Math.PI / 2;
      toRig(new THREE.SphereGeometry(0.05, 10, 10), weaponTrim, 0.63, 0.54, -0.26); // muzzle glow
      // two tapered legs (capsules) + a belt
      toRig(CAP(0.1, 0.32, 8), plateDark, 0, 0.24, 0.14);
      toRig(CAP(0.1, 0.32, 8), plateDark, 0, 0.24, -0.14);
      toRig(RB(0.32, 0.05, 0.05, 0.02), strap, 0, 0.42, 0);
    } else if (kind === "ghost") {
      // LEAN INFILTRATOR — tall, narrow footprint with a long teal coat, a hood + visor, a back
      // blade (kept CENTRED in Z) and a sidearm. Vertical mass is teal coat + torso so the team hue
      // reads; a small textured vest keeps the fabric a real material read.
      breath = toRig(RB(0.28, 0.54, 0.26, 0.06), cloth, 0, 0.78, 0); // narrow teal torso (breath)
      toRig(RB(0.05, 0.14, 0.14, 0.02), core, 0.19, 0.8, 0); // emissive teal chest core (frontmost)
      toRig(new THREE.ConeGeometry(0.2, 0.86, 9), coat, -0.05, 0.5, 0); // long coat tail (tapered)
      toRig(RB(0.14, 0.32, 0.2, 0.05), armour, -0.15, 0.82, 0); // textured vest/back pack
      servo = toRig(new THREE.ConeGeometry(0.13, 0.24, 8), coat, 0.03, 1.16, 0); // hood (rounded)
      toRig(RB(0.05, 0.05, 0.12, 0.02), optic, 0.14, 1.13, 0); // emissive visor slit (face)
      toRig(CAP(0.045, 0.28, 6), strap, -0.12, 0.9, 0.02).rotation.x = 0.3; // bandolier strap
      // back blade (long thin bevelled slab, kept straight/centred) + sidearm pistol
      toRig(RB(0.02, 0.5, 0.06, 0.02), plate, -0.2, 0.84, 0); // back blade (shiny metal)
      toRig(RB(0.05, 0.09, 0.04, 0.02), weaponMat, -0.2, 0.56, 0); // blade hilt
      weapon = toRig(RB(0.28, 0.07, 0.05, 0.03), weaponMat, 0.22, 0.66, -0.02); // sidearm (recoil)
      toRig(new THREE.SphereGeometry(0.045, 10, 10), weaponTrim, 0.34, 0.66, -0.02); // muzzle glow
      // two long tapered legs (capsules) for the tall narrow silhouette + a beacon
      toRig(CAP(0.08, 0.36, 8), plateDark, 0, 0.26, 0.06);
      toRig(CAP(0.08, 0.36, 8), plateDark, 0, 0.26, -0.06);
      toRig(new THREE.SphereGeometry(0.04, 10, 10), accent, -0.02, 1.02, 0); // pack beacon
    } else {
      // TECH SPECIALIST — compact/squat frame, symmetric shoulder pods, antenna + a floating optic on
      // a short boom (pulled in so the centre stays on the body), and a handheld optic/tool. Central
      // mass is bright teal + an emissive core; the floating optic is cyan and also reads as team hue.
      breath = toRig(RB(0.38, 0.48, 0.36, 0.07), cloth, 0, 0.62, 0); // squat teal torso (breath)
      toRig(RB(0.05, 0.14, 0.2, 0.02), core, 0.22, 0.62, 0); // emissive teal chest core (frontmost)
      toRig(RB(0.16, 0.3, 0.28, 0.05), armour, -0.16, 0.66, 0); // textured back toolbox
      servo = toRig(RB(0.24, 0.2, 0.24, 0.05), plateDark, 0, 0.9, 0); // sensor head
      toRig(RB(0.04, 0.06, 0.2, 0.02), optic, 0.15, 0.91, 0); // emissive visor bar (face)
      // two rounded shoulder pods (±Z), symmetric, textured
      toRig(CAP(0.09, 0.1, 8), armour, -0.02, 0.76, 0.24);
      toRig(CAP(0.09, 0.1, 8), armour, -0.02, 0.76, -0.24);
      // short antenna + a floating optic pulled in so the subject mass stays centred
      toRig(new THREE.CylinderGeometry(0.018, 0.02, 0.22, 6), weaponMat, -0.14, 1.08, 0);
      toRig(new THREE.SphereGeometry(0.045, 10, 10), accent, -0.14, 1.22, 0); // antenna tip glow
      toRig(CAP(0.028, 0.2, 6), weaponMat, -0.26, 0.66, 0).rotation.x = Math.PI / 2; // boom
      weapon = toRig(new THREE.SphereGeometry(0.09, 12, 12), accent, -0.34, 0.66, 0); // floating optic
      // handheld optic/tool forward-right (the specialist's "weapon" is a device, not a gun)
      toRig(RB(0.18, 0.1, 0.1, 0.04), weaponMat, 0.26, 0.56, -0.18);
      toRig(new THREE.SphereGeometry(0.045, 10, 10), weaponTrim, 0.36, 0.56, -0.18);
      // two shorter tapered legs + belt
      toRig(CAP(0.09, 0.24, 8), plateDark, 0, 0.2, 0.09);
      toRig(CAP(0.09, 0.24, 8), plateDark, 0, 0.2, -0.09);
      toRig(RB(0.36, 0.05, 0.05, 0.02), strap, 0, 0.42, 0);
    }
    g.userData.side = "player";
    g.userData.rig = rig;
    g.userData.breath = breath;
    g.userData.servo = servo;
    g.userData.weapon = weapon;
    g.userData.flashes = [{ mat: optic, base: optic.emissiveIntensity }, { mat: accent, base: accent.emissiveIntensity }];
    g.userData.bodyMat = cloth;
    g.userData.breathBaseY = breath.position.y;
    g.userData.weaponBaseX = weapon.position.x;
    g.userData.moveT = -10;
    g.userData.hitT = -10;
    g.userData.fireT = -10;
    g.userData.bobPhase = Math.random() * 6.283;
    g.scale.setScalar(1.22);
    return g;
  }

  // Presentation-only animation hint driven by real sim state (attack -> fire pose, damage ->
  // hit flinch). Reads no rules; only sets a decaying timer the render loop animates from.
  pose(id: string, kind: "fire" | "hit"): void {
    const m = this.unitMeshes.get(id);
    if (!m) return;
    if (kind === "fire") m.userData.fireT = this.animClock;
    else m.userData.hitT = this.animClock;
  }

  // Presentation-only rig animation driven by an always-advancing clock + real-state timers. No
  // rules read; only transforms/emissive on already-built meshes. Idle breathing/sway is
  // continuous (changes every frame) so operatives never look frozen; move-lean, fire recoil and
  // hit flinch are transient poses triggered from the authoritative event stream (pose()/sync).
  private animateUnits(dt: number) {
    const t = this.animClock;
    for (const m of this.unitMeshes.values()) {
      if (!m.visible) continue;
      const ud = m.userData;
      if (ud.side === "enemy") {
        if (ud.spin) m.rotation.y += dt * 1.35;
        continue;
      }
      const rig = ud.rig as THREE.Group | undefined;
      if (!rig) continue;
      const ph = ud.bobPhase as number;
      const breath = ud.breath as THREE.Mesh | undefined;
      // idle breathing: subtle torso rise + scale pulse so the silhouette is never frozen
      const rigY = Math.sin(t * 1.15 + ph) * 0.03;
      if (breath) {
        breath.position.y = (ud.breathBaseY as number) + Math.sin(t * 2.3 + ph) * 0.014;
        const s = 1 + Math.sin(t * 2.3 + ph) * 0.03;
        breath.scale.set(1, s, s);
      }
      rig.rotation.y = rigY;
      // movement read: a quick step-lift + forward push while a tile change is still "playing"
      const mel = t - (ud.moveT as number);
      if (mel >= 0 && mel < 0.36) {
        const k = Math.sin((mel / 0.36) * Math.PI);
        rig.position.y = k * 0.08;
        rig.position.x = k * 0.06;
      } else {
        rig.position.set(0, 0, 0);
      }
      // fire: recoil the weapon + spike the emissive muzzle accents
      const fel = t - (ud.fireT as number);
      const weapon = ud.weapon as THREE.Mesh | undefined;
      if (fel >= 0 && fel < 0.26 && weapon) {
        const k = 1 - fel / 0.26;
        weapon.position.x = (ud.weaponBaseX as number) - 0.16 * k;
        if (ud.flashes) for (const f of ud.flashes) f.mat.emissiveIntensity = f.base + 2.6 * k;
      } else {
        if (weapon) weapon.position.x = ud.weaponBaseX as number;
        if (ud.flashes) for (const f of ud.flashes) f.mat.emissiveIntensity = f.base;
      }
      // hit: flinch + a red damage flash on the body cloth
      const hel = t - (ud.hitT as number);
      if (hel >= 0 && hel < 0.42) {
        const k = 1 - hel / 0.42;
        rig.rotation.z = Math.sin((hel / 0.42) * Math.PI * 2) * 0.16;
        rig.position.x -= k * 0.05;
        if (ud.bodyMat) (ud.bodyMat as THREE.MeshStandardMaterial).emissive.setRGB(0.95 * k, 0.06 * k, 0.12 * k);
      } else if (ud.bodyMat) {
        rig.rotation.z = 0;
        (ud.bodyMat as THREE.MeshStandardMaterial).emissive.setRGB(0, 0, 0);
      }
    }
  }

  // Detection-cone telegraphs for alerted enemies (presentation of authoritative detState).
  syncThreat(enemies: { id: string; side: string; alive: boolean; detState?: string; pos: { x: number; y: number; h: number }; facing?: number }[]) {
    const toRemove: THREE.Object3D[] = [];
    this.fxGroup.traverse((o) => {
      if (o.name === "threat") toRemove.push(o);
    });
    for (const o of toRemove) this.fxGroup.remove(o);
    for (const e of enemies) {
      if (!e.alive || e.side !== "enemy" || (e.detState !== "alerted" && e.detState !== "suspicious")) continue;
      const w = this.tileToWorld(e.pos);
      const alerted = e.detState === "alerted";
      const len = alerted ? 2.6 : 1.7;
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(alerted ? 0.62 : 0.42, len, 12, 1, true),
        new THREE.MeshBasicMaterial({ color: alerted ? 0xff5a2c : 0xd9c23a, transparent: true, opacity: alerted ? 0.4 : 0.25, depthWrite: false, side: THREE.DoubleSide }),
      );
      const dir = new THREE.Group();
      dir.add(cone);
      cone.position.set(len / 2, 0.55, 0);
      cone.rotation.z = -Math.PI / 2;
      dir.position.set(w.x, 0, w.z);
      dir.rotation.y = -(e.facing ?? 0);
      dir.name = "threat";
      this.fxGroup.add(dir);
    }
  }

  syncUnits(units: { id: string; archetype: string; side: "player" | "enemy"; alive: boolean; pos: { x: number; y: number; h: number }; facing?: number }[], opts?: { hidden?: Set<string> }) {
    const seen = new Set<string>();
    for (const u of units) {
      seen.add(u.id);
      let m = this.unitMeshes.get(u.id);
      if (!m) {
        m = this.makeUnitMesh(u.archetype, u.side);
        this.unitMeshes.set(u.id, m);
        this.unitGroup.add(m);
        m.position.copy(this.tileToWorld({ x: u.pos.x, y: u.pos.y, h: u.pos.h }));
        m.userData.key = `${u.pos.x},${u.pos.y},${u.pos.h}`;
      }
      const key = `${u.pos.x},${u.pos.y},${u.pos.h}`;
      if (m.userData.key !== key) {
        // state-driven movement lean: reset the rig lean timer when the unit steps to a new tile
        m.userData.key = key;
        m.userData.moveT = this.animClock;
        // Movement is animated as a display tween (never a rules change). An explicit path tween
        // (player move, seeded by beginMove before this sync) already owns the unit; otherwise a
        // unit that simply reached a new tile (e.g. enemy-phase motion) glides via a short auto
        // step. With reducedMotion on, snap instead of animating.
        if (!this.moveTween.has(u.id)) {
          if (this.reducedMotion) {
            m.position.copy(this.tileToWorld({ x: u.pos.x, y: u.pos.y, h: u.pos.h }));
          } else {
            this.beginAutoStep(u.id, { x: u.pos.x, y: u.pos.y, h: u.pos.h });
          }
        }
      }
      if (u.side === "player") {
        // face the squad model where the sim says it is looking (facing legibility)
        const f = u.facing ?? 0;
        if (m.userData.facing !== f) {
          m.userData.facing = f;
          m.rotation.y = -(f * Math.PI) / 4;
        }
      }
      m.visible = u.alive && !opts?.hidden?.has(u.id);
      if (!u.alive && m.userData.death !== 1) {
        m.userData.death = 1;
        m.scale.setScalar(0.001);
      }
    }
    for (const [id, m] of this.unitMeshes) {
      if (!seen.has(id)) {
        this.unitGroup.remove(m);
        m.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose();
            (o.material as THREE.Material).dispose();
          }
        });
        this.unitMeshes.delete(id);
      }
    }
  }

  propGroup = new THREE.Group();
  backdropGroup = new THREE.Group();
  private propGlow = new Map<string, { mat: THREE.MeshStandardMaterial; kind: string }>();
  private extractionRing: THREE.Mesh | null = null;

  // Flattened multi-part prop assembly. Every part is added DIRECTLY to propGroup as a Mesh (never a
  // nested Group) so the existing prop-group contract holds: children are always Meshes that expose a
  // .material with .emissive (the render-state repaint in environment.spec.ts reads them directly).
  private propMesh(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, dev: string, kind: string, part: string, cast: boolean): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = cast;
    m.name = "prop";
    m.userData = { dev, kind, part };
    this.propGroup.add(m);
    return m;
  }

  // Static world props: security devices read as multi-part objects, not invisible rules. Each device
  // keeps one emissive "read" part whose material is repainted in syncProps when authority changes.
  buildProps(devices: { id: string; kind: string; x: number; y: number; h: number }[], extraction: { x: number; y: number; h: number } | null) {
    this.disposeGroup(this.propGroup);
    this.propGlow.clear();
    this.extractionRing = null;
    for (const d of devices) {
      const bx = (d.x - 6.5) * TILE;
      const bz = (d.y - 6.5) * TILE;
      const base = 0.15 + d.h * 0.5;
      if (d.kind === "core") {
        const mat = new THREE.MeshStandardMaterial({ color: 0x3a1e66, emissive: 0xb14bff, emissiveIntensity: 0.85, metalness: 0.45, roughness: 0.4 });
        this.propMesh(new THREE.CylinderGeometry(0.24, 0.32, 0.9, 12), mat, bx, base + 0.45, bz, d.id, d.kind, "body", true);
        this.propMesh(new THREE.TorusGeometry(0.34, 0.05, 8, 22), mat, bx, base + 0.74, bz, d.id, d.kind, "ring", false).rotation.x = Math.PI / 2;
        this.propMesh(new THREE.TorusGeometry(0.28, 0.045, 8, 22), mat, bx, base + 0.28, bz, d.id, d.kind, "ring", false).rotation.x = Math.PI / 2;
        this.propGlow.set(d.id, { mat, kind: d.kind });
      } else if (d.kind === "terminal") {
        this.propMesh(new THREE.BoxGeometry(0.5, 0.12, 0.5), new THREE.MeshStandardMaterial({ color: 0x22303b, metalness: 0.5, roughness: 0.55 }), bx, base + 0.06, bz, d.id, d.kind, "base", true);
        this.propMesh(new THREE.BoxGeometry(0.44, 0.42, 0.34), new THREE.MeshStandardMaterial({ color: 0x14313d, metalness: 0.4, roughness: 0.55 }), bx, base + 0.34, bz, d.id, d.kind, "console", true);
        // Amber console read (dimmed): a bright teal operative no longer sits beside a near-identical
        // cyan prop. Amber is hue- AND luminance-separated from the mint unit marker, so ownership
        // reads even with hue ignored (this is also why the OFF read below is kept much darker).
        const screen = new THREE.MeshStandardMaterial({ color: 0x2a2016, emissive: 0xffb454, emissiveIntensity: 0.7, metalness: 0.2, roughness: 0.4 });
        this.propMesh(new THREE.BoxGeometry(0.42, 0.28, 0.05), screen, bx, base + 0.62, bz + 0.15, d.id, d.kind, "screen", false).rotation.x = -0.38;
        this.propGlow.set(d.id, { mat: screen, kind: d.kind });
      } else if (d.kind === "turret") {
        this.propMesh(new THREE.CylinderGeometry(0.26, 0.34, 0.22, 10), new THREE.MeshStandardMaterial({ color: 0x22303b, metalness: 0.55, roughness: 0.5 }), bx, base + 0.11, bz, d.id, d.kind, "base", true);
        this.propMesh(new THREE.CylinderGeometry(0.12, 0.15, 0.26, 8), new THREE.MeshStandardMaterial({ color: 0x33465a, metalness: 0.5, roughness: 0.45 }), bx, base + 0.36, bz, d.id, d.kind, "neck", true);
        const b1 = new THREE.MeshStandardMaterial({ color: 0x3a3327, emissive: 0xffb454, emissiveIntensity: 0.7, metalness: 0.5, roughness: 0.45 });
        const b2 = new THREE.MeshStandardMaterial({ color: 0x3a3327, emissive: 0xffb454, emissiveIntensity: 0.7, metalness: 0.5, roughness: 0.45 });
        this.propMesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 8), b1, bx - 0.09, base + 0.52, bz + 0.12, d.id, d.kind, "barrel", true).rotation.x = Math.PI / 2;
        this.propMesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 8), b2, bx + 0.09, base + 0.52, bz + 0.12, d.id, d.kind, "barrel", true).rotation.x = Math.PI / 2;
        this.propGlow.set(d.id, { mat: b1, kind: d.kind });
        this.propGlow.set(`${d.id}#2`, { mat: b2, kind: d.kind });
      } else if (d.kind === "camera") {
        this.propMesh(new THREE.BoxGeometry(0.14, 0.52, 0.14), new THREE.MeshStandardMaterial({ color: 0x22303b, metalness: 0.5, roughness: 0.5 }), bx, base + 0.5, bz, d.id, d.kind, "bracket", true);
        this.propMesh(new THREE.BoxGeometry(0.3, 0.2, 0.26), new THREE.MeshStandardMaterial({ color: 0x2b3644, metalness: 0.5, roughness: 0.5 }), bx, base + 0.9, bz, d.id, d.kind, "housing", true);
        const lens = new THREE.MeshStandardMaterial({ color: 0x2b3644, emissive: 0xff5a2c, emissiveIntensity: 1.2, metalness: 0.3, roughness: 0.4 });
        this.propMesh(new THREE.CylinderGeometry(0.1, 0.12, 0.16, 12), lens, bx + 0.2, base + 0.9, bz, d.id, d.kind, "lens", true).rotation.z = Math.PI / 2;
        this.propGlow.set(d.id, { mat: lens, kind: d.kind });
      } else if (d.kind === "node") {
        this.propMesh(new THREE.CylinderGeometry(0.14, 0.16, 0.42, 10), new THREE.MeshStandardMaterial({ color: 0x203040, metalness: 0.5, roughness: 0.5 }), bx, base + 0.42, bz, d.id, d.kind, "body", true);
        const band = new THREE.MeshStandardMaterial({ color: 0x203040, emissive: 0xffb454, emissiveIntensity: 0.7, metalness: 0.4, roughness: 0.5 });
        this.propMesh(new THREE.TorusGeometry(0.26, 0.05, 8, 20), band, bx, base + 0.54, bz, d.id, d.kind, "band", false).rotation.x = Math.PI / 2;
        this.propGlow.set(d.id, { mat: band, kind: d.kind });
      }
    }
    if (extraction) {
      const w = this.tileToWorld({ x: extraction.x, y: extraction.y, h: extraction.h });
      const pad = new THREE.Mesh(
        new THREE.TorusGeometry(0.55, 0.07, 10, 26),
        new THREE.MeshStandardMaterial({ color: 0x10352c, emissive: COLORS.extraction, emissiveIntensity: 1.5, roughness: 0.4 }),
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(w.x, 0.35, w.z);
      pad.name = "prop";
      this.propGroup.add(pad);
      this.extractionRing = pad;
    }
  }

  // Presentation sync for device state (powered / hijacked / disabled).
  syncProps(devices: { id: string; kind: string; powered: boolean; disabled: boolean; owner: string }[]) {
    for (const d of devices) {
      if (d.kind === "turret") {
        const dark = d.disabled || !d.powered;
        const hijack = d.owner === "hijacked";
        const glow = this.propGlow.get(d.id);
        const glow2 = this.propGlow.get(`${d.id}#2`);
        for (const e of [glow, glow2]) {
          if (!e) continue;
          if (dark) {
            e.mat.color.setHex(0x3a3f46);
            e.mat.emissive.setHex(0x000000);
          } else if (hijack) {
            // Hijacked = violet, deliberately NOT the mint unit colour (0x25e0c0). A hijacked turret
            // beside a player operative used to be the same teal; violet + lower lightness separates
            // them by hue AND brightness, so the flip reads without relying on hue alone.
            e.mat.emissive.setHex(0xb14bff);
          } else {
            e.mat.emissive.setHex(0xffb454);
          }
        }
      } else {
        const e = this.propGlow.get(d.id);
        if (!e) continue;
        const off = d.disabled || !d.powered;
        if (d.kind === "camera") e.mat.emissive.setHex(off ? 0x2a1206 : 0xff5a2c);
        else if (d.kind === "node") e.mat.emissive.setHex(off ? 0x140f08 : 0xffb454);
        else if (d.kind === "core") e.mat.emissive.setHex(off ? 0x241038 : 0xb14bff);
        else if (d.kind === "terminal") e.mat.emissive.setHex(off ? 0x140f08 : 0xffb454);
      }
    }
    if (this.extractionRing) {
      const ex = (this.extractionRing.material as THREE.MeshStandardMaterial);
      ex.emissiveIntensity = 1.2 + Math.sin(performance.now() / 260) * 0.5;
    }
  }

  beginMove(unitId: string, path: { x: number; y: number; h: number }[], dur = 1200): void {
    if (this.reducedMotion) return;
    const m = this.unitMeshes.get(unitId);
    if (!m || path.length === 0) return;
    const pts: THREE.Vector3[] = [m.position.clone()];
    for (const p of path) {
      const w = this.tileToWorld(p);
      const last = pts[pts.length - 1];
      if (Math.abs(w.x - last.x) + Math.abs(w.y - last.y) + Math.abs(w.z - last.z) < 1e-4) continue;
      pts.push(w);
    }
    if (pts.length < 2) return;
    const cum: number[] = [0];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += pts[i].distanceTo(pts[i - 1]);
      cum.push(total);
    }
    if (total < 1e-4) return;
    this.moveTween.set(unitId, { pts, cum, total, dur: dur * this.tweenScale, t0: performance.now() });
  }

  private beginAutoStep(id: string, target: { x: number; y: number; h: number }, dur = 300): void {
    const m = this.unitMeshes.get(id);
    if (!m) return;
    const start = m.position.clone();
    const end = this.tileToWorld(target);
    const total = start.distanceTo(end);
    if (total < 1e-4) return;
    this.moveTween.set(id, { pts: [start, end], cum: [0, total], total, dur: dur * this.tweenScale, t0: performance.now() });
  }

  moveTweening(): boolean {
    return this.moveTween.size > 0;
  }

  stepMoveTweens(now: number): void {
    if (this.moveTween.size === 0) return;
    const scratch = this._cv1;
    for (const [id, tw] of this.moveTween) {
      const m = this.unitMeshes.get(id);
      if (!m || !m.visible) {
        this.moveTween.delete(id);
        continue;
      }
      const f = Math.max(0, Math.min(1, (now - tw.t0) / tw.dur));
      const eased = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
      const dist = eased * tw.total;
      let i = 1;
      while (i < tw.cum.length && tw.cum[i] < dist) i++;
      if (i >= tw.cum.length) {
        m.position.copy(tw.pts[tw.pts.length - 1]);
        this.moveTween.delete(id);
        continue;
      }
      const segLen = tw.cum[i] - tw.cum[i - 1];
      const local = segLen > 1e-6 ? (dist - tw.cum[i - 1]) / segLen : 1;
      scratch.copy(tw.pts[i - 1]).lerp(tw.pts[i], local);
      m.position.copy(scratch);
      if (f >= 1) {
        m.position.copy(tw.pts[tw.pts.length - 1]);
        this.moveTween.delete(id);
      }
    }
  }

  tileToWorld(p: { x: number; y: number; h: number }): THREE.Vector3 {
    return new THREE.Vector3((p.x - 6.5) * TILE, 0.15 + p.h * 0.5, (p.y - 6.5) * TILE);
  }

  // ---- markers ----
  showSelection(p: { x: number; y: number; h: number } | null) {
    if (!p) {
      this.selectionRing.visible = false;
      return;
    }
    this.selectionRing.visible = true;
    const w = this.tileToWorld(p);
    this.selectionRing.position.set(w.x, w.y + 0.06, w.z);
  }

  showRange(keys: Set<string>, color: number) {
    this.clearMarkers();
    for (const k of keys) {
      const [xs, ys] = k.split(",");
      const x = Number(xs);
      const y = Number(ys);
      const geo = new THREE.BoxGeometry(TILE * 0.9, 0.12, TILE * 0.9);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, depthWrite: false });
      const m = new THREE.Mesh(geo, mat);
      m.position.set((x - 6.5) * TILE, 0.13, (y - 6.5) * TILE);
      m.name = "marker";
      this.fxGroup.add(m);
    }
  }

  showPath(path: { x: number; y: number; h: number }[]) {
    if (path.length < 2) return;
    const pts = path.map((p) => {
      const w = this.tileToWorld(p);
      return new THREE.Vector3(w.x, 0.16, w.z);
    });
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: COLORS.path, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending });
    const line = new THREE.Line(geo, mat);
    line.name = "marker";
    this.fxGroup.add(line);
    for (const p of path) {
      const w = this.tileToWorld(p);
      const dg = new THREE.RingGeometry(0.16, 0.28, 18);
      const dm = new THREE.MeshBasicMaterial({ color: COLORS.path, transparent: true, opacity: 0.7, side: THREE.DoubleSide });
      const d = new THREE.Mesh(dg, dm);
      d.rotation.x = -Math.PI / 2;
      d.position.set(w.x, 0.16, w.z);
      d.name = "marker";
      this.fxGroup.add(d);
    }
  }

  fxRing(p: { x: number; y: number; h: number }, color = 0x2bd7ff, r = 1.4) {
    const w = this.tileToWorld(p);
    const pairs: [number, number][] = [
      [r - 0.2, r],
      [r * 0.45, r * 0.62],
    ];
    for (const [a, b] of pairs) {
      const geo = new THREE.RingGeometry(a, b, 44);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(w.x, 0.14, w.z);
      m.name = "marker";
      this.fxGroup.add(m);
    }
  }

  clearMarkers() {
    const toRemove: THREE.Object3D[] = [];
    this.fxGroup.traverse((o) => {
      if (o.name === "marker") toRemove.push(o);
    });
    for (const o of toRemove) {
      this.fxGroup.remove(o);
      const anyO = o as THREE.Mesh | THREE.Line;
      if ((anyO as THREE.Mesh).geometry) (anyO as THREE.Mesh).geometry.dispose();
      const mm = (anyO as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mm)) mm.forEach((m) => m.dispose());
      else if (mm) mm.dispose();
    }
  }

  // ---- TRAIL + HOVER tile-plate helper ----
  private makeTilePlate(x: number, y: number, color: number, name: string): THREE.Mesh {
    const geo = new THREE.BoxGeometry(TILE * 0.82, 0.1, TILE * 0.82);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false });
    const m = new THREE.Mesh(geo, mat);
    m.position.set((x - 6.5) * TILE, 0.45, (y - 6.5) * TILE);
    m.renderOrder = 6;
    m.name = name;
    return m;
  }

  // ---- TRAIL (last-move history) ----
  // Set (replace) the last-move trail for one unit from the tiles it travelled. Never appends.
  setTrail(unitId: string, tiles: { x: number; y: number }[]) {
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const t of tiles) {
      const k = `${Math.round(t.x)},${Math.round(t.y)}`;
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
    this.trailKeys.set(unitId, keys);
    this.rebuildTrail(unitId);
  }

  private disposePlateSet(objs: THREE.Object3D[]) {
    for (const o of objs) {
      this.trailGroup.remove(o);
      if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
      const mm = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (mm) mm.dispose();
    }
  }

  private rebuildTrail(unitId: string) {
    const prev = this.trailGroup.userData[unitId] as THREE.Object3D[] | undefined;
    if (prev) this.disposePlateSet(prev);
    delete this.trailGroup.userData[unitId];
    if (!this.renderTrails) return;
    const keys = this.trailKeys.get(unitId);
    if (!keys) return;
    const objs: THREE.Object3D[] = [];
    for (const k of keys) {
      const [xs, ys] = k.split(",");
      const m = this.makeTilePlate(Number(xs), Number(ys), COLORS.trail, "trail");
      this.trailGroup.add(m);
      objs.push(m);
    }
    this.trailGroup.userData[unitId] = objs;
  }

  // Capture-only toggle: rebuild every trail's markers from stored history without changing history.
  setRenderTrails(v: boolean) {
    this.renderTrails = v;
    for (const unitId of [...this.trailKeys.keys()]) this.rebuildTrail(unitId);
  }

  clearTrails() {
    for (const unitId of Object.keys(this.trailGroup.userData)) {
      const objs = this.trailGroup.userData[unitId] as THREE.Object3D[];
      this.disposePlateSet(objs);
      delete this.trailGroup.userData[unitId];
    }
    this.trailKeys.clear();
  }

  debugTrail(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [k, v] of this.trailKeys) out[k] = v.slice();
    return out;
  }

  // ---- HOVER (outline + max-move range) ----
  clearHover() {
    for (const o of [...this.hoverGroup.children]) {
      this.hoverGroup.remove(o);
      if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
      const mm = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (mm) mm.dispose();
    }
    this.hoverUnit = null;
    this.hoverRange.clear();
  }

  // Highlight the hovered piece: a bounding-hugging outline shell + ring, plus the max-move range
  // tiles. at = world position to centre the outline (the piece's tile). Clears any prior hover.
  setHover(unitId: string | null, at: { x: number; y: number; z: number }, rangeKeys: string[]) {
    this.clearHover();
    if (!unitId) return;
    this.hoverUnit = unitId;
    this.hoverRange = new Set(rangeKeys);
    for (const k of rangeKeys) {
      const [xs, ys] = k.split(",");
      const m = this.makeTilePlate(Number(xs), Number(ys), COLORS.hoverRange, "hover-range");
      this.hoverGroup.add(m);
    }
    let r = 0.7;
    let h = 1.3;
    const mesh = this.unitMeshes.get(unitId);
    if (mesh) {
      const bb = new THREE.Box3().setFromObject(mesh);
      const size = bb.getSize(new THREE.Vector3());
      r = Math.max(0.55, Math.min(1.6, (Math.max(size.x, size.z) / 2) * 1.35));
      h = Math.max(0.6, Math.min(2.4, size.y + 0.35));
    }
    const ringGeo = new THREE.RingGeometry(r * 0.72, r, 40);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: COLORS.hoverOutline, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(at.x, 0.155, at.z);
    ring.renderOrder = 7;
    ring.name = "hover-outline";
    this.hoverGroup.add(ring);
    const shellGeo = new THREE.CylinderGeometry(r * 0.7, r * 0.7, h, 22, 1, true);
    const shell = new THREE.Mesh(shellGeo, new THREE.MeshBasicMaterial({ color: COLORS.hoverOutline, transparent: true, opacity: 0.34, side: THREE.DoubleSide, depthWrite: false }));
    shell.position.set(at.x, h / 2 + 0.12, at.z);
    shell.renderOrder = 7;
    shell.name = "hover-outline";
    this.hoverGroup.add(shell);
  }

  debugHover(): { unit: string | null; range: string[]; outline: boolean } {
    return { unit: this.hoverUnit, range: [...this.hoverRange], outline: this.hoverGroup.children.some((o) => o.name === "hover-outline") };
  }

  // ---- effects (transient, allocation-light, geometry-driven) ----
  // Register a transient object under fxGroup/name "fx" with a per-frame update driven by its
  // 0..1 life fraction. Every entry is torn down on expiry (updateEffects) or on a board rebuild
  // (clearEffects), so effects never linger or survive a mission change.
  private addFx(obj: THREE.Object3D, dur: number, tick?: (o: THREE.Object3D, f: number) => void) {
    obj.name = "fx";
    this.fxGroup.add(obj);
    this.effects.push({ obj, kind: (obj.userData && obj.userData.kind) || "fx", t: 0, dur, tick });
  }

  // A Points burst handled by updateParticles (moves by velocity + fades). Kept separate from
  // addFx so a burst is NOT double-registered in the effects list.
  private addBurst(points: THREE.Points, life: number, vel: Float32Array) {
    points.name = "fx";
    this.fxGroup.add(points);
    this.particles.push({ points, life, max: life, vel });
  }

  private disposeFx(o: THREE.Object3D) {
    this.fxGroup.remove(o);
    const anyO = o as THREE.Mesh | THREE.Line | THREE.Points;
    if (anyO.geometry && anyO.geometry !== this._quad) anyO.geometry.dispose();
    const mm = (anyO as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mm)) mm.forEach((m) => m.dispose());
    else if (mm) mm.dispose();
  }

  // Tear down every transient effect + particle burst + the alert wash (mission rebuild / reset).
  clearEffects() {
    for (const e of this.effects) this.disposeFx(e.obj);
    this.effects.length = 0;
    for (const p of this.particles) this.disposeFx(p.points);
    this.particles.length = 0;
    if (this.alertWash) {
      this.fxGroup.remove(this.alertWash);
      this.alertWash.geometry.dispose();
      (this.alertWash.material as THREE.Material).dispose();
      this.alertWash = null;
    }
  }

  effectCount() {
    let n = 0;
    for (const c of this.fxGroup.children) if (c.name === "fx") n++;
    return n;
  }

  // Inspection read for the vision/oracle tests: every live "fx" object with its world position and
  // (for a tracer) the REAL shooter/target tile coords it was built from — proof it is positioned
  // from authoritative geometry, not a fixed placeholder.
  debugFx() {
    const out: { kind: string; at?: number[]; x: number; y: number; z: number; from?: number[]; to?: number[] }[] = [];
    for (const c of this.fxGroup.children) {
      if (c.name !== "fx") continue;
      const rec: { kind: string; at?: number[]; x: number; y: number; z: number; from?: number[]; to?: number[] } = {
        kind: (c.userData && c.userData.kind) || "?",
        x: +c.position.x.toFixed(3), y: +c.position.y.toFixed(3), z: +c.position.z.toFixed(3),
      };
      if (c.userData.at) rec.at = c.userData.at as number[];
      if (c.userData.from) rec.from = c.userData.from as number[];
      if (c.userData.to) rec.to = c.userData.to as number[];
      out.push(rec);
    }
    return out;
  }

  // Back-compat wrapper: the old flat additive beam. Now delegates to the disciplined tracer so
  // existing tooling (e2e/tools.capture.ts, e2e/visual.showcase.ts) keeps a valid call surface.
  beam(from: { x: number; y: number; h: number }, to: { x: number; y: number; h: number }, color = 0xfff0b0) {
    this.tracer(from, to, color);
  }

  // Muzzle flash: a short additive spark cluster at the SHOOTER's real tile, offset to barrel height.
  muzzle(p: { x: number; y: number; h: number }, color = 0xffd27a) {
    const c = this.tileToWorld(p);
    c.y += 0.5;
    const n = 7;
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = c.x; pos[i * 3 + 1] = c.y; pos[i * 3 + 2] = c.z;
      const a = Math.random() * Math.PI * 2;
      vel[i * 3] = Math.cos(a) * 0.8; vel[i * 3 + 1] = Math.random() * 1.2 + 0.3; vel[i * 3 + 2] = Math.sin(a) * 0.8;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color, size: 0.16, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
    pts.userData = { kind: "muzzle", at: [p.x, p.y], from: [p.x, p.y] };
    this.addBurst(pts, 0.14, vel);
  }

  // Tracer along the ACTUAL firing line (shooter tile -> target tile): a thin additive path plus a
  // bright head that travels it. Built purely from real geometry; userData carries the tile coords.
  tracer(from: { x: number; y: number; h: number }, to: { x: number; y: number; h: number }, color = 0xfff0b0) {
    const wa = this.tileToWorld(from); wa.y += 0.55;
    const wb = this.tileToWorld(to); wb.y += 0.55;
    const geo = new THREE.BufferGeometry().setFromPoints([wa, wb]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    line.userData = { kind: "tracer", from: [from.x, from.y], to: [to.x, to.y] };
    this.addFx(line, 0.2, (o, f) => { ((o as THREE.Line).material as THREE.LineBasicMaterial).opacity = 0.9 * (1 - f); });
    const hx = wa.x, hy = wa.y, hz = wa.z, tx = wb.x, ty = wb.y, tz = wb.z;
    const head = new THREE.Mesh(this._quad, new THREE.MeshBasicMaterial({ color: 0xffe9a0, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    head.userData = { kind: "tracer" };
    head.scale.setScalar(0.18);
    head.position.set(hx, hy, hz);
    this.addFx(head, 0.2, (o, f) => {
      o.position.set(hx + (tx - hx) * f, hy + (ty - hy) * f, hz + (tz - hz) * f);
      o.scale.setScalar(0.18 * (1 - f * 0.5));
    });
  }

  // Weapon fire: muzzle at the shooter + a tracer on the real line + recoil/flare via pose().
  fire(from: { x: number; y: number; h: number }, to: { x: number; y: number; h: number }, color = 0xfff0b0) {
    this.muzzle(from);
    this.tracer(from, to, color);
  }

  // ---- FLIGHT PATH (presentation-only, both sides, reduced-motion aware) ----------------------
  // A ranged ability's shot is shown as a projectile that TRAVELS a visible path from the user to the
  // target, then lands an impact beat when the effect RESOLVES — not the old instant straight tracer.
  // Presentation only: it reads tile geometry, never authoritative state, and changes no damage/timing.
  // reducedMotion: no travel animation is created; the impact beat resolves instantly instead.
  flight(from: { x: number; y: number; h: number }, to: { x: number; y: number; h: number }, color = 0xff9a3c): void {
    const wa = this.tileToWorld(from);
    wa.y += 0.55; // barrel height
    const wb = this.tileToWorld(to);
    wb.y += 0.5; // impact height
    const dist = wa.distanceTo(wb);
    // Reduced motion: no travel. Drop a brief full-length streak + an immediate impact so the beat
    // still fires, but nothing animates across frames (flight-path.spec asserts instant resolve).
    if (this.reducedMotion) {
      const geo = new THREE.BufferGeometry().setFromPoints([wa, wb]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
      line.userData = { kind: "flight", from: [from.x, from.y], to: [to.x, to.y] };
      this.addFx(line, 0.12, (o, f) => { ((o as THREE.Line).material as THREE.LineBasicMaterial).opacity = 0.9 * (1 - f); });
      this.impact(to, color, 0.9);
      return;
    }
    this.muzzle(from, color);
    // The travelling projectile: a bright additive head + a growing streak that marks the path flown.
    const group = new THREE.Group();
    const core = new THREE.Mesh(this._quad, new THREE.MeshBasicMaterial({ color: 0xfff0b0, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    core.scale.setScalar(0.2);
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
    trail.frustumCulled = false;
    group.add(trail);
    group.add(core);
    group.userData = { kind: "flight", from: [from.x, from.y], to: [to.x, to.y] };
    this.projectileGroup.add(group);
    const dur = Math.max(0.26, Math.min(0.62, dist * 0.11)) * this.flightScale;
    const arc = Math.min(1.0, 0.14 + dist * 0.09);
    const proj: Projectile = {
      head: group,
      from: wa,
      to: wb,
      arc,
      t: 0,
      dur,
      impactFired: false,
      fromKey: `${from.x},${from.y}`,
      toKey: `${to.x},${to.y}`,
    };
    this.projectiles.push(proj);
  }

  // Advance every live projectile one frame. Eased + arced travel; the impact lands when the effect
  // resolves (f reaches 1), then the projectile is torn down. Never allocates a new scene object per
  // frame beyond the one-time trail buffer it updates in place.
  stepProjectiles(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.t += dt;
      const f = Math.max(0, Math.min(1, p.t / p.dur));
      const eased = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
      // lerp along the line, lifted by a sine arc that peaks mid-flight (reads as an arcing burst).
      const x = p.from.x + (p.to.x - p.from.x) * eased;
      const y = p.from.y + (p.to.y - p.from.y) * eased + Math.sin(Math.PI * f) * p.arc;
      const z = p.from.z + (p.to.z - p.from.z) * eased;
      p.head.position.set(x, y, z);
      // trail = a streak from the launch point to the current head (grows along the flown path).
      const trail = p.head.children[0] as THREE.Line;
      const attr = trail.geometry.getAttribute("position") as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      arr[0] = p.from.x; arr[1] = p.from.y; arr[2] = p.from.z;
      arr[3] = x - p.from.x; arr[4] = y - p.from.y; arr[5] = z - p.from.z;
      attr.needsUpdate = true;
      const head = p.head.children[1] as THREE.Mesh;
      head.scale.setScalar(0.2 * (1 - f * 0.4));
      (trail.material as THREE.LineBasicMaterial).opacity = 0.85 * (1 - f * 0.5);
      if (f >= 1) {
        if (!p.impactFired) {
          p.impactFired = true;
          const [tx, ty] = p.toKey.split(",").map(Number);
          this.impact({ x: tx, y: ty, h: 0 }, 0xff9a3c, 0.9);
        }
        // resolve: drop the projectile group after the impact beat has started.
        this.projectileGroup.remove(p.head);
        trail.geometry.dispose();
        (trail.material as THREE.Material).dispose();
        (head.material as THREE.Material).dispose();
        this.projectiles.splice(i, 1);
      }
    }
  }

  // Test readout: every live projectile with its world head position + its source/target tile keys,
  // so flight-path.spec.ts can sample screen positions across frames and derive start/end/impact
  // expectations from geometry (not from an animation flag).
  debugProjectiles(): { kind: string; x: number; y: number; z: number; from: number[]; to: number[]; f: number; impactFired: boolean }[] {
    const out: { kind: string; x: number; y: number; z: number; from: number[]; to: number[]; f: number; impactFired: boolean }[] = [];
    for (const p of this.projectiles) {
      out.push({
        kind: "flight",
        x: +p.head.position.x.toFixed(3),
        y: +p.head.position.y.toFixed(3),
        z: +p.head.position.z.toFixed(3),
        from: p.fromKey.split(",").map(Number),
        to: p.toKey.split(",").map(Number),
        f: +(p.t / p.dur).toFixed(4),
        impactFired: p.impactFired,
      });
    }
    return out;
  }

  // ---- ability-target highlight (presentation of the authoritative legal target set) ----------
  // Drawn in a persistent layer (targetGroup), NOT fxGroup, so clearMarkers/clearEffects never wipe
  // it. Cleared only via clearAbilityTargets (on resolve/cancel/rebuild). Keys are "x,y" tile coords.
  setAbilityTargets(keys: string[], color = 0xff5a2c): void {
    this.clearAbilityTargets();
    for (const k of keys) {
      const [xs, ys] = k.split(",");
      const x = Number(xs);
      const y = Number(ys);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const geo = new THREE.BoxGeometry(TILE * 0.86, 0.14, TILE * 0.86);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false });
      const m = new THREE.Mesh(geo, mat);
      m.position.set((x - 6.5) * TILE, 0.5, (y - 6.5) * TILE);
      m.renderOrder = 7;
      m.name = "target";
      this.targetGroup.add(m);
    }
  }

  clearAbilityTargets(): void {
    for (const o of [...this.targetGroup.children]) {
      this.targetGroup.remove(o);
      const mm = (o as THREE.Mesh).material as THREE.Material | undefined;
      if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
      if (mm) mm.dispose();
    }
  }

  // Drop every live projectile (mission change / reset). Presentation teardown only.
  clearProjectiles(): void {
    for (const p of this.projectiles) {
      this.projectileGroup.remove(p.head);
      for (const c of p.head.children) {
        if ((c as THREE.Mesh).geometry) (c as THREE.Mesh).geometry.dispose();
        const mm = (c as THREE.Mesh).material as THREE.Material | undefined;
        if (mm) mm.dispose();
      }
    }
    this.projectiles.length = 0;
  }

  debugAbilityTargets(): string[] {
    return this.targetGroup.children.map((o) => {
      const p = (o as THREE.Mesh).position;
      return `${Math.round(p.x / TILE + 6.5)},${Math.round(p.z / TILE + 6.5)}`;
    });
  }

  // Hit: a bright ground flash + expanding shock ring plus a spark burst and a debris/smoke puff at
  // the impact point, scaled by damage. The deck flash/ring make a hit read at gameplay scale even
  // beside cover (a flat additive burst alone read as nothing); all parts are transient.
  impact(p: { x: number; y: number; h: number }, color = 0xffb020, scale = 1) {
    const c = this.tileToWorld(p);
    c.y += 0.4;
    const s = Math.max(0.5, Math.min(1.7, scale));
    // bright ground flash: a short-lived white-hot additive disc under the hit (reads as a scorch).
    const flash = new THREE.Mesh(
      new THREE.RingGeometry(0.001, 0.62 * s, 28),
      new THREE.MeshBasicMaterial({ color: 0xfff2d0, transparent: true, opacity: 0.95, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    flash.userData = { kind: "impact", at: [p.x, p.y] };
    flash.rotation.x = -Math.PI / 2;
    flash.position.set(c.x, 0.12, c.z);
    flash.renderOrder = 6;
    this.addFx(flash, 0.16, (o, f) => { ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - f); });
    // expanding shock ring on the deck.
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.36, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.userData = { kind: "impact", at: [p.x, p.y] };
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(c.x, 0.13, c.z);
    ring.renderOrder = 6;
    this.addFx(ring, 0.4, (o, f) => { o.scale.setScalar(1 + f * (2.6 * s)); ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - f); });
    const ns = Math.round(26 * s);
    const sp = new Float32Array(ns * 3);
    const spv = new Float32Array(ns * 3);
    for (let i = 0; i < ns; i++) {
      sp[i * 3] = c.x; sp[i * 3 + 1] = c.y; sp[i * 3 + 2] = c.z;
      const a = Math.random() * Math.PI * 2;
      spv[i * 3] = Math.cos(a) * 1.6; spv[i * 3 + 1] = Math.random() * 2.2 + 0.5; spv[i * 3 + 2] = Math.sin(a) * 1.6;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.BufferAttribute(sp, 3));
    const sparks = new THREE.Points(sg, new THREE.PointsMaterial({ color, size: 0.14, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    sparks.userData = { kind: "impact", at: [p.x, p.y] };
    this.addBurst(sparks, 0.5, spv);
    // debris/smoke puff: fewer, larger, slower grey motes that rise then dissipate.
    const nm = Math.round(6 * s);
    const mp = new Float32Array(nm * 3);
    const mv = new Float32Array(nm * 3);
    for (let i = 0; i < nm; i++) {
      mp[i * 3] = c.x; mp[i * 3 + 1] = c.y; mp[i * 3 + 2] = c.z;
      const a = Math.random() * Math.PI * 2;
      mv[i * 3] = Math.cos(a) * 0.5; mv[i * 3 + 1] = Math.random() * 0.9 + 0.4; mv[i * 3 + 2] = Math.sin(a) * 0.5;
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute("position", new THREE.BufferAttribute(mp, 3));
    const smoke = new THREE.Points(mg, new THREE.PointsMaterial({ color: 0x8a8f96, size: 0.16, transparent: true, opacity: 0.55, depthWrite: false }));
    smoke.userData = { kind: "impact", at: [p.x, p.y] };
    this.addBurst(smoke, 0.6, mv);
    if (!this.reducedMotion) this.shake = Math.min(0.5, this.shake + 0.1 * s);
  }

  // Miss/blocked: a light-blue spall spray plus a brief expanding ring at the COVER/deck so the
  // surface that took the round reads distinctly from a unit hit.
  coverHit(p: { x: number; y: number; h: number }, color = 0xbfe9ff) {
    const c = this.tileToWorld(p);
    c.y += 0.4;
    const ns = 16;
    const sp = new Float32Array(ns * 3);
    const spv = new Float32Array(ns * 3);
    for (let i = 0; i < ns; i++) {
      sp[i * 3] = c.x; sp[i * 3 + 1] = c.y; sp[i * 3 + 2] = c.z;
      const a = Math.random() * Math.PI * 2;
      spv[i * 3] = Math.cos(a) * 1.2; spv[i * 3 + 1] = Math.random() * 1.4 + 0.4; spv[i * 3 + 2] = Math.sin(a) * 1.2;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.BufferAttribute(sp, 3));
    const spray = new THREE.Points(sg, new THREE.PointsMaterial({ color, size: 0.08, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    spray.userData = { kind: "cover", at: [p.x, p.y] };
    this.addBurst(spray, 0.45, spv);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.14, 0.22, 26), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.userData = { kind: "cover", at: [p.x, p.y] };
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(c.x, 0.16, c.z);
    ring.renderOrder = 5;
    this.addFx(ring, 0.4, (o, f) => { o.scale.setScalar(1 + f * 2.4); ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - f); });
    if (!this.reducedMotion) this.shake = Math.min(0.4, this.shake + 0.04);
  }

  // EMP / disruption: two shock rings expanding outward from a device/point.
  empRing(p: { x: number; y: number; h: number }, color = 0x7fd8ff, r = 1.6) {
    const c = this.tileToWorld(p);
    for (const pair of [[0.3, 0.55], [0.6, 0.7]] as [number, number][]) {
      const m = new THREE.Mesh(new THREE.RingGeometry(pair[0], pair[0] + 0.24, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.userData = { kind: "emp", at: [p.x, p.y] };
      m.rotation.x = -Math.PI / 2;
      m.position.set(c.x, 0.15, c.z);
      m.renderOrder = 5;
      this.addFx(m, pair[1], (o, f) => { o.scale.setScalar(0.4 + f * (r / 0.5)); ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - f); });
    }
  }

  // Scan/ping sweep: a rotating thin arc that fades — reads as a sensor sweep at a point.
  sweep(p: { x: number; y: number; h: number }, color = 0x9be8ff) {
    const c = this.tileToWorld(p);
    const m = new THREE.Mesh(new THREE.RingGeometry(0.25, 1.5, 32, 1, 0, Math.PI / 2.2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.userData = { kind: "sweep", at: [p.x, p.y] };
    m.rotation.x = -Math.PI / 2;
    m.position.set(c.x, 0.17, c.z);
    m.renderOrder = 5;
    this.addFx(m, 0.7, (o, f) => { o.rotation.z = f * Math.PI * 1.4; ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - f); });
  }

  // Stealth shimmer: a restrained translucent pulse over the affected unit (no gore, no clutter).
  shimmer(p: { x: number; y: number; h: number }, color = 0x8ff0ff) {
    const c = this.tileToWorld(p);
    const m = new THREE.Mesh(this._quad, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    m.userData = { kind: "shimmer", at: [p.x, p.y] };
    m.position.set(c.x, c.y + 0.6, c.z);
    m.scale.setScalar(0.5);
    this.addFx(m, 0.6, (o, f) => { o.position.y = c.y + 0.6 + f * 0.25; o.scale.setScalar(0.5 + f * 0.7); ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - f); });
  }

  // Death/neutralisation: a brief, muted dissipate (a few dim embers + a low ring). Restrained.
  neutralize(p: { x: number; y: number; h: number }, color = 0x6a7580) {
    const c = this.tileToWorld(p);
    c.y += 0.35;
    const n = 12;
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = c.x; pos[i * 3 + 1] = c.y; pos[i * 3 + 2] = c.z;
      const a = Math.random() * Math.PI * 2;
      vel[i * 3] = Math.cos(a) * 0.6; vel[i * 3 + 1] = Math.random() * 0.8 + 0.2; vel[i * 3 + 2] = Math.sin(a) * 0.6;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color, size: 0.1, transparent: true, opacity: 0.7, depthWrite: false }));
    pts.userData = { kind: "death", at: [p.x, p.y] };
    this.addBurst(pts, 0.7, vel);
  }

  shakeAdd(a: number) {
    if (!this.reducedMotion) this.shake = Math.min(0.7, this.shake + a);
  }

  private updateEffects(dt: number) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.t += dt;
      const f = e.t / e.dur;
      if (f >= 1) {
        this.disposeFx(e.obj);
        this.effects.splice(i, 1);
        continue;
      }
      if (e.tick) e.tick(e.obj, f);
    }
  }

  // In-world alarm legibility: a single pulsing alert wash on the affected cluster (NOT only HUD).
  setAlertWash(level: number, focus: { x: number; y: number } | null) {
    if (level <= 0 || !focus) {
      if (this.alertWash) { this.fxGroup.remove(this.alertWash); this.alertWash.geometry.dispose(); (this.alertWash.material as THREE.Material).dispose(); this.alertWash = null; }
      return;
    }
    const col = level >= 3 ? 0xff3a5a : level === 2 ? 0xff7a3a : 0xffc23a;
    if (!this.alertWash) {
      const m = new THREE.Mesh(new THREE.RingGeometry(1.4, 3.2, 48), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.28, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 6;
      m.name = "marker";
      this.fxGroup.add(m);
      this.alertWash = m;
    }
    const c = this.tileToWorld({ x: focus.x, y: focus.y, h: 0 });
    this.alertWash.position.set(c.x, 0.13, c.z);
    (this.alertWash.material as THREE.MeshBasicMaterial).color.setHex(col);
    this.alertWash.visible = true;
  }

  private updateAlertWash() {
    if (!this.alertWash) return;
    const mat = this.alertWash.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.2 + 0.12 * (0.5 + 0.5 * Math.sin(this.animClock * 6));
    this.alertWash.rotation.z = this.animClock * 0.6;
  }

  private updateParticles(dt: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.disposeFx(p.points);
        this.particles.splice(i, 1);
        continue;
      }
      const arr = p.points.geometry.getAttribute("position") as THREE.BufferAttribute;
      const a = arr.array as Float32Array;
      for (let j = 0; j < a.length; j += 3) {
        a[j] += p.vel[j] * dt;
        a[j + 1] += p.vel[j + 1] * dt;
        a[j + 2] += p.vel[j + 2] * dt;
        p.vel[j + 1] -= 6 * dt;
      }
      arr.needsUpdate = true;
      (p.points.material as THREE.PointsMaterial).opacity = Math.max(0, p.life / p.max);
    }
  }

  // ---- camera ----
  angleQuarters = 0;
  zoom = 1;
  // Vertical offset (world units) added to the camera lookAt target relative to `focus`. A negative
  // value lowers the aim (camera looks slightly downward past the board), which recentres the whole-orbit
  // framing. Measured over 32 azimuths at lookY=-2: maxCentre 0.097, minCov 0.399, no silhouette overlap,
  // no central intrusion. Does not change fov/distance/height and does not touch focus (pan unchanged).
  lookY = -2.0;
  setAngle(q: number) {
    // Continuous azimuth (in quarter turns). Kept fractional so the orbit can sweep a full 360
    // through intermediate angles; the quarter keyboard/HUD path still lands on exact 0/1/2/3.
    this.angleQuarters = q;
  }
  rotateQuarter(dir: number) {
    this.setAngle(this.angleQuarters + dir);
  }
  // Continuous azimuth from a left-drag (in quarter-turns). Keeps the value in [0,4) so a full 360
  // sweep wraps cleanly; the camera pivots around the CURRENT focus (its central pivot).
  orbitBy(dQuarters: number) {
    this.angleQuarters = (((this.angleQuarters + dQuarters) % 4) + 4) % 4;
  }
  focus = new THREE.Vector3(0, 0, 0);
  focusTile(x: number, y: number) {
    this.focus.set((x - 6.5) * TILE, 0, (y - 6.5) * TILE);
  }
  zoomBy(d: number) {
    this.zoom = Math.max(0.55, Math.min(2.1, this.zoom + d));
  }
  // View-relative pan (shared by the drag path and the four HUD pan buttons). The two ground axes
  // are derived FROM THE LIVE CAMERA (its projected screen-right and its horizontal view direction),
  // NOT from a hardcoded board azimuth. Arguments are screen-space: dxa = right, dya = down. A fixed
  // landmark therefore follows the cursor: a right-drag (dxa>0) makes it move screen-RIGHT, a
  // down-drag (dya>0) makes it move screen-DOWN — at every orbit angle. Replaces the old
  // (sin a+0.8, cos a+0.8) helper, which was up to ~82 deg off the true screen axes and pushed
  // focus along the view direction (a near no-op) at Q1-Q3.
  pan(dxa: number, dya: number) {
    const fwd = this._cv1.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-9) return;
    fwd.normalize();
    const right = this._cv2.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    right.y = 0;
    if (right.lengthSq() < 1e-9) return;
    right.normalize();
    // Right-drag: camera/focus move -screen-right so the world slides screen-right (follows cursor).
    // Down-drag: camera/focus move +forward (deeper into the scene) so the world slides screen-down.
    this.focus.addScaledVector(right, -dxa);
    this.focus.addScaledVector(fwd, dya);
    // clamp to board area
    this.focus.x = Math.max(-8, Math.min(8, this.focus.x));
    this.focus.z = Math.max(-8, Math.min(8, this.focus.z));
  }
  // Optional fixed-camera pose used only by the off-by-default review capture tool to frame a
  // single subject. When null (always during gameplay) the orbit camera below runs unchanged.
  camPoseOverride: { px: number; py: number; pz: number; tx: number; ty: number; tz: number } | null = null;

  private computeCamera() {
    if (this.camPoseOverride) {
      const p = this.camPoseOverride;
      this.camera.position.set(p.px, p.py, p.pz);
      this.camera.lookAt(p.tx, p.ty, p.tz);
      return;
    }
    const a = (this.angleQuarters * Math.PI) / 2;
    // Framing contract: the playfield must dominate the viewport and backdrop props must stay in the
    // outer rim (never the central foreground). A steeper, slightly longer orbit (pitch ~41 deg vs the
    // old ~34 deg) lifts the horizon tower ring toward the top edge and keeps the whole 14x14 board
    // centred, instead of the old shallow pose that let far backdrop blocks loom large mid-frame and
    // let a target-nudge drop half the board off-screen.
    const dist = 14.6 * this.zoom;
    const height = 12.6 * this.zoom;
    // Reused scratch vectors: the render loop must not allocate per frame. Offsets reproduce the
    // previous (sin,0,cos)-normalised horizontal run at length `dist` with a fixed `height` lift.
    const off = this._cv1.set(Math.sin(a), 0, Math.cos(a));
    if (off.lengthSq() > 1e-9) off.normalize();
    off.multiplyScalar(dist);
    off.y = height;
    const pos = this._cv2.copy(this.focus).add(off);
    const lerp = this.reducedMotion ? 1 : 0.15;
    this.camera.position.lerp(pos, lerp);
    // Look target is lifted 2.0 above the focus so the whole-orbit board stays centred without changing
    // the optics (fov/dist/height/pitch and therefore the fog relationship are untouched). focus itself
    // is left alone, so pan and gameplay semantics (which move focus) are unchanged.
    const look = this._cv3.copy(this.focus);
    look.y += this.lookY;
    this.camera.lookAt(look);
    if (this.shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
      this.shake *= 0.86;
    }
  }

  // Framing readout for the CAMERA criterion (e2e/camera-frame.spec.ts). Purely geometric: projects
  // the playfield footprint and every tagged backdrop prop through the CURRENT camera and reports
  // screen coverage / centring + any backdrop intrusion into the central foreground region. No
  // gameplay effect; the render loop never calls it. Central foreground region = |NDC|<=0.30 on both
  // axes (the middle 60% of the frame); backdrop props must not land there.
  debugCameraMetrics(): {
    ok: boolean; W: number; H: number; camY: number; pitchDeg: number;
    playfield: { cov: number; centerDist: number; box: { x: number; y: number; w: number; h: number } };
    backdropTotal: number; backdropOnScreen: number; backdropIntrude: number; backdropOverPlayfield: number; maxOverlapArea: number; intruders: string[];
    maxBackdropProjSize: number; bboxOverPlayfield: number; maxBboxOverlapArea: number;
  } {
    this.camera.updateMatrixWorld(true);
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    const canvas = this.renderer.domElement;
    const CW = canvas.clientWidth || canvas.width;
    const CH = canvas.clientHeight || canvas.height;
    const proj = (x: number, y: number, z: number) => {
      const p = new THREE.Vector3(x, y, z).project(this.camera);
      return { sx: (p.x * 0.5 + 0.5) * CW, sy: (-p.y * 0.5 + 0.5) * CH, nx: p.x, ny: p.y, z: p.z };
    };
    // Playfield footprint: project the 8 corners of the 14x14 board volume. The AABB drives coverage +
    // centring (UNCHANGED); the TRUE projected silhouette (convex hull of the same corners) is what the
    // backdrop-overlap bar is named after. A diamond's AABB is ~twice its area and its four corners are
    // empty space beside the board, so a tower receding past a shoulder lands in an empty corner and the
    // old AABB test called that "over the playfield" when it was over nothing. Measured against the
    // convex hull (the most generous possible footprint) a prop is only "over the board" if it truly is.
    const boardPts: number[][] = [];
    let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
    for (let i = 0; i < 8; i++) {
      const p = proj(i & 1 ? 7 : -7, i & 2 ? 1.7 : 0, i & 4 ? 7 : -7);
      boardPts.push([p.sx, p.sy]);
      minx = Math.min(minx, p.sx); maxx = Math.max(maxx, p.sx);
      miny = Math.min(miny, p.sy); maxy = Math.max(maxy, p.sy);
    }
    const cov = (Math.max(0, maxx - minx) * Math.max(0, maxy - miny)) / (CW * CH);
    const acx = (minx + maxx) / 2, acy = (miny + maxy) / 2;
    const centerDist = Math.hypot((acx - CW / 2) / (CW / 2), (acy - CH / 2) / (CH / 2));
    // 2D convex hull (Andrew monotone chain), normalised to CCW so the clip inside-test is consistent.
    const signed2 = (P: number[][]): number => { let a = 0; for (let i = 0, n = P.length; i < n; i++) { const j = (i + 1) % n; a += P[i][0] * P[j][1] - P[j][0] * P[i][1]; } return a / 2; };
    const hull = (pts: number[][]): number[][] => {
      const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      if (P.length < 3) return P;
      const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const lower: number[][] = [];
      for (const p of P) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
      const upper: number[][] = [];
      for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
      lower.pop(); upper.pop();
      const h = lower.concat(upper);
      return signed2(h) < 0 ? h.reverse() : h;
    };
    const isect = (p1: number[], p2: number[], a: number[], b: number[]): number[] => {
      const dcx = b[0] - a[0], dcy = b[1] - a[1];
      let t = ((a[0] - p1[0]) * dcy - (a[1] - p1[1]) * dcx) / ((p2[0] - p1[0]) * dcy - (p2[1] - p1[1]) * dcx);
      if (!isFinite(t)) t = 0;
      return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
    };
    // Portion of SUBJECT inside a CONVEX clip polygon via Sutherland–Hodgman (= subject ∩ clip).
    const clipConvex = (subject: number[][], clip: number[][]): number[][] => {
      let out = subject;
      for (let i = 0, n = clip.length; i < n && out.length; i++) {
        const a = clip[i], b = clip[(i + 1) % n];
        const inside = (p: number[]) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
        const inp: number[][] = [];
        for (let k = 0, m = out.length; k < m; k++) {
          const cur = out[k], prev = out[(k - 1 + m) % m];
          const ci = inside(cur), pi = inside(prev);
          if (ci) { if (!pi) inp.push(isect(prev, cur, a, b)); inp.push(cur); }
          else if (pi) inp.push(isect(prev, cur, a, b));
        }
        out = inp;
      }
      return out;
    };
    const boardHull = hull(boardPts);
    // Backdrop props: how many project into the central foreground region, and their biggest size.
    let backdropTotal = 0, backdropOnScreen = 0, backdropIntrude = 0;
    const intruders: string[] = [];
    let maxProj = 0;
    // A backdrop prop is a foreground violation if it lands inside the central 60% box OR its projected
    // footprint actually sits over the BOARD — its convex hull intersecting the board's convex hull — not
    // merely inside the board's empty AABB corners. The old AABB-corner overlap is still computed and
    // reported (bboxOverPlayfield / maxBboxOverlapArea) as an auditable diagnostic, but the BAR asserts
    // on the silhouette measure (backdropOverPlayfield), which is what "over the board" actually means.
    const pf = { x: minx, y: miny, w: maxx - minx, h: maxy - miny };
    let backdropOverPlayfield = 0;
    let maxOverlapArea = 0;
    let bboxOverPlayfield = 0;
    let maxBboxOverlapArea = 0;
    for (const c of this.backdropGroup.children) {
      backdropTotal++;
      const bb = new THREE.Box3().setFromObject(c);
      let bminx = 1e9, bmaxx = -1e9, bminy = 1e9, bmaxy = -1e9, anyFront = false;
      const propPts: number[][] = [];
      for (let i = 0; i < 8; i++) {
        const cx = i & 1 ? bb.max.x : bb.min.x;
        const cy = i & 2 ? bb.max.y : bb.min.y;
        const cz = i & 4 ? bb.max.z : bb.min.z;
        const p = proj(cx, cy, cz);
        if (p.z <= 1) anyFront = true;
        propPts.push([p.sx, p.sy]);
        bminx = Math.min(bminx, p.sx); bmaxx = Math.max(bmaxx, p.sx);
        bminy = Math.min(bminy, p.sy); bmaxy = Math.max(bmaxy, p.sy);
      }
      const centerP = new THREE.Vector3(c.position.x, c.position.y, c.position.z).project(this.camera);
      const onScreen = anyFront && centerP.z < 1 && bmaxx >= 0 && bmaxy >= 0 && bminx <= CW && bminy <= CH;
      if (onScreen) backdropOnScreen++;
      const inCentral = onScreen && Math.abs(centerP.x) <= 0.30 && Math.abs(centerP.y) <= 0.30;
      if (inCentral) {
        backdropIntrude++;
        intruders.push(`${c.position.x.toFixed(1)},${c.position.z.toFixed(1)}:central`);
      }
      // footprint overlap against the playfield SILHOUETTE (only meaningful if on-screen & in front).
      if (onScreen) {
        const propHull = hull(propPts);
        const inter = propHull.length >= 3 && boardHull.length >= 3 ? clipConvex(propHull, boardHull) : [];
        const oArea = inter.length >= 3 ? Math.abs(signed2(inter)) / 2 / (CW * CH) : 0;
        if (oArea > 0.0005) {
          backdropOverPlayfield++;
          if (oArea > maxOverlapArea) maxOverlapArea = oArea;
          if (!inCentral) intruders.push(`${c.position.x.toFixed(1)},${c.position.z.toFixed(1)}:overlap ${(oArea * 100).toFixed(2)}%`);
        }
        // secondary diagnostic, NOT asserted: the old AABB-corner overlap, kept so the change is auditable.
        const ox = Math.max(0, Math.min(bmaxx, pf.x + pf.w) - Math.max(bminx, pf.x));
        const oy = Math.max(0, Math.min(bmaxy, pf.y + pf.h) - Math.max(bminy, pf.y));
        const bbArea = (ox * oy) / (CW * CH);
        if (bbArea > 0.0005) {
          bboxOverPlayfield++;
          if (bbArea > maxBboxOverlapArea) maxBboxOverlapArea = bbArea;
        }
      }
      const rad = bb.getSize(new THREE.Vector3()).length() / 2;
      const e2 = new THREE.Vector3(c.position.x + rad, c.position.y, c.position.z).project(this.camera);
      const s1 = proj(c.position.x, c.position.y, c.position.z);
      const s2 = { sx: (e2.x * 0.5 + 0.5) * CW, sy: (-e2.y * 0.5 + 0.5) * CH };
      maxProj = Math.max(maxProj, Math.hypot(s2.sx - s1.sx, s2.sy - s1.sy) / Math.min(CW, CH));
    }
    const camDir = this.camera.getWorldDirection(new THREE.Vector3());
    const pitchDeg = (Math.asin(Math.max(-1, Math.min(1, -camDir.y))) * 180) / Math.PI;
    return {
      ok: true, W: CW, H: CH, camY: +this.camera.position.y.toFixed(2), pitchDeg: +pitchDeg.toFixed(1),
      playfield: { cov: +cov.toFixed(3), centerDist: +centerDist.toFixed(3), box: { x: +(minx / CW).toFixed(3), y: +(miny / CH).toFixed(3), w: +((maxx - minx) / CW).toFixed(3), h: +((maxy - miny) / CH).toFixed(3) } },
      backdropTotal, backdropOnScreen, backdropIntrude, backdropOverPlayfield, maxOverlapArea: +(maxOverlapArea * 100).toFixed(3), intruders, maxBackdropProjSize: +maxProj.toFixed(3),
      bboxOverPlayfield, maxBboxOverlapArea: +(maxBboxOverlapArea * 100).toFixed(3),
    };
  }

  pickAt(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const pt = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.groundPlane, pt)) {
      const x = Math.round(pt.x / TILE + 6.5);
      const y = Math.round(pt.z / TILE + 6.5);
      if (x >= 0 && y >= 0 && x < GRID && y < GRID) return { x, y };
    }
    return null;
  }

  start() {
    this.last = performance.now();
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (t - this.last) / 1000);
      this.last = t;
      this.fpsCount++;
      this.fpsAccum += dt;
      if (this.fpsAccum >= 0.5) {
        this.fpsValue = Math.round(this.fpsCount / this.fpsAccum);
        this.fpsCount = 0;
        this.fpsAccum = 0;
      }
      this.animClock += dt;
      this.clock.getDelta();
      this.computeCamera();
      this.updateParticles(dt);
      this.updateEffects(dt);
      this.stepProjectiles(dt);
      this.updateAlertWash();
      if (!this.reducedMotion) {
        this.stepMoveTweens(t);
        this.animateUnits(dt);
      }
      if (this.composer) this.composer.render();
      else this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  perf() {
    let meshes = 0;
    let shadows = 0;
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        meshes++;
        if (o.castShadow) shadows++;
      }
    });
    return { fps: this.fpsValue, drawCalls: this.renderer.info.render.calls, tris: this.renderer.info.render.triangles, meshes, shadows };
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setSize(w, h);
    }
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points || o instanceof THREE.Line) {
        o.geometry?.dispose?.();
        const mm = o.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mm)) mm.forEach((m) => m.dispose());
        else mm?.dispose?.();
      }
    });
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) this.container.removeChild(this.renderer.domElement);
  }
}
