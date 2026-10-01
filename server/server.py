#!/usr/bin/env python3
"""SlideMate server: a local web app for studying lecture slides with an AI tutor that has the whole deck.

Standard library only (Python 3.9+). Listens on 127.0.0.1 only. Run it directly for development:
    python3 server/server.py          # then open http://127.0.0.1:8767
"""
import base64
import json
import os
import re
import subprocess
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import config
import lecture
import library as lib
import mcp
import providers

# ------------------------------------------------------------------ tutor sessions

SESSIONS = {}
SESSIONS_LOCK = threading.Lock()
USAGE = {}  # deck path → last context/plan usage of its tutor conversation


def get_session(path):
    prov = providers.current()
    model = providers.model_for("chat")
    key = (path, prov.name, model, providers.effort_for(), mcp.fingerprint())
    with SESSIONS_LOCK:
        for k in [k for k in SESSIONS if k[0] == path and k != key]:
            SESSIONS.pop(k).close()  # provider/model changed: start over
        if key not in SESSIONS:
            SESSIONS[key] = prov.session(path, model)
        return SESSIONS[key]


def tutor_context(path):
    """Lecture notes + earlier conversation, given to a fresh tutor session so it remembers."""
    parts = []
    notes = lecture.notes_context(path)
    if notes:
        parts.append("Notes from the actual lecture on this deck (what the lecturer said; use these to answer "
                     "questions about the lecture):\n\n" + notes)
    msgs = lib.load_chat(path)["messages"][-40:]
    if msgs:
        lines = [f"[slide {m.get('slide')}] {'Student' if m['role'] == 'user' else 'You'}: {m['text']}" for m in msgs]
        parts.append("Our earlier conversation about this deck (for continuity; don't repeat it):\n\n" + "\n\n".join(lines)[-60000:])
    return "\n\n---\n\n".join(parts)


# ------------------------------------------------------------------ send to iPad


def copy_image_to_clipboard(png_path):
    script = f'set the clipboard to (read (POSIX file "{png_path}") as «class PNGf»)'
    subprocess.run(["osascript", "-e", script], timeout=15, capture_output=True)


def _helper_status_file():
    return Path(tempfile.mktemp(prefix="airdrop-", suffix=".json", dir=config.WORK))


def airdrop(png_path, device):
    helper = config.helper_app()
    if not helper:
        return {"state": "failed", "error": "AirDrop helper not built (run scripts/build-app.sh)"}
    status = _helper_status_file()
    args = ["open", "-n", "-a", str(helper), "--args", str(png_path), "--status", str(status)]
    if device:
        args[6:6] = ["--device", device]
    subprocess.run(args, timeout=15)
    result = {}
    for _ in range(64):  # up to ~16s: the iPad can take a few seconds to show up
        time.sleep(0.25)
        try:
            result = json.loads(status.read_text())
        except Exception:
            continue
        if result.get("state") in ("clicked", "failed") or (result.get("state") == "panel" and not (device and result.get("trusted"))):
            break
    threading.Timer(90, lambda: status.unlink(missing_ok=True)).start()
    return result


def helper_trust(prompt=False):
    helper = config.helper_app()
    if not helper:
        return None
    status = _helper_status_file()
    subprocess.run(["open", "-n", "-a", str(helper), "--args", "--trust" if prompt else "--check", "--status", str(status)])
    for _ in range(20):
        time.sleep(0.2)
        try:
            return bool(json.loads(status.read_text()).get("trusted"))
        except Exception:
            pass
    return False


def pick_folder():
    """Native folder picker (works whether the UI runs in the Mac app or a browser)."""
    script = 'POSIX path of (choose folder with prompt "Choose the folder that holds your course folders")'
    p = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=600)
    return p.stdout.strip().rstrip("/") or None


