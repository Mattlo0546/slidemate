"""Flashcards: AI-written cards for every lecture deck, reviewed with spaced repetition (FSRS, as in Anki).

Where cards come from (one deck of cards per lecture PDF, split into subtopics):
- the slides themselves,
- the lecture notes (what the lecturer said: emphasis and exam hints decide what's worth memorising),
- the student's own tutor chats (what they asked about is what they found hard: those get targeted cards),
- cards they keep forgetting (a card from a different angle helps).

Decks are made automatically when a lecture's notes are written, and topped up after a revision session in the
chat. Scheduling is FSRS-5 with its published default parameters (the algorithm Anki uses by default).
"""
import hashlib
import math
import queue
import random
import re
import threading
import time
import uuid
from pathlib import Path

import config
import lecture
import library as lib
import providers

CARDS = config.DATA / "flashcards"
CARDS.mkdir(parents=True, exist_ok=True)
_lock = threading.RLock()

# ------------------------------------------------------------------ FSRS-5 scheduler

W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925,
     1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621]
DECAY = -0.5
FACTOR = 0.9 ** (1 / DECAY) - 1
LEARNING_STEPS = [60, 600]   # seconds: a new card comes back after 1 and 10 minutes before it graduates
RELEARNING_STEPS = [600]     # a forgotten card comes back after 10 minutes
MAX_DAYS = 3650
LEARN_AHEAD = 20 * 60        # a learning card due within 20 minutes can be shown early when nothing else is left
LEECH_LAPSES = 4
RATINGS = {1: "again", 2: "hard", 3: "good", 4: "easy"}


def _clamp_d(d):
    return min(10.0, max(1.0, d))


def _init_s(g):
    return max(W[g - 1], 0.1)


def _init_d(g):
    return _clamp_d(W[4] - math.exp(W[5] * (g - 1)) + 1)


def retrievability(s, days):
    return (1 + FACTOR * max(0.0, days) / s) ** DECAY


def _next_d(d, g):
    d2 = d - W[6] * (g - 3) * (10 - d) / 9          # linear damping
    return _clamp_d(W[7] * _init_d(4) + (1 - W[7]) * d2)  # mean reversion


def _short_term_s(s, g):
    k = math.exp(W[17] * (g - 3 + W[18]))
    return s * (max(k, 1.0) if g >= 3 else k)


def _recall_s(d, s, r, g):
    hard = W[15] if g == 2 else 1.0
    easy = W[16] if g == 4 else 1.0
    return s * (1 + math.exp(W[8]) * (11 - d) * s ** (-W[9]) * (math.exp((1 - r) * W[10]) - 1) * hard * easy)


def _forget_s(d, s, r):
    long_term = W[11] * d ** (-W[12]) * ((s + 1) ** W[13] - 1) * math.exp((1 - r) * W[14])
    return min(long_term, s / math.exp(W[17] * W[18]))


def _interval_days(s, retention, seed):
    days = s / FACTOR * (retention ** (1 / DECAY) - 1)
    days = min(max(round(days), 1), MAX_DAYS)
    if days >= 3:  # a little fuzz so cards learned together don't stay clumped together forever
        delta = max(1, round(days * 0.05))
        days = random.Random(seed).randint(days - delta, days + delta)
    return days


def new_srs():
    return {"state": "new", "step": 0, "stability": None, "difficulty": None, "due": 0, "last_review": None,
            "reps": 0, "lapses": 0}


def schedule(srs, g, now, retention, seed=""):
    """The card's next SRS state after rating it g (1 again · 2 hard · 3 good · 4 easy). Pure: doesn't mutate."""
    s = dict(srs)
    st = s.get("state", "new")
    seed = f"{seed}:{s.get('reps', 0)}:{g}"
    if st == "new" or s.get("stability") is None:
        stab, diff = _init_s(g), _init_d(g)
        st, s["step"] = "learning", 0
    else:
        days = (now - (s.get("last_review") or now)) / 86400
        if days < 1:
            stab = _short_term_s(s["stability"], g)
        else:
            r = retrievability(s["stability"], days)
            stab = _forget_s(s["difficulty"], s["stability"], r) if g == 1 else _recall_s(s["difficulty"], s["stability"], r, g)
        diff = _next_d(s["difficulty"], g)
    stab = max(stab, 0.01)
    if st in ("learning", "relearning"):
        steps = LEARNING_STEPS if st == "learning" else RELEARNING_STEPS
        step = min(s.get("step", 0), len(steps) - 1)
        if g == 1:
            step, secs = 0, steps[0]
        elif g == 2:
            secs = steps[0] * 1.5 if step == 0 and len(steps) == 1 else (steps[0] + steps[1]) / 2 if step == 0 else steps[step]
        elif g == 3 and step + 1 < len(steps):
            step, secs = step + 1, steps[step + 1]
        else:  # good on the last step, or easy: graduate
            st, step, secs = "review", 0, _interval_days(stab, retention, seed) * 86400
    else:
        step = 0
        if g == 1:
            st, secs = "relearning", RELEARNING_STEPS[0]
            s["lapses"] = s.get("lapses", 0) + 1
        else:
            secs = _interval_days(stab, retention, seed) * 86400
    s.update(state=st, step=step, stability=round(stab, 4), difficulty=round(diff, 4), due=now + secs,
             last_review=now, reps=s.get("reps", 0) + 1)
    return s


