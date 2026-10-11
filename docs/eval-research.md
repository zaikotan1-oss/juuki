# 重機シミュ（解体→積み込み→整地→クレーン建築）評価観点の調査
注意: 出典は検索で得た二次記事・レビューまとめ（Vaporlens等はAI要約）。一次資料（GDC講演・Swink本・Steam原文）は直接読めていない。
「数字の目安」は、出典に数字がある物は出典付き、無い物は「推測で裏付けがありませんが」と明記。

## 1. 評価観点（8個）

### 観点1 一撃の手応え（壊れる瞬間のjuice）
- 見る物: 1回壊す・崩す・落とす瞬間に、音・揺れ・粒・数字が同時に出るか。
- 大事な理由: juiceは「少ない入力で最大の出力」。ルールを変えずに手触りだけで楽しさが変わる。Teardownは破壊の音（ガラス・瓦礫）と物理が最大の褒められ点。
  出典: https://roblog.co.uk/2024/03/juicy-games/ ／ https://www.nme.com/reviews/game-reviews/teardown-review-smashing-3214653 ／ https://xboxaddict.com/Staff-Review/14920/Teardown.html
- 目安:
  - 崩れた瞬間に 音＋画面揺れ＋粒（粉塵/破片）＋数字（点数/金額）の4つのうち3つ以上が同時に出る（推測で裏付けがありませんが。juiceの定番要素は出典にあり、「3つ以上」は定石）。
  - 揺れ・フラッシュは50〜100ms、ヒットストップは重い当たりで50〜100ms（60fpsで3〜6フレーム）。揺れ振幅は強弱で2〜10px（出典: https://www.wayline.io/learn/game-feel/1 ／ https://uhiyama-lab.com/en/notes/unity/unity-game-feel-hit-feedback/ ※チュートリアル系の二次情報で標準ではない）。
  - 揺れは減衰させる。長すぎる固まりは「ハング」に見える。大きい揺れは酔う。

### 観点2 入りの速さ（最初の30秒・分かりやすさ）
- 見る物: 起動から最初の1回壊す/掘るまでの時間、文字なしで次にやる事が分かるか。
- 大事な理由: モバイルは最初の約30秒で掴めるかが勝負。「5秒テスト＝読まずに何をするか分かるか」が実用的。遊びながら教えるのが良い。
  出典: https://www.gamedeveloper.com/design/5-tips-for-creating-a-better-tutorial ／ https://developers.facebook.com/documentation/games/overview/best-practices ／ https://www.pocketgamer.biz/pgc-digital-how-to-enhance-the-first-time-user-experience
- 目安:
  - 起動→最初の破壊まで ≤30秒（出典の「30秒」）。操作開始→最初の壁が崩れる ≤10秒（推測で裏付けがありませんが）。
  - 画面の説明文は1画面あたり1〜2行、モーダル（止まる説明）は最初の3分で0〜1回（推測）。
  - 次の目標が常に画面に1つ出ている（矢印・光・色）。5秒テストに子どもが通る。
  - 長いログイン・登録・評価ポップアップが無い（出典: pocketgamer.biz）。

### 観点3 進み具合が見える（粒度の細かい進捗）
- 見る物: 「あとどれくらい」がパーツ単位・全体％で見えるか。
- 大事な理由: PowerWash Simulatorは部位ごとのメーターと常時％、部位完了ごとの小さな報酬音で「次の1個」を続けさせる。完了判定が甘い/厳しすぎると最後の満足が消えるのが叩かれ点。
  出典: https://kotaku.com/powerwash-sim-devs-on-making-cleaning-fun-advanced-cro-1847319502 ／ https://www.geeksundergrace.com/gaming/review-powerwash-simulator/ ／ https://gametyrant.com/news/powerwash-simulator-2-review-thats-pretty-clean
- 目安:
  - 常時表示の進捗％またはパーツ別メーター。パーツ完了の合図（音＋数字）が10〜30秒に1回（推測で裏付けがありませんが）。
  - 完了は「最後の1個を壊した瞬間」に出す（先に完了表示しない）。残り1〜2個の取り残しを探させない（取り残し表示/ヒント）。

