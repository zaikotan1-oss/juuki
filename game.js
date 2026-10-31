// まち こわし — 真上寄りの視点で、ショベルを動かして広い街をこわし尽くす。がれきは後ろの荷台に吸い込み、ひきとりじょで お金にして、重機を強くする
// 作り（2026-10-29 本人「juuki の素材で、俯瞰だけ・コントローラーで動かすだけ・触れたら自動でガスガス・壊れ方に面白さ」
//       「ガス管が爆発・車を派手に壊す・燃え出す・水道管が破裂・ゾンビをやっつける」）
//  ・建物は juuki と同じ 0.5m の格子（壊れ方・倒れる・沈むは juuki の物をそのまま使う）
//  ・街は区画ごとに、ショベルが近づいた時に建てる（全部を最初に建てると iPad では重い）
//  ・建物の格子に物理の体は付けない。ショベルの当たりは格子の番号で調べる。がれきだけが物理（地面に当たる）
// このファイルは src/*.js をつないだ物。直す時は src を直して python tools/build.py
"use strict";
const B = BABYLON;
const Q = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);

const CELL = 0.5;          // 格子の大きさ(m)
const MAX_DEBRIS = 320;    // がれきの上限（超えたら古い物から消す）
const CARVE_R = 0.9;
const BUCKET = { W: 1.9, H: 1.05, L: 1.55 };
const G = window.G = {};   // 確かめ用の口

