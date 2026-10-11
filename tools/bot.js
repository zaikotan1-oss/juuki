// 自動で遊ぶ台本（評価用）。ページで G.testMode() の後に読み込む。窓が裏でも 1/60 秒ずつ手で進める。
// 使い方: const s = document.createElement("script"); s.src = "tools/bot.js?" + Date.now(); document.head.appendChild(s);
//         await BOT.cycle()  など。BOT.log に出来事と時刻（秒）が溜まる
(() => {
  const B = BABYLON, G = window.G;
  const BOT = window.BOT = { scale: 2, n: 0, t: 0, log: [], shots: [] };
  const L = G.sticks.L, R = G.sticks.R;
  const clear = () => { L.x = L.y = R.x = R.y = 0; for (const k in G.pedal) G.pedal[k] = 0; };
  const st = () => G.stats || {};
  BOT.ev = (what) => { BOT.log.push({ t: +BOT.t.toFixed(2), what, cells: G.bld.cells.size, held: G.ex && st().held, load: G.truck.amount, debris: G.debris.length }); };
  // 1/60 秒ずつ進める。every 秒ごとに画面を撮る（name_連番.jpg）
  BOT.shotEvery = 0; BOT.shotName = ""; let shotT = 0, shotN = 0;
  BOT.snap = async (name) => {
    // 裏の窓では等倍の描画がとても遅い（1 コマ 180ms、半分なら 4ms）ので、普段は半分で回し、撮る時だけ等倍で 1 コマ描く
    G.engine.setHardwareScalingLevel(1); G.scene.render();
    const u = document.querySelector("canvas").toDataURL("image/jpeg", 0.85);
    G.engine.setHardwareScalingLevel(BOT.scale);
    await fetch("http://127.0.0.1:8821/" + name, { method: "POST", body: u }); BOT.shots.push(name);
  };
  BOT.step = async (n) => {
    for (let i = 0; i < n; i++) {
      if (BOT.paused) await BOT.hold();
      G.scene.render(); BOT.t += 1 / 60;
      if (++BOT.n % 10 === 0) await new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); });   // 裏の窓でも絞られない譲り方   // ページを固めない（確かめの呼び出しが届くように）
      if (BOT.shotEvery) { shotT += 1 / 60; if (shotT >= BOT.shotEvery) { shotT = 0; await BOT.snap(BOT.shotName + "_" + String(shotN++).padStart(3, "0") + ".jpg"); } }
    }
  };
  BOT.film = (name, every) => { BOT.shotName = name; BOT.shotEvery = every; shotN = 0; shotT = every; };
  BOT.cut = () => { BOT.shotEvery = 0; };
  // 腕を目標の姿勢へ（レバーを倒して動かす。人が操作するのと同じ速さ）
  BOT.pose = async (tgt, maxSec = 6) => {
    const ex = G.ex;
    for (let i = 0; i < maxSec * 60; i++) {
      const d = { swing: (tgt.swing ?? ex.swing) - ex.swing, stick: (tgt.stick ?? ex.stick) - ex.stick, boom: (tgt.boom ?? ex.boom) - ex.boom, bucket: (tgt.bucket ?? ex.bucket) - ex.bucket };
      const c = (v, k) => Math.max(-1, Math.min(1, v * k));
      L.x = c(d.swing, 4); L.y = -c(d.stick, 4); R.y = c(d.boom, 6); R.x = -c(d.bucket, 4);   // 向きは game.js の sw/st/bo/bu に合わせる
      R.y = -R.y;
      if (Math.abs(d.swing) < 0.02 && Math.abs(d.stick) < 0.03 && Math.abs(d.boom) < 0.02 && Math.abs(d.bucket) < 0.03) break;
      await BOT.step(1);
    }
    clear();
  };
  BOT.drive = async (sec, fwd = 1) => { G.pedal.fwd = fwd > 0 ? 1 : 0; G.pedal.back = fwd < 0 ? 1 : 0; await BOT.step(Math.round(sec * 60)); clear(); await BOT.step(30); };
  BOT.wait = (sec) => BOT.step(Math.round(sec * 60));
  // 1 回分: 壁を崩す → すくう → 左のダンプへ旋回 → あける → 戻る。出来事を BOT.log へ
  BOT.rec = (k) => BOT.ev(k);
  BOT.attack = async () => { await BOT.pose({ swing: 0, boom: -0.9 }, 4); await BOT.pose({ stick: 1.0, bucket: 0.4 }, 3); await BOT.pose({ boom: 0.3 }, 3); BOT.rec("壁を崩した"); };
  // すくう向きを毎回少しずらす（同じ所ばかりだと空振りになる）
  BOT.k = 0;
  BOT.scoop2 = async () => { const o = [0, -0.25, 0.25, -0.12, 0.12, 0][BOT.k++ % 6], st = [2.2, 2.5, 2.0][BOT.k % 3];
    await BOT.pose({ swing: o, boom: -0.5, stick: st, bucket: -0.3 }, 4); await BOT.pose({ boom: 0.45 }, 3); await BOT.pose({ stick: 0.9, bucket: 2.2 }, 4); BOT.rec("すくった"); };
  BOT.scoop = async () => { await BOT.pose({ boom: -0.5, stick: 2.2, bucket: -0.3 }, 3); await BOT.pose({ boom: 0.4 }, 3); await BOT.pose({ stick: 0.9, bucket: 2.2 }, 4); BOT.rec("すくった"); };
  BOT.dump = async () => { await BOT.pose({ boom: -0.8 }, 3); await BOT.pose({ swing: -Math.PI / 2 }, 5); await BOT.pose({ bucket: -0.9 }, 3); await BOT.wait(2.5); BOT.rec("ダンプへあけた"); await BOT.pose({ swing: 0, bucket: 0.6 }, 5); };
  // 画面に出た浮かぶ文字・目標の札も時刻つきで残す（canvas の写真には写らないため）
  BOT.pops = []; let lastGoal = "";
  new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) BOT.pops.push({ t: +BOT.t.toFixed(2), text: n.textContent }); }).observe(document.getElementById("pops"), { childList: true });
  BOT.goals = [];
  setInterval(() => { const g = document.getElementById("gText").textContent; if (g !== lastGoal) { lastGoal = g; BOT.goals.push({ t: +BOT.t.toFixed(2), text: g }); } }, 50);
  BOT.paused = false; BOT.hold = async () => { while (BOT.paused) await new Promise(r => setTimeout(r, 100)); };
  G.engine.setHardwareScalingLevel(BOT.scale);
  // ---- 賢い台本: 瓦礫の多い所を狙ってすくい、ダンプの方へ回してあける。届かなければ近づく。1 面を通して測る用 ----
  const ex = G.ex, flat = (v) => new B.Vector3(v.x, 0, v.z);
  const angTo = (p) => { const d = p.subtract(ex.pos); let a = Math.atan2(d.x, d.z) - ex.heading; while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  const dist = (p) => B.Vector3.Distance(flat(p), flat(ex.pos));
  // 腕の届く距離の表（ブームを下げた時、ステックごとの水平距離）
  BOT.reachTable = () => {
    const keep = [ex.swing, ex.boom, ex.stick, ex.bucket], t = [];
    for (let st = 0.35; st <= 2.6; st += 0.15) { ex.swing = 0; ex.boom = 0.35; ex.stick = st; ex.bucket = -0.2; G.applyPose(); G.bucketJ.computeWorldMatrix(true); t.push([st, dist(G.bucketJ.getAbsolutePosition())]); }
    [ex.swing, ex.boom, ex.stick, ex.bucket] = keep; G.applyPose(); BOT.RT = t; return t;
  };
  const stickFor = (r) => { let best = BOT.RT[0]; for (const e of BOT.RT) if (Math.abs(e[1] - r) < Math.abs(best[1] - r)) best = e; return best[0]; };
  const loose = () => G.debris.filter(d => !d.held && d.ag && d.m.position.y < 3);
  // 一番まとまっている瓦礫（まわり 1.5m の数が多い）を選ぶ。reachOnly なら届く物だけ
  BOT.pickPile = (reachOnly = true) => {
    const L = loose(), rmin = BOT.RT[BOT.RT.length - 1][1] + 0.3, rmax = BOT.RT[0][1] - 0.3; let best = null, bs = -1;
    for (const d of L) {
      const p = d.m.position, r = dist(p);
      if (reachOnly && (r < rmin || r > rmax)) continue;
      let n = 0; for (const o of L) if (B.Vector3.DistanceSquared(o.m.position, p) < 2.25) n++;
      if (reachOnly && n < 3) continue;
      const sc = n - (reachOnly ? 0 : r * 0.3); if (sc > bs) { bs = sc; best = p.clone(); }
    }
    return best;
  };
  BOT.nearestCell = () => { let best = null, bd = 1e9; for (const c of G.bld.cells.values()) { const d = dist(c.p); if (d < bd) { bd = d; best = c.p.clone(); } } return best; };
  // 狙った所の方へ向いて、want m まで近づく／下がる（ペダル）
  BOT.approach = async (p, want = 6) => {
    for (let k = 0; k < 600; k++) {
      const a = angTo(p), r = dist(p);
      G.pedal.left = a < -0.08 ? 1 : 0; G.pedal.right = a > 0.08 ? 1 : 0;
      G.pedal.fwd = Math.abs(a) < 0.5 && r > want + 0.6 ? 1 : 0; G.pedal.back = Math.abs(a) < 0.5 && r < want - 0.8 ? 1 : 0;
      if (Math.abs(a) < 0.1 && Math.abs(r - want) < 1.0) break;
      await BOT.step(1);
    }
    clear(); await BOT.step(20);
  };
  BOT.miss = 0;
  BOT.smartScoop = async (p) => {   // 人と同じく、すくう前に瓦礫の方へ向いて 5.6m まで寄る
    if (Math.abs(angTo(p)) > 0.5 || dist(p) < 4.5 || dist(p) > 7) { await BOT.pose({ boom: -0.8, swing: 0 }, 4); await BOT.approach(p, 5.6); }
    const st = stickFor(dist(p) + 0.5 + (BOT.miss % 3) * 0.4);
    await BOT.pose({ boom: -0.6 }, 2); await BOT.pose({ swing: angTo(p), stick: st, bucket: -0.4 }, 5);
    await BOT.pose({ boom: 0.45 }, 3);
    await BOT.pose({ stick: Math.max(0.35, st - 1.0), bucket: 2.2 }, 4); await BOT.step(15); if (!(G.stats.held > 0)) BOT.miss++; BOT.rec("すくった");
  };
  BOT.smartDump = async () => {
    while (G.truck.state !== "wait") await BOT.step(10);
    await BOT.pose({ boom: -0.8 }, 3);
    if (dist(G.bedCenter()) > 8.5) await BOT.approach(G.bedCenter(), 6.5);
    await BOT.pose({ swing: angTo(G.bedCenter()) }, 6); await BOT.pose({ bucket: -0.9 }, 3); await BOT.wait(1.2); BOT.rec("ダンプへあけた");
  };
  // 壁を崩す: その方へ回して、高さを変えながら腕を手前へ引いて掻く（高い所も低い所も当たる）
  BOT.smartHit = async (p) => {
    await BOT.pose({ boom: -1.0, bucket: 0.4 }, 3); await BOT.pose({ swing: angTo(p), stick: 0.4 }, 5);
    const boomFor = p.y > 4 ? [-1.0, -0.6] : p.y > 2 ? [-0.6, -0.2] : [-0.2, 0.3];
    for (const bo of boomFor) { await BOT.pose({ boom: bo, stick: 0.4 }, 3); await BOT.pose({ stick: 2.4 }, 4); }
    BOT.rec("壁を崩した");
  };
  // 1 面を通す。進まない時は別の側へ回る。maxSec で打ち切り
  BOT.playStage = async (maxSec = 600) => {
    BOT.reachTable(); const t0 = BOT.t; let stuck = 0, last = "";
    while (BOT.t - t0 < maxSec && !G.isDone()) {
      const sig = G.bld.cells.size + "/" + G.debris.length + "/" + G.truck.amount + "/" + G.truck.trips;
      stuck = sig === last ? stuck + 1 : 0; last = sig;
      await BOT.step(15);
      if (G.stats.held > 0) { await BOT.smartDump(); continue; }
      const pile = BOT.pickPile(true);
      if (pile && stuck < 2) { await BOT.smartScoop(pile); await BOT.step(15); if (G.stats.held > 0) await BOT.smartDump(); continue; }
      if (G.bld.cells.size) {
        let c = BOT.nearestCell();
        if (stuck >= 2) { const cs = [...G.bld.cells.values()]; c = cs[Math.floor(Math.random() * cs.length)].p.clone(); stuck = 0; await BOT.approach(c, 5.5); }
        else if (dist(c) > 7 || dist(c) < 3.5) await BOT.approach(c, 5.5);
        await BOT.smartHit(BOT.nearestCell()); continue;
      }
      const far = BOT.pickPile(false); if (!far) break;
      await BOT.approach(far, 5.5); const p2 = BOT.pickPile(true); if (p2) { await BOT.smartScoop(p2); await BOT.step(15); if (G.stats.held > 0) await BOT.smartDump(); }
    }
    BOT.rec(G.isDone() ? "さら地！" : "打ち切り"); return BOT.t - t0;
  };
  window.BOT_READY = true;
})();
