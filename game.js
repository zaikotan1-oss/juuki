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
  // 画質: 高（既定）／低（?lo か、iPad で重い時に自動で落とす）。本人「実写に近い見た目に」（2026-10-10）
  // タブレット・スマホ（指で触る機械）は最初から低画質で始める。重すぎて止まって見えた（10-11 iPad で「全然動かない」）
  const TOUCH = (navigator.maxTouchPoints || 0) > 1;
  let HQ = Q.has("hq") || (!Q.has("lo") && !TOUCH);
  scene.clearColor = new B.Color4(0.6, 0.66, 0.72, 1);
  scene.fogMode = B.Scene.FOGMODE_LINEAR; scene.fogStart = 70; scene.fogEnd = 380;
  scene.fogColor = new B.Color3(0.6, 0.58, 0.55);     // 背景写真の地平線あたりの色

  // ---- 物理 ----
  const hk = await HavokPhysics({ locateFile: () => "vendor/HavokPhysics.wasm" });
  const plugin = new B.HavokPlugin(true, hk);
  scene.enablePhysics(new B.Vector3(0, -9.81, 0), plugin);

  // ---- 空と光: Poly Haven の HDRI「construction_yard」（CC0）----
  // 光の当たり方は HDR（256 の小さな立方体で十分）、背景は軽い JPG（HDR を 1024 の立方体にすると iPad のメモリが苦しい）
  const ENV_ROT = Number(Q.get("envrot") || -2.11);   // 写真を回して、太陽がプレイヤーの斜め後ろから当たる向きに
  const env = new B.HDRCubeTexture("assets/hdri/construction_yard_2k.hdr", scene, 256, false, true, false, true);
  env.rotationY = ENV_ROT;
  scene.environmentTexture = env; scene.environmentIntensity = 1.0;
  const dome = new B.PhotoDome("bg", "assets/hdri/construction_yard_bg3.jpg", { resolution: 64, size: 1600 }, scene);
  dome.mesh.rotation.y = ENV_ROT + Number(Q.get("domerot") || 0); dome.material.fogEnabled = false;
  // 太陽: 写真の中の太陽の位置（高さ 34°）に合わせる。方位は写真の向きに合わせて DOME と同じだけ回す
  const SUN_EL = 33.8 * Math.PI / 180, SUN_AZ = Number(Q.get("sunaz") || 3.4);   // 写真の太陽の方位（カメラを向けて合わせた。回す前は 5.75）
  const sunDir = new B.Vector3(-Math.sin(SUN_AZ) * Math.cos(SUN_EL), -Math.sin(SUN_EL), -Math.cos(SUN_AZ) * Math.cos(SUN_EL));
  const sun = new B.DirectionalLight("sun", sunDir, scene);
  sun.intensity = 2.1; sun.diffuse = new B.Color3(1, 0.96, 0.9);
  // 影: 現場（x ±26・z -16〜46）にぴったり合わせた 1 枚の影の地図。
  // CascadedShadowGenerator と SSAO2 は WebGPU で画面が真っ黒／背景が黒く抜けた（2026-10-10 確かめ）ので使わない
  const shadow = new B.ShadowGenerator(HQ ? 4096 : 2048, sun);
  sun.autoUpdateExtends = false; sun.autoCalcShadowZBounds = false;
  sun.orthoLeft = -40; sun.orthoRight = 40; sun.orthoTop = 40; sun.orthoBottom = -40; sun.shadowMinZ = 1; sun.shadowMaxZ = 220;
  sun.position = new B.Vector3(0, 0, 15).subtract(sunDir.scale(110));
  shadow.usePercentageCloserFiltering = true; shadow.filteringQuality = B.ShadowGenerator.QUALITY_HIGH;
  shadow.bias = 0.002; shadow.normalBias = 0.04;   // 小さいと面に木目のような影のしま（シャドウアクネ）が出た shadow.darkness = 0.12;
  let shadowOn = !Q.has("noshadow");

  // ---- 材質（PBR: 光を本物らしく返す）----
  // 色は sRGB で書いて、線形に直して渡す
  const mat = (name, r, g, b, rough = 0.55, metal = 0) => {
    const m = new B.PBRMaterial(name, scene); m.albedoColor = new B.Color3(r, g, b).toLinearSpace(); m.roughness = rough; m.metallic = metal; return m;
  };
  const texCache = {};
  const TEX_V = 5;   // 素材の画像を作り直したら上げる（ブラウザの保存分を使わせない）
  const tex = (file, scale) => { const t = new B.Texture("assets/tex/" + file + "?v=" + TEX_V, scene); t.uScale = t.vScale = scale; t.anisotropicFilteringLevel = 8; return t; };
  // 写真素材（diff=色・nor=凹凸・arm=陰/粗さ/金属）。scale は「1 枚が何回くり返すか」
  function pbrTex(name, base, scale, tint, diffFile) {
    const m = new B.PBRMaterial(name, scene);
    m.albedoTexture = tex(diffFile || base + "_diff.jpg", scale);
    m.bumpTexture = tex(base + "_nor.jpg", scale); m.invertNormalMapY = true;
    m.metallicTexture = tex(base + "_arm.jpg", scale);
    m.useAmbientOcclusionFromMetallicTextureRed = true; m.useRoughnessFromMetallicTextureGreen = true; m.useMetallnessFromMetallicTextureBlue = true;
    m.metallic = 1; m.roughness = 1;
    if (tint) m.albedoColor = new B.Color3(...tint);
    return m;
  }

  // 塗装: 汚れとさびの筋を入れた色の写真（assets/tex/paint_*.jpg は rusty_painted_metal から作った）＋つや
  const PAINT_COL = { "paint_yellow_diff.jpg": [0.93, 0.66, 0.08], "paint_orange_diff.jpg": [0.86, 0.36, 0.08], "paint_red_diff.jpg": [0.72, 0.09, 0.06], "paint_white_diff.jpg": [0.86, 0.86, 0.83], "paint_primer_diff.jpg": [0.66, 0.27, 0.17], "paint_dark_diff.jpg": [0.32, 0.31, 0.29] };
  function paintM(name, file, rough, coat = 0.35) {
    // 汚れの写真を貼ると、引き伸ばされて木目のように見えた（10-10）。色だけ使う
    const col = PAINT_COL[file] || [0.8, 0.8, 0.8];
    const m = new B.PBRMaterial(name, scene); m.albedoColor = new B.Color3(...col).toLinearSpace(); m.metallic = 0; m.roughness = rough;
    if (coat) { m.clearCoat.isEnabled = true; m.clearCoat.intensity = coat; m.clearCoat.roughness = 0.3; }
    return m;
  }
  // まだら模様（白黒）: 地面の重ね塗りの「どこに出すか」に使う。ミップマップ無し（WebGPU で黒くなった）
  function blotchTex(name, n, seed) {
    const t = new B.DynamicTexture(name, { width: 256, height: 256 }, scene, false, B.Texture.BILINEAR_SAMPLINGMODE), c = t.getContext();
    let r = seed; const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
    c.fillStyle = "#000"; c.fillRect(0, 0, 256, 256);
    for (let i = 0; i < n; i++) {
      const x = rnd() * 256, y = rnd() * 256, rad = 8 + rnd() * 26, g = c.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, "rgba(255,255,255,0.8)"); g.addColorStop(1, "rgba(255,255,255,0)"); c.fillStyle = g; c.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    t.update(); t.getAlphaFromRGB = true; t.wrapU = t.wrapV = B.Texture.CLAMP_ADDRESSMODE;
    return t;
  }

  // ---- 地面: 物理用の箱（見えない）＋見た目の円盤（写真素材）＋外側の輪（だんだん透けて、背景写真の地面になじむ）----
  const ground = B.MeshBuilder.CreateBox("ground", { width: 240, height: 1, depth: 240 }, scene);
  ground.position.y = -0.5; ground.isVisible = false;
  new B.PhysicsAggregate(ground, B.PhysicsShapeType.BOX, { mass: 0, friction: 0.9 }, scene);
  const GR = 70, GR2 = 170;
  const groundM = pbrTex("groundM", "gravel_ground_01", GR * 2 / 3.5, [1.05, 1.0, 0.93]);
  const groundVis = B.MeshBuilder.CreateDisc("groundVis", { radius: GR, tessellation: 96 }, scene);
  groundVis.rotation.x = Math.PI / 2; groundVis.material = groundM; groundVis.receiveShadows = true; groundVis.isPickable = false;
  {
    // 外側の輪: 内側は不透明、外へ行くほど透ける。模様は内側と同じ大きさでつながる
    const pos = [], uv = [], col = [], idx = [], N = 96;
    for (let i = 0; i <= N; i++) {
      const a = i / N * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      for (const [r, al] of [[GR - 0.01, 1], [GR + 25, 0.85], [GR2, 0]]) {
        pos.push(c * r, 0.002, sn * r); uv.push((c * r) / (GR * 2) + 0.5, (sn * r) / (GR * 2) + 0.5); col.push(1, 1, 1, al);
      }
    }
    for (let i = 0; i < N; i++) for (let k = 0; k < 2; k++) { const a = i * 3 + k, b = (i + 1) * 3 + k; idx.push(a, b, a + 1, b, b + 1, a + 1); }
    const vd = new B.VertexData(); vd.positions = pos; vd.uvs = uv; vd.colors = col; vd.indices = idx;
    vd.normals = []; B.VertexData.ComputeNormals(pos, idx, vd.normals);
    const ring = new B.Mesh("groundRing", scene); vd.applyToMesh(ring); ring.hasVertexAlpha = true;
    const rm = groundM.clone("groundRingM"); rm.backFaceCulling = false; ring.material = rm; ring.isPickable = false; ring.receiveShadows = true;
  }
  for (const [nm, base, sc, y, n, seed, tint] of [["gDirt", "dry_ground_rocks", GR * 2 / 4.5, 0.004, 26, 7, [1.2, 1.15, 1.08]], ["gMud", "muddy_tracks", GR * 2 / 5, 0.008, 10, 99, [1.3, 1.22, 1.12]]]) {
    const m = pbrTex(nm + "M", base, sc, tint); m.opacityTexture = blotchTex(nm + "T", n, seed); m.zOffset = -1 - y * 200; m.backFaceCulling = false;
    const d = B.MeshBuilder.CreateDisc(nm, { radius: GR * 0.62, tessellation: 64 }, scene); d.rotation.x = Math.PI / 2; d.position.y = y;
    d.material = m; d.receiveShadows = true; d.isPickable = false;
    // 模様の画像は円盤いっぱい、まだらは円盤全体に 1 枚
    m.opacityTexture.uScale = m.opacityTexture.vScale = 1;
    for (const t of [m.albedoTexture, m.bumpTexture, m.metallicTexture]) t.uScale = t.vScale = sc * 0.62;
  }
  // 小石（見た目だけ。物理なし）と、隅の土の山
  {
    const rock = B.MeshBuilder.CreateIcoSphere("rocks", { radius: 0.5, subdivisions: 1, flat: true }, scene);
    rock.material = pbrTex("rockM", "concrete_debris", 0.5, [0.75, 0.68, 0.6]); rock.receiveShadows = true; rock.isPickable = false;
    const ms = []; let r = 12345; const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 420; i++) {
      const x = -22 + rnd() * 44, z = -12 + rnd() * 52; if (x > -7 && x < 7 && z > 11 && z < 23) continue;
      const sz = 0.05 + Math.pow(rnd(), 3) * 0.35;
      ms.push(B.Matrix.Compose(new B.Vector3(sz * (0.8 + rnd() * 0.6), sz * (0.5 + rnd() * 0.4), sz * (0.8 + rnd() * 0.6)), B.Quaternion.RotationYawPitchRoll(rnd() * 6, rnd() * 0.5, rnd() * 0.5), new B.Vector3(x, sz * 0.12, z)));
    }
    const buf = new Float32Array(ms.length * 16); ms.forEach((m, i) => m.copyToArray(buf, i * 16)); rock.thinInstanceSetBuffer("matrix", buf, 16, true);
    const moundM = pbrTex("moundM", "dry_ground_rocks", 3, [0.92, 0.88, 0.84]);
    for (const [x, z, sx, sz, ry] of [[-18, -8, 7, 4, 0.3], [18.5, -6, 5, 6, 1.1], [19, 18, 4, 7, 0.2], [-19.5, 16, 4, 6, -0.4]]) {
      const m = B.MeshBuilder.CreateSphere("mound", { diameter: 1, segments: 12 }, scene); m.scaling.set(sx, 2.2, sz); m.position.set(x, -0.15, z); m.rotation.y = ry;
      m.material = moundM; m.receiveShadows = true; m.isPickable = false; shadow.addShadowCaster(m);
    }
  }

  // ================= ビル（格子） =================
  const BW = 8, BD = 6, FLOORS = 3, FH = 3;      // 建物の大きさ(m)
  const bld = { cells: new Map(), origin: new B.Vector3(-BW / 2, 0, 14) };
  const SITE = { x0: bld.origin.x - 3, x1: bld.origin.x + BW + 3, z0: bld.origin.z - 3, z1: bld.origin.z + BD + 3 };   // さら地にする範囲
  const cellShape = new B.PhysicsShapeBox(B.Vector3.Zero(), B.Quaternion.Identity(), new B.Vector3(CELL, CELL, CELL), scene);
  cellShape.material = { friction: 0.8, restitution: 0 };
  const key = (x, y, z) => x + "," + y + "," + z;
  // 見た目: 見えている面だけを 1 枚のメッシュに組む（模様は世界の座標で貼るので、格子の境目で切れない）
  const cellMesh = new B.Mesh("bld", scene);
  const bldM = pbrTex("bldM", "dirty_concrete", 1, [1.0, 0.97, 0.92], "dirty_concrete_soft_diff.jpg");   // しみの濃さを半分にした写真 bldM.backFaceCulling = false;
  cellMesh.material = bldM; cellMesh.receiveShadows = true;
  // 壊れた断面（元は隣に壁があった面）は別のメッシュ: 荒いコンクリート＋飛び出した鉄筋
  const brokeMesh = new B.Mesh("bldBroken", scene);
  const brokeM = pbrTex("brokeM", "concrete_debris", 1, [0.85, 0.83, 0.8]); brokeM.backFaceCulling = false;
  brokeMesh.material = brokeM; brokeMesh.receiveShadows = true;
  const rebar = B.MeshBuilder.CreateCylinder("rebar", { diameter: 0.022, height: 1, tessellation: 5 }, scene);
  rebar.material = mat("rebarM", 0.3, 0.17, 0.1, 0.75, 0.6); rebar.isPickable = false; rebar.receiveShadows = true;
  // 窓枠（アルミ）
  const frame = B.MeshBuilder.CreateBox("winFrame", { size: 1 }, scene);
  frame.material = mat("frameM", 0.42, 0.43, 0.44, 0.35, 0.85); frame.isPickable = false; frame.receiveShadows = true;
  const _yUp = new B.Vector3(0, 1, 0), _rq = new B.Quaternion();
  function setThin(mesh, list) {
    if (!list.length) { mesh.setEnabled(false); return; }
    const buf = new Float32Array(list.length * 16); list.forEach((m, i) => m.copyToArray(buf, i * 16));
    mesh.thinInstanceSetBuffer("matrix", buf, 16, true); mesh.setEnabled(true);
  }
  const paneMesh = new B.Mesh("panes", scene);
  const paneM = new B.PBRMaterial("paneM", scene); paneM.albedoColor = new B.Color3(0.015, 0.02, 0.025); paneM.metallic = 0; paneM.roughness = 0.03; paneM.alpha = 0.88; paneM.backFaceCulling = false;   // 空が映り込む古いガラス
  paneMesh.material = paneM;
  const winSet = new Set();      // 窓の穴（格子の座標）。上下の壁が残っている間だけガラスを出す

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
    bld.cells.clear(); winSet.clear();
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
          if (r >= 2 && r <= 3 && !pillar && (Math.floor(along / 2) % 2 === 1)) { winSet.add(key(x, y, z) + (z === 0 || z === D - 1 ? ",z" : ",x")); continue; }
          // 1 階の正面（z=0）の真ん中は入口
          if (f === 0 && z === 0 && x >= W / 2 - 3 && x <= W / 2 + 2 && r < 4 && !pillar) continue;
          addCell(x, y, z, pillar ? "pillar" : "wall");
        }
      }
    }
    // 屋上の縁の立ち上がり（パラペット）: 一番上の床の外周に 1 段
    for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) if (x === 0 || z === 0 || x === W - 1 || z === D - 1) addCell(x, FLOORS * H, z, "wall");
    bld.total = bld.cells.size;
    bld.orig = new Set(bld.cells.keys());
    rebuildCellMesh();
  }
  const KIND_COL = { wall: [1, 0.98, 0.94], slab: [0.78, 0.78, 0.78], pillar: [0.9, 0.88, 0.85] };   // 写真素材に掛ける色（壁・床・柱で少し変える）
  const FACE = [
    { n: [1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] }, { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] }, { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0] }];
  const TEXM = 4;     // 写真素材 1 枚が何 m 四方か
  function rebuildCellMesh() {
    const pos = [], nor = [], uv = [], col = [], idx = [], h = CELL / 2;
    const bp = [], bn = [], bu = [], bc = [], bi = [], bars = [];
    for (const c of bld.cells.values()) {
      const k = KIND_COL[c.kind], vary = 0.94 + ((c.x * 7 + c.y * 13 + c.z * 5) % 7) * 0.012;
      for (const f of FACE) {
        const nk = key(c.x + f.n[0], c.y + f.n[1], c.z + f.n[2]);
        if (bld.cells.has(nk)) continue;     // 隣が埋まっている面は見えない
        if (bld.orig && bld.orig.has(nk)) {   // 壊れた断面
          const b2 = bp.length / 3;
          for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            const px = c.p.x + (f.n[0] + f.u[0] * su + f.v[0] * sv) * h, py = c.p.y + (f.n[1] + f.u[1] * su + f.v[1] * sv) * h, pz = c.p.z + (f.n[2] + f.u[2] * su + f.v[2] * sv) * h;
            bp.push(px, py, pz); bn.push(...f.n); bu.push((px * f.u[0] + py * f.u[1] + pz * f.u[2]) / 1.4, (px * f.v[0] + py * f.v[1] + pz * f.v[2]) / 1.4);
            bc.push(k[0] * vary, k[1] * vary, k[2] * vary, 1);
          }
          bi.push(b2, b2 + 1, b2 + 2, b2, b2 + 2, b2 + 3);
          // 鉄筋: 面ごとに 0〜2 本、少し曲がって飛び出す（位置は格子の座標から決まるので毎回同じ）
          const hsh = Math.abs((c.x * 73856093) ^ (c.y * 19349663) ^ (c.z * 83492791) ^ (f.n[0] * 3 + f.n[1] * 5 + f.n[2] * 7)) % 1000;
          const nb = hsh % 3; if (bars.length < 1600)
          for (let j = 0; j < nb; j++) {
            const o1 = ((hsh >> (j * 2)) % 5 - 2) * 0.09, o2 = (((hsh * 7) >> j) % 5 - 2) * 0.09, L = 0.15 + ((hsh * (j + 3)) % 30) / 100;
            const dir = new B.Vector3(f.n[0] + f.u[0] * o2 * 1.5 + f.v[0] * -0.25 * j, f.n[1] + f.u[1] * o2 * 1.5 + f.v[1] * -0.25 * j, f.n[2] + f.u[2] * o2 * 1.5 + f.v[2] * -0.25 * j).normalize();
            const base = new B.Vector3(c.p.x + (f.n[0] * h + (f.u[0] * o1 + f.v[0] * o2)), c.p.y + (f.n[1] * h + (f.u[1] * o1 + f.v[1] * o2)), c.p.z + (f.n[2] * h + (f.u[2] * o1 + f.v[2] * o2)));
            B.Quaternion.FromUnitVectorsToRef(_yUp, dir, _rq);
            bars.push(B.Matrix.Compose(new B.Vector3(1, L, 1), _rq, base.add(dir.scale(L / 2 - 0.03))));
          }
          continue;
        }
        const b = pos.length / 3;
        for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const px = c.p.x + (f.n[0] + f.u[0] * su + f.v[0] * sv) * h, py = c.p.y + (f.n[1] + f.u[1] * su + f.v[1] * sv) * h, pz = c.p.z + (f.n[2] + f.u[2] * su + f.v[2] * sv) * h;
          pos.push(px, py, pz); nor.push(...f.n);
          uv.push((px * f.u[0] + py * f.u[1] + pz * f.u[2]) / TEXM, (px * f.v[0] + py * f.v[1] + pz * f.v[2]) / TEXM);
          // 内側（壊して見えた所・床の裏）は少し暗く
          const inner = f.n[1] < 0 ? 0.7 : 1;
          col.push(k[0] * vary * inner, k[1] * vary * inner, k[2] * vary * inner, 1);
        }
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      }
    }
    const vd = new B.VertexData(); vd.positions = pos; vd.normals = nor; vd.uvs = uv; vd.colors = col; vd.indices = idx;
    // 空の形を渡すと WebGPU の影の描画が止まる（古い数のまま描こうとする）ので、空なら隠すだけ
    if (idx.length) { vd.applyToMesh(cellMesh, false); cellMesh.setEnabled(true); } else cellMesh.setEnabled(false);
    if (bi.length) { const bv = new B.VertexData(); bv.positions = bp; bv.normals = bn; bv.uvs = bu; bv.colors = bc; bv.indices = bi; bv.applyToMesh(brokeMesh, false); brokeMesh.setEnabled(true); } else brokeMesh.setEnabled(false);
    setThin(rebar, bars);
    const frames = [];
    // 窓ガラス: 窓の穴の上と下の壁が残っている時だけ
    const pp = [], pn = [], pi = [];
    for (const w of winSet) {
      const [x, y, z, ax] = w.split(","), X = +x, Y = +y, Z = +z;
      if (!bld.cells.has(key(X, Y - 1, Z)) && !bld.cells.has(key(X, Y + 1, Z))) continue;
      if (!bld.cells.has(key(X, Y + 1, Z)) && !bld.cells.has(key(X, Y + 2, Z)) && !bld.cells.has(key(X, Y - 1, Z))) continue;
      const p = cellWorld(X, Y, Z), b = pp.length / 3;
      const u = ax === "z" ? [h, 0, 0] : [0, 0, h], n = ax === "z" ? [0, 0, 1] : [1, 0, 0];
      // 窓枠: 格子 1 つ（0.5m 四方）の上下左右に細い枠
      const T = 0.05, Dp = 0.12;
      for (const [ox, oy, w, hh] of [[0, h - T / 2, CELL, T], [0, -h + T / 2, CELL, T], [h - T / 2, 0, T, CELL], [-h + T / 2, 0, T, CELL]])
        frames.push(B.Matrix.Compose(ax === "z" ? new B.Vector3(w, hh, Dp) : new B.Vector3(Dp, hh, w), B.Quaternion.Identity(), new B.Vector3(p.x + (ax === "z" ? ox : 0), p.y + oy, p.z + (ax === "z" ? 0 : ox))));
      // 窓の下の水切り（外へ少し出る）
      if (bld.cells.has(key(X, Y - 1, Z)) && !winSet.has(key(X, Y - 1, Z) + "," + ax)) {
        const out = (ax === "z" ? (Z === 0 ? -1 : 1) : (X === 0 ? -1 : 1)) * 0.3;
        frames.push(B.Matrix.Compose(ax === "z" ? new B.Vector3(CELL + 0.02, 0.05, 0.22) : new B.Vector3(0.22, 0.05, CELL + 0.02), B.Quaternion.Identity(), new B.Vector3(p.x + (ax === "x" ? out : 0), p.y - h - 0.02, p.z + (ax === "z" ? out : 0))));
      }
      if ((X * 7 + Y * 3 + Z * 5) % 5 === 0) continue;     // 割れてガラスの無い窓
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { pp.push(p.x + u[0] * su, p.y + sv * h, p.z + u[2] * su); pn.push(...n); }
      pi.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    if (pp.length) { const pv = new B.VertexData(); pv.positions = pp; pv.normals = pn; pv.indices = pi; pv.applyToMesh(paneMesh, false); paneMesh.setEnabled(true); }
    else paneMesh.setEnabled(false);
    setThin(frame, frames);
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
  // がれきの塊: 角ばった不規則な形（正二十面体の頂点をずらす）。当たり判定は箱のまま
  const debrisSrc = B.MeshBuilder.CreateIcoSphere("debrisSrc", { radius: 0.6, subdivisions: 1, flat: true, updatable: true }, scene);
  {
    const ps = debrisSrc.getVerticesData(B.VertexBuffer.PositionKind), off = {}; let r = 777; const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < ps.length; i += 3) {
      const k = ps[i].toFixed(3) + "," + ps[i + 1].toFixed(3) + "," + ps[i + 2].toFixed(3);
      const f = off[k] || (off[k] = 0.72 + rnd() * 0.45);
      ps[i] = Math.max(-0.55, Math.min(0.55, ps[i] * f)); ps[i + 1] = Math.max(-0.55, Math.min(0.55, ps[i + 1] * f)); ps[i + 2] = Math.max(-0.55, Math.min(0.55, ps[i + 2] * f));
    }
    debrisSrc.updateVerticesData(B.VertexBuffer.PositionKind, ps);
    const ns = []; B.VertexData.ComputeNormals(ps, debrisSrc.getIndices(), ns); debrisSrc.updateVerticesData(B.VertexBuffer.NormalKind, ns);
  }
  debrisSrc.material = pbrTex("debrisM", "concrete_debris", 0.35); debrisSrc.isVisible = false;
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
  const yel = paintM("yel", "paint_yellow_diff.jpg", 0.45), dark = mat("dark", 0.09, 0.09, 0.1, 0.8), steel = pbrTex("steel", "metal_plate", 1, [0.55, 0.55, 0.57]);
  const glass = mat("glass", 0.05, 0.06, 0.07, 0.03); glass.alpha = 0.55; glass.environmentIntensity = 1.5; glass.backFaceCulling = true;   // 外からは空が映る色付きガラス。中（裏面）からは見えない                              // 映り込みのあるガラス
  const rubber = mat("rubber", 0.05, 0.05, 0.05, 0.92), chrome = mat("chrome", 0.8, 0.8, 0.82, 0.25, 1);
  const orange = paintM("orange", "paint_orange_diff.jpg", 0.42, 0.5), bedM = pbrTex("bed", "metal_plate", 1.5, [0.75, 0.75, 0.78]);
  function makeBox(name, size, parent, pos, m, list) {
    const b = B.MeshBuilder.CreateBox(name, { width: size[0], height: size[1], depth: size[2] }, scene);
    b.parent = parent; b.position.set(pos[0], pos[1], pos[2]); b.material = m;
    shadow.addShadowCaster(b); b.receiveShadows = true;
    if (list) list.push({ mesh: b, size });
    return b;
  }
  const PRISM_WIND = 1;   // Babylon（左手系）の表の向きに合わせる
  function prism(name, prof, w, parent, x0, m) {
    const pos = [], nor = [], uv = [], idx = [], n = prof.length;
    let cz = 0, cy = 0; for (const [z, y] of prof) { cz += z / n; cy += y / n; }
    for (const [sx, nx] of [[x0, -1], [x0 + w, 1]]) {           // 両側の面（中心からの扇）
      const b = pos.length / 3; pos.push(sx, cy, cz); nor.push(nx, 0, 0); uv.push(cy / 3, cz / 3);
      for (const [z, y] of prof) { pos.push(sx, y, z); nor.push(nx, 0, 0); uv.push(y / 3, z / 3); }   // 汚れの筋が縦（雨だれの向き）になるように
      for (let i = 0; i < n; i++) { const a = b + 1 + i, c = b + 1 + (i + 1) % n; if (nx < 0) idx.push(b, a, c); else idx.push(b, c, a); }
    }
    for (let i = 0; i < n; i++) {                                    // まわりの帯
      const [z1, y1] = prof[i], [z2, y2] = prof[(i + 1) % n], L = Math.hypot(z2 - z1, y2 - y1), nz = (y2 - y1) / L, ny = -(z2 - z1) / L, b = pos.length / 3;
      pos.push(x0, y1, z1, x0 + w, y1, z1, x0 + w, y2, z2, x0, y2, z2);
      for (let k = 0; k < 4; k++) nor.push(0, ny, nz);
      uv.push(0, 0, w / 3, 0, w / 3, L / 3, 0, L / 3);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    // 三角形の巻き方向を、決めた法線にそろえる（両面にすると裏向きの面と重なって黒ずんだ）
    for (let i = 0; i < idx.length; i += 3) {
      const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if ((cx * nor[a] + cy * nor[a + 1] + cz * nor[a + 2]) * PRISM_WIND > 0) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    }
    const vd = new B.VertexData(); vd.positions = pos; vd.normals = nor; vd.uvs = uv; vd.indices = idx;
    const mesh = new B.Mesh(name, scene); vd.applyToMesh(mesh); mesh.parent = parent; mesh.material = m;
    shadow.addShadowCaster(mesh); mesh.receiveShadows = true; mesh.isPickable = false;
    return mesh;
  }
  // a→b を結ぶ角材（親の座標で。X 軸まわりに傾けるだけ）
  function beam(name, a, b, wd, ht, parent, m) {
    const dy = b[1] - a[1], dz = b[2] - a[2], L = Math.hypot(dy, dz);
    const bx = B.MeshBuilder.CreateBox(name, { width: wd, height: ht, depth: L }, scene);
    bx.parent = parent; bx.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2); bx.rotation.x = -Math.atan2(dy, dz);
    bx.material = m; shadow.addShadowCaster(bx); bx.receiveShadows = true; bx.isPickable = false;
    return bx;
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
  // ---- 見た目だけの部品（当たりなし）----
  function cyl(name, d, h, parent, pos, rot, m, tess = 20) {
    const c = B.MeshBuilder.CreateCylinder(name, { diameter: d, height: h, tessellation: tess }, scene);
    c.parent = parent; c.position.set(...pos); if (rot) c.rotation.set(...rot); c.material = m; shadow.addShadowCaster(c); c.receiveShadows = true; c.isPickable = false;
    return c;
  }
  function deco(name, size, parent, pos, m, rot) { const b = makeBox(name, size, parent, pos, m); b.isPickable = false; if (rot) b.rotation.set(...rot); return b; }
  // タイヤ＋ホイール（横向き）。side = +1 右 / -1 左（ホイールの面を外へ）
  function wheel(name, d, w, parent, pos, side) {
    const t = cyl(name, d, w, parent, pos, [0, 0, Math.PI / 2], rubber, 28);
    cyl(name + "R", d * 0.58, w + 0.02, parent, [pos[0] + side * 0.01, pos[1], pos[2]], [0, 0, Math.PI / 2], wheelM, 24);
    cyl(name + "H", d * 0.2, w + 0.06, parent, [pos[0] + side * 0.03, pos[1], pos[2]], [0, 0, Math.PI / 2], chrome, 12);
    return t;
  }
  // 油圧シリンダー: 2 点の間に 太い筒（根元側）と 銀色のロッド（先側）。毎コマ置き直す
  const pistons = [];
  function piston(name, aNode, bNode, d, barrelM) {
    const barrel = B.MeshBuilder.CreateCylinder(name + "B", { diameter: d, height: 1, tessellation: 16 }, scene); barrel.material = barrelM;
    const rod = B.MeshBuilder.CreateCylinder(name + "R", { diameter: d * 0.45, height: 1, tessellation: 12 }, scene); rod.material = chrome;
    for (const m of [barrel, rod]) { shadow.addShadowCaster(m); m.isPickable = false; m.rotationQuaternion = new B.Quaternion(); }
    pistons.push({ aNode, bNode, barrel, rod, len: 0 });
  }
  const _up0 = new B.Vector3(0, 1, 0);
  function updatePistons() {
    for (const p of pistons) {
      const a = p.aNode.getAbsolutePosition().clone(), b = p.bNode.getAbsolutePosition().clone(), d = b.subtract(a), L = d.length();
      if (!p.len) p.len = L * 0.58;                       // 筒の長さは最初の長さで決める
      const dir = d.scale(1 / Math.max(1e-4, L)), bl = Math.min(p.len, L * 0.92);
      B.Quaternion.FromUnitVectorsToRef(_up0, dir, p.barrel.rotationQuaternion); p.rod.rotationQuaternion.copyFrom(p.barrel.rotationQuaternion);
      p.barrel.position.copyFrom(a.add(dir.scale(bl / 2))); p.barrel.scaling.y = bl;
      p.rod.position.copyFrom(a.add(dir.scale(bl)).add(b).scale(0.5)); p.rod.scaling.y = Math.max(0.05, L - bl);
    }
  }
  const anchor = (name, parent, pos) => { const n = new B.TransformNode(name, scene); n.parent = parent; n.position.set(...pos); return n; };
  // 履帯の模様（黒い鉄の板に、横向きの爪＝グローサー）
  const trackTex = new B.DynamicTexture("trackTex", { width: 64, height: 256 }, scene, false, B.Texture.BILINEAR_SAMPLINGMODE);   // ミップマップ有りは WebGPU で黒くなり、にじみ処理で画面中に広がった
  { const c = trackTex.getContext(); c.fillStyle = "#1c1c1c"; c.fillRect(0, 0, 64, 256); for (let y = 0; y < 256; y += 32) { c.fillStyle = "#3a3936"; c.fillRect(0, y, 64, 9); c.fillStyle = "#0a0a0a"; c.fillRect(0, y + 9, 64, 3); } trackTex.update(); }
  const trackM = new B.PBRMaterial("trackM", scene); trackM.albedoTexture = trackTex; trackM.metallic = 0.6; trackM.roughness = 0.75;
  const wheelM = mat("wheelM", 0.55, 0.55, 0.53, 0.45, 0.8), lampM = mat("lampM", 1, 0.95, 0.8, 0.2); lampM.emissiveColor = new B.Color3(0.6, 0.55, 0.4);
  const grilleM = mat("grilleM", 0.06, 0.06, 0.06, 0.6, 0.5);
  const cabFrameM = mat("cabFrameM", 0.17, 0.17, 0.18, 0.45, 0.3);     // 運転席の枠（つやのある濃い灰色）
  const bkM = paintM("bkM", "paint_yellow_diff.jpg", 0.55, 0.15);          // バケットも車体と同じ黄色（爪と刃は鉄）

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
  // 履帯: 上下の板と、前後の丸い端（遊動輪・駆動輪）、下転輪
  for (const sx of [-1.2, 1.2]) {
    const tm = trackM;
    for (const [y, nm] of [[0.86, "T"], [0.04, "B"]]) { const b = deco("track" + nm, [0.75, 0.08, 3.5], root, [sx, y, 0], dark); b.material = tm; }
    for (const z of [1.75, -1.75]) { cyl("trackEnd", 0.9, 0.75, root, [sx, 0.45, z], [0, 0, Math.PI / 2], tm, 24); cyl("idler", 0.62, 0.8, root, [sx, 0.45, z], [0, 0, Math.PI / 2], steel, 20); }
    deco("trackFrame", [0.5, 0.42, 3.3], root, [sx * 0.94, 0.45, 0], yel);
    for (let i = 0; i < 5; i++) cyl("roller", 0.24, 0.6, root, [sx, 0.2, -1.2 + i * 0.6], [0, 0, Math.PI / 2], steel, 14);
  }
  makeBox("under", [1.8, 0.6, 3.0], root, [0, 0.7, 0], dark, exParts);
  const upper = new B.TransformNode("upper", scene); upper.parent = root; upper.position.y = 1.0;
  makeBox("house", [2.6, 1.1, 3.2], upper, [0.2, 0.55, -0.5], yel, exParts).isVisible = false;
  // 横から見た形: 前は低い床（運転席が乗る）、後ろはエンジンの盛り上がり、角は斜めに落とす
  prism("houseShape", [[1.1, 0.05], [1.2, 0.5], [1.1, 1.1], [-0.65, 1.1], [-0.9, 1.38], [-1.85, 1.38], [-2.05, 1.15], [-2.1, 0.05], [-1.9, -0.05], [0.95, -0.05]], 2.6, upper, -1.1, yel);
  // 後ろの丸いカウンターウェイト・エンジンフードと格子・排気管・手すり・旋回の台
  { const cw = cyl("counter", 2.7, 1.0, upper, [0.2, 0.55, -2.0], null, yel, 32); cw.scaling.z = 0.42; }
  for (let i = 0; i < 5; i++) deco("grille", [0.03, 0.12, 0.9], upper, [1.51, 0.55 + i * 0.15, -1.45], grilleM);
  cyl("exhaust", 0.12, 0.6, upper, [1.1, 1.65, -1.6], null, grilleM, 12);
  for (const z of [0.9, -0.5]) cyl("railPost", 0.04, 0.5, upper, [1.4, 1.35, z], null, grilleM, 8);
  cyl("rail", 0.04, 1.4, upper, [1.4, 1.6, 0.2], [Math.PI / 2, 0, 0], grilleM, 8);
  cyl("turntable", 2.2, 0.25, upper, [0, -0.05, 0], null, dark, 32);
  // 運転席の柱・窓枠・ステップ
  for (const [x, z] of [[-1.28, 1.08], [-0.22, 1.08], [-1.28, -0.38], [-0.22, -0.38]]) deco("cabPillar", [0.06, 1.62, 0.06], upper, [x, 1.9, z], cabFrameM);
  deco("cabSill", [1.12, 0.07, 1.52], upper, [-0.75, 1.13, 0.35], dark);
  deco("step", [0.35, 0.05, 0.5], upper, [-1.45, 0.2, 0.7], steel);
  cyl("boomLamp", 0.16, 0.12, upper, [0.45, 1.85, 1.1], [Math.PI / 2, 0, 0], lampM, 12);
  // 運転席（左前）。窓は透けるので中から外が見える
  const cab = makeBox("cab", [1.1, 1.6, 1.5], upper, [-0.75, 1.9, 0.35], glass); cab.isPickable = false;
  makeBox("cabRoof", [1.15, 0.08, 1.55], upper, [-0.75, 2.72, 0.35], yel);
  const seat = new B.TransformNode("seat", scene); seat.parent = upper; seat.position.set(-0.75, 2.25, 0.25);
  // 腕: ブーム → アーム → バケット（関節ごとに TransformNode。どれも X 軸まわりに回すだけ）
  const boomJ = new B.TransformNode("boomJ", scene); boomJ.parent = upper; boomJ.position.set(0.45, 1.3, 0.9);
  const BOOM_L = 5.6, STICK_L = 3.0;
  makeBox("boom", [0.5, 0.6, BOOM_L], boomJ, [0, 0, BOOM_L / 2], yel, exParts).isVisible = false;
  beam("boomA", [0, -0.05, -0.25], [0, 0.72, 2.6], 0.52, 0.66, boomJ, yel);
  beam("boomB", [0, 0.72, 2.45], [0, 0.05, BOOM_L + 0.2], 0.48, 0.56, boomJ, yel);
  cyl("boomKnee", 0.62, 0.52, boomJ, [0, 0.72, 2.55], [0, 0, Math.PI / 2], yel, 20);
  cyl("boomPin", 0.3, 0.7, boomJ, [0, 0, 0], [0, 0, Math.PI / 2], steel, 16);
  const stickJ = new B.TransformNode("stickJ", scene); stickJ.parent = boomJ; stickJ.position.z = BOOM_L;
  makeBox("stick", [0.4, 0.45, STICK_L], stickJ, [0, 0, STICK_L / 2], yel, exParts);
  deco("stickTail", [0.38, 0.5, 0.8], stickJ, [0, 0.2, -0.3], yel);
  cyl("stickPin", 0.26, 0.62, stickJ, [0, 0, 0], [0, 0, Math.PI / 2], steel, 16);
  const bucketJ = new B.TransformNode("bucketJ", scene); bucketJ.parent = stickJ; bucketJ.position.z = STICK_L;
  // バケット: 口は自分の -Y 側。背板(y=0)・先の板(z=L)・左右の板。口を上に向ける＝すくう、下に向ける＝あける
  {
    const { W, H, L } = BUCKET, t = 0.1;
    makeBox("bkBack", [W, t, L], bucketJ, [0, 0, L / 2], bkM, exParts);
    makeBox("bkEnd", [W, H, t], bucketJ, [0, -H / 2, L], bkM, exParts);
    makeBox("bkSideL", [t, H, L], bucketJ, [-W / 2, -H / 2, L / 2], bkM, exParts);
    makeBox("bkSideR", [t, H, L], bucketJ, [W / 2, -H / 2, L / 2], bkM, exParts);
    for (let i = 0; i < 5; i++) makeBox("tooth" + i, [0.14, 0.13, 0.32], bucketJ, [-W / 2 + 0.2 + i * (W - 0.4) / 4, -H + 0.06, L + 0.14], steel);
    deco("bkLip", [W + 0.02, 0.06, 0.16], bucketJ, [0, -H + 0.03, L], steel);
    for (const sx of [-1, 1]) deco("bkCutter", [0.04, H * 0.8, 0.3], bucketJ, [sx * (W / 2 + 0.03), -H * 0.55, L - 0.1], steel);
    deco("bkRib", [W * 0.9, 0.05, 0.06], bucketJ, [0, 0.07, L * 0.5], steel);
  }
  const tip = new B.TransformNode("tip", scene); tip.parent = bucketJ; tip.position.set(0, -BUCKET.H, BUCKET.L);
  const tipMid = new B.TransformNode("tipMid", scene); tipMid.parent = bucketJ; tipMid.position.set(0, -BUCKET.H * 0.5, BUCKET.L * 0.6);
  makeColliders(exParts);
  cyl("bucketPin", 0.24, BUCKET.W - 0.1, bucketJ, [0, 0, 0], [0, 0, Math.PI / 2], steel, 16);
  // 油圧シリンダー: ブーム 2 本・アーム 1 本・バケット 1 本
  for (const sx of [-0.33, 0.33]) piston("boomCyl", anchor("bA", upper, [0.45 + sx, 0.55, 0.6]), anchor("bB", boomJ, [sx, 0.3, 2.2]), 0.2, yel);
  piston("armCyl", anchor("aA", boomJ, [0, 1.05, 2.5]), anchor("aB", stickJ, [0, 0.45, -0.6]), 0.2, yel);
  piston("bkCyl", anchor("kA", stickJ, [0, 0.32, 0.5]), anchor("kB", bucketJ, [0, 0.3, 0.2]), 0.17, yel);
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
    for (const n of [root, upper, boomJ, stickJ, bucketJ]) n.computeWorldMatrix(true);
    updatePistons();
  }

  // ================= ダンプ =================
  // 前（運転台）は -Z を向いて止まる。荷台は建物側。いっぱいになったら -Z へ走り去り、空のダンプがバックで戻る
  const TRUCK_HOME = new B.Vector3(-6.8, 0, 4.5);   // ビルを掘る位置（z≈6）から左へ 90° 旋回した所に荷台が来る
  const truck = { root: new B.TransformNode("truck", scene), parts: [], state: "wait", z: TRUCK_HOME.z, v: 0, load: [], amount: 0, trips: 0 };
  truck.root.rotation.y = Math.PI;
  {
    const r = truck.root, P = truck.parts;
    makeBox("tChassis", [2.3, 0.6, 7.2], r, [0, 0.95, -0.6], dark, P);
    makeBox("tCab", [2.4, 1.9, 1.8], r, [0, 2.1, 2.1], orange, P).isVisible = false;
    prism("tCabShape", [[3.0, 1.15], [3.0, 2.88], [2.85, 3.06], [1.3, 3.06], [1.2, 2.9], [1.2, 1.15]], 2.4, r, -1.2, orange);
    // 窓のゴム枠（周りだけ。板にすると窓が真っ黒に見えた）
    for (const [w, hh, x, y] of [[2.3, 0.06, 0, 2.95], [2.3, 0.06, 0, 2.15], [0.06, 0.86, -1.15, 2.55], [0.06, 0.86, 1.15, 2.55], [0.05, 0.8, 0, 2.55]]) deco("tGlassFrame", [w, hh, 0.04], r, [x, y, 3.02], dark);
    const cabIn = mat("cabIn", 0.12, 0.12, 0.12, 0.8);
    deco("tCabBack", [2.3, 1.7, 0.05], r, [0, 2.1, 1.28], cabIn); deco("tCabFloor", [2.3, 0.05, 1.7], r, [0, 1.2, 2.1], cabIn);
    deco("tDash", [2.2, 0.32, 0.35], r, [0, 2.05, 2.8], dark);
    for (const sx of [-0.55, 0.55]) { deco("tSeat", [0.55, 0.5, 0.5], r, [sx, 1.65, 1.7], dark); deco("tSeatBack", [0.55, 0.7, 0.12], r, [sx, 2.15, 1.45], dark); }
    { const sw = B.MeshBuilder.CreateTorus("tWheelSteer", { diameter: 0.45, thickness: 0.04, tessellation: 20 }, scene); sw.parent = r; sw.position.set(0.55, 2.3, 2.55); sw.rotation.x = 1.1; sw.material = dark; sw.isPickable = false; }
    for (const sx of [-1, 1]) {
      deco("tDoorSeam", [0.02, 1.35, 0.025], r, [sx * 1.205, 2.05, 1.45], dark); deco("tDoorSeam", [0.02, 1.35, 0.025], r, [sx * 1.205, 2.05, 2.75], dark);
      deco("tHandle", [0.03, 0.05, 0.22], r, [sx * 1.215, 2.2, 1.65], chrome);
      deco("tStep", [0.32, 0.06, 0.55], r, [sx * 1.3, 0.95, 2.2], bedM); deco("tStep", [0.32, 0.06, 0.55], r, [sx * 1.3, 1.45, 2.2], bedM);
      deco("tFender", [0.55, 0.06, 1.35], r, [sx * 1.15, 1.17, 2.0], dark);
      deco("tFender", [0.55, 0.06, 3.1], r, [sx * 1.15, 1.17, -1.8], dark);
      deco("tBedRail", [0.16, 0.1, 4.45], r, [sx * 1.22, 2.53, -1.6], bedM);
    }
    // ダンプの運転台は中まで詰まった形なので、窓は透けない濃いガラス（空が映る）にする
    const tGlassM = mat("tGlassM", 0.025, 0.03, 0.035, 0.04); tGlassM.environmentIntensity = 1.6;
    deco("tGlass", [2.2, 0.75, 0.05], r, [0, 2.55, 3.01], tGlassM);
    for (const sx of [-1.21, 1.21]) deco("tSideGlass", [0.04, 0.7, 1.0], r, [sx, 2.55, 2.35], tGlassM);
    deco("tGrille", [1.6, 0.6, 0.05], r, [0, 1.55, 3.02], grilleM);
    deco("tBumper", [2.5, 0.3, 0.3], r, [0, 1.0, 3.1], dark);
    for (const sx of [-0.95, 0.95]) { deco("tLamp", [0.35, 0.18, 0.05], r, [sx, 1.35, 3.04], lampM); deco("tMirrorArm", [0.4, 0.04, 0.04], r, [sx * 1.4, 2.6, 2.9], dark); deco("tMirror", [0.06, 0.4, 0.22], r, [sx * 1.55, 2.5, 2.9], dark); }
    for (const sx of [-1.27, 1.27]) for (let i = 0; i < 4; i++) deco("tRib", [0.06, 1.1, 0.12], r, [sx, 1.95, 0.2 - i * 1.25], bedM);
    deco("tBedTop", [2.5, 0.08, 0.15], r, [0, 2.52, -3.8], bedM);
    cyl("tTank", 0.6, 1.2, r, [-1.05, 0.9, 0.6], [Math.PI / 2, 0, 0], chrome, 18);
    makeBox("tFloor", [2.4, 0.15, 4.4], r, [0, 1.35, -1.6], bedM, P);
    makeBox("tWallL", [0.12, 1.1, 4.4], r, [-1.2, 1.95, -1.6], orange, P);
    makeBox("tWallR", [0.12, 1.1, 4.4], r, [1.2, 1.95, -1.6], orange, P);
    makeBox("tWallF", [2.4, 1.5, 0.12], r, [0, 2.15, 0.6], orange, P);
    makeBox("tWallB", [2.4, 1.1, 0.12], r, [0, 1.95, -3.8], orange, P);
    for (const z of [2.0, -1.0, -2.6]) for (const x of [-1.15, 1.15]) wheel("tWheel", 1.1, 0.45, r, [x, 0.55, z], Math.sign(x));
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
  $("bReset").onclick = () => { if (mode === "build") location.reload(); else reset(); };
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

  // ================= ラフタークレーン（建築モード） =================
  // 本人の選択（2026-10-08）: 鉄骨のビル・光る枠に吸い付く・ラフタークレーン・さら地のボタンで移る
  // 2026-10-10 本人「ロープとフックが見えない・操作感が良くない、直感でできるレベルに」→
  //   関節を個別に動かす方式をやめ、「フックを直接動かす」方式にした（旋回・起伏・伸縮・巻き上げは自動で計算）。
  //   左レバー = フックを前後左右、右レバー = 上げ下げ。カメラはフックを自動で追う。吊り荷の真下に落ちる場所の目印。
  //   根拠: 産業クレーンの操作研究（関節を考えさせるのが分かりにくさの原因→荷の動かしたい方向を指定して逆算）
  // 吊り荷は物理なし（フックの下にぶら下げるだけ）。フックは振り子で少しだけ揺れる
  const cr = { pos: new B.Vector3(0, 0, 3), heading: 0, swing: 0, luff: 0.8, ext: 4, wire: 6, sway: new B.Vector2(0, 0), swayV: new B.Vector2(0, 0),
    tgt: new B.Vector3(-7.5, 7, 5.5) };   // tgt = フックをここへ持っていきたい（本人が動かすのはこれ）
  const CLIM = { luff: [0.12, 1.4], ext: [0, 34], wire: [1.2, 50] };
  const crRoot = new B.TransformNode("crane", scene);
  const crRed = paintM("crRed", "paint_red_diff.jpg", 0.38, 0.6), white = paintM("white", "paint_white_diff.jpg", 0.4, 0.6);
  const crRoofGlass = mat("crRoofGlass", 0.2, 0.25, 0.28, 0.05); crRoofGlass.alpha = 0.12;   // 屋根は上を見て吊るので薄く
  const crGlass = mat("crGlass", 0.06, 0.08, 0.09, 0.03); crGlass.alpha = 0.5; crGlass.backFaceCulling = true;   // 運転席のガラスは薄く（色が濃いとフックが暗く沈んだ）
  makeBox("crBody", [2.6, 1.1, 9], crRoot, [0, 1.35, 0], white).isVisible = false;
  prism("crBodyShape", [[4.5, 0.82], [4.62, 1.5], [4.25, 1.9], [-4.25, 1.9], [-4.62, 1.5], [-4.5, 0.82]], 2.6, crRoot, -1.3, white);
  for (const sx of [-1, 1]) for (const z of [2.4, -2.4]) deco("crFender", [0.42, 0.07, 3.0], crRoot, [sx * 1.42, 1.48, z], dark);
  for (const sx of [-1, 1]) {
    deco("crDeck", [0.25, 0.05, 6.5], crRoot, [sx * 1.42, 1.92, 0], steel);
    for (const z of [-0.6, 0.6]) { deco("crBox", [0.12, 0.55, 1.0], crRoot, [sx * 1.33, 1.2, z], mat("crBoxM", 0.25, 0.26, 0.27, 0.5, 0.4)); deco("crBoxLatch", [0.03, 0.06, 0.12], crRoot, [sx * 1.4, 1.38, z], chrome); }
    deco("crSkirt", [0.04, 0.3, 8.6], crRoot, [sx * 1.31, 0.92, 0], dark);
    for (const z of [3.9, -3.9]) deco("crStep", [0.3, 0.05, 0.4], crRoot, [sx * 1.42, 0.75, z * 0.83], steel);
  }
  makeBox("crStripe", [2.62, 0.25, 9.02], crRoot, [0, 1.2, 0], crRed);
  for (const z of [3.2, 1.6, -1.6, -3.2]) for (const x of [-1.25, 1.25]) wheel("crWheel", 1.4, 0.6, crRoot, [x, 0.7, z], Math.sign(x));
  // アウトリガー（張り出した脚）: 横へ伸びた梁＋縦の脚＋地面の板
  for (const z of [3.9, -3.9]) for (const sx of [-1, 1]) {
    deco("crOutBeam", [2.2, 0.45, 0.5], crRoot, [sx * 2.2, 1.1, z], white);
    deco("crJack", [0.4, 1.05, 0.4], crRoot, [sx * 3.2, 0.6, z], crRed);
    cyl("crJackRod", 0.22, 0.4, crRoot, [sx * 3.2, 0.2, z], null, chrome, 12);
    cyl("crPad", 0.8, 0.08, crRoot, [sx * 3.2, 0.04, z], null, dark, 20);
  }
  deco("crBumper", [2.7, 0.35, 0.3], crRoot, [0, 1.0, 4.6], dark);
  for (const sx of [-0.95, 0.95]) deco("crLamp", [0.3, 0.16, 0.05], crRoot, [sx, 1.45, 4.52], lampM);
  const crUpper = new B.TransformNode("crUpper", scene); crUpper.parent = crRoot; crUpper.position.y = 1.9;
  makeBox("crTurn", [2.4, 0.9, 4.2], crUpper, [0.35, 0.45, -1.0], crRed).isVisible = false;
  prism("crTurnShape", [[1.1, 0.02], [1.1, 0.62], [0.8, 0.9], [-2.7, 0.9], [-3.1, 0.55], [-3.1, 0.02]], 2.4, crUpper, -0.85, crRed);
  makeBox("crWeight", [2.4, 1.0, 1.0], crUpper, [0.35, 0.5, -3.4], dark);
  makeBox("crCab", [1.1, 1.5, 1.7], crUpper, [-0.95, 0.75, 1.2], crGlass).isPickable = false;
  makeBox("crCabRoof", [1.15, 0.05, 1.75], crUpper, [-0.95, 1.52, 1.2], crRoofGlass).isVisible = false;   // 上を見て吊るので屋根は無し（縁の線が空に見えた）
  for (const [x, z] of [[-1.48, 2.03], [-0.42, 2.03], [-1.48, 0.37], [-0.42, 0.37]]) deco("crPillar", [0.05, 1.5, 0.05], crUpper, [x, 0.75, z], cabFrameM);
  deco("crCabBase", [1.12, 0.08, 1.72], crUpper, [-0.95, 0.02, 1.2], white);   // 屋根もガラス（上を見て吊るので）
  const crSeat = new B.TransformNode("crSeat", scene); crSeat.parent = crUpper; crSeat.position.set(-0.95, 1.15, 1.1);
  const crBoomJ = new B.TransformNode("crBoomJ", scene); crBoomJ.parent = crUpper; crBoomJ.position.set(0.45, 1.2, -2.4);
  const BOOM0 = 11, PIV = { x: 0.45, y: 1.9 + 1.2, z: -2.4 };   // 一番縮めた時のブームの長さ／ブームの根元（クレーンの中の座標）
  makeBox("crBoom1", [0.9, 0.9, BOOM0], crBoomJ, [0, 0, BOOM0 / 2], crRed).isVisible = false;
  const crBoom2 = makeBox("crBoom2", [0.62, 0.62, 1], crBoomJ, [0, 0, 0], white); crBoom2.isVisible = false;
  // 見た目のブーム: 太い順に 4 段の六角形の筒。伸ばした分を内側の 3 段で等分して出す。筒の口には濃い色の帯
  const SEC = [{ d: 0.98, L: BOOM0, m: crRed }, { d: 0.82, L: 9.2, m: white }, { d: 0.68, L: 9.2, m: white }, { d: 0.55, L: 9.2, m: white }].map((c, i) => {
    const t = B.MeshBuilder.CreateCylinder("crSec" + i, { diameter: c.d, height: c.L, tessellation: 6 }, scene);
    t.parent = crBoomJ; t.rotation.x = Math.PI / 2; t.rotation.y = Math.PI / 6; t.scaling.x = 0.82; t.material = c.m;
    shadow.addShadowCaster(t); t.receiveShadows = true; t.isPickable = false;
    const col = B.MeshBuilder.CreateCylinder("crCollar" + i, { diameter: c.d + 0.06, height: 0.22, tessellation: 6 }, scene);
    col.parent = crBoomJ; col.rotation.x = Math.PI / 2; col.rotation.y = Math.PI / 6; col.scaling.x = 0.82; col.material = i ? dark : crRed; col.isPickable = false; shadow.addShadowCaster(col);
    return { ...c, t, col };
  });
  function placeBoomSecs(ext) {
    SEC.forEach((c, i) => { const a = i ? 0.6 * i + ext * i / 3 : 0; c.t.position.z = a + c.L / 2; c.col.position.z = a + c.L - 0.11; });
  }
  // 起伏シリンダー: 旋回台からブームの腹へ
  piston("crLuff", anchor("lA", crUpper, [0.45, 0.35, 0.2]), anchor("lB", crBoomJ, [0, -0.5, 4.2]), 0.42, white);
  const crLuff = pistons[pistons.length - 1];
  const crTip = new B.TransformNode("crTip", scene); crTip.parent = crBoomJ;
  makeBox("crSheave", [0.46, 0.8, 0.9], crTip, [0, -0.15, -0.15], white);
  for (const sx of [-0.25, 0.25]) cyl("crPulley", 0.75, 0.06, crTip, [sx, -0.25, 0.1], [0, 0, Math.PI / 2], dark, 20);
  // ロープ（太め・2 本）とフック（黄色いブロック＋鉤）。前は細い 1 本と小さな箱で、ほぼ見えなかった
  const ropeM = mat("ropeM", 0.1, 0.1, 0.11, 0.5, 0.8);
  const wireM = B.MeshBuilder.CreateCylinder("wire", { diameter: 0.11, height: 1, tessellation: 8 }, scene); wireM.material = ropeM;
  const wireM2 = B.MeshBuilder.CreateCylinder("wire2", { diameter: 0.11, height: 1, tessellation: 8 }, scene); wireM2.material = ropeM;
  const hookM = mat("hookM", 1, 0.75, 0.05, 0.4); hookM.emissiveColor = new B.Color3(0.25, 0.17, 0);
  const hook = new B.TransformNode("hook", scene);
  const hookBlock = B.MeshBuilder.CreateBox("hookBlock", { width: 0.75, height: 0.9, depth: 0.5 }, scene); hookBlock.parent = hook; hookBlock.material = hookM; shadow.addShadowCaster(hookBlock);
  const hookStripe = B.MeshBuilder.CreateBox("hookStripe", { width: 0.77, height: 0.18, depth: 0.52 }, scene); hookStripe.parent = hook; hookStripe.position.y = 0.1; hookStripe.material = dark;
  const hookCurve = B.MeshBuilder.CreateTorus("hookCurve", { diameter: 0.5, thickness: 0.12, tessellation: 20 }, scene);
  hookCurve.parent = hook; hookCurve.rotation.x = Math.PI / 2; hookCurve.position.y = -0.75; hookCurve.material = steel; shadow.addShadowCaster(hookCurve);
  // 落ちる場所の目印（吊り荷・フックの真下）と、真下へ伸びる細い線
  const markM = new B.StandardMaterial("markM", scene); markM.diffuseColor = new B.Color3(1, 0.55, 0.1); markM.emissiveColor = new B.Color3(0.6, 0.3, 0); markM.alpha = 0.6;
  const mark = B.MeshBuilder.CreateDisc("mark", { radius: 0.9, tessellation: 32 }, scene); mark.rotation.x = Math.PI / 2; mark.material = markM; mark.isPickable = false;
  const markLine = B.MeshBuilder.CreateCylinder("markLine", { diameter: 0.05, height: 1, tessellation: 6 }, scene); markLine.material = markM; markLine.isPickable = false;
  const crAll = [crRoot, wireM, wireM2, hook, mark, markLine, crLuff.barrel, crLuff.rod];
  for (const n of crAll) n.setEnabled(false);

  // 建てる物: 1 階 = 柱 4 → 梁 4 → 床板 1。建物の位置は解体したビルと同じ（x -4〜4, z 14〜20）
  const FLOOR_H = 3.6, SC = { x: 0, z: 17 };
  const steelM = paintM("steelM", "paint_primer_diff.jpg", 0.6, 0), slabM = pbrTex("slabM", "concrete_floor_02", 2.5);   // さび止め塗装の鉄骨・コンクリートの床板
  const ghostM = new B.StandardMaterial("ghostM", scene); ghostM.diffuseColor = new B.Color3(0.2, 0.9, 1); ghostM.emissiveColor = new B.Color3(0.1, 0.6, 0.8); ghostM.alpha = 0.35;
  const ghostOk = new B.StandardMaterial("ghostOk", scene); ghostOk.diffuseColor = new B.Color3(0.3, 1, 0.3); ghostOk.emissiveColor = new B.Color3(0.15, 0.8, 0.15); ghostOk.alpha = 0.6;
  function planFloor(f) {
    const y0 = f * FLOOR_H, L = [];
    for (const x of [-3.8, 3.8]) for (const z of [14.2, 19.8]) L.push({ kind: "柱", size: [0.35, FLOOR_H, 0.35], pos: new B.Vector3(x, y0 + FLOOR_H / 2, z), m: steelM });
    for (const z of [14.2, 19.8]) L.push({ kind: "梁", size: [7.3, 0.4, 0.3], pos: new B.Vector3(0, y0 + FLOOR_H - 0.2, z), m: steelM });
    for (const x of [-3.8, 3.8]) L.push({ kind: "梁", size: [0.3, 0.4, 5.3], pos: new B.Vector3(x, y0 + FLOOR_H - 0.2, SC.z), m: steelM });
    L.push({ kind: "床板", size: [8.2, 0.22, 6.2], pos: new B.Vector3(SC.x, y0 + FLOOR_H + 0.11, SC.z), m: slabM });
    return L;
  }
  const YARD = new B.Vector3(-7.5, 0, 5.5);               // 建材の置き場（クレーンの左前）
  const SNAP = { xz: 2.0, y: 1.8 };                       // 枠のこの範囲に入るとピタッとはまる
  const bd = { floor: 0, step: 0, plan: planFloor(0), placed: [], score: 0, hanging: null, yard: null, snap: null, ghost: null, toastT: 0, near: false };
  // 柱と梁は H 形（フランジ 2 枚＋ウェブ 1 枚）。床板はただの板
  function hBeam(name, size) {
    const ax = size.indexOf(Math.max(...size)), L = size[ax], o = [0, 1, 2].filter(i => i !== ax), W = size[o[0]], Hh = size[o[1]], t = 0.035;
    const part = (a, b, off) => { const d = [0, 0, 0]; d[ax] = L; d[o[0]] = a; d[o[1]] = b; const m = B.MeshBuilder.CreateBox(name, { width: d[0], height: d[1], depth: d[2] }, scene); m.position.set(0, 0, 0); if (off) m.position[["x", "y", "z"][o[1]]] = off; return m; };
    return B.Mesh.MergeMeshes([part(W, t, Hh / 2 - t / 2), part(W, t, -(Hh / 2 - t / 2)), part(t, Hh - 2 * t, 0)], true);
  }
  function pieceMesh(p, name) {
    const m = p.kind === "床板" ? B.MeshBuilder.CreateBox(name, { width: p.size[0], height: p.size[1], depth: p.size[2] }, scene) : hBeam(name, p.size);
    m.material = p.m; shadow.addShadowCaster(m); m.receiveShadows = true; m.rotationQuaternion = B.Quaternion.Identity();
    return m;
  }
  function nextPiece() {
    const p = bd.plan[bd.step];
    if (bd.ghost) bd.ghost.dispose();
    // 枠は細い梁でも目立つよう、細い向きは 0.7m まで太らせる（評価役 3 人とも「緑の細線だけで目立たない」）
    bd.ghost = B.MeshBuilder.CreateBox("ghost", { width: Math.max(0.7, p.size[0] + 0.1), height: Math.max(0.7, p.size[1] + 0.1), depth: Math.max(0.7, p.size[2] + 0.1) }, scene);
    bd.ghost.material = ghostM; bd.ghost.position.copyFrom(p.pos); bd.ghost.isPickable = false;
    // 置き場に寝かせて出す（柱は横倒し）
    const m = pieceMesh(p, "piece");
    if (p.kind === "柱") { m.rotationQuaternion = B.Quaternion.RotationAxis(B.Axis.Z, Math.PI / 2); m.position.set(YARD.x, p.size[0] / 2 + 0.15, YARD.z); }
    else m.position.set(YARD.x, p.size[1] / 2 + 0.15, YARD.z);
    bd.yard = { p, m };
  }
  function toast(t) { const el = $("toast"); el.textContent = t; el.style.display = ""; bd.toastT = 2.5; }
  function applyCranePose() {
    crRoot.position.copyFrom(cr.pos); crRoot.rotation.y = cr.heading;
    crUpper.rotation.y = cr.swing; crBoomJ.rotation.x = -cr.luff;
    const L = BOOM0 + cr.ext;
    crBoom2.scaling.z = Math.max(0.5, L - BOOM0 + 1); crBoom2.position.z = (BOOM0 - 1 + L) / 2;
    crTip.position.z = L;
    placeBoomSecs(cr.ext);
    for (const n of [crRoot, crUpper, crBoomJ]) n.computeWorldMatrix(true);
    updatePistons();
  }
  // 逆算: フックを tgt に持っていくための 旋回・起伏・伸縮・ロープの長さ
  function solveCrane(t, hang) {
    const dx = t.x - cr.pos.x, dz = t.z - cr.pos.z, dist = Math.max(0.6, Math.hypot(dx, dz));
    const swing = Math.atan2(dx, dz) - Math.asin(Math.min(1, PIV.x / dist));
    const a = Math.sqrt(Math.max(0.01, dist * dist - PIV.x * PIV.x)) - PIV.z;     // ブームの根元から水平にどれだけ先か
    // ブームの先の高さ: フックより 3m 以上上、建っている所より 4m 以上上
    const top = bd.floor * FLOOR_H + 1;
    let b = Math.max(t.y + 3 + hang, top + 4) - PIV.y;
    let L = Math.hypot(a, b);
    if (L < BOOM0) { L = BOOM0; b = Math.sqrt(Math.max(0, L * L - a * a)); }
    L = Math.min(L, BOOM0 + CLIM.ext[1]);
    const luff = B.Scalar.Clamp(Math.atan2(b, a), ...CLIM.luff);
    const tipY = PIV.y + L * Math.sin(luff);
    return { swing, luff, ext: L - BOOM0, wire: B.Scalar.Clamp(tipY - t.y, ...CLIM.wire) };
  }
  const approach = (v, to, rate) => v + B.Scalar.Clamp(to - v, -rate, rate);
  const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
  const _tip = new B.Vector3(), _tipPrev = new B.Vector3(), _tipVel = new B.Vector3(), _tipVelPrev = new B.Vector3(), _up = new B.Vector3(0, 1, 0);
  let tipInit = false, lookIdle = 0;
  function hookPos() {
    const s2 = cr.sway.x * cr.sway.x + cr.sway.y * cr.sway.y;
    return new B.Vector3(_tip.x + cr.sway.x, _tip.y - Math.sqrt(Math.max(0.01, cr.wire * cr.wire - s2)), _tip.z + cr.sway.y);
  }
  function setRope(m, a, b) {
    const dir = b.subtract(a), len = dir.length();
    m.position.copyFrom(a.add(b).scaleInPlace(0.5)); m.scaling.y = Math.max(0.01, len);
    m.rotationQuaternion = m.rotationQuaternion || new B.Quaternion();
    B.Quaternion.FromUnitVectorsToRef(_up, dir.scale(-1 / Math.max(0.01, len)), m.rotationQuaternion);
  }
  function updateBuild(dt) {
    const L = sticks.L, R = sticks.R;
    // 左レバー: フックを 前後（遠く・近く）／左右。右レバー: 上げ下げ
    const fwd = L.y + kv("KeyW", "KeyS"), side = L.x + kv("KeyD", "KeyA"), lift = R.y + kv("KeyI", "KeyK");
    const t = cr.tgt, hang = bd.hanging ? bd.hanging.p.size[1] + 0.75 : 0, t0 = t.clone();
    const dx = t.x - cr.pos.x, dz = t.z - cr.pos.z, r = Math.max(3, Math.hypot(dx, dz));
    let ang = Math.atan2(dx, dz);
    const nr = B.Scalar.Clamp(r + fwd * 5 * dt, 5, 38);
    ang += side * 5 * dt / nr;                          // 左右は「横に 5m/秒」になるように角度で動かす
    t.x = cr.pos.x + Math.sin(ang) * nr; t.z = cr.pos.z + Math.cos(ang) * nr;
    t.y = B.Scalar.Clamp(t.y + lift * 4 * dt, 0.9 + hang, 45);
    const tgtSpeed = B.Vector3.Distance(t, t0) / dt;      // 本人がフックを動かしている速さ
    // 関節は逆算した値へ、重機らしい速さで追いかける
    const s = solveCrane(t, hang);
    cr.swing = cr.swing + B.Scalar.Clamp(angDiff(cr.swing, s.swing), -0.9 * dt, 0.9 * dt);
    cr.luff = approach(cr.luff, s.luff, 0.6 * dt);
    cr.ext = approach(cr.ext, s.ext, 8 * dt);
    applyCranePose();
    for (const n of [crRoot, crUpper, crBoomJ]) n.computeWorldMatrix(true);
    _tip.copyFrom(crTip.computeWorldMatrix(true).getTranslation());
    cr.wire = approach(cr.wire, B.Scalar.Clamp(_tip.y - t.y, ...CLIM.wire), 7 * dt);
    if (!tipInit) { _tipPrev.copyFrom(_tip); _tipVelPrev.setAll(0); tipInit = true; }
    // フックの揺れ（振り子）。小さめにして早く収まるようにした（揺れ止め）
    _tip.subtractToRef(_tipPrev, _tipVel).scaleInPlace(1 / dt);
    const ax = (_tipVel.x - _tipVelPrev.x) / dt, az = (_tipVel.z - _tipVelPrev.z) / dt;
    _tipPrev.copyFrom(_tip); _tipVelPrev.copyFrom(_tipVel);
    const g = 9.81 / Math.max(1, cr.wire);
    cr.swayV.x += (-g * cr.sway.x - ax * 0.35) * dt; cr.swayV.y += (-g * cr.sway.y - az * 0.35) * dt;
    cr.swayV.scaleInPlace(Math.max(0, 1 - 2.6 * dt));
    cr.sway.addInPlace(cr.swayV.scale(dt));
    const sl = cr.sway.length(), smax = Math.min(1.2, cr.wire * 0.15); if (sl > smax) cr.sway.scaleInPlace(smax / sl);
    const hp = hookPos();
    if (hp.y - hang < 0.9) hp.y = 0.9 + hang;
    hook.position.copyFrom(hp);
    // ロープ 2 本: ブームの先からフックまで
    const off = new B.Vector3(Math.cos(cr.swing) * 0.13, 0, -Math.sin(cr.swing) * 0.13);
    setRope(wireM, _tip.add(off), hp.add(off).addInPlaceFromFloats(0, 0.4, 0));
    setRope(wireM2, _tip.subtract(off), hp.subtract(off).addInPlaceFromFloats(0, 0.4, 0));

    // 吊る: フックを置き場の建材のすぐ上まで下ろすと掛かる
    if (!bd.hanging && !bd.snap && bd.yard) {
      const m = bd.yard.m; m.computeWorldMatrix(true);
      const top = m.getBoundingInfo().boundingBox.maximumWorld.y;
      if (Math.hypot(hp.x - m.position.x, hp.z - m.position.z) < 1.8 && hp.y - 0.95 < top + 1.2) { bd.hanging = bd.yard; bd.yard = null; thud(0.3, 1200); toast("吊った！ 光る枠の上へ運ぼう"); }
    }
    bd.near = false;
    if (bd.hanging) {
      const h = bd.hanging;
      h.m.position.set(hp.x, hp.y - 0.75 - h.p.size[1] / 2, hp.z);
      B.Quaternion.SlerpToRef(h.m.rotationQuaternion, B.Quaternion.Identity(), Math.min(1, dt * 3), h.m.rotationQuaternion);   // 寝ていた柱が起き上がる
      // 光る枠の近くまで運ぶとピタッとはまる。横は近いのに高さが合っていない時は枠が緑になって知らせる
      const d = Math.hypot(h.m.position.x - h.p.pos.x, h.m.position.z - h.p.pos.z), dy = h.m.position.y - h.p.pos.y;
      bd.near = d < SNAP.xz; bd.dist = d; bd.dy = dy;
      // 通り過ぎただけでははまらない。レバーを離して止めた時（またはほぼ真上でゆっくり）にはまる
      if (d < SNAP.xz && Math.abs(dy) < SNAP.y && (tgtSpeed < 0.3 || (d < 0.5 && Math.abs(dy) < 0.5 && tgtSpeed < 2.5))) {
        const pts = Math.max(30, Math.round(100 - d * 25 - Math.abs(dy) * 15));
        bd.score += pts; bd.snap = { m: h.m, from: h.m.position.clone(), q: h.m.rotationQuaternion.clone(), to: h.p.pos, t: 0 }; bd.hanging = null;
        toast(pts >= 85 ? `ぴったり！ +${pts}` : `はまった！ +${pts}`);
      }
    }
    if (bd.snap) {
      const s2 = bd.snap; s2.t = Math.min(1, s2.t + dt / 0.35);
      B.Vector3.LerpToRef(s2.from, s2.to, s2.t, s2.m.position); B.Quaternion.SlerpToRef(s2.q, B.Quaternion.Identity(), s2.t, s2.m.rotationQuaternion);
      if (s2.t >= 1) {
        thud(0.5, 700); bd.placed.push(s2.m); bd.snap = null; bd.step++;
        if (bd.step >= bd.plan.length) { bd.floor++; bd.step = 0; bd.plan = planFloor(bd.floor); toast(`${bd.floor}階 完成！`); }
        nextPiece();
        cr.tgt.y = Math.max(cr.tgt.y, bd.floor * FLOOR_H + 5);   // 置いたらフックを少し上げて、次へ向かいやすく
      }
    }
    // 落ちる場所の目印: 吊り荷（無ければフック）の真下の、地面か建っている物の上
    {
      const from = bd.hanging ? bd.hanging.m.position : hp, bottom = bd.hanging ? from.y - bd.hanging.p.size[1] / 2 : hp.y - 1;
      let gy = 0.03;
      for (const m of bd.placed) {
        const bb = m.getBoundingInfo().boundingBox;
        if (from.x > bb.minimumWorld.x - 0.3 && from.x < bb.maximumWorld.x + 0.3 && from.z > bb.minimumWorld.z - 0.3 && from.z < bb.maximumWorld.z + 0.3 && bb.maximumWorld.y < bottom + 0.01) gy = Math.max(gy, bb.maximumWorld.y + 0.03);
      }
      mark.position.set(from.x, gy, from.z);
      markM.diffuseColor.set(bd.near ? 0.3 : 1, bd.near ? 1 : 0.55, bd.near ? 0.3 : 0.1);
      setRope(markLine, new B.Vector3(from.x, bottom, from.z), new B.Vector3(from.x, gy, from.z));
    }
    $("hint").textContent = bd.snap ? "" : !bd.hanging ? "右レバー ↓ で下げて、建材を吊る" : bd.near ? (bd.dy > 0.25 ? "右レバー ↓ もう少し下げて、手を離す" : bd.dy < -0.25 ? "右レバー ↑ もう少し上げる" : "手を離すと はまる！") : `左レバーで 光る枠の上へ（あと ${bd.dist.toFixed(1)}m）`;
    if (bd.ghost) { bd.ghost.material = bd.near ? ghostOk : ghostM; bd.ghost.visibility = 0.6 + 0.4 * Math.sin(performance.now() / 250); }
    if (bd.toastT > 0) { bd.toastT -= dt; if (bd.toastT <= 0) $("toast").style.display = "none"; }
    // カメラ: 見回していない間は、吊り荷（無ければフック）を自動で追う
    if (lookPtr) lookIdle = 0; else lookIdle += dt;
    if (view === "fp" && lookIdle > 1.5) {
      const focus = bd.hanging ? bd.hanging.m.position : hp;
      const inv = crSeat.computeWorldMatrix(true).clone().invert(), lp = B.Vector3.TransformCoordinates(focus, inv);
      const wy = Math.atan2(lp.x, lp.z), wp = B.Scalar.Clamp(-Math.atan2(lp.y, Math.hypot(lp.x, lp.z)) + 0.12, -1.25, 1.0);
      look.yaw += (B.Scalar.Clamp(wy, -2.4, 2.4) - look.yaw) * Math.min(1, dt * 3);
      look.pitch += (wp - look.pitch) * Math.min(1, dt * 3);
    }
    if (eng) eng.o.frequency.value = 38 + Math.min(Math.abs(fwd) + Math.abs(side) + Math.abs(lift), 2) * 14;
  }
  let mode = "demo";
  function enterBuild() {
    mode = "build";
    clearDebris(); for (const c of [...bld.cells.values()]) removeCell(c); rebuildCellMesh();
    // ショベルは横へ片づけ、ダンプは帰す
    ex.pos.set(13, 0, 2); ex.heading = -Math.PI / 2; ex.swing = 0; ex.boom = -0.6; ex.stick = 1.6; ex.bucket = 1.5; applyPose(); syncColliders(exParts, true);
    for (const m of truck.load) m.dispose(); truck.load.length = 0; truck.amount = 0; truck.state = "gone"; truck.z = -200; placeTruck(); syncColliders(truck.parts, true); truck.root.setEnabled(false);
    for (const n of crAll) n.setEnabled(true);
    cr.pos.set(0, 0, 3); cr.heading = 0; cr.sway.set(0, 0); cr.swayV.set(0, 0); tipInit = false;
    cr.tgt.set(YARD.x, 6, YARD.z);                           // 最初は置き場の真上。あとは「下げる」だけで吊れる
    const s = solveCrane(cr.tgt, 0); cr.swing = s.swing; cr.luff = s.luff; cr.ext = s.ext; cr.wire = s.wire;
    fp.parent = crSeat; fp.fov = 1.25; look.yaw = 0; look.pitch = -0.1; lookIdle = 9; tp.radius = 32;
    $("done").style.display = "none"; $("pedals").style.display = "none"; $("hint").style.display = "";   // クレーンは止めたまま届くのでペダルは隠す
    $("labL").textContent = "フックを動かす ↑遠く ↓近く ←→左右"; $("labR").textContent = "↑ 上げる / ↓ 下げる";
    nextPiece(); toast("右レバーを↓で下げて、建材を吊ろう");
  }
  $("bBuild").onclick = enterBuild;

  // ================= 毎フレーム =================
  let fpsAvg = 60, msAvg = 16, hudT = 0;
  scene.onBeforeRenderObservable.add(() => {
    const dt = G.fixedDt || Math.min(engine.getDeltaTime() / 1000, 0.05);   // 確かめる時は G.fixedDt で固定
    if (mode === "build") { updateBuild(dt); frameCommon(dt); return; }
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

    frameCommon(dt);
  });
  function frameCommon(dt) {
    // カメラ
    fp.rotation.set(look.pitch, look.yaw, 0);
    tp.target.copyFrom(mode === "build" ? cr.pos.add(new B.Vector3(0, 6, 6)) : ex.pos.add(new B.Vector3(0, 2.5, 0)));

    // 数字
    const f = engine.getFps(); fpsAvg += (f - fpsAvg) * 0.05; msAvg += (engine.getDeltaTime() - msAvg) * 0.05;
    hudT += dt;
    if (hudT > 0.25) {
      hudT = 0;
      let awake = 0;
      for (const d of debris) { if (!d.ag) continue; d.ag.body.getLinearVelocityToRef(_v); if (_v.lengthSquared() > 0.04) awake++; }
      const pct = Math.round((1 - bld.cells.size / bld.total) * 100), sd = siteDebris();
      const tstate = { wait: "待っている", leave: "出発！", back: "戻ってくる" }[truck.state];
      if (mode === "build") {
        const nx = bd.plan[bd.step];
        $("hud").textContent =
          `建築 ${bd.floor + 1}階目　${bd.step}/${bd.plan.length}　次: ${nx.kind}\n` +
          `得点 ${bd.score}　高さ ${(bd.floor * FLOOR_H).toFixed(1)}m\n` +
          (bd.hanging ? (bd.near ? (bd.dy > 0 ? "もう少し下げる ↓" : "もう少し上げる ↑") : `${bd.hanging.p.kind}を光る枠の上へ（あと ${bd.dist.toFixed(1)}m）`) : "右レバー↓で置き場の建材まで下げて吊る") + `\n` +
          `${api}  ${fpsAvg.toFixed(0)} fps (${msAvg.toFixed(1)} ms)  画面 ${engine.getRenderWidth()}×${engine.getRenderHeight()}`;
        G.stats = { mode, floor: bd.floor, step: bd.step, score: bd.score, hanging: !!bd.hanging, fps: fpsAvg };
        return;
      }
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
  }

  // ---- 仕上げの画面処理 ----
  const pipe = new B.DefaultRenderingPipeline("pipe", !Q.has("nohdr"), scene, Q.has("nopp") ? [] : [fp, tp]);
  pipe.imageProcessingEnabled = true;
  pipe.imageProcessing.toneMappingEnabled = true; pipe.imageProcessing.toneMappingType = B.ImageProcessingConfiguration.TONEMAPPING_ACES;
  pipe.imageProcessing.exposure = 1.0; pipe.imageProcessing.contrast = 1.28;
  pipe.imageProcessing.colorCurvesEnabled = true; pipe.imageProcessing.colorCurves = new B.ColorCurves(); pipe.imageProcessing.colorCurves.globalSaturation = -14;
  scene.environmentIntensity = 0.85;
  pipe.imageProcessing.vignetteEnabled = true; pipe.imageProcessing.vignetteWeight = 1.2;
  pipe.fxaaEnabled = true; pipe.samples = 1;
  pipe.bloomEnabled = true; pipe.bloomThreshold = 0.85; pipe.bloomWeight = 0.12; pipe.bloomKernel = 48;
  pipe.sharpenEnabled = true; pipe.sharpen.edgeAmount = 0.18;
  let ssao = null;
  function setQuality(hq) {
    HQ = hq;
    if (hq && !ssao && Q.has("ssao")) {   // SSAO は WebGPU で背景が黒く抜けるので、?ssao の時だけ（WebGL で試す用）
      ssao = new B.SSAO2RenderingPipeline("ssao", scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, [fp, tp]);
      ssao.radius = 1.2; ssao.totalStrength = 1.1; ssao.samples = 12; ssao.maxZ = 120; ssao.expensiveBlur = false;
    } else if (!hq && ssao) { ssao.dispose(); ssao = null; }
    pipe.bloomEnabled = hq; pipe.sharpenEnabled = hq;
    engine.setHardwareScalingLevel(1 / (hq ? DPR : (TOUCH ? 1 : Math.min(DPR, 1.5))));
    $("bQuality").textContent = hq ? "画質 高" : "画質 低";
  }
  $("bQuality").onclick = () => { setQuality(!HQ); autoQ.off = true; };
  setQuality(HQ);
  // 重い時は自動で画質を落とす。4 秒ごとに平均 fps を見て、28 を切っていたら 1 段下げる（高 → 低 → 最低）
  // 1 コマに 0.5 秒以上かかった区間は「窓が裏で描画を止められていた」とみなして数えない
  const autoQ = { t: 0, n: 0, level: HQ ? 0 : 1, ok: 0, off: Q.has("hq"), t0: performance.now() };
  function lowest() {
    autoQ.level = 2; setShadow(false);
    engine.setHardwareScalingLevel(TOUCH ? 1.4 : 1.2); pipe.fxaaEnabled = true;
    toast("重いので画質を一番低くしました（影なし）");
  }
  scene.onAfterRenderObservable.add(() => {
    // scene.isReady() は隠してあるクレーンの目印が「未準備」のまま残り、ずっと false だった（そのせいで一度も働いていなかった）
    if (autoQ.off || G.fixedDt || document.hidden || performance.now() - autoQ.t0 < 3000) return;
    const dt = engine.getDeltaTime() / 1000;
    if (dt > 0.5) { autoQ.t = 0; autoQ.n = 0; return; }
    autoQ.t += dt; autoQ.n++;
    if (autoQ.t < 4) return;
    const fps = autoQ.n / autoQ.t; autoQ.t = 0; autoQ.n = 0;
    if (fps >= 28) { if (++autoQ.ok >= 3) autoQ.off = true; return; }
    if (autoQ.level === 0) { autoQ.level = 1; setQuality(false); toast("重いので画質を下げました"); }
    else if (autoQ.level === 1) lowest();
    else autoQ.off = true;
  });

  // ---- 小物: 金網フェンス・コンクリートの車止め・ドラム缶（Poly Haven の 3D モデル・CC0）----
  async function loadProp(name) {
    const c = await B.SceneLoader.LoadAssetContainerAsync("assets/models/" + name + "/", name + ".gltf", scene);
    return c;
  }
  // 仮囲い: 工事現場を 3m の白い波板で囲う（x ±24・z -14〜42）。手前の真ん中（|x|<6）は出入り口
  {
    const wall = (x0, z0, x1, z1) => {
      const len = Math.hypot(x1 - x0, z1 - z0), m = pbrTex("hoardM", "box_profile_metal_sheet", 1, [1, 1, 1], "hoard_diff.jpg");
      for (const t of [m.albedoTexture, m.bumpTexture, m.metallicTexture]) { t.uScale = len / 2.4; t.vScale = 1.25; }
      const b = B.MeshBuilder.CreateBox("hoard", { width: len, height: 3, depth: 0.06 }, scene);
      b.position.set((x0 + x1) / 2, 1.5, (z0 + z1) / 2); b.rotation.y = -Math.atan2(z1 - z0, x1 - x0); b.material = m; b.receiveShadows = true; b.isPickable = false; shadow.addShadowCaster(b);
      // 支柱
      for (let t = 0; t <= len; t += 3) { const q = B.MeshBuilder.CreateBox("hoardPost", { width: 0.06, height: 3.1, depth: 0.06 }, scene); q.position.set(x0 + (x1 - x0) * t / len, 1.55, z0 + (z1 - z0) * t / len); q.material = steel; q.isPickable = false; }
    };
    wall(-24, 42, 24, 42); wall(-24, -14, -24, 42); wall(24, -14, 24, 42); wall(-24, -14, -6, -14); wall(6, -14, 24, -14);
  }
  {
    const t = new B.DynamicTexture("rutT", { width: 64, height: 256 }, scene, false, B.Texture.BILINEAR_SAMPLINGMODE), c = t.getContext();
    c.clearRect(0, 0, 64, 256); c.fillStyle = "rgba(40,30,22,0.55)"; c.fillRect(0, 0, 64, 256);
    for (let y = 0; y < 256; y += 21) { c.fillStyle = "rgba(25,18,12,0.75)"; c.fillRect(0, y, 64, 7); }
    const g = c.createLinearGradient(0, 0, 64, 0); g.addColorStop(0, "rgba(0,0,0,1)"); t.update(); t.hasAlpha = true; t.wrapV = B.Texture.WRAP_ADDRESSMODE;
    const rm = new B.StandardMaterial("rutM", scene); rm.diffuseTexture = t; rm.useAlphaFromDiffuseTexture = true; rm.specularColor = B.Color3.Black(); rm.zOffset = -3;
    const rut = (x0, z0, x1, z1, w) => {
      const L = Math.hypot(x1 - x0, z1 - z0), m = B.MeshBuilder.CreateGround("rut", { width: w, height: L }, scene);
      m.position.set((x0 + x1) / 2, 0.012, (z0 + z1) / 2); m.rotation.y = Math.atan2(x1 - x0, z1 - z0); m.isPickable = false; m.receiveShadows = true;
      const mm = rm.clone("rutM"); mm.diffuseTexture = t.clone(); mm.diffuseTexture.vScale = L / 1.6; m.material = mm;
    };
    for (const sx of [-1.2, 1.2]) { rut(sx, -10, sx + 0.3, 9, 0.75); rut(sx - 3, 8, sx + 2, 11, 0.7); }
    for (const sx of [-1.0, 1.0]) rut(-6.8 + sx, -14, -6.8 + sx, 4, 0.4);
  }
  {
    const coneM = paintM("coneM", "paint_orange_diff.jpg", 0.5, 0.2);
    const cone = (x, z) => {
      const c = B.MeshBuilder.CreateCylinder("cone", { diameterTop: 0.05, diameterBottom: 0.3, height: 0.7, tessellation: 16 }, scene); c.position.set(x, 0.39, z); c.material = coneM;
      const b = B.MeshBuilder.CreateCylinder("coneBand", { diameterTop: 0.13, diameterBottom: 0.19, height: 0.14, tessellation: 16 }, scene); b.position.set(x, 0.5, z); b.material = white;
      const f = B.MeshBuilder.CreateBox("coneFoot", { width: 0.4, height: 0.04, depth: 0.4 }, scene); f.position.set(x, 0.02, z); f.material = dark;
      for (const m of [c, b, f]) { m.isPickable = false; m.receiveShadows = true; shadow.addShadowCaster(m); }
    };
    for (const [x, z] of [[-6.5, -13.2], [-5, -12.4], [5, -12.4], [6.5, -13.2], [-16, 30], [-15, 31.5], [12, 34], [13.2, 33]]) cone(x, z);
    // 鉄骨の束（置き場の奥）: 下に角材を 2 本、その上に 3×2 本
    for (const z of [32.5, 36.5]) { const t = B.MeshBuilder.CreateBox("dunnage", { width: 2.2, height: 0.15, depth: 0.15 }, scene); t.position.set(-18, 0.075, z); t.material = pbrTex("dunM", "brown_mud_dry", 0.3, [0.9, 0.7, 0.5]); t.isPickable = false; shadow.addShadowCaster(t); }
    for (let row = 0; row < 2; row++) for (let i = 0; i < 3; i++) {
      const b = hBeam("stockBeam", [0.3, 0.3, 6]); b.material = steelM; b.position.set(-18.6 + i * 0.6, 0.3 + row * 0.31, 34.5); b.isPickable = false; b.receiveShadows = true; shadow.addShadowCaster(b);
    }
  }
  // 接地の影: 重機の真下をぼんやり暗く（影の地図では出ない「地面に置いてある感じ」）
  {
    const t = new B.DynamicTexture("blobT", { width: 128, height: 128 }, scene, false, B.Texture.BILINEAR_SAMPLINGMODE), c = t.getContext();
    const g = c.createRadialGradient(64, 64, 10, 64, 64, 64); g.addColorStop(0, "rgba(0,0,0,0.75)"); g.addColorStop(0.6, "rgba(0,0,0,0.35)"); g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g; c.fillRect(0, 0, 128, 128); t.update(); t.hasAlpha = true;
    const bm = new B.StandardMaterial("blobM", scene); bm.diffuseTexture = t; bm.useAlphaFromDiffuseTexture = true; bm.disableLighting = true; bm.emissiveColor = B.Color3.Black(); bm.zOffset = -4;
    for (const [par, w, d] of [[root, 3.6, 4.8], [truck.root, 3.2, 8], [crRoot, 3.4, 10.5]]) {
      const b = B.MeshBuilder.CreateGround("blob", { width: w, height: d }, scene); b.parent = par; b.position.y = 0.03; b.material = bm; b.isPickable = false;
    }
  }
  (async () => {
    try {
      const put = (c, x, z, ry, y = 0) => {
        const inst = c.instantiateModelsToScene(n => n, false);
        const r = inst.rootNodes[0]; r.position.set(x, y, z); r.rotationQuaternion = null; r.rotation.y = ry || 0;
        for (const m of r.getChildMeshes()) { shadow.addShadowCaster(m); m.receiveShadows = true; m.isPickable = false; }
        return r;
      };
      const crate = await loadProp("wooden_crate_01"), pcrate = await loadProp("plastic_crate_01"), can = await loadProp("metal_jerrycan"), bar2 = await loadProp("concrete_road_barrier_02");
      for (const [x, z, r, y] of [[-21, 22, 0.1, 0], [-21.9, 22.3, 0.5, 0], [-21.4, 22.1, 0.9, 0.62], [20.5, 30, 0.2, 0], [21.2, 31, 1.2, 0]]) put(crate, x, z, r, y);
      for (const [x, z, r] of [[-20.6, 24, 0.3], [-20, 24.1, 1.0], [19.5, 3, 0.6]]) put(pcrate, x, z, r);
      for (const [x, z, r] of [[-11.6, 3.4, 0.4], [-11.2, 3.5, 1.6], [17.4, 7.2, 2.2]]) put(can, x, z, r);
      for (const [x, z, r] of [[-22.5, 6, Math.PI / 2], [-22.5, 9.5, Math.PI / 2], [22.5, 12, Math.PI / 2]]) put(bar2, x, z, r);
      const bar = await loadProp("concrete_road_barrier");
      for (const [x, z, r] of [[-7, -12, 0], [-3.5, -12, 0], [7, -12, 0], [10.5, -12, 0], [-14, 8, Math.PI / 2], [-14, 11, Math.PI / 2], [16, 26, 0.3]]) put(bar, x, z, r);
      const barrel = await loadProp("barrel_03");
      for (const [x, z] of [[-12, 1], [-12.9, 1.6], [-12.3, 2.4], [17, 6], [17.8, 6.4], [18, 34], [-19, 30], [-18.2, 30.6]]) put(barrel, x, z, Math.random() * 6);
    } catch (e) { console.warn("小物の読み込み失敗", e); }
  })();

  reset();
  if (Q.has("build")) enterBuild();   // ?build で最初から建築モード（確かめ用）
  $("msg").style.display = "none";
  engine.resize();   // WebGPU は作った時点で canvas の大きさを拾わないことがある（300×150 のままになった）
  engine.runRenderLoop(() => scene.render());
  addEventListener("resize", () => engine.resize());

  Object.assign(G, { get pipe() { return pipe; }, enterBuild, cr, bd, hookPos: () => hook.position.clone(), bucketJ, pedal, scene, engine, ex, bld, debris, truck, carveAt, reset, bucketLowest, spawnDebris, setShadow, sticks, bucketOpenUp,
    setView: v => { if (v !== view) $("bView").onclick(); },
    // 確かめ用: 窓が裏だと描画も物理も止まるので、1/60 秒ずつ手で進める。物理は経過時間でなく固定の刻みにする（経過 0 で止まっていた）
    testMode() { G.fixedDt = 1 / 60; plugin._useDeltaForWorldStep = false; scene.getPhysicsEngine().setTimeStep(1 / 60); G.step = n => { for (let i = 0; i < n; i++) scene.render(); }; } });
})().catch(e => { console.error(e); const m = $("msg"); m.style.display = ""; m.textContent = "起動できませんでした: " + e.message; });
