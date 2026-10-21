"""Missed lectures, filled from the university's own recordings.

A university connection (moodle-mcp, canvas-mcp, blackboard-mcp, classroom-mcp…) that has `<x>_recordings` and
`<x>_recording_transcript` tools can list the course's lecture recordings (Panopto, Echo360, Mediasite, Meet…) and
return what was said. After each Pull, every recording is matched to a deck in the library; if that deck has no
lecture notes, or only partial ones (your own recording started late or stopped early), the transcript becomes a
lecture for it. For partial decks the slides that already have notes are kept and only the others are filled.
Transcripts come from the recording's captions, or from Parakeet when the recording has none.
"""
import json
import re
import shutil
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import config
import lecture
import library as lib

STATE = config.DATA / "recordings.json"     # recording id -> what happened to it
CACHE = config.DATA / "recordings-cache"    # transcripts already fetched (so re-checks don't fetch them again)
RECHECK_S = 7 * 86400                       # recordings whose deck was already full are checked again weekly
MIN_COVERAGE = 0.7                          # notes from a recording shorter than this share of the lecture are partial

_job = {"running": False, "log": [], "result": None, "last": None, "filled": []}
_lock = threading.Lock()


def _log(msg):
    _job["log"] = (_job["log"] + [str(msg)])[-40:]
    print("recordings:", msg, flush=True)


def sources():
    """Connected servers that can list recordings: [(server, list tool, transcript tool)]."""
    import mcp
    out = []
    for name, spec in mcp.servers().items():
        tools = spec.get("tools") or []
        lst = next((t for t in tools if t.endswith("_recordings")), None)
        tr = next((t for t in tools if t.endswith("_recording_transcript")), None)
        if lst and tr:
            out.append((name, lst, tr))
    return out


def status():
    return {"enabled": bool(config.load().get("fill_from_recordings", True)), "available": bool(sources()),
            "running": _job["running"], "result": _job["result"], "last": _job["last"], "log": _job["log"][-8:],
            "filled": _job["filled"][-10:]}


def start(force=False):
    if not config.load().get("fill_from_recordings", True) and not force:
        return status()
    with _lock:
        if _job["running"] or not sources():
            return status()
        _job.update(running=True, log=[], result=None, filled=[])
    threading.Thread(target=_run, args=(force,), daemon=True).start()
    return status()


def _run(force):
    try:
        _job["result"] = run(force)
    except Exception as e:  # noqa: BLE001 - shown in Settings
        _log(f"Error: {e}")
        _job["result"] = "error"
    finally:
        _job["running"] = False
        _job["last"] = time.time()


# ------------------------------------------------------------------ matching a recording to a deck


STOP = set("""about above after again against because before being below between could doesn during every further
having other their there these those through under until where which while would should yours themselves itself
might shall using based what when example examples slide slides lecture today""".split())


def words(text):
    return {w for w in re.findall(r"[a-z]{5,}", (text or "").lower()) if w not in STOP}


# macOS's own PDFKit, through JavaScript for Automation: works on every Mac, no poppler needed.
_PDFKIT = """ObjC.import('Quartz');
function run(argv) {
  const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!d || d.isNil()) return '';
  return argv[1] === 'pages' ? String(d.pageCount) : ObjC.unwrap(d.string) || '';
}"""


def _pdfkit(path, what="text"):
    try:
        return subprocess.run(["osascript", "-l", "JavaScript", "-e", _PDFKIT, path, what], capture_output=True,
                              text=True, timeout=120).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def pdf_text(path):
    tool = config.which("pdftotext")
    if tool:
        try:
            out = subprocess.run([tool, "-q", path, "-"], capture_output=True, text=True, timeout=60).stdout
            if out.strip():
                return out
        except (OSError, subprocess.SubprocessError):
            pass
    return _pdfkit(path)


def overlap(deck_text, said):
    """Share of a deck's distinctive words that the lecturer actually said."""
    d = words(deck_text)
    return len(d & said) / len(d) if d else 0.0


def course_of(rec, items):
    """The library course a recording's LMS course is: by code, then by name."""
    c = rec.get("course") or {}
    code = (c.get("code") or "").strip().lower()
    name_words = words(c.get("name"))
    best, score = None, 0.0
    for course in {i["course"] for i in items if i.get("courseDir")}:
        folder = course.lower()
        s = 0.0
        if code and re.search(rf"(?<![a-z0-9]){re.escape(code)}(?![a-z0-9])", folder):
            s = 2.0
        elif name_words:
            s = len(name_words & words(course)) / len(name_words)
        if s > score:
            best, score = course, s
    return best if score >= 0.5 else None


def local_day(iso):
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().date().isoformat()
    except (AttributeError, ValueError):
        return None


def week_guess(rec, first_start):
    """The teaching week, counting the course's first recording as week 1 (a soft hint: weeks can be skipped)."""
    a, b = local_day(first_start), local_day(rec.get("start"))
    if not (a and b):
        return None
    return (datetime.fromisoformat(b) - datetime.fromisoformat(a)).days // 7 + 1


