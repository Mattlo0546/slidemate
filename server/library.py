"""The library: your PDFs organised as course → category → week, plus inbox filing, sync and chat storage.

Layout convention: each sub-folder of a library folder is a course. Anything inside it (any depth) belongs to
that course. Categories (Lectures / Labs / Readings …) are worked out by the AI once and cached; files are never
moved, except PDFs you drop into the Inbox, which get filed into the right course.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
from datetime import date
from pathlib import Path

import config
import providers

LIB_PATH = config.DATA / "library.json"
CATEGORIES = ["Lectures", "Labs", "Seminar readings", "Readings", "Exercises", "Assessment", "Course info", "Other"]
SKIP_DIRS = {"_Inbox", "SlideMate Chats", "Lectures (SlideMate)"}
_lock = threading.RLock()


def _load(path, default):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return default


def _save(path, obj):
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, ensure_ascii=False))
    tmp.replace(path)


def split_course(name):
    """'PHIL20069 Philosophy of AI' → ('PHIL20069', 'Philosophy of AI'). Codes are optional."""
    m = re.match(r"([A-Z]{2,6}\s?\d{3,6}[A-Z]?)\s*[-–:]?\s+(.*)", name)
    return (m.group(1), m.group(2)) if m else ("", name)


def week_of(rel):
    m = re.search(r"(?:^|[/\s_-])(?:week|wk|w)\s*0*(\d{1,2})(?:\D|$)", str(rel), re.I)
    return int(m.group(1)) if m else None


def course_dirs():
    out = []
    for root in config.roots():
        if root.exists():
            out += [p for p in sorted(root.iterdir()) if p.is_dir() and not p.name.startswith((".", "_")) and p.name not in SKIP_DIRS]
    return out


def _pdfs(folder):
    for p in folder.rglob("*.pdf"):
        if any(part.startswith(".") or part in SKIP_DIRS for part in p.relative_to(folder).parts[:-1]):
            continue
        yield p


def scan():
    """Every PDF with its course, category, week and display title."""
    with _lock:
        lib = _load(LIB_PATH, {})
    items = []
    for cdir in course_dirs():
        code, cname = split_course(cdir.name)
        for p in _pdfs(cdir):
            sp = str(p)
            e = lib.get(sp, {})
            rel = p.relative_to(cdir)
            items.append({"path": sp, "name": p.name, "title": e.get("title") or p.stem.replace("_", " "),
                          "course": cdir.name, "code": code, "courseName": cname, "category": e.get("category"),
                          "week": e.get("week") if e.get("week") is not None else week_of(rel),
                          "mtime": p.stat().st_mtime, "manual": e.get("source") == "manual"})
    for root in config.roots():  # PDFs sitting directly in a library folder
        if root.exists():
            for p in sorted(root.glob("*.pdf")):
                items.append({"path": str(p), "name": p.name, "title": p.stem, "course": "Unsorted", "code": "",
                              "courseName": "Unsorted", "category": "Files", "week": None,
                              "mtime": p.stat().st_mtime, "manual": False})
    for it in items:
        it["hasChat"] = chat_file(it["path"]).exists()
    return items


# ------------------------------------------------------------------ classification

_classifying = threading.Event()


def is_classifying():
    return _classifying.is_set()


def classify_pending(items=None):
    """Give every uncategorised file a category (one AI call per course). Runs in the background."""
    if _classifying.is_set():
        return
    items = items if items is not None else scan()
    pending = [i for i in items if i["category"] is None]
    if not pending:
        return
    _classifying.set()

    def run():
        try:
            by_course = {}
            for i in pending:
                by_course.setdefault(i["course"], []).append(i)
            for course, its in by_course.items():
                for chunk in range(0, len(its), 60):
                    _classify(course, its[chunk:chunk + 60])
        finally:
            _classifying.clear()
    threading.Thread(target=run, daemon=True).start()


def _course_dir(course):
    return next((d for d in course_dirs() if d.name == course), None)


def _course_context(course):
    """Small text files in the course folder (schedules, notes) help tell lectures from labs."""
    d = _course_dir(course)
    if not d:
        return ""
    ctx = []
    files = sorted(list(d.rglob("*.md")) + list(d.rglob("*.txt")), key=lambda f: ("sched" not in f.name.lower(), str(f)))
    for f in files[:12]:
        if any(part in SKIP_DIRS for part in f.parts):
            continue
        try:
            ctx.append(f"## {f.relative_to(d)}\n{f.read_text(errors='ignore')[:2500]}")
        except Exception:
            pass
    return "\n\n".join(ctx)[:25000]


def _classify(course, its):
    d = _course_dir(course)
    files = [{"id": n, "path_in_course": str(Path(i["path"]).relative_to(d)) if d else i["name"], "week_guess": i["week"],
              "first_page": providers.first_page_text(i["path"])} for n, i in enumerate(its)]
    prompt = f"""Sort a university student's course files into categories for a study app.