def fmt_interval(secs):
    if secs < 3600:
        return f"{max(1, round(secs / 60))}m"
    if secs < 86400:
        return f"{round(secs / 3600)}h"
    days = secs / 86400
    if days < 30:
        return f"{round(days)}d"
    if days < 365:
        return f"{days / 30:.1f}mo".replace(".0mo", "mo")
    return f"{days / 365:.1f}y".replace(".0y", "y")


def previews(card, now=None, ret=None):
    """What each answer button would do, Anki-style: {"1": "1m", "2": "6m", "3": "10m", "4": "16d"}."""
    now = now or time.time()
    ret = ret or retention()
    return {str(g): fmt_interval(schedule(card["srs"], g, now, ret, card["id"])["due"] - now) for g in RATINGS}


def retention():
    try:
        return min(0.97, max(0.7, float(config.load().get("cards_retention") or 0.9)))
    except (TypeError, ValueError):
        return 0.9


def day_start(now=None):
    """Days roll over at 4am (like Anki), so a late-night session still counts as 'today'."""
    now = now or time.time()
    lt = time.localtime(now)
    start = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 4, 0, 0, 0, 0, -1))
    return start - 86400 if now < start else start


# ------------------------------------------------------------------ storage


def deck_file(path):
    return CARDS / (hashlib.sha1(str(path).encode()).hexdigest()[:16] + ".json")


def load(path):
    return lib._load(deck_file(path), None)


def save(deck):
    with _lock:
        lib._save(deck_file(deck["path"]), deck)


def all_decks():
    out = []
    for f in sorted(CARDS.glob("*.json")):
        d = lib._load(f, None)
        if d and d.get("path"):
            out.append(d)
    return out


def counts(deck, now=None):
    now = now or time.time()
    end = day_start(now) + 86400
    c = {"new": 0, "learning": 0, "due": 0, "total": 0, "suspended": 0, "mature": 0, "leeches": 0}
    for card in deck.get("cards", []):
        c["total"] += 1
        if card.get("suspended"):
            c["suspended"] += 1
            continue
        s = card["srs"]
        if s["state"] == "new":
            c["new"] += 1
        elif s["state"] in ("learning", "relearning"):
            c["learning"] += 1
            if s["due"] < end:
                c["due"] += 1
        elif s["due"] < end:
            c["due"] += 1
        if s["state"] == "review" and (s.get("stability") or 0) >= 21:
            c["mature"] += 1
        if card.get("leech"):
            c["leeches"] += 1
    return c


# ------------------------------------------------------------------ what the cards are made from

# The chat's one-click prompts ("Explain this slide.") show where the student was, not what confused them.
CANNED = {"Explain this slide.", "Explain this slide more simply, like I'm new to the topic.",
          "Give me a concrete worked example of what this slide is about.",
          "How does this slide connect to the earlier and later slides? What's the big picture?",
          "Quiz me with 3 short questions on this slide, then wait for my answers."}


def _own_questions(msgs, since=0.0):
    return [m for m in msgs if m.get("role") == "user" and (m.get("ts") or 0) > since
            and (m.get("text") or "").strip() not in CANNED]


def chat_context(path, since=0.0, limit=70000):
    """The student's questions (and the gist of each answer) since `since`, oldest first."""
    msgs = lib.load_chat(path)["messages"]
    out, i = [], 0
    while i < len(msgs):
        m = msgs[i]
        if m.get("role") == "user" and (m.get("ts") or 0) > since:
            q = (m.get("text") or "").strip()
            a = (msgs[i + 1].get("text") or "").strip() if i + 1 < len(msgs) and msgs[i + 1].get("role") == "bot" else ""
            tag = "one-click prompt" if q in CANNED else "own question"
            out.append(f"[slide {m.get('slide')} · {tag}] STUDENT: {q[:900]}\nTUTOR (start of answer): {a[:1200]}")
            i += 2 if a else 1
            continue
        i += 1
    text = "\n\n".join(out)
    return text[-limit:] if len(text) > limit else text


def lectures_for(path):
    return [m for m in lecture.list_for_deck(path) if m.get("status") == "done"]


