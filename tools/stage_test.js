// 新しい壊すステージ（6〜9）の確かめ。全体を撮り、倒れる物は根元を削って倒れる途中と後を撮る
// 使い方: ページで読み込む → await ST.run(6, "t1")。絵は 127.0.0.1:8821 の受け口へ
(() => {
  const B = BABYLON, G = window.G, V = (x, y, z) => new B.Vector3(x, y, z);
  const ST = window.ST = { out: {} };
  const loadBot = () => new Promise(r => { if (window.BOT) return r(); const s = document.createElement("script"); s.src = "tools/bot.js?" + Date.now(); s.onload = r; document.head.appendChild(s); });
  const cam = (t, r, beta, alpha) => { G.camAt = () => t; G.tp.radius = r; G.tp.beta = beta; G.tp.alpha = alpha; };
  const VIEW = { 6: [V(0, 14, 19), 62, 1.3], 7: [V(0, 6, 18), 46, 1.15], 8: [V(0, 4, 30), 70, 1.0], 9: [V(-4, 14, 20), 66, 1.3] };
  ST.run = async (i, tag) => {
    G.testMode(); await loadBot(); BOT.scale = 1;
    G.startStage(i); G.setView("tp"); await BOT.step(20);
    const [t, r, b] = VIEW[i], snap = n => BOT.snap(`${tag}_st${i}_${n}.jpg`), o = ST.out[i] = { cells: G.bld.cells.size };
    cam(t, r, b, -Math.PI / 2 - 0.55); await BOT.step(3); await snap("a_all");
    const tops = G.blds.filter(x => x.topple);
    o.tops = tops.length;
    if (!tops.length) { G.camAt = null; return o; }
    const tb = tops[0], low = [...tb.cells].filter(c => c.y <= 4);
    for (const c of low) G.carveAt(c.p, 0.3);
    await BOT.step(30); o.sinks = G.sinks.length; o.top = G.sinks.some(q => q.top);
    await snap("b_tilt");
    await BOT.step(60); await snap("c_fall");
    await BOT.step(60); await snap("d_land");
    await BOT.step(180); await snap("e_after"); o.debris = G.debris.length; o.left = G.sinks.length;
    G.camAt = null; return o;
  };
})();
