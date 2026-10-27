# 確かめ用の絵の受け口（127.0.0.1:8821）。ページから POST された dataURL を保存する
# 使い方: python tools/recv.py <保存先フォルダ>。bot.js の BOT.snap が送ってくる
import base64, http.server, pathlib, sys

OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "shots")
OUT.mkdir(parents=True, exist_ok=True)


class H(http.server.BaseHTTPRequestHandler):
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        data = body.split(",", 1)[1] if body.startswith("data:") else body
        name = pathlib.Path(self.path.strip("/")).name or "shot.jpg"
        (OUT / name).write_bytes(base64.b64decode(data))
        self.send_response(200); self.cors(); self.end_headers(); self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", 8821), H).serve_forever()