def notes_context(path, limit=160000):
    parts = []
    for m in sorted(lectures_for(path), key=lambda m: m.get("started", 0)):
        notes = lib._load(lecture.ldir(m["id"]) / "notes.json", None)
        if not notes:
            continue
        parts.append(f"## Lecture on {m.get('date')}: summary (incl. exam tips)\n{notes.get('summary_md', '')}")
        for n, s in sorted(notes.get("slides", {}).items(), key=lambda kv: int(kv[0])):
            quotes = " / ".join(q["text"] for q in s.get("quotes", []))[:1200]
            parts.append(f"### Slide {n}: what the lecturer said\n{s.get('notes_md', '')}" + (f"\nVerbatim: {quotes}" if quotes else ""))
    return "\n\n".join(parts)[:limit]


# ------------------------------------------------------------------ writing cards with the AI

PROMPT = """You are writing spaced-repetition flashcards (like Anki) for a university student. Attached: the full
lecture deck "{title}"{course}. The student will review these cards over weeks with active recall, mixed in
with cards from their other courses.

{sources}

HOW TO WRITE THE CARDS (evidence-based rules; follow them strictly):
1. One idea per card (minimum information principle). The answer is short: a term, a formula, a phrase or 1–3
   sentences. Split anything bigger into several cards. Never ask for a list of more than 3 items; use several
   cards or a cloze instead.
2. Make the student recall and understand, not recognise. Prefer "why", "how", "what happens if", "what's the
   difference between", "apply it to this case" over bare definitions. No yes/no questions, no "true or false".
3. Each card stands alone: name the topic in the question ("In logistic regression, …", "In Copeland's view, …"),
   because cards are shuffled with other courses.
4. Follow the lecturer. What they emphasised, repeated, warned about ("common misconception") or flagged as
   examinable comes first and gets FLAGS: exam. Use their framing, terms and examples. If their version differs
   from a textbook, use theirs.
5. Never invent facts that aren't in the slides, the lecture notes or the tutor's answers.
6. Skip admin (deadlines, rooms, software set-up) and anything trivial.

ADAPT TO THE SUBJECT (decide what kind of deck this is first):
- Conceptual / humanities (e.g. philosophy): definitions in the course's own terms; who argued what; the
  structure of an argument (premises → conclusion); objections and replies; thought experiments and what they are
  meant to show; distinctions between easily confused ideas; "apply this concept to a new case".
- Science / engineering (e.g. robotics, sensors): how a mechanism works, cause → effect, why a design choice or
  trade-off, comparing alternatives, diagnosing a scenario. Numbers and units only if the lecturer stressed them.
- Maths-heavy (e.g. ML theory): key formulas to recall (with what each symbol means), conditions and assumptions,
  intuition ("what happens if the learning rate is too large?"), "what is the next step of this derivation, and
  why?" for derivations the lecturer walked through, and short practice problems (TYPE: problem) that take under
  3 minutes on paper, with a worked answer. Never make a card whose answer is a long proof: break it into steps.
- Programming: what a snippet does or outputs, tensor shapes / types, which function does which job, common
  errors and their fix. Put code in fenced code blocks.

{chat_rules}

CARD TYPES:
- qa: a question (Q) and its answer (A).
- cloze: a sentence with ONE key part hidden as {{{{c::hidden part}}}} (at most two). Put it in Q; A may add a short
  extra note or be empty. Never put {{{{c::…}}}} inside $…$: wrap the whole formula instead, {{{{c::$x^2$}}}}.
- problem: a short exercise in Q, a worked solution in A.
Optionally add WHY: 1–2 sentences of elaboration shown after the answer (why it matters / how it connects to the
rest of the lecture). Use it for the cards where it genuinely helps.

SUBTOPICS: group the cards into 3–8 subtopics in lecture order (coherent chunks the student can study one at a
time, e.g. "Turing machines", "Universal machines & stored programs", "The Symbol System Hypothesis").

HOW MANY: about one card per substantive idea the lecture covered: typically 25–60 for a full lecture, fewer for
short or admin-heavy decks. Quality over quantity.
{update_rules}
Write maths in Markdown with LaTeX ($…$, $$…$$). This is plain text, not JSON: write LaTeX normally (\\frac, \\sigma).

OUTPUT exactly this plain-text format, nothing else (no code fences around it, no commentary):

===DECK===
KIND: <conceptual | engineering | mathematical | programming | mixed>
===SUBTOPIC 1: <short title>===
SLIDES: <slide numbers, e.g. 3-9, 12>
SUMMARY: <one line: what this subtopic is about>
===SUBTOPIC 2: <short title>===
…
===CARD===
SUBTOPIC: <subtopic number>
TYPE: <qa | cloze | problem>
SLIDES: <the 1–3 slide numbers this card comes from>
SOURCE: <any of: slides, lecture, chat>
FLAGS: <exam and/or struggle, or none>
Q:
<question, Markdown>
A:
<answer, Markdown>
WHY:
<optional elaboration>
===CARD===
…
"""