(async function main() {
  // ======== エンジン・空・光・材質（juuki から） ========
  const canvas = $("cv");
  // ---- エンジン: WebGPU が使えれば使う（?gl=1 で WebGL を強制） ----
  // タブレット（指で触る機械）は WebGL2。iPad の WebGPU で、読み込み後に景色が灰色のまま描かれなくなった（10-11）。?gpu で WebGPU を試せる
  const TABLET = (navigator.maxTouchPoints || 0) > 1;
  // 軽い版: iPhone で「描画が止まりました（GPU のメモリ不足）」が出た（10-11）。スマホ・タブレットは画像を 1/4（assets/lite）・影と仕上げを軽く。?full で元の重さ
  const LITE = (TABLET && !Q.has("full")) || Q.has("lite"), AS = LITE ? "assets/lite/" : "assets/";
  let engine, api = "WebGL2";
  try {
    if (!Q.has("gl") && !(TABLET && !Q.has("gpu")) && navigator.gpu && await B.WebGPUEngine.IsSupportedAsync) {
      engine = new B.WebGPUEngine(canvas, { antialias: true, stencil: true });
      await engine.initAsync();
      api = "WebGPU";
    }
  } catch (e) { console.warn("WebGPU 失敗→WebGL", e); engine = null; }
  if (!engine) engine = new B.Engine(canvas, true, { stencil: true }, false);
  // 描画が止まった時（GPU のメモリ不足など）は理由を画面に出す。灰色のまま黙らないように
  const showErr = (t, keep) => { const m = $("msg"); m.style.display = ""; m.textContent = t; if (!keep) setTimeout(() => { if (m.textContent === t) m.style.display = "none"; }, 8000); };
  engine.onContextLostObservable.add(() => showErr("描画が止まりました（GPU のメモリ不足かも）。ページを開き直してください [" + api + "]", true));
  window.addEventListener("error", e => showErr("エラー: " + (e.message || e) + " [" + api + "]"));
  window.addEventListener("unhandledrejection", e => showErr("エラー: " + ((e.reason && e.reason.message) || e.reason) + " [" + api + "]"));
  // 解像度: 端末の細かさ（iPad は 2）まで使う。本人「解像度を上げて」（2026-10-07）。?lo で 1 倍に戻す
  const DPR = Q.has("lo") ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  engine.setHardwareScalingLevel(1 / DPR);

  const scene = new B.Scene(engine);
  // 画質: 高（既定）／低（?lo か、iPad で重い時に自動で落とす）。本人「実写に近い見た目に」（2026-10-10）
  // タブレット・スマホ（指で触る機械）は最初から低画質で始める。重すぎて止まって見えた（10-11 iPad で「全然動かない」）
  const TOUCH = (navigator.maxTouchPoints || 0) > 1;
  let HQ = Q.has("hq") || (!Q.has("lo") && !TOUCH);
  scene.clearColor = new B.Color4(0.6, 0.66, 0.72, 1);
  scene.fogMode = B.Scene.FOGMODE_LINEAR; scene.fogStart = 120; scene.fogEnd = 420;
  scene.fogColor = new B.Color3(0.6, 0.58, 0.55);     // 背景写真の地平線あたりの色

  // ---- 物理 ----
  const hk = await HavokPhysics({ locateFile: () => "vendor/HavokPhysics.wasm" });
  const plugin = new B.HavokPlugin(true, hk);
  scene.enablePhysics(new B.Vector3(0, -9.81, 0), plugin);

  // ---- 空と光: Poly Haven の HDRI「construction_yard」（CC0）----
  // 光の当たり方は HDR（256 の小さな立方体で十分）、背景は軽い JPG（HDR を 1024 の立方体にすると iPad のメモリが苦しい）
  const ENV_ROT = Number(Q.get("envrot") || -2.11);   // 写真を回して、太陽がプレイヤーの斜め後ろから当たる向きに
  const env = new B.HDRCubeTexture("assets/hdri/construction_yard_2k.hdr", scene, LITE ? 64 : 256, false, true, false, !LITE);   // 軽い版は読み込み時の下ごしらえ（float の描画先を何枚も作る）を省く
  env.rotationY = ENV_ROT;
  scene.environmentTexture = env; scene.environmentIntensity = 1.0;
  const dome = new B.PhotoDome("bg", AS + "hdri/construction_yard_bg3.jpg?v=2", { resolution: 64, size: 1600 }, scene);
  dome.mesh.rotation.y = ENV_ROT + Number(Q.get("domerot") || 0); dome.material.fogEnabled = false; dome._bg = "construction_yard"; dome._rot0 = dome.mesh.rotation.y;
  // 太陽: 写真の中の太陽の位置（高さ 34°）に合わせる。方位は写真の向きに合わせて DOME と同じだけ回す
  const SUN_EL = 33.8 * Math.PI / 180, SUN_AZ = Number(Q.get("sunaz") || 3.4);   // 写真の太陽の方位（カメラを向けて合わせた。回す前は 5.75）
  const sunDir = new B.Vector3(-Math.sin(SUN_AZ) * Math.cos(SUN_EL), -Math.sin(SUN_EL), -Math.cos(SUN_AZ) * Math.cos(SUN_EL));
  const sun = new B.DirectionalLight("sun", sunDir, scene);
  sun.intensity = 2.1; sun.diffuse = new B.Color3(1, 0.96, 0.9);
  // 影: 現場（x ±26・z -16〜46）にぴったり合わせた 1 枚の影の地図。
  // CascadedShadowGenerator と SSAO2 は WebGPU で画面が真っ黒／背景が黒く抜けた（2026-10-10 確かめ）ので使わない
  const shadow = new B.ShadowGenerator(LITE ? 1024 : HQ ? 4096 : 2048, sun);
  sun.autoUpdateExtends = false; sun.autoCalcShadowZBounds = false;
  sun.orthoLeft = -55; sun.orthoRight = 55; sun.orthoTop = 55; sun.orthoBottom = -55; sun.shadowMinZ = 1; sun.shadowMaxZ = 220;
  sun.position = new B.Vector3(0, 0, 15).subtract(sunDir.scale(110));
  shadow.usePercentageCloserFiltering = true; shadow.filteringQuality = B.ShadowGenerator.QUALITY_HIGH;
  shadow.bias = 0.002; shadow.normalBias = 0.04; shadow.darkness = 0.12;   // bias が小さいと面に木目のような影のしま（シャドウアクネ）が出た
  let shadowOn = !Q.has("noshadow");

  // ---- 材質（PBR: 光を本物らしく返す）----
  // 色は sRGB で書いて、線形に直して渡す
  const mat = (name, r, g, b, rough = 0.55, metal = 0) => {
    const m = new B.PBRMaterial(name, scene); m.albedoColor = new B.Color3(r, g, b).toLinearSpace(); m.roughness = rough; m.metallic = metal; return m;
  };
  const texCache = {};
  const TEX_V = window.JUUKI_TEXV || 5;   // 数は tools/make_manifest.py の TEX_V が正   // 素材の画像を作り直したら上げる（ブラウザの保存分を使わせない）
  const tex = (file, scale) => { const t = new B.Texture(AS + "tex/" + file + "?v=" + TEX_V, scene); t.uScale = t.vScale = scale; t.anisotropicFilteringLevel = LITE ? 4 : 8; return t; };
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
  // ======== 格子の建物・壊れ方（juuki から） ========
  const bld = { cells: new Map(), origin: new B.Vector3(0, 0, 0) };
  const key = (x, y, z) => (x + 1024) + (z + 1024) * 2048 + y * 4194304;
  const sk = (x, y, z) => x + "," + y + "," + z;      // 窓の印は文字列のまま
  const bldM = pbrTex("bldM", "dirty_concrete", 1, [1.0, 0.97, 0.92], "dirty_concrete_soft_diff.jpg");   // しみの濃さを半分にした写真
  bldM.backFaceCulling = false;   // 格子の面は向きによって裏返しに組まれる（後ろ・左から見ると壁が抜けていた 10-12。行の途中のコメントに飲まれて効いていなかった）
  // 壊れた断面（元は隣に壁があった面）は同じメッシュの 2 つ目の材質: 荒いコンクリート＋飛び出した鉄筋
  const brokeM = pbrTex("brokeM", "concrete_debris", 1, [0.85, 0.83, 0.8]); brokeM.backFaceCulling = false;
  const cellMM = new B.MultiMaterial("cellMM", scene); cellMM.subMaterials.push(bldM, brokeM);
  const cellShapeM = { friction: 0.8, restitution: 0 };
  const CH = 16, chunks = new Map(); let chunkGen = 0;
  function chunkOf(x, y, z, make) {
    const ck = key(Math.floor(x / CH), Math.floor(y / CH), Math.floor(z / CH));
    let ch = chunks.get(ck);
    if (!ch && make) {
      const mesh = new B.Mesh("bld", scene); mesh.material = cellMM; mesh.receiveShadows = true; shadow.addShadowCaster(mesh); mesh.setEnabled(false); mesh.freezeWorldMatrix();   // 塊は動かない（位置の計算を毎コマしない）
      ch = { cells: new Set(), wins: [], mesh, body: null, shape: null, bars: [], frames: [], pp: [], pn: [], dirty: true };
      chunks.set(ck, ch); chunkGen++;
    }
    return ch;
  }
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
  const paneM = new B.PBRMaterial("paneM", scene); paneM.albedoColor = new B.Color3(0.06, 0.08, 0.1); paneM.emissiveColor = new B.Color3(0.025, 0.032, 0.04); paneM.metallic = 0; paneM.roughness = 0.03; paneM.alpha = 0.88; paneM.backFaceCulling = false;   // 空が映り込む古いガラス。色は真っ黒な四角に見えたので少し明るく（10-25 改善ループ）
  paneMesh.material = paneM;
  const winSet = new Set();      // 窓の穴（格子の座標）。上下の壁が残っている間だけガラスを出す
  const blds = [], dirtyB = new Set(); let curB = null;
  function newB(H, sink) { curB = { cells: new Set(), baseY: H - 1, base0: 0, baseN: 0, sink, warned: false, lot: curLot }; blds.push(curB); if (curLot) curLot.blds.push(curB); return curB; }
  let curLot = null;   // 今 建てている区画（街の建物の記録。壊れ具合と保存に使う）
  function cellWorld(x, y, z) { return new B.Vector3(bld.origin.x + (x + 0.5) * CELL, bld.origin.y + (y + 0.5) * CELL, bld.origin.z + (z + 0.5) * CELL); }
  function addCell(x, y, z, kind) {
    const k = key(x, y, z), old = bld.cells.get(k); if (old) { old.kind = kind; return; }
    const c = { x, y, z, kind, p: cellWorld(x, y, z), b: curB };
    bld.cells.set(k, c); chunkOf(x, y, z, true).cells.add(c);
    if (curB) { curB.cells.add(c); if (y < curB.baseY) curB.base0++; }
  }
  // 格子で家を 1 軒組む。ox, oz は格子の座標（ビルの左手前の角が 0,0）、W・D は格子の数、H は 1 階の段数
  function addHouse(ox, oz, W, D, floors, H, o = {}) {
    const K = Object.assign({ wall: "wall", pillar: "pillar", slab: "slab", roof: "parapet", winRows: [2, 3], door: [W / 2 - 3, W / 2 + 2, 4] }, o);
    newB(H, !!K.sink); curB.topple = !!K.topple;
    for (let f = 0; f < floors; f++) {
      for (let r = 0; r < H; r++) {
        const y = f * H + r;
        for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
          const edge = x === 0 || z === 0 || x === W - 1 || z === D - 1;
          const corner = (x <= 1 || x >= W - 2) && (z <= 1 || z >= D - 2);
          const pillar = corner || ((x === W / 2 - 1 || x === W / 2) && (z === 0 || z === D - 1));
          if (r === H - 1) { addCell(ox + x, y, oz + z, K.slab); continue; }      // 各階の天井
          if (!edge) continue;
          // 窓: 柱以外の壁を 2 格子おきにあける
          const zFace = z === 0 || z === D - 1, along = zFace ? x : z;
          if (K.winRows.includes(r) && !pillar && (Math.floor(along / 2) % 2 === 1)) {
            const sg = zFace ? (z === 0 ? -1 : 1) : (x === 0 ? -1 : 1), w = sk(ox + x, y, oz + z) + (zFace ? ",z," : ",x,") + sg;
            winSet.add(w); chunkOf(ox + x, y, oz + z, true).wins.push(w); continue;
          }
          // 1 階の正面（z=0）の入口
          if (K.door && f === 0 && z === 0 && x >= K.door[0] && x <= K.door[1] && r < K.door[2] && !pillar) continue;
          if (K.doors && f === 0 && z === 0 && !pillar && K.doors.some(d => x >= d[0] && x <= d[1] && r < d[2])) continue;   // 消防署の車庫の口（3 つ）
          addCell(ox + x, y, oz + z, pillar ? K.pillar : K.wall);
        }
      }
    }
    const top = floors * H;
    if (K.roof === "parapet")      // 屋上の縁の立ち上がり: 一番上の床の外周に 1 段
      for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) { if (x === 0 || z === 0 || x === W - 1 || z === D - 1) addCell(ox + x, top, oz + z, K.wall); }
    if (K.roof === "gable") {      // 切妻屋根: 手前と奥から 1 段ずつ上がる。軒は 1 格子はみ出す。両端は壁でふさぐ
      for (let k = 0; ; k++) {
        const zL = k - 1, zR = D - k; if (zL > zR) break;
        for (let x = -1; x <= W; x++) { addCell(ox + x, top + k, oz + zL, "roof"); if (zR !== zL) addCell(ox + x, top + k, oz + zR, "roof"); }
        for (const x of [0, W - 1]) for (let z = Math.max(0, zL + 1); z <= Math.min(D - 1, zR - 1); z++) addCell(ox + x, top + k, oz + z, K.wall);
      }
    }
  }
  // 塀: 長さ len・高さ h（格子）。x 向き
  function addFence(ox, oz, len, h, kind) { newB(1, false); for (let x = 0; x < len; x++) for (let y = 0; y < h; y++) addCell(ox + x, y, oz, kind); }
  // 世界の m で置く（まち まるごと用）。大きさは 1m 単位（格子が偶数になる）
  const OFF = { x: 0, z: 0 };   // 名所の組み立て関数は (0, 20) 辺りに建てる前提。区画の中心へずらす
  const gx = wx => Math.round((wx + OFF.x - bld.origin.x) / CELL), gz = wz => Math.round((wz + OFF.z - bld.origin.z) / CELL);
  const houseW = (wx, wz, wm, dm, floors, o = {}, Hm = 3) => addHouse(gx(wx), gz(wz), wm / CELL, dm / CELL, floors, Math.round(Hm / CELL), o);
  const WOOD = { wall: "wood", pillar: "beam", slab: "wfloor", roof: "gable", door: [2, 4, 4] };
  const TIN = { wall: "tin", pillar: "steelc", slab: "tinroof", roof: "flat", winRows: [5], door: [4, 9, 5] };
  const PRE = { wall: "prefab", pillar: "prefab", slab: "tinroof", roof: "flat", winRows: [2, 3], door: [1, 2, 4] };
  const BIG = { sink: true };
  // なめらかな部材（10-26 本人「観覧車とか斜めの所がカクカクでマイクラみたい」）
  // 斜めの棒・丸い壁は格子を隠し（c.hid）、本物の角棒・曲がった板で描く。格子は削る判定・崩れの判定のために残す
  // 部材は 1.5m ほどの区間に切ってあり、区間のどこか 1 マスが削れると、その区間の絵が消える
  const rods = []; let rodDirty = false, rodMesh = null;
  function newRod(o) { const r = Object.assign({ cells: [], alive: true, ext: true }, o); rods.push(r); rodDirty = true; return r; }
  function rodCell(r, x, y, z, kind) {
    const k = key(x, y, z), had = bld.cells.get(k); addCell(x, y, z, kind);
    const c = bld.cells.get(k); if (!had) c.hid = true;
    (c.segs || (c.segs = [])).push(r); r.cells.push(c);
  }
  // 角棒（a→b、太さ t。u と w を渡すと横幅 w の板）を足す
  function pushRod(r, pos, nor, uv, col, idx) {
    if (r.wedge) return pushWedge(r, pos, nor, uv, col, idx);
    const d = r.b.subtract(r.a), L = d.length(); if (L < 1e-4) return;
    const w = d.scale(1 / L), e = r.ext ? r.t / 2 : 0;
    const u = r.u || B.Vector3.Cross(w, Math.abs(w.y) < 0.9 ? B.Axis.Y : B.Axis.X).normalize(), v = B.Vector3.Cross(u, w).normalize();
    const hu = (r.w || r.t) / 2, hv = r.t / 2, a = r.a.subtract(w.scale(e)), L2 = L + 2 * e, k = KIND_COL[r.kind];
    const P = (i, j, s2) => a.add(w.scale(s2 * L2)).addInPlace(u.scale(i * hu)).addInPlace(v.scale(j * hv));
    const quad = (ps, n, du, dv) => { const b0 = pos.length / 3; ps.forEach((q, i) => { pos.push(q.x, q.y, q.z); nor.push(n.x, n.y, n.z); uv.push([0, du, du, 0][i] / TEXM, [0, 0, dv, dv][i] / TEXM); col.push(k[0], k[1], k[2], 1); }); idx.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3); };
    quad([P(1, -1, 0), P(1, 1, 0), P(1, 1, 1), P(1, -1, 1)], u, 2 * hv, L2); quad([P(-1, -1, 0), P(-1, 1, 0), P(-1, 1, 1), P(-1, -1, 1)], u.negate(), 2 * hv, L2);
    quad([P(-1, 1, 0), P(1, 1, 0), P(1, 1, 1), P(-1, 1, 1)], v, 2 * hu, L2); quad([P(-1, -1, 0), P(1, -1, 0), P(1, -1, 1), P(-1, -1, 1)], v.negate(), 2 * hu, L2);
    quad([P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)], w, 2 * hu, 2 * hv); quad([P(-1, -1, 0), P(1, -1, 0), P(1, 1, 0), P(-1, 1, 0)], w.negate(), 2 * hu, 2 * hv);
  }
  // 丸い板の一切れ（タンクの底・ふた）
  function pushWedge(r, pos, nor, uv, col, idx) {
    const k = KIND_COL[r.kind], C = (y) => new B.Vector3(r.c.x, y, r.c.z), A = (t, y) => new B.Vector3(r.c.x + Math.cos(t) * r.rad, y, r.c.z + Math.sin(t) * r.rad);
    const tri = (ps, n) => { const b0 = pos.length / 3; for (const q of ps) { pos.push(q.x, q.y, q.z); nor.push(n.x, n.y, n.z); uv.push(q.x / TEXM, q.z / TEXM); col.push(k[0], k[1], k[2], 1); } if (ps.length === 3) idx.push(b0, b0 + 1, b0 + 2); else idx.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3); };
    const tm = (r.t0 + r.t1) / 2, out = new B.Vector3(Math.cos(tm), 0, Math.sin(tm));
    if (!r.r0) {
      tri([C(r.y1), A(r.t0, r.y1), A(r.t1, r.y1)], B.Axis.Y); tri([C(r.y0), A(r.t0, r.y0), A(r.t1, r.y0)], B.Axis.Y.negate());
      tri([A(r.t0, r.y0), A(r.t1, r.y0), A(r.t1, r.y1), A(r.t0, r.y1)], out); return;
    }
    // 内側の半径 r0 がある時は、扇の帯（スタンドの段・壁）: 上・下・外・内・両端
    const I = (t, y) => new B.Vector3(r.c.x + Math.cos(t) * r.r0, y, r.c.z + Math.sin(t) * r.r0);
    tri([I(r.t0, r.y1), A(r.t0, r.y1), A(r.t1, r.y1), I(r.t1, r.y1)], B.Axis.Y); tri([I(r.t0, r.y0), A(r.t0, r.y0), A(r.t1, r.y0), I(r.t1, r.y0)], B.Axis.Y.negate());
    tri([A(r.t0, r.y0), A(r.t1, r.y0), A(r.t1, r.y1), A(r.t0, r.y1)], out); tri([I(r.t0, r.y0), I(r.t1, r.y0), I(r.t1, r.y1), I(r.t0, r.y1)], out.negate());
    for (const t of [r.t0, r.t1]) tri([I(t, r.y0), A(t, r.y0), A(t, r.y1), I(t, r.y1)], new B.Vector3(-Math.sin(t), 0, Math.cos(t)));
  }
  function rebuildRods() {
    rodDirty = false;
    if (!rodMesh) { rodMesh = new B.Mesh("rods", scene); rodMesh.material = bldM; rodMesh.receiveShadows = true; rodMesh.isPickable = false; shadow.addShadowCaster(rodMesh); }
    const pos = [], nor = [], uv = [], col = [], idx = [];
    for (const r of rods) if (r.alive) pushRod(r, pos, nor, uv, col, idx);
    if (!idx.length) { rodMesh.setEnabled(false); return; }
    const vd = new B.VertexData(); vd.positions = pos; vd.normals = nor; vd.uvs = uv; vd.colors = col; vd.indices = idx; vd.applyToMesh(rodMesh, false); rodMesh.setEnabled(true);
  }
  const gw = (gxv, gyv, gzv) => new B.Vector3(bld.origin.x + gxv * CELL, bld.origin.y + gyv * CELL, bld.origin.z + gzv * CELL);   // 格子の座標（小数）→ 世界の位置
  // 3D の線を格子で引き、見た目は角棒（a・b は格子の座標・小数でよい。kf は高さ y から種類を返す）
  function lineCells(a, b, kf, th = 1) {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * 2)), PER = 6;
    const W = t => gw(a[0] + (b[0] - a[0]) * t + th / 2, a[1] + (b[1] - a[1]) * t + 0.5, a[2] + (b[2] - a[2]) * t + th / 2);
    let r = null;
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = Math.round(a[0] + (b[0] - a[0]) * t), y = Math.round(a[1] + (b[1] - a[1]) * t), z = Math.round(a[2] + (b[2] - a[2]) * t);
      if (i % PER === 0 && i < n) { const t1 = Math.min(1, (i + PER) / n); r = newRod({ a: W(t), b: W(t1), t: th * CELL * 0.8, kind: kf(Math.round(a[1] + (b[1] - a[1]) * (t + t1) / 2)) }); }
      for (let dx = 0; dx < th; dx++) for (let dz = 0; dz < th; dz++) if (y >= 0) rodCell(r, x + dx, y, z + dz, kf(y));
    }
  }
  // 丸い壁（煙突・タンク）: 中心 cx,cz（格子の角）、半径は高さで変えられる rf(y)、厚さ th マス。見た目は 32 枚の曲がった板を帯ごとに
  function ringWall(cx, cz, y0, y1, rf, th, kf, band) {
    const NS = 32, segs = new Map();
    const seg = (i, j) => {
      const id = i + "," + j; if (segs.has(id)) return segs.get(id);
      const ya = y0 + j * band, yb = Math.min(y1, ya + band), rm = rf((ya + yb) / 2) - th / 2, tm = (i + 0.5) / NS * Math.PI * 2;
      const r = newRod({ a: gw(cx + rm * Math.cos(tm), ya, cz + rm * Math.sin(tm)), b: gw(cx + rm * Math.cos(tm), yb, cz + rm * Math.sin(tm)), t: th * CELL, w: 2 * Math.PI * rm * CELL / NS * 1.06,
        u: new B.Vector3(-Math.sin(tm), 0, Math.cos(tm)), kind: kf(ya), ext: false });
      segs.set(id, r); return r;
    };
    const R = Math.ceil(rf(y0)) + 1;
    for (let y = y0; y < y1; y++) for (let x = -R; x <= R; x++) for (let z = -R; z <= R; z++) {
      const rr = Math.hypot(x + 0.5, z + 0.5), ro = rf(y); if (rr > ro || rr <= ro - th) continue;
      let t = Math.atan2(z + 0.5, x + 0.5); if (t < 0) t += Math.PI * 2;
      rodCell(seg(Math.min(NS - 1, Math.floor(t / (Math.PI * 2) * NS)), Math.floor((y - y0) / band)), cx + x, y, cz + z, kf(y));
    }
  }
  // 丸い板（タンクの底・ふた）: 16 切れ
  function discCells(cx, cz, y0, y1, rad, kind) {
    const NS = 16, cw = gw(cx, 0, cz), list = [];
    for (let i = 0; i < NS; i++) list.push(newRod({ wedge: true, c: cw, rad: rad * CELL, t0: i / NS * Math.PI * 2, t1: (i + 1) / NS * Math.PI * 2, y0: bld.origin.y + y0 * CELL, y1: bld.origin.y + y1 * CELL, kind }));
    const R = Math.ceil(rad);
    for (let y = y0; y < y1; y++) for (let x = -R; x <= R; x++) for (let z = -R; z <= R; z++) {
      if (Math.hypot(x + 0.5, z + 0.5) > rad) continue;
      let t = Math.atan2(z + 0.5, x + 0.5); if (t < 0) t += Math.PI * 2;
      rodCell(list[Math.min(NS - 1, Math.floor(t / (Math.PI * 2) * NS))], cx + x, y, cz + z, kind);
    }
  }
  // 送電の鉄塔: 4 本の脚がすぼまって高さ 40m。4m ごとに輪とバツの筋交い、上に 3 段の腕。赤白のしま
  function buildPylon(wx, wz) {
    const cx = gx(wx), cz = gz(wz), Hc = 80, w = y => 12 - 10 * y / Hc, kf = y => Math.floor(y / 16) % 2 ? "twr_w" : "twr_r";
    newB(6, true); curB.topple = true;
    const C = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const P = (i, y) => [cx + C[i][0] * w(y), y, cz + C[i][1] * w(y)], P2 = (i, y) => [cx + C[i][0] * w(y) - 1, y, cz + C[i][1] * w(y) - 1];
    for (let i = 0; i < 4; i++) lineCells(P2(i, 0), P2(i, Hc), kf, 2);
    for (let y = 0; y < Hc; y += 16) {
      const y2 = Math.min(Hc, y + 16);
      for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; lineCells(P(i, y2), P(j, y2), kf); lineCells(P(i, y), P(j, y2), kf); lineCells(P(j, y), P(i, y2), kf); }
    }
    for (const [ay, half] of [[58, 16], [68, 13], [78, 10]]) {
      for (const dz of [-1, 1]) lineCells([cx - half, ay, cz + dz], [cx + half, ay, cz + dz], kf);
      for (const sx of [-1, 1]) { lineCells([cx + sx * half, ay, cz], [cx + sx * w(ay - 6), ay - 6, cz], kf); for (let k = 1; k <= 3; k++) addCell(cx + sx * half, ay - k, cz, "twr_w"); }   // 腕の下の支えと、がいし
    }
  }
  // 消防署: 赤い 2 階の車庫（口が 3 つ）＋うしろに白い火の見の塔（6 階・倒れる）
  function buildFire() {
    addHouse(gx(-8), gz(13), 32, 22, 2, 7, { wall: "fire", pillar: "firew", slab: "firew", roof: "parapet", winRows: [3, 4], door: null, doors: [[2, 9, 6], [12, 19, 6], [22, 29, 6]] });
    addHouse(gx(9.5), gz(19), 8, 8, 6, 6, { wall: "firew", pillar: "fire", slab: "fire", roof: "parapet", winRows: [3], door: [3, 4, 4], sink: true, topple: true });
    addFence(gx(-14), gz(10), 10, 2, "firew");
  }
  // 球場: ホームの後ろを囲む階段のスタンド（8 つに分かれる）＋照明塔 4 本（倒れる）
  function buildStadium() {
    const Hx = 0, Hz = 28, R0 = 9, D = 9, A = 110 * Math.PI / 180, NSEG = 8, NSL = 48;
    const segs = [], pcs = new Map(), cw = new B.Vector3(Hx, 0, Hz), Y = v => bld.origin.y + v * CELL;
    for (let i = 0; i < NSEG; i++) { newB(1, false); segs.push(curB); }
    // 見た目は扇の帯（段 1 つ×角度 5 度ずつ）。th はホームから見て +z が 0・+x が正。扇の角度 t = 90 度 − th
    const piece = (zone, sl, r0, r1, y0, y1, kind) => {
      const id = zone + "," + sl; if (pcs.has(id)) return pcs.get(id);
      const th0 = -A + sl * 2 * A / NSL, th1 = th0 + 2 * A / NSL;
      const r = newRod({ wedge: true, c: cw, r0, rad: r1, t0: Math.PI / 2 - th1, t1: Math.PI / 2 - th0, y0: Y(y0), y1: Y(y1), kind }); pcs.set(id, r); return r;
    };
    for (let x = gx(Hx - R0 - D - 1); x <= gx(Hx + R0 + D + 1); x++) for (let z = gz(Hz - 6); z <= gz(Hz + R0 + D + 1); z++) {
      const p = cellWorld(x, 0, z), dx = p.x - Hx, dz = p.z - Hz, r = Math.hypot(dx, dz), th = Math.atan2(dx, dz);
      if (Math.abs(th) > A || r < R0 - 0.5 || r > R0 + D + 0.5) continue;
      const seg = Math.min(NSEG - 1, Math.floor((th + A) / (2 * A) * NSEG)); curB = segs[seg];
      const sl = Math.min(NSL - 1, Math.floor((th + A) / (2 * A) * NSL));
      if (r < R0) { const pc = piece("f", sl, R0 - 0.7, R0, 0, 2, "conc"); rodCell(pc, x, 0, z, "conc"); rodCell(pc, x, 1, z, "conc"); continue; }             // 前の低い壁
      if (r > R0 + D) { const pc = piece("b", sl, R0 + D, R0 + D + 0.7, 0, 13, "conc"); for (let y = 0; y < 13; y++) rodCell(pc, x, y, z, "conc"); continue; }     // うしろの高い壁
      const st = Math.floor(r - R0), y = st + 1, kind = seg % 2 ? "seat2" : "seat", pc = piece("s" + st, sl, R0 + st, R0 + st + 1, st, st + 2, kind);
      rodCell(pc, x, y, z, kind); rodCell(pc, x, y - 1, z, "conc");
      if (st % 3 === 2 && Math.round(th * 12) % 3 === 0) for (let yy = 0; yy < y - 1; yy++) addCell(x, yy, z, "conc");   // 下の柱
    }
    for (const [wx, wz] of [[-20, 16], [20, 16], [-13, 44], [13, 44]]) {   // 照明塔: 1m 角の柱 26m＋上にライトの箱
      newB(6, true); curB.topple = true;
      const x = gx(wx), z = gz(wz);
      for (let y = 0; y < 52; y++) for (let a = 0; a < 2; a++) for (let b2 = 0; b2 < 2; b2++) addCell(x + a, y, z + b2, y > 46 ? "twr_w" : "conc");
      for (let y = 52; y < 58; y++) for (let a = -4; a < 6; a++) for (let b2 = 0; b2 < 2; b2++) addCell(x + a, y, z + b2, y === 52 || y === 57 || a === -4 || a === 5 ? "steelc" : (a + y) % 2 ? "lamp" : "twr_w");   // ライトの升目
    }
  }
  // 工場の煙突: れんがの筒（下 3m・上 2.2m の半径、高さ 44m、上 10m は赤白）＋横にトタンの工場
  function buildChimney(wx, wz) {
    const cx = gx(wx), cz = gz(wz), Hc = 88;
    newB(6, true); curB.topple = true;
    ringWall(cx, cz, 0, Hc - 20, y => 6 - 1.6 * y / Hc, 2, () => "brick", 6);
    ringWall(cx, cz, Hc - 20, Hc, y => 6 - 1.6 * y / Hc, 2, y => Math.floor(y / 5) % 2 ? "twr_w" : "twr_r", 5);
    addHouse(gx(-17), gz(14), 18, 14, 1, 9, TIN);
  }
  // 観覧車: 半径 13m の輪 2 枚＋スポーク 12 本＋ゴンドラ 12 個、A 字の脚 4 本。脚を削ると倒れる
  function buildWheel(wx, wz) {
    const cx = gx(wx), cz = gz(wz), hy = 36, R0 = 26, T = Math.PI * 2, fr = () => "twr_w";
    newB(6, true); curB.topple = true; curB.sinkR = 0.55;
    for (const dz of [0, 4]) {
      for (let a = 0; a < 96; a++) { const t1 = a / 96 * T, t2 = (a + 1) / 96 * T; lineCells([cx + R0 * Math.cos(t1), hy + R0 * Math.sin(t1), cz + dz], [cx + R0 * Math.cos(t2), hy + R0 * Math.sin(t2), cz + dz], fr); }
      for (let k = 0; k < 12; k++) { const t = k / 12 * T; lineCells([cx, hy, cz + dz], [cx + R0 * Math.cos(t), hy + R0 * Math.sin(t), cz + dz], fr); }
    }
    for (let z = -3; z <= 7; z++) for (let a = 0; a < 2; a++) for (let b2 = 0; b2 < 2; b2++) addCell(cx + a, hy + b2, cz + z, "steelc");   // 軸
    for (const zz of [cz - 3, cz + 6]) for (const sx of [-1, 1]) lineCells([cx + sx * 14, 0, zz], [cx, hy, zz], () => "fire", 2);
    for (let k = 0; k < 12; k++) {   // ゴンドラ: 輪と輪の間の棒から 1 マス吊るす
      const t = (k + 0.5) / 12 * T, px = Math.round(cx + R0 * Math.cos(t)), py = Math.round(hy + R0 * Math.sin(t));
      lineCells([px, py, cz], [px, py, cz + 4], fr); addCell(px, py - 1, cz + 2, "steelc");
      const col = ["g1", "g2", "g3", "g4"][k % 4];
      for (let x = -1; x <= 1; x++) for (let y = py - 4; y <= py - 2; y++) for (let z = cz + 1; z <= cz + 3; z++) addCell(px + x, y, z, col);
    }
  }
  // 給水塔: 開いた脚 4 本（筋交い付き）の上に 24m の高さで丸いタンク。脚を削ると倒れる
  function buildWaterTower(wx, wz) {
    const cx = gx(wx), cz = gz(wz), Hl = 48, w = y => 10 - 3 * y / Hl, kf = () => "steelc";
    newB(6, true); curB.topple = true; curB.sinkR = 0.55;
    const C = [[-1, -1], [1, -1], [1, 1], [-1, 1]], P = (i, y) => [cx + C[i][0] * w(y), y, cz + C[i][1] * w(y)];
    for (let i = 0; i < 4; i++) lineCells(P(i, 0), P(i, Hl), kf, 2);
    for (let y = 0; y < Hl; y += 12) for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; lineCells(P(i, y + 12), P(j, y + 12), kf); lineCells(P(i, y), P(j, y + 12), kf); lineCells(P(j, y), P(i, y + 12), kf); }
    const RT = 11;
    discCells(cx, cz, Hl, Hl + 1, RT, "tank");
    ringWall(cx, cz, Hl + 1, Hl + 6, () => RT, 1, () => "tank", 5);
    ringWall(cx, cz, Hl + 6, Hl + 8, () => RT, 1, () => "twr_r", 2);
    ringWall(cx, cz, Hl + 8, Hl + 13, () => RT, 1, () => "tank", 5);
    discCells(cx, cz, Hl + 13, Hl + 14, RT + 0.6, "tank");          // ふた（少しはみ出す）
    discCells(cx, cz, Hl + 14, Hl + 16, 2.5, "steelc");             // ふたの上の換気口
  }
  // ガソリンスタンド: 柱 4 本の大きな屋根（柱を削ると屋根が落ちて崩れる）＋給油機＋奥の売店＋値段の看板（倒れる）
  function buildGas() {
    const X0 = gx(-8), X1 = gx(8), Z0 = gz(13), Z1 = gz(21);
    newB(1, false);
    for (let x = X0; x < X1; x++) for (let z = Z0; z < Z1; z++) {
      const edge = x === X0 || x === X1 - 1 || z === Z0 || z === Z1 - 1;
      addCell(x, 12, z, edge ? "fire" : "twr_w");
      if (edge) { addCell(x, 11, z, "fire"); addCell(x, 10, z, "twr_w"); }
    }
    for (const [px, pz] of [[-5, 15], [5, 15], [-5, 19], [5, 19]]) for (let y = 0; y < 12; y++) for (let a = 0; a < 2; a++) for (let b2 = 0; b2 < 2; b2++) addCell(gx(px) + a, y, gz(pz) + b2, "conc");
    for (const [px, pz] of [[-2.5, 15], [2.5, 15], [-2.5, 19], [2.5, 19]]) { newB(1, false); for (let y = 0; y < 4; y++) for (let a = 0; a < 2; a++) addCell(gx(px) + a, y, gz(pz), y === 3 ? "twr_w" : "fire"); }
    addHouse(gx(-7), gz(25), 28, 10, 1, 8, { wall: "twr_w", pillar: "fire", slab: "twr_w", roof: "parapet", winRows: [2, 3, 4, 5], door: [12, 15, 6] });
    newB(6, true); curB.topple = true;
    const sx = gx(11), sz = gz(13);
    for (let y = 0; y < 24; y++) for (let a = 0; a < 2; a++) for (let b2 = 0; b2 < 2; b2++) addCell(sx + a, y, sz + b2, "steelc");
    for (let y = 24; y < 34; y++) for (let x = -3; x < 5; x++) for (let z = 0; z < 2; z++) addCell(sx + x, y, sz + z, y === 24 || y === 33 || x === -3 || x === 4 ? "twr_w" : "fire");
  }
  // 橋: 青い桁の 3 径間。真ん中の径間は 2 本の橋脚に載っていて、片方を削ると落ちる（sinkR 0.6）。両端は岸の壁につながる
  function buildBridge() {
    const Z0 = gz(19), Z1 = gz(25), XA = gx(-22), XB = gx(22), P1 = gx(-8), P2 = gx(8);
    const deck = (x0, x1) => { for (let x = x0; x < x1; x++) for (let z = Z0; z < Z1; z++) {
      addCell(x, 12, z, "conc"); addCell(x, 13, z, "conc");
      if (z === Z0 || z === Z1 - 1) { addCell(x, 10, z, "brg"); addCell(x, 11, z, "brg"); addCell(x, 14, z, "twr_w"); if (x % 3 === 0) addCell(x, 15, z, "twr_w"); }
    } };
    newB(1, false); deck(XA, P1 - 2); for (let x = XA; x < XA + 2; x++) for (let y = 0; y < 12; y++) for (let z = Z0; z < Z1; z++) addCell(x, y, z, "conc");
    newB(1, false); deck(P2 + 2, XB); for (let x = XB - 2; x < XB; x++) for (let y = 0; y < 12; y++) for (let z = Z0; z < Z1; z++) addCell(x, y, z, "conc");
    newB(6, true); curB.sinkR = 0.6; deck(P1 - 2, P2 + 2);
    for (const px of [P1, P2]) for (let x = px - 2; x < px + 2; x++) for (let y = 0; y < 10; y++) for (let z = Z0 + 1; z < Z1 - 1; z++) addCell(x, y, z, "conc");
  }
  // 球場のグラウンド（土の内野と芝の外野）。格子ではなく地面に置く板
  let fieldM = null;
  function stadiumField(on) {
    if (!fieldM) {
      const dirt = new B.StandardMaterial("fieldDirt", scene); dirt.diffuseColor = new B.Color3(0.72, 0.5, 0.34); dirt.specularColor = B.Color3.Black();
      const turf = new B.StandardMaterial("fieldTurf", scene); turf.diffuseColor = new B.Color3(0.34, 0.62, 0.3); turf.specularColor = B.Color3.Black();
      const lineM = new B.StandardMaterial("fieldLine", scene); lineM.diffuseColor = new B.Color3(0.95, 0.95, 0.92); lineM.specularColor = B.Color3.Black();
      const Hx = 0, Hz = 28, mk = [];
      const fan = B.MeshBuilder.CreateDisc("fieldTurf", { radius: 34, arc: 0.25, tessellation: 48 }, scene);   // 外野: ホームから手前（-z）へ 90 度の扇
      fan.rotation.x = Math.PI / 2; fan.rotation.y = Math.PI * 0.75; fan.position.set(Hx, 0.03, Hz); fan.material = turf; mk.push(fan);
      const inf = B.MeshBuilder.CreateGround("fieldDirt", { width: 15, height: 15 }, scene);   // 内野: 菱形
      inf.rotation.y = Math.PI / 4; inf.position.set(Hx, 0.05, Hz - 10.6); inf.material = dirt; mk.push(inf);
      for (const sx of [-1, 1]) { const l = B.MeshBuilder.CreateGround("fieldLine", { width: 0.2, height: 34 }, scene); l.rotation.y = -sx * Math.PI / 4; l.position.set(Hx + sx * 12, 0.07, Hz - 12); l.material = lineM; mk.push(l); }
      for (const m of mk) { m.receiveShadows = true; m.isPickable = false; m.material.backFaceCulling = false; }
      fieldM = mk;
    }
    for (const m of fieldM) m.setEnabled(on);
  }
  // 箱を格子で積む（x1・y1・z1 は含まない。hollow なら外の壁だけ。kind は関数でもよい）
  function box(x0, x1, y0, y1, z0, z1, kind, hollow) {
    for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++)
      if (!hollow || x === x0 || x === x1 - 1 || z === z0 || z === z1 - 1) addCell(x, y, z, typeof kind === "function" ? kind(x, y, z) : kind);
  }
  // 学校: 3 階の長い校舎＋前に時計の塔（倒れる）＋右手前に体育館
  function buildSchool() {
    addHouse(gx(-16), gz(19), 64, 14, 3, 6, { wall: "wall", pillar: "pillar", slab: "slab", roof: "parapet", winRows: [2, 3, 4], door: [28, 35, 5], sink: true });
    addHouse(gx(-2), gz(15.5), 8, 7, 5, 6, { wall: "twr_w", pillar: "brick", slab: "brick", roof: "gable", winRows: [3], door: [3, 4, 4], sink: true, topple: true });
    addHouse(gx(12), gz(6), 20, 16, 1, 12, { wall: "tin", pillar: "steelc", slab: "tinroof", roof: "gable", winRows: [8, 9], door: [8, 11, 6] });
  }
  // お城: 石がきの上に白い壁の 3 段（段ごとに黒い屋根が張り出す）。石がきを削ると丸ごと沈む
  function buildCastle(wx, wz) {
    const cx = gx(wx), cz = gz(wz);
    newB(4, true);
    box(cx - 14, cx + 14, 0, 8, cz - 11, cz + 11, "block", true); box(cx - 14, cx + 14, 7, 8, cz - 11, cz + 11, "block");
    const wall = y0 => (x, y, z) => (y - y0) % 7 === 3 && (x + z) % 4 === 0 ? "roof" : "twr_w";   // 白壁に黒い窓
    const tiers = [[11, 8, 8, 16], [8, 6, 17, 24], [5, 4, 25, 31]];
    for (const [hx, hz, y0, y1] of tiers) {
      box(cx - hx, cx + hx, y0, y1, cz - hz, cz + hz, wall(y0), true);
      box(cx - hx - 2, cx + hx + 2, y1, y1 + 1, cz - hz - 2, cz + hz + 2, "roof");
      box(cx - hx - 1, cx + hx + 1, y1 + 1, y1 + 2, cz - hz - 1, cz + hz + 1, "roof");   // 屋根を 2 段にして厚みを出す（次の段の壁が上書きする）
    }
    box(cx - 5, cx + 5, 32, 34, cz - 1, cz + 1, "roof");
    for (const sx of [-1, 1]) box(cx + sx * 5 - (sx > 0 ? 1 : 0), cx + sx * 5 + (sx > 0 ? 0 : 1), 34, 36, cz - 1, cz + 1, "g2");   // しゃちほこ（金）
  }
  // タワークレーン: 黄色い格子のマスト 36m＋長い腕と短い腕（おもり）＋運転室＋吊り荷。マストの脚を削ると倒れる
  function buildTowerCrane(wx, wz) {
    const cx = gx(wx), cz = gz(wz), H = 72, kf = () => "g2", ks = () => "steelc";
    newB(1, false); box(cx - 5, cx + 5, 0, 2, cz - 5, cz + 5, "conc");
    newB(6, true); curB.topple = true; curB.sinkR = 0.6;
    const C = [[-2, -2], [2, -2], [2, 2], [-2, 2]];
    for (const [a, b] of C) lineCells([cx + a, 2, cz + b], [cx + a, H, cz + b], kf);
    for (let y = 2; y < H; y += 6) for (let i = 0; i < 4; i++) { const [a, b] = C[i], [c, d] = C[(i + 1) % 4], y2 = Math.min(H, y + 6); lineCells([cx + a, y2, cz + b], [cx + c, y2, cz + d], kf); lineCells([cx + a, y, cz + b], [cx + c, y2, cz + d], kf); }
    const J0 = cx - 18, J1 = cx + 44, top = x => H + 5 - 4 * (x - cx) / (J1 - cx);
    for (const b of [-2, 2]) lineCells([J0, H, cz + b], [J1, H, cz + b], kf);
    lineCells([cx, H + 5, cz], [J1, top(J1), cz], kf);
    for (let x = cx + 2; x < J1 - 3; x += 6) for (const b of [-2, 2]) { lineCells([x, H, cz + b], [x + 3, top(x + 3), cz], kf); lineCells([x + 3, top(x + 3), cz], [x + 6, H, cz + b], kf); }
    for (const [a, b] of C) lineCells([cx + a, H, cz + b], [cx, H + 14, cz], kf);
    lineCells([cx, H + 14, cz], [cx + 26, top(cx + 26), cz], ks); lineCells([cx, H + 14, cz], [J0 + 2, H + 1, cz], ks);
    box(J0, J0 + 5, H - 6, H, cz - 3, cz + 3, "conc");                 // おもり
    box(cx + 3, cx + 7, H - 5, H, cz - 3, cz + 2, "twr_w");            // 運転室
    lineCells([cx + 36, H - 34, cz], [cx + 36, H - 1, cz], ks);
    box(cx + 35, cx + 38, H - 37, H - 34, cz - 1, cz + 2, "twr_r");     // 吊り荷
  }
  // 五重塔: 石の台の上に 5 段（赤い柱・白い壁）、段ごとに黒い屋根が大きく張り出す。てっぺんに相輪。根元を削ると倒れる
  function buildPagoda(wx, wz) {
    const cx = gx(wx), cz = gz(wz);
    newB(4, true); curB.topple = true; curB.sinkR = 0.5;
    box(cx - 10, cx + 10, 0, 2, cz - 10, cz + 10, "block", true); box(cx - 10, cx + 10, 1, 2, cz - 10, cz + 10, "block");
    for (let i = 0; i < 5; i++) {
      const h = 7 - i, y0 = 2 + i * 7;
      box(cx - h, cx + h, y0, y0 + 5, cz - h, cz + h, (x, y, z) => Math.abs(x - cx + 0.5) > h - 1 && Math.abs(z - cz + 0.5) > h - 1 || y === y0 + 4 ? "fire" : "firew", true);
      box(cx - h - 3, cx + h + 3, y0 + 5, y0 + 6, cz - h - 3, cz + h + 3, "roof");
      box(cx - h - 1, cx + h + 1, y0 + 6, y0 + 7, cz - h - 1, cz + h + 1, "roof");
    }
    lineCells([cx - 0.5, 37, cz - 0.5], [cx - 0.5, 54, cz - 0.5], () => "brg");   // 相輪
    for (const y of [41, 44, 47, 50]) discCells(cx, cz, y, y + 1, 1.6, "brg");
  }
  const KIND_COL = { wall: [1, 0.98, 0.94], slab: [0.78, 0.78, 0.78], pillar: [0.9, 0.88, 0.85],   // 写真素材に掛ける色（壁・床・柱で少し変える）
    wood: [0.78, 0.55, 0.34], beam: [0.5, 0.33, 0.2], wfloor: [0.62, 0.48, 0.36], roof: [0.3, 0.33, 0.42],      // 木造の家（茶色の板壁・こげ茶の柱・紺の瓦）
    block: [0.86, 0.84, 0.76], tin: [0.62, 0.72, 0.8], steelc: [0.5, 0.55, 0.6], tinroof: [0.66, 0.36, 0.3],     // ブロック塀・トタンの倉庫（水色の壁・赤さびの屋根）
    prefab: [0.95, 0.92, 0.75],                                                                                    // プレハブ小屋（クリーム色）
    twr_r: [0.86, 0.22, 0.16], twr_w: [0.95, 0.95, 0.93], fire: [0.8, 0.13, 0.1], firew: [0.96, 0.95, 0.92],      // 鉄塔（赤白）・消防署（赤と白）
    seat: [0.2, 0.42, 0.85], seat2: [0.95, 0.55, 0.15], conc: [0.8, 0.79, 0.77], brick: [0.66, 0.38, 0.27],      // 球場の席（青・橙）・コンクリ・煙突のれんが
    g1: [0.95, 0.42, 0.6], g2: [0.98, 0.82, 0.22], g3: [0.36, 0.8, 0.42], g4: [0.3, 0.74, 0.95], tank: [0.64, 0.79, 0.87], brg: [0.22, 0.45, 0.76],
    lamp: [1.25, 1.2, 0.95] };   // 観覧車のゴンドラ 4 色・給水塔のタンク・橋の桁・照明のライト（明るめ）
  const FACE = [
    { n: [1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] }, { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] }, { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0] }];
  const TEXM = 4;     // 写真素材 1 枚が何 m 四方か
  const QUAD = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  // 格子 c の面 f を 1 枚足す（sc: 模様の大きさ m・dim: 暗さ）
  function pushFace(c, f, k, vary, sc, dim, pos, nor, uv, col, idx) {
    const b = pos.length / 3, h = CELL / 2;
    for (const [su, sv] of QUAD) {
      const px = c.p.x + (f.n[0] + f.u[0] * su + f.v[0] * sv) * h, py = c.p.y + (f.n[1] + f.u[1] * su + f.v[1] * sv) * h, pz = c.p.z + (f.n[2] + f.u[2] * su + f.v[2] * sv) * h;
      pos.push(px, py, pz); nor.push(f.n[0], f.n[1], f.n[2]);
      uv.push((px * f.u[0] + py * f.u[1] + pz * f.u[2]) / sc, (px * f.v[0] + py * f.v[1] + pz * f.v[2]) / sc);
      col.push(k[0] * vary * dim, k[1] * vary * dim, k[2] * vary * dim, 1);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  function buildChunk(ch) {
    const pos = [], nor = [], uv = [], col = [], idx = [], h = CELL / 2;
    const bp = [], bn = [], bu = [], bc = [], bi = [], bars = [];
    for (const c of ch.cells) {
      if (c.hid) continue;                 // なめらかな部材の中の格子（絵は rodMesh）
      const k = KIND_COL[c.kind], vary = 0.94 + ((c.x * 7 + c.y * 13 + c.z * 5) % 7) * 0.012;
      for (const f of FACE) {
        const nk = key(c.x + f.n[0], c.y + f.n[1], c.z + f.n[2]), nc = bld.cells.get(nk);
        if (nc && !nc.hid) continue;     // 隣が埋まっている面は見えない
        if (!nc && bld.orig && bld.orig.has(nk)) {   // 壊れた断面
          pushFace(c, f, k, vary, 1.4, 1, bp, bn, bu, bc, bi);
          // 鉄筋: 面ごとに 0〜2 本、少し曲がって飛び出す（位置は格子の座標から決まるので毎回同じ）
          const hsh = Math.abs((c.x * 73856093) ^ (c.y * 19349663) ^ (c.z * 83492791) ^ (f.n[0] * 3 + f.n[1] * 5 + f.n[2] * 7)) % 1000;
          const nb = hsh % 3; if (bars.length < 400)
          for (let j = 0; j < nb; j++) {
            const o1 = ((hsh >> (j * 2)) % 5 - 2) * 0.09, o2 = (((hsh * 7) >> j) % 5 - 2) * 0.09, L = 0.15 + ((hsh * (j + 3)) % 30) / 100;
            const dir = new B.Vector3(f.n[0] + f.u[0] * o2 * 1.5 + f.v[0] * -0.25 * j, f.n[1] + f.u[1] * o2 * 1.5 + f.v[1] * -0.25 * j, f.n[2] + f.u[2] * o2 * 1.5 + f.v[2] * -0.25 * j).normalize();
            const base = new B.Vector3(c.p.x + (f.n[0] * h + (f.u[0] * o1 + f.v[0] * o2)), c.p.y + (f.n[1] * h + (f.u[1] * o1 + f.v[1] * o2)), c.p.z + (f.n[2] * h + (f.u[2] * o1 + f.v[2] * o2)));
            B.Quaternion.FromUnitVectorsToRef(_yUp, dir, _rq);
            bars.push(B.Matrix.Compose(new B.Vector3(1, L, 1), _rq, base.add(dir.scale(L / 2 - 0.03))));
          }
          continue;
        }
        pushFace(c, f, k, vary, TEXM, f.n[1] < 0 ? 0.7 : 1, pos, nor, uv, col, idx);   // 内側（床の裏）は少し暗く
      }
    }
    ch.bars = bars;
    // 窓ガラスと窓枠: 窓の穴の上と下の壁が残っている時だけ
    const frames = [], pp = [], pn = [];
    for (const w of ch.wins) {
      const [x, y, z, ax, sg] = w.split(","), X = +x, Y = +y, Z = +z;
      if (!bld.cells.has(key(X, Y - 1, Z)) && !bld.cells.has(key(X, Y + 1, Z))) continue;
      if (!bld.cells.has(key(X, Y + 1, Z)) && !bld.cells.has(key(X, Y + 2, Z)) && !bld.cells.has(key(X, Y - 1, Z))) continue;
      const p = cellWorld(X, Y, Z);
      const u = ax === "z" ? [h, 0, 0] : [0, 0, h], n = ax === "z" ? [0, 0, 1] : [1, 0, 0];
      // 窓枠: 格子 1 つ（0.5m 四方）の上下左右に細い枠
      const T = 0.05, Dp = 0.12;
      for (const [ox, oy, w, hh] of [[0, h - T / 2, CELL, T], [0, -h + T / 2, CELL, T], [h - T / 2, 0, T, CELL], [-h + T / 2, 0, T, CELL]])
        frames.push(B.Matrix.Compose(ax === "z" ? new B.Vector3(w, hh, Dp) : new B.Vector3(Dp, hh, w), B.Quaternion.Identity(), new B.Vector3(p.x + (ax === "z" ? ox : 0), p.y + oy, p.z + (ax === "z" ? 0 : ox))));
      // 窓の下の水切り（外へ少し出る）
      if (bld.cells.has(key(X, Y - 1, Z)) && !winSet.has(sk(X, Y - 1, Z) + "," + ax + "," + sg)) {
        const out = +sg * 0.3;   // 外へ出す向き（家ごとに違うので窓を作った時に覚えておく）
        frames.push(B.Matrix.Compose(ax === "z" ? new B.Vector3(CELL + 0.02, 0.05, 0.22) : new B.Vector3(0.22, 0.05, CELL + 0.02), B.Quaternion.Identity(), new B.Vector3(p.x + (ax === "x" ? out : 0), p.y - h - 0.02, p.z + (ax === "z" ? out : 0))));
      }
      if ((X * 7 + Y * 3 + Z * 5) % 5 === 0) continue;     // 割れてガラスの無い窓
      for (const [su, sv] of QUAD) { pp.push(p.x + u[0] * su, p.y + sv * h, p.z + u[2] * su); pn.push(...n); }
    }
    ch.frames = []; ch.pp = pp; ch.pn = pn;
    const m = ch.mesh;
    // 空の形を渡すと WebGPU の影の描画が止まる（古い数のまま描こうとする）ので、空なら隠すだけ
    if (!idx.length && !bi.length) { m.setEnabled(false); setPanes(ch); return; }
    const nMain = idx.length, off = pos.length / 3;
    for (let i = 0; i < bp.length; i++) pos.push(bp[i]);
    for (let i = 0; i < bn.length; i++) nor.push(bn[i]);
    for (let i = 0; i < bu.length; i++) uv.push(bu[i]);
    for (let i = 0; i < bc.length; i++) col.push(bc[i]);
    for (let i = 0; i < bi.length; i++) idx.push(bi[i] + off);
    const vd = new B.VertexData(); vd.positions = pos; vd.normals = nor; vd.uvs = uv; vd.colors = col; vd.indices = idx;
    vd.applyToMesh(m, false);
    const nv = pos.length / 3; m.subMeshes = [];
    if (nMain) new B.SubMesh(0, 0, nv, 0, nMain, m);
    if (bi.length) new B.SubMesh(1, 0, nv, nMain, bi.length, m);
    m.setEnabled(true);
    // 窓ガラスは塊ごとに 1 つのメッシュ（街全体を 1 つにまとめると、壊すたびに全部を組み直して重い）
    setPanes(ch);
  }
  // 壊れた塊だけ組み直す。鉄筋・窓枠・ガラスは全部の塊のをまとめて 1 回で描く
  function rebuildCellMesh() {
    if (rodDirty) rebuildRods();
    let n = 0;
    for (const ch of chunks.values()) if (ch.dirty && !ch.far) { ch.dirty = false; buildChunk(ch); n++; }   // 遠くの塊は近づいた時に作り直す
    if (n) { const bars = []; for (const ch of chunks.values()) if (ch.bars.length && ch.mesh.isEnabled()) for (const m of ch.bars) { if (bars.length >= 1200) break; bars.push(m); } setThin(rebar, bars); }
    return n;
  }
  function setPanes(ch) {
    const pp = ch.pp || [];
    if (!pp.length) { if (ch.pane) ch.pane.setEnabled(false); return; }
    if (!ch.pane) { ch.pane = new B.Mesh("pane", scene); ch.pane.material = paneM; ch.pane.isPickable = false; ch.pane.freezeWorldMatrix(); }
    const pi = []; for (let i = 0; i < pp.length / 12; i++) { const b = i * 4; pi.push(b, b + 1, b + 2, b, b + 2, b + 3); }
    const pv = new B.VertexData(); pv.positions = pp; pv.normals = ch.pn; pv.indices = pi; pv.applyToMesh(ch.pane, false); ch.pane.setEnabled(true);
    const was = ch.paneN || 0; ch.paneN = pp.length / 12;
    if (ch.paneN < was && ch.paneC) glassBurst(ch.paneC, was - ch.paneN);   // 窓が割れた: キラキラ
    ch.paneC = new B.Vector3(pp[0], pp[1], pp[2]);
  }
  const NBD = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0, 2, 0], [0, -2, 0]];
  function removeCell(c) {
    if (bld.cells.get(key(c.x, c.y, c.z)) !== c) return;   // もう消えている（部材の巻き添えで先に消えた等）
    bld.cells.delete(key(c.x, c.y, c.z));
    const ch = chunkOf(c.x, c.y, c.z, false); if (ch) { ch.cells.delete(c); ch.dirty = true; }
    for (const d of NBD) { const n = chunkOf(c.x + d[0], c.y + d[1], c.z + d[2], false); if (n) n.dirty = true; }   // 隣の塊の面・窓も変わる
    if (c.b) { c.b.cells.delete(c); if (c.y < c.b.baseY) c.b.baseN--; dirtyB.add(c.b); }
    // 部材の区間: 1 マス削れたら区間の絵を消し、ほかの区間に属さない残りの格子も消す（見えない格子が支えに残らないように）
    if (c.segs) for (const r of c.segs) if (r.alive) {
      r.alive = false; rodDirty = true;
      for (const o of r.cells) if (o !== c && o.segs.every(q => !q.alive)) removeCell(o);
    }
  }
  // p の周り（x ±rx・z ±rz・高さ ymax まで）に格子があるか（全部の格子を調べずに、その辺りの番号だけ見る）
  function cellsNear(p, rx, rz, ymax) {
    const x0 = Math.ceil((p.x - rx - bld.origin.x) / CELL - 0.5), x1 = Math.floor((p.x + rx - bld.origin.x) / CELL - 0.5);
    const z0 = Math.ceil((p.z - rz - bld.origin.z) / CELL - 0.5), z1 = Math.floor((p.z + rz - bld.origin.z) / CELL - 0.5);
    const y1 = Math.floor((ymax - bld.origin.y) / CELL - 0.5);
    for (let y = 0; y <= y1; y++) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (bld.cells.has(key(x, y, z))) return true;
    return false;
  }

  // 地面(y=0)につながっていない格子を探す（壊した建物の中だけ）
  const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  function floatingCells() {
    const out = [];
    for (const b of dirtyB) {
      const seen = new Set(), q = [];
      for (const c of b.cells) if (c.y === 0) { seen.add(c); q.push(c); }
      while (q.length) {
        const c = q.pop();
        for (const d of N6) { const n = bld.cells.get(key(c.x + d[0], c.y + d[1], c.z + d[2])); if (n && n.b === b && !seen.has(n)) { seen.add(n); q.push(n); } }
      }
      for (const c of b.cells) if (!seen.has(c)) out.push(c);
    }
    dirtyB.clear();
    return out;
  }
  // 沈むように崩れる: 大きな建物（または大きな浮いた塊）を 1 つのメッシュにして、地面へ沈めながら瓦礫と粉塵を出す
  // （2 万格子を全部瓦礫にすると物理が止まる。iPad でも動く重さにする 10-16）
  const sinks = [], fading = [];
  function sinkSet(list) {
    const set = new Set(list), pos = [], nor = [], uv = [], col = [], idx = [];
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, y0 = 1e9, y1 = -1e9; const kinds = {};
    for (const c of list) {
      x0 = Math.min(x0, c.p.x); x1 = Math.max(x1, c.p.x); z0 = Math.min(z0, c.p.z); z1 = Math.max(z1, c.p.z); y0 = Math.min(y0, c.p.y); y1 = Math.max(y1, c.p.y);
      kinds[c.kind] = (kinds[c.kind] || 0) + 1;
      const k = KIND_COL[c.kind], vary = 0.94 + ((c.x * 7 + c.y * 13 + c.z * 5) % 7) * 0.012;
      if (c.hid) continue;
      for (const f of FACE) { const n = bld.cells.get(key(c.x + f.n[0], c.y + f.n[1], c.z + f.n[2])); if (n && set.has(n) && !n.hid) continue; pushFace(c, f, k, vary, TEXM, f.n[1] < 0 ? 0.7 : 1, pos, nor, uv, col, idx); }
    }
    { const rs = new Set(); for (const c of list) if (c.segs) for (const r of c.segs) if (r.alive) rs.add(r); for (const r of rs) pushRod(r, pos, nor, uv, col, idx); }   // なめらかな部材も同じ塊に
    // 窓ガラスも一緒に沈める（無いと窓が全部 穴に見えた）
    const pp = [], pn = [], pi = [], h2 = CELL / 2;
    for (const w of winSet) {
      const [x, y, z, ax] = w.split(","), X = +x, Y = +y, Z = +z, up = bld.cells.get(key(X, Y + 1, Z)), dn = bld.cells.get(key(X, Y - 1, Z));
      if (!(up && set.has(up)) && !(dn && set.has(dn))) continue;
      const q = cellWorld(X, Y, Z), b = pp.length / 3, u = ax === "z" ? [h2, 0, 0] : [0, 0, h2];
      for (const [su, sv] of QUAD) { pp.push(q.x + u[0] * su, q.y + sv * h2, q.z + u[2] * su); pn.push(ax === "z" ? 0 : 1, 0, ax === "z" ? 1 : 0); }
      pi.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    for (const c of list) removeCell(c);
    if (!idx.length) return;
    sinkValue(list.length);
    const m = new B.Mesh("sink", scene), vd = new B.VertexData(); vd.positions = pos; vd.normals = nor; vd.uvs = uv; vd.colors = col; vd.indices = idx; vd.applyToMesh(m, false);
    m.material = bldM; m.receiveShadows = true; m.isPickable = false; shadow.addShadowCaster(m);
    if (pi.length) { const g = new B.Mesh("sinkPane", scene), pv = new B.VertexData(); pv.positions = pp; pv.normals = pn; pv.indices = pi; pv.applyToMesh(g, false); g.material = paneM; g.parent = m; g.isPickable = false; }
    const h = CELL / 2; m.setPivotPoint(new B.Vector3((x0 + x1) / 2, y0 - h, (z0 + z1) / 2));
    const kind = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0][0];
    if (!G.fixedDt) hitStop = 0.16;   // 沈み始めの一瞬のため（10-24 改善ループ 軸5）
    // 崩れ方は 2 通り: 下へ崩れ落ちる／横へバターンと倒れる（高い建物は半々。塔はいつも倒れる 10-30 本人）
    const top = !!(list[0].b && list[0].b.topple) || (y1 - y0 > 8 && Math.random() < 0.5), cxw = (x0 + x1) / 2, czw = (z0 + z1) / 2;
    let fdx = cxw - ex.pos.x, fdz = czw - ex.pos.z; const fl0 = Math.hypot(fdx, fdz) || 1; fdx /= fl0; fdz /= fl0;   // 倒れる向き: ショベルから見て向こうへ
    if (Math.abs(fdx) > Math.abs(fdz)) { fdx = Math.sign(fdx); fdz = 0; } else { fdz = Math.sign(fdz); fdx = 0; }   // 建物の面に沿って倒す（斜めだと根元が浮いて見えた）
    let cx = cxw, cz = czw, W = 0;
    if (top) {   // 倒れる側の根元の角を軸にする
      cx = cxw + fdx * (x1 - x0 + CELL) / 2; cz = czw + fdz * (z1 - z0 + CELL) / 2; W = fdx ? z1 - z0 + CELL : x1 - x0 + CELL;
      m.setPivotPoint(new B.Vector3(cx, y0 - h, cz));
    }
    sinks.push({ m, v: 0, d: 0, y0: y0 - h, H: y1 - y0 + CELL, x0: x0 - h, x1: x1 + h, z0: z0 - h, z1: z1 + h, total: Math.min(top ? 200 : 150, Math.max(6, Math.round(list.length / (top ? 40 : 90)))), made: 0,
      tx: (Math.random() - 0.5) * 0.14, tz: (Math.random() - 0.5) * 0.14, snd: 0, dT: 0, kind, top, ang: 0, av: 0, fdx, fdz, cr: 0, cx, cz, W, topT: 0 });
    crash(1); shake(1); flash(0.6, true); cloudAt({ x0, x1, z0, z1 }, list.length > 4000 ? 70 : 25); playS("boom", 0.6, 0.7, 0.35); playS("glass", 0.55, 0.9, 0.15); playS("glass", 0.45, 1.1, 0.3);   // 沈み始めに足元から雲を一気に吹き出す
    for (const k of [0.3, 0.6, 0.9, 1.2]) setTimeout(() => { shake(0.35); playS(k < 0.7 ? "impact" : "rubble_dump", 0.25, 0.8 + Math.random() * 0.2); }, k * 1000);   // 揺れの余韻
    popup(top ? "たおれるぞー！！" : list.length > 4000 ? "ドドドドド…!! たおれる！" : "ガラガラガラ…！", "big");
  }
  // 倒れる物（鉄塔・煙突・照明塔・火の見の塔）: 根元を軸にだんだん速く傾き、地面に着いたら一気に崩れる
  function updateTopple(q, i, dt) {
    if (!q.landed) {
      q.av += dt * (0.35 + q.ang * 2.6); q.ang = Math.min(1.5, q.ang + q.av * dt);
      q.m.rotation.x = q.ang * q.fdz; q.m.rotation.z = -q.ang * q.fdx;
      if ((q.cr -= dt) <= 0) { q.cr = 0.4; playS("bolt_impact", 0.2, 0.6 + q.ang * 0.2); shake(0.1 + q.ang * 0.1); }   // ギギギ（傾くほど高く）
      if (q.ang < 1.5) return;
      q.landed = true; q.t = 0;
      const col = KIND_COL[q.kind], L = q.H;
      if (!G.fixedDt) hitStop = 0.14;
      crash(1); shake(1); flash(0.55, true); playS("boom", 0.7, 0.75); playS("impact", 0.6, 0.7, 0.05); playS("rubble_dump", 0.6, 0.9, 0.2);
      popup("ズドーン!!", "big"); toppleHit(q);   // 倒れた先の建物・車・ゾンビも壊す（ドミノ）
      for (let k = 0; k < q.total; k++) {
        const t = Math.random(), side = (Math.random() - 0.5) * 3;
        const p = new B.Vector3(q.cx + q.fdx * t * L - q.fdz * side, 0.6 + Math.random() * 1.2, q.cz + q.fdz * t * L + q.fdx * side);
        spawnDebris(p, new B.Vector3(0.7 + Math.random() * 0.6, 0.45 + Math.random() * 0.4, 0.7 + Math.random() * 0.6), col, new B.Vector3((Math.random() - 0.5) * 3, 1 + Math.random() * 2, (Math.random() - 0.5) * 3));
      }
      for (let k = 0; k <= 6; k++) { const t = k / 6, dp = new B.Vector3(q.cx + q.fdx * t * L, 0.6, q.cz + q.fdz * t * L); setTimeout(() => dust(dp, 34), k * 60); }
      const ex0 = Math.min(q.cx, q.cx + q.fdx * L), ex1 = Math.max(q.cx, q.cx + q.fdx * L), ez0 = Math.min(q.cz, q.cz + q.fdz * L), ez1 = Math.max(q.cz, q.cz + q.fdz * L);
      cloudAt({ x0: ex0 - 2, x1: ex1 + 2, z0: ez0 - 2, z1: ez1 + 2 }, 50);
      return;
    }
    // 倒れた後: 0.6 秒は横たわったまま、体の全長から破片が跳ね上がる（バターン）。そのあと地面へ沈めて消す
    q.t += dt;
    if (q.t < 0.6) {
      if ((q.dT -= dt) <= 0) {
        q.dT = 0.05; const col = KIND_COL[q.kind], side = new B.Vector3(-q.fdz, 0, q.fdx), Wd = q.W || 4;
        for (let j = 0; j < 4; j++) {
          const t = Math.random() * q.H, s = (Math.random() - 0.5) * Wd, p = new B.Vector3(q.cx + q.fdx * t + side.x * s, 0.5 + Math.random() * Math.min(6, Wd * 0.6), q.cz + q.fdz * t + side.z * s);
          spawnDebris(p, new B.Vector3(0.6 + Math.random() * 0.9, 0.4 + Math.random() * 0.5, 0.6 + Math.random() * 0.9), col, side.scale(s * 0.8).addInPlaceFromFloats(q.fdx * 3, 3 + Math.random() * 5, q.fdz * 3));
        }
        dust(new B.Vector3(q.cx + q.fdx * Math.random() * q.H, 1, q.cz + q.fdz * Math.random() * q.H), 30);
      }
      return;
    }
    q.m.position.y = -(q.t - 0.6) * 2.4;
    if (q.t > 1.8) { q.m.dispose(); sinks.splice(i, 1); }
  }
  function updateSinks(dt) {
    for (let i = sinks.length - 1; i >= 0; i--) {
      if (sinks[i].top) { updateTopple(sinks[i], i, dt); continue; }
      const q = sinks[i], air = q.y0 - q.d > 0.5;           // 浮いた塊はまず落ちる
      q.v = Math.min(q.v + dt * (air ? 9.8 : 4), air ? 20 : 9); q.d += q.v * dt;
      q.m.position.y = -q.d;
      const k = Math.min(1, q.d / q.H); q.m.rotation.x = q.tx * k; q.m.rotation.z = q.tz * k;
      const under = q.d - q.y0;                              // 地面より下へ入った深さ
      // 上の方から破片がバラーンと飛び散る（沈み始めから、今の屋上の高さで）
      const topY = q.y0 + q.H - q.d;
      if (topY > 2 && (q.topT -= dt) <= 0) {
        q.topT = 0.07; const col = KIND_COL[q.kind], cxm = (q.x0 + q.x1) / 2, czm = (q.z0 + q.z1) / 2;
        for (let j = 0; j < 2; j++) {
          const p = new B.Vector3(q.x0 + Math.random() * (q.x1 - q.x0), topY - Math.random() * 2, q.z0 + Math.random() * (q.z1 - q.z0));
          const out = new B.Vector3(p.x - cxm, 0, p.z - czm).normalize().scale(3 + Math.random() * 5);
          spawnDebris(p, new B.Vector3(0.6 + Math.random() * 0.8, 0.4 + Math.random() * 0.5, 0.6 + Math.random() * 0.8), col, out.addInPlaceFromFloats(0, 2 + Math.random() * 4, 0));
        }
        if (Math.random() < 0.4) dust(new B.Vector3(cxm, topY, czm), 20);
      }
      if (under > 0) {
        const want = Math.min(q.total, Math.ceil(under / q.H * q.total));
        const col = KIND_COL[q.kind];
        while (q.made < want) {
          q.made++;
          const p = new B.Vector3(q.x0 - 1 + Math.random() * (q.x1 - q.x0 + 2), 1 + Math.random() * 2.5, q.z0 - 1 + Math.random() * (q.z1 - q.z0 + 2));
          const out = new B.Vector3(p.x - (q.x0 + q.x1) / 2, 0, p.z - (q.z0 + q.z1) / 2).normalize().scale(1.5 + Math.random() * 2.5);
          spawnDebris(p, new B.Vector3(0.9 + Math.random() * 0.7, 0.55 + Math.random() * 0.5, 0.9 + Math.random() * 0.7), col, out.addInPlaceFromFloats(0, 1.5, 0));
        }
        if ((q.dT -= dt) <= 0) { q.dT = 0.14; dust(new B.Vector3(q.x0 + Math.random() * (q.x1 - q.x0), 0.5, q.z0 + Math.random() * (q.z1 - q.z0)), 22); cloudAt(q, q.H > 20 ? (LITE ? 6 : 8) : 3); }
        if ((q.snd -= dt) <= 0) { q.snd = 0.5; crash(0.8); shake(0.3); }
      }
      if (under > q.H + 0.5) { q.m.dispose(); sinks.splice(i, 1); flash(0.35); shake(0.5); playS("rubble_dump", 0.7); playS("impact", 0.5, 0.7); for (let j = 0; j < 4; j++) { const dp = new B.Vector3(q.x0 + Math.random() * (q.x1 - q.x0), 0.6, q.z0 + Math.random() * (q.z1 - q.z0)); setTimeout(() => dust(dp, 30), j * 110); } }
    }
  }
  // 沈む時の大きな土けむり（粒は大きく・長く残る。1 つだけ作って使い回す）
  let cloud = null;
  function cloudAt(q, n) {
    if (!cloud) {
      cloud = new B.ParticleSystem("cloud", LITE ? 120 : 240, scene); cloud.particleTexture = dustTex;
      cloud.color1 = new B.Color4(0.66, 0.61, 0.54, 0.62); cloud.color2 = new B.Color4(0.56, 0.52, 0.46, 0.52); cloud.colorDead = new B.Color4(0.6, 0.56, 0.5, 0);
      cloud.addSizeGradient(0, 4, 7); cloud.addSizeGradient(1, 18, 28); cloud.minLifeTime = 3; cloud.maxLifeTime = 5.5; cloud.emitRate = 0; cloud.manualEmitCount = 0;   // 大きさ・寿命: 外から見ると根元に少ししか見えなかった（10-25 改善ループ 2）
      cloud.blendMode = B.ParticleSystem.BLENDMODE_STANDARD; cloud.gravity = new B.Vector3(0, 0.3, 0);
      cloud.direction1 = new B.Vector3(-2, 0.4, -2); cloud.direction2 = new B.Vector3(2, 2.2, 2); cloud.minEmitPower = 2; cloud.maxEmitPower = 5;
      cloud.minAngularSpeed = -0.3; cloud.maxAngularSpeed = 0.3; cloud.maxInitialRotation = 6.28; cloud.renderingGroupId = 1; cloud.start();
    }
    const hx = (q.x1 - q.x0) / 2 + 1, hz = (q.z1 - q.z0) / 2 + 1;
    cloud.emitter = new B.Vector3((q.x0 + q.x1) / 2, 1.5, (q.z0 + q.z1) / 2); cloud.minEmitBox = new B.Vector3(-hx, -1, -hz); cloud.maxEmitBox = new B.Vector3(hx, 1, hz);
    cloud.manualEmitCount = Math.max(0, cloud.manualEmitCount) + n;
  }
  // 瓦礫を消す時は、ぱっと消さずに 0.8 秒で小さくする
  function fadeOut(d) { physOff(d); fading.push({ m: d.m, t: 0, s: d.m.scaling.clone() }); }
  function updateFading(dt) {
    for (let i = fading.length - 1; i >= 0; i--) {
      const f = fading[i]; f.t += dt; const k = 1 - f.t / 0.8;
      if (k <= 0) { f.m.dispose(); fading.splice(i, 1); } else f.m.scaling.copyFrom(f.s).scaleInPlace(k);
    }
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
  function spawnDebris(p, s, col, vel, val) {
    const m = debrisSrc.createInstance("d");
    m.scaling.set(s.x, s.y, s.z);
    m.position.copyFrom(p);
    m.rotationQuaternion = B.Quaternion.FromEulerAngles((Math.random() - 0.5) * 0.3, Math.random() * 3, (Math.random() - 0.5) * 0.3);
    m.instancedBuffers.color = new B.Color4(col[0], col[1], col[2], 1);
    const d = { m, ag: null, held: false, val: val || Math.max(1, Math.round(s.x * s.y * s.z / 0.11)), t: 0 };   // val: 荷台に入る量＝ひきとりの値段（格子の数くらい）
    physOn(d, vel);
    debris.push(d);
    while (debris.length > MAX_DEBRIS) {
      const i = debris.findIndex(o => !o.held); if (i < 0) break;
      fadeOut(debris.splice(i, 1)[0]);
    }
    return d;
  }
  function clearDebris() { for (const d of debris) { physOff(d); d.m.dispose(); } debris.length = 0; }
  function carvedToDebris(c, kick) {
    const k = KIND_COL[c.kind];
    // 半分は粉々（粉塵だけ・瓦礫を残さない）。全部を瓦礫にすると 1 棟のすくう回数が多すぎた（10-12 評価 r0 テンポ）
    special(c);
    // 格子 1 つずつを瓦礫にすると数が多すぎるので、3 つに 1 つだけ少し大きい塊にする（値段は 3 つ分）
    if (Math.random() < 0.66) { removeCell(c); return; }
    spawnDebris(c.p, new B.Vector3(CELL * 1.3, CELL * (0.9 + Math.random() * 0.3), CELL * 1.3), c.burnt ? CHAR_COL : k,
      kick.add(new B.Vector3((Math.random() - 0.5), Math.random() * 0.8, (Math.random() - 0.5))), KIND_VAL[c.kind] * 3 || 3);
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
      for (const c of list) special(c);
      const ctr = mn.add(mx).scaleInPlace(0.5); spawnDebris(ctr, size, k, null, list.length * (KIND_VAL[list[0].kind] || 1)); if (groups.size <= 8 || Math.random() < 0.4) dust(ctr, 25);
      for (const c of list) removeCell(c);
    }
    return groups.size;
  }
  // ================= 部品づくり（見た目の箱＋必要なら ANIMATED の当たり） =================
  const yel = paintM("yel", "paint_yellow_diff.jpg", 0.45), dark = mat("dark", 0.13, 0.13, 0.14, 0.8), steel = pbrTex("steel", "metal_plate", 1, [0.55, 0.55, 0.57]);
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
  const grilleM = mat("grilleM", 0.1, 0.1, 0.1, 0.6, 0.5);
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
  const ex = { pos: new B.Vector3(0, 0, 0), heading: 0, swing: 0, boom: -0.35, stick: 1.3, bucket: 0.6 };
  const LIM = { boom: [-1.05, 0.6], stick: [0.35, 2.6], bucket: [-0.9, 2.6] };
  let limHit = false;
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
  // 壊す当たり点: バケットの先・角・背中、アームの先と中ほど
  const HIT_PTS_B = [[0, -BUCKET.H, BUCKET.L], [-BUCKET.W / 2, -BUCKET.H, BUCKET.L], [BUCKET.W / 2, -BUCKET.H, BUCKET.L], [-BUCKET.W / 2, 0, BUCKET.L], [BUCKET.W / 2, 0, BUCKET.L],
    [0, -BUCKET.H * 0.5, BUCKET.L * 0.6], [0, 0.1, BUCKET.L * 0.4], [0, 0.2, 0]].map(a => new B.Vector3(...a));
  const HIT_PTS_S = [[0, 0, STICK_L * 0.85], [0, 0, STICK_L * 0.45]].map(a => new B.Vector3(...a));
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
    if (ac && !sfxLoading) loadSfx();
  }
  document.addEventListener("visibilitychange", () => { if (ac && !document.hidden) ac.resume(); });
  // ---- 手ごたえ（10-12 評価 r0「崩れた時に音 1 種だけ・揺れ・粉塵・数字が無い」）----
  let master = null, nbuf = null;
  const OUT = () => { if (!master) { master = ac.createDynamicsCompressor(); master.connect(ac.destination); } return master; };
  const NB = () => { if (!nbuf) { nbuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate); const d = nbuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; } return nbuf; };
  let crashT = 0, crashP = 0, glassT = 0;
  // 崩れる音: 低いドーン＋ザザッ（帯域ノイズ）＋ガラガラ（小石の当たる音を時間差で）。pw 0〜1
  function crash(pw) {
    if (!ac || ac.state !== "running") return;
    const t = ac.currentTime; if (t - crashT < 0.05 && pw < crashP + 0.15) { if (pw >= 0.3) playS("impact", 0.3, 1.3); return; } crashT = t; crashP = pw;   // 続けて鳴らさない。ただし前より大きい崩れは通す
    if (hasS("crash_small") && hasS("crash_big")) {
      if (pw < 0.3) { playS("crash_small", 0.45 + pw * 1.5); if (pw >= 0.15) playS("rubble_dump", 0.2, 1.2, 0.12); return; }
      // 大きい崩れは重ねる: ドーン（低い衝撃）＋ガシャーン＋少し遅れてガラガラの尾（10-25 改善ループ 2「壊れる時の爽快感の音」）
      playS("crash_big", Math.min(1, 0.55 + pw * 0.5)); playS("impact", 0.45 + pw * 0.35, 0.8); if (pw > 0.55) playS("boom", 0.3 + pw * 0.3, 1.1); if (pw > 0.8) playS("impact", 0.4, 0.6, 0.06);
      playS("crash_small", 0.5, 1.1, 0.03 + Math.random() * 0.06); if (pw > 0.55) playS("rubble_dump", 0.4, 0.92 + Math.random() * 0.16, 0.22);
      return;
    }
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = "sine"; o.frequency.setValueAtTime(75, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.55);
    g.gain.setValueAtTime(Math.min(0.75, 0.12 + pw * 0.6), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    o.connect(g).connect(OUT()); o.start(t); o.stop(t + 0.65);
    const n = ac.createBufferSource(), f = ac.createBiquadFilter(), g2 = ac.createGain();
    n.buffer = NB(); f.type = "bandpass"; f.frequency.value = 700 + Math.random() * 400; f.Q.value = 0.6;
    g2.gain.setValueAtTime(Math.min(0.5, 0.08 + pw * 0.4), t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.35 + pw * 0.4);
    n.connect(f).connect(g2).connect(OUT()); n.start(t, Math.random() * 0.4); n.stop(t + 0.8);
    const k = Math.min(16, 2 + Math.round(pw * 14));
    for (let i = 0; i < k; i++) {
      const st = t + 0.04 + Math.random() * (0.2 + pw * 0.7), c = ac.createBufferSource(), hf = ac.createBiquadFilter(), cg = ac.createGain();
      c.buffer = NB(); hf.type = "bandpass"; hf.frequency.value = 1500 + Math.random() * 2800; hf.Q.value = 5;
      cg.gain.setValueAtTime(0.1 + Math.random() * 0.14, st); cg.gain.exponentialRampToValueAtTime(0.001, st + 0.045);
      c.connect(hf).connect(cg).connect(OUT()); c.start(st, Math.random() * 0.9); c.stop(st + 0.05);
    }
  }
  // 鉄骨がはまる音: 金属の倍音（カーン）＋少し遅れてボルト締め（カン、カン）
  function clang(pw) {
    if (!ac || ac.state !== "running") return;
    if (playS("steel_clang", 0.8 * pw)) { playS("bolt_impact", 0.55, 1, 0.35); return; }
    const t = ac.currentTime;
    for (const [f, a, d] of [[420, 0.22, 1.1], [1130, 0.14, 0.7], [2210, 0.08, 0.45], [3370, 0.05, 0.3]]) {
      const o = ac.createOscillator(), g = ac.createGain(); o.type = "sine"; o.frequency.value = f * (0.97 + Math.random() * 0.06);
      g.gain.setValueAtTime(a * pw, t); g.gain.exponentialRampToValueAtTime(0.0008, t + d); o.connect(g).connect(OUT()); o.start(t); o.stop(t + d + 0.05);
    }
    for (const k of [0.32, 0.5]) {
      const c = ac.createBufferSource(), hf = ac.createBiquadFilter(), cg = ac.createGain(), st = t + k;
      c.buffer = NB(); hf.type = "bandpass"; hf.frequency.value = 2600; hf.Q.value = 6;
      cg.gain.setValueAtTime(0.25, st); cg.gain.exponentialRampToValueAtTime(0.001, st + 0.06);
      c.connect(hf).connect(cg).connect(OUT()); c.start(st, Math.random()); c.stop(st + 0.07);
    }
  }
  // ごほうびの音（ドレミ）。notes は半音の数（0=ド）
  function chime(notes, step = 0.11, vol = 0.16) {
    if (!ac || ac.state !== "running") return;
    const t = ac.currentTime;
    notes.forEach((n, i) => {
      const o = ac.createOscillator(), g = ac.createGain(), st = t + i * step;
      o.type = "triangle"; o.frequency.value = 523.25 * Math.pow(2, n / 12);
      g.gain.setValueAtTime(0.0001, st); g.gain.linearRampToValueAtTime(vol, st + 0.015); g.gain.exponentialRampToValueAtTime(0.001, st + 0.5);
      o.connect(g).connect(OUT()); o.start(st); o.stop(st + 0.55);
    });
  }
  // ---- 録った効果音（assets/sfx。音作りのセッションに頼んだ物 10-13）。無い音は今までの合成音のまま ----
  const SFX_FILES = ["exc_engine_loop", "exc_hydraulic_loop", "exc_tracks_loop", "crane_winch_loop", "bucket_hit_1", "bucket_hit_2", "bucket_hit_3",
    "crash_small_1", "crash_small_2", "crash_small_3", "crash_big_1", "crash_big_2", "crash_big_3", "rubble_dump_1", "rubble_dump_2", "rubble_dump_3",
    "truck_depart", "truck_horn", "steel_clang_1", "steel_clang_2", "bolt_impact", "wind_gust", "sling_hook",
    ...["impact", "glass", "coin", "boom", "levelup", "popup", "firework", "click"].flatMap(n => [1, 2, 3].map(i => n + "_" + i))];   // 派手さの音（10-25 改善ループ 2・se-library）
  const sfx = {}; let sfxLoading = false;
  // mp3 は頭と終わりに無音（エンコーダの遅れ）が付くので、ループ物は鳴っている所だけに切る（つなぎ目でプツッと切れないように）
  function trimSilence(buf) {
    const d = buf.getChannelData(0), th = 0.002; let a = 0, b = d.length - 1;
    while (a < b && Math.abs(d[a]) < th) a++; while (b > a && Math.abs(d[b]) < th) b--;
    if (a < 8 && b > d.length - 9) return buf;
    const out = ac.createBuffer(buf.numberOfChannels, b - a + 1, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(a, b + 1), c);
    return out;
  }
  function loadSfx() {
    sfxLoading = true;
    for (const n of SFX_FILES) fetch("assets/sfx/" + n + ".mp3").then(r => r.ok ? r.arrayBuffer() : null).then(a => a && new Promise((ok, ng) => ac.decodeAudioData(a, ok, ng)))
      .then(b => { if (b) { sfx[n] = n.endsWith("_loop") ? trimSilence(b) : b; if (n.endsWith("_loop")) startLoops(); } }).catch(() => {});
  }
  const hasS = n => !!(sfx[n] || sfx[n + "_1"]);
  // 1 回鳴らす。name_1〜3 があれば、その中から選ぶ（同じ音が続かないように）
  const lastPick = {};
  function playS(name, vol = 1, rate = 1, delay = 0) {
    if (!ac || ac.state !== "running") return false;
    const vs = [1, 2, 3].map(i => name + "_" + i).filter(k => sfx[k]); let k = sfx[name] ? name : null;
    if (vs.length) { do { k = vs[Math.floor(Math.random() * vs.length)]; } while (vs.length > 1 && k === lastPick[name]); lastPick[name] = k; }
    if (!k) return false;
    const src = ac.createBufferSource(), g = ac.createGain(); src.buffer = sfx[k]; src.playbackRate.value = rate * (0.95 + Math.random() * 0.1); g.gain.value = vol;
    src.connect(g).connect(OUT()); src.start(ac.currentTime + delay); return true;
  }
  // 鳴りっぱなしの音（エンジン・油圧・キャタピラ・ウインチ）。音量と速さを毎コマ合わせる
  const loops = {};
  function startLoops() {
    for (const n of ["exc_engine_loop", "exc_hydraulic_loop", "exc_tracks_loop", "crane_winch_loop"]) {
      if (loops[n] || !sfx[n]) continue;
      const src = ac.createBufferSource(), g = ac.createGain(); src.buffer = sfx[n]; src.loop = true; g.gain.value = 0;
      src.connect(g).connect(OUT()); src.start(); loops[n] = { src, g, v: 0 };
    }
    if (loops.exc_engine_loop && eng) { eng.g.gain.value = 0; }   // 録った音が来たら仮のエンジン音は消す
  }
  function setLoop(n, vol, rate, dt) {
    const L = loops[n]; if (!L) return;
    L.v += (vol - L.v) * Math.min(1, dt * 8);       // 急に鳴ったり消えたりしない
    L.g.gain.value = L.v; L.src.playbackRate.value = rate;
  }
  // 画面の揺れ（trauma 方式: 足して、2 乗で揺らし、すぐ減る。?noshake で無し）
  let trauma = 0;
  const shake = (a) => { if (!Q.has("noshake")) trauma = Math.min(1, trauma + a); };
  // 粉塵と小さな破片（使い回しの粒の箱）
  const dustTex = (() => {
    const t = new B.DynamicTexture("dustT", 64, scene, false), c = t.getContext(), g = c.createRadialGradient(32, 32, 2, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,0.95)"); g.addColorStop(0.45, "rgba(255,255,255,0.4)"); g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g; c.fillRect(0, 0, 64, 64); t.update(); t.hasAlpha = true; return t;
  })();
  // 粒は地面の後に描く（地面は半透明の重ね貼りなので、同じ組だと粒の上に地面が塗られて瓦礫の形だけ粉塵色に見えた 10-12）
  scene.setRenderingAutoClearDepthStencil(1, false, false, false);
  const dustPool = []; let dustI = 0;
  for (let i = 0; i < (LITE ? 4 : 6); i++) {
    const ps = new B.ParticleSystem("dust" + i, LITE ? 160 : 300, scene);
    ps.particleTexture = dustTex; ps.emitter = new B.Vector3(0, -50, 0);
    ps.minEmitBox = new B.Vector3(-0.5, -0.4, -0.5); ps.maxEmitBox = new B.Vector3(0.5, 0.4, 0.5);
    ps.color1 = new B.Color4(0.6, 0.55, 0.48, 0.3); ps.color2 = new B.Color4(0.5, 0.46, 0.4, 0.22); ps.colorDead = new B.Color4(0.56, 0.52, 0.46, 0);   // 濃いと運転席から当たりが見えない（10-12 評価 r1）。colorDead を行の後ろのコメントに入れてしまい、既定の黒へ変わって黒い煙になっていた
    ps.addSizeGradient(0, 0.6, 1.1); ps.addSizeGradient(1, 1.8, 3.0);
    ps.minLifeTime = 0.7; ps.maxLifeTime = 1.5; ps.emitRate = 0; ps.manualEmitCount = 0;
    ps.blendMode = B.ParticleSystem.BLENDMODE_STANDARD; ps.gravity = new B.Vector3(0, 0.2, 0);
    ps.direction1 = new B.Vector3(-1, 0.2, -1); ps.direction2 = new B.Vector3(1, 1.0, 1); ps.minEmitPower = 0.3; ps.maxEmitPower = 1.4;
    ps.minAngularSpeed = -0.5; ps.maxAngularSpeed = 0.5; ps.minInitialRotation = 0; ps.maxInitialRotation = 6.28;
    const ch = new B.ParticleSystem("chips" + i, LITE ? 60 : 120, scene);
    ch.particleTexture = dustTex; ch.emitter = ps.emitter; ch.minEmitBox = ps.minEmitBox; ch.maxEmitBox = ps.maxEmitBox;
    ch.color1 = new B.Color4(0.32, 0.3, 0.27, 1); ch.color2 = new B.Color4(0.55, 0.38, 0.28, 1); ch.colorDead = new B.Color4(0.3, 0.28, 0.25, 0.6);   // 灰のコンクリ＋茶のレンガ
    ch.minSize = 0.1; ch.maxSize = 0.26; ch.minLifeTime = 0.5; ch.maxLifeTime = 1.0; ch.emitRate = 0; ch.manualEmitCount = 0;
    ch.blendMode = B.ParticleSystem.BLENDMODE_STANDARD; ch.gravity = new B.Vector3(0, -9.8, 0);
    ch.direction1 = new B.Vector3(-1.5, 1, -1.5); ch.direction2 = new B.Vector3(1.5, 3, 1.5); ch.minEmitPower = 1; ch.maxEmitPower = 3;
    ps.renderingGroupId = ch.renderingGroupId = 1; ps.start(); ch.start(); dustPool.push([ps, ch]);
  }
  // 当たった所の火花（黄白の小さな粒が 0.3 秒だけ飛ぶ。10-25 改善ループ 2）
  let sparkPS = null, sparkT = 0;
  function sparks(p, n) {
    if (playT - sparkT < 0.07) return; sparkT = playT;
    if (!sparkPS) {
      sparkPS = new B.ParticleSystem("sparks", 60, scene); sparkPS.particleTexture = dustTex;
      sparkPS.color1 = new B.Color4(1, 0.92, 0.6, 1); sparkPS.color2 = new B.Color4(1, 0.75, 0.35, 1); sparkPS.colorDead = new B.Color4(1, 0.6, 0.2, 0);
      sparkPS.minSize = 0.06; sparkPS.maxSize = 0.16; sparkPS.minLifeTime = 0.2; sparkPS.maxLifeTime = 0.4; sparkPS.emitRate = 0; sparkPS.manualEmitCount = 0;
      sparkPS.blendMode = B.ParticleSystem.BLENDMODE_ADD; sparkPS.gravity = new B.Vector3(0, -12, 0);
      sparkPS.direction1 = new B.Vector3(-3, 1, -3); sparkPS.direction2 = new B.Vector3(3, 4, 3); sparkPS.minEmitPower = 2; sparkPS.maxEmitPower = 5;
      sparkPS.renderingGroupId = 1; sparkPS.start();
    }
    sparkPS.emitter = p.clone(); sparkPS.manualEmitCount = Math.min(18, n);
  }
  function dust(p, n) {
    const [ps, ch] = dustPool[dustI++ % dustPool.length];
    const e = p.clone(); ps.emitter = e; ch.emitter = e;
    ps.manualEmitCount = Math.min(LITE ? 50 : 100, Math.round(n)); ch.manualEmitCount = Math.min(LITE ? 30 : 60, Math.round(n * 0.8));
  }
  // 浮かぶ数字（崩れた量を 0.5 秒ためて 1 回出す）と得点
  let hitStop = 0, score = 0, combo = 0, comboT = 0, comboP = null, lastPctStep = 0, lastDustT = -1;
  // 画面の閃光（崩れた瞬間に白く光る。10-25 改善ループ 2「派手さ」）
  function flash(a, warm) { const f = $("flash"); f.classList.toggle("warm", !!warm); f.style.transition = "none"; f.style.opacity = a; void f.offsetWidth; f.style.transition = "opacity .25s ease-out"; f.style.opacity = 0; }
  // コンボの札: 続けて壊している間「N こわし」を出し、10・25・60 を越えるたびに音が上がる
  let comboTier = 0, maxCombo = 0;
  function showCombo() {
    const el = $("combo"); if (combo < 3) return;
    el.querySelector("b").textContent = combo; el.style.display = "";
    if (playT - (showCombo.t || -1) > 0.12) { showCombo.t = playT; el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }   // 毎コマ組み直すと重いので間引く
    const tier = combo >= 60 ? 3 : combo >= 25 ? 2 : combo >= 10 ? 1 : 0;
    if (tier > comboTier) { comboTier = tier; chime([tier * 4, tier * 4 + 7], 0.07, 0.12); if (tier === 3) { playS("coin", 0.5, 0.95 + Math.random() * 0.15); playS("firework", 0.3, 0.95 + Math.random() * 0.15, 0.1); popup("ごくじょう！", "mile"); } else if (tier === 2) playS("popup", 0.35, 0.95 + Math.random() * 0.15); else playS("coin", 0.25, 1.25 + Math.random() * 0.15); el.dataset.tier = tier; }
  }
  function popup(text, cls) {
    const el = document.createElement("div"); el.className = "pop " + (cls || ""); el.textContent = text; if (cls === "tiny") el.style.setProperty("--dx", Math.round(Math.random() * 140 - 70) + "px");
    $("pops").appendChild(el); setTimeout(() => el.remove(), 1300);
  }
  function broke(n, p, big) {      // 格子が n 個こわれた（p はその辺り）
    combo += n; comboT = combo >= 10 ? 1.3 : 0.9; comboP = p; score += n;
    if (big || playT - lastDustT > 0.08) { lastDustT = playT; dust(p, (big ? 40 : 18) + n * (big ? 8 : 6)); }   // 押し当てている間に毎コマ出すと画面が粉塵で埋まった
    crash(Math.min(1, (big ? 0.35 : 0.05) + n * (big ? 0.06 : 0.03)));
    shake(Math.min(0.6, (big ? 0.28 : 0.08) + n * (big ? 0.03 : 0.012)));
    if (big && n >= 6 && !G.fixedDt) hitStop = 0.1;   // 大きく崩れた瞬間だけ一瞬ため（ヒットストップ・10-24 改善ループ 軸5）
    sparks(p, big ? 14 : 8);
    if (n >= 3 && playT - (broke.tT || -1) > 0.15) { broke.tT = playT; popup("+" + n, n >= 25 ? "tiny gold huge" : n >= 12 ? "tiny gold" : "tiny"); }
    if (big && n >= 6) { flash(Math.min(0.45, 0.15 + n * 0.01), n >= 25); if (ac && ac.currentTime - glassT > 0.25) { glassT = ac.currentTime; playS("glass", 0.5, 1, 0.04); } }
    showCombo();
  }
  function updateCombo(dt) {
    if (comboT <= 0) return;
    comboT -= dt; if (comboT > 0) return;
    $("combo").style.display = "none"; comboTier = 0; $("combo").dataset.tier = 0;
    if (combo >= 6) popup((combo >= 60 ? "ドドーン!! " : combo >= 25 ? "ガラガラ！ " : "ゴロッ ") + "+" + combo, combo >= 60 ? "big" : combo >= 25 ? "mid" : "");
    if (combo > maxCombo && combo >= 25 && maxCombo >= 10) { popup("さいこう れんぞく！", "mile"); playS("popup", 0.5); }
    maxCombo = Math.max(maxCombo, combo); combo = 0;

  }
  function thud(v, freq) {
    if (!ac || ac.state !== "running") return;
    const n = ac.createBufferSource(), len = ac.sampleRate * 0.25, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const f = ac.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = freq || 500; const g = ac.createGain(); g.gain.value = Math.min(0.6, v);
    n.buffer = buf; n.connect(f).connect(g).connect(OUT()); n.start();
  }

  // ================= 壊す =================
  let collapseTimer = 0, dirty = false, hitT = 0;
  function carveAt(p, r) {
    let n = 0;
    const lx = Math.floor((p.x - bld.origin.x) / CELL), ly = Math.floor((p.y - bld.origin.y) / CELL), lz = Math.floor((p.z - bld.origin.z) / CELL);
    const k = Math.ceil(r / CELL);
    for (let x = lx - k; x <= lx + k && n < 10; x++) for (let y = ly - k; y <= ly + k && n < 10; y++) for (let z = lz - k; z <= lz + k && n < 10; z++) {
      const c = bld.cells.get(key(x, y, z)); if (!c) continue;
      if (B.Vector3.Distance(c.p, p) > r) continue;
      carvedToDebris(c, c.p.subtract(p).normalize().scale(2.0)); n++;
      chainAbove(c.x, c.y, c.z, 0);
    }
    if (n) { dirty = true; broke(n, p, false); if (ac && ac.currentTime - hitT > 0.3) { hitT = ac.currentTime; playS("bucket_hit", 0.7, 0.92 + Math.random() * 0.18); shake(0.06 + Math.min(0.15, n * 0.015)); } }   // ガツッ（続けて当てても 0.3 秒に 1 回）
    return n;
  }
  // 連鎖: 削った格子の真上と斜め上は、少し遅れて確率で崩れる（上へ 5 段まで）。「ガラガラ崩れていく」感じ
  const chain = []; let chainLast = null;
  function chainAbove(x, y, z, depth) {
    if (depth >= 5) return;
    for (const [dx, dz, pr] of [[0, 0, 0.75], [1, 0, 0.3], [-1, 0, 0.3], [0, 1, 0.3], [0, -1, 0.3]])
      if (Math.random() < pr) chain.push({ x: x + dx, y: y + 1, z: z + dz, depth: depth + 1, t: 0.08 + Math.random() * 0.12 });
  }
  function updateChain(dt) {
    let n = 0;
    for (let i = chain.length - 1; i >= 0; i--) {
      const q = chain[i]; q.t -= dt; if (q.t > 0) continue;
      chain.splice(i, 1);
      const c = bld.cells.get(key(q.x, q.y, q.z)); if (!c) continue;
      carvedToDebris(c, new B.Vector3((Math.random() - 0.5) * 1.5, -0.5, (Math.random() - 0.5) * 1.5)); n++; chainLast = q;
      chainAbove(q.x, q.y, q.z, q.depth);
    }
    if (n) { dirty = true; broke(n, cellWorld(chainLast.x, chainLast.y, chainLast.z), false); }
  }
  // ================= 街 =================
  // 6×6 区画（1 区画 40m・道 12m）。真ん中寄りの 1 区画が ひきとりじょ。名所（鉄塔・観覧車…）を 10 区画、ほかは 2×2 の土地に家・マンション・ビル・倉庫・公園
  const NBK = Math.max(3, Math.min(8, Number(Q.get("nb") || 6))), BLK = 40, ROAD = 12, PITCH = BLK + ROAD, HALF = NBK * PITCH / 2;
  const blockC = (i, j) => ({ x: -HALF + ROAD / 2 + i * PITCH + BLK / 2, z: -HALF + ROAD / 2 + j * PITCH + BLK / 2 });
  const YI = Math.floor((NBK - 1) / 2), YJ = Math.floor((NBK - 1) / 2);
  const yard = Object.assign(blockC(YI, YJ), { h: BLK / 2 });
  let seed = 20261029; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(rnd() * a.length)];

  // ---- 保存（お金・強化・こわしきった土地） ----
  const SAVE_KEY = "machi_kowashi_v1";
  const sv = (() => { try { return Object.assign({ money: 0, up: { cap: 0, spd: 0, pow: 0, suck: 0 }, gone: [], delivered: 0 }, JSON.parse(localStorage.getItem(SAVE_KEY)) || {}); } catch (e) { return { money: 0, up: { cap: 0, spd: 0, pow: 0, suck: 0 }, gone: [], delivered: 0 }; } })();
  if (Q.has("fresh")) Object.assign(sv, { money: 0, up: { cap: 0, spd: 0, pow: 0, suck: 0 }, gone: [], delivered: 0 });
  let saveDirty = false;
  const save = () => { saveDirty = false; try { localStorage.setItem(SAVE_KEY, JSON.stringify(sv)); } catch (e) {} };

  // ---- 地面: 道路・歩道・土地を 1 枚の絵に描いて貼る（模様の細かさは写真素材の凹凸で足す） ----
  const GW = HALF * 2 + 120, GPX = 2048, PPM = GPX / GW;   // 絵の 1 画素 = 約 0.2m
  const ground = B.MeshBuilder.CreateBox("ground", { width: GW + 400, height: 1, depth: GW + 400 }, scene);
  ground.position.y = -0.5; ground.isVisible = false;
  new B.PhysicsAggregate(ground, B.PhysicsShapeType.BOX, { mass: 0, friction: 0.9 }, scene);
  const groundTex = new B.DynamicTexture("groundTex", { width: GPX, height: GPX }, scene, true);
  const gctx = groundTex.getContext();
  const W2P = (x, z) => [(x + GW / 2) * PPM, (GW / 2 - z) * PPM];   // 世界 → 絵の画素（絵の上が +z）
  const groundM = new B.PBRMaterial("groundM", scene);
  groundM.albedoTexture = groundTex; groundM.metallic = 0; groundM.roughness = 0.92;
  groundM.bumpTexture = tex("concrete_floor_02_nor.jpg", GW / 3); groundM.invertNormalMapY = true; groundM.bumpTexture.level = 0.5;
  { const load = f => new Promise(ok => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ok(null); im.src = AS + "tex/" + f + "?v=" + TEX_V; });
    load("dirty_concrete_soft_diff.jpg").then(im => {
      if (!im) return;
      const S = 512, cv = document.createElement("canvas"); cv.width = cv.height = S; const x = cv.getContext("2d"); x.drawImage(im, 0, 0, S, S);
      const d = x.getImageData(0, 0, S, S), a = d.data; let mean = 0;
      for (let i = 0; i < a.length; i += 4) mean += (a[i] + a[i + 1] + a[i + 2]) / 3; mean /= a.length / 4;
      for (let i = 0; i < a.length; i += 4) { const l = (a[i] + a[i + 1] + a[i + 2]) / 3, v = Math.max(0, Math.min(255, 128 + (l - mean) * 1.6)); a[i] = v; a[i + 1] = 128; a[i + 2] = 255 - v; a[i + 3] = 255; }   // 赤＝明るさの揺れ・青＝粗さ（詳細マップの決まり）
      x.putImageData(d, 0, 0);
      const t = new B.Texture(cv.toDataURL("image/jpeg", 0.9), scene); t.uScale = t.vScale = GW / 5;
      groundM.detailMap.texture = t; groundM.detailMap.isEnabled = true; groundM.detailMap.diffuseBlendLevel = 0.75; groundM.detailMap.roughnessBlendLevel = 0.5; groundM.detailMap.bumpLevel = 0;
    }); }
  const groundVis = B.MeshBuilder.CreateGround("groundVis", { width: GW, height: GW }, scene);
  groundVis.material = groundM; groundVis.receiveShadows = true; groundVis.isPickable = false;
  const outer = B.MeshBuilder.CreateGround("outer", { width: GW + 700, height: GW + 700 }, scene);   // 街の外の土
  outer.position.y = -0.03; outer.material = pbrTex("outerM", "dry_ground_rocks", (GW + 700) / 5, [0.9, 0.85, 0.78]); outer.receiveShadows = true; outer.isPickable = false;
  function speckle(x0, y0, w, h, n, cols) { for (let i = 0; i < n; i++) { gctx.fillStyle = pick(cols); gctx.fillRect(x0 + rnd() * w, y0 + rnd() * h, 1 + rnd() * 2, 1 + rnd() * 2); } }
  function drawGround(lots) {
    const c = gctx;
    c.fillStyle = "#6b6151"; c.fillRect(0, 0, GPX, GPX);                    // 街の外: 土
    let [ax, ay] = W2P(-HALF, HALF); c.fillStyle = "#3e4043"; c.fillRect(ax, ay, HALF * 2 * PPM, HALF * 2 * PPM);   // 道路（アスファルト）
    speckle(ax, ay, HALF * 2 * PPM, HALF * 2 * PPM, 60000, ["#36383b", "#47494c", "#2f3134"]);
    // 中央の白い破線・交差点の横断歩道
    c.fillStyle = "#d8d6cf";
    for (let k = 0; k <= NBK; k++) {
      const L = -HALF + k * PITCH;
      for (let s = -HALF; s < HALF; s += 6) {
        const [px, py] = W2P(L - 0.1, s + 3); c.fillRect(px, py, 0.2 * PPM, 3 * PPM);
        const [qx, qy] = W2P(s, L + 0.1); c.fillRect(qx, qy, 3 * PPM, 0.2 * PPM);
      }
    }
    for (let i = 0; i <= NBK; i++) for (let j = 0; j <= NBK; j++) {
      const X = -HALF + i * PITCH, Z = -HALF + j * PITCH;
      c.fillStyle = "#3e4043"; const [rx, ry] = W2P(X - ROAD / 2, Z + ROAD / 2); c.fillRect(rx, ry, ROAD * PPM, ROAD * PPM);   // 交差点は線を消す
      c.fillStyle = "#cfcdc6";
      for (let s = -4.5; s <= 4.5; s += 1.2) for (const sd of [-1, 1]) {
        const [p1x, p1y] = W2P(X + s - 0.3, Z + sd * (ROAD / 2 - 0.5) + 1.2); c.fillRect(p1x, p1y, 0.6 * PPM, 2.4 * PPM);   // 南北の横断歩道
        const [p2x, p2y] = W2P(X + sd * (ROAD / 2 - 0.5) - 1.2, Z + s + 0.3); c.fillRect(p2x, p2y, 2.4 * PPM, 0.6 * PPM);
      }
    }
    for (let i = 0; i < NBK; i++) for (let j = 0; j < NBK; j++) {
      const b = blockC(i, j); let [bx, by] = W2P(b.x - BLK / 2, b.z + BLK / 2);
      c.fillStyle = "#a9a7a0"; c.fillRect(bx, by, BLK * PPM, BLK * PPM);   // 歩道
      c.fillStyle = "#8c8a84"; c.fillRect(bx, by, BLK * PPM, 0.3 * PPM); c.fillRect(bx, by + (BLK - 0.3) * PPM, BLK * PPM, 0.3 * PPM); c.fillRect(bx, by, 0.3 * PPM, BLK * PPM); c.fillRect(bx + (BLK - 0.3) * PPM, by, 0.3 * PPM, BLK * PPM);   // 縁石
    }
    for (const L of lots) {
      const [lx, ly] = W2P(L.cx - L.w / 2, L.cz + L.d / 2);
      c.fillStyle = L.ground; c.fillRect(lx, ly, L.w * PPM, L.d * PPM);
      speckle(lx, ly, L.w * PPM, L.d * PPM, L.w * L.d * 3, L.ground === "#5f7d40" ? ["#557238", "#6a8a48", "#4d6a32"] : ["#7d7b75", "#94928b", "#6f6d68"]);
      if (sv.gone.includes(L.id)) rubbleMark(L.cx, L.cz, Math.min(L.w, L.d) * 0.45);
    }
    // ひきとりじょ: 黄色と黒のしまの縁＋コンクリの床
    { const [yx, yy] = W2P(yard.x - BLK / 2, yard.z + BLK / 2); c.fillStyle = "#77746c"; c.fillRect(yx, yy, BLK * PPM, BLK * PPM);
      for (let s = 0; s < BLK; s += 1.5) { c.fillStyle = (s / 1.5) % 2 ? "#e0b419" : "#1d1d1d"; for (const [x, y, w, h] of [[s, 0, 1.5, 1], [s, BLK - 1, 1.5, 1], [0, s, 1, 1.5], [BLK - 1, s, 1, 1.5]]) c.fillRect(yx + x * PPM, yy + y * PPM, w * PPM, h * PPM); } }
    groundTex.update();
  }
  function rubbleMark(x, z, r) {   // こわした跡（黒っぽい土とがれきの点）
    const [px, py] = W2P(x, z), g = gctx.createRadialGradient(px, py, 0, px, py, r * PPM);
    g.addColorStop(0, "rgba(60,54,46,0.85)"); g.addColorStop(1, "rgba(60,54,46,0)"); gctx.fillStyle = g; gctx.fillRect(px - r * PPM, py - r * PPM, r * 2 * PPM, r * 2 * PPM);
    speckle(px - r * PPM * 0.7, py - r * PPM * 0.7, r * PPM * 1.4, r * PPM * 1.4, r * r * 8, ["#8b867c", "#5a554d", "#a39d92"]);
  }
  let scorchDirty = 0;
  function scorch(x, z, r) {      // 爆発の焦げ跡（絵の送り直しは間引く）
    const [px, py] = W2P(x, z), g = gctx.createRadialGradient(px, py, 0, px, py, r * PPM);
    g.addColorStop(0, "rgba(15,12,10,0.8)"); g.addColorStop(0.6, "rgba(25,20,16,0.45)"); g.addColorStop(1, "rgba(25,20,16,0)"); gctx.fillStyle = g; gctx.fillRect(px - r * PPM, py - r * PPM, r * 2 * PPM, r * 2 * PPM);
    scorchDirty = 1;
  }

  // ---- 土地（区画の中の建てる場所）を決める ----
  const LANDMARKS = ["pylon", "chimney", "wheel", "wtower", "gas", "fire", "school", "castle", "tcrane", "pagoda"];
  const LM_NAME = { pylon: "てっとう", chimney: "えんとつ", wheel: "かんらんしゃ", wtower: "きゅうすいとう", gas: "ガソリンスタンド", fire: "しょうぼうしょ", school: "がっこう", castle: "おしろ", tcrane: "タワークレーン", pagoda: "ごじゅうのとう" };
  const lots = [];
  {
    const blocks = [];
    for (let i = 0; i < NBK; i++) for (let j = 0; j < NBK; j++) if (!(i === YI && j === YJ) && !(i === YI && j === YJ - 1)) blocks.push([i, j]);
    const lmBlocks = new Set(); const pool = blocks.slice();
    for (const k of LANDMARKS) { if (!pool.length) break; const n = Math.floor(rnd() * pool.length); lmBlocks.add(pool[n].join(",") + "," + k); pool.splice(n, 1); }
    const lmOf = {}; for (const s of lmBlocks) { const [i, j, k] = s.split(","); lmOf[i + "," + j] = k; }
    for (let i = 0; i < NBK; i++) for (let j = 0; j < NBK; j++) {
      if (i === YI && j === YJ) continue;
      const b = blockC(i, j), down = 1 - Math.hypot(i - (NBK - 1) / 2, j - (NBK - 1) / 2) / (NBK * 0.7);   // 真ん中ほど高い建物
      const lm = lmOf[i + "," + j];
      if (lm) { lots.push({ id: lots.length, cx: b.x, cz: b.z, w: BLK - 6, d: BLK - 6, kind: lm, lm: true, ground: "#857a66" }); continue; }
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const r = rnd(), kind = i === YI && j === YJ - 1 ? (r < 0.5 ? "park" : "house")       // 最初の場所の前は低い物
          : r < 0.08 ? "park" : r < 0.16 ? "parking" : r < 0.42 - down * 0.15 ? "house" : r < 0.6 ? "apart" : r < 0.7 ? "shop" : r < 0.78 ? "ware" : down > 0.35 ? "office" : "apart";
        lots.push({ id: lots.length, cx: b.x + sx * 8.75, cz: b.z + sz * 8.75, w: 16.5, d: 16.5, kind, down, ground: kind === "park" ? "#5f7d40" : "#8f8d87" });
      }
    }
  }
  for (const L of lots) Object.assign(L, { made: false, gone: sv.gone.includes(L.id), blds: [], cells0: 0, proxy: null });
  drawGround(lots);

  // ---- 建物を建てる（ショベルが近づいた土地から順に） ----
  const KIND_VAL = { tin: 2, steelc: 3, tinroof: 2, brick: 2, twr_r: 3, twr_w: 3, g1: 2, g2: 2, g3: 2, g4: 2, tank: 3, brg: 3, lamp: 2, pipe: 3, gasm: 2 };   // 1 格子の値段（無い物は 1）
  const CHAR_COL = [0.16, 0.14, 0.13];
  Object.assign(KIND_COL, { gasm: [1.0, 0.82, 0.12], pipe: [0.25, 0.5, 0.95], shopw: [0.88, 0.86, 0.8], awn: [0.85, 0.25, 0.2] });
  bld.orig = new Set();
  const meters = [];   // ガスメーター（黄色い箱）。格子が 1 つ削れたら爆発
  function gasMeter(x0, z0, big) {   // 格子の座標。壁の外側（南の面）に 2×2×3
    const m = { done: false, big: !!big }; meters.push(m);
    for (let x = 0; x < 2; x++) for (let y = 0; y < 3; y++) { addCell(x0 + x, y, z0, "gasm"); const c = bld.cells.get(key(x0 + x, y, z0)); if (c) c.gm = m; }
  }
  function waterPipe(x0, z0, h) { for (let y = 0; y < h; y++) addCell(x0, y, z0, "pipe"); }   // 壁の外の水道管（青）
  function buildLot(L) {
    curLot = L; OFF.x = 0; OFF.z = 0;
    const W = L.w, cx = L.cx, cz = L.cz;
    const fx = (w) => cx - w / 2 + (rnd() - 0.5) * (W - w) * 0.6, fz = (d) => cz - d / 2 + (rnd() - 0.5) * (L.d - d) * 0.6;
    let x0, z0, w, d;
    const extras = (floors) => {   // 南の面にガスメーター、横に水道管
      const gx0 = gx(x0) + 2 + Math.floor(rnd() * Math.max(1, w / CELL - 6)), gz0 = gz(z0) - 1;
      if (rnd() < 0.75) gasMeter(gx0, gz0);
      if (rnd() < 0.55) waterPipe(gx(x0) - 1, gz(z0) + 3 + Math.floor(rnd() * Math.max(1, d / CELL - 6)), Math.min(floors * 6, 14));
    };
    switch (L.kind) {
      case "house": { w = pick([8, 10]); d = pick([6, 8]); x0 = fx(w); z0 = fz(d); houseW(x0, z0, w, d, pick([1, 2, 2]), pick([WOOD, Object.assign({}, WOOD, { wall: "prefab" })]), 2.5); extras(2);
        if (rnd() < 0.5) addFence(gx(cx - W / 2 + 0.5), gz(cz - L.d / 2 + 0.5), Math.round(W / CELL) - 2, 2, "block"); break; }
      case "apart": { w = pick([10, 12]); d = pick([8, 10]); x0 = fx(w); z0 = fz(d); const f = 3 + Math.floor(rnd() * (2 + L.down * 4)); houseW(x0, z0, w, d, f, f >= 4 ? BIG : {}); extras(f); break; }
      case "office": { w = pick([12, 14]); d = pick([10, 12]); x0 = fx(w); z0 = fz(d); const f = 6 + Math.floor(rnd() * (3 + L.down * 9)); houseW(x0, z0, w, d, f, Object.assign({ winRows: [1, 2, 3, 4] }, BIG)); extras(f); break; }
      case "shop": { w = 14; d = 8; x0 = fx(w); z0 = fz(d); houseW(x0, z0, w, d, 2, { wall: pick(["brick", "shopw"]), pillar: "pillar", winRows: [1, 2, 3], door: [8, 19, 5] }); extras(2);
        for (let x = gx(x0); x < gx(x0 + w); x++) addCell(x, 5, gz(z0) - 1, "awn"); break; }   // 日よけ（赤）
      case "ware": { w = 15; d = 10; x0 = fx(w); z0 = fz(d); houseW(x0, z0, w, d, 1, TIN, 4.5); extras(1); break; }
      case "parking": { w = 6; d = 4; x0 = cx - 6; z0 = cz + 3; houseW(x0, z0, w, d, 1, PRE); extras(1);
        for (let k = 0; k < 4; k++) addCar(cx - 5 + k * 3.2, cz - 4, Math.PI / 2 * (rnd() < 0.5 ? 1 : -1) + Math.PI / 2, false); break; }
      case "park": { for (let k = 0; k < 7; k++) addTree(cx + (rnd() - 0.5) * (W - 3), cz + (rnd() - 0.5) * (L.d - 3)); break; }
      default: {   // 名所: (0, 20) 辺りに建てる組み立て関数を、区画の中心へずらして呼ぶ
        OFF.x = cx; OFF.z = cz - 20;
        ({ pylon: () => buildPylon(0, 19), chimney: () => buildChimney(0, 21), wheel: () => buildWheel(0, 20), wtower: () => buildWaterTower(0, 19),
          gas: () => { buildGas(); for (const [px, pz] of [[-2.5, 15], [2.5, 15], [-2.5, 19], [2.5, 19]]) { const m = { done: false, big: true }; meters.push(m); for (let y = 0; y < 3; y++) for (let a = 0; a < 2; a++) { addCell(gx(px) + a, y, gz(pz), "gasm"); bld.cells.get(key(gx(px) + a, y, gz(pz))).gm = m; } } },
          fire: () => buildFire(), school: () => buildSchool(), castle: () => buildCastle(0, 21), tcrane: () => buildTowerCrane(0, 22), pagoda: () => buildPagoda(0, 21) })[L.kind]();
        OFF.x = OFF.z = 0;
      }
    }
    curLot = null;
    for (const b of L.blds) { b.baseN = b.base0; b.n0 = b.cells.size; for (const c of b.cells) bld.orig.add(key(c.x, c.y, c.z)); L.cells0 += b.cells.size; }
    L.made = true; if (L.proxy) { L.proxy.dispose(); L.proxy = null; }
  }
  // まだ建てていない土地は、遠くから見えた時のために箱だけ置く（名所・公園・駐車場は置かない）
  const proxyM = mat("proxyM", 0.6, 0.6, 0.58, 0.9);
  const PROXY_H = { house: 5, apart: 12, office: 30, shop: 6, ware: 4.5 };
  for (const L of lots) if (!L.gone && PROXY_H[L.kind]) {
    const p = B.MeshBuilder.CreateBox("proxy", { width: 10, depth: 9, height: PROXY_H[L.kind] * (L.kind === "office" ? 0.6 + L.down : 1) }, scene);
    p.position.set(L.cx, p.getBoundingInfo().boundingBox.extendSize.y, L.cz); p.material = proxyM; p.isPickable = false; L.proxy = p;
  }
  const ACT_R = Number(Q.get("act") || 85);
  function activateNear(p, all) {   // ショベルに近い土地を 1 つ（all なら全部）建てる
    let best = null, bd2 = ACT_R * ACT_R;
    for (const L of lots) {
      if (L.made || L.gone) continue;
      const d2 = (L.cx - p.x) ** 2 + (L.cz - p.z) ** 2;
      if (all ? d2 < bd2 : d2 < bd2 && (!best || d2 < best.d2)) { if (all) buildLot(L); else { best = L; best.d2 = d2; } }
    }
    if (best) buildLot(best);
    return !!best;
  }

  // ---- 街の小物（車・木・街灯・消火栓）: 形は 1 つずつの元から写した物（同じ形は 1 回で描ける） ----
  const instSrc = (name, mesh, m) => { mesh.material = m; mesh.isVisible = false; mesh.registerInstancedBuffer("color", 4); mesh.instancedBuffers.color = new B.Color4(1, 1, 1, 1); shadow.addShadowCaster(mesh); mesh.receiveShadows = true; return mesh; };
  const carPaint = new B.PBRMaterial("carPaint", scene); carPaint.albedoColor = B.Color3.White(); carPaint.metallic = 0.3; carPaint.roughness = 0.35; carPaint.clearCoat.isEnabled = true; carPaint.clearCoat.intensity = 0.6;
  const SRC = {
    box: instSrc("srcBox", B.MeshBuilder.CreateBox("srcBox", { size: 1 }, scene), carPaint),
    glass: instSrc("srcGlass", B.MeshBuilder.CreateBox("srcGlass", { size: 1 }, scene), mat("carGlass", 0.04, 0.05, 0.07, 0.08, 0.3)),
    wheel: instSrc("srcWheel", B.MeshBuilder.CreateCylinder("srcWheel", { diameter: 1, height: 1, tessellation: 14 }, scene), mat("tireM", 0.05, 0.05, 0.05, 0.9)),
    trunk: instSrc("srcTrunk", B.MeshBuilder.CreateCylinder("srcTrunk", { diameterTop: 0.6, diameterBottom: 1, height: 1, tessellation: 8 }, scene), mat("trunkM", 0.35, 0.24, 0.15, 0.9)),
    crown: instSrc("srcCrown", B.MeshBuilder.CreateIcoSphere("srcCrown", { radius: 1, subdivisions: 1, flat: true }, scene), mat("leafM", 0.3, 0.48, 0.2, 0.85)),
    pole: instSrc("srcPole", B.MeshBuilder.CreateCylinder("srcPole", { diameter: 1, height: 1, tessellation: 8 }, scene), mat("poleM", 0.45, 0.46, 0.47, 0.5, 0.7)),
    skin: instSrc("srcSkin", B.MeshBuilder.CreateBox("srcSkin", { size: 1 }, scene), mat("skinM", 1, 1, 1, 0.8)),
    cap: instSrc("srcCap", (() => { const m = B.MeshBuilder.CreateCapsule("srcCap", { radius: 0.3, height: 1, tessellation: 10, capSubdivisions: 3 }, scene); m.scaling.set(1 / 0.6, 1, 1 / 0.6); m.bakeCurrentTransformIntoVertices(); return m; })(), mat("capM", 1, 1, 1, 0.85)),   // 人の体（丸み）。半径 0.5・高さ 1 だと筒の部分が潰れて黒い帯が出た
    ball: instSrc("srcBall", B.MeshBuilder.CreateSphere("srcBall", { diameter: 1, segments: 8 }, scene), mat("ballM", 1, 1, 1, 0.75)),
  };
  const col4 = (r, g, b) => new B.Color4(r, g, b, 1);
  function inst(src, parent, size, pos, color, rot) {
    const m = SRC[src].createInstance(src); m.parent = parent; m.scaling.set(...size); m.position.set(...pos); if (rot) m.rotation.set(...rot);
    m.instancedBuffers.color = color || col4(1, 1, 1); m.isPickable = false; return m;
  }
  const props = [];   // {kind, root, pos, state, ...}
  const CAR_COLS = [[0.85, 0.85, 0.83], [0.12, 0.12, 0.13], [0.62, 0.08, 0.07], [0.12, 0.25, 0.55], [0.55, 0.56, 0.58], [0.9, 0.75, 0.15], [0.2, 0.42, 0.25], [0.95, 0.95, 0.95]];
  function addCar(x, z, heading, drive, lane) {
    const root = new B.TransformNode("car", scene); root.position.set(x, 0, z); root.rotation.y = heading;
    const c = pick(CAR_COLS), cc = col4(...c), tall = rnd() < 0.25;
    const body = inst("box", root, [1.8, tall ? 1.2 : 0.75, 4.2], [0, tall ? 0.95 : 0.72, 0], cc);
    const cab = inst("glass", root, [1.66, tall ? 0.7 : 0.62, tall ? 3.2 : 2.1], [0, tall ? 1.9 : 1.38, tall ? -0.3 : -0.25]);
    const roof = inst("box", root, [1.6, 0.06, tall ? 3.0 : 1.8], [0, tall ? 2.27 : 1.71, tall ? -0.3 : -0.3], cc);
    const wheels = [[-0.85, 1.35], [0.85, 1.35], [-0.85, -1.35], [0.85, -1.35]].map(([wx, wz]) => inst("wheel", root, [0.62, 0.28, 0.62], [wx, 0.33, wz], null, [0, 0, Math.PI / 2]));
    const lamp = inst("box", root, [1.5, 0.12, 0.05], [0, 0.85, 2.1], col4(1, 0.95, 0.8));
    const car = { kind: "car", root, pos: root.position, parts: [body, cab, roof, lamp, ...wheels], body, cc: c, hp: 2.2, state: drive ? "drive" : "park", vel: new B.Vector3(), av: new B.Vector3(), val: 40, r: 2.3, lane, honkT: 0 };
    props.push(car); return car;
  }
  function addTree(x, z) {
    const root = new B.TransformNode("tree", scene); root.position.set(x, 0, z); const s = 0.8 + rnd() * 0.6;
    inst("trunk", root, [0.35 * s, 2.4 * s, 0.35 * s], [0, 1.2 * s, 0]);
    const g = 0.75 + rnd() * 0.4; inst("crown", root, [1.7 * s, 1.5 * s, 1.7 * s], [0, 3.1 * s, 0], col4(0.85 * g, 1.05 * g, 0.8 * g), [0, rnd() * 3, 0]);
    props.push({ kind: "tree", root, pos: root.position, state: "up", val: 6, r: 1.0, h: 4 * s });
  }
  function addLamp(x, z, face) {
    const root = new B.TransformNode("lamp", scene); root.position.set(x, 0, z); root.rotation.y = face;
    inst("pole", root, [0.16, 6, 0.16], [0, 3, 0]); inst("pole", root, [0.1, 1.6, 0.1], [0, 5.9, 0.7], null, [Math.PI / 2, 0, 0]);
    inst("box", root, [0.4, 0.15, 0.6], [0, 5.85, 1.45], col4(1.4, 1.35, 1.1));
    props.push({ kind: "lamp", root, pos: root.position, state: "up", val: 5, r: 0.6, h: 6 });
  }
  function addHydrant(x, z) {
    const root = new B.TransformNode("hyd", scene); root.position.set(x, 0, z);
    inst("pole", root, [0.32, 0.8, 0.32], [0, 0.4, 0], col4(0.9, 0.12, 0.08)); inst("pole", root, [0.42, 0.12, 0.42], [0, 0.82, 0], col4(0.9, 0.12, 0.08)); inst("pole", root, [0.16, 0.5, 0.16], [0, 0.55, 0], col4(0.95, 0.85, 0.2), [0, 0, Math.PI / 2]);
    props.push({ kind: "hyd", root, pos: root.position, state: "up", val: 4, r: 0.6, h: 1 });
  }
  // 並べる: 歩道に木と街灯、交差点の角に消火栓、道の端に止めた車、走る車
  for (let i = 0; i < NBK; i++) for (let j = 0; j < NBK; j++) {
    if (i === YI && j === YJ) continue;
    const b = blockC(i, j), e = BLK / 2 - 1.4;
    for (let s = -e + 3; s < e - 2; s += 9) {
      for (const [x, z, f] of [[b.x + s, b.z - e, Math.PI], [b.x + s, b.z + e, 0], [b.x - e, b.z + s, -Math.PI / 2], [b.x + e, b.z + s, Math.PI / 2]]) {
        const r = rnd(); if (r < 0.3) addTree(x, z); else if (r < 0.45) addLamp(x, z, f);
      }
    }
    addHydrant(b.x - e + 0.6, b.z - e + 0.6); if (rnd() < 0.6) addHydrant(b.x + e - 0.6, b.z + e - 0.6);
  }
  for (let k = 0; k <= NBK; k++) for (let s = 0; s < NBK; s++) {   // 道の端に止めた車
    const L = -HALF + k * PITCH, m0 = -HALF + s * PITCH + ROAD / 2 + 3;
    for (let t = 0; t < BLK - 6; t += 6) {
      if (rnd() < 0.35) addCar(L + 4.6, m0 + t, 0, false);
      if (rnd() < 0.35) addCar(m0 + t, L - 4.6, Math.PI / 2, false);
    }
  }
  const NDRIVE = Number(Q.get("cars") || 14);
  for (let k = 0; k < NDRIVE; k++) {   // 走る車: 道の中心線から 2.4m 横を、交差点で曲がりながら走る
    const ax = rnd() < 0.5 ? "x" : "z", line = -HALF + Math.floor(rnd() * (NBK + 1)) * PITCH, dir = rnd() < 0.5 ? 1 : -1, s0 = -HALF + rnd() * HALF * 2;
    const car = addCar(0, 0, 0, true, { ax, line, dir, s: s0 }); placeLane(car);
  }
  // 止まっている小物は位置の計算を固める（数千個を毎コマ計算して重かった 10-30）。当たって動き出す時に戻す
  function freezeProp(q, on) {
    const ms = q.root.getChildMeshes();
    if (on) { q.root.computeWorldMatrix(true); for (const m of ms) m.freezeWorldMatrix(); } else for (const m of ms) m.unfreezeWorldMatrix();
    q.frozen = on;
  }
  for (const q of props) if (q.state !== "drive") freezeProp(q, true);
  function placeLane(car) {
    const l = car.lane, off = -l.dir * 2.4;   // 左側通行
    if (l.ax === "x") { car.pos.set(l.s, 0, l.line + off); car.root.rotation.y = l.dir > 0 ? Math.PI / 2 : -Math.PI / 2; }
    else { car.pos.set(l.line - off, 0, l.s); car.root.rotation.y = l.dir > 0 ? 0 : Math.PI; }
  }

  // ---- ひきとりじょ: 大きな穴（がれきの山が育つ）・看板・光る輪 ----
  const pitM = mat("pitM", 0.12, 0.11, 0.1, 0.95);
  { const p = B.MeshBuilder.CreateBox("pit", { width: 18, height: 0.05, depth: 18 }, scene); p.position.set(yard.x, 0.03, yard.z + 3); p.material = pitM; p.receiveShadows = true;
    for (const [w, d, x, z] of [[18.6, 0.5, 0, 9], [18.6, 0.5, 0, -9], [0.5, 18, 9, 0], [0.5, 18, -9, 0]]) { const wl = B.MeshBuilder.CreateBox("pitWall", { width: w, height: 1.2, depth: d }, scene); wl.position.set(yard.x + x, 0.6, yard.z + 3 + z); wl.material = mat("pitWallM", 0.62, 0.6, 0.55, 0.9); shadow.addShadowCaster(wl); wl.receiveShadows = true; }
  }
  const pile = B.MeshBuilder.CreateSphere("pile", { diameter: 1, segments: 10 }, scene);
  pile.material = pbrTex("pileM", "concrete_debris", 3, [0.85, 0.8, 0.74]); pile.position.set(yard.x, -0.1, yard.z + 3); pile.receiveShadows = true; shadow.addShadowCaster(pile);
  const pileSize = () => { const k = Math.min(1, Math.sqrt(sv.delivered / 30000)); pile.scaling.set(4 + k * 12, 0.6 + k * 7, 4 + k * 12); };
  pileSize();
  { const dt2 = new B.DynamicTexture("signT", { width: 512, height: 160 }, scene, true), c = dt2.getContext();
    c.fillStyle = "#1a5f2a"; c.fillRect(0, 0, 512, 160); c.strokeStyle = "#fff"; c.lineWidth = 8; c.strokeRect(6, 6, 500, 148);
    c.fillStyle = "#fff"; c.font = "bold 58px sans-serif"; c.textAlign = "center"; c.fillText("ひきとりじょ", 256, 78); c.font = "bold 34px sans-serif"; c.fillText("がれき かいます ¥", 256, 130); dt2.update();
    const sm = new B.StandardMaterial("signM", scene); sm.diffuseTexture = dt2; sm.emissiveColor = new B.Color3(0.45, 0.45, 0.45); sm.backFaceCulling = false;
    const sg = B.MeshBuilder.CreatePlane("sign", { width: 10, height: 3.1 }, scene); sg.material = sm; sg.position.set(yard.x, 5.2, yard.z + 16); sg.rotation.x = 0.55;   // 北の端（入る所をふさがない）
    for (const sx of [-4, 4]) { const p = B.MeshBuilder.CreateCylinder("signPole", { diameter: 0.25, height: 5 }, scene); p.position.set(yard.x + sx, 2.5, yard.z + 16.2); p.material = SRC.pole.material; shadow.addShadowCaster(p); } }
  const ringM = new B.StandardMaterial("ringM", scene); ringM.emissiveColor = new B.Color3(1, 0.8, 0.15); ringM.disableLighting = true; ringM.alpha = 0.35; ringM.backFaceCulling = false;
  const yardRing = B.MeshBuilder.CreateTube("yardRing", { path: [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([a, b]) => new B.Vector3(yard.x + a * (BLK / 2 - 0.7), 0.25, yard.z + b * (BLK / 2 - 0.7))), radius: 0.18, tessellation: 6 }, scene);
  yardRing.material = ringM; yardRing.isPickable = false;

  // ---- ゾンビ: 道を歩いて、ショベルに寄ってくる。当たると吹き飛んで緑の煙 ----
  const zombies = [];
  const Z_SHIRT = [[0.45, 0.4, 0.33], [0.3, 0.32, 0.4], [0.5, 0.18, 0.15], [0.38, 0.42, 0.3], [0.6, 0.6, 0.58]];
  // ゾンビ: 丸みのある体（カプセルと球）。前かがみで両腕を前へ・服は汚れて血のしみ（10-30 本人「ゾンビとか四角やしな」）
  const Z_PANTS = [[0.18, 0.2, 0.26], [0.28, 0.25, 0.2], [0.15, 0.15, 0.16], [0.32, 0.33, 0.36]], BLOOD = [0.32, 0.03, 0.03];
  function addZombie(x, z) {
    const root = new B.TransformNode("zom", scene); root.position.set(x, 0, z);
    const g = rnd() * 0.12, sk = col4(0.5 + g, 0.58 + g, 0.45 + g * 0.5), sh = col4(...pick(Z_SHIRT)), pa = col4(...pick(Z_PANTS)), dk = col4(0.07, 0.06, 0.06);
    const hip = new B.TransformNode("hip", scene); hip.parent = root; hip.position.y = 0.92;
    const body = new B.TransformNode("body", scene); body.parent = hip; body.rotation.x = 0.32 + rnd() * 0.15; body.rotation.z = (rnd() - 0.5) * 0.2;   // 前かがみ・少し傾く
    inst("cap", hip, [0.34, 0.3, 0.24], [0, 0.03, 0], pa);                                   // 腰
    const torso = inst("cap", body, [0.42, 0.66, 0.27], [0, 0.36, 0], sh);                    // 胴
    for (let k = 0; k < 2; k++) inst("box", body, [0.08 + rnd() * 0.1, 0.07 + rnd() * 0.12, 0.02], [(rnd() - 0.5) * 0.25, 0.25 + rnd() * 0.3, 0.135], col4(...BLOOD));   // 血のしみ
    inst("cap", body, [0.11, 0.14, 0.11], [0, 0.72, 0.03], sk);                               // 首
    const headN = new B.TransformNode("headN", scene); headN.parent = body; headN.position.set(0, 0.86, 0.05); headN.rotation.set(-0.2, 0, (rnd() - 0.5) * 0.5);
    const head = inst("ball", headN, [0.25, 0.29, 0.26], [0, 0, 0], sk);
    inst("ball", headN, [0.26, 0.13, 0.27], [0, 0.09, -0.02], col4(0.1 + rnd() * 0.15, 0.08, 0.06));   // 髪
    for (const e of [-1, 1]) inst("ball", headN, [0.055, 0.04, 0.03], [e * 0.06, 0.01, 0.12], col4(0.85, 0.75, 0.3));   // にごった目
    inst("box", headN, [0.1, 0.03, 0.03], [0, -0.08, 0.12], col4(0.2, 0.04, 0.04));           // 口
    const arms = [-1, 1].map(s => {
      const a = new B.TransformNode("sh", scene); a.parent = body; a.position.set(s * 0.25, 0.62, 0);
      inst("cap", a, [0.11, 0.36, 0.11], [0, 0, 0.16], sh, [Math.PI / 2, 0, 0]);             // 二の腕（袖）
      inst("cap", a, [0.09, 0.34, 0.09], [s * -0.02, -0.04, 0.46], sk, [Math.PI / 2 + 0.15, 0, 0]);   // 前腕
      inst("ball", a, [0.1, 0.06, 0.14], [s * -0.03, -0.07, 0.65], sk);                      // 手（だらんと垂れる）
      return a;
    });
    const legs = [-1, 1].map(s => {
      const lg = new B.TransformNode("lg", scene); lg.parent = hip; lg.position.set(s * 0.11, 0, 0);
      inst("cap", lg, [0.16, 0.48, 0.16], [0, -0.23, 0], pa); inst("cap", lg, [0.13, 0.46, 0.13], [0, -0.62, 0.01], pa);
      inst("box", lg, [0.13, 0.09, 0.27], [0, -0.87, 0.06], dk);                              // 靴
      return lg;
    });
    const zo = { root, pos: root.position, hip, arms, legs, head, headN, torso, t: rnd() * 6, spd: 0.9 + rnd() * 0.9, state: "walk", vel: new B.Vector3(), av: new B.Vector3(), wander: rnd() * 6.28, groanT: 2 + rnd() * 6 };
    zombies.push(zo); return zo;
  }
  const ZMAX = Number(Q.get("zombies") || 22);
  function spawnZombieNear(p) {   // 見えない少し遠くの道に出す
    for (let k = 0; k < 8; k++) {
      const a = rnd() * 6.28, r = 38 + rnd() * 20, x = p.x + Math.sin(a) * r, z = p.z + Math.cos(a) * r;
      if (Math.abs(x) > HALF - 2 || Math.abs(z) > HALF - 2) continue;
      if (cellsNear(new B.Vector3(x, 0, z), 1, 1, 2)) continue;
      return addZombie(x, z);
    }
    return null;
  }
  // ================= 遊び =================
  let playT = 0;
  // ---- 強化（ひきとりじょで買う） ----
  const UPS = {
    cap: { name: "にだい", icon: "🧺", vals: [150, 260, 420, 650, 1000, 1500, 2300, 3500], fmt: v => v + " はいる" },
    spd: { name: "はやさ", icon: "💨", vals: [6, 7, 8.2, 9.5, 11, 12.5], fmt: v => v.toFixed(1) + " m/秒" },
    pow: { name: "パワー", icon: "💥", vals: [1, 1.35, 1.75, 2.2, 2.8, 3.5], fmt: v => "×" + v.toFixed(2) },
    suck: { name: "すいこみ", icon: "🌀", vals: [8, 9.5, 11, 13, 15.5, 18], fmt: v => v + " m" },
  };
  const upV = k => UPS[k].vals[Math.min(sv.up[k] || 0, UPS[k].vals.length - 1)];
  const upPrice = k => Math.round(120 * Math.pow(2.15, sv.up[k] || 0));
  const fmtY = n => "¥" + Math.round(n).toLocaleString();

  // ---- 荷台: 上の旋回体の後ろ（カウンターウェイトの後ろ）に箱。中の山は量で高くなる ----
  const bedRoot = new B.TransformNode("bedRoot", scene); bedRoot.parent = upper; bedRoot.position.set(0.2, 0.75, -3.25);
  const bedTilt = new B.TransformNode("bedTilt", scene); bedTilt.parent = bedRoot; bedTilt.position.z = -1.2;   // あける時は後ろの縁を軸に傾ける
  { const P = bedTilt, o = 1.2;
    deco("bedFloor", [2.5, 0.12, 2.4], P, [0, 0, o], orange); deco("bedL", [0.1, 1.0, 2.4], P, [-1.25, 0.5, o], orange); deco("bedR", [0.1, 1.0, 2.4], P, [1.25, 0.5, o], orange);
    deco("bedF", [2.5, 1.1, 0.1], P, [0, 0.55, o + 1.2], orange); deco("bedB", [2.5, 0.8, 0.1], P, [0, 0.4, o - 1.2], orange);
    for (const sx of [-1.28, 1.28]) for (const z of [-0.6, 0.6]) deco("bedRib", [0.06, 0.9, 0.1], P, [sx, 0.5, o + z], dark); }
  const bedFill = B.MeshBuilder.CreateBox("bedFill", { width: 2.35, height: 1, depth: 2.25 }, scene);
  bedFill.parent = bedTilt; bedFill.position.set(0, 0.06, 1.2); bedFill.material = pbrTex("bedFillM", "concrete_debris", 0.8, [0.8, 0.76, 0.7]); bedFill.receiveShadows = true; shadow.addShadowCaster(bedFill);
  const bed = { load: 0, money: 0 };
  function showBed() { const k = Math.min(1, bed.load / upV("cap")); bedFill.scaling.y = Math.max(0.01, k * 1.25); bedFill.position.y = 0.06 + bedFill.scaling.y / 2; bedFill.setEnabled(k > 0); }
  showBed();
  const bedPos = () => B.Vector3.TransformCoordinates(new B.Vector3(0, 1.2, 1.2), bedTilt.computeWorldMatrix(true));

  // ---- 入力: 画面のスティック（左側をさわった所に出る）・ゲームパッド・キーボード ----
  const mv = { x: 0, y: 0 }, keys = new Set();
  addEventListener("keydown", e => { keys.add(e.code); wakeAudio(); hideStart(); });
  addEventListener("keyup", e => keys.delete(e.code));
  const joy = { id: null, ox: 0, oy: 0, x: 0, y: 0 }, JR = 60;
  canvas.addEventListener("pointerdown", e => {
    wakeAudio(); hideStart();
    if (joy.id !== null) return;
    joy.id = e.pointerId; joy.ox = e.clientX; joy.oy = e.clientY; joy.x = joy.y = 0; canvas.setPointerCapture(e.pointerId);
    const s = $("joy"); s.style.display = ""; s.style.left = e.clientX + "px"; s.style.top = e.clientY + "px"; $("joyK").style.transform = "translate(-50%,-50%)";
  });
  canvas.addEventListener("pointermove", e => {
    if (e.pointerId !== joy.id) return;
    let dx = e.clientX - joy.ox, dy = e.clientY - joy.oy; const L = Math.hypot(dx, dy);
    if (L > JR) { dx *= JR / L; dy *= JR / L; }
    joy.x = dx / JR; joy.y = -dy / JR; $("joyK").style.transform = `translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px))`;
  });
  const joyEnd = e => { if (e.pointerId !== joy.id) return; joy.id = null; joy.x = joy.y = 0; $("joy").style.display = "none"; };
  // スタートの幕は絵の上にかぶさるので、幕を触っても閉じる（スマホで動かなかった 10-31）
  for (const ev of ["pointerdown", "touchstart", "click"]) $("start").addEventListener(ev, () => { wakeAudio(); hideStart(); });
  canvas.addEventListener("pointerup", joyEnd); canvas.addEventListener("pointercancel", joyEnd); canvas.addEventListener("lostpointercapture", joyEnd);
  let padPrev = [];
  function readInput() {
    let x = joy.x, y = joy.y;
    const kx = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0), ky = (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
    if (kx || ky) { const L = Math.hypot(kx, ky); x = kx / L; y = ky / L; }
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
      if (Math.hypot(ax, ay) > 0.18) { x = ax; y = -ay; }
      const pr = p.buttons.map(b => b.pressed);
      if (pr.some(Boolean)) { wakeAudio(); hideStart(); }
      if (pr[3] && !padPrev[3]) setZoom(zoomI + 1);                   // Y: 寄る／引く
      if (pr[9] && !padPrev[9]) toggleShop();                          // スタート: 強化の店
      if (shopOpen) { if (pr[12] && !padPrev[12]) moveShopSel(-1); if (pr[13] && !padPrev[13]) moveShopSel(1); if (pr[0] && !padPrev[0]) buy(Object.keys(UPS)[shopSel]); }   // 十字の上下で選んで A で買う
      padPrev = pr; break;
    }
    if (G.mv) { x = G.mv.x; y = G.mv.y; }
    const L = Math.hypot(x, y); if (L > 1) { x /= L; y /= L; }
    mv.x = x; mv.y = y;
  }

  // ---- カメラ: 南の斜め上から見下ろす（北が画面の上）。寄り・引きは 3 段 ----
  const cam = new B.ArcRotateCamera("cam", -Math.PI / 2, 0.6, 40, new B.Vector3(0, 0, 0), scene);
  cam.inputs.clear(); cam.minZ = 0.5; cam.maxZ = 900; cam.fov = 0.75;
  scene.activeCamera = cam;
  const ZOOMS = [30, 42, 58]; let zoomI = 1;
  function setZoom(i) { zoomI = ((i % ZOOMS.length) + ZOOMS.length) % ZOOMS.length; $("bZoom").textContent = ["🔍＋", "🔍", "🔍－"][zoomI]; }
  $("bZoom").onclick = () => { wakeAudio(); setZoom(zoomI + 1); };
  addEventListener("wheel", e => setZoom(zoomI + (e.deltaY > 0 ? 1 : -1)));
  const camT = new B.Vector3();

  // ---- 動く: スティックの向きへ回りながら進む。建物に当たったら止まって、正面を削りながら押し進む ----
  let speed = 0, rammT = 0;
  const fwd = () => new B.Vector3(Math.sin(ex.heading), 0, Math.cos(ex.heading));
  const wrapA = a => Math.atan2(Math.sin(a), Math.cos(a));
  // 当たり: ショベルの足もと全体（長さ ±2.1・幅 ±1.4）を、運転席の高さ 3.6m まで格子で調べる（1 階に穴を開けて中へ潜れないように）
  const FOOT = []; for (const k of [2.1, 1.05, 0, -1.05, -2.1]) for (const s of [-1.4, 0, 1.4]) FOOT.push([s, k]);
  function overlap(np, h) {
    const f = new B.Vector3(Math.sin(h), 0, Math.cos(h)), r = new B.Vector3(f.z, 0, -f.x);
    let n = 0, front = null;
    for (const [s, k] of FOOT) { const p = np.add(r.scale(s)).add(f.scale(k)); if (cellsNear(p, 0.3, 0.3, 3.6)) { n++; if (!front && k > 0) front = p; } }
    return { n, front };
  }
  const _jit = new B.Vector3(); let ramK = 0;
  function moveEx(dt) {
    const mag = Math.hypot(mv.x, mv.y), top = upV("spd");
    let want = 0;
    const cur = overlap(ex.pos, ex.heading).n;
    if (mag > 0.12) {
      const wantH = Math.atan2(mv.x, mv.y), diff = wrapA(wantH - ex.heading);
      const nh = ex.heading + B.Scalar.Clamp(diff, -4.2 * dt, 4.2 * dt);
      if (overlap(ex.pos, nh).n <= cur) ex.heading = nh;   // 回ると建物にめり込む時は回らない
      want = top * mag * Math.max(0, Math.cos(diff));
    }
    speed += (want - speed) * Math.min(1, dt * (want > speed ? 3 : 6));
    if (speed < 0.02) speed = 0;
    ramK = Math.max(0, ramK - dt * 4);
    if (!speed) return 0;
    const np = ex.pos.add(fwd().scale(speed * dt)), o = overlap(np, ex.heading);
    if (o.n === 0 || o.n < cur) { ex.pos.copyFrom(np); }
    else {
      // 当たった: 片方の向きだけでも進めるならすべる（角で引っかからない）。だめなら止まってガガガと削る
      const nx = new B.Vector3(np.x, 0, ex.pos.z), nz = new B.Vector3(ex.pos.x, 0, np.z);
      if (!overlap(nx, ex.heading).n) ex.pos.copyFrom(nx); else if (!overlap(nz, ex.heading).n) ex.pos.copyFrom(nz);
      speed = Math.min(speed, 1.2);
      ramK = 1;
      const hit = o.front || np.add(fwd().scale(2.1));
      if ((rammT -= dt) <= 0) {
        rammT = 0.13 / Math.sqrt(upV("pow"));
        const n = smash(new B.Vector3(hit.x, 0.6 + Math.random() * 2.4, hit.z), 0.8 + upV("pow") * 0.1, fwd(), 10, 3);
        playS("bucket_hit", 0.45, 0.75 + Math.random() * 0.3); sparks(new B.Vector3(hit.x, 1 + Math.random() * 2, hit.z), 8); shake(0.06);
        if (n) broke(n, hit, false); else dust(new B.Vector3(hit.x, 1, hit.z), 6);
      }
    }
    const lim = HALF + 30; ex.pos.x = B.Scalar.Clamp(ex.pos.x, -lim, lim); ex.pos.z = B.Scalar.Clamp(ex.pos.z, -lim, lim);
    return speed / top;
  }

  // ---- まとめて削る（腕・体当たり・爆発・倒れた塔）。juuki の carveAt は 1 回 10 個まで ----
  // 体当たり中はショベルが小刻みに揺れる（ガガガガ）
  function ramShake() { if (!ramK) return; _jit.set((Math.random() - 0.5) * 0.09 * ramK, Math.random() * 0.05 * ramK, (Math.random() - 0.5) * 0.09 * ramK); root.position.addInPlace(_jit); root.computeWorldMatrix(true); }
  function smash(p, r, dir, maxN = 60, kickP = 2.5) {
    let n = 0;
    const lx = Math.floor((p.x - bld.origin.x) / CELL), ly = Math.floor((p.y - bld.origin.y) / CELL), lz = Math.floor((p.z - bld.origin.z) / CELL), k = Math.ceil(r / CELL);
    for (let x = lx - k; x <= lx + k; x++) for (let y = Math.max(0, ly - k); y <= ly + k; y++) for (let z = lz - k; z <= lz + k; z++) {
      if (n >= maxN) break;
      const c = bld.cells.get(key(x, y, z)); if (!c) continue;
      if (B.Vector3.Distance(c.p, p) > r) continue;
      const kick = c.p.subtract(p).normalize().scale(kickP); if (dir) kick.addInPlace(dir.scale(kickP * 0.8));
      carvedToDebris(c, kick); n++;
      if (n % 3 === 0) chainAbove(c.x, c.y, c.z, 0);
    }
    if (n) dirty = true;
    return n;
  }
  // 1 番近い格子（腕の届く所）を探す: 正面から左右へ、近くから遠くへ、低い所から
  const _tp = new B.Vector3();
  function findCellTarget() {
    for (const a of [0, 0.3, -0.3, 0.65, -0.65, 1.0, -1.0, 1.45, -1.45, 2.0, -2.0, 2.6, -2.6, 3.14])
      for (const d of [3.8, 5.0, 6.3, 7.6])
        for (const y of [0.8, 2.3, 4.0, 5.8, 7.5]) {
          const h = ex.heading + a; _tp.set(ex.pos.x + Math.sin(h) * d, y, ex.pos.z + Math.cos(h) * d);
          const lx = Math.floor((_tp.x - bld.origin.x) / CELL), ly = Math.floor(_tp.y / CELL), lz = Math.floor((_tp.z - bld.origin.z) / CELL);
          for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) { const c = bld.cells.get(key(lx + dx, ly + dy, lz + dz)); if (c) return { p: c.p.clone(), kind: "cell", d }; }
        }
    return null;
  }
  // ---- 腕: 届く所に何かあれば、勝手に振り上げて叩きつける（ゾンビ＞車＞建物の順に狙う） ----
  const arm = { ph: "idle", t: 0, tg: null, from: null };
  const POSE_REST = { boom: -0.55, stick: 1.5, bucket: 1.1 }, POSE_UP = { boom: -0.98, stick: 0.8, bucket: 0.2 };
  const slamPose = tg => {
    const d = Math.hypot(tg.p.x - ex.pos.x, tg.p.z - ex.pos.z), y = tg.p.y;
    return { boom: B.Scalar.Clamp(0.42 - (y - 0.8) * 0.11 - (d - 4) * 0.03, -0.9, 0.55), stick: B.Scalar.Clamp(2.1 - (d - 3.5) * 0.32, 0.5, 2.4), bucket: 1.7 };
  };
  function findTarget() {
    let best = null, bd = 1e9;
    for (const z of zombies) { if (z.state !== "walk") continue; const d = Math.hypot(z.pos.x - ex.pos.x, z.pos.z - ex.pos.z); if (d < 7.5 && d > 1.5 && d < bd) { bd = d; best = { p: z.pos.add(new B.Vector3(0, 1, 0)), kind: "zombie", ref: z }; } }
    if (best) return best;
    for (const c of props) { if (c.kind !== "car" || c.state === "fly" || c.state === "gone") continue; const d = Math.hypot(c.pos.x - ex.pos.x, c.pos.z - ex.pos.z); if (d < 7.5 && d < bd) { bd = d; best = { p: c.pos.add(new B.Vector3(0, 0.9, 0)), kind: "car", ref: c }; } }
    if (best) return best;
    return findCellTarget();
  }
  const lerpPose = (a, b, k) => { ex.boom = a.boom + (b.boom - a.boom) * k; ex.stick = a.stick + (b.stick - a.stick) * k; ex.bucket = a.bucket + (b.bucket - a.bucket) * k; };
  const curPose = () => ({ boom: ex.boom, stick: ex.stick, bucket: ex.bucket });
  function updateArm(dt) {
    const T = 0.62 / Math.sqrt(upV("pow"));
    // 上の旋回体を目標へ向ける（何も無ければ前へ戻す）
    const aim = arm.tg ? Math.atan2(arm.tg.p.x - ex.pos.x, arm.tg.p.z - ex.pos.z) - ex.heading : 0;
    ex.swing += B.Scalar.Clamp(wrapA(aim - ex.swing), -6 * dt, 6 * dt);
    arm.t += dt;
    if (arm.ph === "idle") {
      lerpPose(curPose(), POSE_REST, Math.min(1, dt * 3));
      if ((arm.cool -= dt) > 0) return false;
      arm.cool = 0.12;
      const tg = findTarget(); if (!tg) { arm.tg = null; return false; }
      arm.tg = tg; arm.ph = "up"; arm.t = 0; arm.from = curPose(); return true;
    }
    if (arm.ph === "up") { const k = Math.min(1, arm.t / (T * 0.45)); lerpPose(arm.from, POSE_UP, 1 - Math.pow(1 - k, 2)); if (k >= 1) { arm.ph = "down"; arm.t = 0; arm.from = curPose(); arm.slam = slamPose(arm.tg); playS("exc_hydraulic", 0); } return true; }
    if (arm.ph === "down") { const k = Math.min(1, arm.t / (T * 0.22)); lerpPose(arm.from, arm.slam, k * k); if (k >= 1) { impact(arm.tg); arm.ph = "back"; arm.t = 0; arm.from = curPose(); } return true; }
    if (arm.ph === "back") { const k = Math.min(1, arm.t / (T * 0.33)); lerpPose(arm.from, POSE_REST, k); if (k >= 1) { arm.ph = "idle"; arm.cool = 0; } return true; }
    return false;
  }
  function impact(tg) {
    const pw = upV("pow"), R = 1.25 + pw * 0.38, dir = new B.Vector3(tg.p.x - ex.pos.x, 0, tg.p.z - ex.pos.z).normalize();
    let p = tg.p;
    if (tg.kind === "zombie") { p = tg.ref.pos.add(new B.Vector3(0, 1, 0)); zombieHit(tg.ref, dir, 2); }
    if (tg.kind === "car") { p = tg.ref.pos.add(new B.Vector3(0, 0.8, 0)); carHit(tg.ref, dir, 1.2 * pw); }
    const wood = tg.kind === "cell" && woodNear(p);
    const n = smash(p, R, dir, 70 + pw * 30, 3 + pw);
    if (n) { broke(n, p, n >= 25); playS("bucket_hit", 0.8, 0.85 + Math.random() * 0.2); }
    if (wood && n && Math.random() < 0.12) { startFire(p.clone(), 14 + Math.random() * 10); popup("もえだした！", "mid"); }   // 木造の家は火が付くことがある
    else { dust(new B.Vector3(p.x, 0.3, p.z), 14); playS("bucket_hit", 0.4, 0.7); }   // 空振り・ゾンビだけの時は画面を揺らさない（何もしていないのに揺れっぱなしになった 10-30）
    hitAround(p, R + 1.2, dir, 1.2 * pw, tg.ref);
  }

  const WOODK = new Set(["wood", "beam", "wfloor"]);
  function woodNear(p) {   // p の周りに木の格子があるか
    const lx = Math.floor((p.x - bld.origin.x) / CELL), ly = Math.floor(p.y / CELL), lz = Math.floor((p.z - bld.origin.z) / CELL);
    for (let x = lx - 2; x <= lx + 2; x++) for (let y = Math.max(0, ly - 2); y <= ly + 2; y++) for (let z = lz - 2; z <= lz + 2; z++) { const c = bld.cells.get(key(x, y, z)); if (c && WOODK.has(c.kind)) return true; }
    return false;
  }
  // ---- 爆発・火事・水 ----
  const fxTex = dustTex;
  const boomLight = new B.PointLight("boomLight", new B.Vector3(0, 3, 0), scene); boomLight.diffuse = new B.Color3(1, 0.55, 0.2); boomLight.intensity = 0; boomLight.range = 40;
  const boomPool = [];
  for (let i = 0; i < 3; i++) {
    const f = new B.ParticleSystem("fireball" + i, 160, scene); f.particleTexture = fxTex; f.emitter = new B.Vector3(0, -50, 0);
    f.color1 = new B.Color4(1, 0.9, 0.45, 1); f.color2 = new B.Color4(1, 0.45, 0.1, 1); f.colorDead = new B.Color4(0.25, 0.05, 0, 0);
    f.addSizeGradient(0, 1.5, 3); f.addSizeGradient(1, 4, 7.5); f.minLifeTime = 0.35; f.maxLifeTime = 0.85; f.emitRate = 0; f.manualEmitCount = 0;
    f.blendMode = B.ParticleSystem.BLENDMODE_ADD; f.gravity = new B.Vector3(0, 4, 0); f.createSphereEmitter(1.2); f.minEmitPower = 4; f.maxEmitPower = 13;
    const s = new B.ParticleSystem("boomSmoke" + i, 90, scene); s.particleTexture = fxTex; s.emitter = f.emitter;
    s.color1 = new B.Color4(0.2, 0.18, 0.17, 0.75); s.color2 = new B.Color4(0.32, 0.28, 0.25, 0.6); s.colorDead = new B.Color4(0.3, 0.28, 0.26, 0);
    s.addSizeGradient(0, 3, 5); s.addSizeGradient(1, 9, 14); s.minLifeTime = 1.8; s.maxLifeTime = 3.4; s.emitRate = 0; s.manualEmitCount = 0;
    s.blendMode = B.ParticleSystem.BLENDMODE_STANDARD; s.gravity = new B.Vector3(0, 2.5, 0); s.createSphereEmitter(1.5); s.minEmitPower = 2; s.maxEmitPower = 6;
    f.renderingGroupId = s.renderingGroupId = 1; f.start(); s.start(); boomPool.push([f, s]);
  }
  let boomI = 0, lightK = 0;
  const pendingBooms = [];
  function explode(p, pw = 1) {
    const [f, s] = boomPool[boomI++ % boomPool.length], e = p.clone(); e.y = Math.max(0.8, e.y);
    f.emitter = e; s.emitter = e; f.manualEmitCount = Math.round(70 + pw * 50); s.manualEmitCount = Math.round(25 + pw * 20);
    boomLight.position.copyFrom(e).addInPlaceFromFloats(0, 2, 0); lightK = Math.max(lightK, 1);
    flash(Math.min(0.75, 0.4 + pw * 0.2), true); shake(Math.min(1, 0.6 + pw * 0.3)); if (!G.fixedDt) hitStop = Math.max(hitStop, 0.1 + pw * 0.04);
    playS("boom", Math.min(1, 0.7 + pw * 0.2), 0.75 + Math.random() * 0.15); playS("impact", 0.7, 0.6, 0.03); playS("glass", 0.5, 1, 0.08); crash(1);
    popup(pw >= 1.5 ? "ドッカーーン!!" : "ドカーン!!", "big");
    const R = 2.4 + pw * 1.3;
    const n = smash(e, R, null, 400, 9 + pw * 3); if (n) broke(n, e, true);
    hitAround(e, R * 2.4, null, 3 * pw, null);
    for (const d of debris) if (d.ag && !d.held) { const v = d.m.position.subtract(e); const L = v.length(); if (L < R * 2.5) { v.y = Math.abs(v.y) + 2; d.ag.body.setLinearVelocity(v.normalize().scale((R * 2.5 - L) * 3)); } }
    for (let k = 0; k < 2 + pw * 2; k++) startFire(e.add(new B.Vector3((Math.random() - 0.5) * R * 2, Math.random() * 2, (Math.random() - 0.5) * R * 2)), 9 + Math.random() * 8);
    // 近くのガスメーターも誘爆（少し遅れて）
    for (const c of cellsIn(e, R + 3)) if (c.gm && !c.gm.done) { c.gm.done = true; pendingBooms.push({ p: c.p.clone(), pw: c.gm.big ? 1.6 : 1, t: 0.12 + Math.random() * 0.25 }); }
    scorch(e.x, e.z, R * 1.6);
  }
  function cellsIn(p, r) {   // p の周り r の格子（爆発の誘爆を探す用）
    const out = [], lx = Math.floor((p.x - bld.origin.x) / CELL), ly = Math.floor(p.y / CELL), lz = Math.floor((p.z - bld.origin.z) / CELL), k = Math.ceil(r / CELL);
    for (let x = lx - k; x <= lx + k; x += 1) for (let y = Math.max(0, ly - k); y <= ly + k; y += 1) for (let z = lz - k; z <= lz + k; z += 1) { const c = bld.cells.get(key(x, y, z)); if (c && c.gm) out.push(c); }
    return out;
  }
  // 格子が壊れた時の仕掛け: ガスメーター＝爆発・水道管＝噴き出す
  function special(c) {
    if (c.gm && !c.gm.done) { c.gm.done = true; pendingBooms.push({ p: c.p.clone(), pw: c.gm.big ? 1.6 : 1, t: 0.08 }); popup("ガスもれ…!?", "mid"); }
    else if (c.kind === "pipe" && !c.wet) { c.wet = true; if (playT - (special.wT || -9) > 1) { special.wT = playT; geyser(new B.Vector3(c.p.x, 0.3, c.p.z)); } }
  }
  // 火事: 炎＋黒い煙。近くの格子を少しずつ焼いて崩す。燃え移る。水で消える
  // 粒の仕組みは最初に作って使い回す（途中で作ると、絵の準備（シェーダー）が間に合わず最初の火が出ない・カクッとする）
  const fires = [], FIRE_MAX = 10, firePool = [];
  for (let i = 0; i < FIRE_MAX; i++) {
    const f = new B.ParticleSystem("fire", 90, scene); f.particleTexture = fxTex; f.emitter = new B.Vector3(0, -50, 0);
    f.color1 = new B.Color4(1, 0.75, 0.25, 0.9); f.color2 = new B.Color4(1, 0.35, 0.08, 0.85); f.colorDead = new B.Color4(0.3, 0.05, 0, 0);
    f.addSizeGradient(0, 1.6, 2.6); f.addSizeGradient(1, 0.4, 0.9); f.minLifeTime = 0.35; f.maxLifeTime = 0.8; f.emitRate = 70;
    f.blendMode = B.ParticleSystem.BLENDMODE_ADD; f.gravity = new B.Vector3(0, 5, 0); f.minEmitBox = new B.Vector3(-0.7, 0, -0.7); f.maxEmitBox = new B.Vector3(0.7, 0.4, 0.7);
    f.direction1 = new B.Vector3(-0.4, 1, -0.4); f.direction2 = new B.Vector3(0.4, 2, 0.4); f.minEmitPower = 0.5; f.maxEmitPower = 1.5;
    const s = new B.ParticleSystem("smoke", 50, scene); s.particleTexture = fxTex; s.emitter = f.emitter;
    s.color1 = new B.Color4(0.12, 0.11, 0.1, 0.5); s.color2 = new B.Color4(0.25, 0.23, 0.22, 0.4); s.colorDead = new B.Color4(0.3, 0.3, 0.3, 0);
    s.addSizeGradient(0, 2, 3); s.addSizeGradient(1, 7, 11); s.minLifeTime = 2.2; s.maxLifeTime = 3.8; s.emitRate = 14;
    s.blendMode = B.ParticleSystem.BLENDMODE_STANDARD; s.gravity = new B.Vector3(0.6, 2.5, 0.3); s.minEmitPower = 0.5; s.maxEmitPower = 1.5; s.direction1 = new B.Vector3(-0.3, 1, -0.3); s.direction2 = new B.Vector3(0.3, 1, 0.3);
    f.renderingGroupId = s.renderingGroupId = 1; f.emitRate = s.emitRate = 0; f.start(); s.start();
    firePool.push({ f, s });
  }
  function freeFire(q) { q.f.emitRate = q.s.emitRate = 0; firePool.push({ f: q.f, s: q.s }); }
  function startFire(p, life, car) {
    if (!firePool.length) freeFire(fires.shift());
    const { f, s } = firePool.pop(); f.emitter = p.clone(); s.emitter = f.emitter; f.emitRate = 70; s.emitRate = 14;
    fires.push({ p: f.emitter, f, s, life, t: 0, burnT: 0.4, car });
  }
  function updateFires(dt) {
    for (let i = fires.length - 1; i >= 0; i--) {
      const q = fires[i]; q.t += dt;
      if (q.car) q.p.copyFrom(q.car.pos).addInPlaceFromFloats(0, 1.2, 0);
      if (q.t > q.life) { freeFire(q); fires.splice(i, 1); continue; }
      if (q.t > q.life - 1.5) { q.f.emitRate = 70 * (q.life - q.t) / 1.5; }
      if ((q.burnT -= dt) > 0 || q.car) continue;
      q.burnT = 0.55 + Math.random() * 0.4;
      // まわりの格子を 1〜2 個焼く（黒くなって崩れる）。たまに上や横へ燃え移る
      const near = []; const lx = Math.floor((q.p.x - bld.origin.x) / CELL), ly = Math.floor(q.p.y / CELL), lz = Math.floor((q.p.z - bld.origin.z) / CELL);
      for (let x = lx - 3; x <= lx + 3; x++) for (let y = Math.max(0, ly - 2); y <= ly + 4; y++) for (let z = lz - 3; z <= lz + 3; z++) { const c = bld.cells.get(key(x, y, z)); if (c) near.push(c); }
      if (!near.length) { q.life = Math.min(q.life, q.t + 2); continue; }
      const wd = near.some(c => WOODK.has(c.kind));   // 木はよく燃える（たくさん焼けて、よく燃え移る）
      for (let k = 0; k < (wd ? 4 : 2); k++) { const c = near[Math.floor(Math.random() * near.length)]; if (!bld.cells.has(key(c.x, c.y, c.z))) continue; c.burnt = true; carvedToDebris(c, new B.Vector3(0, -0.5, 0)); chainAbove(c.x, c.y, c.z, 2); dirty = true; }
      if (Math.random() < (wd ? 0.45 : 0.22) && fires.length < FIRE_MAX) { const c = near[Math.floor(Math.random() * near.length)]; if (c.y >= ly) startFire(c.p.add(new B.Vector3(0, 0.6, 0)), 8 + Math.random() * 8); }
      if (Math.random() < 0.3) playS("crash_small", 0.15, 1.4);
    }
  }
  // 水道管の破裂: 白い水柱が噴き上がる（近くの火は消える）
  const geysers = [], waterPool = [];
  for (let i = 0; i < 4; i++) {
    const w = new B.ParticleSystem("water", 400, scene); w.particleTexture = fxTex; w.emitter = new B.Vector3(0, -50, 0);
    w.color1 = new B.Color4(0.85, 0.93, 1, 0.85); w.color2 = new B.Color4(0.6, 0.78, 0.95, 0.7); w.colorDead = new B.Color4(0.8, 0.9, 1, 0);
    w.minSize = 0.25; w.maxSize = 0.7; w.minLifeTime = 1.0; w.maxLifeTime = 1.7; w.emitRate = 260;
    w.blendMode = B.ParticleSystem.BLENDMODE_STANDARD; w.gravity = new B.Vector3(0, -9.8, 0);
    w.direction1 = new B.Vector3(-0.25, 1, -0.25); w.direction2 = new B.Vector3(0.25, 1, 0.25); w.minEmitPower = 10; w.maxEmitPower = 14; w.minEmitBox = new B.Vector3(-0.2, 0, -0.2); w.maxEmitBox = new B.Vector3(0.2, 0, 0.2);
    w.renderingGroupId = 1; w.emitRate = 0; w.start(); waterPool.push(w);
  }
  function geyser(p, life = 7) {
    if (!waterPool.length) { const g0 = geysers.shift(); g0.w.emitRate = 0; waterPool.push(g0.w); }
    const w = waterPool.pop(); w.emitter = p.clone(); w.emitRate = 260;
    geysers.push({ w, p: w.emitter, life, t: 0 });
    playS("wind_gust", 0.7, 1.6); playS("impact", 0.4, 1.3); popup("ブシャーー!!", "mid"); shake(0.3);
    hiss(life);
  }
  function hiss(life) {   // シャーッ（白い雑音を高い所だけ通す）
    if (!ac || ac.state !== "running") return;
    const t = ac.currentTime, n = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    n.buffer = NB(); n.loop = true; f.type = "highpass"; f.frequency.value = 2200;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.16, t + 0.1); g.gain.setValueAtTime(0.16, t + life - 1); g.gain.linearRampToValueAtTime(0.0001, t + life);
    n.connect(f).connect(g).connect(OUT()); n.start(t); n.stop(t + life + 0.1);
  }
  function updateGeysers(dt) {
    for (let i = geysers.length - 1; i >= 0; i--) {
      const g = geysers[i]; g.t += dt;
      if (g.t > g.life) { g.w.emitRate = 0; waterPool.push(g.w); geysers.splice(i, 1); continue; }
      if (g.t > g.life - 1.5) g.w.emitRate = 260 * (g.life - g.t) / 1.5;
      for (const q of fires) if (Math.hypot(q.p.x - g.p.x, q.p.z - g.p.z) < 8) q.life = Math.min(q.life, q.t + 0.8);   // 水で火が消える
    }
  }

  // ---- 車・木・街灯・消火栓・ゾンビへの当たり ----
  function hitAround(p, r, dir, pw, skip) {
    for (const q of props) if (q !== skip && q.state !== "gone" && q.state !== "fly") { const d = Math.hypot(q.pos.x - p.x, q.pos.z - p.z); if (d < r + q.r) propHit(q, dir || new B.Vector3(q.pos.x - p.x, 0, q.pos.z - p.z).normalize(), pw * (1 - d / (r + q.r) * 0.5)); }
    for (const z of zombies) if (z !== skip && z.state === "walk") { const d = Math.hypot(z.pos.x - p.x, z.pos.z - p.z); if (d < r + 0.5) zombieHit(z, dir || new B.Vector3(z.pos.x - p.x, 0, z.pos.z - p.z).normalize(), pw); }
  }
  function propHit(q, dir, pw) {
    if (q.frozen) freezeProp(q, false);
    if (q.kind === "car") return carHit(q, dir, pw);
    if (q.state !== "up") return;
    q.state = "fall"; q.t = 0; q.fdir = dir.clone(); q.fdir.y = 0; q.fdir.normalize();
    if (q.kind === "tree") { playS("crash_small", 0.4, 1.3); dust(q.pos.add(new B.Vector3(0, 2, 0)), 10); }
    if (q.kind === "lamp") { playS("bolt_impact", 0.5, 0.9); sparks(q.pos.add(new B.Vector3(0, 5.8, 0)), 18); }
    if (q.kind === "hyd") { geyser(q.pos.add(new B.Vector3(0, 0.6, 0)), 8); q.root.setEnabled(false); q.state = "gone"; }
  }
  const _carCol = (c, k) => col4(c[0] * k, c[1] * k, c[2] * k);
  function carHit(c, dir, pw) {
    if (c.frozen) freezeProp(c, false);
    if (c.state === "gone" || c.state === "fly" || c.state === "collect") return;
    c.hp -= pw;
    c.state = "fly"; c.t = 0;
    c.vel.copyFrom(dir).scaleInPlace(4 + pw * 4); c.vel.y = 3.5 + pw * 3.5; c.av.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 6);
    c.body.scaling.y *= 0.82; c.body.scaling.x *= 1.04;   // ぺしゃんこ
    const k = c.hp > 0 ? 0.7 : 0.25; for (const m of [c.body, c.parts[2]]) m.instancedBuffers.color = _carCol(c.cc, k);
    playS("crash_big", 0.6, 1.25); playS("glass", 0.6, 1.1, 0.03); glassBurst(c.pos.add(new B.Vector3(0, 1.4, 0)), 12); sparks(c.pos.add(new B.Vector3(0, 1, 0)), 14); shake(0.3);
    if (c.hp <= 0 && !c.fuse) { c.fuse = 0.7 + Math.random() * 0.8; startFire(c.pos.add(new B.Vector3(0, 1.2, 0)), 7, c); }   // 燃え出して、少しして爆発
  }
  function zombieHit(z, dir, pw) {
    if (z.state !== "walk") return;
    z.state = "fly"; z.t = 0; z.vel.copyFrom(dir).scaleInPlace(6 + pw * 3); z.vel.y = 5 + pw * 2.5; z.av.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 14);
    playS("impact", 0.55, 1.3); playS("popup", 0.35, 0.6); groan(0.25, 1.4);
  }
  function updateProps(dt) {
    const exr = 2.6;
    for (let i = props.length - 1; i >= 0; i--) {
      const q = props[i];
      if (q.state === "gone") continue;
      const dx = q.pos.x - ex.pos.x, dz = q.pos.z - ex.pos.z, dd = Math.hypot(dx, dz);
      if ((q.state === "up" || q.state === "park" || q.state === "drive") && dd < exr + q.r * 0.6) propHit(q, new B.Vector3(dx, 0, dz).normalize(), 0.8 + speed / 6);   // 体当たり
      if (q.state === "drive") driveCar(q, dt, dd);
      else if (q.state === "fall") {
        q.t += dt; const k = Math.min(1, q.t / 0.55), ang = k * k * 1.45;
        q.root.rotation.x = ang * q.fdir.z; q.root.rotation.z = -ang * q.fdir.x;
        if (k >= 1 && !q.landed) { q.landed = true; dust(q.pos.add(q.fdir.scale(q.h * 0.6)), 16); playS("crash_small", 0.35, 1.1); if (q.kind === "lamp") sparks(q.pos.add(q.fdir.scale(q.h)), 12); }
        if (q.t > 1.2) q.state = "down";
      } else if (q.state === "fly") {
        q.t += dt; q.vel.y -= 16 * dt; q.pos.addInPlace(q.vel.scale(dt));
        q.root.rotation.addInPlace(q.av.scale(dt));
        if (cellsNear(q.pos.add(new B.Vector3(0, 0.8, 0)), 0.9, 0.9, q.pos.y + 1.4)) {   // 飛んだ車が建物に刺さる
          const n = smash(q.pos.add(new B.Vector3(0, 1, 0)), 1.4, q.vel.clone().normalize(), 25, 3); if (n) broke(n, q.pos, n > 6);
          q.vel.x *= -0.3; q.vel.z *= -0.3;
        }
        if (q.pos.y < 0) { q.pos.y = 0; if (Math.abs(q.vel.y) > 2.5) { playS("crash_small", 0.5, 0.9); dust(q.pos, 10); } q.vel.y = -q.vel.y * 0.3; q.vel.x *= 0.6; q.vel.z *= 0.6; q.av.scaleInPlace(0.5); if (Math.abs(q.vel.y) < 1.2) { q.vel.setAll(0); q.av.setAll(0); q.state = "down"; q.root.rotation.x = Math.round(q.root.rotation.x / Math.PI) * Math.PI; q.root.rotation.z = Math.round(q.root.rotation.z / Math.PI) * Math.PI; } }
        hitAround(q.pos, 1.8, q.vel.clone().normalize(), 0.8, q);   // 飛んだ車が別の車やゾンビに当たる
      }
      if (q.fuse !== undefined && q.fuse > 0 && (q.fuse -= dt) <= 0) { q.fuse = -1; explode(q.pos.add(new B.Vector3(0, 0.8, 0)), 1.1); q.state = "fly"; q.vel.set((Math.random() - 0.5) * 3, 11, (Math.random() - 0.5) * 3); q.av.set(4, 2, 3); for (const m of q.parts) m.instancedBuffers.color = col4(0.08, 0.07, 0.07); }
      // 倒れた物・つぶれた車は、近くに来たら荷台へ吸い込む
      if (q.state === "down" && !(q.fuse > 0) && dd < upV("suck") && bed.load < upV("cap")) { q.state = "collect"; flyToBed({ node: q.root, val: q.val, done: () => { q.root.dispose(); q.state = "gone"; props.splice(props.indexOf(q), 1); } }); }
    }
  }
  function driveCar(c, dt, dd) {
    const l = c.lane, f = new B.Vector3(Math.sin(c.root.rotation.y), 0, Math.cos(c.root.rotation.y));
    const toEx = new B.Vector3(ex.pos.x - c.pos.x, 0, ex.pos.z - c.pos.z), ahead = B.Vector3.Dot(toEx, f);
    let v = 8;
    if (ahead > 0 && ahead < 12 && Math.abs(B.Vector3.Cross(toEx, f).y) < 3) { v = 0; if ((c.honkT -= dt) <= 0) { c.honkT = 2.5 + Math.random() * 2; if (dd < 30) playS("truck_horn", 0.25, 1.5); } }   // ショベルが前にいたら止まってクラクション
    if (cellsNear(c.pos.add(f.scale(3)), 0.8, 0.8, 1.5)) { v = 0; c.state = "park"; }   // がれきや建物で道がふさがれたら止まる
    const s0 = l.s; l.s += l.dir * v * dt;
    const node = k => -HALF + k * PITCH, k0 = Math.floor((s0 + HALF) / PITCH), k1 = Math.floor((l.s + HALF) / PITCH);
    if (k0 !== k1) {   // 交差点を過ぎた: 4 割で曲がる
      const nodeS = node(Math.max(k0, k1));
      if (Math.random() < 0.4) { const ns = l.line; l.line = nodeS; l.ax = l.ax === "x" ? "z" : "x"; l.dir = Math.random() < 0.5 ? 1 : -1; l.s = ns; }
    }
    if (l.s > HALF + 10) l.s = -HALF - 10; if (l.s < -HALF - 10) l.s = HALF + 10;
    placeLane(c);
  }
  function updateZombies(dt) {
    while (zombies.filter(z => z.state === "walk").length < ZMAX) if (!spawnZombieNear(ex.pos)) break;
    for (let i = zombies.length - 1; i >= 0; i--) {
      const z = zombies[i];
      if (z.state === "walk") {
        const dx = ex.pos.x - z.pos.x, dz = ex.pos.z - z.pos.z, d = Math.hypot(dx, dz);
        if (d > 90) { z.root.dispose(); zombies.splice(i, 1); continue; }
        let h = z.wander; if (d < 32) h = Math.atan2(dx, dz); else if (Math.random() < dt * 0.3) z.wander += (Math.random() - 0.5) * 2;
        z.root.rotation.y += wrapA(h - z.root.rotation.y) * Math.min(1, dt * 3);
        const v = d < 3 ? 0 : z.spd, np = z.pos.add(new B.Vector3(Math.sin(z.root.rotation.y), 0, Math.cos(z.root.rotation.y)).scale(v * dt));
        if (!cellsNear(np.add(new B.Vector3(0, 0.5, 0)), 0.25, 0.25, 1.5)) z.pos.copyFrom(np); else z.wander += 1.5;
        z.t += dt * (2 + z.spd * 2);
        z.legs[0].rotation.x = Math.sin(z.t) * 0.6; z.legs[1].rotation.x = -Math.sin(z.t) * 0.6;
        z.arms[0].rotation.x = -0.15 + Math.sin(z.t * 0.5) * 0.15; z.arms[1].rotation.x = -0.15 - Math.sin(z.t * 0.5) * 0.15; z.hip.position.y = 0.92 + Math.abs(Math.sin(z.t)) * 0.05; z.headN.rotation.z = Math.sin(z.t * 0.5) * 0.25; z.hip.rotation.z = Math.sin(z.t) * 0.08;   // よろよろ歩き
        if (d < 3.2) { z.arms[0].rotation.x = z.arms[1].rotation.x = -0.6 + Math.sin(z.t * 3) * 0.4; }   // しがみついて叩く
        if ((z.groanT -= dt) <= 0) { z.groanT = 4 + Math.random() * 8; if (d < 28) groan(0.12 * (1 - d / 30), 0.8 + Math.random() * 0.3); }
        if (d < 2.2 && speed > 1.5) zombieHit(z, new B.Vector3(-dx, 0, -dz).normalize(), speed / 4);   // ひく
      } else if (z.state === "fly") {
        z.t += dt; z.vel.y -= 14 * dt; z.pos.addInPlace(z.vel.scale(dt)); z.root.rotation.addInPlace(z.av.scale(dt));
        if (z.pos.y < 0 || z.t > 1.1) { poof(z.pos.add(new B.Vector3(0, 0.8, 0))); z.root.dispose(); zombies.splice(i, 1); kills++; sv.money += 5; saveDirty = true; popup("ゾンビ +¥5", "tiny gold"); }
      }
    }
  }
  let kills = 0, poofPS = null;
  function poof(p) {   // ゾンビが消える緑の煙
    if (!poofPS) {
      poofPS = new B.ParticleSystem("poof", 200, scene); poofPS.particleTexture = fxTex; poofPS.emitRate = 0; poofPS.manualEmitCount = 0;
      poofPS.color1 = new B.Color4(0.45, 0.85, 0.3, 0.8); poofPS.color2 = new B.Color4(0.3, 0.6, 0.2, 0.6); poofPS.colorDead = new B.Color4(0.3, 0.5, 0.2, 0);
      poofPS.addSizeGradient(0, 0.6, 1); poofPS.addSizeGradient(1, 2, 3); poofPS.minLifeTime = 0.5; poofPS.maxLifeTime = 1; poofPS.createSphereEmitter(0.5); poofPS.minEmitPower = 1; poofPS.maxEmitPower = 3;
      poofPS.blendMode = B.ParticleSystem.BLENDMODE_STANDARD; poofPS.renderingGroupId = 1; poofPS.start();
    }
    poofPS.emitter = p.clone(); poofPS.manualEmitCount = 26; playS("popup", 0.3, 0.7);
  }
  function groan(v, rate) {   // ゾンビのうなり声（低いのこぎり波を口の形のフィルターで）
    if (!ac || ac.state !== "running") return;
    const t = ac.currentTime, o = ac.createOscillator(), f = ac.createBiquadFilter(), g = ac.createGain(), L = 0.8 + Math.random() * 0.6;
    o.type = "sawtooth"; o.frequency.setValueAtTime(95 * rate, t); o.frequency.linearRampToValueAtTime(70 * rate, t + L);
    f.type = "bandpass"; f.frequency.setValueAtTime(500, t); f.frequency.linearRampToValueAtTime(320, t + L); f.Q.value = 3;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.15); g.gain.exponentialRampToValueAtTime(0.0005, t + L);
    o.connect(f).connect(g).connect(OUT()); o.start(t); o.stop(t + L + 0.05);
  }
  // 窓ガラスが割れたキラキラ
  let glassPS = null;
  function glassBurst(p, n) {
    if (!glassPS) {
      glassPS = new B.ParticleSystem("glassPS", 160, scene); glassPS.particleTexture = fxTex; glassPS.emitRate = 0; glassPS.manualEmitCount = 0;
      glassPS.color1 = new B.Color4(0.85, 0.95, 1, 1); glassPS.color2 = new B.Color4(0.6, 0.8, 0.95, 1); glassPS.colorDead = new B.Color4(0.7, 0.85, 1, 0);
      glassPS.minSize = 0.06; glassPS.maxSize = 0.16; glassPS.minLifeTime = 0.5; glassPS.maxLifeTime = 0.9; glassPS.gravity = new B.Vector3(0, -12, 0);
      glassPS.createSphereEmitter(0.6); glassPS.minEmitPower = 2; glassPS.maxEmitPower = 5; glassPS.blendMode = B.ParticleSystem.BLENDMODE_ADD; glassPS.renderingGroupId = 1; glassPS.start();
    }
    glassPS.emitter = p.clone(); glassPS.manualEmitCount = Math.min(60, n * 6);
    if (playT - (glassBurst.t || -9) > 0.3) { glassBurst.t = playT; playS("glass", 0.35, 1.05 + Math.random() * 0.2); }
  }
  // 大きな建物が沈んだ: 出てくるがれきは大きさで値段が決まる。ここでは大物の合図だけ
  function sinkValue(n) { if (n > 1500) popup("おおもの！ " + n, "mile"); }
  // 倒れた塔の先にある物も壊す（ドミノ）
  function toppleHit(q) {
    // 倒れた建物が横たわる所（長さ＝高さ・幅＝建物の幅・厚み＝幅くらい）をまとめて壊す。そこの建物は崩れて、また倒れることもある（ドミノ）
    const L = q.H, W = Math.max(3, q.W || 3), side = new B.Vector3(-q.fdz, 0, q.fdx), dir = new B.Vector3(q.fdx, -0.4, q.fdz);
    let n = 0;
    for (let k = 1.5; k <= L + 1; k += 1.6) for (let s = -W / 2; s <= W / 2 + 0.01; s += 2.2) for (const y of [1.2, 3.4, 5.6, 7.8, 10, 12.2, 14.4].filter(y => y < Math.min(W, 16) + 1)) {
      if (n > 2400) break;
      n += smash(new B.Vector3(q.cx + q.fdx * k + side.x * s, y, q.cz + q.fdz * k + side.z * s), 1.6, dir, 70, 6);
    }
    for (let k = 2; k <= L; k += 2) hitAround(new B.Vector3(q.cx + q.fdx * k, 1, q.cz + q.fdz * k), W / 2 + 1.5, new B.Vector3(q.fdx, 0, q.fdz), 3, null);
    if (n) { broke(n, new B.Vector3(q.cx + q.fdx * L * 0.6, 1, q.cz + q.fdz * L * 0.6), true); popup(n > 300 ? "ドミノ だおし！！ " + n : "まきぞえ！ " + n, "mile"); shake(1); }
    popup("バターーン!!", "big");
  }

  // ---- 荷台へ吸い込む ----
  const flyers = [];
  function flyToBed(o) { o.from = (o.node.getAbsolutePosition ? o.node.getAbsolutePosition() : o.node.position).clone(); o.t = 0; o.dur = 0.35 + Math.random() * 0.2; o.s0 = o.node.scaling.clone(); flyers.push(o); }
  let suckT = 0, tickT = 0, fullWarned = false;
  function updateCollect(dt) {
    const cap = upV("cap"), r = upV("suck");
    if ((suckT -= dt) <= 0 && bed.load < cap) {
      suckT = 0.05;
      for (const d of debris) {
        if (d.held) continue;
        const p = d.m.position; if (Math.abs(p.x - ex.pos.x) > r || Math.abs(p.z - ex.pos.z) > r || (p.x - ex.pos.x) ** 2 + (p.z - ex.pos.z) ** 2 > r * r || p.y > 6) continue;
        d.held = true; physOff(d); bed.load += d.val; bed.money += d.val; d.counted = true;   // 先に数える（飛んでいる間に同じ物を 2 回数えない）
        flyToBed({ node: d.m, val: 0, done: () => { d.m.dispose(); const i = debris.indexOf(d); if (i >= 0) debris.splice(i, 1); } });
        if (bed.load >= cap) break;
      }
    }
    const to = bedPos();
    for (let i = flyers.length - 1; i >= 0; i--) {
      const o = flyers[i]; o.t += dt / o.dur; const k = Math.min(1, o.t);
      const p = B.Vector3.Lerp(o.from, o.toP || to, k); p.y += Math.sin(Math.PI * k) * 2.5;
      o.node.position.copyFrom(p); o.node.scaling.copyFrom(o.s0).scaleInPlace(1 - k * 0.6);
      if (k >= 1) {
        flyers.splice(i, 1); if (o.val) { bed.load += o.val; bed.money += o.val; }
        o.done(); showBed();
        if (playT - tickT > 0.06) { tickT = playT; playS("click", 0.12, 1.6 + Math.min(1, bed.load / cap) * 0.6); }
      }
    }
    if (bed.load >= cap && !fullWarned) { fullWarned = true; popup("にだい いっぱい！ ひきとりじょへ！", "mile"); playS("levelup", 0.3, 0.8); }
    if (bed.load < cap) fullWarned = false;
  }

  // ---- ひきとりじょ: 中に入ると荷台を傾けて がれきを穴へ。お金になる ----
  let dump = null, inYardPrev = false;
  const inYard = () => Math.abs(ex.pos.x - yard.x) < yard.h && Math.abs(ex.pos.z - yard.z) < yard.h;
  function updateYard(dt) {
    const here = inYard();
    if (here && !inYardPrev) { setShop(true); }
    if (!here && inYardPrev) setShop(false);
    inYardPrev = here;
    ringM.alpha = 0.25 + 0.2 * Math.sin(playT * 4) + (bed.load >= upV("cap") * 0.6 ? 0.25 : 0);
    if (here && !dump && bed.load > 0 && !flyers.length) { dump = { t: 0, money: bed.money, load: bed.load, shown: 0, chunks: 0 }; playS("rubble_dump", 0.7); }
    if (!dump) { bedTilt.rotation.x += (0 - bedTilt.rotation.x) * Math.min(1, dt * 5); return; }
    dump.t += dt; const D = 1.6;
    bedTilt.rotation.x = -Math.min(1, dump.t / 0.35) * 0.9 * (dump.t < D ? 1 : Math.max(0, 1 - (dump.t - D) / 0.4));
    bed.load = dump.load * Math.max(0, 1 - dump.t / D); showBed();
    // 荷台から穴へ がれきが飛ぶ（見た目だけ）
    while (dump.chunks < Math.min(24, dump.t / D * 24)) {
      dump.chunks++; const m = debrisSrc.createInstance("dumpd"); const s = 0.6 + Math.random() * 0.6; m.scaling.set(s, s * 0.7, s); m.instancedBuffers.color = new B.Color4(0.8, 0.77, 0.72, 1);
      m.position.copyFrom(bedPos()); const tg = pile.position.add(new B.Vector3((Math.random() - 0.5) * 6, 1, (Math.random() - 0.5) * 6));
      flyers.push({ node: m, from: m.position.clone(), t: 0, dur: 0.5, s0: m.scaling.clone(), val: 0, toP: tg, done: () => { m.dispose(); dust(tg, 6); } });
    }
    const shown = Math.round(dump.money * Math.min(1, dump.t / D));
    if (shown > dump.shown) { if (Math.floor(shown / Math.max(1, dump.money / 12)) !== Math.floor(dump.shown / Math.max(1, dump.money / 12))) playS("coin", 0.25, 1.2 + Math.random() * 0.3); dump.shown = shown; $("money").textContent = fmtY(sv.money + shown); }
    if (dump.t >= D + 0.4) {
      sv.money += dump.money; sv.delivered += dump.load; bed.load = 0; bed.money = 0; showBed(); pileSize(); save();
      popup("+" + fmtY(dump.money), "huge"); playS("coin", 0.6); playS("firework", 0.35, 1, 0.1); if (dump.money >= 500) playS("levelup", 0.4);
      flash(0.25, true); dump = null; renderShop();
    }
  }

  // ---- 強化の店（ひきとりじょの中で出る） ----
  let shopOpen = false, shopSel = 0;
  function setShop(on) { shopOpen = on; $("shop").style.display = on ? "" : "none"; if (on) renderShop(); }
  function toggleShop() { if (inYard()) setShop(!shopOpen); }
  function moveShopSel(d) { shopSel = (shopSel + d + 4) % 4; renderShop(); }
  function renderShop() {
    if (!shopOpen) return;
    const el = $("shopList"); el.innerHTML = "";
    Object.entries(UPS).forEach(([k, u], i) => {
      const lv = sv.up[k] || 0, max = lv >= u.vals.length - 1, price = upPrice(k), can = !max && sv.money >= price;
      const b = document.createElement("button"); b.className = "upBtn" + (can ? " can" : "") + (i === shopSel ? " sel" : "");
      b.innerHTML = `<span class="ic">${u.icon}</span><span class="nm">${u.name}<small>Lv ${lv + 1}　${u.fmt(u.vals[lv])}${max ? "" : " → " + u.fmt(u.vals[lv + 1])}</small></span><span class="pr">${max ? "さいだい" : fmtY(price)}</span>`;
      b.onclick = () => { wakeAudio(); shopSel = i; buy(k); };
      el.appendChild(b);
    });
    const pct = Math.round(lots.filter(L => L.gone).length / lots.length * 100);
    $("rebuild").style.display = pct >= 60 ? "" : "none";
  }
  function buy(k) {
    const u = UPS[k], lv = sv.up[k] || 0; if (lv >= u.vals.length - 1) return;
    const price = upPrice(k); if (sv.money < price) { playS("click", 0.3, 0.6); return; }
    sv.money -= price; sv.up[k] = lv + 1; save(); showBed();
    playS("levelup", 0.5); playS("coin", 0.4); flash(0.3, true); popup(u.icon + " " + u.name + " Lv" + (lv + 2) + "！", "mile");
    $("money").textContent = fmtY(sv.money); renderShop();
  }
  $("rebuild").onclick = () => { if (confirm("こわした まちを ぜんぶ たてなおしますか？（お金と強化は そのまま）")) { sv.gone = []; save(); location.reload(); } };
  $("shopClose").onclick = () => setShop(false);

  // ---- こわしきった土地: 1 割より減ったら「こわしきった！」＋ほうび ----
  let goneT = 0;
  function checkGone(dt) {
    if ((goneT -= dt) > 0) return; goneT = 0.8;
    for (const L of lots) {
      if (!L.made || L.gone || !L.cells0) continue;
      let n = 0; for (const b of L.blds) n += b.cells.size;
      if (n < L.cells0 * 0.1) {
        L.gone = true; sv.gone.push(L.id); saveDirty = true;
        const bonus = Math.round(L.cells0 * 0.15); sv.money += bonus;
        popup((L.lm ? "🏆 " + LM_NAME[L.kind] : "🏚 たてもの") + " こわしきった！ +" + fmtY(bonus), L.lm ? "mile" : "mid"); playS("levelup", L.lm ? 0.5 : 0.3); chime([0, 4, 7, 12]);
        for (const b of L.blds) for (const c of [...b.cells]) { if (!c.segs) carvedToDebris(c, new B.Vector3(0, 0.5, 0)); else removeCell(c); }   // 残りかすは がれきに
        dirty = true;
      }
    }
  }

  // ---- 画面の表示（お金・荷台・まちの こわれ具合・小さな地図・ひきとりじょへの矢印） ----
  const mapC = $("map"), mctx = mapC.getContext("2d"), MS = mapC.width / (HALF * 2 + 16);
  const M = (x, z) => [(x + HALF + 8) * MS, (HALF + 8 - z) * MS];
  function drawMap() {
    const c = mctx; c.clearRect(0, 0, mapC.width, mapC.height);
    c.fillStyle = "#2d3034cc"; c.fillRect(0, 0, mapC.width, mapC.height);
    for (const L of lots) { const [x, y] = M(L.cx - L.w / 2, L.cz + L.d / 2); c.fillStyle = L.gone ? "#5a5148" : L.lm ? "#c9a55a" : L.kind === "park" ? "#5f7d40" : "#9a9890"; c.fillRect(x, y, L.w * MS, L.d * MS); }
    { const [x, y] = M(yard.x - BLK / 2, yard.z + BLK / 2); c.fillStyle = "#f2c230"; c.fillRect(x, y, BLK * MS, BLK * MS); c.fillStyle = "#222"; c.font = "bold 10px sans-serif"; c.textAlign = "center"; c.fillText("¥", x + BLK * MS / 2, y + BLK * MS / 2 + 4); }
    c.fillStyle = "#ff8a2a"; for (const q of fires) { const [x, y] = M(q.p.x, q.p.z); c.fillRect(x - 1.5, y - 1.5, 3, 3); }
    c.fillStyle = "#7de05a"; for (const z of zombies) { const [x, y] = M(z.pos.x, z.pos.z); c.fillRect(x - 1, y - 1, 2, 2); }
    const [ex0, ey0] = M(ex.pos.x, ex.pos.z); c.save(); c.translate(ex0, ey0); c.rotate(ex.heading); c.fillStyle = "#ffdf3a"; c.strokeStyle = "#000"; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(0, -6); c.lineTo(4.5, 5); c.lineTo(-4.5, 5); c.closePath(); c.fill(); c.stroke(); c.restore();
  }
  // ひきとりじょへの矢印（荷台が 6 割を超えたら、ショベルの前に出る）
  const arrowM = new B.StandardMaterial("arrowM", scene); arrowM.emissiveColor = new B.Color3(1, 0.85, 0.2); arrowM.disableLighting = true; arrowM.alpha = 0.85;
  // 矢印の形: 先が +z を向く平たい矢（三角の円盤を回して作ったら、向きが合っていなかった 10-30 本人「矢印通り行っても永遠に着かない」）
  const arrow = new B.Mesh("arrow", scene);
  { const vd = new B.VertexData(); vd.positions = [0, 0, 1.8, -1.2, 0, 0.2, 1.2, 0, 0.2, -0.5, 0, 0.2, 0.5, 0, 0.2, -0.5, 0, -1.4, 0.5, 0, -1.4];
    vd.indices = [0, 1, 2, 3, 5, 4, 4, 5, 6]; vd.normals = []; B.VertexData.ComputeNormals(vd.positions, vd.indices, vd.normals); vd.applyToMesh(arrow); }
  arrow.material = arrowM; arrowM.backFaceCulling = false; arrow.isPickable = false; arrow.renderingGroupId = 1;
  const arrowP = new B.TransformNode("arrowP", scene); arrow.parent = arrowP;
  let hudT = 0;
  function updateHud(dt) {
    const cap = upV("cap"), k = Math.min(1, bed.load / cap);
    $("bedBar").style.width = (k * 100).toFixed(1) + "%"; $("bedBar").classList.toggle("full", k >= 1);
    const yd = Math.round(Math.hypot(yard.x - ex.pos.x, yard.z - ex.pos.z));
    $("bedT").textContent = `にだい ${Math.round(bed.load)} / ${cap}` + (inYard() ? "" : `　🟨まで ${yd}m`);
    if (!dump) $("money").textContent = fmtY(sv.money);
    const show = k >= 0.6 && !inYard();
    arrowP.setEnabled(show);
    if (show) { const a = Math.atan2(yard.x - ex.pos.x, yard.z - ex.pos.z); arrowP.position.set(ex.pos.x + Math.sin(a) * 6, 0.4, ex.pos.z + Math.cos(a) * 6); arrowP.rotation.y = a; arrowM.alpha = 0.55 + 0.35 * Math.sin(playT * 6); }
    if ((hudT -= dt) > 0) return; hudT = 0.25;
    const pct = Math.round(lots.filter(L => L.gone).length / lots.length * 100);
    $("city").textContent = `まち ${pct}% こわした　🧟 ${kills}`;
    drawMap();
  }

  // ---- 建物の陰で ショベルが隠れる時は、手前（南）の高い塊を透かす ----
  const faded = new Set(); let fadeT = 0; const VIEW_R = 66;   // 一番引いた時に見える広さより少し外まで
  function updateOcclusion(dt) {
    if ((fadeT -= dt) > 0) return; fadeT = 0.15;
    const tb = Math.tan(cam.beta), now = new Set();
    for (const ch of chunks.values()) {
      const m = ch.mesh;
      if (!ch.c0) { const bb0 = m.getBoundingInfo().boundingBox; if (bb0.maximumWorld.x > bb0.minimumWorld.x) ch.c0 = bb0.centerWorld.clone(); }
      if (ch.c0) { const far = Math.abs(ch.c0.x - ex.pos.x) > VIEW_R || Math.abs(ch.c0.z - ex.pos.z) > VIEW_R; if (far !== !!ch.far) { ch.far = far; if (far) { m.setEnabled(false); if (ch.pane) ch.pane.setEnabled(false); } else ch.dirty = true; } }   // 戻ってきたら作り直して出す
      if (ch.far || !m.isEnabled()) continue;
      const bb = m.getBoundingInfo().boundingBox, cx = (bb.minimumWorld.x + bb.maximumWorld.x) / 2, top = bb.maximumWorld.y;
      const dz = ex.pos.z - bb.maximumWorld.z, dx = Math.abs(cx - ex.pos.x) - (bb.maximumWorld.x - bb.minimumWorld.x) / 2;
      if (dz > -1 && dz < 45 && dx < 6 && top > 2.5 + Math.max(0, dz) / tb) now.add(m);
    }
    for (const q of props) { const far = Math.abs(q.pos.x - ex.pos.x) > VIEW_R || Math.abs(q.pos.z - ex.pos.z) > VIEW_R; if (far !== !!q.far && q.state !== "gone") { q.far = far; q.root.setEnabled(!far); } }   // 遠くの車・木・街灯も描かない（数千個あって重かった）
    for (const m of faded) if (!now.has(m)) { m.visibility = 1; }
    for (const m of now) m.visibility = 0.28;
    faded.clear(); for (const m of now) faded.add(m);
  }

  // ---- 始める画面 ----
  let started = false;
  function hideStart() { if (started) return; started = true; $("start").style.display = "none"; $("joyHint").style.display = "none"; }

  poof(new B.Vector3(0, -50, 0)); glassBurst(new B.Vector3(0, -50, 0), 0);   // 粒の仕組みを最初に作っておく

  // ---- 確かめ用 ----
  G.testMode = () => { G.fixedDt = 1 / 60; scene.useConstantAnimationDeltaTime = true; plugin._useDeltaForWorldStep = false; scene.getPhysicsEngine().setTimeStep(1 / 60); engine.stopRenderLoop(); G.step = n => { for (let i = 0; i < n; i++) scene.render(); }; };
  Object.assign(G, { sinkSet, sinks, scene, engine, ex, lots, sv, bed, props, zombies, fires, explode, geyser, smash, debris, yard, upV, buy, setZoom, cam, activateNear, bld, chunks, startFire, inYard, applyPose, mv: null });
  // ================= 毎コマ =================
  ex.pos.set(yard.x, 0, yard.z - BLK / 2 - ROAD / 2); ex.heading = Math.PI;   // ひきとりじょの南の道から、南（低い家と公園）を向いて始める
  if (Q.has("x")) { ex.pos.x = Number(Q.get("x")); ex.pos.z = Number(Q.get("z") || 0); }
  activateNear(ex.pos, true);
  rebuildCellMesh();
  applyPose();
  let saveT = 0, partT = 0;
  scene.onBeforeRenderObservable.add(() => {
    let dt = G.fixedDt || Math.min(engine.getDeltaTime() / 1000, 0.05);
    if (!(dt > 0.0001)) return;
    if (hitStop > 0) { hitStop -= dt; dt *= 0.08; plugin._useDeltaForWorldStep = false; scene.getPhysicsEngine().setTimeStep(dt); if (hitStop <= 0) plugin._useDeltaForWorldStep = true; }
    playT += dt;
    readInput();
    const mvK = moveEx(dt);
    const swinging = updateArm(dt);
    applyPose(); ramShake();
    for (const b of pendingBooms) b.t -= dt;
    for (let i = pendingBooms.length - 1; i >= 0; i--) if (pendingBooms[i].t <= 0) { const b = pendingBooms.splice(i, 1)[0]; explode(b.p, b.pw); }
    lightK = Math.max(0, lightK - dt * 3); boomLight.intensity = lightK * 60;
    updateChain(dt);
    // 削った後、少し置いてから「支えのない塊」を落とす（juuki と同じ）
    if (dirty) { collapseTimer += dt; if (collapseTimer > 0.2) {
      dirty = false; collapseTimer = 0;
      for (const b of [...dirtyB]) if (b.sink && b.cells.size) {
        // 1 階の壁が減った割合か、削られた数（1 階の壁の 8 割ぶん）で崩れる。大きいビルを外から叩き続けても崩れるように
        const r = b.baseN / Math.max(1, b.base0), lost = b.n0 ? (b.n0 - b.cells.size) / Math.max(60, b.base0 * 0.8) : 0;
        if (r < (b.sinkR || 0.45) || lost >= 1) sinkSet([...b.cells]);
        else if ((r < 0.75 || lost > 0.55) && !b.warned) { b.warned = true; popup("ぐらぐら…！ あと すこし！", "mid"); shake(0.4); }
      }
      const fl = floatingCells();
      if (fl.length > 900) sinkSet(fl);
      else if (fl.length) { const c0 = fl[0].p.clone(), m = fl.length; collapse(fl); broke(m, c0, true); }
    } }
    rebuildCellMesh();
    if (sinks.length) updateSinks(dt);
    if (fading.length) updateFading(dt);
    updateFires(dt); updateGeysers(dt);
    updateProps(dt); updateZombies(dt);
    updateCollect(dt); updateYard(dt);
    checkGone(dt); updateCombo(dt); updateHud(dt); updateOcclusion(dt);
    if ((partT -= dt) <= 0) { partT = 0.1; activateNear(ex.pos); }   // 近づいた土地を 1 つずつ建てる
    // 鳴りっぱなしの音
    setLoop("exc_engine_loop", 0.22 + mvK * 0.15, 0.9 + mvK * 0.25, dt);
    setLoop("exc_tracks_loop", mvK * 0.35, 0.8 + mvK * 0.4, dt);
    setLoop("exc_hydraulic_loop", swinging ? 0.2 : 0, 1.1, dt);
    if (eng) eng.g.gain.value = loops.exc_engine_loop ? 0 : 0.04 + mvK * 0.03;
    // カメラ: ショベルの少し前（進む向き）を見る。揺れは注目点をずらす
    trauma = Math.max(0, trauma - dt * 1.6); const tr = trauma * trauma;
    const ahead = fwd().scale(speed * 0.5);
    camT.set(ex.pos.x + ahead.x, 1.5, ex.pos.z + ahead.z + 3);
    cam.target.x += (camT.x - cam.target.x) * Math.min(1, dt * 5); cam.target.z += (camT.z - cam.target.z) * Math.min(1, dt * 5); cam.target.y = camT.y;
    cam.target.x += (Math.random() - 0.5) * tr * 0.7; cam.target.z += (Math.random() - 0.5) * tr * 0.7;
    cam.radius += (ZOOMS[zoomI] - cam.radius) * Math.min(1, dt * 4);
    // 縦持ち（スマホ・10-31 本人「縦で作って」）: 横幅を基準に見る。真上寄りにして奥（描かない遠く）を映さない
    const port = engine.getRenderHeight() > engine.getRenderWidth();
    cam.fovMode = port ? B.Camera.FOVMODE_HORIZONTAL_FIXED : B.Camera.FOVMODE_VERTICAL_FIXED; cam.fov = port ? 0.66 : 0.75;
    cam.beta = (port ? 0.42 : 0.62) - (zoomI - 1) * 0.04;
    // 影はショベルの周りだけ（街全体では細かさが足りない）
    sun.position.set(ex.pos.x - sun.direction.x * 120, -sun.direction.y * 120, ex.pos.z - sun.direction.z * 120);
    if ((saveT += dt) > 3) { saveT = 0; if (saveDirty) { saveDirty = false; save(); } }
  });

  // ---- 仕上げの画面処理（juuki と同じ） ----
  const pipe = new B.DefaultRenderingPipeline("pipe", !Q.has("nohdr") && !LITE, scene, Q.has("nopp") ? [] : [cam]);
  pipe.imageProcessingEnabled = true;
  pipe.imageProcessing.toneMappingEnabled = true; pipe.imageProcessing.toneMappingType = B.ImageProcessingConfiguration.TONEMAPPING_ACES;
  pipe.imageProcessing.exposure = 1.0; pipe.imageProcessing.contrast = 1.14;
  pipe.imageProcessing.colorCurvesEnabled = true; pipe.imageProcessing.colorCurves = new B.ColorCurves(); pipe.imageProcessing.colorCurves.globalSaturation = -6;
  scene.environmentIntensity = 0.85;
  pipe.imageProcessing.vignetteEnabled = true; pipe.imageProcessing.vignetteWeight = 1.0;
  pipe.fxaaEnabled = true; pipe.samples = 1;
  pipe.bloomEnabled = HQ; pipe.bloomThreshold = 0.85; pipe.bloomWeight = 0.18; pipe.bloomKernel = 48;
  engine.setHardwareScalingLevel(1 / (HQ ? DPR : (TOUCH ? 1 : Math.min(DPR, 1.5))));

  scene.skipPointerMovePicking = true;   // 指で触っても物を選ばない（毎回の当たり探しを省く）
  $("msg").style.display = "none";
  setZoom(1);
  engine.resize();
  engine.runRenderLoop(() => scene.render());
  addEventListener("resize", () => engine.resize());
  G.ready = true;
})();
