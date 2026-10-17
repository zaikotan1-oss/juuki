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
const CARVE_R = 0.9;       // バケットの当たり点ごとの削る半径（10-11 本人「ちょっとぶつかっただけで崩れるくらい甘く」）
const BUCKET = { W: 1.9, H: 1.05, L: 1.55 };   // 本人「バケットを大きく」で 1.1×0.7×1.25 から拡大
const HOLD_MAX = 40;       // バケットに一度に掴める数
const TRUCK_CAP = 24;      // ダンプ 1 台に積める量（units() で数える）。すくう 1 回で出発。往復 9 秒 < 1 回分 20 秒なので待ちは出ない（10-12 評価 r1: 最初の出発 50 秒は遅い）
const G = window.G = {};   // 確かめ用の口

(async function main() {
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
  scene.fogMode = B.Scene.FOGMODE_LINEAR; scene.fogStart = 70; scene.fogEnd = 380;
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
  const dome = new B.PhotoDome("bg", AS + "hdri/construction_yard_bg3.jpg", { resolution: 64, size: 1600 }, scene);
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
  sun.orthoLeft = -40; sun.orthoRight = 40; sun.orthoTop = 40; sun.orthoBottom = -40; sun.shadowMinZ = 1; sun.shadowMaxZ = 220;
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
  const BW = 8, BD = 6, FH = 3;      // 建物の大きさ(m)
  // ステージ: 階の数が増える。クリアすると強化が開く（10-12 評価 r0「ステージ・強化が無い」）
  const STAGES = [
    // trucks: ダンプが この台数 出発したら さら地 かんせい（10-12 本人「全部は入らないから回数を決める」→ 少なめ 4/6/8/10・建物が残っていても台数だけで終わり）
    // 瓦礫の全部は 1 面で ダンプ約 19 台分（4 面は約 47 台分）。★ の時間は 1 台 45 秒ほどの見込みで決めた推測（人の実測はまだ）
    // bld: クレーンで建てる物（10-13 本人「ステージごとに違う建物」）
    { floors: 2, name: "小さな ビル", trucks: 4, star3: 200, star2: 330, bld: "biru" },
    { floors: 3, name: "3かいだての ビル", trucks: 6, star3: 290, star2: 480, bld: "mansion" },
    { floors: 4, name: "4かいだての ビル", trucks: 8, star3: 380, star2: 620, bld: "tower" },
    { floors: 2, name: "まちの いえ（5けん）", trucks: 10, star3: 470, star2: 770, town: true, open: true, bld: "house" },
    // 10-16 本人「何十階建てのビルも」「街丸ごと好きなように」。大きい建物は 1 階を削ると沈むように崩れる
    { floors: 30, name: "30かいだての ビル", trucks: 12, star3: 720, star2: 1100, sky: true, look: 1 },
    { floors: 2, name: "まち まるごと", trucks: 999, star3: 1200, star2: 2000, wide: true, free: true, look: 0 }];
  const BLD = { biru: "じゅうきビル", mansion: "じゅうきマンション", tower: "じゅうきタワー", house: "あたらしい おうち" };
  // クレーンで建てるステージ（10-16 本人「ショベルとクレーンを完全に分ける」）。look は空気（LOOKS の番号）
  const BSTAGES = [
    { name: "じゅうきビル", bld: "biru", floors: 2, look: 0 },
    { name: "じゅうきマンション", bld: "mansion", floors: 3, look: 1 },
    { name: "じゅうきタワー", bld: "tower", floors: 4, look: 2 },
    { name: "あたらしい おうち", bld: "house", floors: 2, look: 3 },
    { name: "たかい タワー（10かい）", bld: "tower", floors: 10, look: 2, wind: 1.5, unit: true },   // 上へ行くほど風が強い。柱と梁は工場で組んだ「わく」1 つで吊る（1 階 10 個だと 10 階で 40 分かかる）
    { name: "おうち 3けん", bld: "house", floors: 2, look: 0, sites: [[0, 17], [-10.5, 21], [10.5, 21]] }];   // 3 か所に順に建てる
  let bstage = Math.min(BSTAGES.length - 1, Math.max(0, (Number(Q.get("build")) || 1) - 1));
  const bldType = () => BSTAGES[bstage].bld || "biru";   // 10-12 本人「周りにいろんな家があってもいい・別のステージで」。★の時間は推測（まだ通しで測っていない）
  const UPGRADES = ["うでと はしりが はやくなる（油圧パワーアップ）", "バケットが 大きくなる（たくさん すくえる）", "ダンプが 速くなる（すぐ もどってくる）"];
  const prog = (() => { try { return JSON.parse(localStorage.getItem("juuki_prog")) || { stars: [] }; } catch (e) { return { stars: [] }; } })();
  const saveProg = () => { try { localStorage.setItem("juuki_prog", JSON.stringify(prog)); } catch (e) {} };
  let stage = Math.min(STAGES.length - 1, Math.max(0, Number(Q.get("stage") || 0) - 1));
  let FLOORS = STAGES[stage].floors;
  const POW = () => (prog.stars[0] ? 1.5 : 1);          // 1 面クリア: 腕が 1.5 倍速・走るのも 1.3 倍（1.3 倍だけでは 1 回分が 1.14 倍しか速くならなかった 10-12）
  const BIGB = () => !!prog.stars[1];                    // 2 面クリア: バケットが大きい
  const FASTT = () => (prog.stars[2] ? 1.6 : 1);         // 3 面クリア: ダンプが速い
  const bld = { cells: new Map(), origin: new B.Vector3(-BW / 2, 0, 14) };
  const SITE = {};   // さら地にする範囲（buildBuilding で決める。まちのステージは広い）
  const AREA = { x0: -23.4, x1: 23.4, z0: -13.4, z1: 41.4 }, hoards = [];   // 歩ける範囲・仮囲い（まち まるごとでは囲いを外して広くする）
  let SUN_D = 110; const sunC = new B.Vector3(0, 0, 15);                    // 太陽（影の中心）までの距離と影の中心
  // 格子の番号は数（文字列だと 2 万個の建物で探すのが遅い 10-16）。x・z は ±1024、y は 0〜2047
  const key = (x, y, z) => (x + 1024) + (z + 1024) * 2048 + y * 4194304;
  const sk = (x, y, z) => x + "," + y + "," + z;      // 窓の印は文字列のまま
  // 見た目: 見えている面だけをメッシュに組む（模様は世界の座標で貼るので、格子の境目で切れない）
  // 16 格子（8m）角の「塊」ごとに 1 つのメッシュ＋1 つの当たり（形はメッシュそのもの）。壊した塊だけ組み直す
  // （前は格子 1 つずつに物理の体を持たせていた。30 階・まち全部の 2 万格子では重すぎる 10-16）
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
      const mesh = new B.Mesh("bld", scene); mesh.material = cellMM; mesh.receiveShadows = true; shadow.addShadowCaster(mesh); mesh.setEnabled(false);
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
  const paneM = new B.PBRMaterial("paneM", scene); paneM.albedoColor = new B.Color3(0.015, 0.02, 0.025); paneM.metallic = 0; paneM.roughness = 0.03; paneM.alpha = 0.88; paneM.backFaceCulling = false;   // 空が映り込む古いガラス
  paneMesh.material = paneM;
  const winSet = new Set();      // 窓の穴（格子の座標）。上下の壁が残っている間だけガラスを出す
  // 建物ごとの記録: 1 階の壁がどれだけ残っているか（sink の建物は少なくなると丸ごと沈むように崩れる）
  const blds = [], dirtyB = new Set(); let curB = null;
  function newB(H, sink) { curB = { cells: new Set(), baseY: H - 1, base0: 0, baseN: 0, sink, warned: false }; blds.push(curB); return curB; }

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
    newB(H, !!K.sink);
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
  const gx = wx => Math.round((wx - bld.origin.x) / CELL), gz = wz => Math.round((wz - bld.origin.z) / CELL);
  const houseW = (wx, wz, wm, dm, floors, o = {}, Hm = FH) => addHouse(gx(wx), gz(wz), wm / CELL, dm / CELL, floors, Math.round(Hm / CELL), o);
  const WOOD = { wall: "wood", pillar: "beam", slab: "wfloor", roof: "gable", door: [2, 4, 4] };
  const TIN = { wall: "tin", pillar: "steelc", slab: "tinroof", roof: "flat", winRows: [5], door: [4, 9, 5] };
  const PRE = { wall: "prefab", pillar: "prefab", slab: "tinroof", roof: "flat", winRows: [2, 3], door: [1, 2, 4] };
  const BIG = { sink: true };
  function buildTown() {
    // まち まるごと（10-16 本人「街丸ごと好きなようにぶっ壊せる」）: 15 棟＋塀。3 階より高い建物は 1 階を削ると沈むように崩れる
    houseW(-4, 14, 8, 6, 4, BIG);                 // まんなかの ビル
    houseW(8, 14, 6, 5, 2, WOOD, 2.5);            // 木の家
    addFence(gx(8), gz(11), 18, 3, "block");
    houseW(-15, 14, 7, 5, 1, TIN, 3.5);           // トタンの倉庫
    houseW(-30, 10, 10, 8, 6, BIG);               // マンション
    houseW(20, 24, 4, 3, 1, PRE);                 // プレハブ
    houseW(-10, 30, 12, 8, 7, BIG);               // 会社のビル
    houseW(6, 31, 6, 5, 2, WOOD, 2.5);
    houseW(16, 38, 6, 5, 2, WOOD, 2.5);
    houseW(-32, 32, 7, 5, 1, TIN, 3.5);
    houseW(26, -2, 6, 5, 2, WOOD, 2.5);
    houseW(24, -16, 8, 6, 3, BIG);                // 店
    houseW(-30, -14, 4, 3, 1, PRE);
    houseW(-24, 48, 8, 8, 10, BIG);               // 10 階の塔
    houseW(10, 50, 8, 8, 5, BIG);
    addFence(gx(-14), gz(26), 20, 3, "block"); addFence(gx(28), gz(12), 16, 3, "block");
  }
  function buildBuilding() {
    for (const ch of chunks.values()) { if (ch.body) { ch.body.dispose(); ch.shape.dispose(); } ch.mesh.dispose(); }
    chunks.clear(); chunkGen++; bld.cells.clear(); winSet.clear(); blds.length = 0; dirtyB.clear(); curB = null;
    for (const q of sinks) q.m.dispose(); sinks.length = 0; for (const q of fading) q.m.dispose(); fading.length = 0;
    const S = STAGES[stage];
    if (S.sky) addHouse(-4, 0, 24, 16, FLOORS, FH / CELL, BIG);       // 30 階: 12m × 8m・高さ 90m
    else if (S.wide) buildTown();
    else addHouse(0, 0, BW / CELL, BD / CELL, FLOORS, FH / CELL);     // 真ん中のビル 16 × 12、1 階 6 段
    if (S.town) {
      // まち: 右に木造の家（2 階・切妻屋根）とブロック塀、左にトタンの倉庫、右奥にプレハブ小屋（格子 0.5m。ビルの左手前の角 = 世界の x -4, z 14）
      addHouse(24, -2, 12, 10, 2, 5, WOOD);
      addFence(20, -8, 18, 3, "block");
      addHouse(-26, -2, 14, 10, 1, 7, TIN);
      addHouse(24, 16, 8, 6, 1, 6, { wall: "prefab", pillar: "prefab", slab: "tinroof", roof: "flat", winRows: [2, 3], door: [1, 2, 4] });
    }
    for (const b of blds) b.baseN = b.base0;
    // さら地にする範囲: 格子の外側 3m
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const c of bld.cells.values()) { x0 = Math.min(x0, c.p.x); x1 = Math.max(x1, c.p.x); z0 = Math.min(z0, c.p.z); z1 = Math.max(z1, c.p.z); }
    Object.assign(SITE, { x0: x0 - 3, x1: x1 + 3, z0: z0 - 3, z1: z1 + 3 });
    Object.assign(AREA, S.wide ? { x0: -66, x1: 66, z0: -58, z1: 74 } : { x0: -23.4, x1: 23.4, z0: -13.4, z1: 41.4 });
    for (const h of hoards) h.setEnabled(!S.wide);
    // 影: 30 階は太陽を遠くへ（近いと上の階の影が切れる）。まちは影の範囲がショベルについていく
    SUN_D = S.sky ? 240 : 110; sun.shadowMaxZ = SUN_D + 130; sunC.set(0, 0, 15); sun.position = sunC.subtract(sun.direction.scale(SUN_D));
    bld.total = bld.cells.size;
    bld.orig = new Set(bld.cells.keys());
    rebuildCellMesh();
  }
  const KIND_COL = { wall: [1, 0.98, 0.94], slab: [0.78, 0.78, 0.78], pillar: [0.9, 0.88, 0.85],   // 写真素材に掛ける色（壁・床・柱で少し変える）
    wood: [0.78, 0.55, 0.34], beam: [0.5, 0.33, 0.2], wfloor: [0.62, 0.48, 0.36], roof: [0.3, 0.33, 0.42],      // 木造の家（茶色の板壁・こげ茶の柱・紺の瓦）
    block: [0.86, 0.84, 0.76], tin: [0.62, 0.72, 0.8], steelc: [0.5, 0.55, 0.6], tinroof: [0.66, 0.36, 0.3],     // ブロック塀・トタンの倉庫（水色の壁・赤さびの屋根）
    prefab: [0.95, 0.92, 0.75] };                                                                              // プレハブ小屋（クリーム色）
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
      const k = KIND_COL[c.kind], vary = 0.94 + ((c.x * 7 + c.y * 13 + c.z * 5) % 7) * 0.012;
      for (const f of FACE) {
        const nk = key(c.x + f.n[0], c.y + f.n[1], c.z + f.n[2]);
        if (bld.cells.has(nk)) continue;     // 隣が埋まっている面は見えない
        if (bld.orig && bld.orig.has(nk)) {   // 壊れた断面
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
    ch.frames = frames; ch.pp = pp; ch.pn = pn;
    const m = ch.mesh;
    // 空の形を渡すと WebGPU の影の描画が止まる（古い数のまま描こうとする）ので、空なら隠すだけ
    if (!idx.length && !bi.length) { m.setEnabled(false); if (ch.body) { ch.body.dispose(); ch.shape.dispose(); ch.body = ch.shape = null; } return; }
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
    // 当たり: 見えている面そのもの（物理の体は塊に 1 つ。形だけ取り替える）
    const shape = new B.PhysicsShapeMesh(m, scene); shape.material = cellShapeM;
    if (!ch.body) ch.body = new B.PhysicsBody(m, B.PhysicsMotionType.STATIC, false, scene);
    const old = ch.shape; ch.body.shape = shape; ch.shape = shape; if (old) old.dispose();
  }
  // 壊れた塊だけ組み直す。鉄筋・窓枠・ガラスは全部の塊のをまとめて 1 回で描く
  function rebuildCellMesh() {
    let any = false;
    for (const ch of chunks.values()) if (ch.dirty) { ch.dirty = false; buildChunk(ch); any = true; }
    if (!any) return;
    const bars = [], frames = [], pp = [], pn = [], pi = [];
    for (const ch of chunks.values()) {
      for (const m of ch.bars) if (bars.length < 1600) bars.push(m);
      for (const m of ch.frames) frames.push(m);
      const b0 = pp.length / 3;
      for (const v of ch.pp) pp.push(v); for (const v of ch.pn) pn.push(v);
      for (let i = 0; i < ch.pp.length / 12; i++) { const b = b0 + i * 4; pi.push(b, b + 1, b + 2, b, b + 2, b + 3); }
    }
    setThin(rebar, bars); setThin(frame, frames);
    if (pp.length) { const pv = new B.VertexData(); pv.positions = pp; pv.normals = pn; pv.indices = pi; pv.applyToMesh(paneMesh, false); paneMesh.setEnabled(true); }
    else paneMesh.setEnabled(false);
  }
  const NBD = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0, 2, 0], [0, -2, 0]];
  function removeCell(c) {
    bld.cells.delete(key(c.x, c.y, c.z));
    const ch = chunkOf(c.x, c.y, c.z, false); if (ch) { ch.cells.delete(c); ch.dirty = true; }
    for (const d of NBD) { const n = chunkOf(c.x + d[0], c.y + d[1], c.z + d[2], false); if (n) n.dirty = true; }   // 隣の塊の面・窓も変わる
    if (c.b) { c.b.cells.delete(c); if (c.y < c.b.baseY) c.b.baseN--; dirtyB.add(c.b); }
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
      for (const f of FACE) { const n = bld.cells.get(key(c.x + f.n[0], c.y + f.n[1], c.z + f.n[2])); if (n && set.has(n)) continue; pushFace(c, f, k, vary, TEXM, f.n[1] < 0 ? 0.7 : 1, pos, nor, uv, col, idx); }
    }
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
    const m = new B.Mesh("sink", scene), vd = new B.VertexData(); vd.positions = pos; vd.normals = nor; vd.uvs = uv; vd.colors = col; vd.indices = idx; vd.applyToMesh(m, false);
    m.material = bldM; m.receiveShadows = true; m.isPickable = false; shadow.addShadowCaster(m);
    if (pi.length) { const g = new B.Mesh("sinkPane", scene), pv = new B.VertexData(); pv.positions = pp; pv.normals = pn; pv.indices = pi; pv.applyToMesh(g, false); g.material = paneM; g.parent = m; g.isPickable = false; }
    const h = CELL / 2; m.setPivotPoint(new B.Vector3((x0 + x1) / 2, y0 - h, (z0 + z1) / 2));
    const kind = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0][0];
    sinks.push({ m, v: 0, d: 0, y0: y0 - h, H: y1 - y0 + CELL, x0: x0 - h, x1: x1 + h, z0: z0 - h, z1: z1 + h, total: Math.min(150, Math.max(6, Math.round(list.length / 90))), made: 0,
      tx: (Math.random() - 0.5) * 0.14, tz: (Math.random() - 0.5) * 0.14, snd: 0, dT: 0, kind });
    crash(1); shake(1); popup(list.length > 4000 ? "ドドドドド…!! たおれる！" : "ガラガラガラ…！", "big");
  }
  function updateSinks(dt) {
    for (let i = sinks.length - 1; i >= 0; i--) {
      const q = sinks[i], air = q.y0 - q.d > 0.5;           // 浮いた塊はまず落ちる
      q.v = Math.min(q.v + dt * (air ? 9.8 : 4), air ? 20 : 9); q.d += q.v * dt;
      q.m.position.y = -q.d;
      const k = Math.min(1, q.d / q.H); q.m.rotation.x = q.tx * k; q.m.rotation.z = q.tz * k;
      const under = q.d - q.y0;                              // 地面より下へ入った深さ
      if (under > 0) {
        const want = Math.min(q.total, Math.ceil(under / q.H * q.total));
        const col = KIND_COL[q.kind];
        while (q.made < want) {
          q.made++;
          const p = new B.Vector3(q.x0 - 1 + Math.random() * (q.x1 - q.x0 + 2), 1 + Math.random() * 2.5, q.z0 - 1 + Math.random() * (q.z1 - q.z0 + 2));
          const out = new B.Vector3(p.x - (q.x0 + q.x1) / 2, 0, p.z - (q.z0 + q.z1) / 2).normalize().scale(1.5 + Math.random() * 2.5);
          spawnDebris(p, new B.Vector3(0.9 + Math.random() * 0.7, 0.55 + Math.random() * 0.5, 0.9 + Math.random() * 0.7), col, out.addInPlaceFromFloats(0, 1.5, 0));
        }
        if ((q.dT -= dt) <= 0) { q.dT = 0.14; dust(new B.Vector3(q.x0 + Math.random() * (q.x1 - q.x0), 0.5, q.z0 + Math.random() * (q.z1 - q.z0)), 22); cloudAt(q, q.H > 20 ? 5 : 2); }
        if ((q.snd -= dt) <= 0) { q.snd = 0.5; crash(0.8); shake(0.3); }
      }
      if (under > q.H + 0.5) { q.m.dispose(); sinks.splice(i, 1); for (let j = 0; j < 4; j++) dust(new B.Vector3(q.x0 + Math.random() * (q.x1 - q.x0), 0.6, q.z0 + Math.random() * (q.z1 - q.z0)), 30); }
    }
  }
  // 沈む時の大きな土けむり（粒は大きく・長く残る。1 つだけ作って使い回す）
  let cloud = null;
  function cloudAt(q, n) {
    if (!cloud) {
      cloud = new B.ParticleSystem("cloud", LITE ? 120 : 240, scene); cloud.particleTexture = dustTex;
      cloud.color1 = new B.Color4(0.62, 0.57, 0.5, 0.32); cloud.color2 = new B.Color4(0.52, 0.48, 0.42, 0.26); cloud.colorDead = new B.Color4(0.6, 0.56, 0.5, 0);
      cloud.addSizeGradient(0, 2.5, 4); cloud.addSizeGradient(1, 8, 13); cloud.minLifeTime = 2.5; cloud.maxLifeTime = 4.5; cloud.emitRate = 0; cloud.manualEmitCount = 0;
      cloud.blendMode = B.ParticleSystem.BLENDMODE_STANDARD; cloud.gravity = new B.Vector3(0, 0.3, 0);
      cloud.direction1 = new B.Vector3(-2, 0.3, -2); cloud.direction2 = new B.Vector3(2, 1.5, 2); cloud.minEmitPower = 1; cloud.maxEmitPower = 3;
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
      fadeOut(debris.splice(i, 1)[0]);
    }
    return d;
  }
  function clearDebris() { for (const d of debris) { physOff(d); d.m.dispose(); } debris.length = 0; }
  function carvedToDebris(c, kick) {
    const k = KIND_COL[c.kind];
    // 半分は粉々（粉塵だけ・瓦礫を残さない）。全部を瓦礫にすると 1 棟のすくう回数が多すぎた（10-12 評価 r0 テンポ）
    if (Math.random() < 0.5) { removeCell(c); return; }
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
      const ctr = mn.add(mx).scaleInPlace(0.5); spawnDebris(ctr, size, k, null); if (groups.size <= 8 || Math.random() < 0.4) dust(ctr, 25);
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

  // ================= ダンプ =================
  // 前（運転台）は -Z を向いて止まる。荷台は建物側。いっぱいになったら -Z へ走り去り、空のダンプがバックで戻る
  const TRUCK_HOME = new B.Vector3(-6.8, 0, 4.5);   // ビルを掘る位置（z≈6）から左へ 90° 旋回した所に荷台が来る
  const truck = { root: new B.TransformNode("truck", scene), parts: [], state: "wait", z: TRUCK_HOME.z, v: 0, load: [], amount: 0, trips: 0, sent: 0 };   // sent: 出発した台数（完成の数え方）・trips: 走り去って戻った台数
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
    const [cx, cy] = stickCenter(s), R = s.el.offsetWidth * 0.43;   // 輪の大きさに合わせる（10-17 UI を小さくした）
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
  $("bView").onclick = () => { if (!ride) return; view = view === "fp" ? "tp" : "fp"; scene.activeCamera = view === "fp" ? fp : tp; $("bView").textContent = view === "fp" ? "運転席" : "外から"; };
  function setShadow(on) {
    shadowOn = on; sun.shadowEnabled = on;
    $("bShadow").textContent = on ? "影 ON" : "影 OFF"; $("bShadow").classList.toggle("on", !on);
  }
  $("bShadow").onclick = () => setShadow(!shadowOn);
  $("bReset").onclick = () => { if (mode === "build") location.reload(); else reset(); };
  shadow.addShadowCaster(debrisSrc);
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
    if (ac && !sfxLoading) loadSfx();
  }
  document.addEventListener("visibilitychange", () => { if (ac && !document.hidden) ac.resume(); });
  // ---- 手ごたえ（10-12 評価 r0「崩れた時に音 1 種だけ・揺れ・粉塵・数字が無い」）----
  let master = null, nbuf = null;
  const OUT = () => { if (!master) { master = ac.createDynamicsCompressor(); master.connect(ac.destination); } return master; };
  const NB = () => { if (!nbuf) { nbuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate); const d = nbuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; } return nbuf; };
  let crashT = 0;
  // 崩れる音: 低いドーン＋ザザッ（帯域ノイズ）＋ガラガラ（小石の当たる音を時間差で）。pw 0〜1
  function crash(pw) {
    if (!ac || ac.state !== "running") return;
    const t = ac.currentTime; if (t - crashT < 0.07) return; crashT = t;
    if (hasS("crash_small") && hasS("crash_big")) { if (pw < 0.3) playS("crash_small", 0.45 + pw * 1.5); else playS("crash_big", Math.min(1, 0.55 + pw * 0.5)); return; }
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
    "crash_small_1", "crash_small_2", "crash_small_3", "crash_big_1", "crash_big_2", "crash_big_3", "rubble_dump_1", "rubble_dump_2",
    "truck_depart", "truck_horn", "steel_clang_1", "steel_clang_2", "bolt_impact", "wind_gust", "sling_hook"];
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
    ch.color1 = new B.Color4(0.32, 0.3, 0.27, 1); ch.color2 = new B.Color4(0.5, 0.47, 0.42, 1); ch.colorDead = new B.Color4(0.3, 0.28, 0.25, 0.6);
    ch.minSize = 0.06; ch.maxSize = 0.16; ch.minLifeTime = 0.5; ch.maxLifeTime = 1.0; ch.emitRate = 0; ch.manualEmitCount = 0;
    ch.blendMode = B.ParticleSystem.BLENDMODE_STANDARD; ch.gravity = new B.Vector3(0, -9.8, 0);
    ch.direction1 = new B.Vector3(-1.5, 1, -1.5); ch.direction2 = new B.Vector3(1.5, 3, 1.5); ch.minEmitPower = 1; ch.maxEmitPower = 3;
    ps.renderingGroupId = ch.renderingGroupId = 1; ps.start(); ch.start(); dustPool.push([ps, ch]);
  }
  function dust(p, n) {
    const [ps, ch] = dustPool[dustI++ % dustPool.length];
    const e = p.clone(); ps.emitter = e; ch.emitter = e;
    ps.manualEmitCount = Math.min(LITE ? 50 : 100, Math.round(n)); ch.manualEmitCount = Math.min(LITE ? 20 : 40, Math.round(n * 0.5));
  }
  // 浮かぶ数字（崩れた量を 0.5 秒ためて 1 回出す）と得点
  let score = 0, combo = 0, comboT = 0, comboP = null, lastPctStep = 0, lastDustT = -1;
  function popup(text, cls) {
    const el = document.createElement("div"); el.className = "pop " + (cls || ""); el.textContent = text;
    $("pops").appendChild(el); setTimeout(() => el.remove(), 1300);
  }
  function broke(n, p, big) {      // 格子が n 個こわれた（p はその辺り）
    combo += n; comboT = 0.5; comboP = p; score += n;
    if (big || playT - lastDustT > 0.15) { lastDustT = playT; dust(p, (big ? 30 : 6) + n * (big ? 8 : 3)); }   // 押し当てている間に毎コマ出すと画面が粉塵で埋まった
    crash(Math.min(1, (big ? 0.35 : 0.05) + n * (big ? 0.06 : 0.03)));
    shake(Math.min(0.6, (big ? 0.25 : 0.04) + n * (big ? 0.03 : 0.012)));
  }
  function updateCombo(dt) {
    if (comboT <= 0) return;
    comboT -= dt; if (comboT > 0) return;
    if (combo >= 6) popup((combo >= 60 ? "ドドーン!! " : combo >= 25 ? "ガラガラ！ " : "ゴロッ ") + "+" + combo, combo >= 60 ? "big" : combo >= 25 ? "mid" : "");
    combo = 0;
    const pct = Math.floor((1 - bld.cells.size / bld.total) * 4);   // 25% ごとの合図
    if (pct > lastPctStep && pct < 4) { lastPctStep = pct; chime([0, 4, 7]); popup(pct * 25 + "% こわした！", "mile"); }
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
    if (n) { dirty = true; broke(n, p, false); if (ac && ac.currentTime - hitT > 0.3) { hitT = ac.currentTime; playS("bucket_hit", 0.7); } }   // ガツッ（続けて当てても 0.3 秒に 1 回）
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

  // ================= 掴む・あける =================
  const _inv = new B.Matrix(), _lp = new B.Vector3(), _v = new B.Vector3();
  let held = 0;
  function bucketOpenUp() {          // バケットの口（-Y）が世界でどれだけ上を向いているか（1=真上）
    const m = bucketJ.computeWorldMatrix(true);
    return -B.Vector3.TransformNormal(B.Axis.Y, m).normalize().y;
  }
  let lastBucket = 0;
  // バケットの中の置き場（バケットの座標。背板 y=0 側から口へ向かって積む。最後の 4 つは口からはみ出す山盛り）
  const SLOTS = [];
  for (let k = 0; k < 3; k++) for (const z of [0.3, 0.75, 1.2]) for (const x of [-0.63, -0.21, 0.21, 0.63]) SLOTS.push(new B.Vector3(x, -0.25 - k * 0.38, z));
  for (const [x, z] of [[-0.21, 0.55], [0.21, 0.55], [-0.21, 1.0], [0.21, 1.0]]) SLOTS.push(new B.Vector3(x, -1.32, z));
  const slotUsed = new Array(SLOTS.length).fill(null), BASE_SLOTS = SLOTS.length;
  // 暴れ止め: 大きな崩れで塊が重なって生まれると、物理が押し出して 50m/s で飛んだ・地面を抜けて落ち続けた（10-12 通しプレイで 168 回）
  // 速すぎる物は 12m/s に抑え、地面の下へ抜けた物は消す
  let calmI = 0; const _cv = new B.Vector3();
  function calmDebris() {
    if (++calmI % 2) return;
    for (let i = debris.length - 1; i >= 0; i--) {
      const d = debris[i]; if (!d.ag) continue;
      if (d.m.position.y < -2) { physOff(d); d.m.dispose(); debris.splice(i, 1); continue; }
      d.ag.body.getLinearVelocityToRef(_cv); const v2 = _cv.lengthSquared();
      if (v2 > 144) { _cv.scaleInPlace(12 / Math.sqrt(v2)); d.ag.body.setLinearVelocity(_cv); }
      d.ag.body.getAngularVelocityToRef(_cv); if (_cv.lengthSquared() > 100) d.ag.body.setAngularVelocity(_cv.normalize().scaleInPlace(10));
    }
  }
  const flying = [];
  function updateFly(dt) {
    for (let i = flying.length - 1; i >= 0; i--) {
      const f = flying[i]; if (f.d.held || f.d.ag || f.d.m.isDisposed()) { flying.splice(i, 1); continue; }
      f.t = Math.min(f.T, f.t + dt);
      const m = f.d.m; m.position.set(f.p0.x + f.v.x * f.t, f.p0.y + f.v.y * f.t - 4.905 * f.t * f.t, f.p0.z + f.v.z * f.t);
      m.rotationQuaternion.multiplyInPlace(B.Quaternion.FromEulerAngles(f.spin.x * dt, f.spin.y * dt, f.spin.z * dt));
      if (f.t >= f.T) { flying.splice(i, 1); physOn(f.d, new B.Vector3(f.v.x, f.v.y - 9.81 * f.t, f.v.z)); f.d.restT = 0; if (!flying.length) { if (!playS("rubble_dump", 0.8)) crash(0.25); dust(bedCenter().addInPlaceFromFloats(0, 0.6, 0), 14); } }   // 最後の 1 個が荷台に入る時にザザッ
    }
  }
  function updateHeld(dt) {
    updateFly(dt);   // 掴んだ破片を置き場へすっと寄せる
    const a = Math.min(1, dt * 12);
    for (let i = 0; i < SLOTS.length; i++) { const d = slotUsed[i]; if (d) B.Vector3.LerpToRef(d.m.position, SLOTS[i], a, d.m.position); }
  }
  function updateGrab() {
    const up = bucketOpenUp();
    // すくう動き（バケットを巻き込んでいる最中）は、口の前の広めの範囲も掴む。板で押しのけてしまい 1 個しか入らなかったため
    const curling = ex.bucket > lastBucket + 1e-4 && up > -0.6, opening = ex.bucket < lastBucket - 1e-4; lastBucket = ex.bucket;
    if ((up > 0.35 || curling) && held < SLOTS.length) {
      const m = curling ? 0.95 : 0.1;   // すくう時は口の前を広めに（0.55 では散らばった瓦礫が 1 回 2〜9 個しか入らなかった 10-12）
      bucketJ.getWorldMatrix().invertToRef(_inv);
      const { W, H, L } = BUCKET;
      for (const d of debris) {
        if (d.held) continue;
        B.Vector3.TransformCoordinatesToRef(d.m.position, _inv, _lp);
        if (Math.abs(_lp.x) < W / 2 + m && _lp.y > -H - 0.25 - m && _lp.y < 0.05 && _lp.z > -0.1 && _lp.z < L + 0.15 + m) {
          const si = slotUsed.indexOf(null); if (si < 0) break;
          physOff(d); d.m.setParent(bucketJ); d.held = true; held++; d.slot = si; slotUsed[si] = d;
          // 大きすぎる塊はバケットに入る大きさに割れた扱い（離した後もこの大きさ）
          d.m.scaling.set(Math.min(d.m.scaling.x, 0.44), Math.min(d.m.scaling.y, 0.42), Math.min(d.m.scaling.z, 0.44));
          if (held >= SLOTS.length) break;
        }
      }
    } else if (opening && up < 0.1 && held) {
      // 自分で「あける」操作をして口が下を向いたら離す。ブームを上げただけで口が下を向き、運ぶ途中で落ちていたため
      // 少しずつこぼす（一度に全部だと荷台からあふれる）
      let n = 0;
      // 口に近い（山盛りの）物から順に、1 コマ 4 個ずつ
      for (let si = SLOTS.length - 1; si >= 0 && n < 4; si--) {
        const d = slotUsed[si]; if (!d) continue;
        slotUsed[si] = null; d.slot = -1;
        d.m.setParent(null); d.held = false; held--;
        // 口のすぐ外へ、置き場の並びのまま出す（重ならないので弾け飛ばない）
        const sp = SLOTS[si];
        const mouth = B.Vector3.TransformCoordinates(new B.Vector3(sp.x, -BUCKET.H - 0.3 - (si % 3) * 0.12, sp.z), bucketJ.getWorldMatrix());
        d.m.position.copyFrom(mouth);
        // 荷台の近く（9m 以内。6.5m では運転台の前で開くと外れた 10-12）で開いたら、荷台の中のばらけた場所に落ちる速さで投げる（補助）
        const p = d.m.position, v = new B.Vector3(0, 0, 0);
        if (truck.state === "wait") {
          const m = truck.root.computeWorldMatrix(true);
          const tgt = B.Vector3.TransformCoordinates(new B.Vector3((Math.random() - 0.5) * 1.5, BED.y0 + 0.35, BED.z0 + 0.6 + Math.random() * (BED.z1 - BED.z0 - 1.2)), m);
          if (Math.hypot(p.x - tgt.x, p.z - tgt.z) < 9) {
            // 山なりに投げる: 一番高い所が荷台の縁より 0.5m 上になるように（低い所で離しても縁を越えて中へ落ちる）
            const g = 9.81, rimY = B.Vector3.TransformCoordinates(new B.Vector3(0, 3.1, 0), m).y, peak = Math.max(p.y + 0.3, rimY + 0.8);   // 運転台の屋根（3.06）も越える高さ。荷台の縁だけ見ていたら運転台に当たって横へ跳ねた（10-12）
            const vy = Math.sqrt(2 * g * (peak - p.y)), t = vy / g + Math.sqrt(2 * Math.max(0.05, peak - tgt.y) / g);
            v.set((tgt.x - p.x) / t, vy, (tgt.z - p.z) / t);
            // 飛んでいる間は物理を切って放物線で動かす（物理のまま投げると、出てすぐ腕や仲間に当たって止まり、荷台の手前に落ちた 10-12）
            // 荷台の縁の少し上まで下りてきたら物理に戻す
            const yOn = rimY + 0.2, tOn = vy / g + Math.sqrt(2 * Math.max(0.05, peak - yOn) / g);
            flying.push({ d, p0: p.clone(), v: v.clone(), t: 0, T: tOn, spin: new B.Vector3(Math.random() * 6 - 3, Math.random() * 6 - 3, Math.random() * 6 - 3) });
            n++; continue;
          }
        }
        physOn(d, v); d.restT = 0;
        d.ag.body.setLinearDamping(0.05); d.ag.body.setAngularDamping(0.6);
        n++;
      }
      if (n) thud(0.15 + n * 0.03, 350);
    }
  }

  // ================= ダンプの荷台に入った破片を積む／出発と戻り =================
  let loadT = 0, loadedNow = 0, loadSum = 0, loadPopT = 0;
  function updateTruck(dt) {
    if (loadPopT > 0 && (loadPopT -= dt) <= 0 && loadSum) { popup("つんだ +" + loadSum * 3, "load"); loadSum = 0; }   // つんだ数は 0.9 秒ためて 1 回出す
    if (truck.state === "wait") {
      loadT += dt;
      if (loadT > 0.2) {
        loadT = 0;
        truck.root.computeWorldMatrix(true).invertToRef(_inv);
        for (let i = debris.length - 1; i >= 0; i--) {
          const d = debris[i]; if (d.held || !d.ag) continue;
          B.Vector3.TransformCoordinatesToRef(d.m.position, _inv, _lp);
          if (Math.abs(_lp.x) < BED.x && _lp.z > BED.z0 && _lp.z < BED.z1 && _lp.y > BED.y0 && _lp.y < BED.y0 + 1.6) {
            d.ag.body.getLinearVelocityToRef(_v);
            if (_v.lengthSquared() > 0.09) { d.restT = 0; continue; }       // 落ち着くまで待つ
            d.restT = (d.restT || 0) + 0.2; if (d.restT < 0.4) continue;
            physOff(d); d.m.setParent(truck.root); debris.splice(i, 1); truck.load.push(d.m); const u = units(d.m); truck.amount += u; score += u * 3; loadedNow += u;
          }
        }
        if (loadedNow) { chime([7 + Math.min(5, loadedNow)], 0.1, 0.1); loadSum += loadedNow; loadPopT = 0.9; loadedNow = 0; }
        if (truck.amount >= TRUCK_CAP) {
          // 出発の時、荷台の中でまだ転がっている物も全部積んだことにする（物理のまま運ぶと、速さの上限で荷台から滑り落ちた 10-12）
          for (let i = debris.length - 1; i >= 0; i--) {
            const d = debris[i]; if (d.held || !d.ag) continue;
            B.Vector3.TransformCoordinatesToRef(d.m.position, _inv, _lp);
            if (Math.abs(_lp.x) < BED.x + 0.2 && _lp.z > BED.z0 - 0.2 && _lp.z < BED.z1 + 0.2 && _lp.y > BED.y0 - 0.3 && _lp.y < BED.y0 + 2.5) { physOff(d); d.m.setParent(truck.root); debris.splice(i, 1); truck.load.push(d.m); }
          }
          if (loadSum) { popup("つんだ +" + loadSum * 3, "load"); loadSum = 0; loadPopT = 0; }   // 「しゅっぱつ」より先に出す
          truck.state = "leave"; truck.v = 0; if (playS("truck_horn", 0.6)) playS("truck_depart", 0.8, 1, 0.4); else thud(0.4, 200); score += 100; chime([0, 4, 7, 12], 0.12); truck.sent++; const left = STAGES[stage].trucks - truck.sent;
          popup(truck.sent + "だいめ しゅっぱつ！ +100" + (left > 0 ? "（あと " + left + "だい）" : ""), "big"); if (left <= 0 && !siteDone && finishAt < 0) finishAt = playT + 2.5; }   // 最後の 1 台が走り去るのを見せてから完成
      }
    } else if (truck.state === "leave") {
      truck.v = Math.min(16 * FASTT(), truck.v + 5 * FASTT() * dt); truck.z -= truck.v * dt;
      if (truck.z < -55) { for (const m of truck.load) m.dispose(); truck.load.length = 0; truck.amount = 0; truck.trips++; truck.state = "back"; }
    } else if (truck.state === "back") {
      const rest = TRUCK_HOME.z - truck.z;
      truck.v = Math.max(1.5, Math.min(16 * FASTT(), rest * 0.9 * FASTT())); truck.z += truck.v * dt;
      if (rest < 0.02) { truck.z = TRUCK_HOME.z; truck.state = "wait"; }
    }
    placeTruck(); syncColliders(truck.parts, false);
  }

  // 次はここ: 何か掴んでいる時、ダンプの荷台の上に下向きの矢印（はねる）
  const arrow = B.MeshBuilder.CreateCylinder("goalArrow", { diameterTop: 0, diameterBottom: 0.9, height: 1.0, tessellation: 4 }, scene);
  arrow.rotation.x = Math.PI; arrow.isPickable = false;
  { const am = new B.StandardMaterial("arrowM", scene); am.emissiveColor = new B.Color3(0.35, 1, 0.35); am.disableLighting = true; am.alpha = 0.85; arrow.material = am; }
  let arrowT = 0;
  function updateArrow(dt) {
    arrowT += dt;
    const show = held > 0 && truck.state === "wait"; arrow.setEnabled(show); if (!show) return;
    const c = bedCenter(); arrow.position.set(c.x, c.y + 3.2 + Math.sin(arrowT * 5) * 0.3, c.z); arrow.rotation.y = arrowT * 2;
  }
  let playT = 0;
  function goalText(pct, sd) {
    if (craneHere) return ride === "ex" ? "🚶 「おりる」で ショベルから おりて、クレーン車に のろう" : "🏗 クレーン車まで あるいて「のる」";
    if (!ride) return "🚜 ショベルカーに もどって「のる」";
    if (truck.state === "leave") return "🚚 ダンプが はこんで いくよ！";
    if (held > 0) return truck.state === "wait" ? "↩ ひだりに まわして、ダンプの 上で あけよう（みどりの 矢印）" : "⏳ ダンプが もどるまで まとう";
    if (finishAt >= 0) return "🎉 さいごの ダンプが しゅっぱつ！";
    if (bld.cells.size === 0) return "🪣 がれきを すくって ダンプへ（あと " + Math.max(0, STAGES[stage].trucks - truck.sent) + "だい）";
    if (sd >= 12) return "🪣 がれきを すくおう（右レバーを ←）";
    if (STAGES[stage].free) return "🏙 すきな たてものを こわそう！ ダンプにも つめるよ";
    if (STAGES[stage].sky) return sinks.length ? "🏢 たおれる！ はなれて みよう" : "🏢 1かいの かべを けずると…？";
    return STAGES[stage].town ? "🏠 バケットを いえに ぶつけて こわそう！" : "🏢 バケットを ビルに ぶつけて こわそう！";
  }
  function updateGoal(pct, sd) {
    $("gText").textContent = goalText(pct, sd);
    $("gBld").style.width = pct + "%"; $("gBldT").textContent = "かいたい " + pct + "%";
    const tp = Math.min(100, Math.round(truck.amount / TRUCK_CAP * 100));
    $("gTr").style.width = tp + "%"; $("gTrT").textContent = "ダンプ " + tp + "%　" + (STAGES[stage].free ? truck.sent + "だい はこんだ" : truck.sent + " / " + STAGES[stage].trucks + "だい");
    $("gScore").textContent = "★ " + score;
    $("gStage").textContent = "ステージ " + (stage + 1) + "　" + STAGES[stage].name;
  }
  // ステージを選ぶ札（最初と、クリアの後）
  function stars(n) { return "★".repeat(n) + "☆".repeat(3 - n); }
  // ステージ選び: 左に「こわす（ショベル）」、右に「たてる（クレーン）」。いつでも右上の「ステージ」から開ける（10-16 本人「飽きたら帰れるように」）
  // 全部最初から選べる。こわす→たてる・たてる→こわす はページを読み直して始める（重機や建材を確実に片づけるため）
  function goStage(kind, i) {
    if (kind === "d" && mode !== "build") { $("stages").style.display = "none"; $("done").style.display = "none"; startStage(i); return; }
    location.href = location.pathname + (kind === "d" ? "?stage=" + (i + 1) : "?build=" + (i + 1));
  }
  function showStages(title, canClose) {
    const el = $("stages"); el.innerHTML = "";
    const h = document.createElement("div"); h.className = "stTitle"; h.textContent = title; el.appendChild(h);
    const cols = document.createElement("div"); cols.className = "stCols"; el.appendChild(cols);
    for (const [kind, head, list, got] of [["d", "🚜 ショベルで こわす", STAGES, prog.stars], ["b", "🏗 クレーンで たてる", BSTAGES, prog.build || []]]) {
      const col = document.createElement("div"); col.className = "stCol"; cols.appendChild(col);
      const hh = document.createElement("div"); hh.className = "stHead"; hh.textContent = head; col.appendChild(hh);
      list.forEach((st, i) => {
        const now = (kind === "b") === (mode === "build") && i === (kind === "b" ? bstage : stage) && canClose;
        const b = document.createElement("button"); b.className = "btn stBtn" + (now ? " now" : "");
        b.textContent = `${i + 1}. ${st.name}　${st.free ? "♾" : stars(got[i] || 0)}`;
        b.onclick = () => { wakeAudio(); goStage(kind, i); };
        col.appendChild(b);
      });
    }
    if (canClose) { const c = document.createElement("button"); c.className = "btn stClose"; c.textContent = "◀ もどる"; c.onclick = () => { el.style.display = "none"; $("goal").style.display = ""; }; el.appendChild(c); }
    el.style.display = ""; $("goal").style.display = "none";
  }
  $("bStage").onclick = () => { wakeAudio(); if ($("stages").style.display === "none") showStages("ステージを えらぼう", true); else $("stages").style.display = "none"; };
  function startStage(i) { $("goal").style.display = ""; stage = i; FLOORS = STAGES[i].floors; reset(); applyLook(STAGES[i].look ?? i); chime([0, 7]); popup("ステージ " + (i + 1) + " スタート！", "mile"); }
  // さら地の結果
  function showResult() {
    const st = STAGES[stage], n = playT <= st.star3 ? 3 : playT <= st.star2 ? 2 : 1;
    const first = !prog.stars[stage];
    prog.stars[stage] = Math.max(prog.stars[stage] || 0, n); saveProg();
    const mm = Math.floor(playT / 60), ss = String(Math.floor(playT % 60)).padStart(2, "0");
    $("rStars").textContent = stars(n);
    $("rInfo").textContent = `じかん ${mm}:${ss}　ダンプ ${truck.sent}だい　とくてん ${score}` + (first && UPGRADES[stage] ? `\n🔓 パワーアップ: ${UPGRADES[stage]}` : "");
    $("bNext").style.display = STAGES[stage + 1] ? "" : "none"; $("bBuild").style.display = "none"; $("bNext").textContent = "つぎの ステージ ▶"; $("done").querySelector(".rT").textContent = STAGES[stage].free ? "まち ぜんぶ こわした！" : "さら地 かんせい！";
    $("done").style.display = "";
    chime([0, 4, 7, 12, 7, 12, 16], 0.13, 0.2); confetti();
  }
  const confettiPS = (() => {
    const ps = new B.ParticleSystem("confetti", 400, scene); ps.particleTexture = dustTex; ps.emitter = new B.Vector3(0, 12, 17);
    ps.minEmitBox = new B.Vector3(-6, 0, -4); ps.maxEmitBox = new B.Vector3(6, 2, 4);
    ps.color1 = new B.Color4(1, 0.85, 0.2, 1); ps.color2 = new B.Color4(0.3, 0.8, 1, 1); ps.colorDead = new B.Color4(1, 0.3, 0.5, 0.8);
    ps.minSize = 0.15; ps.maxSize = 0.35; ps.minLifeTime = 2; ps.maxLifeTime = 4; ps.emitRate = 0; ps.manualEmitCount = 0;
    ps.blendMode = B.ParticleSystem.BLENDMODE_ADD; ps.gravity = new B.Vector3(0, -2.5, 0);
    ps.direction1 = new B.Vector3(-3, 6, -3); ps.direction2 = new B.Vector3(3, 10, 3); ps.minEmitPower = 1; ps.maxEmitPower = 2; ps.renderingGroupId = 1; ps.start(); return ps;
  })();
  function confetti() { confettiPS.manualEmitCount = LITE ? 200 : 400; }

  // さら地: ビルが無くなり、範囲の瓦礫が CLEAR_LEFT 個以下になったら完成。最後の少しは片付け係が持っていく（拾い残しを探させない）
  const CLEAR_LEFT = 40;
  function sweepRest() {
    let k = 0;
    for (let i = debris.length - 1; i >= 0; i--) {
      const d = debris[i], p = d.m.getAbsolutePosition();
      if (d.held || p.x < SITE.x0 - 4 || p.x > SITE.x1 + 4 || p.z < SITE.z0 - 4 || p.z > SITE.z1 + 4) continue;
      if (k++ % 4 === 0) dust(p, 12);
      physOff(d); d.m.dispose(); debris.splice(i, 1);
    }
    popup("🧹 のこりは かたづけたよ！", "mile");
  }
  // 決めた台数を運んだら、残っている建物も片付け係が崩して持っていく（さら地にする）
  function clearRest() {
    let k = 0;
    const every = Math.max(25, Math.ceil(bld.cells.size / 40));
    for (const c of [...bld.cells.values()]) { if (k++ % every === 0) dust(c.p, 18); removeCell(c); }
    if (k) { rebuildCellMesh(); crash(0.6); shake(0.3); }
    sweepRest();
  }
  // ================= さら地の判定 =================
  let siteDone = false, finishAt = -1;   // finishAt: 決めた台数が出発した時刻＋少し（その時に完成）
  function siteDebris() {
    let n = 0;
    for (const d of debris) { const p = d.m.getAbsolutePosition(); if (!d.held && p.x > SITE.x0 && p.x < SITE.x1 && p.z > SITE.z0 && p.z < SITE.z1) n++; }
    return n;
  }

  function reset() {
    clearDebris(); buildBuilding();
    for (const m of truck.load) m.dispose(); truck.load.length = 0; truck.amount = 0; truck.trips = 0; truck.sent = 0; finishAt = -1; truck.state = "wait"; truck.z = TRUCK_HOME.z;
    held = 0; slotUsed.fill(null); chain.length = 0; flying.length = 0; siteDone = false; $("done").style.display = "none";
    score = 0; combo = 0; comboT = 0; lastPctStep = 0; playT = 0; trauma = 0; lastDustT = -1;
    if (BIGB() && SLOTS.length === BASE_SLOTS) { for (const [x, z] of [[-0.63, 0.55], [0.63, 0.55], [-0.63, 1.0], [0.63, 1.0], [-0.42, 0.3], [0.42, 0.3], [-0.42, 1.25], [0.42, 1.25], [0, 0.75], [0, 0.3], [0, 1.25], [-0.21, 0.75], [0.21, 0.75]]) { SLOTS.push(new B.Vector3(x, -1.32 - (Math.abs(x) < 0.3 ? 0.36 : 0), z)); slotUsed.push(null); } bucketJ.scaling.setAll(1.15); }
    ex.pos.set(0, 0, 2); ex.heading = 0; ex.swing = 0; ex.boom = -0.35; ex.stick = 1.3; ex.bucket = 0.6;
    look.yaw = 0; look.pitch = 0.12;
    applyPose(); syncColliders(exParts, true); placeTruck(); syncColliders(truck.parts, true);
    // 乗り降り: 始めはショベルに乗っている。来ていたクレーン車は帰す
    ride = "ex"; craneHere = false; exSlide = null; wkRoot.setEnabled(false); for (const n of crAll) n.setEnabled(false); drawSlings(null);
    fp.parent = seat; fp.fov = 1.15; $("pedals").style.display = ""; setLabels();
  }

  // 重機が格子・ダンプに入り込まないか
  function blockedAt(p) {
    if (cellsNear(p, 2.0, 2.3, 2)) return true;
    const t = truck.root.position;
    if (Math.abs(t.x - p.x) < 1.25 + 1.9 && Math.abs(t.z - 0.6 - p.z) < 3.6 + 2.2) return true;
    if (craneHere && Math.abs(cr.pos.x - p.x) < 4.5 && Math.abs(cr.pos.z - p.z) < 7) return true;
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
  const CLIM = { luff: [0.12, 1.4], ext: [0, 33], wire: [1.2, 50] };   // 10 階のタワーまで届くよう筒を 4 段にして 33 まで（各段 8.25m 出ても 9.2m の筒は重なる 10-16）   // ext は 25 まで（内側の筒 9.2m を 3 段で出すので、25.8 を超えると段の間にすき間が空いた 10-12 評価 k2）
  const crRoot = new B.TransformNode("crane", scene);
  const crRed = paintM("crRed", "paint_red_diff.jpg", 0.38, 0.6), white = paintM("white", "paint_white_diff.jpg", 0.4, 0.6);
  const crRoofGlass = mat("crRoofGlass", 0.2, 0.25, 0.28, 0.05); crRoofGlass.alpha = 0.12;   // 屋根は上を見て吊るので薄く
  const crGlass = mat("crGlass", 0.1, 0.16, 0.22, 0.03); crGlass.alpha = 0.45; crGlass.backFaceCulling = true;   // 運転席のガラスは薄く（色が濃いとフックが暗く沈んだ）
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
    cyl("crPad", 0.8, 0.08, crRoot, [sx * 3.2, 0.12, z], null, dark, 20);
    deco("crMat", [1.3, 0.1, 1.3], crRoot, [sx * 3.2, 0.05, z], mat("crMatM", 0.42, 0.3, 0.18, 0.9));   // 敷板（木）
  }
  deco("crBumper", [2.7, 0.35, 0.3], crRoot, [0, 1.0, 4.6], dark);
  for (const sx of [-0.95, 0.95]) deco("crLamp", [0.3, 0.16, 0.05], crRoot, [sx, 1.45, 4.52], lampM);
  const crUpper = new B.TransformNode("crUpper", scene); crUpper.parent = crRoot; crUpper.position.y = 1.9;
  makeBox("crTurn", [2.4, 0.9, 4.2], crUpper, [0.35, 0.45, -1.0], crRed).isVisible = false;
  prism("crTurnShape", [[1.1, 0.02], [1.1, 0.62], [0.8, 0.9], [-2.7, 0.9], [-3.1, 0.55], [-3.1, 0.02]], 2.4, crUpper, -0.85, crRed);
  makeBox("crWeight", [2.4, 1.0, 1.0], crUpper, [0.35, 0.5, -3.4], dark);
  makeBox("crCab", [1.1, 1.5, 1.7], crUpper, [-0.95, 0.75, 1.2], crGlass).isPickable = false;
  makeBox("crCabRoof", [1.15, 0.05, 1.75], crUpper, [-0.95, 1.52, 1.2], crRoofGlass).isVisible = false;   // 上を見て吊るので屋根は無し（縁の線が空に見えた）
  for (const [x, z] of [[-1.48, 2.03], [-0.42, 2.03], [-1.48, 0.37], [-0.42, 0.37]]) deco("crPillar", [0.07, 1.5, 0.07], crUpper, [x, 0.75, z], white);
  deco("crCabLow", [1.14, 0.52, 1.74], crUpper, [-0.95, 0.28, 1.2], white);   // 腰から下は白い板（ガラスの箱だけだと骨組みに見えた 評価 k3）
  deco("crCabBack", [1.14, 1.5, 0.06], crUpper, [-0.95, 0.75, 0.34], white);
  deco("crCabRim", [1.14, 0.06, 0.06], crUpper, [-0.95, 1.5, 2.03], white);   // 前の窓の上の枠
  for (const x of [-1.3, -0.6]) deco("crWorkLamp", [0.2, 0.14, 0.1], crUpper, [x, 1.6, 2.0], lampM);   // 作業灯
  deco("crBeacon", [0.14, 0.12, 0.14], crUpper, [-0.95, 1.6, 0.6], mat("beaconM", 1, 0.55, 0.05, 0.4));   // 回転灯
  deco("crWiper", [0.5, 0.025, 0.025], crUpper, [-0.95, 0.62, 2.07], dark, [0, 0, 0.5]);
  deco("crCabBase", [1.12, 0.08, 1.72], crUpper, [-0.95, 0.02, 1.2], white);   // 屋根もガラス（上を見て吊るので）
  for (const [x, z] of [[-1.55, 2.0]]) { deco("crMirrorArm", [0.3, 0.04, 0.04], crUpper, [x - 0.1, 1.2, z], dark); deco("crMirror", [0.06, 0.32, 0.2], crUpper, [x - 0.27, 1.12, z], dark); }
  const crSeat = new B.TransformNode("crSeat", scene); crSeat.parent = crUpper; crSeat.position.set(-0.95, 1.15, 1.1);
  const crBoomJ = new B.TransformNode("crBoomJ", scene); crBoomJ.parent = crUpper; crBoomJ.position.set(0.45, 1.2, -2.4);
  const BOOM0 = 11, PIV = { x: 0.45, y: 1.9 + 1.2, z: -2.4 };   // 一番縮めた時のブームの長さ／ブームの根元（クレーンの中の座標）
  makeBox("crBoom1", [0.9, 0.9, BOOM0], crBoomJ, [0, 0, BOOM0 / 2], crRed).isVisible = false;
  const crBoom2 = makeBox("crBoom2", [0.62, 0.62, 1], crBoomJ, [0, 0, 0], white); crBoom2.isVisible = false;
  // 見た目のブーム: 太い順に 4 段の六角形の筒。伸ばした分を内側の 3 段で等分して出す。筒の口には濃い色の帯
  const SEC = [{ d: 0.98, L: BOOM0, m: crRed }, { d: 0.82, L: 9.2, m: white }, { d: 0.68, L: 9.2, m: white }, { d: 0.55, L: 9.2, m: white }, { d: 0.43, L: 9.2, m: white }].map((c, i) => {
    const t = B.MeshBuilder.CreateCylinder("crSec" + i, { diameter: c.d, height: c.L, tessellation: 6 }, scene);
    t.rotation.y = Math.PI / 6; t.bakeCurrentTransformIntoVertices();   // 六角形の向きは筒の軸まわりに先に焼き込む（rotation.y と x を同時に入れると Y が後に掛かり、筒が横へ 30 度ねじれて段が途切れて見えた 10-12 評価 k2）
    t.parent = crBoomJ; t.rotation.x = Math.PI / 2; t.scaling.x = 0.82; t.material = c.m;
    shadow.addShadowCaster(t); t.receiveShadows = true; t.isPickable = false;
    const col = B.MeshBuilder.CreateCylinder("crCollar" + i, { diameter: c.d + 0.06, height: 0.22, tessellation: 6 }, scene);
    col.rotation.y = Math.PI / 6; col.bakeCurrentTransformIntoVertices(); col.parent = crBoomJ; col.rotation.x = Math.PI / 2; col.scaling.x = 0.82; col.material = i ? dark : crRed; col.isPickable = false; shadow.addShadowCaster(col);
    return { ...c, t, col };
  });
  function placeBoomSecs(ext) {
    SEC.forEach((c, i) => { const a = i ? 0.6 * i + ext * i / (SEC.length - 1) : 0; c.t.position.z = a + c.L / 2; c.col.position.z = a + c.L - 0.11; });
  }
  // 起伏シリンダー: 旋回台からブームの腹へ
  piston("crLuff", anchor("lA", crUpper, [0.45, 0.35, 0.2]), anchor("lB", crBoomJ, [0, -0.5, 4.2]), 0.42, white);
  const crLuff = pistons[pistons.length - 1];
  const crTip = new B.TransformNode("crTip", scene); crTip.parent = crBoomJ;
  makeBox("crSheave", [0.46, 0.8, 0.9], crTip, [0, -0.15, -0.15], white);
  for (const sx of [-0.25, 0.25]) cyl("crPulley", 0.75, 0.06, crTip, [sx, -0.25, 0.1], [0, 0, Math.PI / 2], dark, 20);
  // ロープ（太め・2 本）とフック（黄色いブロック＋鉤）。前は細い 1 本と小さな箱で、ほぼ見えなかった
  const ropeM = mat("ropeM", 0.24, 0.24, 0.26, 0.6, 0.8);   // 暗い鋼色（真っ黒だと鉄のロープに見えなかった 評価 k4）
  const wireM = B.MeshBuilder.CreateCylinder("wire", { diameter: 0.11, height: 1, tessellation: 8 }, scene); wireM.material = ropeM;
  const wireM2 = B.MeshBuilder.CreateCylinder("wire2", { diameter: 0.11, height: 1, tessellation: 8 }, scene); wireM2.material = ropeM;
  const hookM = mat("hookM", 1, 0.75, 0.05, 0.4); hookM.emissiveColor = new B.Color3(0.25, 0.17, 0);
  const hook = new B.TransformNode("hook", scene);
  const hookBlock = B.MeshBuilder.CreateBox("hookBlock", { width: 0.75, height: 0.9, depth: 0.5 }, scene); hookBlock.parent = hook; hookBlock.material = hookM; shadow.addShadowCaster(hookBlock);
  const hookStripe = B.MeshBuilder.CreateBox("hookStripe", { width: 0.77, height: 0.18, depth: 0.52 }, scene); hookStripe.parent = hook; hookStripe.position.y = 0.1; hookStripe.material = dark;
  for (const z of [-0.26, 0.26]) { const sv = B.MeshBuilder.CreateCylinder("hookSheave", { diameter: 0.4, height: 0.03, tessellation: 24 }, scene); sv.parent = hook; sv.rotation.x = Math.PI / 2; sv.position.set(0, 0.16, z); sv.material = steel; }   // 滑車の丸（フックブロックらしく）
  // 鉤: J 字（軸 → 下で丸く曲がって先が上を向く）。前は黒い輪で、鉤に見えなかった（評価 k3）
  const jPts = [new B.Vector3(-0.17, -0.42, 0), new B.Vector3(-0.17, -0.78, 0)];
  for (let i = 1; i <= 12; i++) { const a = Math.PI + Math.PI * i / 12; jPts.push(new B.Vector3(Math.cos(a) * 0.17, -0.78 + Math.sin(a) * 0.17, 0)); }
  jPts.push(new B.Vector3(0.17, -0.66, 0));
  const hookCurve = B.MeshBuilder.CreateTube("hookCurve", { path: jPts, radius: 0.055, tessellation: 10, cap: B.Mesh.CAP_ALL }, scene);
  hookCurve.parent = hook; hookCurve.material = steel; shadow.addShadowCaster(hookCurve);
  const hookShank = B.MeshBuilder.CreateCylinder("hookShank", { diameter: 0.16, height: 0.12, tessellation: 12 }, scene); hookShank.parent = hook; hookShank.position.set(-0.17, -0.46, 0); hookShank.material = steel;
  const hookLatch = B.MeshBuilder.CreateBox("hookLatch", { width: 0.36, height: 0.035, depth: 0.07 }, scene);   // 外れ止め: 軸から鉤の先へ渡した黄色い金具
  hookLatch.parent = hook; hookLatch.position.set(0, -0.6, 0); hookLatch.rotation.z = -0.3; hookLatch.material = hookM;
  // 落ちる場所の目印（吊り荷・フックの真下）と、真下へ伸びる細い線
  const markM = new B.StandardMaterial("markM", scene); markM.diffuseColor = new B.Color3(1, 0.55, 0.1); markM.emissiveColor = new B.Color3(0.6, 0.3, 0); markM.alpha = 0.6;
  const mark = B.MeshBuilder.CreateDisc("mark", { radius: 0.9, tessellation: 32 }, scene); mark.rotation.x = Math.PI / 2; mark.material = markM; mark.isPickable = false;
  const markLine = B.MeshBuilder.CreateCylinder("markLine", { diameter: 0.05, height: 1, tessellation: 6 }, scene); markLine.material = markM; markLine.isPickable = false;
  // 丸影: 半透明の黒い円を 3 枚重ねて、真ん中ほど濃く見せる（ぼかした絵の透け具合や頂点の色の透け具合では、なぜか全部透けて見えなかった 10-12 評価 k3。材質の alpha なら写った）
  const blobM = new B.StandardMaterial("blobM", scene); blobM.disableLighting = true; blobM.diffuseColor = B.Color3.Black(); blobM.specularColor = B.Color3.Black(); blobM.emissiveColor = new B.Color3(0.02, 0.02, 0.02); blobM.alpha = 0.24; blobM.backFaceCulling = false;
  const blob = (name, w, d) => {
    const b = new B.Mesh(name, scene);
    [0.5, 0.37, 0.24].forEach((r, k) => { const c = B.MeshBuilder.CreateDisc(name + k, { radius: r, tessellation: 28 }, scene); c.rotation.x = Math.PI / 2; c.scaling.set(w, d, 1); c.position.y = k * 0.004; c.parent = b; c.material = blobM; c.isPickable = false; c.renderingGroupId = 1; });
    b.setVis = v => { for (const c of b.getChildMeshes()) c.visibility = v; };
    return b;
  };
  const crBlob = blob("crBlob", 7.5, 12); crBlob.parent = crRoot; crBlob.position.y = 0.05;
  const hookBlob = blob("hookBlob", 1, 1), loadBlob = blob("loadBlob", 1, 1);
  const crAll = [crRoot, wireM, wireM2, hook, mark, markLine, crLuff.barrel, crLuff.rod, hookBlob, loadBlob];
  for (const n of crAll) n.setEnabled(false);

  // 建てる物: 1 階 = 柱 4 → 梁 4 → 床板 1。建物の位置は解体したビルと同じ（x -4〜4, z 14〜20）
  const FLOOR_H = 3.6, SC = { x: 0, z: 17 };
  const steelM = paintM("steelM", "paint_primer_diff.jpg", 0.6, 0), slabM = pbrTex("slabM", "concrete_floor_02", 2.5);   // さび止め塗装の鉄骨・コンクリートの床板
  const ghostM = new B.StandardMaterial("ghostM", scene); ghostM.diffuseColor = new B.Color3(0.2, 0.9, 1); ghostM.emissiveColor = new B.Color3(0.1, 0.6, 0.8); ghostM.alpha = 0.35;
  const ghostOk = new B.StandardMaterial("ghostOk", scene); ghostOk.diffuseColor = new B.Color3(0.3, 1, 0.3); ghostOk.emissiveColor = new B.Color3(0.15, 0.8, 0.15); ghostOk.alpha = 0.6;
  let BUILD_GOAL = 99; const bd_goal = () => BUILD_GOAL;   // 何階だてか（最後の階に看板を足す）。bd より前に呼ばれるので別の変数
  const signMs = {};
  const signM = (text) => signMs[text] || (signMs[text] = (() => {
    const t = new B.DynamicTexture("signT", { width: 512, height: 200 }, scene, true), c = t.getContext();
    c.fillStyle = "#1c5fb8"; c.fillRect(0, 0, 512, 200); c.strokeStyle = "#fff"; c.lineWidth = 10; c.strokeRect(8, 8, 496, 184);
    c.fillStyle = "#fff"; c.textAlign = "center"; c.textBaseline = "middle";
    let fs = 92; do { c.font = "bold " + fs + "px sans-serif"; fs -= 4; } while (c.measureText(text).width > 470 && fs > 30);
    c.fillText(text, 256, 104); t.update();
    const m = new B.StandardMaterial("signM", scene); m.diffuseTexture = t; m.emissiveColor = new B.Color3(0.35, 0.35, 0.35); return m;
  })());
  // 建物ごとの色（写真素材が無いので色だけ）
  const solidM = (name, rgb, rough) => { const m = new B.PBRMaterial(name, scene); m.albedoColor = new B.Color3(...rgb).toLinearSpace(); m.metallic = 0; m.roughness = rough; return m; };
  const woodM = solidM("woodM", [0.6, 0.4, 0.22], 0.8), woodFloorM = solidM("woodFloorM", [0.72, 0.55, 0.36], 0.7), roofTM = solidM("roofTM", [0.2, 0.25, 0.36], 0.5), whiteM = solidM("whiteM", [0.88, 0.88, 0.85], 0.45);
  const glassWM = solidM("glassWM", [0.3, 0.55, 0.78], 0.06); glassWM.metallic = 0.4; glassWM.alpha = 0.7;
  // 1 階ぶんの段取り。建物の種類（bldType）で色と足す物が変わる
  //   biru: 赤い鉄骨＋床＋屋上の看板 / mansion: 白い骨組み＋各階の前にベランダ / tower: 各階の前面に青いガラスの壁 / house: 木の柱と梁・木の床＋最後に三角屋根 2 枚
  function planFloor(f) {
    const y0 = f * FLOOR_H, L = [], T = bldType(), last = f === bd_goal() - 1;
    const fm = T === "house" ? woodM : T === "mansion" ? whiteM : steelM;
    const X = SC.x, Z = SC.z - 17;   // 建てる場所（おうち 3けん では場所が変わる）
    if (BSTAGES[bstage].unit) {        // わく（柱 4 本＋梁 4 本を組んだ物）→ 床板 → ガラス（→ 最後に看板）
      L.push({ kind: "わく", size: [7.95, FLOOR_H, 5.95], pos: new B.Vector3(X, y0 + FLOOR_H / 2, SC.z), m: fm });
      L.push({ kind: "床板", size: [8.2, 0.22, 6.2], pos: new B.Vector3(X, y0 + FLOOR_H + 0.11, SC.z), m: slabM });
      L.push({ kind: "ガラス", size: [7.4, FLOOR_H - 0.5, 0.12], pos: new B.Vector3(X, y0 + (FLOOR_H - 0.5) / 2 + 0.05, Z + 13.8), m: glassWM });
      if (last) L.push({ kind: "かんばん", size: [4, 1.6, 0.25], pos: new B.Vector3(X, y0 + FLOOR_H + 0.22 + 0.8, Z + 14.6), m: signM(BLD[T]) });
      return L;
    }
    for (const x of [-3.8, 3.8]) for (const z of [14.2, 19.8]) L.push({ kind: "柱", size: [0.35, FLOOR_H, 0.35], pos: new B.Vector3(X + x, y0 + FLOOR_H / 2, Z + z), m: fm });
    for (const z of [14.2, 19.8]) L.push({ kind: "梁", size: [7.3, 0.4, 0.3], pos: new B.Vector3(X, y0 + FLOOR_H - 0.2, Z + z), m: fm });
    for (const x of [-3.8, 3.8]) L.push({ kind: "梁", size: [0.3, 0.4, 5.3], pos: new B.Vector3(X + x, y0 + FLOOR_H - 0.2, SC.z), m: fm });
    L.push({ kind: "床板", size: [8.2, 0.22, 6.2], pos: new B.Vector3(SC.x, y0 + FLOOR_H + 0.11, SC.z), m: T === "house" ? woodFloorM : slabM });
    if (T === "mansion") L.push({ kind: "ベランダ", size: [8.2, 0.18, 1.3], pos: new B.Vector3(SC.x, y0 + FLOOR_H + 0.09, Z + 13.9 - 0.65), m: whiteM });
    if (T === "tower") L.push({ kind: "ガラス", size: [7.4, FLOOR_H - 0.5, 0.12], pos: new B.Vector3(X, y0 + (FLOOR_H - 0.5) / 2 + 0.05, Z + 13.8), m: glassWM });   // 床板の縁（z 13.9）より外: ワイヤーが床を突き抜けて見えないように
    if (last && T === "house") {
      // 三角屋根: 床の上で 30 度。手前の 1 枚 → 奥の 1 枚。軒は 0.5m 出す
      const a = Math.PI / 6, run = 3.1 + 0.5, len = run / Math.cos(a), yb = y0 + FLOOR_H + 0.22;
      for (const sg of [-1, 1]) L.push({ kind: "やね", size: [8.9, 0.2, len], pos: new B.Vector3(SC.x, yb + Math.tan(a) * run / 2 - 0.05, SC.z + sg * run / 2), m: roofTM, q: B.Quaternion.RotationAxis(B.Axis.X, sg * a) });
    } else if (last) L.push({ kind: "かんばん", size: [4, 1.6, 0.25], pos: new B.Vector3(X, y0 + FLOOR_H + 0.22 + 0.8, Z + 14.6), m: signM(BLD[T]) });   // 最後の 1 個は屋上の看板
    return L;
  }
  const YARD = new B.Vector3(-7.5, 0, 10.5);              // 建材の置き場（クレーンの左前）。5.5 では置き場へ戻る 2〜3 秒が待ちになった（10-12 評価 b0）
  const SNAP = { xz: 2.0, y: 1.8 };                       // 枠のこの範囲に入るとピタッとはまる
  const bd = { floor: 0, step: 0, plan: planFloor(0), placed: [], score: 0, hanging: null, yard: null, snap: null, ghost: null, toastT: 0, near: false, goal: 2, t: 0, streak: 0, perfect: 0, done: false, windT: 4, gust: 0, gustDir: 0, hookT: 0 };
  const CRANE_SPD = () => (prog.build && prog.build[0] ? 1.4 : 1);   // 建築 1 つめクリア: フックが 1.4 倍速
  const SNAP_MUL = () => (prog.build && prog.build[1] ? 1.35 : 1);   // 建築 2 つめクリア: はまる範囲が広い
  const WIND_MUL = () => (prog.build && prog.build[2] ? 0.4 : 1);    // 建築 3 つめクリア: 風に強い
  const BUILD_UPS = ["クレーンが はやくなる（1.4ばい）", "ぴったりの はんいが ひろがる", "かぜに つよくなる"];
  // 柱と梁は H 形（フランジ 2 枚＋ウェブ 1 枚）。床板はただの板
  function hBeam(name, size) {
    const ax = size.indexOf(Math.max(...size)), L = size[ax], o = [0, 1, 2].filter(i => i !== ax), W = size[o[0]], Hh = size[o[1]], t = 0.035;
    const part = (a, b, off) => { const d = [0, 0, 0]; d[ax] = L; d[o[0]] = a; d[o[1]] = b; const m = B.MeshBuilder.CreateBox(name, { width: d[0], height: d[1], depth: d[2] }, scene); m.position.set(0, 0, 0); if (off) m.position[["x", "y", "z"][o[1]]] = off; return m; };
    return B.Mesh.MergeMeshes([part(W, t, Hh / 2 - t / 2), part(W, t, -(Hh / 2 - t / 2)), part(t, Hh - 2 * t, 0)], true);
  }
  function frameUnit(name, size) {   // わく: 4 隅の柱と上の梁 4 本を 1 つに
    const [W, H, D] = size, hx = W / 2 - 0.18, hz = D / 2 - 0.18, ps = [];
    for (const x of [-hx, hx]) for (const z of [-hz, hz]) { const c = hBeam(name, [0.35, H, 0.35]); c.position.set(x, 0, z); ps.push(c); }
    for (const z of [-hz, hz]) { const b = hBeam(name, [W - 0.65, 0.4, 0.3]); b.position.set(0, H / 2 - 0.2, z); ps.push(b); }
    for (const x of [-hx, hx]) { const b = hBeam(name, [0.3, 0.4, D - 0.65]); b.position.set(x, H / 2 - 0.2, 0); ps.push(b); }
    return B.Mesh.MergeMeshes(ps, true);
  }
  function pieceMesh(p, name) {
    const m = p.kind === "わく" ? frameUnit(name, p.size) : p.kind !== "柱" && p.kind !== "梁" ? B.MeshBuilder.CreateBox(name, { width: p.size[0], height: p.size[1], depth: p.size[2] }, scene) : hBeam(name, p.size);
    m.material = p.m; shadow.addShadowCaster(m); m.receiveShadows = true; m.rotationQuaternion = B.Quaternion.Identity();
    return m;
  }
  function nextPiece() {
    const p = bd.plan[bd.step];
    if (bd.ghost) bd.ghost.dispose();
    // 枠は細い梁でも目立つよう、細い向きは 0.7m まで太らせる（評価役 3 人とも「緑の細線だけで目立たない」）
    bd.ghost = B.MeshBuilder.CreateBox("ghost", { width: Math.max(0.7, p.size[0] + 0.1), height: Math.max(0.7, p.size[1] + 0.1), depth: Math.max(0.7, p.size[2] + 0.1) }, scene);
    bd.ghost.material = ghostM; bd.ghost.position.copyFrom(p.pos); bd.ghost.isPickable = false; if (p.q) bd.ghost.rotationQuaternion = p.q.clone();
    // 置き場に寝かせて出す（柱は横倒し）
    const m = pieceMesh(p, "piece");
    // 柱は寝かせて、上になる端（+Y の端）を置き場の印の上に。吊ると、その端から起き上がる（建て起こし）
    if (p.kind === "柱") { m.rotationQuaternion = B.Quaternion.RotationAxis(B.Axis.Z, -Math.PI / 2); m.position.set(YARD.x - p.size[1] / 2, p.size[0] / 2 + 0.15, YARD.z); }
    else m.position.set(YARD.x, p.size[1] / 2 + 0.15, YARD.z);
    bd.yard = { p, m, at: new B.Vector3(YARD.x, 0, YARD.z), rest: m.position.clone(), q0: m.rotationQuaternion.clone(), ...rigOf(p) };
    // 掛ける所に黄色い吊りリング（フックをどこへ下ろすか見て分かるように）。はまったら外す
    bd.yard.rings = bd.yard.pts.map((q, i) => { const r = B.MeshBuilder.CreateTorus("ring" + i, { diameter: 0.46, thickness: 0.09, tessellation: 14 }, scene); r.parent = m; r.position.copyFrom(q).addInPlaceFromFloats(0, 0.2, 0); r.rotation.x = Math.PI / 2; r.material = ringM; r.isPickable = false; return r; });
  }
  // 玉掛け: 柱は上の端に 1 本（建て起こし）、梁は 2 本、床板・看板は 4 本。
  // ワイヤーの長さは「広がりの半分 × 1.15」以上（吊り角度がおよそ 80 度以下。広げすぎると本物らしくない）
  const HOOK_DROP = 0.95;                                   // フックの中心から鉤の底まで
  function rigOf(p) {
    const [sx, sy, sz] = p.size;
    if (p.kind === "柱") { const S = 0.7; return { pts: [new B.Vector3(0, sy / 2, 0)], S, hang: HOOK_DROP + S + sy, col: true }; }
    let pts;
    if (p.kind === "梁") { const ax = sx > sz ? "x" : "z", h = Math.max(sx, sz) / 2 - 0.6; pts = [-h, h].map(v => { const q = new B.Vector3(0, sy / 2, 0); q[ax] = v; return q; }); }
    else if (p.kind === "かんばん" || p.kind === "ガラス") { const h = p.kind === "ガラス" ? sx / 2 - 1 : 1.4; pts = [-h, h].map(v => new B.Vector3(v, sy / 2, 0)); }   // 立てたまま上の縁に 2 本
    else pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => new B.Vector3(a * (sx / 2 - 0.5), sy / 2, b * (sz / 2 - 0.5)));
    const spread = Math.max(...pts.map(q => Math.hypot(q.x, q.z))), S = Math.max(0.9, spread * 1.15);
    return { pts, S, hang: HOOK_DROP + S + sy, col: false };
  }
  const slingM = mat("slingM", 0.36, 0.36, 0.37, 0.6, 0.6);   // 玉掛けワイヤー（評価 k1: 細く明るいと見えにくい → 太く暗めの灰）
  const ringM = mat("ringM", 1, 0.8, 0.1, 0.4); ringM.emissiveColor = new B.Color3(0.3, 0.22, 0);
  const slings = [0, 1, 2, 3].map(i => { const w = B.MeshBuilder.CreateCylinder("sling" + i, { diameter: 0.095, height: 1, tessellation: 6 }, scene); w.material = slingM; w.isPickable = false; w.setEnabled(false); return w; });
  const slings2 = slings.map((w, i) => { const v = w.clone("slingB" + i); v.setEnabled(false); return v; });   // たるんだ時の下半分
  // sag > 0 の時はワイヤーがたるむ（真ん中が下がった 2 本の線で描く）
  function drawSlings(h, hb, sag = 0) {
    if (!h) { for (const w of slings) w.setEnabled(false); for (const w of slings2) w.setEnabled(false); return; }
    const W = h.m.computeWorldMatrix(true);
    slings.forEach((w, i) => {
      const q = h.pts[i], v = slings2[i]; w.setEnabled(!!q); v.setEnabled(!!q && sag > 0); if (!q) return;
      const e = B.Vector3.TransformCoordinates(q, W);
      if (sag > 0) { const mid = B.Vector3.Lerp(hb, e, 0.55); mid.y -= sag; setRope(w, hb, mid); setRope(v, mid, e); } else setRope(w, hb, e);
    });
  }
  // 吊っている建材の位置と向き。ワイヤーが張るまでは地面に残る（地切り）。柱は下の端を地面に付けたまま起き上がる
  function hangPiece(h, hp, dt) {
    const hb = new B.Vector3(hp.x, hp.y - HOOK_DROP, hp.z), m = h.m;
    if (h.col) {
      const Lc = h.p.size[1], yb = h.rest.y, top = new B.Vector3(hp.x, hb.y - h.S, hp.z), rise = top.y - yb;
      let bot;
      if (rise >= Lc - 0.001) { bot = top.subtract(new B.Vector3(0, Lc, 0)); h.lifted = true; }
      else {
        const hd = Math.sqrt(Math.max(0, Lc * Lc - Math.max(0, rise) * Math.max(0, rise)));
        const u = new B.Vector3(top.x - h.bot.x, 0, top.z - h.bot.z); const ul = u.length(); if (ul > 1e-3) u.scaleInPlace(1 / ul); else u.set(1, 0, 0);
        bot = new B.Vector3(top.x - u.x * hd, yb, top.z - u.z * hd); h.lifted = false;
        if (rise < 0) top.y = yb;
      }
      h.bot = bot;
      const dir = top.subtract(bot).normalize();
      m.position.copyFrom(top.add(bot).scaleInPlace(0.5));
      B.Quaternion.FromUnitVectorsToRef(_up, dir, m.rotationQuaternion);
    } else {
      const want = hb.y - h.S - h.p.size[1] / 2;
      if (want > h.rest.y + 0.02) {
        h.lifted = true;
        const k = Math.min(1, dt * 6); m.position.x += (hp.x - m.position.x) * k; m.position.z += (hp.z - m.position.z) * k; m.position.y = want;
      } else { h.lifted = false; m.position.y = h.rest.y; }
      if (h.lifted) B.Quaternion.RotationYawPitchRollToRef(0, B.Scalar.Clamp(cr.swayV.y * 0.012, -0.017, 0.017), B.Scalar.Clamp(-cr.swayV.x * 0.012, -0.017, 0.017), m.rotationQuaternion);   // 最大 2 度（評価 k2: 4.6 度では傾いたまま運ばれて見えた）
    }
    drawSlings(h, hb);
  }
  function drawLoose(dt) {
    const L = bd.loose; if (!L) return;
    L.t -= dt; if (L.t <= 0 || bd.hanging) { bd.loose = null; if (!bd.hanging && !bd.snap) drawSlings(null); return; }
    const W = L.h.m.computeWorldMatrix(true), c = B.Vector3.TransformCoordinates(new B.Vector3(0, L.h.p.size[1] / 2 + 0.05, 0), W);
    slings.forEach((w, i) => { const q = L.h.pts[i]; w.setEnabled(!!q); slings2[i].setEnabled(false); if (q) { const e = B.Vector3.TransformCoordinates(q, W); e.y += 0.05; setRope(w, e, B.Vector3.Lerp(e, c, 0.7)); } });
  }
  function toast(t) { const el = $("toast"); el.textContent = t; el.style.display = ""; bd.toastT = 2.5; }
  function applyCranePose() {
    crRoot.position.copyFrom(cr.pos); crRoot.rotation.y = cr.heading;
    crUpper.rotation.y = cr.swing; crBoomJ.rotation.x = -cr.luff + (cr.bend || 0);
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
  // 外から見ている時、ブームが「カメラ→吊り荷・光る枠」の間に入ったら半透明にする（看板を据える所がブームで隠れた 10-12 評価 b1）
  let boomFade = 1;
  function fadeBoom(dt) {
    let want = 1;
    if (view === "tp" && !bd.done && !G.camAt) {
      const cam = tp.position, root = crBoomJ.getAbsolutePosition(), tip = crTip.getAbsolutePosition();
      const goals = [cr.tgt]; if (bd.ghost) goals.push(bd.ghost.position);
      for (const g of goals) {
        const d = g.subtract(cam), len = d.length(); d.scaleInPlace(1 / len);
        for (let i = 0; i <= 12 && want === 1; i++) {
          const q = B.Vector3.Lerp(root, tip, i / 12), v = q.subtract(cam), k = B.Vector3.Dot(v, d);
          if (k > 0 && k < len - 1 && v.subtract(d.scale(k)).length() < 1.6) want = 0.25;
        }
      }
    }
    const nf = G.camAt ? 1 : B.Scalar.MoveTowards(boomFade, want, 4 * dt);
    if (nf !== boomFade) { boomFade = nf; for (const c of SEC) { c.t.visibility = nf; c.col.visibility = nf; } }
  }
  function updateBuild(dt) {
    const onCr = ride === "cr", K = onCr ? kv : () => 0, L = onCr ? sticks.L : NO_STICK, R = onCr ? sticks.R : NO_STICK;   // 乗っていない時はレバーが効かない
    fadeBoom(dt); drawLoose(dt);
    // 左レバー: フックを 前後（遠く・近く）／左右。右レバー: 上げ下げ
    const fwd = L.y + K("KeyW", "KeyS"), side = L.x + K("KeyD", "KeyA"), lift = R.y + K("KeyI", "KeyK");
    const t = cr.tgt, hang = bd.hanging && bd.hanging.lifted ? bd.hanging.hang : bd.snap ? bd.snap.h.hang : 0, t0 = t.clone();   // 置いている間も吊りの長さは同じ（0 に戻すとブームが組み直しで動き、フックが 1.5m 流れた 評価 k5）
    const dx = t.x - cr.pos.x, dz = t.z - cr.pos.z, r = Math.max(3, Math.hypot(dx, dz));
    let ang = Math.atan2(dx, dz);
    const csp = CRANE_SPD();
    const nr = B.Scalar.Clamp(r + fwd * 5 * csp * dt, 5, 38);
    ang += side * 5 * csp * dt / nr;                          // 左右は「横に 5m/秒」になるように角度で動かす
    t.x = cr.pos.x + Math.sin(ang) * nr; t.z = cr.pos.z + Math.cos(ang) * nr;
    t.y = B.Scalar.Clamp(t.y + lift * 4 * csp * dt, 0.9 + hang, 45);
    if (bd.hanging && bd.hanging.holdT > 0) { bd.hanging.holdT -= dt; t.y = Math.min(t.y, t0.y); }   // 地切りで止めている間は上げない
    if (!bd.done) { bd.t += dt; bd.hookT += dt; }
    const tgtSpeed = B.Vector3.Distance(t, t0) / dt;      // 本人がフックを動かしている速さ
    // 関節は逆算した値へ、重機らしい速さで追いかける
    const s = solveCrane(t, hang);
    const slow = bd.hanging ? 0.8 : 1;
    const drive = (v, d, max, acc, gain) => approach(v, B.Scalar.Clamp(d * gain, -max, max), acc * dt);   // 目標までの差に比例した速さを、加速度の上限つきで追う
    cr.swV = drive(cr.swV || 0, angDiff(cr.swing, s.swing), 0.42 * csp * slow, 0.7 * csp, 1.6); cr.swing += cr.swV * dt;   // 旋回 最大 24 度/秒（1 周 15 秒）
    const swA = ((cr.swV || 0) - (cr.swVp || 0)) / Math.max(dt, 1e-3); cr.swVp = cr.swV || 0;
    cr.bendV = (cr.bendV || 0) + ((B.Scalar.Clamp(Math.abs(swA) * 0.012, 0, 0.008) - (cr.bend || 0)) * 60 - (cr.bendV || 0) * 5) * dt; cr.bend = (cr.bend || 0) + cr.bendV * dt;   // 旋回の加速・減速でブームがしなり、止まると 1 回揺れ戻す（ばね）
    cr.luV = drive(cr.luV || 0, s.luff - cr.luff, 0.3 * csp * slow, 0.6 * csp, 2); cr.luff += cr.luV * dt;
    cr.exV = drive(cr.exV || 0, s.ext - cr.ext, 1.5 * csp * slow, 2 * csp, 2); cr.ext += cr.exV * dt;   // 伸縮 最大 1.5m/秒（評価 k2: 2.5 は速い）
    applyCranePose();
    for (const n of [crRoot, crUpper, crBoomJ]) n.computeWorldMatrix(true);
    _tip.copyFrom(crTip.computeWorldMatrix(true).getTranslation());
    { const ex2 = t.x - _tip.x, ez2 = t.z - _tip.z, dd = Math.hypot(ex2, ez2), LE = 1.6; if (dd > LE) { t.x = _tip.x + ex2 * LE / dd; t.z = _tip.z + ez2 * LE / dd; } }   // 目標はフックの真上から 1.6m まで
    cr.wire = approach(cr.wire, B.Scalar.Clamp(_tip.y - t.y, ...CLIM.wire), 3.5 * dt);
    if (!tipInit) { _tipPrev.copyFrom(_tip); _tipVelPrev.setAll(0); tipInit = true; }
    // フックの揺れ（振り子）。小さめにして早く収まるようにした（揺れ止め）
    _tip.subtractToRef(_tipPrev, _tipVel).scaleInPlace(1 / dt);
    const ax = (_tipVel.x - _tipVelPrev.x) / dt, az = (_tipVel.z - _tipVelPrev.z) / dt;
    _tipPrev.copyFrom(_tip); _tipVelPrev.copyFrom(_tipVel);
    const g = 9.81 / Math.max(1, cr.wire);
    cr.swayV.x += (-g * cr.sway.x - ax * 0.35) * dt; cr.swayV.y += (-g * cr.sway.y - az * 0.35) * dt;
    // 2 かいめからは風: ときどき突風でフックが横に押される（同じ繰り返しにしないため 10-12 評価 b0）
    if (bd.floor >= 1 && !bd.done) {
      bd.windT -= dt;
      if (bd.windT <= 0) { bd.windT = (BSTAGES[bstage].wind ? 6 : 7) + Math.random() * 6; bd.gust = 1.2; bd.gustDir = Math.random() * 6.28; popup("💨 かぜだ！ ゆれに 気をつけて", "mile"); if (!playS("wind_gust", 0.7)) chime([12, 7], 0.09, 0.08); }
      if (bd.gust > 0) { bd.gust -= dt; const wk2 = BSTAGES[bstage].wind || 1, w = 2.2 * WIND_MUL() * wk2 * (wk2 > 1 ? 1 + bd.floor * 0.07 : 1) * Math.sin(Math.min(1, bd.gust) * Math.PI); cr.swayV.x += Math.cos(bd.gustDir) * w * dt; cr.swayV.y += Math.sin(bd.gustDir) * w * dt; }
    }
    cr.swayV.scaleInPlace(Math.max(0, 1 - 0.9 * dt));   // 2.6 では揺れがすぐ消えて見えなかった（評価 k1）
    cr.sway.addInPlace(cr.swayV.scale(dt));
    const sl = cr.sway.length(), smax = Math.min(1.2, cr.wire * 0.15); if (sl > smax) cr.sway.scaleInPlace(smax / sl);
    const hp = hookPos();
    if (bd.snap && bd.snap.drop) hp.y -= bd.snap.drop;   // 置いた後、フックを少し下げてワイヤーをゆるめる
    if (hp.y - hang < 0.9) hp.y = 0.9 + hang;
    // 置き場の建材の上では、鉤が建材の上面に当たって止まる（めり込まない）
    if (!bd.hanging && !bd.snap && bd.yard) {
      const y = bd.yard, top = y.rest.y + (y.p.kind === "柱" ? y.p.size[0] / 2 : y.p.size[1] / 2);
      if (Math.hypot(hp.x - y.at.x, hp.z - y.at.z) < 1.0 && hp.y - HOOK_DROP < top) hp.y = top + HOOK_DROP;
    }
    hook.position.copyFrom(hp);
    // ロープ 2 本: ブームの先からフックまで
    const off = new B.Vector3(Math.cos(cr.swing) * 0.13, 0, -Math.sin(cr.swing) * 0.13);
    setRope(wireM, _tip.add(off), hp.add(off).addInPlaceFromFloats(0, 0.4, 0));
    setRope(wireM2, _tip.subtract(off), hp.subtract(off).addInPlaceFromFloats(0, 0.4, 0));

    // 吊る: フックを置き場の建材のすぐ上まで下ろすと掛かる
    if (!bd.hanging && !bd.snap && bd.yard) {
      const y = bd.yard, top = y.rest.y + (y.p.kind === "柱" ? y.p.size[0] / 2 : y.p.size[1] / 2);
      if (Math.hypot(hp.x - y.at.x, hp.z - y.at.z) < (y.col ? 1.6 : 1.1) && hp.y - HOOK_DROP < top + 0.35) {   // 掛かる範囲: 柱 1.0→1.6m・平らな荷 0.6→1.1m・高さ 0.06→0.35m（10-13 本人「両方とも大きく」）。平らな荷の傾きは最大 1 度に抑えてある
        bd.hanging = y; bd.yard = null; bd.hookT = 0; y.lifted = false; y.bot = y.rest.add(new B.Vector3(-y.p.size[1] / 2, 0, 0));
        if (!playS("sling_hook", 0.8)) thud(0.3, 1200); chime([7], 0.1, 0.1); popup("かけた！ まきあげよう ↑", "load");
      }
    }
    bd.near = false;
    if (bd.hanging) {
      const h = bd.hanging;
      const wasLifted = h.lifted; hangPiece(h, hp, dt);
      if (h.lifted && !wasLifted && !h.liftedOnce) { h.liftedOnce = true; h.holdT = 0.35; thud(0.2, 900); popup("つった！", "load"); }   // 地切り: 少し浮いた所でいったん止める
      // 光る枠の近くまで運ぶとピタッとはまる。横は近いのに高さが合っていない時は枠が緑になって知らせる
      const d = Math.hypot(h.m.position.x - h.p.pos.x, h.m.position.z - h.p.pos.z), dy = h.m.position.y - h.p.pos.y;
      bd.near = d < SNAP.xz * SNAP_MUL(); bd.dist = d; bd.dy = dy;
      // 通り過ぎただけでははまらない。レバーを離して止めた時（またはほぼ真上でゆっくり）にはまる
      if (h.lifted && d < SNAP.xz * SNAP_MUL() && Math.abs(dy) < SNAP.y * SNAP_MUL() && (tgtSpeed < 0.3 || (d < 0.5 && Math.abs(dy) < 0.5 && tgtSpeed < 2.5))) {
        let pts = Math.max(40, Math.round(100 - d * 14 - Math.abs(dy) * 8));   // 25/15 では真上で止めても 77〜80 で「ぴったり」がほぼ出なかった（10-12 台本）
        const good = pts >= 85; bd.streak = good ? bd.streak + 1 : 0; if (good) bd.perfect++;
        if (bd.streak >= 2) pts += 20 * (bd.streak - 1);          // 続けてぴったりだと上乗せ
        const quick = bd.hookT < 9; if (quick) pts += 30;          // 吊ってから 9 秒以内に置けたら上乗せ
        bd.score += pts; bd.snap = { m: h.m, from: h.m.position.clone(), q: h.m.rotationQuaternion.clone(), to: h.p.pos, t: 0, good, h }; bd.hanging = null;
        popup((good ? "ぴったり！ +" : "はまった！ +") + pts + (bd.streak >= 2 ? `（${bd.streak}れんぞく）` : "") + (quick ? " ⚡はやい！" : ""), good ? "mid" : "");
      }
    }
    if (bd.snap) {
      const s2 = bd.snap, hb = new B.Vector3(hp.x, hp.y - HOOK_DROP, hp.z);
      cr.sway.scaleInPlace(Math.max(0, 1 - 6 * dt)); cr.swayV.scaleInPlace(Math.max(0, 1 - 6 * dt));   // 置いている間はフックの揺れを止める（揺れてフックが荷から離れ、ワイヤーが横に伸びた 評価 k5）
      const far = Math.hypot(hb.x - s2.to.x, hb.z - s2.to.z) > 0.8;
      if (s2.t < 1) {
        s2.t = Math.min(1, s2.t + dt / 0.9); const e = 1 - Math.pow(1 - s2.t, 3);   // 着地の手前ほどゆっくり（評価 k1: 0.35 秒で急に収まっていた）
        B.Vector3.LerpToRef(s2.from, s2.to, e, s2.m.position); B.Quaternion.SlerpToRef(s2.q, s2.h.p.q || B.Quaternion.Identity(), e, s2.m.rotationQuaternion);   // 屋根は傾けて はめる
        if (far) drawSlings(null); else drawSlings(s2.h, hb);
        cr.tgt.x += (s2.to.x - cr.tgt.x) * Math.min(1, dt * 6); cr.tgt.z += (s2.to.z - cr.tgt.z) * Math.min(1, dt * 6);   // はまる間はフックも枠の真上へ（荷だけ横へ動くとワイヤーが横に伸びた 評価 k5）
        if (s2.t >= 1) { s2.slack = 0; clang(s2.good ? 1 : 0.7); shake(s2.m === bd.placed[0] ? 0.1 : 0.15); dust(s2.to, s2.good ? 14 : 8); }
      } else {
        s2.slack += dt; s2.drop = Math.min(0.4, s2.slack * 1.2); s2.hx = s2.hx || hb.clone();
        if (Math.hypot(hb.x - s2.hx.x, hb.z - s2.hx.z) > 0.5 || Math.hypot(hb.x - s2.to.x, hb.z - s2.to.z) > 0.8) s2.slack = 0.55;   // フックが横へ動き出したら、すぐ外す（ワイヤーが横へ引き伸ばされて見えた 評価 k4）
        else drawSlings(s2.h, hb, s2.drop * 0.9);
        s2.m.position.y = s2.to.y - 0.03 * Math.sin(Math.min(1, s2.slack / 0.3) * Math.PI);   // 着地で 3cm 沈んで戻る
      }
      if (s2.t >= 1 && s2.slack >= 0.55) {
        drawSlings(null); for (const r of s2.h.rings || []) r.dispose(); bd.loose = { h: s2.h, t: 1.0 };   // 外したワイヤーはしばらく荷の上に寝かせる
        bd.placed.push(s2.m); bd.snap = null; bd.step++;
        if (bd.step >= bd.plan.length) {
          bd.floor++; bd.step = 0; bd.score += 150; chime([0, 4, 7, 12], 0.12); shake(0.25); popup(`${bd.floor}かい かんせい！ +150`, "big");
          const sites = BSTAGES[bstage].sites;
          if (bd.floor >= bd.goal && sites && bd.site < sites.length - 1) {   // おうち 3けん: 次の場所へ
            flagAt(SC.x, bd.goal * FLOOR_H + 2.4, SC.z);
            bd.site++; SC.x = sites[bd.site][0]; SC.z = sites[bd.site][1]; bd.floor = 0;
            popup(`🏠 ${bd.site}けん できた！ つぎの おうちへ`, "big"); chime([0, 7, 12, 16], 0.12);
          }
          if (bd.floor >= bd.goal) { buildDone(); return; }
          bd.plan = planFloor(bd.floor);
        }
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
      // 丸影: 高いほど薄く大きく
      const hl = bd.hanging, h1 = Math.max(0, bottom - gy), fade = B.Scalar.Clamp(1 - h1 / 30, 0.25, 1);
      if (hl) { const ex = hl.m.getBoundingInfo().boundingBox.extendSizeWorld; loadBlob.position.set(from.x, gy + 0.03, from.z); loadBlob.scaling.set(ex.x * 2.6 + h1 * 0.05, 1, ex.z * 2.6 + h1 * 0.05); loadBlob.setVis(fade); }
      loadBlob.setEnabled(!!hl);
      hookBlob.position.set(hp.x, gy + 0.025, hp.z); hookBlob.scaling.setAll(1.3 + h1 * 0.03); hookBlob.setVis(fade * 0.8);
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
    { const w = Math.min(1, Math.abs(fwd) + Math.abs(side) + Math.abs(lift));
      setLoop("exc_engine_loop", 0.22 + w * 0.12, 0.85 + w * 0.15, dt); setLoop("crane_winch_loop", w * 0.5, 0.9 + w * 0.2, dt);
      setLoop("exc_hydraulic_loop", 0, 1, dt); setLoop("exc_tracks_loop", 0, 1, dt); }
  }
  let mode = "demo";
  function updateBuildGoal() {
    const n = bd.plan.length, k = bd.floor * n + bd.step, all = bd.goal * n, pct = Math.round(k / all * 100);
    const nx = bd.plan[bd.step];
    $("gStage").textContent = `けんちく　${bd.goal}かいだてを たてよう`;
    $("gText").textContent = bd.done ? "🎉 " + BLD[bldType()] + " かんせい！" : !ride ? "🏗 クレーン車に もどって「のる」" : bd.hanging ? `🏗 ${nx.kind}を 光る わくの 上へ はこぼう` : `🪝 おきばの ${nx.kind}を つろう（右レバーを ↓）`;
    $("gBld").style.width = pct + "%"; $("gBldT").textContent = `たてた ${pct}%　（${bd.floor + (bd.done ? 0 : 1)}かいめ ${bd.step}/${n}）`;
    $("gTr").style.width = Math.min(100, bd.streak * 20) + "%"; $("gTrT").textContent = bd.streak ? `ぴったり ${bd.streak}れんぞく` : "ぴったりで おくと ボーナス";
    $("gScore").textContent = "★ " + bd.score;
  }
  // 決めた階数まで建てたら完成: 屋上に旗・紙吹雪・結果の札
  function flagAt(x, top, z) {
    const pole = B.MeshBuilder.CreateCylinder("flagPole", { diameter: 0.08, height: 3 }, scene); pole.position.set(x + 3.4, top + 1.5, z); pole.material = steel;
    const flag = B.MeshBuilder.CreatePlane("flag", { width: 1.6, height: 1.0 }, scene); flag.position.set(x + 4.2, top + 2.5, z);
    const fm = new B.StandardMaterial("flagM", scene); fm.diffuseColor = new B.Color3(1, 0.2, 0.15); fm.emissiveColor = new B.Color3(0.5, 0.08, 0.05); fm.backFaceCulling = false; flag.material = fm;
    scene.onBeforeRenderObservable.add(() => { flag.rotation.y = Math.sin(performance.now() / 300) * 0.25; });
  }
  function buildDone() {
    bd.done = true; if (bd.ghost) { bd.ghost.dispose(); bd.ghost = null; }
    const top = bd.goal * FLOOR_H + 0.3 + (bldType() === "house" ? 2.1 : 0);   // おうちは屋根の上
    flagAt(SC.x, top, bldType() === "house" ? SC.z : SC.z + 2.4);
    const st = BSTAGES[bstage], per = st.unit ? [80, 130] : [150, 240], n = bd.t <= st.floors * (st.sites ? 3 : 1) * per[0] ? 3 : bd.t <= st.floors * (st.sites ? 3 : 1) * per[1] ? 2 : 1;
    prog.build = prog.build || []; const first = !prog.build[bstage]; prog.build[bstage] = Math.max(prog.build[bstage] || 0, n); saveProg();
    const mm = Math.floor(bd.t / 60), ss = String(Math.floor(bd.t % 60)).padStart(2, "0");
    $("done").querySelector(".rT").textContent = BLD[bldType()] + " かんせい！";
    $("rStars").textContent = stars(n);
    const total = bd.placed.length;
    $("rInfo").textContent = `じかん ${mm}:${ss}　ぴったり ${bd.perfect}/${total}　とくてん ${bd.score}` + (first && BUILD_UPS[bstage] ? `\n🔓 パワーアップ: ${BUILD_UPS[bstage]}` : "");
    $("bNext").textContent = "つぎの ステージ ▶"; $("bNext").style.display = BSTAGES[bstage + 1] ? "" : "none"; $("bBuild").textContent = "もういちど 建てる"; $("bBuild").style.display = ""; $("done").style.display = "";
    $("hint").style.display = "none";
    confettiPS.emitter = new B.Vector3(SC.x, top + 4, SC.z); chime([0, 4, 7, 12, 7, 12, 16], 0.13, 0.2); confetti(); shake(0.3);
  }
  function enterBuild() {
    const BS = BSTAGES[bstage]; bd.site = 0; if (BS.sites) { SC.x = BS.sites[0][0]; SC.z = BS.sites[0][1]; }
    bd.goal = BS.floors; bd.t = 0; bd.streak = 0; bd.perfect = 0; bd.done = false; bd.score = 0; bd.windT = 4; BUILD_GOAL = bd.goal; bd.plan = planFloor(0);
    $("goal").style.display = ""; $("stages").style.display = "none";   // 建築でも左上に目標と進み具合
    mode = "build";
    clearDebris(); for (const c of [...bld.cells.values()]) removeCell(c); rebuildCellMesh();
    // ショベルは横へ片づけ、ダンプは帰す
    exSlide = null;
    ex.pos.set(13, 0, 2); ex.heading = -Math.PI / 2;   // 建てる面ではショベルは横に置いてあるだけ（乗れない）
    ex.swing = 0; ex.boom = -0.6; ex.stick = 1.6; ex.bucket = 1.5; applyPose(); syncColliders(exParts, true);
    craneHere = true; ride = "cr"; wkRoot.setEnabled(false);
    for (const m of truck.load) m.dispose(); truck.load.length = 0; truck.amount = 0; truck.state = "gone"; truck.z = -200; placeTruck(); syncColliders(truck.parts, true); truck.root.setEnabled(false);
    for (const n of crAll) n.setEnabled(true);
    cr.pos.set(0, 0, 3); cr.heading = 0; cr.sway.set(0, 0); cr.swayV.set(0, 0); tipInit = false;
    cr.tgt.set(YARD.x, 6, YARD.z);                           // 最初は置き場の真上。あとは「下げる」だけで吊れる
    const s = solveCrane(cr.tgt, 0); cr.swing = s.swing; cr.luff = s.luff; cr.ext = s.ext; cr.wire = s.wire;
    fp.parent = crSeat; fp.fov = 1.25; look.yaw = 0; look.pitch = -0.1; lookIdle = 9; tp.radius = BS.floors > 4 ? 44 : BS.sites ? 38 : 30; tp.beta = 1.05; tp.alpha = -Math.PI / 2 - 0.35;
    if (view === "fp") $("bView").onclick();   // 建築は外からが最初（運転席からだとブームと柱でフックが隠れた 10-12 評価 b0）
    $("done").style.display = "none"; $("pedals").style.display = "none"; $("hint").style.display = "";   // クレーンは止めたまま届くのでペダルは隠す
    craneLabels();
    nextPiece(); popup("けんちく スタート！ " + bd.goal + "かいだてを たてよう", "mile");
  }
  $("bBuild").onclick = () => { if (mode === "build") goStage("b", bstage); };   // もういちど 建てる
  $("bNext").onclick = () => { if (mode === "build") goStage("b", bstage + 1); else goStage("d", stage + 1); };
  $("bAgain").onclick = () => { $("done").style.display = "none"; showStages("ステージを えらぼう"); };

  // ================= 降りて歩く（10-14 本人「降りて歩けるように。乗り物に乗って動かす感じ」）=================
  // 後ろから作業員を見る。乗れるのはショベル（解体の間）とクレーン車（さら地の後・建築）。近くで「のる」、乗っていたら「おりる」
  let ride = "ex", craneHere = false, exSlide = null;   // ride: "ex" ショベル / "cr" クレーン車 / null 歩いている
  const NO_STICK = { x: 0, y: 0 };
  const wk = { pos: new B.Vector3(0, 0, 0), heading: 0, phase: 0, v: 0, camR: 7 };
  const wkRoot = new B.TransformNode("worker", scene);
  const wkM = { skin: mat("wkSkin", 0.86, 0.66, 0.5, 0.7), vest: mat("wkVest", 1, 0.42, 0.04, 0.6), stripe: mat("wkStripe", 0.85, 0.87, 0.85, 0.3), shirt: mat("wkShirt", 0.3, 0.45, 0.7, 0.8),
    pants: mat("wkPants", 0.16, 0.2, 0.32, 0.85), boot: mat("wkBoot", 0.14, 0.11, 0.08, 0.8), helmet: mat("wkHelmet", 1, 0.82, 0.08, 0.35) };
  const wkBox = (name, w, h, d, m, parent, x, y, z) => { const b = B.MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene); b.material = m; b.parent = parent; b.position.set(x, y, z); shadow.addShadowCaster(b); b.receiveShadows = true; b.isPickable = false; return b; };
  const wkJoint = (name, x, y, z) => { const n = new B.TransformNode(name, scene); n.parent = wkRoot; n.position.set(x, y, z); return n; };
  const hipL = wkJoint("hipL", -0.11, 0.9, 0), hipR = wkJoint("hipR", 0.11, 0.9, 0), shL = wkJoint("shL", -0.29, 1.46, 0), shR = wkJoint("shR", 0.29, 1.46, 0);
  for (const h of [hipL, hipR]) { wkBox("leg", 0.17, 0.8, 0.19, wkM.pants, h, 0, -0.42, 0); wkBox("boot", 0.19, 0.12, 0.3, wkM.boot, h, 0, -0.84, 0.05); }
  for (const h of [shL, shR]) { wkBox("arm", 0.13, 0.5, 0.14, wkM.shirt, h, 0, -0.26, 0); wkBox("hand", 0.11, 0.13, 0.12, wkM.skin, h, 0, -0.58, 0); }
  wkBox("hips", 0.4, 0.18, 0.24, wkM.pants, wkRoot, 0, 0.93, 0);
  wkBox("vest", 0.46, 0.56, 0.27, wkM.vest, wkRoot, 0, 1.25, 0);
  for (const y of [1.12, 1.3]) wkBox("stripe", 0.47, 0.04, 0.28, wkM.stripe, wkRoot, 0, y, 0);   // 反射テープ
  wkBox("neck", 0.12, 0.08, 0.12, wkM.skin, wkRoot, 0, 1.56, 0);
  { const head = B.MeshBuilder.CreateSphere("head", { diameter: 0.25, segments: 10 }, scene); head.material = wkM.skin; head.parent = wkRoot; head.position.set(0, 1.71, 0); shadow.addShadowCaster(head); head.isPickable = false;
    const hel = B.MeshBuilder.CreateSphere("helmet", { diameter: 0.31, segments: 10, slice: 0.5 }, scene); hel.material = wkM.helmet; hel.parent = wkRoot; hel.position.set(0, 1.75, 0); shadow.addShadowCaster(hel); hel.isPickable = false;
    for (const x of [-0.05, 0.05]) wkBox("eye", 0.035, 0.035, 0.02, wkM.boot, wkRoot, x, 1.73, 0.12);   // 目（向きが分かるように）
    const brim = B.MeshBuilder.CreateCylinder("brim", { diameter: 0.36, height: 0.025, tessellation: 18 }, scene); brim.material = wkM.helmet; brim.parent = wkRoot; brim.position.set(0, 1.75, 0.03); brim.scaling.z = 1.12; brim.isPickable = false; }
  wkRoot.setEnabled(false);
  // 歩いて通れない所: 建物の格子（低い所）・重機・ダンプ・仮囲い
  function walkBlocked(p) {
    if (cellsNear(p, 0.55, 0.55, 1.9)) return true;
    { const dx = p.x - ex.pos.x, dz = p.z - ex.pos.z, c = Math.cos(ex.heading), sn = Math.sin(ex.heading), lx = dx * c - dz * sn, lz = dx * sn + dz * c; if (Math.abs(lx) < 1.95 && Math.abs(lz) < 2.75) return true; }   // ショベル（キャタピラの外まで）
    if (craneHere) { const dx = p.x - cr.pos.x, dz = p.z - cr.pos.z, c = Math.cos(cr.heading), sn = Math.sin(cr.heading), lx = dx * c - dz * sn, lz = dx * sn + dz * c; if (Math.abs(lx) < 1.7 && Math.abs(lz) < 5.6) return true; }
    if (truck.root.isEnabled()) { const t = truck.root.position; if (Math.abs(t.x - p.x) < 1.6 && Math.abs(t.z - 0.6 - p.z) < 4.4) return true; }
    return p.x < AREA.x0 || p.x > AREA.x1 || p.z < AREA.z0 || p.z > AREA.z1;
  }
  function updateWalk(dt) {
    const L = sticks.L, R = sticks.R;
    const mx0 = B.Scalar.Clamp(L.x + kv("KeyD", "KeyA") + kv("ArrowRight", "ArrowLeft"), -1, 1), my0 = B.Scalar.Clamp(L.y + kv("KeyW", "KeyS") + kv("ArrowUp", "ArrowDown"), -1, 1);
    // 右レバーで見回す
    tp.alpha -= R.x * 1.8 * dt; tp.beta = B.Scalar.Clamp(tp.beta - R.y * 1.2 * dt, 0.5, 1.45);
    // カメラから見た前・右へ歩く
    const fx = -Math.cos(tp.alpha), fz = -Math.sin(tp.alpha), rx = fz, rz = -fx;
    let mx = fx * my0 + rx * mx0, mz = fz * my0 + rz * mx0; const m = Math.min(1, Math.hypot(mx, mz));
    const want = m * 3.4;   // 走る速さ（m/秒）
    wk.v += (want - wk.v) * Math.min(1, dt * 8);
    if (m > 0.05) {
      const h = Math.atan2(mx, mz); let dh = h - wk.heading; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
      wk.heading += dh * Math.min(1, dt * 10);
    }
    if (wk.v > 0.02) {
      const step = new B.Vector3(Math.sin(wk.heading), 0, Math.cos(wk.heading)).scale(wk.v * dt);
      const nx = wk.pos.add(new B.Vector3(step.x, 0, 0)); if (!walkBlocked(nx)) wk.pos.copyFrom(nx);   // 壁に沿って滑れるように x と z を分けて動かす
      const nz = wk.pos.add(new B.Vector3(0, 0, step.z)); if (!walkBlocked(nz)) wk.pos.copyFrom(nz);
      // 前へ歩いている間は、カメラがゆっくり背中側へ回り込む
      if (!lookPtr && my0 > 0.3) { const back = Math.atan2(-Math.cos(wk.heading), -Math.sin(wk.heading)); let da = back - tp.alpha; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI; tp.alpha += da * Math.min(1, dt * 1.2); }
    }
    // 歩く動き: 足と腕を逆に振る
    wk.phase += wk.v * dt * 3.2; const sw = Math.sin(wk.phase) * Math.min(1, wk.v / 2.5) * 0.7;
    hipL.rotation.x = sw; hipR.rotation.x = -sw; shL.rotation.x = -sw * 0.8; shR.rotation.x = sw * 0.8;
    wkRoot.position.set(wk.pos.x, Math.abs(Math.cos(wk.phase)) * 0.04 * Math.min(1, wk.v / 2.5), wk.pos.z); wkRoot.rotation.y = wk.heading;
    // カメラと作業員の間に重機・ダンプ・建物があれば、カメラを手前に寄せる（降りた直後にカメラが運転席の中に入った）
    if (dt > 0) {
      const tg = wk.pos.add(new B.Vector3(0, 1.4, 0)), dir = new B.Vector3(Math.cos(tp.alpha) * Math.sin(tp.beta), Math.cos(tp.beta), Math.sin(tp.alpha) * Math.sin(tp.beta));
      const hit = scene.pickWithRay(new B.Ray(tg, dir, wk.camR), m => m.isEnabled() && m.isVisible && camBlockers().has(m));
      const want = hit && hit.hit ? Math.max(2.4, hit.distance - 0.35) : wk.camR;   // 寄りすぎると顔しか見えない（1.2m で顔が画面いっぱいになった）
      tp.radius += (want - tp.radius) * Math.min(1, dt * (want < tp.radius ? 20 : 3));   // 寄る時は速く、戻る時はゆっくり
    }
  }
  let _camBl = null;
  function camBlockers() {   // カメラをさえぎる物（重機・ダンプ・クレーン・建物・組んだ建材）
    const sig = bd.placed.length + "/" + chunkGen;
    if (!_camBl || _camBl.n !== sig) {
      _camBl = new Set([...[...chunks.values()].map(c => c.mesh), ...scene.getTransformNodeByName("exRoot").getChildMeshes(), ...truck.root.getChildMeshes(), ...crRoot.getChildMeshes(), ...bd.placed]); _camBl.n = sig;
    }
    return _camBl;
  }
  // 近くの乗り物（歩いている時）
  function nearRide() {
    if (mode !== "build" && Math.hypot(wk.pos.x - ex.pos.x, wk.pos.z - ex.pos.z) < 3.8) return "ex";
    if (craneHere && Math.hypot(wk.pos.x - cr.pos.x, wk.pos.z - cr.pos.z) < 6.5) return "cr";
    return null;
  }
  function craneLabels() { $("labL").textContent = "フックを動かす ↑遠く ↓近く ←→左右"; $("labR").textContent = "↑ 上げる / ↓ 下げる"; }
  function getOff() {
    if (!ride) return;
    const onCr = ride === "cr", P = onCr ? cr.pos : ex.pos, h = onCr ? cr.heading : ex.heading;
    const left = new B.Vector3(-Math.cos(h), 0, Math.sin(h));   // 運転席のある左側へ降りる
    wk.pos.copyFrom(P.add(left.scale(onCr ? 3.2 : 2.6)));
    for (let k = 0; k < 8 && walkBlocked(wk.pos); k++) wk.pos.addInPlace(left.scale(0.6));
    wk.heading = Math.atan2(left.x, left.z); wk.v = 0;
    ride = null; wkRoot.setEnabled(true); updateWalk(0);
    for (const k in pedal) pedal[k] = 0; for (const st of Object.values(sticks)) releaseStick(st);
    if (view === "fp") { view = "tp"; scene.activeCamera = tp; $("bView").textContent = "外から"; }
    tp.radius = wk.camR; tp.beta = 1.25; tp.alpha = Math.atan2(left.z, left.x) + 0.6;   // 降りた所を少し前から（作業員と重機が両方見える）
    $("pedals").style.display = "none"; $("labL").textContent = "あるく"; $("labR").textContent = "見回す";
    playS("sling_hook", 0.4);
  }
  function getOn(v) {
    ride = v; wkRoot.setEnabled(false); for (const st of Object.values(sticks)) releaseStick(st);
    if (v === "cr") {
      if (mode !== "build") { enterBuild(); return; }   // さら地の後に初めて乗ったら建築が始まる
      fp.parent = crSeat; fp.fov = 1.25; tp.radius = 30; tp.beta = 1.05; tp.alpha = -Math.PI / 2 - 0.35; craneLabels();
    } else {
      fp.parent = seat; fp.fov = 1.15; tp.radius = 18; tp.beta = 1.1; tp.alpha = -ex.heading - Math.PI / 2;
      $("pedals").style.display = ""; setLabels();
    }
    look.yaw = 0; look.pitch = 0.12;
    playS("sling_hook", 0.4); thud(0.2, 300);
  }
  function updateRideBtn() {
    const b = $("bRide"); let t = "";
    if (ride) t = "おりる"; else { const n = nearRide(); if (n) t = n === "ex" ? "のる（ショベル）" : "のる（クレーン）"; }
    if (b.textContent !== t) b.textContent = t;
    const show = !!t && !(mode === "build" && bd.done); if ((b.style.display !== "none") !== show) b.style.display = show ? "" : "none";
    b.classList.toggle("on", !ride);
  }
  $("bRide").onclick = () => { wakeAudio(); if (ride) getOff(); else { const n = nearRide(); if (n) getOn(n); } };
  addEventListener("keydown", e => { if (e.code === "KeyE" || e.code === "Enter") $("bRide").onclick(); });
  // さら地になったら、クレーン車が来る（建てる所の手前。ショベルが邪魔なら横へずらす）
  function crArrive() {
    if (craneHere) return; craneHere = true;
    for (const n of crAll) n.setEnabled(true);
    cr.pos.set(0, 0, 3); cr.heading = 0; cr.sway.set(0, 0); cr.swayV.set(0, 0); tipInit = false;
    cr.tgt.set(YARD.x, 6, YARD.z); const s = solveCrane(cr.tgt, 0); cr.swing = s.swing; cr.luff = s.luff; cr.ext = s.ext; cr.wire = s.wire; applyCranePose();
    bd.plan = planFloor(0); bd.hanging = null; bd.yard = null; bd.snap = null;
    if (Math.abs(ex.pos.x) < 6.5 && ex.pos.z > -5 && ex.pos.z < 11) exSlide = { from: ex.pos.clone(), to: new B.Vector3(9.5, 0, ex.pos.z), t: 0 };
    dust(cr.pos.add(new B.Vector3(0, 0.6, 0)), 30); thud(0.4, 160);
    popup("🏗 クレーン車が きたよ！", "mile");
  }

  // ================= 毎フレーム =================
  let fpsAvg = 60, msAvg = 16, hudT = 0;
  scene.onBeforeRenderObservable.add(() => {
    const dt = G.fixedDt || Math.min(engine.getDeltaTime() / 1000, 0.05);   // 確かめる時は G.fixedDt で固定
    if (!ride) updateWalk(dt);
    if (mode === "build") { updateBuild(dt); frameCommon(dt); return; }
    if (craneHere) updateBuild(dt);   // さら地の後: 来たクレーン車は止まったまま（乗るまでレバーは効かない）
    if (exSlide) { exSlide.t = Math.min(1, exSlide.t + dt / 1.5); B.Vector3.LerpToRef(exSlide.from, exSlide.to, 1 - Math.pow(1 - exSlide.t, 3), ex.pos); if (exSlide.t >= 1) exSlide = null; }
    const onEx = ride === "ex", K = onEx ? kv : () => 0, L = onEx ? sticks.L : NO_STICK, R = onEx ? sticks.R : NO_STICK;   // 乗っていない時はレバーが効かない
    const sw = L.x + K("KeyD", "KeyA"), st = -L.y + K("KeyS", "KeyW"), bo = -R.y + K("KeyK", "KeyI"), bu = -R.x + K("KeyJ", "KeyL");
    const prev = [ex.boom, ex.stick, ex.bucket], low0 = bucketLowest();
    const pw = POW();
    ex.swing += sw * 0.85 * pw * dt;
    ex.stick = B.Scalar.Clamp(ex.stick + st * 0.7 * pw * dt, ...LIM.stick);
    ex.boom = B.Scalar.Clamp(ex.boom + bo * 0.45 * pw * dt, ...LIM.boom);
    ex.bucket = B.Scalar.Clamp(ex.bucket + bu * 1.2 * pw * dt, ...LIM.bucket);
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
    const want = B.Scalar.Clamp((onEx ? pedal.fwd - pedal.back : 0) + K("ArrowUp", "ArrowDown"), -1, 1) * (pedal.back && !pedal.fwd ? 2.0 : 3.2) * (prog.stars[0] ? 1.3 : 1);
    speed += (want - speed) * Math.min(1, dt * (want ? 2.5 : 4));
    if (Math.abs(speed) < 0.02 && !want) speed = 0;
    const wantT = B.Scalar.Clamp((onEx ? pedal.right - pedal.left : 0) + K("ArrowRight", "ArrowLeft"), -1, 1) * 0.7;
    turnRate += (wantT - turnRate) * Math.min(1, dt * 5);
    if (speed || Math.abs(turnRate) > 0.005) {
      ex.heading += turnRate * dt;
      const np = ex.pos.add(new B.Vector3(Math.sin(ex.heading), 0, Math.cos(ex.heading)).scale(speed * dt));
      if (!blockedAt(np)) ex.pos.copyFrom(np); else speed = 0;
      moving += Math.abs(speed) / 3.2 + Math.abs(turnRate);
    }
    applyPose(); syncColliders(exParts, false);
    if (eng) eng.o.frequency.value = 38 + Math.min(moving, 2) * 14;
    { const tr = Math.min(1, Math.abs(speed) / 3.2 + Math.abs(turnRate)), arm = Math.min(1, Math.max(0, moving - tr));
      setLoop("exc_engine_loop", 0.3 + Math.min(1, moving) * 0.2, 1 + Math.min(1, moving) * 0.3, dt);
      setLoop("exc_hydraulic_loop", arm * 0.45, 0.9 + arm * 0.2, dt); setLoop("exc_tracks_loop", tr * 0.5, 0.85 + tr * 0.3, dt); setLoop("crane_winch_loop", 0, 1, dt); }

    // バケットの先で削る（何か掴んでいる間は削らない＝運んでいる途中で壁を崩さない）
    // バケット全体と腕の先のどこかが壁に触れたら削る（止まっていても・何か掴んでいても）
    {
      const bm = bucketJ.getWorldMatrix(), sm = stickJ.getWorldMatrix(), { W, H, L } = BUCKET;
      for (const q of HIT_PTS_B) carveAt(B.Vector3.TransformCoordinates(q, bm), CARVE_R);
      for (const q of HIT_PTS_S) carveAt(B.Vector3.TransformCoordinates(q, sm), CARVE_R * 0.8);
    }
    updateHeld(dt); updateChain(dt); updateArrow(dt);
    calmDebris();
    // 削った後、少し置いてから「支えのない塊」を落とす（揺れの間）
    if (dirty) { collapseTimer += dt; if (collapseTimer > 0.25) {
      dirty = false; collapseTimer = 0;
      // 大きな建物: 1 階の壁が 45% より減ったら丸ごと沈む。75% で「ぐらぐら」の合図
      for (const b of [...dirtyB]) if (b.sink && b.cells.size) {
        const r = b.baseN / Math.max(1, b.base0);
        if (r < 0.45) sinkSet([...b.cells]);
        else if (r < 0.75 && !b.warned) { b.warned = true; popup("ぐらぐら…！ あと すこし！", "mid"); shake(0.5); }
      }
      const fl = floatingCells();
      if (fl.length > 900) sinkSet(fl);       // 大きすぎる塊は瓦礫にせず沈める
      else if (fl.length) { const c0 = fl[0].p.clone(), m = fl.length; collapse(fl); broke(m, c0, true); }
      rebuildCellMesh();
    } }
    updateGrab();
    updateTruck(dt);

    frameCommon(dt);
  });
  function frameCommon(dt) {
    // カメラ
    trauma = Math.max(0, trauma - dt * 1.6); const tr = trauma * trauma;
    fp.position.set((Math.random() - 0.5) * tr * 0.22, (Math.random() - 0.5) * tr * 0.22, 0);
    fp.rotation.set(look.pitch + (Math.random() - 0.5) * tr * 0.03, look.yaw + (Math.random() - 0.5) * tr * 0.03, (Math.random() - 0.5) * tr * 0.05);
    if (mode !== "build") { updateCombo(dt); playT += dt; }
    if (sinks.length) updateSinks(dt);
    if (fading.length) updateFading(dt);
    const camAt = G.camAt && G.camAt();   // 確かめ用: 撮る時だけ注目点を差し替える
    tp.target.copyFrom(camAt || (!ride ? wk.pos.add(new B.Vector3(0, 1.4, 0)) : ride === "cr" ? cr.pos.add(new B.Vector3(SC.x * 0.5, 6 + (mode === "build" ? Math.min(bd.floor, bd.goal - 1) * FLOOR_H * 0.6 : 0), 6)) : ex.pos.add(new B.Vector3(0, 2.5, 0))));
    updateRideBtn();

    // 数字
    const f = engine.getFps(); fpsAvg += (f - fpsAvg) * 0.05; msAvg += (engine.getDeltaTime() - msAvg) * 0.05;
    hudT += dt;
    if (hudT > 0.25) {
      hudT = 0;
      let awake = 0;
      // まち まるごと: 止まって 18 秒たった瓦礫（ダンプの近く以外）は消していく（いくら壊しても重くならないように）
      const free = STAGES[stage].free && mode !== "build", tpos = truck.root.position;
      for (let i = debris.length - 1; i >= 0; i--) {
        const d = debris[i]; if (!d.ag) continue; d.ag.body.getLinearVelocityToRef(_v);
        if (_v.lengthSquared() > 0.04) { awake++; d.rest = 0; }
        else if (free && !d.held && (d.rest = (d.rest || 0) + 0.25) > 18 && B.Vector3.DistanceSquared(d.m.position, tpos) > 49) { debris.splice(i, 1); fadeOut(d); }
      }
      if (STAGES[stage].wide && mode !== "build") {   // 影の範囲をショベル（歩いている時は人）の辺りへ（16m ごとに動かす）
        const at = ride ? ex.pos : wk.pos, cx = Math.round(at.x / 16) * 16, cz = Math.round(at.z / 16) * 16 + 8;
        if (cx !== sunC.x || cz !== sunC.z) { sunC.set(cx, 0, cz); sun.position = sunC.subtract(sun.direction.scale(SUN_D)); }
      }
      const pct = Math.round((1 - bld.cells.size / bld.total) * 100), sd = siteDebris();
      const tstate = { wait: "待っている", leave: "出発！", back: "戻ってくる" }[truck.state];
      if (mode === "build") {
        const nx = bd.plan[bd.step];
        updateBuildGoal();
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
      G.stats = { api, fps: fpsAvg, ms: msAvg, debris: debris.length, awake, cells: bld.cells.size, pct, site: sd, load: truck.amount, trips: truck.trips, sent: truck.sent, held, truck: truck.state };
      // さら地: ビルが残っておらず、範囲のがれきが 10 個以下
      updateGoal(pct, sd);
      if (!siteDone && finishAt >= 0 && playT >= finishAt) { siteDone = true; clearRest(); showResult(); }
      else if (!siteDone && STAGES[stage].free && pct >= 95) { siteDone = true; clearRest(); showResult(); }   // まち まるごと: ほとんど壊したら おしまい
      else if (!siteDone && bld.cells.size === 0 && sd <= CLEAR_LEFT) { siteDone = true; sweepRest(); showResult(); }   // 台数の前に拾う物が無くなった時の逃げ道
    }
  }

  // ---- 仕上げの画面処理 ----
  const pipe = new B.DefaultRenderingPipeline("pipe", !Q.has("nohdr") && !LITE, scene, Q.has("nopp") ? [] : [fp, tp]);
  pipe.imageProcessingEnabled = true;
  pipe.imageProcessing.toneMappingEnabled = true; pipe.imageProcessing.toneMappingType = B.ImageProcessingConfiguration.TONEMAPPING_ACES;
  pipe.imageProcessing.exposure = 1.0; pipe.imageProcessing.contrast = 1.28;
  pipe.imageProcessing.colorCurvesEnabled = true; pipe.imageProcessing.colorCurves = new B.ColorCurves(); pipe.imageProcessing.colorCurves.globalSaturation = -14;
  scene.environmentIntensity = 0.85;
  pipe.imageProcessing.vignetteEnabled = true; pipe.imageProcessing.vignetteWeight = 1.2;
  pipe.fxaaEnabled = true; pipe.samples = 1;
  pipe.bloomEnabled = true; pipe.bloomThreshold = 0.85; pipe.bloomWeight = 0.12; pipe.bloomKernel = 48;
  pipe.sharpenEnabled = true; pipe.sharpen.edgeAmount = 0.18;
  // ---- ステージごとの空気（10-13 本人「ステージごとに背景や地面の色を変えて」）----
  // 新しい写真は使わず、画面全体の色合い（色カーブ）・太陽の色と高さ・霧・地面の色で変える
  //   el: 太陽の高さ（度）／sun: 太陽の色／si: 強さ／hue・dens: 画面全体に掛ける色（色相と濃さ 0〜100）／sat: あざやかさ
  //   exp: 明るさ／fog: 遠くの霞の色／fogEnd: 霞で見えなくなる距離／ground: 地面に掛ける色／shade: 影の薄さ（0=真っ黒）
  const LOOKS = [
    { name: "はれ", bg: "construction_yard", el: 33.8, sun: [1, 0.96, 0.9], si: 2.1, hue: 0, dens: 0, sat: -14, exp: 1.0, fog: [0.6, 0.58, 0.55], fogEnd: 380, ground: [1, 1, 1], shade: 0.12 },
    { name: "ゆうがた", bg: "sunset_jhbcentral", bgRot: Math.PI, el: 16, sun: [1, 0.62, 0.36], si: 1.9, hue: 28, dens: 45, sat: -2, exp: 0.95, fog: [0.78, 0.55, 0.38], fogEnd: 320, ground: [1.1, 0.95, 0.8], shade: 0.2 },
    { name: "くもり", bg: "potsdamer_platz", bgRot: 0, el: 55, sun: [0.86, 0.9, 1], si: 0.8, hue: 215, dens: 24, sat: -42, exp: 0.93, fog: [0.56, 0.59, 0.63], fogEnd: 200, ground: [0.84, 0.88, 0.94], shade: 0.55 },
    { name: "あさ", bg: "stuttgart_suburbs", bgRot: 0, el: 24, sun: [1, 0.95, 0.8], si: 2.3, hue: 55, dens: 14, sat: 2, exp: 1.08, fog: [0.72, 0.74, 0.68], fogEnd: 380, ground: [0.78, 1.0, 0.66], shade: 0.15 }];
  const GROUND_MATS = ["groundM", "groundRingM", "gDirtM", "gMudM", "moundM"];
  function applyLook(i) {
    const L = LOOKS[i] || LOOKS[0], el = L.el * Math.PI / 180;
    // 周りぐるっとの背景写真（Poly Haven・CC0。地平線より下は地面の色で塗ってある。tools は scratchpad の make_bg.py と同じ手順 → context に記録）
    if (dome._bg !== L.bg) {   // 上下の向きは PhotoDome が最初に作る時と同じ（invertY = !_useDirectMapping。逆にすると空と地面が逆さになった）
      dome._bg = L.bg; const old = dome.photoTexture; dome.photoTexture = new B.Texture(AS + "hdri/" + L.bg + "_bg3.jpg", scene, true, !dome._useDirectMapping); if (old && old !== dome.photoTexture) old.dispose(); }
    dome.mesh.rotation.y = dome._rot0 + (L.bgRot || 0);   // 開けた方（夕焼け空・ビル街・遠くの町）が正面に来る向き（6 通り回して撮って選んだ）
    sun.direction.set(-Math.sin(SUN_AZ) * Math.cos(el), -Math.sin(el), -Math.cos(SUN_AZ) * Math.cos(el));
    sun.position = sunC.subtract(sun.direction.scale(SUN_D));
    sun.diffuse = new B.Color3(...L.sun); sun.intensity = L.si; shadow.darkness = L.shade;
    const ip = pipe.imageProcessing, cc = ip.colorCurves;
    cc.globalHue = L.hue; cc.globalDensity = L.dens; cc.globalSaturation = L.sat; ip.exposure = L.exp;
    scene.fogColor = new B.Color3(...L.fog); scene.fogEnd = L.fogEnd;
    for (const n of GROUND_MATS) {
      const m = scene.getMaterialByName(n); if (!m) continue;
      if (!m._baseCol) m._baseCol = (m.albedoColor || B.Color3.White()).clone();
      m.albedoColor = new B.Color3(m._baseCol.r * L.ground[0], m._baseCol.g * L.ground[1], m._baseCol.b * L.ground[2]);
    }
  }
  applyLook(Q.has("build") ? BSTAGES[bstage].look : (STAGES[stage].look ?? stage));
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
    const c = await B.SceneLoader.LoadAssetContainerAsync(AS + "models/" + name + "/", name + ".gltf", scene);
    return c;
  }
  // 仮囲い: 工事現場を 3m の白い波板で囲う（x ±24・z -14〜42）。手前の真ん中（|x|<6）は出入り口
  {
    const wall = (x0, z0, x1, z1) => {
      const len = Math.hypot(x1 - x0, z1 - z0), m = pbrTex("hoardM", "box_profile_metal_sheet", 1, [1, 1, 1], "hoard_diff.jpg");
      for (const t of [m.albedoTexture, m.bumpTexture, m.metallicTexture]) { t.uScale = len / 2.4; t.vScale = 1.25; }
      const b = B.MeshBuilder.CreateBox("hoard", { width: len, height: 3, depth: 0.06 }, scene);
      b.position.set((x0 + x1) / 2, 1.5, (z0 + z1) / 2); b.rotation.y = -Math.atan2(z1 - z0, x1 - x0); b.material = m; b.receiveShadows = true; b.isPickable = false; shadow.addShadowCaster(b); hoards.push(b);
      // 支柱
      for (let t = 0; t <= len; t += 3) { const q = B.MeshBuilder.CreateBox("hoardPost", { width: 0.06, height: 3.1, depth: 0.06 }, scene); q.position.set(x0 + (x1 - x0) * t / len, 1.55, z0 + (z1 - z0) * t / len); q.material = steel; q.isPickable = false; hoards.push(q); }
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
  if (Q.has("build")) enterBuild();   // ?build=N でクレーンの N 面
  else if (!Q.has("stage") && !Q.has("nostage")) showStages("ステージを えらぼう", false);
  $("msg").style.display = "none";
  engine.resize();   // WebGPU は作った時点で canvas の大きさを拾わないことがある（300×150 のままになった）
  engine.runRenderLoop(() => scene.render());
  addEventListener("resize", () => engine.resize());

  // ---- 見張り: iPad で「一瞬映ってすぐ灰色（ボタンだけ残る）」が出た（10-11）。PC では再現しないので、
  // 1 秒ごとに画面の 9 点を読んで、全部ほぼ同じ色（＝何も映っていない）なら段階的に軽くして立て直し、何をしたか画面に出す
  const watch = { t: 0, bad: 0, stage: 0, last: null, buf: new Uint8Array(4) };
  const camOk = () => { const p = fp.globalPosition; return isFinite(p.x) && isFinite(p.y) && isFinite(p.z); };
  engine.onEndFrameObservable.add(() => {
    if (G.fixedDt) return;
    // カメラ・重機の位置が数でなくなったら（NaN）、最後の正常な状態へ戻す
    if (!camOk() || !isFinite(ex.pos.x + ex.heading + ex.swing + ex.boom + ex.stick + ex.bucket + look.yaw + look.pitch + speed + turnRate)) {
      const L = watch.last;
      if (L) { ex.pos.copyFrom(L.pos); Object.assign(ex, { heading: L.heading, swing: L.swing, boom: L.boom, stick: L.stick, bucket: L.bucket }); }
      look.yaw = 0; look.pitch = 0.12; speed = 0; turnRate = 0;
      showErr("位置が壊れたので戻しました（NaN）[" + api + "]", true);
      return;
    }
    watch.last = { pos: ex.pos.clone(), heading: ex.heading, swing: ex.swing, boom: ex.boom, stick: ex.stick, bucket: ex.bucket };
    const now = performance.now(); if (now - watch.t < 1000 || api !== "WebGL2") return; watch.t = now;
    const gl = engine._gl; if (!gl) return;
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight; let mn = [255, 255, 255], mx = [0, 0, 0];
    for (const fx of [0.2, 0.5, 0.8]) for (const fy of [0.25, 0.5, 0.75]) {
      gl.readPixels(Math.floor(W * fx), Math.floor(H * fy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, watch.buf);
      for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], watch.buf[k]); mx[k] = Math.max(mx[k], watch.buf[k]); }
    }
    const flat = mx[0] - mn[0] < 16 && mx[1] - mn[1] < 16 && mx[2] - mn[2] < 16;   // 灰色だけの時でも周辺減光で 10 ほど差が出る
    G.watch = { flat, rgb: mx.join(","), stage: watch.stage };
    if (!flat) { watch.bad = 0; return; }
    if (++watch.bad < 3) return;
    watch.bad = 0; watch.stage++;
    const what = "何も映っていない [" + api + " 画面 " + W + "×" + H + " 色 " + mx.join(",") + "]";
    if (watch.stage === 1) { pipe.dispose(); showErr(what + " → 画面の仕上げ処理を外しました", true); }
    else if (watch.stage === 2) { setShadow(false); scene.getEngine().setHardwareScalingLevel(1.5); showErr(what + " → 影を消して解像度を下げました", true); }
    else if (watch.stage === 3) { dome.setEnabled(false); showErr(what + " → 背景の写真を外しました。この文を教えてください", true); }
  });

  // 確かめ用の口（Object.assign は get を値で写してしまうので、変わる値は関数にする）
  Object.assign(G, { carveAt, blds, sinks, chunks, planFloor, nextPiece, SC, getRide: () => ride, wk, nearRide, getOff, getOn, applyLook, sfxInfo: () => ({ n: Object.keys(sfx).length, ac: ac && ac.state, loops: Object.fromEntries(Object.entries(loops).map(([k, L]) => [k, +L.v.toFixed(2)])), len: Object.fromEntries(Object.entries(sfx).map(([k, b]) => [k, +b.duration.toFixed(2)])) }), playS, hook, crTip, tp, applyPose, bedCenter, isDone: () => siteDone, nFlying: () => flying.length, pipe, getScore: () => score, startStage, prog, showResult, getPlayT: () => playT, enterBuild, cr, bd, hookPos: () => hook.position.clone(), bucketJ, pedal, scene, engine, ex, bld, debris, truck, carveAt, reset, bucketLowest, spawnDebris, setShadow, sticks, bucketOpenUp,
    setView: v => { if (v !== view) $("bView").onclick(); },
    // 確かめ用: 窓が裏だと描画も物理も止まるので、1/60 秒ずつ手で進める。物理は経過時間でなく固定の刻みにする（経過 0 で止まっていた）
    testMode() { G.fixedDt = 1 / 60; scene.useConstantAnimationDeltaTime = true;   /* 粒（土けむり）も 1/60 秒ずつ進める */ plugin._useDeltaForWorldStep = false; scene.getPhysicsEngine().setTimeStep(1 / 60); G.step = n => { for (let i = 0; i < n; i++) scene.render(); }; } });
})().catch(e => {
  console.error(e); const m = $("msg"); m.style.display = "";
  // GPU が使えない状態（前に GPU のメモリ不足で止まった後、Safari がこのページの 3D を止めていることがある）かどうかも出す
  let lost = "?"; try { const g = document.querySelector("canvas").getContext("webgl2"); lost = g ? (g.isContextLost() ? "GPU停止中" : "GPU可") : "GPUなし"; } catch (_) {}
  m.textContent = "起動できませんでした: " + e.message + " [" + lost + "]" + (lost !== "GPU可" ? "\nこのタブを閉じて（スワイプで消して）、新しいタブで開き直してください" : "");
});
