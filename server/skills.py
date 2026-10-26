"""Study skills: subject-specific ways of asking good questions, and the router that picks which ones a request sees.

A skill is a Markdown file (frontmatter: title, tags, summary; body: when to use it and its question moves). The
built-in ones are in server/study_skills/; files in <data>/study-skills/ add to them, or replace one with the same
file name. Adapted from Agentcomplete's knowledge catalog: retrieval only nominates skills, and the model still
reviews every candidate (keep + score) before using it (see suggest.py).

The router tries, in order, and the first usable result wins:
1. complete catalog: every skill, when the whole catalog fits the operation's budget (no ranking can exclude one);
2. lexical shortlist: tag / title / summary / body overlap with the query (weights 4 / 3 / 2 / 0.5, IDF-ranked),
   up to 3 skills; a skill must match on its metadata, body-only overlap can't nominate it; ambiguous ties defer;
3. subject: the course name and the flashcard deck's kind (conceptual / mathematical / …) mapped to tags.
An empty list is usable too: the model then works from the slide alone.
"""
import math
import re
import threading
import unicodedata
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import config

BUILTIN = Path(__file__).parent / "study_skills"
USER = config.DATA / "study-skills"
MAX_SHORTLIST = 3

_WORDS = re.compile(r"[^\W_]+(?:[.+][^\W_]+)*(?:\+\+|#)?", re.UNICODE)
_STOP = frozenset("""a an the and or so that which by such as including using with to for of in on at from into then than
only all any do does did not no when while where how what why who whom whose is are was were be been being it its this
these those i me my we our you your they their he she his her can could would should will may might must about
explain mean means meaning slide lecture please help understand tell show give example examples question questions
difference between like just also more most very really get got one two""".split())


def tokens(text):
    """Normalised content words. A light stemmer folds plurals and -ing so 'derivations' meets 'derivation'."""
    out = set()
    for w in _WORDS.findall(unicodedata.normalize("NFKC", text or "").casefold()):
        if w in _STOP or len(w) < 2:
            continue
        if not any(c in w for c in ".+#"):
            if len(w) > 4 and w.endswith("ies"):
                w = w[:-3] + "y"
            elif len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
                w = w[:-1]
            elif len(w) > 5 and w.endswith("ing"):
                w = w[:-3]
        if w not in _STOP:
            out.add(w)
    return out


@dataclass(frozen=True)
class Skill:
    id: str
    title: str
    tags: tuple
    summary: str
    body: str

    def render(self, i):
        return f'<skill index="{i}" id="{self.id}">\nTitle: {self.title}\nTags: {", ".join(self.tags)}\n' \
               f"Summary: {self.summary}\n{self.body.strip()}\n</skill>"


@dataclass(frozen=True)
class Catalog:
    skills: tuple
    weights: tuple   # per skill: {term: weight}
    meta: tuple      # per skill: frozenset of metadata terms
    idf: dict
    stamp: tuple     # file names + mtimes: changes when a skill file does


@dataclass
class Retrieval:
    route: str           # "catalog" | "lexical" | "subject" | "none"
    skills: list


def _parse(f):
    text = f.read_text(encoding="utf-8")
    meta, body = {}, text
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", text, re.S)
    if m:
        body = m.group(2)
        for line in m.group(1).splitlines():
            k, _, v = line.partition(":")
            meta[k.strip().lower()] = v.strip()
    title = meta.get("title") or f.stem.replace("-", " ").capitalize()
    tags = tuple(t.strip().lower() for t in meta.get("tags", "").split(",") if t.strip())
    return Skill(f.stem, title[:120], tags[:24], meta.get("summary", "")[:400], body[:6000])


def _files():
    files = {f.name: f for f in sorted(BUILTIN.glob("*.md"))}
    if USER.is_dir():
        files.update({f.name: f for f in sorted(USER.glob("*.md"))})  # the student's own skills win
    return [files[n] for n in sorted(files)]


_cache = None
_lock = threading.Lock()


def catalog():
    """The current catalog, rebuilt only when a skill file is added, removed or edited."""
    global _cache
    files = _files()
    stamp = tuple((str(f), f.stat().st_mtime) for f in files)
    with _lock:
        if _cache and _cache.stamp == stamp:
            return _cache
        skills, weights, meta, df = [], [], [], Counter()
        for f in files:
            try:
                s = _parse(f)
            except Exception as e:
                print("study skill unreadable", f, e, flush=True)
                continue
            w = {}
            for text, weight in ((" ".join(s.tags), 4), (s.title, 3), (s.summary, 2), (s.body, 0.5)):
                for t in tokens(text):
                    w[t] = w.get(t, 0.0) + weight
            skills.append(s)
            weights.append(w)
            meta.append(frozenset(tokens(" ".join([*s.tags, s.title, s.summary]))))
            df.update(w.keys())
        n = len(skills)
        idf = {t: math.log(1 + (n - c + 0.5) / (c + 0.5)) for t, c in df.items()}
        _cache = Catalog(tuple(skills), tuple(weights), tuple(meta), idf, stamp)
        return _cache


def is_current(cat):
    """Still the same skill files? (Checked after generation: a suggestion made with edited skills is dropped.)"""
    return cat.stamp == catalog().stamp


def _fits(skills, budget):
    return sum(len(s.render(i)) for i, s in enumerate(skills)) <= budget


def select_lexical(cat, query):
    q = tokens(query)
    scored = []
    for s, w, meta in zip(cat.skills, cat.weights, cat.meta):
        if not q & meta:
            continue  # body-only overlap can't nominate a skill
        score = sum(cat.idf.get(t, 0) * w[t] / (w[t] + 1.2) for t in q if t in w)
        scored.append((score, s, q & meta))
    if not scored:
        return None
    scored.sort(key=lambda x: -x[0])
    # More candidates than we can take, all leaning on the same single metadata term: don't guess between them.
    if len(scored) > MAX_SHORTLIST and len({frozenset(x[2]) for x in scored[:MAX_SHORTLIST + 1]}) == 1 \
            and len(scored[0][2]) == 1:
        return None
    return [s for _, s, _ in scored[:MAX_SHORTLIST]]


KIND_TAGS = {"mathematical": "maths derivation formula", "programming": "programming code algorithm",
             "engineering": "engineering mechanism system", "conceptual": "argument theory concept"}


def select_subject(cat, course, kind):
    hint = " ".join(filter(None, [course, KIND_TAGS.get((kind or "").lower(), "")]))
    picked = select_lexical(cat, hint) if hint.strip() else None
    general = [s for s in cat.skills if "general" in s.tags]
    return (picked or []) + [s for s in general if s not in (picked or [])][:1]


def route(query, budget, course="", kind=""):
    """The skills a request reviews. `budget` bounds the complete-catalog route (characters of rendered skills)."""
    cat = catalog()
    if not cat.skills:
        return cat, Retrieval("none", [])
    if _fits(cat.skills, budget):
        return cat, Retrieval("catalog", list(cat.skills))
    picked = select_lexical(cat, query)
    if picked:
        return cat, Retrieval("lexical", picked)
    return cat, Retrieval("subject", select_subject(cat, course, kind))


def render(skills):
    return "\n\n".join(s.render(i) for i, s in enumerate(skills))


def listing():
    cat = catalog()
    user = {f.stem for f in USER.glob("*.md")} if USER.is_dir() else set()
    return {"skills": [{"id": s.id, "title": s.title, "tags": list(s.tags), "summary": s.summary, "own": s.id in user}
                       for s in cat.skills], "folder": str(USER)}