Course folder: {course}

Context files from the course folder (may be empty):
{_course_context(course)}

Files:
{json.dumps(files, ensure_ascii=False, indent=1)}

Categories: "Lectures" (lecture slides/notes), "Labs" (lab/practical/workshop material), "Seminar readings",
"Readings" (papers/chapters/other reading), "Exercises" (problem sheets/exercises/solutions),
"Assessment" (coursework briefs, past papers), "Course info" (handbooks, syllabi, schedules), "Other".
Use folder names, the context files and each first page to decide. Also give a short clean display title
(no week prefix, no file extension) and the teaching week as an integer if you can tell (else null).

Answer ONLY with JSON: {{"files": [{{"id": 0, "category": "...", "title": "...", "week": 1}}]}}"""
    try:
        res = providers.current().oneshot_json(prompt)
    except Exception as e:
        print("classify failed", course, e, flush=True)
        res = {"files": []}
    got = {r.get("id"): r for r in res.get("files", []) if isinstance(r, dict)}
    with _lock:
        lib = _load(LIB_PATH, {})
        for n, i in enumerate(its):
            r = got.get(n, {})
            e = lib.get(i["path"], {})
            if e.get("source") == "manual":
                continue
            wk = r.get("week") if isinstance(r.get("week"), int) else i["week"]
            lib[i["path"]] = {**e, "category": r.get("category") if r.get("category") in CATEGORIES else "Other",
                              "title": (r.get("title") or i["title"])[:120], "week": wk, "source": "auto"}
        _save(LIB_PATH, lib)


def set_entry(path, **fields):
    with _lock:
        lib = _load(LIB_PATH, {})
        e = lib.get(path, {})
        e.update({k: v for k, v in fields.items() if v is not None})
        e["source"] = "manual"
        lib[path] = e
        _save(LIB_PATH, lib)


# ------------------------------------------------------------------ optional sync command

_sync = {"running": False, "log": [], "result": None, "last": None}


LOGIN_HINT = re.compile(r"not signed in|sign[- ]?in|log ?in|session (has )?expired|unauthori[sz]ed|401", re.I)


def _sync_mcp():
    m = config.load().get("sync_mcp") or {}
    return m if m.get("server") and m.get("tool") else None


def sync_state():
    cfg = config.load()
    m = _sync_mcp()
    return {"configured": bool(cfg["sync_command"].strip() or m),
            "has_login": bool(cfg["sync_login_command"].strip() or (m and m.get("login_tool"))),
            "via": f"{m['server']} › {m['tool']}" if m else (cfg["sync_command"].strip() or None),
            "label": f"Pull from {m['server'].replace('-', ' ').replace('_', ' ').title()}" if m else "Sync now",
            "running": _sync["running"], "result": _sync["result"], "last": _sync["last"], "log": _sync["log"][-8:]}


def _run_cmd(cmd, timeout):
    p = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=config.ENV)
    t0 = time.time()
    for line in p.stdout:
        _sync["log"].append(line.rstrip())
        if time.time() - t0 > timeout:
            p.kill()
            break
    return p.wait()


def start_sync(login_first=False):
    cfg = config.load()
    m = _sync_mcp()
    if _sync["running"] or not (cfg["sync_command"].strip() or m):
        return
    _sync.update(running=True, log=[], result=None)

    def run():
        try:
            if m:  # pull through an MCP tool (e.g. blackboard › bb_sync)
                import mcp
                log = _sync["log"].append
                if login_first and m.get("login_tool") and not mcp.run_login(m["server"], m["login_tool"], log):
                    _sync["result"] = "login_failed"
                    return
                result = mcp.run_sync(m["server"], m["tool"], log)
                if result == "login_required" and m.get("login_tool") and not login_first:
                    # Expired session: try the server's sign-in tool once (often refreshes silently), then retry.
                    if mcp.run_login(m["server"], m["login_tool"], log):
                        result = mcp.run_sync(m["server"], m["tool"], log)
                _sync["result"] = result
                _sync["last"] = time.time()
                if result == "ok":
                    classify_pending()
                return
            if login_first and cfg["sync_login_command"].strip():
                _sync["log"].append("Running sign-in…")
                if _run_cmd(cfg["sync_login_command"], 600) != 0:
                    _sync["result"] = "login_failed"
                    return
            code = _run_cmd(cfg["sync_command"], 3600)
            _sync["result"] = "login_required" if code == 2 else ("ok" if code == 0 else "error")
            _sync["last"] = time.time()
            if code == 0:
                classify_pending()
        finally:
            _sync["running"] = False
    threading.Thread(target=run, daemon=True).start()


# ------------------------------------------------------------------ inbox


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def find_duplicate(path):
    size = os.path.getsize(path)
    digest = None
    for it in scan():
        if it["path"] == str(path) or not os.path.exists(it["path"]) or os.path.getsize(it["path"]) != size:
            continue
        digest = digest or sha(path)
        if sha(it["path"]) == digest:
            return it["path"]
    return None


def sort_file(path):
    """File a PDF from the inbox into <course>/Week NN/ (or <course>/Added/). Returns the new path."""
    path = Path(path)
    dup = find_duplicate(path)
    if dup:
        path.unlink()
        return dup
    courses = [c.name for c in course_dirs()]
    if not courses:
        return str(path)
    known = [{"course": i["course"], "week": i["week"], "category": i["category"], "title": i["title"]}
             for i in scan() if i["course"] in courses][:150]
    prompt = f"""A student added a PDF to their study library. File it.
