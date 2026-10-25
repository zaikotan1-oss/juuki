// ステージ選びの絵を撮る。こわす: TH.demo()（全部）。たてる: ?build=N で開いて TH.build(N)
// 絵は 127.0.0.1:8821 の受け口へ（th_d0.jpg / th_b0.jpg）。切り抜きと縮小は tools/thumbs_pack.py
(() => {
  const B = BABYLON, G = window.G, V = (x, y, z) => new B.Vector3(x, y, z);
  const TH = window.TH = {};
  const loadBot = () => new Promise(r => { if (window.BOT) return r(); const s = document.createElement("script"); s.src = "tools/bot.js?" + Date.now(); s.onload = r; document.head.appendChild(s); });
  const cam = (t, r, beta, alpha) => { G.camAt = () => t; G.tp.radius = r; G.tp.beta = beta; G.tp.alpha = alpha; };
  // 建物の箱に合わせて寄る（高い物は少し見上げ気味）
  const fit = (x0, x1, y1, z0, z1) => { const w = Math.max(x1 - x0, z1 - z0), h = y1; cam(V((x0 + x1) / 2, h * 0.45, (z0 + z1) / 2), Math.max(w * 1.05, h * (h > 40 ? 1.5 : 1.25)) + 8, h > w * 1.4 ? 1.38 : 1.12, -Math.PI / 2 - 0.6); };
  // 絵に要らない物（当てる目印・クレーン・吊り具・置き場の部材・枠）を隠す
  const hide = names => { for (const m of G.scene.meshes) if (names.includes(m.name)) { m.setEnabled(false); m.visibility = 0; } for (const t of G.scene.transformNodes) if (names.includes(t.name)) t.setEnabled(false); };
  const ready = async () => { await new Promise(r => setTimeout(r, 1500)); await BOT.step(10); };   // whenReadyAsync は裏の窓だと終わらない
  TH.demo = async (list) => {
    G.testMode(); await loadBot(); BOT.scale = 1;
    for (const i of list || [...Array(10).keys()]) {
      G.startStage(i); G.setView("tp"); await BOT.step(20);
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, y1 = 0;
      for (const c of G.bld.cells.values()) { x0 = Math.min(x0, c.p.x); x1 = Math.max(x1, c.p.x); z0 = Math.min(z0, c.p.z); z1 = Math.max(z1, c.p.z); y1 = Math.max(y1, c.p.y); }
      hide(["hitMk", "goalArrow"]); await ready();
      if (i === 5) cam(V(0, 2, 10), 70, 0.95, -Math.PI / 2 - 0.6);
      else if (i === 12) cam(V(0, 3, 22), 44, 0.9, -Math.PI / 2 - 0.35);   // ガソリンスタンドは見下ろして奥の売店も入れる
      else fit(x0, x1, y1, z0, z1);
      await BOT.step(4); await BOT.snap(`th_d${i}.jpg`);
    }
    G.camAt = null;
  };
  TH.build = async (n) => {
    G.testMode(); await loadBot(); BOT.scale = 1;
    G.setView("tp"); await BOT.step(20);
    const ms = G.previewBuilt();
    if (G.bd.ghost) G.bd.ghost.setEnabled(false); if (G.bd.yard) G.bd.yard.m.setEnabled(false);
    hide(["crane", "hook", "wire", "wire2", "mark", "markLine", "hookBlob", "crLuffB", "crLuffR", "goalArrow", "yardMk", "ymRing", "ymBeam"]); await ready();
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, y1 = 0;
    for (const m of ms) { m.computeWorldMatrix(true); const b = m.getBoundingInfo().boundingBox; x0 = Math.min(x0, b.minimumWorld.x); x1 = Math.max(x1, b.maximumWorld.x); z0 = Math.min(z0, b.minimumWorld.z); z1 = Math.max(z1, b.maximumWorld.z); y1 = Math.max(y1, b.maximumWorld.y); }
    fit(x0, x1, y1, z0, z1); await BOT.step(4); await BOT.snap(`th_b${n - 1}.jpg`);
    G.camAt = null;
  };
})();
