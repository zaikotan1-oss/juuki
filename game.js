// 重機で建てる — 試作1: 一人称ショベルでビルを壊す＋iPad で性能を測る
// 方針（knowhow/html-game/tablet-3d-and-engine-choice.md）:
//  ・重機の腕はキネマティック（角度を直接動かす）。当たりは ANIMATED の箱で破片を押すだけ
//  ・ビルは 1m 格子。バケット先端が触れた格子を消し、地面につながらない塊は破片として落とす
"use strict";
const B = BABYLON;
const Q = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);

const CELL = 1;            // 格子の大きさ(m)
const MAX_DEBRIS = 400;    // 破片の上限。超えたら古い物から消す
const CARVE_R = 0.85;      // バケット先端の削る半径
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
  engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, Q.has("hd") ? 2 : 1));

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
  let shadow = new B.ShadowGenerator(1024, sun);
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
  const bld = { cells: new Map(), mesh: null, origin: new B.Vector3(-4, 0, 14) };
  const cellShape = new B.PhysicsShapeBox(B.Vector3.Zero(), B.Quaternion.Identity(), new B.Vector3(CELL, CELL, CELL), scene);
  cellShape.material = { friction: 0.8, restitution: 0 };
  const key = (x, y, z) => x + "," + y + "," + z;
  const cellMesh = B.MeshBuilder.CreateBox("cellSrc", { size: CELL * 0.999 }, scene);
  cellMesh.material = mat("cellM", 1, 1, 1); cellMesh.receiveShadows = true;
  cellMesh.alwaysSelectAsActiveMesh = true;
  bld.mesh = cellMesh;

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
    const W = 8, D = 6, FLOORS = 3, FH = 3;
    for (let f = 0; f < FLOORS; f++) {
      for (let y = f * FH; y < f * FH + FH; y++) {
        for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
          const edge = x === 0 || z === 0 || x === W - 1 || z === D - 1;
          const slab = y === f * FH + FH - 1;           // 各階の天井
          const pillar = (x === 0 || x === W - 1) && (z === 0 || z === D - 1);
          if (slab) { addCell(x, y, z, "slab"); continue; }
          if (!edge) continue;
          // 窓: 各階の真ん中の段で、柱以外の壁を一部あける
          const win = y === f * FH + 1 && !pillar && ((x + z) % 2 === 1);
          if (win) continue;
          // 1階の正面（z=0）の真ん中は入口
          if (f === 0 && z === 0 && (x === 3 || x === 4) && y < 2) continue;
          addCell(x, y, z, pillar ? "pillar" : "wall");
        }
      }
    }
    bld.total = bld.cells.size;
    rebuildCellMesh();
  }
  const KIND_COL = { wall: [0.82, 0.8, 0.74], slab: [0.6, 0.6, 0.6], pillar: [0.72, 0.7, 0.66] };
  function rebuildCellMesh() {
    const n = bld.cells.size, mats = new Float32Array(n * 16), cols = new Float32Array(n * 4);
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
  const debris = [];
  function spawnDebris(p, size, col, vel) {
    const m = debrisSrc.createInstance("d");
    m.scaling.set(size, size * (0.6 + Math.random() * 0.4), size);
    m.position.copyFrom(p);
    m.rotationQuaternion = B.Quaternion.FromEulerAngles(Math.random() * 0.4, Math.random() * 3, Math.random() * 0.4);
    m.instancedBuffers.color = new B.Color4(col[0], col[1], col[2], 1);
    const ag = new B.PhysicsAggregate(m, B.PhysicsShapeType.BOX, { mass: size * size * size * 40, friction: 0.85, restitution: 0.05 }, scene);
    if (vel) ag.body.setLinearVelocity(vel);
    debris.push({ m, ag, t: performance.now() });
    while (debris.length > MAX_DEBRIS) { const d = debris.shift(); d.ag.dispose(); d.m.dispose(); }
  }
  function clearDebris() { for (const d of debris) { d.ag.dispose(); d.m.dispose(); } debris.length = 0; }
  function cellToDebris(c, kick) {
    const k = KIND_COL[c.kind];
    // 崩れ落ちる塊は 1 格子 1 個（数を抑える）
    if (!kick) { spawnDebris(c.p, 0.92, k, null); removeCell(c); return; }
    // 削った所は 2 つに割る（見た目の崩れ感）
    for (let i = 0; i < 2; i++) {
      const off = new B.Vector3((Math.random() - 0.5) * 0.4, (i - 0.5) * 0.45, (Math.random() - 0.5) * 0.4);
      spawnDebris(c.p.add(off), 0.62, k, kick ? kick.add(new B.Vector3((Math.random() - 0.5), Math.random(), (Math.random() - 0.5))) : null);
    }
    removeCell(c);
  }

  // ================= ショベル（キネマティック） =================
  const ex = { pos: new B.Vector3(0, 0, 0), heading: 0, swing: 0, boom: -0.35, stick: 1.3, bucket: 0.6 };
  const LIM = { boom: [-1.05, 0.55], stick: [0.35, 2.6], bucket: [-0.7, 2.3] };
  const yel = mat("yel", 0.95, 0.72, 0.1), dark = mat("dark", 0.15, 0.15, 0.16), glass = mat("glass", 0.3, 0.45, 0.55);
  glass.alpha = 0.35;
  const root = new B.TransformNode("exRoot", scene);
  const parts = [];                      // 当たりを持つ部品 {mesh, size}
  function box(name, size, parent, pos, m, collide) {
    const b = B.MeshBuilder.CreateBox(name, { width: size[0], height: size[1], depth: size[2] }, scene);
    b.parent = parent; b.position.set(pos[0], pos[1], pos[2]); b.material = m;
    shadow.addShadowCaster(b);
    if (collide) parts.push({ mesh: b, size });
    return b;
  }
  // 足回り（履帯は見た目だけ）
  box("trackL", [0.8, 0.9, 4.2], root, [-1.2, 0.45, 0], dark, false);
  box("trackR", [0.8, 0.9, 4.2], root, [1.2, 0.45, 0], dark, false);
  box("under", [1.8, 0.6, 3.0], root, [0, 0.7, 0], dark, true);
  const upper = new B.TransformNode("upper", scene); upper.parent = root; upper.position.y = 1.0;
  box("house", [2.6, 1.1, 3.2], upper, [0.2, 0.55, -0.5], yel, true);
  box("counter", [2.6, 0.9, 0.8], upper, [0.2, 0.45, -2.3], dark, false);
  // 運転席（左前）。窓は透けるので中から外が見える
  const cab = box("cab", [1.1, 1.6, 1.5], upper, [-0.75, 1.9, 0.35], glass, false);
  cab.isPickable = false;
  box("cabRoof", [1.15, 0.08, 1.55], upper, [-0.75, 2.72, 0.35], yel, false);
  const seat = new B.TransformNode("seat", scene); seat.parent = upper; seat.position.set(-0.75, 2.25, 0.25);
  // 腕: ブーム → アーム → バケット（関節ごとに TransformNode）
  const boomJ = new B.TransformNode("boomJ", scene); boomJ.parent = upper; boomJ.position.set(0.45, 1.3, 0.9);
  const BOOM_L = 5.6, STICK_L = 3.0, BUCKET_L = 1.25;
  box("boom", [0.5, 0.6, BOOM_L], boomJ, [0, 0, BOOM_L / 2], yel, true);
  const stickJ = new B.TransformNode("stickJ", scene); stickJ.parent = boomJ; stickJ.position.z = BOOM_L;
  box("stick", [0.4, 0.45, STICK_L], stickJ, [0, 0, STICK_L / 2], yel, true);
  const bucketJ = new B.TransformNode("bucketJ", scene); bucketJ.parent = stickJ; bucketJ.position.z = STICK_L;
  box("bucketBack", [1.1, 0.12, BUCKET_L], bucketJ, [0, 0.35, BUCKET_L / 2], dark, true);
  box("bucketBottom", [1.1, 0.7, 0.12], bucketJ, [0, 0, BUCKET_L], dark, true);
  const tip = new B.TransformNode("tip", scene); tip.parent = bucketJ; tip.position.set(0, -0.2, BUCKET_L);
  const tipMid = new B.TransformNode("tipMid", scene); tipMid.parent = bucketJ; tipMid.position.set(0, 0.1, BUCKET_L * 0.5);
  // 当たり用の ANIMATED の箱（見た目の部品を毎フレーム追いかける）
  for (const pt of parts) {
    const n = new B.TransformNode("col_" + pt.mesh.name, scene);
    n.rotationQuaternion = B.Quaternion.Identity();
    const body = new B.PhysicsBody(n, B.PhysicsMotionType.ANIMATED, false, scene);
    body.shape = new B.PhysicsShapeBox(B.Vector3.Zero(), B.Quaternion.Identity(), new B.Vector3(...pt.size), scene);
    body.shape.material = { friction: 0.6, restitution: 0 };
    pt.node = n; pt.body = body;
  }
  const _s = new B.Vector3(), _q = new B.Quaternion(), _p = new B.Vector3();
  function syncColliders(teleport) {
    for (const pt of parts) {
      pt.mesh.computeWorldMatrix(true).decompose(_s, _q, _p);
      if (teleport) { pt.node.position.copyFrom(_p); pt.node.rotationQuaternion.copyFrom(_q); pt.body.disablePreStep = false; }
      else { pt.body.disablePreStep = true; pt.body.setTargetTransform(_p, _q); }
    }
  }
  function applyPose() {
    root.position.copyFrom(ex.pos); root.rotation.y = ex.heading;
    upper.rotation.y = ex.swing;
    boomJ.rotation.x = ex.boom; stickJ.rotation.x = ex.stick; bucketJ.rotation.x = ex.bucket;
  }

  // ================= カメラ =================
  const fp = new B.UniversalCamera("fp", B.Vector3.Zero(), scene);
  fp.parent = seat; fp.minZ = 0.05; fp.fov = 1.15; fp.inputs.clear();
  const tp = new B.ArcRotateCamera("tp", -Math.PI / 2, 1.1, 18, B.Vector3.Zero(), scene);
  tp.minZ = 0.1; tp.inputs.clear();
  const look = { yaw: 0, pitch: 0.12 };
  let view = "fp";
  scene.activeCamera = fp;

  // ================= 入力（2本レバー＋画面ドラッグで見回し＋キーボード） =================
  const sticks = { L: { x: 0, y: 0, id: null, el: $("stL") }, R: { x: 0, y: 0, id: null, el: $("stR") } };
  let lookPtr = null;
  let mode = "work";
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

  function setLabels() {
    if (mode === "work") { $("labL").textContent = "←→ 旋回 / ↑↓ アーム"; $("labR").textContent = "↑↓ ブーム / ←→ バケット"; }
    else { $("labL").textContent = "↑↓ 前後 / ←→ 曲がる"; $("labR").textContent = "（走行中は使わない）"; }
    $("bMode").textContent = mode === "work" ? "作業" : "走行"; $("bMode").classList.toggle("on", mode === "drive");
  }
  $("bMode").onclick = () => { mode = mode === "work" ? "drive" : "work"; setLabels(); };
  $("bView").onclick = () => { view = view === "fp" ? "tp" : "fp"; scene.activeCamera = view === "fp" ? fp : tp; $("bView").textContent = view === "fp" ? "運転席" : "外から"; };
  function setShadow(on) {
    shadowOn = on; sun.shadowEnabled = on;
    $("bShadow").textContent = on ? "影 ON" : "影 OFF"; $("bShadow").classList.toggle("on", !on);
  }
  $("bShadow").onclick = () => setShadow(!shadowOn);
  $("bSpawn").onclick = () => {
    const f = root.getDirection(B.Axis.Z);
    const c = ex.pos.add(f.scale(9));
    for (let i = 0; i < 100; i++) spawnDebris(c.add(new B.Vector3((Math.random() - 0.5) * 5, 3 + Math.random() * 8, (Math.random() - 0.5) * 5)), 0.5 + Math.random() * 0.3, [0.6, 0.55, 0.5]);
  };
  $("bReset").onclick = reset;
  shadow.addShadowCaster(cellMesh); shadow.addShadowCaster(debrisSrc);
  setShadow(shadowOn); setLabels();

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
  function thud(v) {
    if (!ac || ac.state !== "running") return;
    const n = ac.createBufferSource(), len = ac.sampleRate * 0.25, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const f = ac.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 500; const g = ac.createGain(); g.gain.value = Math.min(0.6, v);
    n.buffer = buf; n.connect(f).connect(g).connect(ac.destination); n.start();
  }

  // ================= 壊す =================
  let collapseTimer = 0, dirty = false, carvedTotal = 0;
  function carveAt(p, r) {
    let n = 0;
    const lx = Math.floor((p.x - bld.origin.x) / CELL), ly = Math.floor((p.y - bld.origin.y) / CELL), lz = Math.floor((p.z - bld.origin.z) / CELL);
    for (let x = lx - 1; x <= lx + 1; x++) for (let y = ly - 1; y <= ly + 1; y++) for (let z = lz - 1; z <= lz + 1; z++) {
      const c = bld.cells.get(key(x, y, z)); if (!c) continue;
      if (B.Vector3.Distance(c.p, p) > r + CELL * 0.5) continue;
      const kick = c.p.subtract(p).normalize().scale(2.5);
      cellToDebris(c, kick); n++;
      if (n >= 4) break;
    }
    if (n) { dirty = true; carvedTotal += n; thud(0.25 + n * 0.08); }
    return n;
  }

  function reset() {
    clearDebris(); buildBuilding();
    ex.pos.set(0, 0, 0); ex.heading = 0; ex.swing = 0; ex.boom = -0.35; ex.stick = 1.3; ex.bucket = 0.6;
    look.yaw = 0; look.pitch = 0.12;
    applyPose(); syncColliders(true);
  }

  // 重機が格子に入り込まないか（足回りの円と、低い段の格子）
  function blockedAt(p) {
    for (const c of bld.cells.values()) {
      if (c.y > 3) continue;
      if (Math.abs(c.p.x - p.x) < 2.2 && Math.abs(c.p.z - p.z) < 2.2) return true;
    }
    return false;
  }

  // ================= 毎フレーム =================
  let fpsAvg = 60, msAvg = 16, hudT = 0;
  scene.onBeforeRenderObservable.add(() => {
    const dt = G.fixedDt || Math.min(engine.getDeltaTime() / 1000, 0.05);   // 確かめる時は G.fixedDt で固定
    const L = sticks.L, R = sticks.R;
    let moving = 0;
    if (mode === "work") {
      const sw = L.x + kv("KeyD", "KeyA"), st = -L.y + kv("KeyS", "KeyW"), bo = -R.y + kv("KeyK", "KeyI"), bu = R.x + kv("KeyL", "KeyJ");
      ex.swing += sw * 0.85 * dt;
      ex.stick = B.Scalar.Clamp(ex.stick + st * 0.7 * dt, ...LIM.stick);
      ex.boom = B.Scalar.Clamp(ex.boom + bo * 0.45 * dt, ...LIM.boom);
      ex.bucket = B.Scalar.Clamp(ex.bucket + bu * 1.2 * dt, ...LIM.bucket);
      moving = Math.abs(sw) + Math.abs(st) + Math.abs(bo) + Math.abs(bu);
    }
    const fwd = (mode === "drive" ? L.y : 0) + kv("ArrowUp", "ArrowDown"), turn = (mode === "drive" ? L.x : 0) + kv("ArrowRight", "ArrowLeft");
    if (fwd || turn) {
      ex.heading += turn * 0.7 * dt;
      const d = new B.Vector3(Math.sin(ex.heading), 0, Math.cos(ex.heading)).scale(fwd * 3.2 * dt);
      const np = ex.pos.add(d);
      if (!blockedAt(np)) ex.pos.copyFrom(np);
      moving += Math.abs(fwd) + Math.abs(turn);
    }
    applyPose(); syncColliders(false);
    if (eng) eng.o.frequency.value = 38 + Math.min(moving, 2) * 14;

    // バケットの先で削る
    tip.computeWorldMatrix(true); tipMid.computeWorldMatrix(true);
    carveAt(tip.getAbsolutePosition(), CARVE_R);
    carveAt(tipMid.getAbsolutePosition(), CARVE_R * 0.8);
    // 削った後、少し置いてから「支えのない塊」を落とす（揺れの間）
    if (dirty) { collapseTimer += dt; if (collapseTimer > 0.25) {
      dirty = false; collapseTimer = 0;
      const fl = floatingCells();
      if (fl.length) { for (const c of fl) cellToDebris(c, null); thud(Math.min(0.6, 0.2 + fl.length * 0.01)); }
      rebuildCellMesh();
    } }

    // カメラ
    fp.rotation.set(look.pitch, look.yaw, 0);
    tp.target.copyFrom(ex.pos.add(new B.Vector3(0, 2.5, 0)));

    // 数字
    const f = engine.getFps(); fpsAvg += (f - fpsAvg) * 0.05; msAvg += (engine.getDeltaTime() - msAvg) * 0.05;
    hudT += dt;
    if (hudT > 0.25) {
      hudT = 0;
      let awake = 0; const v = new B.Vector3();
      for (const d of debris) { d.ag.body.getLinearVelocityToRef(v); if (v.lengthSquared() > 0.04) awake++; }
      const pct = Math.round((1 - bld.cells.size / bld.total) * 100);
      $("hud").textContent =
        `${api}  ${fpsAvg.toFixed(0)} fps (${msAvg.toFixed(1)} ms)\n` +
        `破片 ${debris.length} 個（動いている ${awake}）\n` +
        `ビル 残り ${bld.cells.size} 格子・解体 ${pct}%\n` +
        `画面 ${engine.getRenderWidth()}×${engine.getRenderHeight()}  影 ${shadowOn ? "あり" : "なし"}`;
      G.stats = { api, fps: fpsAvg, ms: msAvg, debris: debris.length, awake, cells: bld.cells.size, pct };
    }
  });

  reset();
  $("msg").style.display = "none";
  engine.resize();   // WebGPU は作った時点で canvas の大きさを拾わないことがある（300×150 のままになった）
  engine.runRenderLoop(() => scene.render());
  addEventListener("resize", () => engine.resize());

  Object.assign(G, { scene, engine, ex, bld, debris, carveAt, reset, spawnDebris, setShadow, sticks,
    setView: v => { if (v !== view) $("bView").onclick(); }, setMode: m => { if (m !== mode) $("bMode").onclick(); } });
})().catch(e => { console.error(e); const m = $("msg"); m.style.display = ""; m.textContent = "起動できませんでした: " + e.message; });
