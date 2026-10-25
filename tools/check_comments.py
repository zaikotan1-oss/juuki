# 行の途中に足した // コメントが、後ろのコードを飲み込んでいないかを探す（10-25 までに 6 回やった）
# 使い方: python tools/check_comments.py [ファイル]   → 怪しい行を出す。何も出なければ OK（終了コード 0）
import re, sys, os
p = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'game.js')
CODE = re.compile(r'[A-Za-z_]\w*\.\w+\s*=[^=>]|[A-Za-z_]\w*\([^)]*\);')
bad = 0
for i, l in enumerate(open(p, encoding='utf-8', errors='replace'), 1):
    q = None
    k = -1
    j = 0
    while j < len(l) - 1:
        c = l[j]
        if q:
            if c == '\\':
                j += 2
                continue
            if c == q:
                q = None
        elif c in '"\'`':
            q = c
        elif l[j:j + 2] == '//' and (j == 0 or l[j - 1] != ':'):
            k = j
            break
        j += 1
    if k < 0:
        continue
    if CODE.search(l[k + 2:]):
        print(i, l.strip()[:170])
        bad += 1
print("怪しい行:", bad)
sys.exit(1 if bad else 0)