Today is {date.today().isoformat()}.
File name: {path.name}
First page text: {providers.first_page_text(path, 1500)}

Course folders: {json.dumps(courses)}
Existing files (to spot the course and the current teaching week): {json.dumps(known, ensure_ascii=False)}

Categories: {json.dumps(CATEGORIES)}
Answer ONLY with JSON: {{"course": "<one of the course folders, or null>", "category": "...", "week": <int or null>, "title": "<short display title>"}}"""
    try:
        r = providers.current().oneshot_json(prompt, timeout=180)
    except Exception:
        r = {}
    course = r.get("course") if r.get("course") in courses else None
    if not course:
        return str(path)  # leave it in the inbox; the user can move it
    cdir = _course_dir(course)
    dest_dir = cdir / (f"Week {r['week']:02d}" if isinstance(r.get("week"), int) else "Added")
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / path.name
    n = 2
    while dest.exists():
        dest = dest_dir / f"{path.stem} ({n}){path.suffix}"
        n += 1
    shutil.move(str(path), dest)
    set_entry(str(dest), category=r.get("category") if r.get("category") in CATEGORIES else "Other",
              title=r.get("title"), week=r.get("week"))
    return str(dest)


def inbox_files():
    ib = config.inbox()
    return sorted(ib.glob("*.pdf")) if ib else []


_sorting = threading.Lock()


def sort_inbox():
    def run():
        if not _sorting.acquire(blocking=False):
            return
        try:
            for f in inbox_files():
                try:
                    sort_file(f)
                except Exception as e:
                    print("sort failed", f, e, flush=True)
        finally:
            _sorting.release()
    threading.Thread(target=run, daemon=True).start()


# ------------------------------------------------------------------ chats


def chat_file(path):
    return config.CHATS / (hashlib.sha1(str(path).encode()).hexdigest()[:16] + ".json")


def load_chat(path):
    return _load(chat_file(path), {"path": str(path), "messages": []})


def append_chat(path, *msgs):
    with _lock:
        chat = load_chat(path)
        chat["path"] = str(path)
        chat["messages"].extend(msgs)
        _save(chat_file(path), chat)
    if config.load()["write_markdown"]:
        _write_markdown(path, chat)
    return chat


def clear_chat(path):
    with _lock:
        f = chat_file(path)
        if f.exists():
            archive = config.CHATS / "archive"
            archive.mkdir(exist_ok=True)
            f.rename(archive / f"{f.stem}-{int(time.time())}.json")
            md = markdown_path(path)
            if md.exists():
                md.rename(md.with_name(md.stem + f" (archived {time.strftime('%Y-%m-%d %H.%M')}).md"))


def course_folder_for(path):
    p = Path(path)
    for d in course_dirs():
        try:
            p.relative_to(d)
            return d
        except ValueError:
            continue
    return None


def markdown_path(path):
    d = course_folder_for(path)
    base = (d / "SlideMate Chats") if d else (config.DATA / "chats-md")
    base.mkdir(parents=True, exist_ok=True)
    return base / (Path(path).stem + ".md")


def _write_markdown(path, chat):
    p = Path(path)
    by_slide = {}
    for m in chat["messages"]:
        by_slide.setdefault(m.get("slide", 0), []).append(m)
    out = [f"# {p.stem}", "", f"Deck: `{p}`", ""]
    for slide in sorted(by_slide):
        out += [f"## Slide {slide}", ""]
        for m in by_slide[slide]:
            when = time.strftime("%Y-%m-%d %H:%M", time.localtime(m.get("ts", 0)))
            if m["role"] == "user":
                out += [f"**You** ({when}{', about a snipped area' if m.get('snip') else ''}):", "",
                        "> " + m["text"].replace("\n", "\n> "), ""]
            else:
                out += ["**Tutor:**", "", m["text"], ""]
    markdown_path(path).write_text("\n".join(out))
