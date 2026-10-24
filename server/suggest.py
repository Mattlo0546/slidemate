"""Question suggestions for the chat box: what to ask about a slide, and what to ask next after an answer.

Students often don't know what to ask ("explain" is too vague). So for each slide we suggest a few specific
questions, shown as grey text in the empty ask box (Tab puts one in, like Codex / Claude Code's next-prompt
suggestions). They follow the evidence on good learning questions: "why / how does X cause Y" (elaborative
interrogation), "how does this connect to / differ from …" (Graesser & Person's deep questions, King's question
stems), "what if / apply it". No "quiz me" questions: the flashcards' Quiz me does retrieval practice.

- Starters: one cheap AI call per deck (the light model, e.g. Haiku) writes questions for every slide at once,
  from the slide text and what the lecturer said. Saved to disk, so changing slides shows them instantly.
- Follow-ups: after each answer, one small call with that slide and the last question + answer.
"""
import hashlib
import os
import threading
import time

import config
import lecture
import library as lib
import providers

SUG = config.DATA / "suggestions"
SUG.mkdir(parents=True, exist_ok=True)
_running = set()
_lock = threading.Lock()
RETRY_AFTER = 6 * 3600  # after a failed run, don't try again on our own for a while (each try costs plan usage)

GOOD_QUESTIONS = """WHAT MAKES A GOOD QUESTION HERE (follow strictly):
- Specific: name the actual concept, term, formula or example from the slide. Never "Explain this slide" or "What
  does this mean?".
- Deep, not shallow: prefer "Why does …", "How does X lead to Y?", "What's the difference between X and Y?", "How
  does this connect to <earlier idea>?", "What would happen if …?", "How would I apply X to <case>?", "What's the
  intuition behind <formula>?". Avoid yes/no questions and bare definitions.
- Each question a different kind (e.g. one why/how, one connect/compare, one apply/what-if).
- Prefer what the lecturer stressed or flagged as examinable, and points students commonly get wrong.
- Never ask to be quizzed or tested (no "quiz me", "test me", "check my understanding"): that's handled elsewhere.
- Written as the student would type it: first person, plain, under 18 words, one question each.
- Only ask about what's on the slide or the lecture; don't invent topics."""

STARTERS = """You suggest questions a university student could ask an AI tutor about each slide of a lecture
deck, for when they don't know what to ask. Deck: "{title}"{course}.

{rules}

Below is the text of each slide{notes_note}. Skip slides with nothing to ask about (title, contents, admin,
references, a blank or image-only slide). For the rest, write 2-3 questions.

{slides}

Reply with JSON only, no commentary: {{"<slide number>": ["question", "question", ...], ...}}"""

FOLLOWUPS = """A university student is studying a lecture slide with an AI tutor. Suggest 2-3 follow-up questions
the student could ask next, to understand the topic more deeply.

{rules}
- Follow on from the answer: dig into the part that's most likely still unclear, connect it to the rest of the
  lecture, or apply it. Don't repeat what was just answered.

Slide {page} of "{title}":
{slide}

The student asked:
{question}

The tutor answered:
{answer}

Reply with JSON only, no commentary: ["question", "question", ...]"""


def _file(path):
    return SUG / (hashlib.sha1(str(path).encode()).hexdigest()[:16] + ".json")


def _stamp(path):
    try:
        return int(os.path.getmtime(path))
    except OSError:
        return 0


def _clean(qs, n=3):
    out = []
    for q in qs if isinstance(qs, list) else []:
        q = " ".join(str(q).split())
        if 8 <= len(q) <= 200 and q.lower() not in {x.lower() for x in out}:
            out.append(q)
    return out[:n]


def _ask_light(prompt, timeout):
    prov = providers.current()
    extra = {"effort": "low"} if prov.name == "claude" else {}
    return prov.oneshot_json(prompt, providers.model_for("light"), timeout, **extra)