CHAT_RULES_FULL = """THE STUDENT'S QUESTIONS: below are the questions they asked the AI tutor while revising this deck. Each genuine
confusion ("what is X", "I don't understand Y", "why …", asking for something to be re-explained) means that idea
is hard for them: write at least one card that targets exactly that point, ideally from the angle that finally
made it click in the tutor's answer, and give it FLAGS: struggle (plus exam if it is also examinable). One-click
prompts like "Explain this slide." only show which slides they studied. Ignore set-up / logistics questions."""

UPDATE_RULES = """
THIS IS AN UPDATE: the deck already has the cards listed under EXISTING CARDS. Output ONLY new cards that add
something: {update_focus} Do not repeat or rephrase an existing card. Keep the existing subtopic numbers; add a
new ===SUBTOPIC n=== block (numbered after the existing ones) only if new cards don't fit any of them. If nothing
new is worth a card, output just the ===DECK=== block.
"""


def _sources_text(path, mode, deck):
    parts = []
    notes = notes_context(path)
    if notes:
        parts.append("LECTURE NOTES (what the lecturer actually said, matched to slides; the summary's exam tips matter most):\n\n" + notes)
    else:
        parts.append("There are no notes from the lecture itself, so work from the slides.")
    since = (deck or {}).get("chat_ts", 0) if mode == "update" else 0
    chats = chat_context(path, since)
    if chats:
        parts.append(("NEW " if since else "") + "QUESTIONS THE STUDENT ASKED THE TUTOR ABOUT THIS DECK" +
                     (" (since the cards were last updated)" if since else "") + ":\n\n" + chats)
    if mode == "update" and deck and deck.get("cards"):
        subs = "\n".join(f"{i}. {t['title']}" for i, t in enumerate(deck["subtopics"], 1))
        existing = "\n".join(f"- [{_sub_no(deck, c['subtopic'])}] {_plain(c['front'])[:220]}" for c in deck["cards"])
        parts.append(f"EXISTING SUBTOPICS:\n{subs}\n\nEXISTING CARDS (front only):\n{existing}")
        leeches = [c for c in deck["cards"] if c.get("leech") or c["srs"].get("lapses", 0) >= 3]
        if leeches:
            parts.append("CARDS THE STUDENT KEEPS FORGETTING (add one supporting card for each from a different angle: a "
                         "simpler sub-question, a concrete example, or a contrast with what it gets confused with):\n" +
                         "\n".join(f"- Q: {_plain(c['front'])[:300]}\n  A: {_plain(c['back'])[:300]}" for c in leeches[:12]))
    return "\n\n---\n\n".join(parts)


def _sub_no(deck, sid):
    return next((i for i, t in enumerate(deck["subtopics"], 1) if t["id"] == sid), "?")


def _plain(md):
    return re.sub(r"\s+", " ", md or "").strip()


def _slides(text, maxn=0, cap=40):
    out = []
    for a, b in re.findall(r"(\d+)\s*(?:[-–]\s*(\d+))?", text or ""):
        a, b = int(a), int(b or a)
        for n in range(a, min(max(a, b), a + 60) + 1):
            if (not maxn or 1 <= n <= maxn) and n not in out:
                out.append(n)
    return out[:cap]


BLOCK = re.compile(r"^===\s*(DECK|CARD|SUBTOPIC\s+(\d+)\s*:\s*(.*?))\s*===\s*$", re.M)
SECTION = re.compile(r"^(Q|A|WHY):[ \t]*(.*)$", re.M)
CLOZE = re.compile(r"\{\{c\d*::(.+?)(?:::(.*?))?\}\}", re.S)


def parse(text, pages=0):
    """The AI's plain-text answer → (kind, {number: subtopic}, [card dicts])."""
    kind, subs, cards = "", {}, []
    marks = list(BLOCK.finditer(text))
    for i, m in enumerate(marks):
        body = text[m.end(): marks[i + 1].start() if i + 1 < len(marks) else len(text)].strip("\n")
        if m.group(1) == "DECK":
            k = re.search(r"^KIND:\s*(.+)$", body, re.M)
            kind = k.group(1).strip().lower() if k else ""
        elif m.group(2):
            sl = re.search(r"^SLIDES:\s*(.*)$", body, re.M)
            sm = re.search(r"^SUMMARY:\s*(.*)$", body, re.M)
            subs[int(m.group(2))] = {"title": m.group(3).strip()[:80] or f"Part {m.group(2)}",
                                     "slides": _slides(sl.group(1), pages) if sl else [],
                                     "summary": sm.group(1).strip()[:240] if sm else ""}
        else:
            card = _parse_card(body, pages)
            if card:
                cards.append(card)
    return kind, subs, cards


