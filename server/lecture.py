"""Lecture capture for SlideMate: record → Parakeet transcript → Claude summary + per-slide notes with verbatim quotes."""
import base64
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from datetime import date, datetime
from pathlib import Path

import config
import library as lib
import providers

HOME = Path.home()
LECTURES = config.LECTURES
ENV = config.ENV


def FFMPEG():
    return config.which("ffmpeg") or "ffmpeg"


def tools_status():
    """Recording needs ffmpeg + parakeet-mlx (Apple Silicon). Importing transcripts needs neither."""
    return {"ffmpeg": bool(config.which("ffmpeg")), "parakeet": bool(config.which("parakeet-mlx")),
            "install": "brew install ffmpeg uv && uv tool install parakeet-mlx"}


def audio_path(lid):
    return ldir(lid) / load_meta(lid).get("audio", "audio.webm")

_locks = {}
_caffeinate = {}


def _lock(lid):
    return _locks.setdefault(lid, threading.RLock())


def ldir(lid):
    if not re.fullmatch(r"[\w-]+", lid or ""):
        raise ValueError("bad lecture id")
    return LECTURES / lid


def load_meta(lid):
    return lib._load(ldir(lid) / "meta.json", {})


def save_meta(lid, **kw):
    with _lock(lid):
        m = load_meta(lid)
        m.update(kw)
        lib._save(ldir(lid) / "meta.json", m)
        return m


def deck_info(path):
    item = next((i for i in lib.scan() if i["path"] == path), None)
    cdir = lib.course_folder_for(path)
    return {"deck": path, "deck_title": (item or {}).get("title") or Path(path).stem,
            "course": cdir.name if cdir else None, "course_dir": str(cdir) if cdir else None}


def list_for_deck(path):
    out = []
    for d in LECTURES.iterdir():
        m = lib._load(d / "meta.json", None)
        if m and m.get("deck") == path:
            out.append(m)
    return sorted(out, key=lambda m: m.get("started", 0), reverse=True)


# ------------------------------------------------------------------ recording


def start(path, ext="webm"):
    lid = datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
    ldir(lid).mkdir(parents=True)
    save_meta(lid, id=lid, **deck_info(path), date=date.today().isoformat(), started=time.time(),
              status="recording", source="recorded", seq=-1, live_offset=0.0,
              audio="audio." + ("mp4" if ext == "mp4" else "webm"))
    lib._save(ldir(lid) / "events.json", [])
    lib._save(ldir(lid) / "live.json", [])
    # Keep the Mac awake while recording (lid open, screen may dim).
    _caffeinate[lid] = subprocess.Popen(["caffeinate", "-i", "-s"])
    threading.Thread(target=_live_loop, args=(lid,), daemon=True).start()
    return lid


def add_chunk(lid, seq, data):
    with _lock(lid):
        m = load_meta(lid)
        if m.get("status") != "recording":
            return False
        if seq <= m.get("seq", -1):
            return True  # duplicate retry
        with open(audio_path(lid), "ab") as f:
            f.write(data)
        save_meta(lid, seq=seq, audio_bytes=audio_path(lid).stat().st_size)
    return True


def add_events(lid, events):
    with _lock(lid):
        ev = lib._load(ldir(lid) / "events.json", [])
        ev.extend(events)
        lib._save(ldir(lid) / "events.json", ev)


def _duration(path):
    try:
        out = subprocess.run([FFMPEG(), "-i", str(path), "-f", "null", "-"], capture_output=True, text=True, timeout=600, env=ENV).stderr
        t = re.findall(r"time=(\d+):(\d+):([\d.]+)", out)
        h, mnt, s = t[-1]
        return int(h) * 3600 + int(mnt) * 60 + float(s)
    except Exception:
        return 0.0


