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
CHAT_IMAGES = DATA / "chat-images"  # pictures the student attached to chat questions
SNAPS = HOME / "Pictures" / "SlideMate"
SLIDES = DATA / "Slides"      # the library of a new install: one folder per course (Settings → Library can add more)
for d in (DATA, WORK, CHATS, LECTURES, CHAT_IMAGES):
    d.mkdir(parents=True, exist_ok=True)

# Tools are looked up on a PATH that includes the usual install locations, because apps
# launched from Finder don't inherit your shell's PATH.
TOOLS = DATA / "tools"  # what SlideMate installs for itself (server/tools.py): Parakeet, ffmpeg, university connections
EXTRA_PATH = [str(TOOLS / "bin"), str(HOME / ".local/bin"), str(HOME / ".grok/bin"), "/opt/homebrew/bin", "/usr/local/bin", str(HOME / ".npm-global/bin"),
              str(HOME / ".bun/bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
ENV = {**os.environ, "PATH": ":".join(EXTRA_PATH + os.environ.get("PATH", "").split(":"))}


def which(name):
    return shutil.which(name, path=ENV["PATH"])


DEFAULTS = {
    "setup_done": False,
    "library_roots": [],            # folders that hold your courses (each sub-folder = one course)
    "provider": "codex",            # "claude" (Claude Code), "codex" (Codex CLI), "cursor" (Cursor CLI), "grok" (Grok CLI)
                                    # "antigravity" (Antigravity CLI) or "ollama" (a local model)
    "ai_plan": "",                  # "free" (only ChatGPT is offered) or "paid"; blank = worked out from the provider
    "claude_model": "sonnet",
    "claude_notes_model": "opus",
    "claude_effort": "",            # "" = default, or low / medium / high / xhigh / max
    "codex_model": "",              # blank = Codex default
    "codex_effort": "",             # "" = model default
    "cursor_model": "",             # blank = Cursor default (Auto); effort is part of Cursor's model names
    "grok_model": "",               # blank = Grok default
    "grok_effort": "",              # "" = model default
    "antigravity_model": "",        # blank = Antigravity default
    "antigravity_effort": "",       # "" = model default
    "ollama_model": "",             # blank = the first downloaded model that can see images
    "ipad_name": "",
    "rec_limit_min": 120,
    "fill_from_recordings": True,   # after a Pull, write notes for missed lectures from the university's recordings  # stop + save a lecture recording after this long (0 = no limit)
    "airdrop": True,
    "copy_to_clipboard": True,
    "write_markdown": True,         # also save chats / lecture notes as Markdown next to your slides
    "sync_command": "",             # optional, e.g. "blackboard-mcp sync"
    "sync_login_command": "",       # optional, run when sync exits with code 2 (sign-in needed)
    "archived": [],                 # course folders / files hidden under "Archived" (nothing moves on disk)
    "course_titles": {},            # course folder → display name (renames are display-only)
    "mcp_servers": {},              # MCP servers the tutor can use (see mcp.py)
    "sync_mcp": {"server": "", "tool": "", "login_tool": ""},  # optional: an MCP tool behind the Sync button
    "cards_auto": True,             # make flashcards when a lecture's notes are written
    "cards_from_chats": True,       # add cards for what you asked the tutor, once a revision session goes quiet
    "cards_new_per_day": 20,        # new flashcards introduced per day (all decks together)
    "cards_retention": 0.9,         # FSRS target: the chance you still remember a card when it comes up
    "cards_since": 0,               # when flashcards were first switched on (older lectures are made on request)
}


def load():
    cfg = dict(DEFAULTS)
    try:
        cfg.update(json.loads(CONFIG_PATH.read_text()))
    except Exception:
        pass
    if cfg["ai_plan"] not in ("free", "paid"):  # set up before the free/paid choice existed
        cfg["ai_plan"] = "free" if cfg["provider"] == "codex" else "paid"
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


def ensure_library():
    """Before setup is done and while no slides folder is chosen, use SlideMate's own Slides folder. It's outside
    Documents/Desktop, so macOS doesn't ask for folder access, and iCloud never offloads the PDFs."""
    cfg = load()
    if not cfg["library_roots"] and not cfg["setup_done"]:
        SLIDES.mkdir(parents=True, exist_ok=True)
        update({"library_roots": [str(SLIDES)]})


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
