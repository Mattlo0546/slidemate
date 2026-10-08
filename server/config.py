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
    "claude_effort": "",            # "" = default, or low / medium / high / xhigh / max
    "codex_model": "",              # blank = Codex default
    "codex_effort": "",             # "" = model default
    "ipad_name": "",
    "rec_limit_min": 120,  # stop + save a lecture recording after this long (0 = no limit)
    "airdrop": True,
    "copy_to_clipboard": True,
    "write_markdown": True,         # also save chats / lecture notes as Markdown next to your slides
    "sync_command": "",             # optional, e.g. "blackboard-mcp sync"
    "sync_login_command": "",       # optional, run when sync exits with code 2 (sign-in needed)
    "archived": [],                 # course folders / files hidden under "Archived" (nothing moves on disk)
    "course_titles": {},            # course folder → display name (renames are display-only)
    "mcp_servers": {},              # MCP servers the tutor can use (see mcp.py)
    "sync_mcp": {"server": "", "tool": "", "login_tool": ""},  # optional: an MCP tool behind the Sync button
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
    os.chmod(tmp, 0o600)  # may hold MCP server credentials
    tmp.replace(CONFIG_PATH)


def update(changes):
    cfg = load()
    for k, v in changes.items():
        if k in DEFAULTS and k != "mcp_servers":  # MCP servers change only via the /api/mcp/* endpoints
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


def public():
    """Config for the UI, with MCP env values (possible secrets) masked."""
    cfg = load()
    cfg["mcp_servers"] = {n: {**{k: v for k, v in s.items() if k not in ("env", "headers")},
                              "env_keys": sorted((s.get("env") or {}).keys())}
                          for n, s in (cfg.get("mcp_servers") or {}).items()}
    return cfg


def set_mcp(name, spec=None):
    cfg = load()
    srv = cfg.setdefault("mcp_servers", {})
    if spec is None:
        srv.pop(name, None)
    else:
        srv[name] = {**srv.get(name, {}), **spec}
    save(cfg)
    return cfg
