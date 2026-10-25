# ステージ選びの絵を仕上げる: tools/thumbs.js で撮った th_*.jpg を 320x240 に縮めて assets/thumbs/ へ
# 使い方: python tools/thumbs_pack.py <撮った絵のフォルダ>
import sys, pathlib
from PIL import Image

src = pathlib.Path(sys.argv[1])
out = pathlib.Path(__file__).resolve().parent.parent / "assets" / "thumbs"
out.mkdir(parents=True, exist_ok=True)
for f in sorted(src.glob("th_[db]*.jpg")):
    im = Image.open(f).convert("RGB").resize((320, 240), Image.LANCZOS)
    im.save(out / (f.stem[3:] + ".jpg"), quality=82, optimize=True)
    print(f.stem[3:], (out / (f.stem[3:] + ".jpg")).stat().st_size // 1024, "KB")