def pick_deck(rec, items, said, week=None):
    """{"deck", "title", "why"}; deck None when no deck clearly matches. `said` is a function returning the
    recording's words (fetched only when needed); `week` is the likely teaching week, if known."""
    course = course_of(rec, items)
    if not course:
        return {"deck": None, "why": f"no course in your library matches {(rec.get('course') or {}).get('name')}"}
    decks = [i for i in items if i["course"] == course and not i.get("archived")]
    lectures = [i for i in decks if i.get("category") == "Lectures"] or decks
    if not lectures:
        return {"deck": None, "why": f"no slides in {course} yet"}
    day = local_day(rec.get("start"))
    for d in lectures:  # you recorded this class yourself: same deck
        if day and any(m.get("date") == day and m.get("source") != "replay" for m in lecture.list_for_deck(d["path"])):
            return {"deck": d["path"], "title": d["title"], "why": "your own recording that day"}
    heard = said()

    def prior(d):  # decks from the likely week first; the deck's own words still decide
        if not week or d.get("week") is None:
            return 0.9
        return {0: 1.0, 1: 0.9}.get(abs(d["week"] - week), 0.7)
    scored = sorted(((overlap(pdf_text(d["path"]), heard) * prior(d), d) for d in lectures), key=lambda x: -x[0])
    best, d = scored[0]
    second = scored[1][0] if len(scored) > 1 else 0.0
    if best < 0.2:
        return {"deck": None, "why": f"no deck in {course} matches what was said (best: {d['title']}, {best:.0%})"}
    if second and best < second * 1.05:
        return {"deck": None, "why": f"two decks match equally well ({d['title']}, {scored[1][1]['title']})"}
    return {"deck": d["path"], "title": d["title"],
            "why": f"{best:.0%} of its key words were said" + (f" (next best {second:.0%})" if second else "")}


# ------------------------------------------------------------------ the deck's notes so far


def pdf_pages(path):
    tool = config.which("pdfinfo")
    if tool:
        try:
            m = re.search(r"^Pages:\s+(\d+)", subprocess.run([tool, path], capture_output=True, text=True,
                                                             timeout=30).stdout, re.M)
            if m:
                return int(m.group(1))
        except (OSError, subprocess.SubprocessError):
            pass
    n = _pdfkit(path, "pages").strip()
    return int(n) if n.isdigit() else 0


def deck_notes(deck, rec):
    """{"state": empty | partial | filled | busy | has_this, "lecture": the notes to build on, "why"}"""
    native = rec.get("native_id")
    lectures = lecture.list_for_deck(deck)
    if any(m.get("replay_id") == native and m.get("status") != "error" for m in lectures):
        return {"state": "has_this"}
    if any(m.get("status") in ("recording", "transcribing", "writing") for m in lectures):
        return {"state": "busy"}
    done = [m for m in lectures if m.get("status") == "done"]
    if not done:
        return {"state": "empty"}
    latest = done[0]
    notes = (lib._load(lecture.ldir(latest["id"]) / "notes.json", {}) or {}).get("slides") or {}
    noted = sorted(int(k) for k in notes)
    pages = pdf_pages(deck) or (max(noted) if noted else 0)
    minutes, length = (latest.get("duration") or 0) / 60, (rec.get("duration_s") or 0) / 60
    why = []
    if minutes and length and minutes < MIN_COVERAGE * length:
        why.append(f"your recording is {minutes:.0f} of {length:.0f} min")
    if pages and noted and max(noted) < 0.6 * pages:
        why.append(f"notes stop at slide {max(noted)} of {pages}")
    if pages and len(noted) < 0.25 * pages:
        why.append(f"only {len(noted)} of {pages} slides have notes")
    return {"state": "partial" if why else "filled", "lecture": latest["id"], "why": "; ".join(why)}


# ------------------------------------------------------------------ transcripts


def _cache_path(rec_id):
    return CACHE / (re.sub(r"[^\w-]+", "_", rec_id)[-150:] + ".json")


def transcript(server, tool, rec):
    """The recording's sentences: from the server (captions / Meet transcript), else transcribed here."""
    import mcp
    p = _cache_path(rec["id"])
    cached = lib._load(p, None)
    if cached:
        return cached
    res = mcp.call_tool(server, tool, {"id": rec["id"]}, timeout=600)
    d = json.loads(res["text"]) if res["text"].strip().startswith("{") else {"error": res["text"][:300]}
    if d.get("login_required"):
        raise PermissionError("sign-in needed")
    if d.get("error"):
        raise RuntimeError(d["error"])
    if d.get("sentences"):
        sents, source = d["sentences"], d.get("source") or "captions"
    elif d.get("media_url"):
        sents, source = transcribe_url(d["media_url"], d.get("media_headers") or {}), "Parakeet"
    else:
        raise RuntimeError("the connection returned no transcript")
    out = {"sentences": sents, "source": source}
    CACHE.mkdir(parents=True, exist_ok=True)
    lib._save(p, out)
    return out