def for_slide(path, page):
    """{"state": "ready" | "making" | "off" | "failed", "questions": [...]} for one slide. Starts the deck's
    run in the background when there's none yet (or the PDF changed)."""
    if not config.load().get("chat_suggestions", True):
        return {"state": "off", "questions": []}
    saved = lib._load(_file(path), None)
    if saved and saved.get("stamp") == _stamp(path) and not saved.get("error"):
        return {"state": "ready", "questions": saved["slides"].get(str(page), [])}
    if path in _running:
        return {"state": "making", "questions": []}
    if saved and saved.get("error") and time.time() - saved.get("at", 0) < RETRY_AFTER and saved.get("stamp") == _stamp(path):
        return {"state": "failed", "questions": []}
    start(path)
    return {"state": "making", "questions": []}


def start(path):
    with _lock:
        if path in _running or not os.path.isfile(path):
            return
        _running.add(path)
    threading.Thread(target=_make, args=(path,), daemon=True).start()


def _slide_notes(path):
    """Slide number → a short version of what the lecturer said about it (when the lecture was recorded)."""
    _, notes = lecture._latest_notes(path)
    out = {}
    for n, s in ((notes or {}).get("slides") or {}).items():
        text = " ".join((s.get("notes_md") or "").split())
        if text:
            out[n] = text[:500]
    return out


def _make(path):
    stamp = _stamp(path)
    try:
        info = lecture.deck_info(path)
        notes = _slide_notes(path)
        blocks = []
        for chunk in providers.deck_text(path, 150_000).split("=== Slide ")[1:]:
            num, _, body = chunk.partition(" ===")
            body = " ".join(body.split())[:1500]
            if notes.get(num):
                body += f"\n[Lecturer said: {notes[num]}]"
            blocks.append(f"--- Slide {num} ---\n{body}")
        if not blocks:
            raise RuntimeError("no slide text (a scanned deck?)")
        prompt = STARTERS.format(title=info["deck_title"], course=f" (course: {info['course']})" if info.get("course") else "",
                                 rules=GOOD_QUESTIONS, slides="\n\n".join(blocks),
                                 notes_note=", with what the lecturer said about it where we have it" if notes else "")
        data = _ask_light(prompt, 600)
        slides = {str(int(k)): q for k, v in (data.items() if isinstance(data, dict) else [])
                  if str(k).strip().isdigit() and (q := _clean(v))}
        if not slides:
            raise RuntimeError("couldn't read any questions from the AI's answer")
        lib._save(_file(path), {"path": path, "stamp": stamp, "at": time.time(), "slides": slides})
        print(f"suggestions: {os.path.basename(path)}: {len(slides)} slides", flush=True)
    except Exception as e:
        print("suggestions failed", path, e, flush=True)
        lib._save(_file(path), {"path": path, "stamp": stamp, "at": time.time(), "slides": {}, "error": str(e)[:300]})
    finally:
        _running.discard(path)


def followups(path, page):
    """2-3 next questions after the latest answer on this slide (a small, synchronous call)."""
    if not config.load().get("chat_suggestions", True):
        return []
    msgs = lib.load_chat(path)["messages"]
    if len(msgs) < 2 or msgs[-1].get("role") != "bot" or msgs[-2].get("role") != "user":
        return []
    q, a = msgs[-2].get("text") or "", msgs[-1].get("text") or ""
    if not a.strip() or a.strip().startswith("_Stopped"):
        return []
    slide = providers.deck_text(path, 400_000).split(f"=== Slide {page} ===", 1)
    slide = " ".join(slide[1].split("=== Slide ", 1)[0].split())[:2500] if len(slide) > 1 else "(no text on this slide)"
    prompt = FOLLOWUPS.format(rules=GOOD_QUESTIONS, page=page, title=lecture.deck_info(path)["deck_title"], slide=slide,
                              question=q[:1500], answer=a[:5000])
    try:
        return _clean(_ask_light(prompt, 120))
    except Exception as e:
        print("follow-up suggestions failed", e, flush=True)
        return []

