"""AI providers. SlideMate drives a CLI you're already signed in to, so no API keys are needed:

- "claude": Claude Code (`claude`) using your Claude subscription. Gets the full PDF natively (text + visuals).
- "codex":  Codex CLI (`codex`) using "Sign in with ChatGPT". Gets the deck's text plus an image of your slide.
- "cursor": Cursor CLI (`cursor-agent`) using your Cursor account. Gets the deck's text; opens the slide image itself.
- "grok":   Grok CLI (`grok`) using your grok.com / SuperGrok account. Gets the deck's text plus an image of your slide.
- "antigravity": Antigravity CLI (`agy`) using your Google account (the free plan works). Gets the deck's text;
  opens the slide image itself.
- "ollama": a model running on this Mac through Ollama (free, offline). Gets the deck's text plus an image of your
  slide if the model can see images.
"""
import base64
import glob
import json
import os
import queue
import re
import subprocess
import time
import threading
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import config
import mcp

TUTOR_PROMPT = """You are a patient, sharp university tutor built into the student's slide viewer.
You have the ENTIRE lecture deck. With each question you also get an image of the slide the student is
looking at and its slide number.

How to answer:
- Anchor on the current slide, but use the rest of the deck for context: say how it connects to what came
  before and what it sets up later (cite slide numbers like "slide 12").
- Explain intuitively first, then precisely. Unpack notation, diagrams, equations and jargon on the slide.
- If you're given notes from the actual lecture (what the lecturer said), they matter most: build the explanation
  around what the lecturer actually said about this slide — their framing, examples, emphasis and any exam hints —
  and say so ("In the lecture, they…"). Quote them briefly where it helps.
- Only if there are no lecture notes and a slide is terse (bullet fragments, a lone diagram), fill in what the
  lecturer is most likely saying.
- Use short paragraphs, bullets and worked examples where useful. Use LaTeX with $...$ / $$...$$ for maths.
- Be concise by default; go deeper when asked. Don't repeat the slide text back verbatim.
- The student may attach their own pictures, often photos of handwritten lecture notes. Read them carefully
  (handwriting, arrows, sketches, crossed-out bits), briefly say what you read wherever it's ambiguous, then explain
  the ideas and tie them to the relevant slides. Gently point out anything in the notes that looks wrong.
- You may have tools connected to the student's accounts (e.g. their university VLE). Use them when a question needs
  live information — deadlines, announcements, other course materials — and say briefly what you looked up.
  Otherwise answer from the deck.
"""


def _tool_label(name):
    """'mcp__blackboard__bb_upcoming' → 'blackboard › bb_upcoming'."""
    parts = name.split("__")
    return " › ".join(parts[1:]) if parts[0] == "mcp" and len(parts) > 2 else name


# ------------------------------------------------------------------ models, effort, usage

CLAUDE_MODELS = [
    {"id": "opus", "label": "Opus 5.5", "desc": "Most capable for deep explanations"},
    {"id": "sonnet", "label": "Sonnet 5.5", "desc": "Fast and smart, the everyday choice"},
    {"id": "fable", "label": "Fable 5.1", "desc": "Most powerful, slower"},
    {"id": "haiku", "label": "Haiku 4.5", "desc": "Fastest, lightest"},
]
CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"]
LIMITS = {}  # provider → latest plan-usage windows reported by the CLI


def window_label(minutes=None, key=""):
    if key == "five_hour" or minutes == 300:
        return "5-hour limit"
    if key == "seven_day" or minutes == 10080:
        return "Weekly limit"
    if minutes:
        return f"{minutes // 60}-hour limit" if minutes < 1440 else f"{minutes // 1440}-day limit"
    return key.replace("_", " ").capitalize() or "Limit"


def codex_models():
    try:
        data = json.loads((config.HOME / ".codex" / "models_cache.json").read_text())
    except Exception:
        return []
    out = []
    for m in data if isinstance(data, list) else data.get("models", []):
        if m.get("visibility", "list") != "list":
            continue
        out.append({"id": m["slug"], "label": m.get("display_name") or m["slug"], "desc": (m.get("description") or "")[:80],
                    "context_window": m.get("context_window"),
                    "efforts": [e["effort"] for e in m.get("supported_reasoning_levels", []) if e.get("effort") != "ultra"],
                    "default_effort": m.get("default_reasoning_level")})
    return out


def catalogue(everything=False):
    """Models + effort for each provider. Cursor's and Antigravity's lists are network calls, so they're only
    fetched when that provider is in use or Settings asks for every list."""
    cfg = config.load()
    return {"provider": cfg["provider"],
            "claude": {"models": CLAUDE_MODELS, "efforts": CLAUDE_EFFORTS, "model": cfg["claude_model"], "effort": cfg["claude_effort"]},
            "codex": {"models": codex_models(), "model": cfg["codex_model"], "effort": cfg["codex_effort"]},
            "cursor": {"models": cursor_models(fetch=everything or cfg["provider"] == "cursor"), "efforts": [],
                       "model": cfg["cursor_model"], "effort": ""},
            "grok": {"models": grok_models(), "model": cfg["grok_model"], "effort": cfg["grok_effort"]},
            "antigravity": {"models": antigravity_models(fetch=everything or cfg["provider"] == "antigravity"),
                            "default_efforts": AGY_EFFORTS, "model": cfg["antigravity_model"],
                            "effort": cfg["antigravity_effort"]},
            "ollama": {"models": ollama_models(), "efforts": [], "model": cfg["ollama_model"], "effort": ""},
            "limits": LIMITS.get(cfg["provider"], [])}


# ------------------------------------------------------------------ PDF helpers


def page_count(pdf):
    try:
        out = subprocess.run([config.which("pdfinfo") or "pdfinfo", str(pdf)], capture_output=True, text=True,
                             timeout=20, env=config.ENV).stdout
        m = re.search(r"Pages:\s+(\d+)", out)
        return int(m.group(1)) if m else 0
    except Exception:
        return 0


def deck_text(pdf, limit=400_000):
    """Text of every slide, marked with slide numbers."""
    try:
        text = subprocess.run([config.which("pdftotext") or "pdftotext", "-layout", str(pdf), "-"],
                              capture_output=True, text=True, timeout=120, env=config.ENV).stdout
    except Exception:
        return ""
    body = "\n\n".join(f"=== Slide {i + 1} ===\n{t.strip()}" for i, t in enumerate(text.split("\f")) if t.strip())
    return body[:limit]


def first_page_text(pdf, n=500):
    try:
        t = subprocess.run([config.which("pdftotext") or "pdftotext", "-l", "1", str(pdf), "-"],
                           capture_output=True, text=True, timeout=20, env=config.ENV).stdout
        return re.sub(r"\s+", " ", t).strip()[:n]
    except Exception:
        return ""


def _json_from(text):
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    text = m.group(1) if m else text
    start = min([i for i in (text.find("{"), text.find("[")) if i >= 0], default=0)
    return json.loads(text[start:])


# ------------------------------------------------------------------ Claude Code


