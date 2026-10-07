// 重機で建てる — 解体: 一人称ショベルでビルを壊し、がれきをダンプに積んで さら地にする
// 方針（knowhow/html-game/tablet-3d-and-engine-choice.md）:
//  ・重機の腕はキネマティック（角度を直接動かす）。当たりは ANIMATED の箱で破片を押す
//  ・ビルは 0.5m 格子。バケット先端が触れた格子を消し、地面につながらない塊は 2×2×2 ずつ まとめて落とす
//  ・バケットは「口が上を向いている間、中の破片をしっかり掴む（物理を止めて腕にくっつける）」。口を下に向けると離す
//  ・ダンプの荷台に入った破片は荷台にくっつく。いっぱいになるとダンプが出ていき、空のダンプが戻る
"use strict";
const B = BABYLON;
const Q = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);

const CELL = 0.5;          // 格子の大きさ(m)。本人「細かく壊れるように」（2026-10-07）で 1m→0.5m
const MAX_DEBRIS = 500;    // 破片の上限。超えたら古い物から消す（掴んでいる物は消さない）
const CARVE_R = 0.75;      // バケット先端の削る半径
const BUCKET = { W: 1.9, H: 1.05, L: 1.55 };   // 本人「バケットを大きく」で 1.1×0.7×1.25 から拡大
const HOLD_MAX = 40;       // バケットに一度に掴める数
const TRUCK_CAP = 40;      // ダンプ 1 台に積める量（小さい破片 1・2m の板 4 くらい。units() で数える）
const G = window.G = {};   // 確かめ用の口