### 観点4 1サイクルの長さとテンポ（無駄な間）
- 見る物: 掘る→積む→運ぶ→降ろす→評価、の1周の時間と、何もしない待ちの長さ。
- 大事な理由: Construction Simulator系の最多不満は「遅い・長い・単調な作業」。Instruments of Destructionは時間制限なしで「ストレス解消」と好評だが、キャンペーンの繰り返しミッションは不満。短いサイクルの達成が「作業ゲー」を止めさせない。
  出典: https://www.thexboxhub.com/construction-simulator-review/ ／ https://vaporlens.app/app/1273400/construction_simulator.md ／ https://vaporlens.app/app/1428100/instruments_of_destruction ／ https://foxdata.com/jp/blogs/why-are-simulator-games-so-popular-its-not-about-realism-its-about-relatability/
- 目安（いずれも推測で裏付けがありませんが、定石として）:
  - 1サイクル（掘る→積む→出発）60〜120秒、ステージ全体5〜10分（子ども向けモバイル）。
  - 操作が無い待ち（移動・読み込み・演出）が連続5秒を超えない。長い移動は早送り/ワープ。
  - 1ステージの中で「新しい事（道具・敵・地形）」が2〜3分ごとに1つ出る。

### 観点5 目的と達成感（終わりの形・結果発表）
- 見る物: 何のために壊す/建てるか、終わった時の見せ場。
- 大事な理由: Teardownは「目標は決まっているが手段は自由」＋脱出が達成感を作る。逆に目的が薄いとただの破壊は飽きる、との声もある。シミュレーターは「うまくやる満足」と「わざと大失敗する面白さ」の両方を満たすと良い。
  出典: https://checkpointgaming.net/reviews/2022/05/teardown-review-selective-limited-destruction/ ／ https://gamingfurever.com/news/reviews/teardown-xbox-review ／ https://vice.com/en/article/why-do-we-play-video-games-that-simulate-work
- 目安:
  - 各ステージに明確な1行目標（例「ビルを全部壊す」「トラックを満杯にする」）。
  - 終了時に結果画面（時間・％・★1〜3）。完成/更地/ビルが建った瞬間に5秒以上の見せ場（花火・音楽・カメラ引き）（推測）。
  - 目標達成の手段が2通り以上ある（自由度）。

### 観点6 進行と報酬（成長・アンロック）
- 見る物: 稼ぐ→強化→次が楽になる、が体感できるか。
- 大事な理由: PowerWashは報酬で道具を買い、後の仕事が速くなる成長感がある。重機は「バケット拡大・新アタッチメント・新重機」が定番。
  出典: https://www.geeksundergrace.com/gaming/review-powerwash-simulator/ ／ https://kotaku.com/powerwash-sim-devs-on-making-cleaning-fun-advanced-cro-1847319502
- 目安（推測で裏付けがありませんが）:
  - 1プレイ（10分）で必ず何か1つアンロック/強化できる。
  - 強化前後で同じ作業が目に見えて速くなる（例 ≥1.3倍）。
  - 通貨・数字は成果の瞬間に加算音と一緒に出る（数字はカウントアップ、出典: roblog.co.uk）。

### 観点7 物理と破壊の気持ちよさ・安定（壊れ方の納得感）
- 見る物: 崩れ方の自然さ、破片の量、物が飛ぶ/めり込む/暴れるバグ、処理落ち。
- 大事な理由: 重機シミュでの叩かれ点の筆頭が「物理のバグ（暴れる/ひっくり返る/引っかかる）」と「処理落ち」。Teardownも爆発多発で重くなる、物理が一貫しないという声。
  出典: https://techraptor.net/gaming/reviews/review-teardown ／ https://vaporlens.app/app/1118110/coal_mining_simulator ／ https://vaporlens.app/app/1428100/instruments_of_destruction
- 目安:
  - 破片多数の最悪の場面でも iPadで ≥30fps（理想60）。推測で裏付けがありませんが、モバイル定石。
  - 5分の通しプレイで「物が空に飛ぶ/地面を抜ける/詰まる」が0回。
  - 壊れ方は大→中→小の段階的に細かくなる（出典: IoDの「どんどん小さな瓦礫に」）。リアルすぎる必要はなく、過剰juice（岩が揺れる等の不自然さ）は避ける（出典: gamedeveloper.com Don't Juice It）。

### 観点8 子ども（9歳）が楽しめるか・飽きにくさ
- 見る物: 読み書きなしで遊べるか、失敗が優しいか、繰り返しても飽きない仕掛けがあるか。
- 大事な理由: 遊びながら教える・失敗を安全にする・1回数分で区切れる、がモバイル/子ども向けの基本（子ども専用の一次資料は今回見つからず）。反復でマンネリは全作の共通弱点（Teardown・PowerWash・IoD）。
  出典: https://developers.facebook.com/documentation/games/overview/best-practices ／ https://waytoomany.games/2022/05/17/review-teardown/ ／ https://www.geeksundergrace.com/gaming/review-powerwash-simulator/