class Claude:
    name = "claude"
    label = "Claude"

    @staticmethod
    def bin():
        return config.which("claude")

    def status(self):
        b = self.bin()
        st = {"provider": self.name, "installed": bool(b), "logged_in": False,
              "install": "curl -fsSL https://claude.ai/install.sh | bash", "login": "claude auth login"}
        if b:
            try:
                out = subprocess.run([b, "auth", "status"], capture_output=True, text=True, timeout=20, env=config.ENV).stdout
                info = json.loads(out[out.find("{"):])
                st["logged_in"] = bool(info.get("loggedIn"))
                st["detail"] = info.get("authMethod")
            except Exception as e:
                st["detail"] = str(e)[:200]
        return st

    def _base(self, model):
        return [self.bin(), "-p", "--tools", "", "--no-session-persistence", "--setting-sources", "",
                "--strict-mcp-config", "--model", model]

    def session(self, pdf, model):
        return ClaudeSession(self, pdf, model, config.load()["claude_effort"])

    def oneshot(self, prompt, model=None, timeout=300):
        cmd = self._base(model or config.load()["claude_model"]) + ["--output-format", "json"]
        out = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=timeout, cwd=config.WORK, env=config.ENV)
        return json.loads(out.stdout).get("result", "")

    def oneshot_json(self, prompt, model=None, timeout=300):
        return _json_from(self.oneshot(prompt, model, timeout))

    def with_pdf(self, pdf, prompt, model=None, timeout=1800):
        """One turn with the whole deck attached (native PDF input)."""
        model = model or config.load()["claude_notes_model"]
        content = _claude_deck_blocks(pdf) + [{"type": "text", "text": prompt}]
        msg = {"type": "user", "message": {"role": "user", "content": content}}
        cmd = self._base(model) + ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
        env = {**config.ENV, "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "64000"}
        p = subprocess.run(cmd, input=json.dumps(msg) + "\n", capture_output=True, text=True, timeout=timeout, cwd=config.WORK, env=env)
        for line in reversed(p.stdout.splitlines()):
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") == "result":
                if ev.get("is_error"):
                    raise RuntimeError(ev.get("result") or "Claude error")
                return ev.get("result", "")
        raise RuntimeError("Claude returned nothing: " + p.stderr[-400:])


def _pictures_intro(n):
    return (f"I've attached {n} picture{'s' if n > 1 else ''} of my own (e.g. my handwritten notes from the lecture). "
            "These are not slides from the deck")


def _claude_deck_blocks(pdf):
    name = os.path.basename(pdf)
    pages = page_count(pdf)
    intro = {"type": "text", "text": f'This is the full lecture deck "{name}" ({pages} slides). Read it all for context.'}
    if os.path.getsize(pdf) < 30 * 1024 * 1024 and 0 < pages <= 100:
        data = base64.b64encode(Path(pdf).read_bytes()).decode()
        return [intro, {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": data}, "title": name}]
    return [intro, {"type": "text", "text": deck_text(pdf, 600_000)}]


IDLE_TIMEOUT = 150  # seconds of total silence (no events at all, not even thinking) before we give up


class ClaudeSession:
    """One long-lived `claude -p` process per deck: the deck is sent once, follow-ups keep full context.

    A reader thread moves Claude's output onto a queue, so a turn can be stopped at any moment, a silent
    process is detected (IDLE_TIMEOUT), and stderr is drained so Claude can never block on a full pipe.
    """

    def __init__(self, provider, pdf, model, effort=""):
        self.p, self.pdf, self.model, self.effort = provider, pdf, model, effort
        self.lock = threading.Lock()
        self.proc = None
        self.q = None
        self.primed = False
        self.cancelled = False
        self.last_used = time.time()
        self.stderr_tail = ""

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def close(self):
        if self.proc is not None and self.proc.poll() is None:
            try:
                self.proc.kill()
            except Exception:
                pass
        self.proc = None
        self.primed = False

    def cancel(self):
        """Stop the current answer (the next question starts a fresh process with the chat history as context)."""
        self.cancelled = True
        self.close()

    def _start(self):
        cmd = self.p._base(self.model) + ["--input-format", "stream-json", "--output-format", "stream-json",
                                          "--verbose", "--include-partial-messages", "--system-prompt", TUTOR_PROMPT]
        cmd += mcp.claude_args()
        if self.effort in CLAUDE_EFFORTS:
            cmd += ["--effort", self.effort]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                cwd=config.WORK, text=True, bufsize=1, env=config.ENV)
        q = queue.Queue()

        def pump_out():
            for line in proc.stdout:
                q.put(line)
            q.put(None)  # EOF

        def pump_err():
            for line in proc.stderr:
                self.stderr_tail = (self.stderr_tail + line)[-2000:]
        threading.Thread(target=pump_out, daemon=True).start()
        threading.Thread(target=pump_err, daemon=True).start()
        self.proc, self.q, self.primed = proc, q, False

    def ask(self, question, page, total, image_b64, context="", attachments=()):
        """`attachments`: the student's own pictures as (media_type, b64) pairs."""
        # A previous answer that nobody is waiting for any more (page reloaded, deck switched) must not
        # block this one: cancel it and take over.
        if not self.lock.acquire(timeout=1):
            self.cancel()
            if not self.lock.acquire(timeout=10):
                yield "**Still finishing the previous answer.** Press Stop, then ask again."
                return
        try:
            self.cancelled = False
            self.last_used = time.time()
            if not self.alive():
                self._start()
            content = []
            if not self.primed:
                content += _claude_deck_blocks(self.pdf)
                if context:
                    content.append({"type": "text", "text": context})
            if image_b64:
                content.append({"type": "text", "text": f"Here is slide {page} of {total}, which I'm looking at right now:"})
                content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": image_b64}})
            for i, (media_type, data) in enumerate(attachments):
                if i == 0:
                    content.append({"type": "text", "text": _pictures_intro(len(attachments)) + ":"})
                if len(attachments) > 1:
                    content.append({"type": "text", "text": f"Picture {i + 1}:"})
                content.append({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}})
            content.append({"type": "text", "text": f"[I'm currently on slide {page} of {total}.]\n\n{question}"})
            try:
                self.proc.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": content}}) + "\n")
                self.proc.stdin.flush()
            except (BrokenPipeError, OSError):
                self.close()
                yield "\n\n*(Claude restarted, please ask again.)*"
                return
            self.primed = True
            yield from self._read_turn()
        finally:
            self.last_used = time.time()
            self.lock.release()

    def _read_turn(self):
        streamed, thinking = False, False
        q = self.q
        wait = IDLE_TIMEOUT
        while True:
            try:
                line = q.get(timeout=wait)
            except queue.Empty:
                self.close()
                yield (f"\n\n**Claude didn't respond for {IDLE_TIMEOUT // 60} minutes, so I stopped it.** "
                       "Please ask again (it may be busy right now).")
                return
            if line is None:  # process ended
                if self.cancelled:
                    return
                err = self.stderr_tail.strip()[-600:]
                self.close()
                yield "\n\n**Claude stopped unexpectedly.** Please ask again." + (f"\n\n`{err}`" if err else "")
                return
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            wait = IDLE_TIMEOUT
            t = ev.get("type")
            if t == "system" and ev.get("subtype") == "api_retry":
                # Claude's servers are overloaded / rate-limited: Claude Code retries on its own. Say so, and
                # don't let our silence timeout cut a legitimate retry wait short.
                delay = (ev.get("retry_delay_ms") or 0) / 1000
                wait = max(IDLE_TIMEOUT, delay + 60)
                why = "you've hit a usage limit" if ev.get("error_status") == 429 or ev.get("error") == "rate_limit" \
                    else "Claude's servers are busy" if ev.get("error_status") in (529, 503, 500, 502) or ev.get("error") == "overloaded" \
                    else "Claude didn't answer in time"
                yield ("status", f"{why[0].upper() + why[1:]}, retrying (attempt {ev.get('attempt', '?')} of {ev.get('max_retries', '?')})"
                                 + (f" in {round(delay)}s" if delay >= 2 else "") + "…")
                continue
            if t == "stream_event":
                e = ev.get("event", {})
                et = e.get("type")
                if et == "content_block_delta" and e.get("delta", {}).get("type") == "text_delta":
                    streamed = True
                    yield e["delta"]["text"]
                elif et == "content_block_start":
                    kind = e.get("content_block", {}).get("type")
                    if kind == "tool_use":
                        yield ("status", f"Using {_tool_label(e['content_block'].get('name', 'a tool'))}…")
                        if streamed:
                            yield "\n\n"
                    elif kind in ("thinking", "redacted_thinking") and not thinking:
                        thinking = True
                        yield ("status", "Thinking it through…")
            elif t == "system" and ev.get("subtype") == "status" and ev.get("status") == "requesting" and not streamed:
                yield ("status", "Reading the deck…")
            elif t == "rate_limit_event":
                info = ev.get("rate_limit_info") or {}
                wins = info.get("unifiedWindows") or {}
                LIMITS["claude"] = [{"label": window_label(key=k), "used": w.get("utilization"), "resets_at": w.get("resetsAt")}
                                    for k, w in wins.items()] or LIMITS.get("claude", [])
            elif t == "result":
                if ev.get("is_error"):
                    yield f"\n\n**Error:** {ev.get('result') or ev.get('subtype')}"
                elif not streamed and ev.get("result"):
                    yield ev["result"]
                u = ev.get("usage") or {}
                mu = next(iter((ev.get("modelUsage") or {}).items()), (None, {}))
                used = sum(u.get(k, 0) or 0 for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"))
                yield ("usage", {"context_used": used, "context_window": mu[1].get("contextWindow"), "model": mu[0],
                                 "limits": LIMITS.get("claude", []), "at": time.time()})
                return


# ------------------------------------------------------------------ Codex CLI (ChatGPT sign-in)


NO_TOOLS = ("Do not run any commands or read any files: everything you need is in this message. "
            "Answer directly.")
NO_SHELL = ("Do not run shell commands or read files: the deck is in this message. If connected tools (MCP) are "
            "available and the question needs live information, you may use them.")


class Codex:
    name = "codex"
    label = "ChatGPT (Codex)"

    @staticmethod
    def bin():
        return config.which("codex")

    def status(self):
        b = self.bin()
        st = {"provider": self.name, "installed": bool(b), "logged_in": False,
              "install": "brew install codex   (or: npm install -g @openai/codex)", "login": "codex login"}
        if b:
            try:
                p = subprocess.run([b, "login", "status"], capture_output=True, text=True, timeout=20, env=config.ENV)
                out = (p.stdout + p.stderr).strip()
                st["logged_in"] = "logged in" in out.lower() and "not logged in" not in out.lower()
                st["detail"] = out.splitlines()[-1][:200] if out else ""
            except Exception as e:
                st["detail"] = str(e)[:200]
        return st

    def _cmd(self, resume=None, model=None, images=(), ephemeral=False, tools=False, effort=""):
        model = model if model is not None else config.load()["codex_model"]
        if resume:
            cmd = [self.bin(), "exec", "resume", resume]
        else:
            cmd = [self.bin(), "exec", "-s", "read-only", "-C", str(config.WORK)]
        cmd += ["--json", "--skip-git-repo-check", "--ignore-user-config"]
        if ephemeral:
            cmd.append("--ephemeral")
        if tools:
            cmd += mcp.codex_args()
        if effort:
            cmd += ["-c", f'model_reasoning_effort="{effort}"']
        if model:
            cmd += ["-m", model]
        for img in images:
            cmd += ["-i", str(img)]
        return cmd + ["-"]  # prompt comes on stdin (-i would otherwise swallow it)

    def _run(self, cmd, prompt, timeout, on_proc=None):
        """Run codex exec; yields ("thread", id) and ("text", message) events."""
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                cwd=config.WORK, env=config.ENV, bufsize=1)
        if on_proc:
            on_proc(proc)
        proc.stdin.write(prompt)
        proc.stdin.close()
        timer = threading.Timer(timeout, proc.kill)
        timer.start()
        try:
            for line in proc.stdout:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                t = ev.get("type")
                if t == "thread.started":
                    yield "thread", ev.get("thread_id")
                elif t == "item.completed" and ev.get("item", {}).get("type") == "agent_message":
                    yield "text", ev["item"].get("text", "")
                elif t == "item.started" and ev.get("item", {}).get("type") == "mcp_tool_call":
                    it = ev["item"]
                    yield "status", f"Using {it.get('server')} › {it.get('tool')}…"
                elif t in ("turn.failed", "error"):
                    msg = (ev.get("error") or {}).get("message") if isinstance(ev.get("error"), dict) else ev.get("message")
                    yield "error", msg or json.dumps(ev)[:300]
            proc.wait()
            if proc.returncode not in (0, None):
                err = proc.stderr.read()[-500:]
                if err.strip():
                    yield "error", err
        finally:
            timer.cancel()

    def session(self, pdf, model):
        return CodexSession(self, pdf, model, config.load()["codex_effort"])

    def oneshot(self, prompt, model=None, timeout=600):
        texts, errors = [], []
        for kind, val in self._run(self._cmd(model=model, ephemeral=True), NO_TOOLS + "\n\n" + prompt, timeout):
            (texts if kind == "text" else errors if kind == "error" else []).append(val)
        if not texts:
            raise RuntimeError("Codex returned nothing. " + " ".join(e for e in errors if e)[:400])
        return texts[-1]

    def oneshot_json(self, prompt, model=None, timeout=600):
        return _json_from(self.oneshot(prompt, model, timeout))

    def with_pdf(self, pdf, prompt, model=None, timeout=1800):
        deck = deck_text(pdf)
        return self.oneshot(f"FULL DECK TEXT (slide by slide):\n\n{deck}\n\n---\n\n{prompt}", model, timeout)


class TurnSession:
    """Base for CLIs that run once per question and resume the conversation by id (Codex, Cursor, Grok).
    The deck goes in the first turn; follow-ups resume the CLI's own conversation."""

    def __init__(self, provider, pdf, model, effort=""):
        self.p, self.pdf, self.model, self.effort = provider, pdf, model, effort
        self.lock = threading.Lock()
        self.thread = None  # the CLI's conversation id
        self.proc = None
        self.cancelled = False
        self.last_used = time.time()
        self.dir = config.WORK / f"{provider.name}-{uuid.uuid4().hex[:8]}"
        self.dir.mkdir(parents=True, exist_ok=True)

    def close(self):
        self.cancel()
        self.thread = None

    def cancel(self):
        self.cancelled = True
        if self.proc is not None and self.proc.poll() is None:
            try:
                self.proc.kill()
            except Exception:
                pass

    def _set_proc(self, proc):
        self.proc = proc

    def ask(self, question, page, total, image_b64, context="", attachments=()):
        if not self.lock.acquire(timeout=1):  # an abandoned answer is still running: stop it and take over
            self.cancel()
            if not self.lock.acquire(timeout=10):
                yield "**Still finishing the previous answer.** Press Stop, then ask again."
                return
        try:
            self.cancelled = False
            self.last_used = time.time()
            yield from self._ask(question, page, total, image_b64, context, attachments)
        finally:
            self.proc = None
            self.last_used = time.time()
            self.lock.release()

    def _first_parts(self, total, context):
        """What the first turn carries: the tutor prompt, the whole deck as text, and earlier context."""
        parts = [TUTOR_PROMPT, NO_SHELL if mcp.servers(tutor_only=True) else NO_TOOLS,
                 f'FULL DECK TEXT of "{os.path.basename(self.pdf)}" ({total} slides):\n\n{deck_text(self.pdf)}']
        if context:
            parts.append(context)
        return parts

    def _pictures_note(self, attachments, opener):
        """Saves the student's pictures for a CLI that opens files itself, and says where they are."""
        names = [f"`{p.name}`" for p in self._save_pictures(attachments)]
        return (f"{_pictures_intro(len(names))}: saved as {', '.join(names)} in your workspace. Open "
                f"{'them' if len(names) > 1 else 'it'} with your {opener} before answering.") if names else ""

    def _save_pictures(self, attachments):
        """The student's own pictures, saved in the session folder (for CLIs that attach or open files)."""
        out = []
        for i, (media_type, data) in enumerate(attachments, 1):
            img = self.dir / f"picture-{i}.{media_type.split('/')[1]}"
            img.write_bytes(base64.b64decode(data))
            out.append(img)
        return out


class CodexSession(TurnSession):
    """Codex keeps the conversation as a thread; the deck text goes in the first turn, follow-ups resume it."""

    def _ask(self, question, page, total, image_b64, context, attachments=()):
        images = []
        if image_b64:
            img = self.dir / f"slide-{page}.jpg"
            img.write_bytes(base64.b64decode(image_b64))
            images.append(img)
        images += self._save_pictures(attachments)
        parts = [] if self.thread else self._first_parts(total, context)
        if image_b64:
            parts.append(f"The first attached image is slide {page} of {total}, which I'm looking at right now.")
        if attachments:
            n = len(attachments)
            where = f"the last {n} attached images" if n > 1 else "the last attached image"
            parts.append(f"{_pictures_intro(n)}: they're {where}.")
        parts.append(f"[I'm currently on slide {page} of {total}.]\n\n{question}")
        first = True
        got = False
        for kind, val in self.p._run(self.p._cmd(resume=self.thread, model=self.model or None, images=images, tools=True,
                                                 effort=self.effort),
                                     "\n\n".join(parts), 600, on_proc=self._set_proc):
            if self.cancelled:
                return
            if kind == "thread" and val:
                self.thread = val
            elif kind == "status":
                yield ("status", val)
            elif kind == "text" and val:
                got = True
                yield ("" if first else "\n\n") + val
                first = False
            elif kind == "error" and not got:
                yield f"\n\n**Codex error:** {val}"
        usage = self.usage()
        if usage:
            yield ("usage", usage)

    def usage(self):
        """Context + plan usage, read from the token_count events Codex writes to its session log."""
        if not self.thread:
            return None
        files = glob.glob(str(config.HOME / ".codex" / "sessions" / "**" / f"rollout-*{self.thread}.jsonl"), recursive=True)
        if not files:
            return None
        last = None
        try:
            with open(max(files, key=os.path.getmtime)) as f:
                for line in f:
                    if '"token_count"' in line:
                        last = line
            payload = json.loads(last)
            info = payload.get("payload", payload).get("info") or {}
            rl = payload.get("payload", payload).get("rate_limits") or {}
        except Exception:
            return None
        lu = info.get("last_token_usage") or {}
        limits = [{"label": window_label(w.get("window_minutes")), "used": (w.get("used_percent") or 0) / 100,
                   "resets_at": w.get("resets_at")} for w in (rl.get("primary"), rl.get("secondary")) if w]
        if limits:
            LIMITS["codex"] = limits
        return {"context_used": (lu.get("input_tokens") or 0) + (lu.get("output_tokens") or 0),
                "context_window": info.get("model_context_window"), "model": self.model or "default",
                "limits": LIMITS.get("codex", []), "at": time.time()}


# ------------------------------------------------------------------ shared: CLIs that print one JSON event per line


def _json_events(cmd, cwd, timeout, stdin="", env=None, on_proc=None, last=()):
    """Run a CLI, yield each JSON line it prints, then {"type": "_exit"} with the exit code and stderr tail.
    After an event whose type is in `last`, the CLI gets a few seconds to exit before it's stopped."""
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            cwd=str(cwd), env=env or config.ENV, bufsize=1)
    if on_proc:
        on_proc(proc)
    err = []

    def drain():
        for line in proc.stderr:
            err.append(line)
            del err[:-40]
    threading.Thread(target=drain, daemon=True).start()
    try:
        proc.stdin.write(stdin)
        proc.stdin.close()
    except (BrokenPipeError, OSError):
        pass
    timer = threading.Timer(timeout, proc.kill)
    timer.start()
    try:
        for line in proc.stdout:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if isinstance(ev, dict):
                yield ev
                if ev.get("type") in last:
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                    break
        proc.wait()
        yield {"type": "_exit", "code": proc.returncode, "stderr": "".join(err)[-600:]}
    finally:
        timer.cancel()