(async function main() {
  const canvas = $("cv");
  // ---- エンジン: WebGPU が使えれば使う（?gl=1 で WebGL を強制） ----
  let engine, api = "WebGL2";
  try {
    if (!Q.has("gl") && navigator.gpu && await B.WebGPUEngine.IsSupportedAsync) {
      engine = new B.WebGPUEngine(canvas, { antialias: true, stencil: true });
      await engine.initAsync();
      api = "WebGPU";
    }
  } catch (e) { console.warn("WebGPU 失敗→WebGL", e); engine = null; }
  if (!engine) engine = new B.Engine(canvas, true, { stencil: true }, false);
  // 解像度: 端末の細かさ（iPad は 2）まで使う。本人「解像度を上げて」（2026-10-07）。?lo で 1 倍に戻す
  const DPR = Q.has("lo") ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  engine.setHardwareScalingLevel(1 / DPR);

  const scene = new B.Scene(engine);
  scene.clearColor = new B.Color4(0.62, 0.78, 0.92, 1);
  scene.fogMode = B.Scene.FOGMODE_LINEAR; scene.fogStart = 80; scene.fogEnd = 220;
  scene.fogColor = new B.Color3(0.62, 0.78, 0.92);

  // ---- 物理 ----
  const hk = await HavokPhysics({ locateFile: () => "vendor/HavokPhysics.wasm" });
  const plugin = new B.HavokPlugin(true, hk);
  scene.enablePhysics(new B.Vector3(0, -9.81, 0), plugin);

  // ---- 光と影 ----
  const hemi = new B.HemisphericLight("hemi", new B.Vector3(0.2, 1, 0.1), scene);
  hemi.intensity = 0.55; hemi.groundColor = new B.Color3(0.35, 0.33, 0.3);
  const sun = new B.DirectionalLight("sun", new B.Vector3(-0.5, -1, -0.35), scene);
  sun.position = new B.Vector3(40, 60, 30); sun.intensity = 1.0;
  const shadow = new B.ShadowGenerator(Q.has("lo") ? 1024 : 2048, sun);
  shadow.usePercentageCloserFiltering = true; shadow.bias = 0.002;
  let shadowOn = !Q.has("noshadow");

  const mat = (name, r, g, b) => { const m = new B.StandardMaterial(name, scene); m.diffuseColor = new B.Color3(r, g, b); m.specularColor = new B.Color3(0.08, 0.08, 0.08); return m; };

  // ---- 地面（土の模様を DynamicTexture で） ----
  const ground = B.MeshBuilder.CreateBox("ground", { width: 240, height: 1, depth: 240 }, scene);
  ground.position.y = -0.5; ground.receiveShadows = true;
  {
    const dt = new B.DynamicTexture("dirt", 512, scene, false, B.Texture.BILINEAR_SAMPLINGMODE), c = dt.getContext();   // ミップマップ有りだと WebGPU で遠くが黒くなった
    c.fillStyle = "#8a7453"; c.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 5000; i++) { const v = 100 + Math.random() * 60 | 0; c.fillStyle = `rgba(${v},${v * 0.85 | 0},${v * 0.6 | 0},0.5)`; c.fillRect(Math.random() * 512, Math.random() * 512, 3, 3); }
    c.strokeStyle = "rgba(60,45,30,0.35)"; c.lineWidth = 2;
    for (let i = 0; i <= 512; i += 64) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i, 512); c.moveTo(0, i); c.lineTo(512, i); c.stroke(); }
    dt.update(); dt.uScale = dt.vScale = 30;
    const gm = mat("groundM", 1, 1, 1); gm.diffuseTexture = dt; ground.material = gm;
  }
  new B.PhysicsAggregate(ground, B.PhysicsShapeType.BOX, { mass: 0, friction: 0.9 }, scene);

  // ================= ビル（格子） =================
  const BW = 8, BD = 6, FLOORS = 3, FH = 3;      // 建物の大きさ(m)
  const bld = { cells: new Map(), origin: new B.Vector3(-BW / 2, 0, 14) };
  const SITE = { x0: bld.origin.x - 3, x1: bld.origin.x + BW + 3, z0: bld.origin.z - 3, z1: bld.origin.z + BD + 3 };   // さら地にする範囲
  const cellShape = new B.PhysicsShapeBox(B.Vector3.Zero(), B.Quaternion.Identity(), new B.Vector3(CELL, CELL, CELL), scene);
  cellShape.material = { friction: 0.8, restitution: 0 };
  const key = (x, y, z) => x + "," + y + "," + z;
  const cellMesh = B.MeshBuilder.CreateBox("cellSrc", { size: CELL * 0.999 }, scene);
  cellMesh.material = mat("cellM", 1, 1, 1); cellMesh.receiveShadows = true;
  cellMesh.alwaysSelectAsActiveMesh = true;

  function cellWorld(x, y, z) { return new B.Vector3(bld.origin.x + (x + 0.5) * CELL, bld.origin.y + (y + 0.5) * CELL, bld.origin.z + (z + 0.5) * CELL); }
  function addCell(x, y, z, kind) {
    const p = cellWorld(x, y, z);
    const node = new B.TransformNode("c", scene); node.position.copyFrom(p);
    const body = new B.PhysicsBody(node, B.PhysicsMotionType.STATIC, false, scene);
    body.shape = cellShape;
    bld.cells.set(key(x, y, z), { x, y, z, kind, node, body, p });
  }
  function buildBuilding() {
    for (const c of bld.cells.values()) { c.body.dispose(); c.node.dispose(); }
    bld.cells.clear();
    const W = BW / CELL, D = BD / CELL, H = FH / CELL;           // 16 × 12、1 階 6 段
    for (let f = 0; f < FLOORS; f++) {
      for (let r = 0; r < H; r++) {
        const y = f * H + r;
        for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
          const edge = x === 0 || z === 0 || x === W - 1 || z === D - 1;
          const corner = (x <= 1 || x >= W - 2) && (z <= 1 || z >= D - 2);
          const pillar = corner || ((x === W / 2 - 1 || x === W / 2) && (z === 0 || z === D - 1));
          if (r === H - 1) { addCell(x, y, z, "slab"); continue; }      // 各階の天井
          if (!edge) continue;
          // 窓: 各階の 2〜3 段目、柱以外の壁を 2 格子おきにあける
          const along = (z === 0 || z === D - 1) ? x : z;
          if (r >= 2 && r <= 3 && !pillar && (Math.floor(along / 2) % 2 === 1)) continue;
          // 1 階の正面（z=0）の真ん中は入口
          if (f === 0 && z === 0 && x >= W / 2 - 3 && x <= W / 2 + 2 && r < 4 && !pillar) continue;
          addCell(x, y, z, pillar ? "pillar" : "wall");
        }
      }
    }
    bld.total = bld.cells.size;
    rebuildCellMesh();
  }
  const KIND_COL = { wall: [0.82, 0.8, 0.74], slab: [0.6, 0.6, 0.6], pillar: [0.72, 0.7, 0.66] };
  function rebuildCellMesh() {
    const n = bld.cells.size, mats = new Float32Array(Math.max(1, n) * 16), cols = new Float32Array(Math.max(1, n) * 4);
    let i = 0;
    for (const c of bld.cells.values()) {
      B.Matrix.Translation(c.p.x, c.p.y, c.p.z).copyToArray(mats, i * 16);
      const k = KIND_COL[c.kind], s = 0.94 + ((c.x * 7 + c.y * 13 + c.z * 5) % 7) * 0.012;
      cols.set([k[0] * s, k[1] * s, k[2] * s, 1], i * 4); i++;
    }
    cellMesh.thinInstanceSetBuffer("matrix", mats, 16, false);
    cellMesh.thinInstanceSetBuffer("color", cols, 4, false);
    cellMesh.thinInstanceCount = n;
  }
  function removeCell(c) { c.body.dispose(); c.node.dispose(); bld.cells.delete(key(c.x, c.y, c.z)); }

  // 地面(y=0)につながっていない格子を探す
  function floatingCells() {
    const seen = new Set(), q = [];
    for (const c of bld.cells.values()) if (c.y === 0) { const k = key(c.x, c.y, c.z); seen.add(k); q.push(c); }
    const N = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    while (q.length) {
      const c = q.pop();
      for (const d of N) { const k = key(c.x + d[0], c.y + d[1], c.z + d[2]); if (!seen.has(k) && bld.cells.has(k)) { seen.add(k); q.push(bld.cells.get(k)); } }
    }
    const out = []; for (const [k, c] of bld.cells) if (!seen.has(k)) out.push(c);
    return out;
  }

  // ================= 破片 =================
  const debrisSrc = B.MeshBuilder.CreateBox("debrisSrc", { size: 1 }, scene);
  debrisSrc.material = mat("debrisM", 0.7, 0.68, 0.63); debrisSrc.isVisible = false;
  debrisSrc.registerInstancedBuffer("color", 4); debrisSrc.instancedBuffers.color = new B.Color4(1, 1, 1, 1);
  const debris = [];                       // {m, ag, held}
  const units = m => Math.max(1, Math.round(m.scaling.x * m.scaling.y * m.scaling.z / 0.45));
  function physOn(d, vel) {
    const s = d.m.scaling;
    d.ag = new B.PhysicsAggregate(d.m, B.PhysicsShapeType.BOX, { mass: Math.max(0.5, s.x * s.y * s.z * 40), friction: 0.85, restitution: 0.05 }, scene);
    if (vel) d.ag.body.setLinearVelocity(vel);
  }
  function physOff(d) { if (d.ag) { d.ag.dispose(); d.ag = null; } }
  function spawnDebris(p, s, col, vel) {
    const m = debrisSrc.createInstance("d");
    m.scaling.set(s.x, s.y, s.z);
    m.position.copyFrom(p);
    m.rotationQuaternion = B.Quaternion.FromEulerAngles((Math.random() - 0.5) * 0.3, Math.random() * 3, (Math.random() - 0.5) * 0.3);
    m.instancedBuffers.color = new B.Color4(col[0], col[1], col[2], 1);
    const d = { m, ag: null, held: false };
    physOn(d, vel);
    debris.push(d);
    while (debris.length > MAX_DEBRIS) {
      const i = debris.findIndex(o => !o.held); if (i < 0) break;
      const o = debris.splice(i, 1)[0]; physOff(o); o.m.dispose();
    }
    return d;
  }
  function clearDebris() { for (const d of debris) { physOff(d); d.m.dispose(); } debris.length = 0; }
  function carvedToDebris(c, kick) {
    const k = KIND_COL[c.kind];
    spawnDebris(c.p, new B.Vector3(CELL * 0.9, CELL * (0.7 + Math.random() * 0.25), CELL * 0.9), k,
      kick.add(new B.Vector3((Math.random() - 0.5), Math.random() * 0.8, (Math.random() - 0.5))));
    removeCell(c);
  }
  // 崩れ落ちる格子は 4×4×4（2m 角）ずつ 1 個にまとめる。壁なら 2m 四方の板、床なら 2m 四方の床板になる
  // （1m 角だとビル 1 棟で 375 個・PC でも 14ms/コマ、すくう回数も多すぎた）
  function collapse(cells) {
    const groups = new Map();
    for (const c of cells) {
      const g = key(c.x >> 2, c.y >> 2, c.z >> 2);
      if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c);
    }
    for (const list of groups.values()) {
      const mn = new B.Vector3(1e9, 1e9, 1e9), mx = new B.Vector3(-1e9, -1e9, -1e9);
      for (const c of list) { mn.minimizeInPlace(c.p); mx.maximizeInPlace(c.p); }
      const size = mx.subtract(mn).addInPlaceFromFloats(CELL, CELL, CELL).scaleInPlace(0.94);
      const k = KIND_COL[list[0].kind];
      spawnDebris(mn.add(mx).scaleInPlace(0.5), size, k, null);
      for (const c of list) removeCell(c);
    }
    return groups.size;
  }

  // ================= 部品づくり（見た目の箱＋必要なら ANIMATED の当たり） =================
  const yel = mat("yel", 0.95, 0.72, 0.1), dark = mat("dark", 0.15, 0.15, 0.16), steel = mat("steel", 0.32, 0.32, 0.34);
  const glass = mat("glass", 0.3, 0.45, 0.55); glass.alpha = 0.35;
  const orange = mat("orange", 0.9, 0.42, 0.12), bedM = mat("bed", 0.45, 0.47, 0.5);
  function makeBox(name, size, parent, pos, m, list) {
    const b = B.MeshBuilder.CreateBox(name, { width: size[0], height: size[1], depth: size[2] }, scene);
    b.parent = parent; b.position.set(pos[0], pos[1], pos[2]); b.material = m;
    shadow.addShadowCaster(b); b.receiveShadows = true;
    if (list) list.push({ mesh: b, size });
    return b;
  }
  function makeColliders(list) {
    for (const pt of list) {
      const n = new B.TransformNode("col_" + pt.mesh.name, scene);
      n.rotationQuaternion = B.Quaternion.Identity();
      const body = new B.PhysicsBody(n, B.PhysicsMotionType.ANIMATED, false, scene);
      body.shape = new B.PhysicsShapeBox(B.Vector3.Zero(), B.Quaternion.Identity(), new B.Vector3(...pt.size), scene);
      body.shape.material = { friction: 0.7, restitution: 0 };
      pt.node = n; pt.body = body;
    }
  }
  const _s = new B.Vector3(), _q = new B.Quaternion(), _p = new B.Vector3();
  function syncColliders(list, teleport) {
    for (const pt of list) {
      pt.mesh.computeWorldMatrix(true).decompose(_s, _q, _p);
      if (teleport) { pt.node.position.copyFrom(_p); pt.node.rotationQuaternion.copyFrom(_q); pt.body.disablePreStep = false; }
      else { pt.body.disablePreStep = true; pt.body.setTargetTransform(_p, _q); }
    }
  }

  // ================= ショベル（キネマティック） =================
  const ex = { pos: new B.Vector3(0, 0, 2), heading: 0, swing: 0, boom: -0.35, stick: 1.3, bucket: 0.6 };
  const LIM = { boom: [-1.05, 0.6], stick: [0.35, 2.6], bucket: [-0.9, 2.6] };
  const root = new B.TransformNode("exRoot", scene);
  const exParts = [];
  makeBox("trackL", [0.8, 0.9, 4.2], root, [-1.2, 0.45, 0], dark);
  makeBox("trackR", [0.8, 0.9, 4.2], root, [1.2, 0.45, 0], dark);
  makeBox("under", [1.8, 0.6, 3.0], root, [0, 0.7, 0], dark, exParts);
  const upper = new B.TransformNode("upper", scene); upper.parent = root; upper.position.y = 1.0;
  makeBox("house", [2.6, 1.1, 3.2], upper, [0.2, 0.55, -0.5], yel, exParts);
  makeBox("counter", [2.6, 0.9, 0.8], upper, [0.2, 0.45, -2.3], dark);
  // 運転席（左前）。窓は透けるので中から外が見える
  const cab = makeBox("cab", [1.1, 1.6, 1.5], upper, [-0.75, 1.9, 0.35], glass); cab.isPickable = false;
  makeBox("cabRoof", [1.15, 0.08, 1.55], upper, [-0.75, 2.72, 0.35], yel);
  const seat = new B.TransformNode("seat", scene); seat.parent = upper; seat.position.set(-0.75, 2.25, 0.25);
  // 腕: ブーム → アーム → バケット（関節ごとに TransformNode。どれも X 軸まわりに回すだけ）
  const boomJ = new B.TransformNode("boomJ", scene); boomJ.parent = upper; boomJ.position.set(0.45, 1.3, 0.9);
  const BOOM_L = 5.6, STICK_L = 3.0;
  makeBox("boom", [0.5, 0.6, BOOM_L], boomJ, [0, 0, BOOM_L / 2], yel, exParts);
  const stickJ = new B.TransformNode("stickJ", scene); stickJ.parent = boomJ; stickJ.position.z = BOOM_L;
  makeBox("stick", [0.4, 0.45, STICK_L], stickJ, [0, 0, STICK_L / 2], yel, exParts);
  const bucketJ = new B.TransformNode("bucketJ", scene); bucketJ.parent = stickJ; bucketJ.position.z = STICK_L;
  // バケット: 口は自分の -Y 側。背板(y=0)・先の板(z=L)・左右の板。口を上に向ける＝すくう、下に向ける＝あける
  {
    const { W, H, L } = BUCKET, t = 0.1;
    makeBox("bkBack", [W, t, L], bucketJ, [0, 0, L / 2], steel, exParts);
    makeBox("bkEnd", [W, H, t], bucketJ, [0, -H / 2, L], steel, exParts);
    makeBox("bkSideL", [t, H, L], bucketJ, [-W / 2, -H / 2, L / 2], steel, exParts);
    makeBox("bkSideR", [t, H, L], bucketJ, [W / 2, -H / 2, L / 2], steel, exParts);
    for (let i = 0; i < 5; i++) makeBox("tooth" + i, [0.12, 0.12, 0.25], bucketJ, [-W / 2 + 0.2 + i * (W - 0.4) / 4, -H + 0.06, L + 0.1], dark);
  }
  const tip = new B.TransformNode("tip", scene); tip.parent = bucketJ; tip.position.set(0, -BUCKET.H, BUCKET.L);
  const tipMid = new B.TransformNode("tipMid", scene); tipMid.parent = bucketJ; tipMid.position.set(0, -BUCKET.H * 0.5, BUCKET.L * 0.6);
  makeColliders(exParts);
  // バケットの一番低い所（地面に潜らせないため）
  const GROUND_MIN = 0.05;
  const bkPts = [[0, -BUCKET.H, BUCKET.L], [-BUCKET.W / 2, -BUCKET.H, BUCKET.L], [BUCKET.W / 2, -BUCKET.H, BUCKET.L], [0, 0, BUCKET.L], [0, -BUCKET.H, 0], [0, 0.3, 0]].map(a => new B.Vector3(...a));
  function bucketLowest() {
    for (const n of [root, upper, boomJ, stickJ]) n.computeWorldMatrix(true);   // 親から順に計算し直す（親の古い値を使わない）
    const m = bucketJ.computeWorldMatrix(true); let lo = 1e9;
    for (const q of bkPts) lo = Math.min(lo, B.Vector3.TransformCoordinates(q, m).y);
    return lo;
  }
  function applyPose() {
    root.position.copyFrom(ex.pos); root.rotation.y = ex.heading;
    upper.rotation.y = ex.swing;
    boomJ.rotation.x = ex.boom; stickJ.rotation.x = ex.stick; bucketJ.rotation.x = ex.bucket;
  }

  // ================= ダンプ =================
  // 前（運転台）は -Z を向いて止まる。荷台は建物側。いっぱいになったら -Z へ走り去り、空のダンプがバックで戻る
  const TRUCK_HOME = new B.Vector3(-6.8, 0, 4.5);   // ビルを掘る位置（z≈6）から左へ 90° 旋回した所に荷台が来る
  const truck = { root: new B.TransformNode("truck", scene), parts: [], state: "wait", z: TRUCK_HOME.z, v: 0, load: [], amount: 0, trips: 0 };
  truck.root.rotation.y = Math.PI;
  {
    const r = truck.root, P = truck.parts;
    makeBox("tChassis", [2.3, 0.6, 7.2], r, [0, 0.95, -0.6], dark, P);
    makeBox("tCab", [2.4, 1.9, 1.8], r, [0, 2.1, 2.1], orange, P);
    makeBox("tGlass", [2.2, 0.8, 0.05], r, [0, 2.55, 3.0], glass);
    makeBox("tFloor", [2.4, 0.15, 4.4], r, [0, 1.35, -1.6], bedM, P);
    makeBox("tWallL", [0.12, 1.1, 4.4], r, [-1.2, 1.95, -1.6], bedM, P);
    makeBox("tWallR", [0.12, 1.1, 4.4], r, [1.2, 1.95, -1.6], bedM, P);
    makeBox("tWallF", [2.4, 1.5, 0.12], r, [0, 2.15, 0.6], bedM, P);
    makeBox("tWallB", [2.4, 1.1, 0.12], r, [0, 1.95, -3.8], bedM, P);
    for (const z of [2.0, -1.0, -2.6]) for (const x of [-1.15, 1.15]) {
      const w = B.MeshBuilder.CreateCylinder("wheel", { diameter: 1.1, height: 0.45, tessellation: 16 }, scene);
      w.parent = r; w.rotation.z = Math.PI / 2; w.position.set(x, 0.55, z); w.material = dark; shadow.addShadowCaster(w);
    }
    makeColliders(P);
  }
  const BED = { x: 1.12, z0: -3.72, z1: 0.52, y0: 1.4, y1: 4.2 };      // 荷台の内側（ダンプの中の座標）
  function bedCenter() { return B.Vector3.TransformCoordinates(new B.Vector3(0, BED.y0, (BED.z0 + BED.z1) / 2), truck.root.computeWorldMatrix(true)); }
  function placeTruck() { truck.root.position.set(TRUCK_HOME.x, 0, truck.z); }

  // ================= カメラ =================
  const fp = new B.UniversalCamera("fp", B.Vector3.Zero(), scene);
  fp.parent = seat; fp.minZ = 0.05; fp.fov = 1.15; fp.inputs.clear();
  const tp = new B.ArcRotateCamera("tp", -Math.PI / 2, 1.1, 18, B.Vector3.Zero(), scene);
  tp.minZ = 0.1; tp.inputs.clear();
  const look = { yaw: 0, pitch: 0.12 };
  let view = "fp";
  scene.activeCamera = fp;

  // ================= 入力（2本レバー＋ペダル＋画面ドラッグで見回し＋キーボード） =================
  const sticks = { L: { x: 0, y: 0, id: null, el: $("stL") }, R: { x: 0, y: 0, id: null, el: $("stR") } };
  // 走行はペダル（押している間だけ）。本人の指定（2026-10-02）: 真ん中にアクセルとバック
  const pedal = { fwd: 0, back: 0, left: 0, right: 0 };
  let speed = 0, turnRate = 0;
  let lookPtr = null;
  function stickAt(e) {
    const W = innerWidth, H = innerHeight;
    if (e.clientY < H * 0.4) return null;
    if (e.clientX < W * 0.32) return "L";
    if (e.clientX > W * 0.68) return "R";
    return null;
  }
  function stickCenter(s) { const r = s.el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }
  function setStick(s, e) {
    const [cx, cy] = stickCenter(s), R = 65;
    let dx = e.clientX - cx, dy = e.clientY - cy; const l = Math.hypot(dx, dy);
    if (l > R) { dx *= R / l; dy *= R / l; }
    s.x = dx / R; s.y = -dy / R;
    s.el.querySelector(".knob").style.transform = `translate(${dx}px,${dy}px)`;
  }
  function releaseStick(s) { s.x = s.y = 0; s.id = null; s.el.querySelector(".knob").style.transform = ""; }
  canvas.addEventListener("pointerdown", e => {
    wakeAudio();
    const w = stickAt(e);
    if (w && sticks[w].id === null) { sticks[w].id = e.pointerId; setStick(sticks[w], e); }
    else if (lookPtr === null) lookPtr = { id: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", e => {
    for (const s of Object.values(sticks)) if (s.id === e.pointerId) setStick(s, e);
    if (lookPtr && lookPtr.id === e.pointerId) {
      const dx = e.clientX - lookPtr.x, dy = e.clientY - lookPtr.y; lookPtr.x = e.clientX; lookPtr.y = e.clientY;
      if (view === "fp") { look.yaw = B.Scalar.Clamp(look.yaw + dx * 0.005, -2.4, 2.4); look.pitch = B.Scalar.Clamp(look.pitch + dy * 0.005, -0.8, 1.0); }
      else { tp.alpha -= dx * 0.006; tp.beta = B.Scalar.Clamp(tp.beta - dy * 0.006, 0.3, 1.45); }
    }
  });
  const up = e => { for (const s of Object.values(sticks)) if (s.id === e.pointerId) releaseStick(s); if (lookPtr && lookPtr.id === e.pointerId) lookPtr = null; };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("wheel", e => { if (view === "tp") tp.radius = B.Scalar.Clamp(tp.radius + e.deltaY * 0.02, 6, 40); }, { passive: true });
  document.addEventListener("gesturestart", e => e.preventDefault());
  const keys = new Set();
  addEventListener("keydown", e => keys.add(e.code)); addEventListener("keyup", e => keys.delete(e.code));
  const kv = (a, b) => (keys.has(a) ? 1 : 0) - (keys.has(b) ? 1 : 0);

  // 前は「作業/走行」の切り替え式だったが、切り替えに気づけず前に進めなかった（2026-10-02 本人）→ 走行はペダルに分けた
  function setLabels() {
    $("labL").textContent = "←→ 旋回 / ↑↓ アーム"; $("labR").textContent = "↑↓ ブーム / ← すくう → あける";
  }
  $("bView").onclick = () => { view = view === "fp" ? "tp" : "fp"; scene.activeCamera = view === "fp" ? fp : tp; $("bView").textContent = view === "fp" ? "運転席" : "外から"; };
  function setShadow(on) {
    shadowOn = on; sun.shadowEnabled = on;
    $("bShadow").textContent = on ? "影 ON" : "影 OFF"; $("bShadow").classList.toggle("on", !on);
  }
  $("bShadow").onclick = () => setShadow(!shadowOn);
  $("bReset").onclick = reset;
  shadow.addShadowCaster(cellMesh); shadow.addShadowCaster(debrisSrc);
  setShadow(shadowOn); setLabels();
  for (const [id, k] of [["pFwd", "fwd"], ["pBack", "back"], ["pLeft", "left"], ["pRight", "right"]]) {
    const el = $(id);
    const on = e => { e.preventDefault(); wakeAudio(); pedal[k] = 1; el.classList.add("on"); el.setPointerCapture(e.pointerId); };
    const off = () => { pedal[k] = 0; el.classList.remove("on"); };
    el.addEventListener("pointerdown", on); el.addEventListener("pointerup", off); el.addEventListener("pointercancel", off); el.addEventListener("lostpointercapture", off);
  }

  // ================= 音（最初のタップで鳴らせるように） =================
  let ac = null, eng = null;
  function wakeAudio() {
    if (!ac) {
      try {
        ac = new (window.AudioContext || window.webkitAudioContext)();
        // エンジン音: のこぎり波＋ローパス（試作用の仮の音）
        const o = ac.createOscillator(), f = ac.createBiquadFilter(), g = ac.createGain();
        o.type = "sawtooth"; o.frequency.value = 38; f.type = "lowpass"; f.frequency.value = 220; g.gain.value = 0.05;
        o.connect(f).connect(g).connect(ac.destination); o.start(); eng = { o, g };
      } catch (e) { ac = null; }
    }
    if (ac && ac.state !== "running") ac.resume();
  }
  document.addEventListener("visibilitychange", () => { if (ac && !document.hidden) ac.resume(); });
  function thud(v, freq) {
    if (!ac || ac.state !== "running") return;
    const n = ac.createBufferSource(), len = ac.sampleRate * 0.25, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const f = ac.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = freq || 500; const g = ac.createGain(); g.gain.value = Math.min(0.6, v);
    n.buffer = buf; n.connect(f).connect(g).connect(ac.destination); n.start();
  }

  // ================= 壊す =================
  let collapseTimer = 0, dirty = false;
  function carveAt(p, r) {
    let n = 0;
    const lx = Math.floor((p.x - bld.origin.x) / CELL), ly = Math.floor((p.y - bld.origin.y) / CELL), lz = Math.floor((p.z - bld.origin.z) / CELL);
    const k = Math.ceil(r / CELL);
    for (let x = lx - k; x <= lx + k && n < 10; x++) for (let y = ly - k; y <= ly + k && n < 10; y++) for (let z = lz - k; z <= lz + k && n < 10; z++) {
      const c = bld.cells.get(key(x, y, z)); if (!c) continue;
      if (B.Vector3.Distance(c.p, p) > r) continue;
      carvedToDebris(c, c.p.subtract(p).normalize().scale(2.0)); n++;
    }
    if (n) { dirty = true; thud(0.2 + n * 0.04); }
    return n;
  }

  // ================= 掴む・あける =================
  const _inv = new B.Matrix(), _lp = new B.Vector3(), _v = new B.Vector3();
  let held = 0;
  function bucketOpenUp() {          // バケットの口（-Y）が世界でどれだけ上を向いているか（1=真上）
    const m = bucketJ.computeWorldMatrix(true);
    return -B.Vector3.TransformNormal(B.Axis.Y, m).normalize().y;
  }
  let lastBucket = 0;
  function updateGrab() {
    const up = bucketOpenUp();
    // すくう動き（バケットを巻き込んでいる最中）は、口の前の広めの範囲も掴む。板で押しのけてしまい 1 個しか入らなかったため
    const curling = ex.bucket > lastBucket + 1e-4 && up > -0.6, opening = ex.bucket < lastBucket - 1e-4; lastBucket = ex.bucket;
    if ((up > 0.35 || curling) && held < HOLD_MAX) {
      const m = curling ? 0.55 : 0.1;
      bucketJ.getWorldMatrix().invertToRef(_inv);
      const { W, H, L } = BUCKET;
      for (const d of debris) {
        if (d.held) continue;
        B.Vector3.TransformCoordinatesToRef(d.m.position, _inv, _lp);
        if (Math.abs(_lp.x) < W / 2 + m && _lp.y > -H - 0.25 - m && _lp.y < 0.05 && _lp.z > -0.1 && _lp.z < L + 0.15 + m) {
          physOff(d); d.m.setParent(bucketJ); d.held = true; held++;
          if (held >= HOLD_MAX) break;
        }
      }
    } else if (opening && up < 0.1 && held) {
      // 自分で「あける」操作をして口が下を向いたら離す。ブームを上げただけで口が下を向き、運ぶ途中で落ちていたため
      // 少しずつこぼす（一度に全部だと荷台からあふれる）
      let n = 0;
      for (const d of debris) {
        if (!d.held) continue;
        d.m.setParent(null); d.held = false; held--;
        // 口のすぐ外へ出してから落とす（中に残すと板に乗ったまま滑り落ちなかった）
        const mouth = B.Vector3.TransformCoordinates(new B.Vector3((Math.random() - 0.5) * BUCKET.W * 0.7, -BUCKET.H - 0.45, BUCKET.L * (0.3 + Math.random() * 0.5)), bucketJ.getWorldMatrix());
        d.m.position.copyFrom(mouth);
        // 荷台の近くで開いたら、荷台の真ん中へ寄せて落とす（補助）
        // 落ちるまでの時間から、荷台の真ん中（少しばらす）に落ちる横の速さを決める
        const c = bedCenter(), p = d.m.position, v = new B.Vector3(0, 0, 0);
        if (truck.state === "wait" && Math.hypot(p.x - c.x, p.z - c.z) < 4.5 && p.y > c.y + 0.5) {
          const t = Math.sqrt(2 * (p.y - c.y - 0.6) / 9.81);
          v.x = (c.x + (Math.random() - 0.5) * 1.2 - p.x) / t; v.z = (c.z + (Math.random() - 0.5) * 2.6 - p.z) / t;
        }
        physOn(d, v);
        if (++n >= 6) break;
      }
      if (n) thud(0.15 + n * 0.03, 350);
    }
  }

  // ================= ダンプの荷台に入った破片を積む／出発と戻り =================
  let loadT = 0;
  function updateTruck(dt) {
    if (truck.state === "wait") {
      loadT += dt;
      if (loadT > 0.2) {
        loadT = 0;
        truck.root.computeWorldMatrix(true).invertToRef(_inv);
        for (let i = debris.length - 1; i >= 0; i--) {
          const d = debris[i]; if (d.held || !d.ag) continue;
          B.Vector3.TransformCoordinatesToRef(d.m.position, _inv, _lp);
          if (Math.abs(_lp.x) < BED.x && _lp.z > BED.z0 && _lp.z < BED.z1 && _lp.y > BED.y0 && _lp.y < BED.y1) {
            d.ag.body.getLinearVelocityToRef(_v);
            if (_v.lengthSquared() > 4) continue;            // まだ勢いよく動いている物は待つ
            physOff(d); d.m.setParent(truck.root); debris.splice(i, 1); truck.load.push(d.m); truck.amount += units(d.m);
          }
        }
        if (truck.amount >= TRUCK_CAP) { truck.state = "leave"; truck.v = 0; thud(0.4, 200); }
      }
    } else if (truck.state === "leave") {
      truck.v = Math.min(12, truck.v + 3 * dt); truck.z -= truck.v * dt;
      if (truck.z < -90) { for (const m of truck.load) m.dispose(); truck.load.length = 0; truck.amount = 0; truck.trips++; truck.state = "back"; }
    } else if (truck.state === "back") {
      const rest = TRUCK_HOME.z - truck.z;
      truck.v = Math.max(1.2, Math.min(12, rest * 0.6)); truck.z += truck.v * dt;
      if (rest < 0.02) { truck.z = TRUCK_HOME.z; truck.state = "wait"; }
    }
    placeTruck(); syncColliders(truck.parts, false);
  }

  // ================= さら地の判定 =================
  let siteDone = false;
  function siteDebris() {
    let n = 0;
    for (const d of debris) { const p = d.m.getAbsolutePosition(); if (!d.held && p.x > SITE.x0 && p.x < SITE.x1 && p.z > SITE.z0 && p.z < SITE.z1) n++; }
    return n;
  }

  function reset() {
    clearDebris(); buildBuilding();
    for (const m of truck.load) m.dispose(); truck.load.length = 0; truck.amount = 0; truck.trips = 0; truck.state = "wait"; truck.z = TRUCK_HOME.z;
    held = 0; siteDone = false; $("done").style.display = "none";
    ex.pos.set(0, 0, 2); ex.heading = 0; ex.swing = 0; ex.boom = -0.35; ex.stick = 1.3; ex.bucket = 0.6;
    look.yaw = 0; look.pitch = 0.12;
    applyPose(); syncColliders(exParts, true); placeTruck(); syncColliders(truck.parts, true);
  }

  // 重機が格子・ダンプに入り込まないか
  function blockedAt(p) {
    for (const c of bld.cells.values()) {
      if (c.p.y > 2) continue;
      if (Math.abs(c.p.x - p.x) < 2.0 && Math.abs(c.p.z - p.z) < 2.3) return true;
    }
    const t = truck.root.position;
    if (Math.abs(t.x - p.x) < 1.25 + 1.9 && Math.abs(t.z - 0.6 - p.z) < 3.6 + 2.2) return true;
    return false;
  }

  // ================= 毎フレーム =================
  let fpsAvg = 60, msAvg = 16, hudT = 0;
  scene.onBeforeRenderObservable.add(() => {
    const dt = G.fixedDt || Math.min(engine.getDeltaTime() / 1000, 0.05);   // 確かめる時は G.fixedDt で固定
    const L = sticks.L, R = sticks.R;
    const sw = L.x + kv("KeyD", "KeyA"), st = -L.y + kv("KeyS", "KeyW"), bo = -R.y + kv("KeyK", "KeyI"), bu = -R.x + kv("KeyJ", "KeyL");
    const prev = [ex.boom, ex.stick, ex.bucket], low0 = bucketLowest();
    ex.swing += sw * 0.85 * dt;
    ex.stick = B.Scalar.Clamp(ex.stick + st * 0.7 * dt, ...LIM.stick);
    ex.boom = B.Scalar.Clamp(ex.boom + bo * 0.45 * dt, ...LIM.boom);
    ex.bucket = B.Scalar.Clamp(ex.bucket + bu * 1.2 * dt, ...LIM.bucket);
    // 腕は物理で動かしていないので地面を突き抜ける → 地面より下へ行く動きはそのコマだけ取り消す
    applyPose();
    const low1 = bucketLowest();
    if (low1 < GROUND_MIN && low1 < low0) {
      // 取り消すと地面に沿って引けなくなる → ブームを少しずつ上げて地面の上に戻す（地面をなぞる補助）
      let lo = low1;
      for (let i = 0; i < 40 && lo < GROUND_MIN && ex.boom > LIM.boom[0]; i++) { ex.boom = Math.max(LIM.boom[0], ex.boom - 0.004); applyPose(); lo = bucketLowest(); }
      if (lo < GROUND_MIN && lo < low0) [ex.boom, ex.stick, ex.bucket] = prev;
    }
    let moving = Math.abs(sw) + Math.abs(st) + Math.abs(bo) + Math.abs(bu);
    // ペダル: 目標の速さへじわっと近づける（急に止まらない）
    const want = B.Scalar.Clamp(pedal.fwd - pedal.back + kv("ArrowUp", "ArrowDown"), -1, 1) * (pedal.back && !pedal.fwd ? 2.0 : 3.2);
    speed += (want - speed) * Math.min(1, dt * (want ? 2.5 : 4));
    if (Math.abs(speed) < 0.02 && !want) speed = 0;
    const wantT = B.Scalar.Clamp(pedal.right - pedal.left + kv("ArrowRight", "ArrowLeft"), -1, 1) * 0.7;
    turnRate += (wantT - turnRate) * Math.min(1, dt * 5);
    if (speed || Math.abs(turnRate) > 0.005) {
      ex.heading += turnRate * dt;
      const np = ex.pos.add(new B.Vector3(Math.sin(ex.heading), 0, Math.cos(ex.heading)).scale(speed * dt));
      if (!blockedAt(np)) ex.pos.copyFrom(np); else speed = 0;
      moving += Math.abs(speed) / 3.2 + Math.abs(turnRate);
    }
    applyPose(); syncColliders(exParts, false);
    if (eng) eng.o.frequency.value = 38 + Math.min(moving, 2) * 14;

    // バケットの先で削る（何か掴んでいる間は削らない＝運んでいる途中で壁を崩さない）
    if (!held) {
      tip.computeWorldMatrix(true); tipMid.computeWorldMatrix(true);
      carveAt(tip.getAbsolutePosition(), CARVE_R);
      carveAt(tipMid.getAbsolutePosition(), CARVE_R * 0.8);
    }
    // 削った後、少し置いてから「支えのない塊」を落とす（揺れの間）
    if (dirty) { collapseTimer += dt; if (collapseTimer > 0.25) {
      dirty = false; collapseTimer = 0;
      const fl = floatingCells();
      if (fl.length) { const n = collapse(fl); thud(Math.min(0.6, 0.2 + n * 0.01)); }
      rebuildCellMesh();
    } }
    updateGrab();
    updateTruck(dt);

    // カメラ
    fp.rotation.set(look.pitch, look.yaw, 0);
    tp.target.copyFrom(ex.pos.add(new B.Vector3(0, 2.5, 0)));

    // 数字
    const f = engine.getFps(); fpsAvg += (f - fpsAvg) * 0.05; msAvg += (engine.getDeltaTime() - msAvg) * 0.05;
    hudT += dt;
    if (hudT > 0.25) {
      hudT = 0;
      let awake = 0;
      for (const d of debris) { if (!d.ag) continue; d.ag.body.getLinearVelocityToRef(_v); if (_v.lengthSquared() > 0.04) awake++; }
      const pct = Math.round((1 - bld.cells.size / bld.total) * 100), sd = siteDebris();
      const tstate = { wait: "待っている", leave: "出発！", back: "戻ってくる" }[truck.state];
      $("hud").textContent =
        `解体 ${pct}%　がれき ${sd} 個\n` +
        `ダンプ ${Math.min(100, Math.round(truck.amount / TRUCK_CAP * 100))}%（${tstate}）運んだ ${truck.trips} 台\n` +
        `バケット ${held} 個\n` +
        `${api}  ${fpsAvg.toFixed(0)} fps (${msAvg.toFixed(1)} ms)  破片 ${debris.length}（動 ${awake}）\n` +
        `画面 ${engine.getRenderWidth()}×${engine.getRenderHeight()}  影 ${shadowOn ? "あり" : "なし"}`;
      G.stats = { api, fps: fpsAvg, ms: msAvg, debris: debris.length, awake, cells: bld.cells.size, pct, site: sd, load: truck.amount, trips: truck.trips, held, truck: truck.state };
      // さら地: ビルが残っておらず、範囲のがれきが 10 個以下
      if (!siteDone && bld.cells.size === 0 && sd <= 10) { siteDone = true; $("done").style.display = ""; thud(0.5, 900); }
    }
  });

  reset();
  $("msg").style.display = "none";
  engine.resize();   // WebGPU は作った時点で canvas の大きさを拾わないことがある（300×150 のままになった）
  engine.runRenderLoop(() => scene.render());
  addEventListener("resize", () => engine.resize());

  Object.assign(G, { bucketJ, pedal, scene, engine, ex, bld, debris, truck, carveAt, reset, bucketLowest, spawnDebris, setShadow, sticks, bucketOpenUp,
    setView: v => { if (v !== view) $("bView").onclick(); },
    // 確かめ用: 窓が裏だと描画も物理も止まるので、1/60 秒ずつ手で進める。物理は経過時間でなく固定の刻みにする（経過 0 で止まっていた）
    testMode() { G.fixedDt = 1 / 60; plugin._useDeltaForWorldStep = false; scene.getPhysicsEngine().setTimeStep(1 / 60); G.step = n => { for (let i = 0; i < n; i++) scene.render(); }; } });
})().catch(e => { console.error(e); const m = $("msg"); m.style.display = ""; m.textContent = "起動できませんでした: " + e.message; });