- 目安（推測で裏付けがありませんが）:
  - 文字を読まなくても最初の3ステージをクリアできる（絵・アイコン・矢印）。
  - 失敗/ゲームオーバーが無い or 即やり直し（≤3秒）。時間制限は任意。
  - 同じ作業が続く連続時間 ≤3分で、次に変化（新しい地形・道具・演出）。2周目に別要素（ハイスコア、別目標）。
  - 子どもが説明なしで最初の5分遊んで「もう1回」と言うか（定性チェック）。

## 2. 名作が共通してやっている演出・仕掛け（17個）
1. 壊れた瞬間の多層フィードバック（音・揺れ・粒・数字）— https://roblog.co.uk/2024/03/juicy-games/
2. ヒットストップ（重い当たりで50〜100ms、当たった物だけ止める）— https://www.wayline.io/learn/game-feel/1
3. 揺れは減衰させ、強さを当たりの強さに比例（trauma^2方式）— 同上
4. 数字はカウントアップ、ポップアップで浮かせる— https://roblog.co.uk/2024/03/juicy-games/
5. 物の伸縮・つぶれ（スカッシュ&ストレッチ）で生き物感— 同上
6. 破片が段階的に細かくなる（大塊→瓦礫→粉）— https://vaporlens.app/app/1428100/instruments_of_destruction
7. 破壊音を素材別（ガラス、コンクリ、木）に分ける— https://www.xboxtavern.com/teardown-review/（Teardownは音が高評価）
8. 水が汚れを剥がす等の「見た目が即変わる」直接の見返り（掘った所が穴になる、壊した所が空く）— Kotaku PowerWash記事
9. パーツ別メーター＋全体％の常時表示— Kotaku/GeeksUnderGrace
10. パーツ完了ごとの小報酬＋チャリンの音— GeeksUnderGrace
11. 道具/ノズル等の購入でプレイが速くなる成長— 同上
12. 「目的は固定、手段は自由」のミッション設計（Teardown）— Checkpoint Gaming
13. 時間制限なし（または任意）で落ち着いて遊べる（IoDの好評点）— https://www.tech-gaming.com/instruments-of-destruction/
14. 自分で作る/選ぶ自由（IoDの乗り物作り、Teardownの道具選び）— Vaporlens IoD
15. 音と動作の「メディテーション的リズム」（シュワー音＋ディンの反復）— https://gametyrant.com/news/powerwash-simulator-2-review-thats-pretty-clean
16. 会話・メッセージなど軽いユーモアの小ご褒美（PowerWashの依頼人メッセージ）— GeeksUnderGrace
17. 遊びながら教える最初の導線、5秒テスト— Facebook Instant Games best-practices
18. 酔い対策（揺れ弱め、設定でオフ）— https://xboxaddict.com/Staff-Review/14920/Teardown.html ／ https://uhiyama-lab.com/en/notes/unity/unity-game-feel-hit-feedback/

## 3. Steamで重機/解体/作業シミュが叩かれがちな点
（出典多くはAI要約のVaporlens等と個別批評。原文確認は未）
- 物理のバグ: 暴れる、ひっくり返る、引っかかる（Coal Mining Simulator, Gold Mining Simulator）
- 反復・長い単調なミッション・遅いテンポ（Construction Simulator, IoDキャンペーン, PowerWash, Teardown）
- 操作が分かりにくい・乗り物ごとに違う（Construction Simulator, IoD）
- 処理落ち・安定性（Teardown, IoD, Construction Simulator）
- 目的が薄く「ただの練習場」（Demolish & Build 3 Excavator Playground は Mostly Negative。https://discord.com/game/demolish-build-3-excavator-playground-1236089950303424523 ）
- 序盤の長いガイドミッション（Construction Simulator）
- 完了判定が甘い/厳しい（PowerWash）
- 酔い、設定項目不足（Teardown）
- DLC/課金の不評（Construction Simulator）
- 破壊を続けても満足が薄れる（Teardown一部レビュー）
褒められる点: 破壊物理と音、ストレス解消、自由度、時間制限なし、細かい進捗の見え方。
