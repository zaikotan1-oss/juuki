# 素材の出どころ

- 写真素材（assets/tex）・HDRI（assets/hdri）・3D モデル（assets/models）: [Poly Haven](https://polyhaven.com/)（CC0。表記不要だが記録として）
  - tex: gravel_ground_01, dry_ground_rocks, muddy_tracks, brown_mud_dry, dirty_concrete, concrete_floor_02, concrete_debris, metal_plate, box_profile_metal_sheet
  - hdri: construction_yard（背景の jpg はこの HDRI から作った。bg3 は地平線より下を地面の色へ溶かした版）
  - models: concrete_road_barrier, concrete_road_barrier_02, barrel_03, wooden_crate_01, plastic_crate_01, metal_jerrycan
- 作り変えた画像: hoard_diff.jpg（box_profile_metal_sheet を白く）、dirty_concrete_soft_diff.jpg（しみを薄く）

## 効果音（assets/sfx/）
- 自前で生成した音（音作りのセッション・bgm-pipeline、2026-10-13）。一覧と中身は assets/sfx/README.md と sfx.json

## ステージ 2〜4 の背景写真（assets/hdri/*_bg3.jpg・assets/lite/hdri/*_bg3.jpg）
- Poly Haven（CC0）: sunset_jhbcentral（ゆうがた）・potsdamer_platz（くもり）・stuttgart_suburbs（あさ）。https://polyhaven.com/
- 2048×1024 の正距円筒の画像を取り、地平線より下を地面の色 (118,102,79) で塗った（今の construction_yard_bg3 と同じ作り）。軽い版は 1024×512