def transcribe(audio, offset=0.0, start_at=None):
    """Run Parakeet on (part of) an audio file. Returns [{start, end, text}]."""
    work = Path(audio).parent / f"tmp-{uuid.uuid4().hex[:6]}"
    work.mkdir()
    try:
        wav = work / "a.wav"
        parakeet = config.which("parakeet-mlx")
        if not parakeet:
            raise RuntimeError("Transcription needs parakeet-mlx: " + tools_status()["install"])
        cmd = [FFMPEG(), "-loglevel", "error", "-y"]
        if start_at:
            cmd += ["-ss", f"{start_at:.2f}"]
        cmd += ["-i", str(audio), "-ar", "16000", "-ac", "1", str(wav)]
        subprocess.run(cmd, check=True, timeout=1800, env=ENV)
        subprocess.run([parakeet, str(wav), "--output-format", "json", "--output-dir", str(work)],
                       check=True, capture_output=True, timeout=7200, env=ENV)
        data = json.loads((work / "a.json").read_text())
        return [{"start": round(s["start"] + offset, 2), "end": round(s["end"] + offset, 2), "text": s["text"].strip()}
                for s in data.get("sentences", []) if s.get("text", "").strip()]
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _live_loop(lid):
    """While recording, transcribe new audio every ~45s so a live transcript is visible."""
    while True:
        time.sleep(20)
        m = load_meta(lid)
        if m.get("status") != "recording":
            return
        audio = audio_path(lid)
        if not audio.exists():
            continue
        dur = _duration(audio)
        off = m.get("live_offset", 0.0)
        if dur - off < 45:
            continue
        try:
            sents = transcribe(audio, offset=off, start_at=off)
        except Exception as e:
            print("live transcribe failed", e, flush=True)
            continue
        # Keep the unfinished last sentence for the next pass.
        if len(sents) > 1:
            keep, next_off = sents[:-1], sents[-1]["start"]
        else:
            keep, next_off = sents, dur
        with _lock(lid):
            live = lib._load(ldir(lid) / "live.json", [])
            live.extend(keep)
            lib._save(ldir(lid) / "live.json", live)
            save_meta(lid, live_offset=next_off)


def stop(lid, model="opus"):
    p = _caffeinate.pop(lid, None)
    if p:
        p.terminate()
    save_meta(lid, status="transcribing", ended=time.time())
    threading.Thread(target=_finish, args=(lid, model), daemon=True).start()


def _finish(lid, model):
    try:
        audio = audio_path(lid)
        if not audio.exists() or audio.stat().st_size < 2000:
            save_meta(lid, status="error", error="No audio was recorded (check the microphone permission).")
            return
        save_meta(lid, duration=_duration(audio))
        sents = transcribe(audio)
        lib._save(ldir(lid) / "transcript.json", sents)
        generate_notes(lid, model)
    except Exception as e:
        save_meta(lid, status="error", error=str(e)[:500])


# ------------------------------------------------------------------ import


TS = re.compile(r"^\s*[\[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s*[-–:]?\s*")


HEADER = re.compile(r"^(Meeting Title|Title|Date|Meeting participants|Participants|Transcript)\s*:(\s|$)", re.I)
SPEAKER = re.compile(r"^(Me|Them|Speaker\s*\d*|[A-Z][\w.' -]{0,30}):\s+")