def _say_cli_failed(name, ev):
    tail = (ev.get("stderr") or "").strip()
    return f"\n\n**{name} stopped unexpectedly.** Please ask again." + (f"\n\n`{tail[-400:]}`" if tail else "")


# ------------------------------------------------------------------ Cursor CLI (Cursor account)


MODEL_CACHE = {}  # provider → (time, models), for model lists that need a network call


def cursor_models(fetch=True):
    """`cursor-agent models` lists `id - Label` lines for this account. It's a network call, so cache it."""
    at, models = MODEL_CACHE.get("cursor", (0, []))
    if not fetch or (models and time.time() - at < 3600):
        return models
    b = Cursor.bin()
    if not b:
        return []
    try:
        out = subprocess.run([b, "models"], capture_output=True, text=True, timeout=45, env=config.ENV).stdout
    except Exception:
        return models
    found = []
    for line in out.splitlines():
        m = re.match(r"^\s*([A-Za-z0-9][\w.\-\[\]=,]*)\s+-\s+(.+?)\s*$", re.sub(r"[​-‍﻿]", "", line))
        if m and m.group(1) != "auto":  # "auto" is what Default (no --model) already means
            found.append({"id": m.group(1), "label": re.sub(r"\s*\((current|default)[^)]*\)", "", m.group(2)).strip(),
                          "desc": ""})
    if found:
        MODEL_CACHE["cursor"] = (time.time(), found)
    return found or models


