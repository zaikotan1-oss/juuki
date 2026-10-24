// 改善ループ用の撮影と計測（評価役に渡す材料）。ページで読み込むと CAP.run(場面, 回) が使える
// 使い方: ?stage=1 などで開く → script を読み込む → await CAP.run("s1", "r0")。結果は CAP.out、絵は 127.0.0.1:8821 の受け口へ
(() => {
  const B = BABYLON, G = window.G, V = (x, y, z) => new B.Vector3(x, y, z);
  const CAP = window.CAP = { out: {} };
  const loadBot = () => new Promise(r => { if (window.BOT) return r(); const s = document.createElement("script"); s.src = "tools/bot.js?" + Date.now(); s.onload = r; document.head.appendChild(s); });
  const cam = (t, r, beta, alpha) => { G.camAt = () => t; G.tp.radius = r; G.tp.beta = beta; G.tp.alpha = alpha; };
  const toTp = () => { if (document.getElementById("bView").textContent !== "運転席") document.getElementById("bView").click(); };
  const toFp = () => { if (document.getElementById("bView").textContent === "運転席") document.getElementById("bView").click(); };
  CAP.run = async (sc, round) => {
    G.testMode(); await loadBot(); BOT.scale = 1; G.engine.setHardwareScalingLevel(1);
    const snap = n => BOT.snap(`${round}_${sc}_${n}.jpg`), o = CAP.out[sc] = { t0: BOT.t };
    const t = performance.now(); await BOT.step(10); o.msPerFrame = +((performance.now() - t) / 10).toFixed(1);
    if (sc === "s1") {          // 1 面: 運転席から → 2 分半こわして運ぶ → 外から
      toFp(); await BOT.step(5); await snap("a_cab_start");
      await BOT.playStage(150);
      o.log = BOT.log.map(l => `${l.t} ${l.what} 残${l.cells} 破片${l.debris} 積${l.load}`); o.pops = BOT.pops.map(p => `${p.t} ${p.text}`); o.stats = G.stats;
      toFp(); await BOT.step(5); await snap("b_cab_mid");
      toTp(); G.camAt = null; await BOT.step(5); await snap("c_tp_mid");
      cam(V(0, 2, 12), 26, 1.05, -Math.PI / 2 - 0.7); await BOT.step(3); await snap("d_overview"); G.camAt = null;
    }
    if (sc === "s5") {          // 30 階: 遠景 → 1 階を削る → 沈む途中 → 後
      toTp(); cam(V(0, 30, 18), 100, 1.38, -Math.PI / 2 - 0.5); await BOT.step(20); await snap("a_tower");
      toFp(); G.camAt = null; await BOT.step(5); await snap("b_cab");
      const b = G.blds[0];
      for (let x = -6; x <= 6; x += 0.5) for (let y = 0.25; y < 2.6; y += 0.5) for (const z of [14.25, 21.75]) { if (b.baseN < b.base0 * 0.44) break; G.carveAt(V(x, y, z), 0.8); }
      for (let i = 0; i < 40 && !G.sinks.length; i++) await BOT.step(5);
      toTp(); cam(V(0, 25, 18), 95, 1.38, -Math.PI / 2 - 0.4); await BOT.step(150); await snap("c_sinking");
      while (G.sinks.length) await BOT.step(30);
      await BOT.step(90); cam(V(0, 2, 16), 34, 1.12, -Math.PI / 2 - 0.3); await BOT.step(3); await snap("d_after"); G.camAt = null;
      o.debris = G.debris.length; o.sinkSec = null;
    }
    if (sc === "s6") {          // まち: 上から全体 → 運転席
      toTp(); cam(V(0, 0, 20), 110, 0.95, -Math.PI / 2 - 0.3); await BOT.step(10); await snap("a_town");
      cam(V(-4, 4, 14), 30, 1.2, -Math.PI / 2 - 0.2); await BOT.step(3); await snap("b_street");
      toFp(); G.camAt = null; await BOT.step(5); await snap("c_cab");
      o.cells = G.bld.cells.size;
    }
    if (sc === "b1") {          // クレーン 1 面: 最初 → 4 個置く → 外から
      toTp(); G.camAt = null; await BOT.step(5); await snap("a_start");
      const t0 = BOT.t; const per = [];
      for (let i = 0; i < 4; i++) { const a = BOT.t; await BOT.placeOne(); per.push(+(BOT.t - a).toFixed(1)); if (i === 1) await snap("b_hanging_or_after"); }
      o.secPerPiece = per; o.log = BOT.log.map(l => `${l.t} ${l.what}`); o.pops = BOT.pops.map(p => `${p.t} ${p.text}`);
      await snap("c_after4"); toFp(); await BOT.step(5); await snap("d_cab"); toTp();
    }
    return o;
  };
})();