def _secs(ts):
    parts = [int(x) for x in ts.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    return parts[0] * 3600 + parts[1] * 60 + parts[2]


def import_transcript(path, text, on_date=None, model="opus"):
    lid = datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
    ldir(lid).mkdir(parents=True)
    sents = []
    for line in text.splitlines():
        line = line.strip()
        if not line or HEADER.match(line):
            continue
        m = TS.match(line)
        start = _secs(m.group(1)) if m else None
        body = line[m.end():] if m else line
        body = SPEAKER.sub("", body).strip()
        # Granola-style exports put a whole lecture on one line: split into sentences so quotes are precise.
        for sent in re.split(r"(?<=[.?!])\s+(?=[A-Z0-9\"'(])", body):
            if sent.strip():
                sents.append({"start": start, "end": None, "text": sent.strip()})
                start = None
    save_meta(lid, id=lid, **deck_info(path), date=on_date or date.today().isoformat(), started=time.time(),
              status="writing", source="imported")
    lib._save(ldir(lid) / "transcript.json", sents)
    lib._save(ldir(lid) / "events.json", [])
    threading.Thread(target=lambda: _safe_notes(lid, model), daemon=True).start()
    return lid


def _safe_notes(lid, model):
    try:
        generate_notes(lid, model)
    except Exception as e:
        save_meta(lid, status="error", error=str(e)[:500])


def regenerate(lid, model="opus"):
    save_meta(lid, status="writing", error=None)
    threading.Thread(target=lambda: _safe_notes(lid, model), daemon=True).start()


# ------------------------------------------------------------------ notes


def _fmt(t):
    if t is None:
        return ""
    t = int(t)
    return f"{t // 3600}:{t % 3600 // 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60}:{t % 60:02d}"


def _lines(sents, events, deck=None):
    """Number transcript lines and tag each with the slide the student was viewing at that moment."""
    ev = sorted([e for e in events if e.get("t") is not None and e.get("deck") in (None, deck)], key=lambda e: e["t"])
    out = []
    for n, s in enumerate(sents, 1):
        viewing = None
        if s.get("start") is not None:
            for e in ev:
                if e["t"] <= s["start"] + 0.5:
                    viewing = e.get("slide")
                else:
                    break
        tag = f"L{n}"
        if s.get("start") is not None:
            tag += f" {_fmt(s['start'])}"
        if viewing:
            tag += f" · viewing slide {viewing}"
        out.append(f"[{tag}] {s['text']}")
    return out


NOTES_PROMPT = """You are writing lecture notes for a university student. Attached: the full slide deck "{title}".
Below: the transcript of the lecture, one numbered line per sentence. {timing}

Write two things, using EXACTLY this plain-text format (no JSON, no code fences):

===SUMMARY===
A skimmable Markdown overview with these sections (use ### headings, bullets, keep it tight):
### In a nutshell  (3–6 bullets: what we learned today)
### Key concepts  (the ideas/definitions/equations that matter, one line each)
### To do next  (readings, prep, labs, anything the lecturer asked students to do; say "Nothing mentioned" if none)
### Assignments & deadlines  (dates, weightings, submission details; "None mentioned" if none)
### Exam tips  (anything flagged as examinable, common mistakes, "this will come up", emphasis)
### Worth remembering  (anecdotes, examples, admin details, anything else useful)

Then one block per slide that the lecturer actually discussed, in slide order:
===SLIDE <number>===
LINES: <comma-separated transcript line ranges spoken about this slide, e.g. 12-18, 40-41>
<Markdown notes: what the lecturer said about this slide that ISN'T already obvious from the slide itself —
explanations, examples, intuition, emphasis, warnings, exam hints. 2–7 bullets. Use LaTeX $...$ for maths.>

Rules:
- Slide numbers are PDF page numbers (1-based) of the attached deck.
- Match transcript to slides by content first; "viewing slide N" tags (if present) show which slide the student had open and are a strong hint.
- Only include slides that were discussed; skip slides that were not mentioned.
- LINES must point to the most relevant verbatim passages (at most ~4 ranges, each ≤ 12 lines).
- Never invent content that isn't in the transcript or slides.
- The transcript comes from automatic speech recognition and may contain mis-heard words (e.g. "teasone bridge" for
  "Wheatstone bridge"). Use the slides to work out what was meant and write the notes with the correct terms.
- Ignore side conversations, students chatting, and anything unrelated to the lecture content.

TRANSCRIPT:
{transcript}
"""


def _parse(text, sents):
    summary = ""
    slides = {}
    parts = re.split(r"^===(SUMMARY|SLIDE\s+(\d+))===\s*$", text, flags=re.M)
    # parts: [pre, tag, slide_no, body, tag, slide_no, body, ...]
    for i in range(1, len(parts) - 2, 3):
        tag, num, body = parts[i], parts[i + 1], parts[i + 2].strip()
        if tag == "SUMMARY":
            summary = body
            continue
        n = int(num)
        ranges = []
        m = re.match(r"LINES:\s*(.*)", body)
        if m:
            body = body[m.end():].strip()
            for a, b in re.findall(r"(\d+)\s*(?:-|–)?\s*(\d+)?", m.group(1)):
                a, b = int(a), int(b or a)
                if 1 <= a <= len(sents):
                    ranges.append((a, min(max(a, b), len(sents), a + 14)))
        quotes = []
        for a, b in ranges:
            chunk = sents[a - 1:b]
            quotes.append({"from": a, "to": b, "start": chunk[0].get("start"), "end": chunk[-1].get("end"),
                           "text": " ".join(s["text"] for s in chunk)})
        slides[n] = {"notes_md": body, "quotes": quotes}
    return summary, slides


def generate_notes(lid, model="opus"):
    m = save_meta(lid, status="writing")
    sents = lib._load(ldir(lid) / "transcript.json", [])
    if not sents:
        save_meta(lid, status="error", error="Transcript is empty.")
        return
    events = lib._load(ldir(lid) / "events.json", [])
    timed = any(s.get("start") is not None for s in sents)
    timing = ("Lines carry timestamps and, where known, which slide the student was viewing."
              if events else "Lines carry timestamps." if timed else "The transcript has no timestamps.")
    prompt = NOTES_PROMPT.format(title=m.get("deck_title"), timing=timing, transcript="\n".join(_lines(sents, events, m.get("deck"))))
    text = providers.current().with_pdf(m["deck"], prompt, providers.model_for("notes"))
    summary, slides = _parse(text, sents)
    if not summary and not slides:
        raise RuntimeError("Couldn't parse Claude's notes.")
    lib._save(ldir(lid) / "notes.json", {"summary_md": summary, "slides": {str(k): v for k, v in slides.items()}, "raw": text})
    files = _write_markdown(lid, summary, slides, sents)
    save_meta(lid, status="done", files=files, finished=time.time())


def _write_markdown(lid, summary, slides, sents):
    m = load_meta(lid)
    if not config.load()["write_markdown"]:
        return {}
    base = (Path(m["course_dir"]) / "Lectures (SlideMate)") if m.get("course_dir") else (config.DATA / "lectures-md")
    base.mkdir(parents=True, exist_ok=True)
    stem = f"{m['date']} {m['deck_title']}"
    stem = re.sub(r'[/:*?"<>|]+', "-", stem)[:120]
    fs = {"summary": base / f"{stem} - summary.md", "slides": base / f"{stem} - slide notes.md",
          "transcript": base / f"{stem} - transcript.md"}
    head = f"Deck: `{m['deck']}` · {m['date']}"
    fs["summary"].write_text(f"# {m['deck_title']}: lecture summary\n\n{head}\n\n{summary}\n")
    out = [f"# {m['deck_title']}: slide-by-slide notes", "", head, ""]
    for n in sorted(slides):
        out += [f"## Slide {n}", "", slides[n]["notes_md"], ""]
        for q in slides[n]["quotes"]:
            when = f"[{_fmt(q['start'])}] " if q.get("start") is not None else ""
            out += [f"> {when}{q['text']}", ""]
    fs["slides"].write_text("\n".join(out))
    fs["transcript"].write_text(f"# {m['deck_title']}: transcript\n\n{head}\n\n" + "\n\n".join(
        (f"**{_fmt(s['start'])}** " if s.get("start") is not None else "") + s["text"] for s in sents) + "\n")
    return {k: str(v) for k, v in fs.items()}


def delete(lid):
    p = _caffeinate.pop(lid, None)
    if p:
        p.terminate()
    m = load_meta(lid)
    save_meta(lid, status="deleted")
    for f in (m.get("files") or {}).values():
        Path(f).unlink(missing_ok=True)
    shutil.rmtree(ldir(lid), ignore_errors=True)


def get(lid):
    m = load_meta(lid)
    notes = lib._load(ldir(lid) / "notes.json", None)
    if notes:
        notes.pop("raw", None)
    live = lib._load(ldir(lid) / "live.json", []) if m.get("status") == "recording" else []
    return {"meta": m, "notes": notes, "live": live[-40:], "has_audio": audio_path(lid).exists(), "audio_type": "audio/mp4" if m.get("audio", "").endswith("mp4") else "audio/webm"}


def notes_context(path, limit=40000):
    """Latest finished lecture notes for a deck, as text for the tutor's context."""
    for m in list_for_deck(path):
        if m.get("status") != "done":
            continue
        notes = lib._load(ldir(m["id"]) / "notes.json", {})
        parts = [f"Lecture on {m['date']} — summary:\n{notes.get('summary_md', '')}"]
        for n, s in sorted(notes.get("slides", {}).items(), key=lambda kv: int(kv[0])):
            quotes = " / ".join(q["text"] for q in s.get("quotes", []))[:1500]
            parts.append(f"Slide {n} — lecturer's points:\n{s['notes_md']}\nVerbatim: {quotes}")
        return "\n\n".join(parts)[:limit]
    return ""