def status():
    cfg = config.load()
    return {"providers": {n: p.status() for n, p in providers.PROVIDERS.items()}, "provider": cfg["provider"],
            "recording": lecture.tools_status(), "pdftools": bool(config.which("pdftotext")),
            "helper": bool(config.helper_app()), "data_dir": str(config.DATA)}


# ------------------------------------------------------------------ HTTP

MIME = {".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
        ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".png": "image/png", ".svg": "image/svg+xml",
        ".json": "application/json"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _api_ok(self):
        # A custom header forces a CORS preflight, so other websites can't call this local API.
        if self.headers.get("X-SlideMate") != "1":
            self._json({"error": "forbidden"}, 403)
            return False
        return True

    def do_OPTIONS(self):
        self.send_response(403)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---------------------------------------------------------------- GET
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        arg = lambda k: q.get(k, [""])[0]
        if u.path == "/api/health":
            return self._json({"ok": True, "app": "slidemate"})
        if u.path.startswith("/api/"):
            if not self._api_ok():
                return
            if u.path == "/api/pdf":
                p = arg("path")
                if not p.lower().endswith(".pdf") or not os.path.isfile(p):
                    return self._json({"error": "not found"}, 404)
                return self._file(Path(p), "application/pdf")
            if u.path == "/api/library":
                items = lib.scan()
                lib.classify_pending(items)
                ib = config.inbox()
                return self._json({"items": items, "classifying": lib.is_classifying(), "inbox": len(lib.inbox_files()),
                                   "sync": lib.sync_state(), "categories": lib.CATEGORIES,
                                   "paths": {"roots": [str(r) for r in config.roots()], "inbox": str(ib) if ib else "",
                                             "data": str(config.DATA), "snaps": str(config.SNAPS)}})
            if u.path == "/api/config":
                return self._json(config.public())
            if u.path == "/api/mcp/discover":
                have = config.load().get("mcp_servers") or {}
                return self._json({n: {"source": s["source"], "command": s.get("command") or s.get("url"),
                                       "env_keys": sorted((s.get("env") or {}).keys()), "added": n in have}
                                   for n, s in mcp.discover().items()})
            if u.path == "/api/models":
                return self._json(providers.catalogue())
            if u.path == "/api/usage":
                u_ = USAGE.get(arg("path")) or {}
                return self._json({**u_, "limits": providers.LIMITS.get(config.load()["provider"], u_.get("limits", []))})
            if u.path == "/api/status":
                return self._json(status())
            if u.path == "/api/trust":
                return self._json({"trusted": helper_trust(False)})
            if u.path == "/api/chat-history":
                return self._json(lib.load_chat(arg("path")))
            if u.path == "/api/lectures":
                return self._json(lecture.list_for_deck(arg("path")))
            if u.path == "/api/lecture":
                return self._json(lecture.get(arg("id")))
            if u.path == "/api/lecture/audio":
                return self._audio(lecture.audio_path(arg("id")))
            return self._json({"error": "unknown"}, 404)
        rel = "index.html" if u.path in ("/", "") else urllib.parse.unquote(u.path.lstrip("/"))
        f = (config.STATIC / rel).resolve()
        if not str(f).startswith(str(config.STATIC.resolve())) or not f.is_file():
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self._file(f, MIME.get(f.suffix, "application/octet-stream"), cache=False)

    def _file(self, f, ctype, cache=True):
        data = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if not cache:
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def _audio(self, f):
        if not f.exists():
            return self._json({"error": "no audio"}, 404)
        size = f.stat().st_size
        start, end = 0, size - 1
        m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if m:
            start = int(m.group(1) or 0)
            end = int(m.group(2)) if m.group(2) else size - 1
        end = min(end, size - 1)
        with open(f, "rb") as fh:
            fh.seek(start)
            data = fh.read(end - start + 1)
        self.send_response(206 if m else 200)
        self.send_header("Content-Type", "audio/mp4" if f.suffix == ".mp4" else "audio/webm")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(len(data)))
        if m:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        self.wfile.write(data)

    # ---------------------------------------------------------------- POST
    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if not self._api_ok():
            return
        if u.path == "/api/upload":
            return self._upload()
        if u.path == "/api/lecture/chunk":
            q = urllib.parse.parse_qs(u.query)
            ok = lecture.add_chunk(q["id"][0], int(q["seq"][0]), self._body())
            return self._json({"ok": ok}, 200 if ok else 409)
        body = json.loads(self._body() or b"{}")
        p = u.path
        if p == "/api/chat":
            return self._chat(body)
        if p == "/api/reset":
            with SESSIONS_LOCK:
                for k in [k for k in SESSIONS if k[0] == body.get("path")]:
                    SESSIONS.pop(k).close()
            if body.get("clear"):
                lib.clear_chat(body.get("path"))
            return self._json({"ok": True})
        if p == "/api/config":
            config.update(body)
            return self._json(config.public())
        if p == "/api/mcp/import":  # copies specs (incl. env) server-side, so secrets never touch the browser
            found = mcp.discover()
            for n in body.get("names", []):
                if n in found:
                    spec = {k: v for k, v in found[n].items() if k != "source"}
                    config.set_mcp(n, {**spec, "enabled": True, "tutor": True})
                    mcp.autoconfigure(n)  # learn its tools; a sync tool becomes the Pull button
            return self._json(config.public())
        if p == "/api/mcp/save":
            name = body.get("name", "")
            if not mcp.NAME_RE.match(name):
                return self._json({"error": "Use letters, numbers, - or _ for the name"}, 400)
            spec = {k: body[k] for k in ("command", "args", "url", "enabled", "tutor") if k in body}
            if "env" in body and isinstance(body["env"], dict):
                spec["env"] = body["env"]
            config.set_mcp(name, spec)
            if "command" in spec or "url" in spec:
                mcp.autoconfigure(name)
            return self._json(config.public())
        if p == "/api/mcp/remove":
            config.set_mcp(body.get("name", ""), None)
            if (config.load().get("sync_mcp") or {}).get("server") == body.get("name"):
                config.update({"sync_mcp": {"server": "", "tool": "", "login_tool": ""}})
            return self._json(config.public())
        if p == "/api/mcp/tools":
            try:
                return self._json(mcp.list_tools(body.get("name", "")))
            except Exception as e:
                return self._json({"error": str(e)[:400]})
        if p == "/api/pick-folder":
            return self._json({"path": pick_folder()})
        if p == "/api/login":
            return self._json({"ok": providers.open_login_terminal(body.get("provider", "claude"))})
        if p == "/api/library/set":
            lib.set_entry(body["path"], category=body.get("category"), title=body.get("title"))
            return self._json({"ok": True})
        if p == "/api/sync":
            lib.start_sync(login_first=bool(body.get("login")))
            return self._json(lib.sync_state())
        if p == "/api/sort-inbox":
            lib.sort_inbox()
            return self._json({"ok": True})
        if p == "/api/send":
            return self._send(body)
        if p == "/api/trust":
            return self._json({"trusted": helper_trust(True)})
        if p == "/api/reveal":
            target = os.path.expanduser(body.get("path", ""))
            if os.path.exists(target):
                subprocess.run(["open", target] if body.get("open") and os.path.isdir(target) else ["open", "-R", target])
            return self._json({"ok": os.path.exists(target)})
        if p == "/api/lecture/start":
            return self._json({"id": lecture.start(body["path"], body.get("ext", "webm"))})
        if p == "/api/lecture/events":
            lecture.add_events(body["id"], body.get("events", []))
            return self._json({"ok": True})
        if p == "/api/lecture/stop":
            lecture.stop(body["id"])
            return self._json({"ok": True})
        if p == "/api/lecture/import":
            return self._json({"id": lecture.import_transcript(body["path"], body.get("text", ""), body.get("date"))})
        if p == "/api/lecture/regenerate":
            lecture.regenerate(body["id"])
            return self._json({"ok": True})
        if p == "/api/lecture/delete":
            lecture.delete(body["id"])
            return self._json({"ok": True})
        return self._json({"error": "unknown"}, 404)

    def _upload(self):
        name = re.sub(r"[^\w.\- ()]+", "_", urllib.parse.unquote(self.headers.get("X-Filename") or "slides.pdf"))[:120]
        if not name.lower().endswith(".pdf"):
            name += ".pdf"
        data = self._body()
        if not data.startswith(b"%PDF"):
            return self._json({"error": "not a PDF"}, 400)
        ib = config.inbox()
        if not ib:
            return self._json({"error": "Choose a library folder in Settings first"}, 400)
        dest = ib / name
        dest.write_bytes(data)
        try:
            final = lib.sort_file(dest)
        except Exception as e:
            print("sort failed", e, flush=True)
            final = str(dest)
        return self._json({"path": final})

    def _chat(self, body):
        path = body.get("path", "")
        if not os.path.isfile(path):
            return self._json({"error": "no pdf"}, 400)
        sess = get_session(path)
        img = body.get("image") or ""
        img = img.split(",", 1)[1] if "," in img else img
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        question, page = body.get("question", "Explain this slide."), body.get("page", 1)
        user_msg = {"role": "user", "text": body.get("display") or question, "slide": page, "ts": time.time(), "snip": bool(body.get("snip"))}
        answer, gone = [], False
        for chunk in sess.ask(question, page, body.get("total", 1), img, tutor_context(path)):
            if isinstance(chunk, tuple):  # ("status", "Using blackboard › …") / ("usage", {...}): live only, not saved
                if chunk[0] == "usage":
                    USAGE[path] = chunk[1]
                msg = f"event: {chunk[0]}\ndata: {json.dumps(chunk[1])}\n\n"
            else:
                answer.append(chunk)
                msg = f"data: {json.dumps(chunk)}\n\n"
            if gone:
                continue
            try:
                self.wfile.write(msg.encode())
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                gone = True  # keep consuming so the answer still gets saved
        lib.append_chat(path, user_msg, {"role": "bot", "text": "".join(answer), "slide": page, "ts": time.time()})
        if not gone:
            try:
                self.wfile.write(b"event: done\ndata: {}\n\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _send(self, body):
        cfg = config.load()
        img = body.get("image", "")
        raw = base64.b64decode(img.split(",", 1)[1] if "," in img else img)
        config.SNAPS.mkdir(parents=True, exist_ok=True)
        stem = re.sub(r"[^\w\- ]+", "", body.get("name") or "slide")[:60].strip() or "slide"
        png = config.SNAPS / f"{stem} {time.strftime('%Y-%m-%d %H.%M.%S')}.png"
        png.write_bytes(raw)
        out = {"file": str(png), "clipboard": False, "airdrop": None}
        if cfg["copy_to_clipboard"]:
            copy_image_to_clipboard(str(png))
            out["clipboard"] = True
        if cfg["airdrop"] and body.get("airdrop", True):
            out["airdrop"] = airdrop(png, cfg["ipad_name"])
        return self._json(out)


def housekeeping():
    """Auto-file PDFs dropped into the Inbox and categorise new files."""
    n = 0
    while True:
        try:
            if config.load()["setup_done"]:
                if lib.inbox_files():
                    time.sleep(3)  # let Finder finish copying
                    lib.sort_inbox()
                if n % 20 == 0:
                    lib.classify_pending()
        except Exception as e:
            print("housekeeping", e, flush=True)
        n += 1
        time.sleep(30)


def main():
    threading.Thread(target=housekeeping, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", config.PORT), Handler)
    srv.daemon_threads = True
    print(f"SlideMate running on http://127.0.0.1:{config.PORT}  (data: {config.DATA})", flush=True)
    try:
        srv.serve_forever()
    finally:
        for s in SESSIONS.values():
            s.close()


if __name__ == "__main__":
    main()
