"""Paths and settings. User data lives outside the app, in ~/Library/Application Support/SlideMate."""
import json
import os
import shutil
from pathlib import Path

HOME = Path.home()
APP_DIR = Path(__file__).resolve().parent
STATIC = APP_DIR / "static"
DATA = Path(os.environ.get("SLIDEMATE_DATA") or HOME / "Library" / "Application Support" / "SlideMate")
PORT = int(os.environ.get("SLIDEMATE_PORT") or 8767)
CONFIG_PATH = DATA / "config.json"
WORK = DATA / "work"          # scratch dir the AI CLIs run in (never your files)
CHATS = DATA / "chats"
LECTURES = DATA / "lectures"
SNAPS = HOME / "Pictures" / "SlideMate"
for d in (DATA, WORK, CHATS, LECTURES):
    d.mkdir(parents=True, exist_ok=True)

# Tools are looked up on a PATH that includes the usual install locations, because apps
# launched from Finder don't inherit your shell's PATH.
EXTRA_PATH = [str(HOME / ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", str(HOME / ".npm-global/bin"),
              str(HOME / ".bun/bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
ENV = {**os.environ, "PATH": ":".join(EXTRA_PATH + os.environ.get("PATH", "").split(":"))}


def which(name):
    return shutil.which(name, path=ENV["PATH"])


DEFAULTS = {
    "setup_done": False,
    "library_roots": [],            # folders that hold your courses (each sub-folder = one course)
    "provider": "claude",           # "claude" (Claude Code) or "codex" (Codex CLI / ChatGPT sign-in)
    "claude_model": "sonnet",
    "claude_notes_model": "opus",
    "codex_model": "",              # blank = Codex default
    "ipad_name": "",
    "airdrop": True,
    "copy_to_clipboard": True,
    "write_markdown": True,         # also save chats / lecture notes as Markdown next to your slides
    "sync_command": "",             # optional, e.g. "blackboard-mcp sync"
    "sync_login_command": "",       # optional, run when sync exits with code 2 (sign-in needed)
}


def load():
    cfg = dict(DEFAULTS)
    try:
        cfg.update(json.loads(CONFIG_PATH.read_text()))
    except Exception:
        pass
    return cfg


def save(cfg):
    tmp = CONFIG_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2))
    tmp.replace(CONFIG_PATH)


def update(changes):
    cfg = load()
    for k, v in changes.items():
        if k in DEFAULTS:
            cfg[k] = v
    save(cfg)
    return cfg


def roots():
    return [Path(os.path.expanduser(r)) for r in load()["library_roots"] if r]


def inbox():
    """Drop-zone folder: PDFs put here get filed into the right course."""
    rs = roots()
    if not rs:
        return None
    p = rs[0] / "_Inbox"
    p.mkdir(parents=True, exist_ok=True)
    return p


def helper_app():
    """The AirDrop helper: bundled inside SlideMate.app, or built locally by scripts/build-app.sh."""
    cands = [os.environ.get("SLIDEMATE_HELPER"), APP_DIR.parent / "Helpers" / "SlideMateAirDrop.app",
             APP_DIR.parent / "build" / "SlideMateAirDrop.app"]
    for c in cands:
        if c and Path(c).exists():
            return Path(c)
    return None