def transcribe_url(url, headers):
    if not config.which("parakeet-mlx"):
        raise RuntimeError("this recording has no captions, and speech-to-text isn't installed (Settings → "
                           "Lecture recording)")
    work = config.DATA / "work" / f"rec-{uuid.uuid4().hex[:6]}"
    work.mkdir(parents=True)
    try:
        audio = work / "audio.m4a"
        cmd = [lecture.FFMPEG(), "-loglevel", "error", "-y"]
        if headers:
            cmd += ["-headers", "".join(f"{k}: {v}\r\n" for k, v in headers.items())]
        cmd += ["-i", url, "-vn", "-ac", "1", "-c:a", "aac", "-b:a", "64k", str(audio)]
        subprocess.run(cmd, check=True, timeout=3600, env=config.ENV, capture_output=True)
        return lecture.transcribe(audio)
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ------------------------------------------------------------------ the run


def run(force=False):
    import mcp
    state = lib._load(STATE, {})
    items = lib.scan()
    now = time.time()
    for server, list_tool, tr_tool in sources():
        _log(f"Checking {server} for lecture recordings…")
        try:
            res = mcp.call_tool(server, list_tool, {}, timeout=1200)
            d = json.loads(res["text"])
        except Exception as e:  # noqa: BLE001
            _log(f"{server}: couldn't list recordings ({e})")
            continue
        if d.get("login_required"):
            _log(f"{server}: sign-in needed (press Pull to sign in)")
            continue
        for err in (d.get("errors") or [])[:3]:
            _log(err)
        first = {}
        for rec in d.get("recordings") or []:
            cid = str((rec.get("course") or {}).get("id"))
            if rec.get("start") and (cid not in first or rec["start"] < first[cid]):
                first[cid] = rec["start"]
        for rec in d.get("recordings") or []:
            prev = state.get(rec["id"]) or {}
            if not force and (prev.get("status") == "sent" or
                              (prev.get("status") in ("already_filled", "too_short") and
                               now - prev.get("checked", 0) < RECHECK_S)):
                continue
            try:
                r = one(server, tr_tool, rec, items,
                        week_guess(rec, first.get(str((rec.get("course") or {}).get("id")))))
            except PermissionError:
                _log(f"{server}: sign-in needed (press Pull to sign in)")
                break
            except Exception as e:  # noqa: BLE001 - one recording failing shouldn't stop the rest
                r = {"status": "error", "error": str(e)[:300]}
            r.update(checked=now, title=rec.get("title"), start=rec.get("start"))
            state[rec["id"]] = r
            lib._save(STATE, state)
            if r["status"] == "error":
                _log(f"{rec.get('title')}: {r['error']}")
    return "ok"


def one(server, tr_tool, rec, items, week=None):
    cache = {}

    def said():
        if "t" not in cache:
            cache["t"] = transcript(server, tr_tool, rec)
        return words(" ".join(s["text"] for s in cache["t"]["sentences"]))

    pick = pick_deck(rec, items, said, week)
    out = {"deck": pick.get("deck"), "matched_by": pick["why"]}
    if not pick["deck"]:
        return {**out, "status": "no_deck"}
    have = deck_notes(pick["deck"], rec)
    out["notes"] = have["state"]
    if have["state"] in ("filled", "busy", "has_this"):
        return {**out, "status": {"filled": "already_filled", "busy": "busy", "has_this": "sent"}[have["state"]]}
    said()
    sents = cache["t"]["sentences"]
    if len(sents) < 30:
        return {**out, "status": "too_short"}
    fill = have["state"] == "partial"
    _log(f"Writing notes for {pick['title']} from the {local_day(rec.get('start')) or ''} recording"
         + (" (only the slides without notes)" if fill else "") + "…")
    lid = lecture.import_transcript(pick["deck"], "", local_day(rec.get("start")), sentences=sents, source="replay",
                                    fill_from=have.get("lecture") if fill else None,
                                    extra={"replay_id": rec.get("native_id"), "replay_title": rec.get("title"),
                                           "replay_url": rec.get("url"),
                                           "replay_platform": rec.get("platform")})
    # One lecture at a time: each one is a long AI run.
    for _ in range(360):
        st = lecture.load_meta(lid).get("status")
        if st in ("done", "error"):
            break
        time.sleep(10)
    meta = lecture.load_meta(lid)
    if meta.get("status") == "error":
        return {**out, "status": "error", "error": meta.get("error") or "notes failed", "lecture": lid}
    _job["filled"].append({"deck": pick["title"], "date": local_day(rec.get("start")), "partial": fill})
    return {**out, "status": "sent", "lecture": lid, "transcript_from": cache["t"]["source"]}