class Cursor:
    name = "cursor"
    label = "Cursor"

    @staticmethod
    def bin():
        return config.which("cursor-agent")

    def status(self):
        b = self.bin()
        st = {"provider": self.name, "installed": bool(b), "logged_in": False,
              "install": "curl https://cursor.com/install -fsS | bash", "login": "cursor-agent login"}
        if b:
            try:
                p = subprocess.run([b, "status"], capture_output=True, text=True, timeout=30, env=config.ENV)
                out = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", p.stdout + p.stderr).lower()
                st["logged_in"] = "logged in" in out and "not logged in" not in out
                st["detail"] = "Cursor account" if st["logged_in"] else ""
            except Exception as e:
                st["detail"] = str(e)[:200]
        return st

    def _cmd(self, folder, model=None, resume=None, tools=False):
        cmd = [self.bin(), "-p", "--output-format", "stream-json", "--stream-partial-output", "--mode", "ask",
               "--trust", "--workspace", str(folder)]
        if tools:
            cmd.append("--approve-mcps")
        if model:
            cmd += ["--model", model]
        if resume:
            cmd += ["--resume", resume]
        return cmd  # the prompt goes on stdin, so a long deck never hits the argument-size limit

    def session(self, pdf, model):
        return CursorSession(self, pdf, model)

    def oneshot(self, prompt, model=None, timeout=600):
        folder = config.WORK / "cursor-oneshot"
        folder.mkdir(parents=True, exist_ok=True)
        mcp.cursor_files(folder, with_servers=False)
        texts, errors = [], []
        model = model if model is not None else config.load()["cursor_model"]
        for ev in _json_events(self._cmd(folder, model or None), folder, timeout, NO_TOOLS + "\n\n" + prompt, last=("result",)):
            if ev.get("type") == "result":
                (errors if ev.get("is_error") else texts).append(ev.get("result") or "")
            elif ev.get("type") == "_exit" and ev["code"]:
                errors.append(ev["stderr"])
        if not any(texts):
            raise RuntimeError("Cursor returned nothing. " + " ".join(e for e in errors if e)[:400])
        return texts[-1]

    def oneshot_json(self, prompt, model=None, timeout=600):
        return _json_from(self.oneshot(prompt, model, timeout))

    def with_pdf(self, pdf, prompt, model=None, timeout=1800):
        return self.oneshot(f"FULL DECK TEXT (slide by slide):\n\n{deck_text(pdf)}\n\n---\n\n{prompt}", model, timeout)


def _cursor_tool_status(call):
    kind, info = next(iter(call.items()), ("", {}))
    args = (info or {}).get("args") or {}
    if kind == "mcpToolCall":
        return f"Using {args.get('providerIdentifier') or args.get('serverIdentifier', 'a tool')} › {args.get('toolName', '')}…"
    if kind == "readToolCall" and os.path.basename(str(args.get("path", ""))).startswith("slide-"):
        return "Looking at the slide…"
    return None


