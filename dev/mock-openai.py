"""Мок OpenAI-совместимого API, воспроизводящий поведение Gemini:
   - часть моделей отдаёт 404 «no longer available to new users»;
   - часть — 400 «only supports text-to-speech»;
   - /quota/... — 429 (исчерпана квота), кроме модели с большим лимитом.

Нужен, чтобы проверять автоподбор и переключение по квоте без VPN.
"""
import json
import sys
import socketserver
import http.server

LOG_PATH = sys.argv[1] if len(sys.argv) > 1 else "mock-openai.log"

MODELS = [
    "models/gemini-3.8-flash",
    "models/gemini-3.5-flash-lite",
    "models/gemini-3.6-flash",
    "models/gemini-3.8-flash-tts",
    "models/text-embedding-004",
]

BAD_404 = {"gemini-2.5-flash"}
BAD_400 = {"gemini-3.8-flash-tts"}
# та, что выживает при исчерпанной квоте у остальных
SURVIVOR = "gemini-3.5-flash-lite"


def log(msg):
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(msg + "\n")


def geo_error():
    return {"error": {"code": 400, "message": "User location is not supported for the API use.",
                      "status": "FAILED_PRECONDITION"}}


def quota_error():
    return {"error": {"code": 429, "message": "Resource has been exhausted (e.g. check quota).",
                      "status": "RESOURCE_EXHAUSTED"}}


class Handler(http.server.BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/geo"):
            return self._json(400, geo_error())
        if self.path.startswith("/quota"):
            return self._json(200, {"object": "list", "data": [{"id": m, "object": "model"} for m in MODELS]})
        if self.path.rstrip("/").endswith("/models"):
            return self._json(200, {"object": "list", "data": [{"id": m, "object": "model"} for m in MODELS]})
        self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n) or b"{}"
        try:
            req = json.loads(raw)
        except Exception:
            return self._json(400, {"error": {"message": "invalid json"}})

        model = req.get("model", "")
        name = model.replace("models/", "")

        if self.path.startswith("/geo"):
            return self._json(400, geo_error())
        if self.path.startswith("/busy") and name != SURVIVOR:
            log("chat model=%s -> 503 busy" % model)
            return self._json(503, {"error": {
                "code": 503,
                "message": "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
                "status": "UNAVAILABLE"}})
        if self.path.startswith("/quota") and name != SURVIVOR:
            log("chat model=%s -> 429 quota" % model)
            return self._json(429, quota_error())

        try:
            _u = req["messages"][-1]["content"]
            payload = json.loads(_u.split("\n", 1)[1])
        except Exception:
            payload = []

        log("chat model=%s questions=%s" % (model, len(payload)))

        if name in BAD_404:
            return self._json(404, {"error": {
                "code": 404,
                "message": "This model " + model + " is no longer available to new users. "
                           "Please update your code to use a newer model.",
                "status": "NOT_FOUND"}})
        if name in BAD_400:
            return self._json(400, {"error": {
                "code": 400,
                "message": "This model only supports text-to-speech and cannot be used for chat.",
                "status": "INVALID_ARGUMENT"}})

        answers = [
            {
                "id": q["id"],
                "choices": [min(1, len(q["options"]) - 1)],
                "confidence": 0.9,
                "why": "мок-ответ от " + model,
            }
            for q in payload
        ]
        content = json.dumps({"answers": answers}, ensure_ascii=False)

        log("chat model=%s -> 200 OK (questions=%s)" % (model, len(payload)))
        self._json(200, {
            "id": "chatcmpl-mock",
            "object": "chat.completion",
            "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content},
                         "finish_reason": "stop"}],
        })

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    open(LOG_PATH, "w", encoding="utf-8").close()
    with Server(("127.0.0.1", 8137), Handler) as httpd:
        print("mock openai on http://127.0.0.1:8137/v1")
        httpd.serve_forever()
