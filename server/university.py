"""Connect your university's Moodle or Blackboard in one step (Settings → Your university, or the welcome screen).

Connecting installs that connection (tools.py), adds it as an MCP server with your site's address, makes it the
library's Pull button, opens the university sign-in window, then pulls your slides. No commands or JSON.
"""
import threading
from urllib.parse import urlparse

import config
import library as lib
import mcp
import tools

KINDS = {
    "moodle": {"label": "Moodle", "env": "MOODLE_BASE_URL"},
    "blackboard": {"label": "Blackboard", "env": "BB_BASE_URL"},
}
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
    out = {}
    for kind, k in KINDS.items():
        spec = _spec(kind) or {}
        managed = str(spec.get("command", "")).startswith(str(tools.BIN))
        out[kind] = {"label": k["label"], "connected": bool(spec),
                     "own_setup": bool(spec) and not managed,  # e.g. a server you added yourself under this name
                     "url": (spec.get("env") or {}).get(k["env"], ""),
                     **{x: v for x, v in (_jobs.get(kind) or {}).items() if x != "thread"}}
        inst = tools._jobs.get(kind) or {}
        if out[kind].get("step") == "Installing…" and inst.get("state") == "running":
            out[kind]["step"] = inst["step"]  # e.g. "Downloading the installer…"
    return out


def connect(kind, url):
    if kind not in KINDS:
        return {"error": "Unknown connection"}
    base = site(url)
    if not base:
        return {"error": f"Enter your university's {KINDS[kind]['label']} address, e.g. "
                         + ("moodle.lse.ac.uk" if kind == "moodle" else "learn.example.ac.uk")}
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
            config.set_mcp(kind, {"command": str(tools.BIN / tools.PACKAGES[kind]["exe"]), "args": ["serve"],
                                  "env": {KINDS[kind]["env"]: base}, "tutor": True})
            step("Checking the connection…")
            mcp.list_tools(kind)
            found = mcp.detect_sync(kind)
            if found:
                config.update({"sync_mcp": found})  # this is now the library's Pull button
            step(f"Sign in to {KINDS[kind]['label']} in the window that opened…")
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


def disconnect(kind):
    config.set_mcp(kind, None)
    if (config.load().get("sync_mcp") or {}).get("server") == kind:
        config.update({"sync_mcp": {"server": "", "tool": "", "login_tool": ""}})
    _jobs.pop(kind, None)
    return status()