class CursorSession(TurnSession):
    """Cursor CLI keeps the chat; the slide image is saved in the session's workspace for Cursor to open."""

    def _ask(self, question, page, total, image_b64, context, attachments=()):
        tools = mcp.cursor_files(self.dir)
        parts = [] if self.thread else self._first_parts(total, context)
        if image_b64:
            name = f"slide-{page}.jpg"
            (self.dir / name).write_bytes(base64.b64decode(image_b64))
            parts.append(f"An image of slide {page} of {total}, which I'm looking at right now, is saved as `{name}` in "
                         "your workspace. Open it with your file-reading tool before answering, so you can see its "
                         "diagrams and equations.")
        if attachments:
            parts.append(self._pictures_note(attachments, "file-reading tool"))
        parts.append(f"[I'm currently on slide {page} of {total}.]\n\n{question}")
        streamed, said, gap, thinking, used = False, False, False, False, None
        for ev in _json_events(self.p._cmd(self.dir, self.model or None, self.thread, tools), self.dir, 600,
                               "\n\n".join(parts), on_proc=self._set_proc, last=("result",)):
            if self.cancelled:
                return
            t = ev.get("type")
            if ev.get("session_id") and t in ("system", "result"):
                self.thread = ev["session_id"]
            if t == "assistant" and ev.get("model_call_id"):
                continue  # Cursor repeats each finished piece of text in one event: it's already been streamed
            if t == "assistant":
                text = "".join(c.get("text", "") for c in (ev.get("message") or {}).get("content", []) if c.get("type") == "text")
                if "timestamp_ms" in ev:  # a streamed piece; the full message follows without a timestamp
                    if text:
                        yield ("\n\n" if gap and said else "") + text
                        streamed, said, gap = True, True, False
                elif not streamed and text:
                    yield ("\n\n" if gap and said else "") + text
                    said, gap = True, False
                if "timestamp_ms" not in ev:
                    streamed = False
            elif t == "thinking" and not thinking:
                thinking = True
                yield ("status", "Thinking it through…")
            elif t == "tool_call" and ev.get("subtype") == "started":
                label = _cursor_tool_status(ev.get("tool_call") or {})
                if label:
                    yield ("status", label)
                gap = True
            elif t == "result":
                if ev.get("is_error"):
                    yield f"\n\n**Cursor error:** {ev.get('result') or ev.get('subtype')}"
                u = ev.get("usage") or {}
                used = sum(u.get(k) or 0 for k in ("inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"))
            elif t == "_exit" and ev["code"] and used is None:
                self.thread = None  # start a fresh chat (with the deck and our chat history) next time
                yield _say_cli_failed("Cursor", ev)
        if used is not None:
            yield ("usage", {"context_used": used, "context_window": None, "model": self.model or "auto",
                             "limits": [], "at": time.time()})


# ------------------------------------------------------------------ Grok CLI (grok.com account)


EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
GROK_ARG_BUDGET = 700_000  # bytes of prompt we put on the command line (macOS allows ~1 MB in total)


def grok_models():
    try:
        data = json.loads((config.HOME / ".grok" / "models_cache.json").read_text())
    except Exception:
        return []
    out = []
    for mid, m in (data.get("models") or {}).items():
        info = m.get("info") or {}
        if info.get("hidden"):
            continue
        out.append({"id": mid, "label": info.get("name") or mid, "desc": (info.get("description") or "")[:80],
                    "context_window": info.get("context_window"),
                    "efforts": sorted((e["id"] for e in info.get("reasoning_efforts") or [] if e.get("id")),
                                      key=lambda e: EFFORT_ORDER.index(e) if e in EFFORT_ORDER else 99),
                    "default_effort": info.get("reasoning_effort")})
    return out


class Grok:
    name = "grok"
    label = "Grok"

    @staticmethod
    def bin():
        return config.which("grok")

    def status(self):
        b = self.bin()
        st = {"provider": self.name, "installed": bool(b), "logged_in": False,
              "install": "curl -fsSL https://x.ai/cli/install.sh | bash", "login": "grok login"}
        if b:
            try:
                p = subprocess.run([b, "models"], capture_output=True, text=True, timeout=30, env=self.env())
                out = (p.stdout + p.stderr).strip()
                low = out.lower()
                st["logged_in"] = p.returncode == 0 and "logged in" in low and "not logged in" not in low
                m = re.search(r"logged in (?:with|as) (.+?)\.?$", out, re.I | re.M)
                st["detail"] = m.group(1)[:200] if m and st["logged_in"] else ""
            except Exception as e:
                st["detail"] = str(e)[:200]
        return st

    @staticmethod
    def env():
        # SlideMate writes the MCP config into a scratch folder it owns, so Grok's folder-trust prompt doesn't
        # apply; Grok's cross-session memory stays out of tutoring.
        return {**config.ENV, "GROK_FOLDER_TRUST": "0", "GROK_MEMORY": "0", "GROK_DISABLE_AUTOUPDATER": "1"}

    def _cmd(self, folder, model=None, effort="", resume=None, system=None, tools=False):
        # No built-in tools (shell, files, edits); with tools=True, the MCP tools stay, reached via search/use_tool.
        cmd = [self.bin(), "--cwd", str(folder), "--output-format", "streaming-json", "--no-auto-update",
               "--disable-web-search", "--no-subagents", "--tools", "read_file",
               "--disallowed-tools", "read_file" if tools else "read_file,search_tool,use_tool"]
        if tools:
            cmd += ["--allow", "MCPTool"]
        if system:
            cmd += ["--system-prompt-override", system]
        if model:
            cmd += ["-m", model]
        if effort:
            cmd += ["--effort", effort]
        if resume:
            cmd += ["--resume", resume]
        return cmd

    def session(self, pdf, model):
        return GrokSession(self, pdf, model, config.load()["grok_effort"])

    def oneshot(self, prompt, model=None, timeout=600):
        folder = config.WORK / "grok-oneshot"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "prompt.md").write_text(prompt)
        model = model if model is not None else config.load()["grok_model"]
        cmd = self._cmd(folder, model or None, system=NO_TOOLS) + ["--prompt-file", str(folder / "prompt.md")]
        texts, errors = [], []
        for ev in _json_events(cmd, folder, timeout, env=self.env(), last=("end", "error")):
            if ev.get("type") == "text":
                texts.append(ev.get("data", ""))
            elif ev.get("type") == "error":
                errors.append(ev.get("message", ""))
            elif ev.get("type") == "_exit" and ev["code"]:
                errors.append(ev["stderr"])
        if not "".join(texts).strip():
            raise RuntimeError("Grok returned nothing. " + " ".join(e for e in errors if e)[:400])
        return "".join(texts)

    def oneshot_json(self, prompt, model=None, timeout=600):
        return _json_from(self.oneshot(prompt, model, timeout))

    def with_pdf(self, pdf, prompt, model=None, timeout=1800):
        return self.oneshot(f"FULL DECK TEXT (slide by slide):\n\n{deck_text(pdf)}\n\n---\n\n{prompt}", model, timeout)


def _grok_tool_status(ev):
    if ev.get("toolName") == "use_tool":
        name = (ev.get("rawInput") or {}).get("tool_name", "")
        return f"Using {' › '.join(name.split('__', 1)) if name else 'a tool'}…"
    if ev.get("toolName") == "search_tool":
        return "Looking for the right tool…"
    return None


