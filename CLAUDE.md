# 重機で建てる（juuki）

一人称で重機を乗り換えながら「ショベルでビルを壊す → ダンプに廃材を積む → ブルドーザーで整地 → クレーンで鉄骨・足場を組んで家を建てる」ゲーム。リアル寄り。見た目は最後に詰める。iPad（iPadOS 26 以上）で遊ぶのが目標。

- エンジン: Babylon.js 9.28 ＋ Havok（`vendor/` に同梱。CDN に頼らない）。WebGPU が使えれば使い、無ければ WebGL2（`?gl=1` で WebGL 強制）
- 本体: `index.html`（画面の枠）＋ `game.js`（全部）
- 遊ぶ: `あそぶ.bat`（http://localhost:8820）。公開は GitHub Pages（context/README.md の「公開」）
- 確かめ: ブラウザの窓が裏だと描画が止まるので、`G.scene.render()` を手で回して確かめる（`window.G` が確かめ用の口）
- 選んだ理由と調べた事: `C:\Users\zaiko\knowhow\html-game\tablet-3d-and-engine-choice.md`
- 再開する時は `context/README.md` を読む