def _parse_card(body, pages):
    secs = list(SECTION.finditer(body))
    if not secs:
        return None
    head = body[:secs[0].start()]
    fields = {}
    for j, s in enumerate(secs):
        end = secs[j + 1].start() if j + 1 < len(secs) else len(body)
        fields[s.group(1)] = (s.group(2) + "\n" + body[s.end():end]).strip()
    hv = lambda k: (re.search(rf"^{k}:\s*(.*)$", head, re.M) or [None, ""])[1].strip()
    ctype = hv("TYPE").lower()
    ctype = ctype if ctype in ("qa", "cloze", "problem") else "qa"
    front, back = fields.get("Q", ""), fields.get("A", "")
    if ctype == "cloze" and not CLOZE.search(front):
        ctype = "qa"
    if not front or (ctype != "cloze" and not back):
        return None
    flags = hv("FLAGS").lower()
    sub = re.search(r"\d+", hv("SUBTOPIC"))
    return {"subtopic_no": int(sub.group()) if sub else 1, "type": ctype, "front": front[:4000], "back": back[:6000],
            "why": fields.get("WHY", "")[:2000], "slides": _slides(hv("SLIDES"), pages, 3),
            "source": [s for s in ("slides", "lecture", "chat") if s in hv("SOURCE").lower()],
            "exam": "exam" in flags, "struggle": "struggle" in flags}


def _make(path, mode, deck):
    """Run the AI and merge its cards into the deck (a new deck, or new cards for an existing one)."""
    info = lecture.deck_info(path)
    pages = providers.page_count(path)
    update = mode == "update" and deck and deck.get("cards")
    focus = {"lecture": "material from the newest lecture notes that the existing cards don't cover yet, plus",
             "chats": "above all, the student's NEW questions (each genuine confusion → a targeted card), plus"}
    prompt = PROMPT.format(
        title=info["deck_title"], course=f" (course: {info['course']})" if info.get("course") else "",
        sources=_sources_text(path, "update" if update else "full", deck),
        chat_rules=CHAT_RULES_FULL,
        update_rules=UPDATE_RULES.format(update_focus=(focus.get(deck.get("_why")) or "") + " any important idea that is still missing, and support cards for cards the student keeps forgetting.") if update else "")
    started = time.time()
    text = providers.current().with_pdf(path, prompt, providers.model_for("notes"))
    kind, subs, cards = parse(text, pages)
    if not cards and not update:
        raise RuntimeError("Couldn't read any cards from the AI's answer.")
    with _lock:
        cur = load(path) or deck or {}
        if not update:
            cur = {"path": path, "created": cur.get("created") or started, "subtopics": [], "cards": [], "log": cur.get("log", [])}
        cur.update(path=path, title=info["deck_title"], course=info.get("course"), course_dir=info.get("course_dir"))
        if kind:
            cur["kind"] = kind
        # Subtopic numbers in the answer → ids. In an update, 1..n are the existing ones.
        ids = {i: t["id"] for i, t in enumerate(cur["subtopics"], 1)} if update else {}
        for no, t in sorted(subs.items()):
            if no in ids:
                continue
            tid = "t" + uuid.uuid4().hex[:6]
            cur["subtopics"].append({"id": tid, **t})
            ids[no] = tid
        if not cur["subtopics"]:
            cur["subtopics"].append({"id": "t" + uuid.uuid4().hex[:6], "title": "Key ideas", "slides": [], "summary": ""})
        seen = {_plain(c["front"]).lower() for c in cur["cards"]}
        added = 0
        for c in cards:
            key = _plain(c["front"]).lower()
            if key in seen:
                continue
            seen.add(key)
            no = c.pop("subtopic_no")
            c.update(id="c" + uuid.uuid4().hex[:10], subtopic=ids.get(no) or cur["subtopics"][-1]["id"],
                     created=time.time(), srs=new_srs())
            cur["cards"].append(c)
            added += 1
        cur["updated"] = time.time()
        cur["chat_ts"] = max([m.get("ts") or 0 for m in lib.load_chat(path)["messages"]] + [cur.get("chat_ts", 0)])
        cur["lectures"] = sorted({m["id"] for m in lectures_for(path)})
        cur.pop("error", None)
        cur.pop("error_at", None)
        cur["last_added"] = added
        save(cur)
    write_markdown(cur)
    return cur, added


# ------------------------------------------------------------------ the job queue (one AI call at a time)

JOBS = {}  # path → {"state": "queued" | "running", "mode": ..., "why": ..., "since": ts}
_jobq = queue.Queue()


def job(path):
    return JOBS.get(path)