class GrokSession(TurnSession):
    """Grok runs once per question and resumes its session; the slide image goes in as an image block."""

    def _ask(self, question, page, total, image_b64, context, attachments=()):
        tools = mcp.grok_files(self.dir)
        parts = [] if self.thread else self._first_parts(total, context)[1:]  # the tutor prompt is the system prompt
        if image_b64:
            parts.append(f"The first attached image is slide {page} of {total}, which I'm looking at right now.")
        if attachments:
            n = len(attachments)
            parts.append(f"{_pictures_intro(n)}: they're the last {n} attached images." if n > 1
                         else f"{_pictures_intro(1)}: it's the last attached image.")
        parts.append(f"[I'm currently on slide {page} of {total}.]\n\n{question}")
        text = "\n\n".join(parts)
        blocks = ([{"type": "image", "mimeType": "image/jpeg", "data": image_b64}] if image_b64 else []) \
            + [{"type": "image", "mimeType": t, "data": b} for t, b in attachments]
        cmd = self.p._cmd(self.dir, self.model or None, self.effort, self.thread, TUTOR_PROMPT, tools)
        if blocks:
            # Images only go in through --prompt-json (on the command line), so keep it under the size limit.
            def payload(t):
                return json.dumps(blocks + [{"type": "text", "text": t}], ensure_ascii=False)
            body, keep = text, len(text)
            while len(payload(body).encode()) > GROK_ARG_BUDGET and keep > 0:
                keep -= max(10_000, len(payload(body).encode()) - GROK_ARG_BUDGET)
                body = text[:max(0, keep)] + "\n\n[…the rest of the deck text was cut to fit…]\n\n" + parts[-1]
            cmd += ["--prompt-json", payload(body)]
        else:
            (self.dir / "prompt.md").write_text(text)
            cmd += ["--prompt-file", str(self.dir / "prompt.md")]
        streamed, gap, thinking, last, done = False, False, False, None, False
        for ev in _json_events(cmd, self.dir, 600, env=self.p.env(), on_proc=self._set_proc, last=("end", "error")):
            if self.cancelled:
                return
            t = ev.get("type")
            if t == "text" and ev.get("data"):
                yield ("\n\n" if gap and streamed else "") + ev["data"]
                streamed, gap = True, False
            elif t == "thought" and not thinking:
                thinking = True
                yield ("status", "Thinking it through…")
            elif t == "tool_call":
                label = _grok_tool_status(ev)
                if label:
                    yield ("status", label)
                gap = True
            elif t == "usage":
                last = ev.get("usage") or last
            elif t == "end":
                done = True
                self.thread = ev.get("sessionId") or self.thread
            elif t == "error":
                done = True
                yield f"\n\n**Grok error:** {ev.get('message') or 'unknown error'}"
            elif t == "_exit" and ev["code"] and not done:
                self.thread = None  # start a fresh session (with the deck and our chat history) next time
                yield _say_cli_failed("Grok", ev)
        if last:
            models = grok_models()  # Grok lists its default model first
            m = next((x for x in models if x["id"] == self.model), models[0] if models else None)
            used = sum(last.get(k) or 0 for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"))
            yield ("usage", {"context_used": used, "context_window": m and m.get("context_window"),
                             "model": self.model or "default", "limits": [], "at": time.time()})


# ------------------------------------------------------------------ Antigravity CLI (Google account)


AGY_EFFORTS = ["low", "medium", "high"]  # what every model listed so far offers


def _agy_models_run():
    """Run `agy models`: (signed in?, models). It lists one `id<TAB>Label` line per model and effort, e.g.
    `gemini-3.8-flash-high<TAB>Gemini 3.8 Flash (High)`; these are grouped into one model with its efforts."""
    b = Antigravity.bin()
    if not b:
        return False, []
    try:
        p = subprocess.run([b, "models"], capture_output=True, text=True, timeout=45, cwd=config.WORK, env=config.ENV)
    except Exception:
        return False, []
    found = {}
    for line in p.stdout.splitlines():
        m = re.match(r"^([A-Za-z0-9][\w.\-]*)\t(.+?)\s*$", line)
        if not m:
            continue
        mid, label = m.groups()
        e = re.match(r"^(.+)-(none|minimal|low|medium|high|xhigh|max)$", mid)
        base, effort = (e.group(1), e.group(2)) if e else (mid, None)
        entry = found.setdefault(base, {"id": base, "label": re.sub(r"\s*\([^)]*\)$", "", label), "desc": "", "efforts": []})
        if effort:
            entry["efforts"].append(effort)
    for entry in found.values():
        entry["efforts"].sort(key=lambda x: EFFORT_ORDER.index(x))
    models = list(found.values())
    if models:
        MODEL_CACHE["antigravity"] = (time.time(), models)
    return p.returncode == 0 and bool(models), models


def antigravity_models(fetch=True):
    """The models on this Google account (a network call, so cached for an hour)."""
    at, models = MODEL_CACHE.get("antigravity", (0, []))
    if not fetch or (models and time.time() - at < 3600):
        return models
    return _agy_models_run()[1] or models


class Antigravity:
    name = "antigravity"
    label = "Antigravity"

    @staticmethod
    def bin():
        return config.which("agy")

    def status(self):
        b = self.bin()
        st = {"provider": self.name, "installed": bool(b), "logged_in": False,
              "install": "curl -fsSL https://antigravity.google/cli/install.sh | bash",
              "login": "agy   (then sign in with Google)"}
        if b:
            st["logged_in"], _ = _agy_models_run()  # only works signed in, and refreshes the model list
            st["detail"] = "Google account" if st["logged_in"] else ""
        return st

    def _cmd(self, model=None, effort="", resume=None):
        # The prompt goes on stdin as one stream-json message, so a long deck never hits the argument-size limit.
        # Shell commands, web access and files outside the session folder need permission, which headless mode
        # can't ask for, so they're refused; MCP tools are allowed by mcp.antigravity_files.
        cmd = [self.bin(), "--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands"]
        if model:
            cmd += ["--model", model]
            m = next((x for x in antigravity_models(fetch=False) if x["id"] == model), None)
            if effort and m and m["efforts"] and effort not in m["efforts"]:
                effort = ""  # e.g. a model with a single effort level
        if effort:
            cmd += ["--effort", effort]
        if resume:
            cmd += ["--conversation", resume]
        return cmd

    @staticmethod
    def message(text):
        return json.dumps({"event": "user", "message": {"role": "user", "content": text}}) + "\n"

    def session(self, pdf, model):
        return AntigravitySession(self, pdf, model, config.load()["antigravity_effort"])

    def oneshot(self, prompt, model=None, timeout=600):
        folder = config.WORK / "antigravity-oneshot"
        folder.mkdir(parents=True, exist_ok=True)
        mcp.antigravity_files(folder, with_servers=False)
        model = model if model is not None else config.load()["antigravity_model"]
        texts, errors = [], []
        for ev in _json_events(self._cmd(model or None), folder, timeout, self.message(NO_TOOLS + "\n\n" + prompt)):
            if ev.get("event") == "result":
                r = ev.get("result") or {}
                (texts if r.get("status") == "SUCCESS" else errors).append(r.get("response") or r.get("error") or "")
            elif ev.get("type") == "_exit" and ev["code"]:
                errors.append(ev["stderr"])
        if not any(texts):
            raise RuntimeError("Antigravity returned nothing. " + " ".join(e for e in errors if e)[:400])
        return texts[-1]

    def oneshot_json(self, prompt, model=None, timeout=600):
        return _json_from(self.oneshot(prompt, model, timeout))

    def with_pdf(self, pdf, prompt, model=None, timeout=1800):
        return self.oneshot(f"FULL DECK TEXT (slide by slide):\n\n{deck_text(pdf)}\n\n---\n\n{prompt}", model, timeout)


def _agy_tool_status(step):
    params = (step.get("tool_info") or {}).get("parameters") or {}
    if step.get("tool_name") == "call_mcp_tool":
        return f"Using {params.get('ServerName') or 'a tool'} › {params.get('ToolName', '')}…"
    if step.get("tool_name") == "view_file" and os.path.basename(str(params.get("AbsolutePath", ""))).startswith("slide-"):
        return "Looking at the slide…"
    return None


class AntigravitySession(TurnSession):
    """Antigravity runs once per question and resumes its conversation by id; the slide image is saved in the
    session's folder for it to open (its stdin only takes text)."""

    def _ask(self, question, page, total, image_b64, context, attachments=()):
        mcp.antigravity_files(self.dir)
        parts = [] if self.thread else self._first_parts(total, context)
        if image_b64:
            name = f"slide-{page}.jpg"
            (self.dir / name).write_bytes(base64.b64decode(image_b64))
            parts.append(f"An image of slide {page} of {total}, which I'm looking at right now, is saved as `{name}` in "
                         "your workspace. Open it with your file viewer before answering, so you can see its diagrams "
                         "and equations. Don't mention or link the file itself.")
        if attachments:
            parts.append(self._pictures_note(attachments, "file viewer"))
        parts.append(f"[I'm currently on slide {page} of {total}.]\n\n{question}")
        said = yield from self._turn("\n\n".join(parts))
        if said is None:  # a refused tool ended the turn before any answer: say so and ask once more
            said = yield from self._turn("(That tool isn't available here. Answer my question directly from the deck "
                                         "and the slide image, without running commands or opening web pages.)")
            if said is None:
                yield ("\n\n**Antigravity stopped** after trying to use a tool SlideMate doesn't allow "
                       "(shell commands and web pages are off). Please ask again.")

    def _turn(self, text):
        """One CLI run. Returns True if it answered, None if a refused tool ended it silently, False on an error."""
        said, gap, step, used, done, denied = False, False, None, None, False, False
        for ev in _json_events(self.p._cmd(self.model or None, self.effort, self.thread), self.dir, 600,
                               self.p.message(text), on_proc=self._set_proc):
            if self.cancelled:
                return False
            kind = ev.get("event")
            if kind == "init" and ev.get("conversation_id"):
                self.thread = ev["conversation_id"]
            elif kind == "step_update":
                s = ev.get("step_update") or {}
                if s.get("step_type") == "agent_response":
                    delta = s.get("text_delta") or ""
                    if delta:
                        yield ("\n\n" if said and (gap or s.get("step_index") != step) else "") + delta
                        said, gap, step = True, False, s.get("step_index")
                    u = s.get("usage")
                    if u:  # per model call, so the latest one is roughly how full the conversation is
                        used = sum(u.get(k) or 0 for k in ("input_tokens", "cache_read_tokens", "output_tokens"))
                elif s.get("step_type") == "tool" and s.get("state") == "ACTIVE":
                    label = _agy_tool_status(s)
                    if label:
                        yield ("status", label)
                    gap = True
            elif kind == "result":
                done = True
                r = ev.get("result") or {}
                self.thread = r.get("conversation_id") or self.thread
                if r.get("status") != "SUCCESS":
                    yield f"\n\n**Antigravity error:** {r.get('error') or r.get('status') or 'unknown error'}"
                    return False
                if not said and (r.get("response") or "").strip():
                    yield r["response"]
                    said = True
                denied = bool(r.get("denied_actions"))
            elif ev.get("type") == "_exit" and ev["code"] and not done:
                self.thread = None  # start a fresh conversation (with the deck and our chat history) next time
                yield _say_cli_failed("Antigravity", ev)
                return False
        if used is not None:
            yield ("usage", {"context_used": used, "context_window": None, "model": self.model or "default",
                             "limits": [], "at": time.time()})
        return True if said else (None if denied else False)


# ------------------------------------------------------------------ Ollama (a model running on this Mac)


_OLLAMA_HOST = os.environ.get("OLLAMA_HOST") or "127.0.0.1:11434"
OLLAMA_URL = (_OLLAMA_HOST if "://" in _OLLAMA_HOST else "http://" + _OLLAMA_HOST).rstrip("/").replace("0.0.0.0", "127.0.0.1")
OLLAMA_SUGGESTED = "qwen3-vl:8b"  # sees images, ~6 GB, fits a 16 GB Mac
OLLAMA_MAX_CTX = 32768   # tokens for deck + chat: about 5 GB of memory on top of an 8B model
OLLAMA_ANSWER_ROOM = 6144  # tokens kept free for the answer
CHARS_PER_TOKEN = 3.2      # rough, for sizing the context before Ollama has counted anything
SHOW_CACHE = {}  # (model, digest) → /api/show


def _ollama(path, body=None, timeout=10):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(OLLAMA_URL + path, data=data, headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout)


def _ollama_json(path, body=None, timeout=10):
    with _ollama(path, body, timeout) as r:
        return json.loads(r.read())


def _ollama_error(e):
    """Ollama's own message from an HTTP error ({"error": "…"}), or a plain description."""
    if isinstance(e, urllib.error.HTTPError):
        try:
            return json.loads(e.read()).get("error") or str(e)
        except Exception:
            return str(e)
    if isinstance(e, urllib.error.URLError):
        return "Ollama isn't running. Open the Ollama app (or run `ollama serve`) and ask again."
    return str(e)


def ollama_models():
    """Models downloaded into Ollama, with whether each can see images and how much context it takes."""
    try:
        tags = _ollama_json("/api/tags", timeout=3).get("models") or []
    except Exception:
        return []
    out = []
    for t in tags:
        name = t.get("name") or t.get("model")
        if not name:
            continue
        key = (name, t.get("digest"))
        if key not in SHOW_CACHE:
            try:
                SHOW_CACHE[key] = _ollama_json("/api/show", {"model": name}, timeout=10)
            except Exception:
                SHOW_CACHE[key] = {}
        info = SHOW_CACHE[key]
        caps = info.get("capabilities") or []
        if caps and "completion" not in caps:
            continue  # embedding models can't chat
        ctx = next((v for k, v in (info.get("model_info") or {}).items() if k.endswith(".context_length")), None)
        size = (t.get("details") or {}).get("parameter_size") or ""
        out.append({"id": name, "label": name, "context_window": ctx, "vision": "vision" in caps,
                    "desc": " · ".join(x for x in (size, "sees slide images" if "vision" in caps else "text only") if x)})
    return out


def _fit_ctx(chars, model_ctx=None):
    """Context size for a prompt this long: 8k, 16k or 32k tokens (bigger needs more memory, so no more than needed)."""
    need, ctx = int(chars / CHARS_PER_TOKEN) + OLLAMA_ANSWER_ROOM, 8192
    while ctx < need and ctx < OLLAMA_MAX_CTX:
        ctx *= 2
    return min(ctx, model_ctx or ctx)


OLLAMA_DECK_CHARS = int((OLLAMA_MAX_CTX - OLLAMA_ANSWER_ROOM - 4000) * CHARS_PER_TOKEN)  # the rest is prompt + chat


class Ollama:
    name = "ollama"
    label = "Ollama"

    @staticmethod
    def bin():
        app = "/Applications/Ollama.app/Contents/Resources/ollama"
        return config.which("ollama") or (app if os.path.exists(app) else None)

    def status(self):
        st = {"provider": self.name, "installed": bool(self.bin()), "logged_in": False,
              "install": "brew install --cask ollama-app   (or download it from ollama.com)",
              "login": f"ollama pull {OLLAMA_SUGGESTED}"}
        try:
            _ollama_json("/api/version", timeout=3)
        except Exception:
            st.update(not_ready="Not running", login_label="Start Ollama…")
            return st
        models = ollama_models()
        st["installed"] = True
        st["logged_in"] = bool(models)
        if models:
            st["detail"] = f"{len(models)} model{'s' if len(models) > 1 else ''} on this Mac"
        else:
            st.update(not_ready="No model downloaded", login_label="Download a model…")
        return st

    @staticmethod
    def pick_model(models=None):
        """The model in Settings, or else the first one that can see images, or else the first one."""
        chosen = config.load()["ollama_model"]
        if chosen:
            return chosen
        models = ollama_models() if models is None else models
        return next((m["id"] for m in models if m["vision"]), models[0]["id"] if models else None)

    def session(self, pdf, model):
        return OllamaSession(self, pdf, model)

    def oneshot(self, prompt, model=None, timeout=600, fmt=None):
        model = model or self.pick_model()
        if not model:
            raise RuntimeError(f"No Ollama model downloaded yet. In Terminal: ollama pull {OLLAMA_SUGGESTED}")
        text = NO_TOOLS + "\n\n" + prompt
        body = {"model": model, "messages": [{"role": "user", "content": text}], "stream": False,
                "options": {"num_ctx": _fit_ctx(len(text))}, "keep_alive": "20m"}
        if fmt:
            body["format"] = fmt
        try:
            r = _ollama_json("/api/chat", body, timeout)
        except Exception as e:
            raise RuntimeError(_ollama_error(e))
        return (r.get("message") or {}).get("content", "")

    def oneshot_json(self, prompt, model=None, timeout=600):
        return _json_from(self.oneshot(prompt, model, timeout, fmt="json"))

    def with_pdf(self, pdf, prompt, model=None, timeout=1800):
        deck = deck_text(pdf, max(20_000, OLLAMA_DECK_CHARS - len(prompt)))
        return self.oneshot(f"FULL DECK TEXT (slide by slide):\n\n{deck}\n\n---\n\n{prompt}", model, timeout)


class OllamaSession(TurnSession):
    """Ollama keeps no conversation, so SlideMate does: the whole chat is sent each time (Ollama reuses its cache for
    the unchanged start, so only the new question is read). The slide image goes in with the question if the model
    can see images. Connected tools (MCP) aren't available to local models."""

    def __init__(self, provider, pdf, model, effort=""):
        super().__init__(provider, pdf, model, effort)
        self.messages = []  # earlier turns, exactly as sent, so Ollama's cache still matches
        self.ctx = None
        self.resp = None

    def cancel(self):
        self.cancelled = True
        r = self.resp
        if r is not None:
            try:
                r.close()
            except Exception:
                pass

    def _ask(self, question, page, total, image_b64, context, attachments=()):
        models = ollama_models()
        model = self.model or self.p.pick_model(models)
        if not model:
            yield (f"**No local model yet.** In Terminal, run `ollama pull {OLLAMA_SUGGESTED}` "
                   "(about 6 GB), then ask again.")
            return
        info = next((m for m in models if m["id"] == model), {})
        parts = []
        if not self.messages:
            deck = deck_text(self.pdf, OLLAMA_DECK_CHARS)
            parts.append(f'FULL DECK TEXT of "{os.path.basename(self.pdf)}" ({total} slides):\n\n{deck}')
            if context:
                parts.append(context[-int(4000 * CHARS_PER_TOKEN):])  # lecture notes / earlier chat, kept short
            self.ctx = _fit_ctx(len(TUTOR_PROMPT) + sum(map(len, parts)) + len(question), info.get("context_window"))
        vision = bool(info.get("vision"))
        images = ([image_b64] if image_b64 else []) + [b for _, b in attachments] if vision else []
        if image_b64 and vision:
            parts.append(f"The first attached image is slide {page} of {total}, which I'm looking at right now.")
        if attachments:
            parts.append(f"{_pictures_intro(len(attachments))}: they're the last attached images." if vision else
                         "(I attached pictures of my own, but this model can't see images, so tell me to pick a model "
                         "that can, or to describe what's in them.)")
        parts.append(f"[I'm currently on slide {page} of {total}.]\n\n{question}")
        user = {"role": "user", "content": "\n\n".join(parts), **({"images": images} if images else {})}
        # Keep the deck (first exchange) and drop the oldest follow-ups once the chat outgrows the context.
        def size(msgs):
            return sum(len(m["content"]) + (1500 * CHARS_PER_TOKEN if m.get("images") else 0) for m in msgs) / CHARS_PER_TOKEN
        while len(self.messages) > 2 and size(self.messages + [user]) + 1500 > self.ctx - OLLAMA_ANSWER_ROOM:
            del self.messages[2:4]
        body = {"model": model, "stream": True, "keep_alive": "20m", "options": {"num_ctx": self.ctx},
                "messages": [{"role": "system", "content": TUTOR_PROMPT}] + self.messages + [user]}
        yield ("status", "Reading the deck…" if not self.messages else "Thinking…")
        out, stats, thinking = [], {}, False
        try:
            self.resp = _ollama("/api/chat", body, timeout=600)
            for line in self.resp:
                if self.cancelled:
                    return
                ev = json.loads(line)
                if ev.get("error"):
                    yield f"\n\n**Ollama error:** {ev['error']}"
                    return
                msg = ev.get("message") or {}
                if msg.get("thinking") and not thinking:
                    thinking = True
                    yield ("status", "Thinking it through…")
                if msg.get("content"):
                    out.append(msg["content"])
                    yield msg["content"]
                if ev.get("done"):
                    stats = ev
        except Exception as e:
            if not self.cancelled:
                yield f"\n\n**Ollama error:** {_ollama_error(e)}"
            return
        finally:
            r, self.resp = self.resp, None
            if r is not None:
                r.close()
        if out:
            self.messages += [user, {"role": "assistant", "content": "".join(out)}]
        if stats:
            yield ("usage", {"context_used": (stats.get("prompt_eval_count") or 0) + (stats.get("eval_count") or 0),
                             "context_window": self.ctx, "model": model, "limits": [], "at": time.time()})


PROVIDERS = {"claude": Claude(), "codex": Codex(), "cursor": Cursor(), "grok": Grok(), "antigravity": Antigravity(),
             "ollama": Ollama()}


def current():
    return PROVIDERS.get(config.load()["provider"], PROVIDERS["claude"])


def effort_for():
    cfg = config.load()
    return cfg.get(f"{current().name}_effort", "")


def model_for(kind="chat"):
    cfg = config.load()
    name = current().name
    if name == "claude":
        return cfg["claude_notes_model"] if kind == "notes" else cfg["claude_model"]
    return cfg.get(f"{name}_model") or None  # blank = that CLI's own default


BREW_INSTALL = ('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n'
                'eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"')
OLLAMA_APP_INSTALL = ('curl -fL --progress-bar -o /tmp/Ollama.zip https://ollama.com/download/Ollama-darwin.zip || exit 1\n'
                      'ditto -x -k /tmp/Ollama.zip /Applications && rm -f /tmp/Ollama.zip || exit 1')
SIGN_IN = {  # what to say before signing in, and the command (the script's PATH covers the usual install folders)
    "claude": ("Your browser opens: sign in with your Claude Pro or Max account.", "claude auth login"),
    "codex": ("Your browser opens: sign in with your ChatGPT account.", "codex login"),
    "cursor": ("Your browser opens: sign in with your Cursor account.", "cursor-agent login"),
    "grok": ("Your browser opens: sign in with your grok.com account.", "grok login"),
}
CURL_INSTALL = {"claude": "https://claude.ai/install.sh", "cursor": "https://cursor.com/install",
                "grok": "https://x.ai/cli/install.sh", "antigravity": "https://antigravity.google/cli/install.sh"}


def setup_script(name, install):
    """Shell steps that install (if asked) and sign in to a provider, for a Terminal window."""
    label = PROVIDERS[name].label
    steps = [f'echo "Installing {label}…"'] if install else []
    if install and name in CURL_INSTALL:
        steps += [f"curl -fsSL {CURL_INSTALL[name]} | bash || exit 1"]
    elif install and name == "codex":
        if config.which("brew"):
            steps += ["brew install codex || exit 1"]
        elif config.which("npm"):
            steps += ["npm install -g @openai/codex || exit 1"]
        else:
            steps += ['echo "Codex installs with Homebrew, which asks for your Mac password once."', BREW_INSTALL,
                      "brew install codex || exit 1"]
    elif install and name == "ollama":
        steps += [OLLAMA_APP_INSTALL]
    if name in SIGN_IN:
        say, cmd = SIGN_IN[name]
        steps += [f'echo; echo "Signing in. {say}"', f"{cmd} || exit 1"]
    elif name == "antigravity":
        # Antigravity has no login command: starting it signs you in. Run it in SlideMate's scratch folder.
        steps += ['echo; echo "Signing in. Antigravity starts and opens your browser: sign in with your Google account."',
                  'echo "Once it says you are signed in, press Ctrl-C twice to quit it."; echo',
                  f"cd '{config.WORK}' && agy"]
    elif name == "ollama":
        steps += ['echo; echo "Starting Ollama and downloading a model that can read slides (about 6 GB)…"',
                  "ollama list >/dev/null 2>&1 || open -a Ollama || (nohup ollama serve >/dev/null 2>&1 &)",
                  "for i in $(seq 1 30); do ollama list >/dev/null 2>&1 && break; sleep 1; done",
                  f"ollama pull {OLLAMA_SUGGESTED} || exit 1"]
    return steps


def open_setup_terminal(name, install=False):
    """Install and sign-in are interactive (browser sign-in, maybe a password), so they run in a Terminal window
    the user can see. SlideMate notices by itself when sign-in has finished."""
    if name not in PROVIDERS or (not install and not PROVIDERS[name].bin()):
        return False
    path = config.DATA / "setup" / f"{name}-setup.command"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/bash\n"
                    f'export PATH="{config.ENV["PATH"]}:/Applications/Ollama.app/Contents/Resources"\n'
                    "clear\n" + "\n".join(setup_script(name, install)) + "\n"
                    'echo; echo "✓ Done. You can close this window and go back to SlideMate."\n')
    path.chmod(0o755)
    subprocess.Popen(["open", "-a", "Terminal", str(path)])
    return True
