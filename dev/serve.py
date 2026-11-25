"""Мини-сервер для e2e-проверки: отдаёт dev/ и специально тормозит /slow.png.

Нужен, чтобы headless-браузер не снимал DOM раньше, чем расширение
успеет сходить в модель и нарисовать бейджи.
"""
import http.server
import os
import socketserver
import threading
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
GIF = (
    b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00"
    b"\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if self.path.startswith("/slow.png"):
            time.sleep(20)
            self.send_response(200)
            self.send_header("Content-Type", "image/gif")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(GIF)))
            self.end_headers()
            self.wfile.write(GIF)
            return
        super().do_GET()

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("127.0.0.1", 8123), Handler) as httpd:
        print("serving", ROOT, "on http://127.0.0.1:8123")
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