def request(path, mode="auto", why="manual"):
    """Queue a build. mode: auto (new deck, or add to an existing one) · rebuild (rewrite the unreviewed cards)."""
    if path in JOBS:
        return JOBS[path]
    JOBS[path] = {"state": "queued", "mode": mode, "why": why, "since": time.time()}
    _jobq.put(path)
    return JOBS[path]


def _worker():
    while True:
        path = _jobq.get()
        j = JOBS.get(path)
        if not j:
            continue
        j.update(state="running", since=time.time())
        try:
            deck = load(path)
            if deck and j["mode"] == "rebuild":  # rewrite the cards not studied yet; keep the ones with history
                with _lock:
                    deck["cards"] = [c for c in deck["cards"] if c["srs"].get("reps")]
                    used = {c["subtopic"] for c in deck["cards"]}
                    deck["subtopics"] = [t for t in deck["subtopics"] if t["id"] in used]
                    save(deck)
            if deck is not None:
                deck["_why"] = j["why"]
            mode = "update" if deck and deck.get("cards") else "full"
            _, added = _make(path, mode, deck)
            print(f"flashcards: {Path(path).name}: {mode}, {added} new cards", flush=True)
        except Exception as e:
            print("flashcards failed", path, e, flush=True)
            deck = load(path) or {"path": path, "title": Path(path).stem, "subtopics": [], "cards": [], "log": []}
            deck.pop("_why", None)
            deck.update(error=str(e)[:400], error_at=time.time())
            save(deck)
        finally:
            JOBS.pop(path, None)


threading.Thread(target=_worker, daemon=True).start()


def on_notes_done(meta):
    """A lecture's notes were just written: make (or top up) that deck's flashcards."""
    if config.load().get("cards_auto", True) and meta.get("deck"):
        request(meta["deck"], "auto", "lecture")


def check_chats(quiet_for=20 * 60, min_questions=2):
    """After a revision session in the chat has gone quiet, add cards for what the student asked."""
    if not config.load().get("cards_from_chats", True):
        return
    now = time.time()
    for d in all_decks():
        if not d.get("cards") or d["path"] in JOBS or now - d.get("error_at", 0) < 6 * 3600:
            continue  # (after a failure, don't retry on our own for a while: each try costs plan usage)
        msgs = lib.load_chat(d["path"])["messages"]
        if not msgs or now - (msgs[-1].get("ts") or 0) < quiet_for:
            continue
        if len(_own_questions(msgs, d.get("chat_ts", 0))) >= min_questions and Path(d["path"]).exists():
            request(d["path"], "auto", "chats")


def catch_up():
    """On startup: lectures whose notes were finished while flashcards couldn't be made (app quit mid-way)."""
    cfg = config.load()
    since = cfg.get("cards_since") or 0
    if not since:
        config.update({"cards_since": time.time()})  # the backlog from before flashcards existed is opt-in
        return
    if not cfg.get("cards_auto", True):
        return
    have = {d["path"]: set(d.get("lectures", [])) for d in all_decks() if d.get("cards")}
    for d in lecture.LECTURES.iterdir():
        m = lib._load(d / "meta.json", None)
        if m and m.get("status") == "done" and (m.get("finished") or 0) > since and m.get("deck") \
                and m["id"] not in have.get(m["deck"], set()) and Path(m["deck"]).exists():
            request(m["deck"], "auto", "lecture")


# ------------------------------------------------------------------ studying


def overview():
    """Every deck with cards (and its counts), lectures that have notes but no cards yet, and today's stats."""
    now = time.time()
    decks, empty = [], {}
    for d in all_decks():
        if not d.get("cards"):  # a first build that failed (or is being made)
            empty[d["path"]] = d
            continue
        decks.append({"path": d["path"], "title": d.get("title"), "course": d.get("course"), "counts": counts(d, now),
                      "error": d.get("error"), "updated": d.get("updated"), "job": job(d["path"]),
                      "exists": Path(d["path"]).exists(),
                      "new_questions": len(_own_questions(lib.load_chat(d["path"])["messages"], d.get("chat_ts", 0)))})
    have = {d["path"] for d in decks}
    backlog = {}
    for d in lecture.LECTURES.iterdir():
        m = lib._load(d / "meta.json", None)
        if m and m.get("status") == "done" and m.get("deck") and m["deck"] not in have and Path(m["deck"]).exists():
            b = backlog.setdefault(m["deck"], {"path": m["deck"], "title": m.get("deck_title"), "course": m.get("course"),
                                               "date": m.get("date")})
            b["date"] = max(b["date"] or "", m.get("date") or "")
    for p in set(empty) | set(JOBS):  # decks being made, or whose first build failed
        if p not in have and p not in backlog:
            backlog[p] = {"path": p, "title": (empty.get(p) or {}).get("title") or Path(p).stem,
                          "course": (lib.course_folder_for(p) or Path()).name, "date": ""}
    for p, b in backlog.items():
        b["job"] = job(p)
        b["error"] = (empty.get(p) or {}).get("error")
    return {"decks": decks, "backlog": sorted(backlog.values(), key=lambda b: b.get("date") or "", reverse=True),
            "today": today()}


