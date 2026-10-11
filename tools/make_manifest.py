# 読み込み画面の進捗バー用: 先に読む全ファイルと大きさの一覧（assets/manifest.json）を作る。
# 素材を足した・作り直した時はこれを実行する。写真素材を作り直したら TEX_V を 1 上げる（ブラウザの保存分を使わせない）
import json, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEX_V = 5
files = []
for top in ['vendor', 'assets']:
    for d, _, fs in os.walk(os.path.join(ROOT, top)):
        for f in sorted(fs):
            p = os.path.relpath(os.path.join(d, f), ROOT).replace(os.sep, '/')
            if p.endswith(('.md', 'manifest.json')): continue
            url = p + (f'?v={TEX_V}' if p.startswith('assets/tex/') else '')
            files.append([url, os.path.getsize(os.path.join(ROOT, p))])
json.dump({'texV': TEX_V, 'files': files}, open(os.path.join(ROOT, 'assets', 'manifest.json'), 'w'), separators=(',', ':'))
print(len(files), 'files', round(sum(s for _, s in files) / 1e6, 1), 'MB')
