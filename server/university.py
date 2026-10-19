"""Connect your university's Canvas, Moodle, Blackboard or Google Classroom in one step (Settings → Your university,
or the welcome screen).

Connecting installs that connection (tools.py), adds it as an MCP server with your site's address, makes it the
library's Pull button, opens the sign-in window, then pulls your slides. No commands or JSON. Each connection's
permissions (the tutor may use it; it's the Pull button) can be switched afterwards.
"""
import json
import threading
from pathlib import Path
from urllib.parse import urlparse

import config
import library as lib
import mcp
import tools

KINDS = {
    "canvas": {"label": "Canvas", "env": "CANVAS_BASE_URL", "example": "canvas.ox.ac.uk"},
    "moodle": {"label": "Moodle", "env": "MOODLE_BASE_URL", "example": "moodle.ucl.ac.uk"},
    "blackboard": {"label": "Blackboard", "env": "BB_BASE_URL", "example": "bb.imperial.ac.uk"},
    "classroom": {"label": "Google Classroom", "env": None},  # no address: Google; needs your own OAuth client file
}
CLASSROOM_SECRET = Path.home() / ".config" / "classroom-mcp" / "client_secret.json"
_jobs = {}  # kind -> {"state": running|done|failed, "step": …, "error": …}


def site(url):
    """"moodle.lse.ac.uk/my/" → "https://moodle.lse.ac.uk"."""
    url = (url or "").strip()
    if not url:
        return ""
    if "://" not in url:
        url = "https://" + url
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}" if p.netloc and "." in p.netloc else ""


def _spec(kind):
    return (config.load().get("mcp_servers") or {}).get(kind)


def status():
    cfg = config.load()
    pull = (cfg.get("sync_mcp") or {}).get("server")
    out = {}
    for kind, k in KINDS.items():
        spec = _spec(kind) or {}
        managed = str(spec.get("command", "")).startswith(str(tools.BIN))
        out[kind] = {"label": k["label"], "connected": bool(spec),
                     "own_setup": bool(spec) and not managed,  # e.g. a server you added yourself under this name
                     "url": (spec.get("env") or {}).get(k["env"], "") if k["env"] else "",
                     "tutor": spec.get("tutor", True), "pull": bool(spec) and pull == kind,
                     "tools": spec.get("tools") or [],
                     **{x: v for x, v in (_jobs.get(kind) or {}).items() if x != "thread"}}
        inst = tools._jobs.get(kind) or {}
        if out[kind].get("step") == "Installing…" and inst.get("state") == "running":
            out[kind]["step"] = inst["step"]  # e.g. "Downloading the installer…"
    out["classroom"]["has_secret"] = CLASSROOM_SECRET.exists()
    return out


def save_classroom_secret(text):
    """Keep the Google OAuth client file (from Google Cloud Console) where classroom-mcp looks for it."""
    try:
        data = json.loads(text or "")
        client = data.get("installed") or data.get("web") or {}
    except (ValueError, AttributeError):
        client = {}
    if not (client.get("client_id") and client.get("client_secret")):
        return {"error": "That isn't a Google OAuth client file. In Google Cloud Console, create a client of type "
                         "Desktop app and download its JSON."}
    CLASSROOM_SECRET.parent.mkdir(parents=True, exist_ok=True)
    CLASSROOM_SECRET.write_text(json.dumps(data))
    CLASSROOM_SECRET.chmod(0o600)
    return status()["classroom"]


def _server_spec(kind, base):
    spec = {"command": str(tools.BIN / tools.PACKAGES[kind]["exe"]), "args": ["serve"], "tutor": True}
    if KINDS[kind]["env"]:
        spec["env"] = {KINDS[kind]["env"]: base}
    elif kind == "classroom" and config.roots():
        spec["env"] = {"CLASSROOM_DIR": str(config.roots()[0])}  # slides go straight into the library
    return spec


def connect(kind, url):
    if kind not in KINDS:
        return {"error": "Unknown connection"}
    label = KINDS[kind]["label"]
    base = site(url) if KINDS[kind]["env"] else ""
    if KINDS[kind]["env"] and not base:
        return {"error": f"Enter your university's {label} address, e.g. {KINDS[kind]['example']}"}
    if kind == "classroom" and not CLASSROOM_SECRET.exists():
        return {"error": "Choose your Google client file first (see the steps on the card)."}
    job = _jobs.get(kind)
    if job and job["state"] == "running":
        return status()[kind]
    job = _jobs[kind] = {"state": "running", "step": "Starting…"}

    def go():
        step = lambda s: job.update(step=s)  # noqa: E731
        try:
            step("Installing…")
            r = tools.install(kind, wait=True)
            if r["state"] != "done":
                raise RuntimeError(r.get("error") or "The install didn't finish.")
            config.set_mcp(kind, None)  # a fresh spec, not merged into an older one
            config.set_mcp(kind, _server_spec(kind, base))
            step("Checking the connection…")
            mcp.list_tools(kind)
            found = mcp.detect_sync(kind)
            if found:
                config.update({"sync_mcp": found})  # this is now the library's Pull button
            where = "Google" if kind == "classroom" else label
            step(f"Sign in to {where} in the window that opened…")
            log = []
            if not (found and found.get("login_tool") and mcp.run_login(kind, found["login_tool"], log.append)):
                raise RuntimeError("Sign-in didn't finish. " + (log[-1] if log else "") +
                                   " Press Connect to try again.")
            step("Signed in. Pulling your slides…")
            job.update(state="done", step="Connected")
            lib.start_sync()
        except Exception as e:  # noqa: BLE001 - shown on the card
            job.update(state="failed", error=str(e))
    job["thread"] = threading.Thread(target=go, daemon=True)
    job["thread"].start()
    return status()[kind]


def permissions(kind, tutor=None, pull=None):
    """What SlideMate may do with a connection: let the tutor call its tools; make it the library's Pull button."""
    if kind not in KINDS or not _spec(kind):
        return {"error": "Not connected"}
    if tutor is not None:
        config.set_mcp(kind, {"tutor": bool(tutor)})
    if pull is not None:
        cur = (config.load().get("sync_mcp") or {}).get("server")
        if pull:
            found = mcp.detect_sync(kind)
            if not found:
                return {"error": "This connection has no sync tool to pull with."}
            config.update({"sync_mcp": found, "sync_command": ""})
        elif cur == kind:
            config.update({"sync_mcp": {"server": "", "tool": "", "login_tool": ""}})
    return status()[kind]


def disconnect(kind):
    config.set_mcp(kind, None)
    if (config.load().get("sync_mcp") or {}).get("server") == kind:
        config.update({"sync_mcp": {"server": "", "tool": "", "login_tool": ""}})
    _jobs.pop(kind, None)
    return status()