def today(decks=None):
    """Reviews done today, new cards introduced today (against the daily allowance), and the day streak."""
    now = time.time()
    start = day_start(now)
    reviewed, new_today, days = 0, 0, set()
    for d in decks if decks is not None else all_decks():
        for e in d.get("log", []):
            days.add(day_start(e["t"]))
            if e["t"] >= start:
                reviewed += 1
                new_today += bool(e.get("was_new"))
    streak, day = 0, start if start in days else day_start(start - 3600)
    while day in days:
        streak += 1
        day = day_start(day - 3600)  # the 4am before (an hour back is still yesterday, even across DST)
    limit = int(config.load().get("cards_new_per_day") or 20)
    return {"reviewed": reviewed, "new": new_today, "new_limit": limit, "new_left": max(0, limit - new_today), "streak": streak}


def _in_scope(d, scope):
    if scope in ("", "all"):
        return True
    kind, _, val = scope.partition(":")
    return (kind == "deck" and d["path"] == val) or (kind == "course" and d.get("course") == val)


def study_queue(scope="all", subtopic=""):
    """Cards to review now: learning cards and due reviews (shuffled: interleaving beats blocking for retention),
    then new cards (in lecture order) up to today's new-card allowance, spread through the reviews."""
    now = time.time()
    end = day_start(now) + 86400
    decks = all_decks()
    ov_today = today(decks)
    ret = retention()
    reviews, learning, fresh = [], [], {}
    for d in decks:
        if not _in_scope(d, scope) or not Path(d["path"]).exists():
            continue
        order = {t["id"]: i for i, t in enumerate(d["subtopics"])}
        titles = {t["id"]: t["title"] for t in d["subtopics"]}
        for c in d["cards"]:
            if c.get("suspended") or (subtopic and c["subtopic"] != subtopic):
                continue
            item = {**c, "path": d["path"], "deck_title": d.get("title"), "course": d.get("course"),
                    "subtopic_title": titles.get(c["subtopic"], ""), "previews": previews(c, now, ret)}
            st = c["srs"]["state"]
            if st == "new":
                fresh.setdefault(d["path"], []).append((order.get(c["subtopic"], 99), (c.get("slides") or [999])[0], item))
            elif st in ("learning", "relearning") and c["srs"]["due"] < end:
                learning.append(item)
            elif st == "review" and c["srs"]["due"] < end:
                reviews.append(item)
    random.shuffle(reviews)
    new_left = ov_today["new_left"] if not subtopic else max(ov_today["new_left"], 10)  # studying one subtopic: let it start
    per_deck = [[x[2] for x in sorted(v, key=lambda x: x[:2])] for v in fresh.values()]
    new = []
    while len(new) < new_left and any(per_deck):  # round-robin across lectures
        for lst in per_deck:
            if lst and len(new) < new_left:
                new.append(lst.pop(0))
    mixed, k = [], max(1, len(reviews) // max(1, len(new))) if new else 0
    for i, r in enumerate(reviews):
        mixed.append(r)
        if new and (i + 1) % k == 0:
            mixed.append(new.pop(0))
    mixed += new
    learning.sort(key=lambda c: c["srs"]["due"])
    more_new = sum(len(v) for v in fresh.values()) - sum(1 for c in mixed if c["srs"]["state"] == "new")
    return {"cards": learning + mixed, "now": now, "learn_ahead": LEARN_AHEAD, "more_new": more_new}


def _find(path, cid):
    deck = load(path)
    card = next((c for c in (deck or {}).get("cards", []) if c["id"] == cid), None)
    return deck, card


def review(path, cid, rating):
    with _lock:
        deck, card = _find(path, cid)
        if not card or rating not in RATINGS:
            return {"error": "card not found"}
        now = time.time()
        prev = card["srs"]
        card["srs"] = schedule(prev, rating, now, retention(), cid)
        if card["srs"]["lapses"] >= LEECH_LAPSES:
            card["leech"] = True
        deck.setdefault("log", []).append({"id": cid, "t": now, "g": rating, "prev": prev, "was_new": prev["state"] == "new"})
        save(deck)
    return {"card": {**card, "previews": previews(card, now)}, "now": now}


def undo(path, cid):
    with _lock:
        deck, card = _find(path, cid)
        log = (deck or {}).get("log", [])
        i = next((i for i in range(len(log) - 1, -1, -1) if log[i]["id"] == cid), None)
        if card is None or i is None:
            return {"error": "nothing to undo"}
        card["srs"] = log.pop(i)["prev"]
        if card["srs"].get("lapses", 0) < LEECH_LAPSES:
            card.pop("leech", None)
        save(deck)
    return {"card": {**card, "previews": previews(card)}}


def edit(path, cid, changes):
    with _lock:
        deck, card = _find(path, cid)
        if not card:
            return {"error": "card not found"}
        if changes.get("delete"):
            deck["cards"].remove(card)
        else:
            for k in ("front", "back", "why"):
                if isinstance(changes.get(k), str):
                    card[k] = changes[k][:6000]
            if "suspended" in changes:
                card["suspended"] = bool(changes["suspended"])
            if changes.get("reset"):
                card["srs"] = new_srs()
                card.pop("leech", None)
            if card["type"] == "cloze" and not CLOZE.search(card["front"]):
                card["type"] = "qa"
        save(deck)
    write_markdown(deck)
    return {"ok": True, "card": card}


def delete_deck(path):
    with _lock:
        deck_file(path).unlink(missing_ok=True)
    return {"ok": True}


# ------------------------------------------------------------------ Markdown copy + Anki export


def _out_dir(deck):
    base = Path(deck["course_dir"]) / "SlideMate Flashcards" if deck.get("course_dir") else config.DATA / "flashcards-md"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _stem(deck):
    return re.sub(r'[/:*?"<>|]+', "-", deck.get("title") or Path(deck["path"]).stem)[:120]


def write_markdown(deck):
    if not config.load()["write_markdown"] or not deck.get("cards"):
        return None
    out = [f"# {deck.get('title')}: flashcards", "", f"Deck: `{deck['path']}`", ""]
    for t in deck["subtopics"]:
        cards = [c for c in deck["cards"] if c["subtopic"] == t["id"]]
        if not cards:
            continue
        out += [f"## {t['title']}", "", f"_{t['summary']}_" if t.get("summary") else "", ""]
        for c in cards:
            tags = (" ⭐ exam" if c.get("exam") else "") + (" · from your questions" if c.get("struggle") else "")
            front = CLOZE.sub(lambda m: "[…]", c["front"]) if c["type"] == "cloze" else c["front"]
            back = CLOZE.sub(lambda m: f"**{m.group(1)}**", c["front"]) + ("\n\n" + c["back"] if c["back"] else "") if c["type"] == "cloze" else c["back"]
            out += [f"**Q{tags}:** {front}", "", f"**A:** {back}", ""]
            if c.get("why"):
                out += [f"> {c['why']}", ""]
    f = _out_dir(deck) / f"{_stem(deck)}.md"
    f.write_text("\n".join(out))
    return str(f)


def _anki_html(md):
    """Just enough Markdown → HTML for Anki (maths as MathJax \\( \\) / \\[ \\])."""
    s = md.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    s = re.sub(r"```\w*\n(.*?)```", lambda m: "<pre>" + m.group(1) + "</pre>", s, flags=re.S)
    s = re.sub(r"\$\$(.+?)\$\$", r"\\[\1\\]", s, flags=re.S)
    s = re.sub(r"(?<![\\$])\$([^$\n]+?)\$", r"\\(\1\\)", s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"(?<![\w*\\])\*(?!\s)([^*\n]+?)\*(?!\w)", r"<i>\1</i>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    return s.replace("\t", " ").replace("\n", "<br>")


def export_anki(path):
    """A tab-separated file Anki imports as-is (File → Import): Basic and Cloze notes, tagged by course/subtopic."""
    deck = load(path)
    if not deck or not deck.get("cards"):
        return {"error": "No cards to export"}
    name = "SlideMate::" + "::".join(x.replace("::", ":") for x in filter(None, [deck.get("course"), deck.get("title")]))
    lines = ["#separator:tab", "#html:true", "#notetype column:1", "#deck column:2", "#tags column:5"]
    subs = {t["id"]: t["title"] for t in deck["subtopics"]}
    for c in deck["cards"]:
        tags = " ".join(filter(None, [re.sub(r"\W+", "_", subs.get(c["subtopic"], "")).strip("_"),
                                      "exam" if c.get("exam") else "", "struggle" if c.get("struggle") else ""]))
        extra = c["back"] + ("\n\n" + c["why"] if c.get("why") else "")
        if c["type"] == "cloze":
            n = iter(range(1, 99))
            text = CLOZE.sub(lambda m: "{{c%d::%s%s}}" % (next(n), m.group(1), "::" + m.group(2) if m.group(2) else ""), c["front"])
            lines.append("\t".join(["Cloze", name, _anki_html(text), _anki_html(extra), tags]))
        else:
            lines.append("\t".join(["Basic", name, _anki_html(c["front"]), _anki_html(extra), tags]))
    f = _out_dir(deck) / f"{_stem(deck)} (Anki).txt"
    f.write_text("\n".join(lines) + "\n")
    return {"file": str(f), "count": len(deck["cards"])}
