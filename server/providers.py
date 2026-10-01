"""AI providers. SlideMate drives a CLI you're already signed in to, so no API keys are needed:

- "claude": Claude Code (`claude`) using your Claude subscription. Gets the full PDF natively (text + visuals).
- "codex":  Codex CLI (`codex`) using "Sign in with ChatGPT". Gets the deck's text plus an image of your slide.
"""
import base64
import json
import os
import re
import subprocess
import threading
import uuid
from pathlib import Path

import config

TUTOR_PROMPT = """You are a patient, sharp university tutor built into the student's slide viewer.
You have the ENTIRE lecture deck. With each question you also get an image of the slide the student is
looking at and its slide number.

How to answer:
- Anchor on the current slide, but use the rest of the deck for context: say how it connects to what came
  before and what it sets up later (cite slide numbers like "slide 12").
- Explain intuitively first, then precisely. Unpack notation, diagrams, equations and jargon on the slide.
- If a slide is terse (bullet fragments, a lone diagram), fill in what the lecturer is most likely saying.
- Use short paragraphs, bullets and worked examples where useful. Use LaTeX with $...$ / $$...$$ for maths.
- Be concise by default; go deeper when asked. Don't repeat the slide text back verbatim.
"""


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
        return ClaudeSession(self, pdf, model)

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


def _claude_deck_blocks(pdf):
    name = os.path.basename(pdf)
    pages = page_count(pdf)
    intro = {"type": "text", "text": f'This is the full lecture deck "{name}" ({pages} slides). Read it all for context.'}
    if os.path.getsize(pdf) < 30 * 1024 * 1024 and 0 < pages <= 100:
        data = base64.b64encode(Path(pdf).read_bytes()).decode()
        return [intro, {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": data}, "title": name}]
    return [intro, {"type": "text", "text": deck_text(pdf, 600_000)}]


class ClaudeSession:
    """One long-lived `claude -p` process per deck: the deck is sent once, follow-ups keep full context."""

    def __init__(self, provider, pdf, model):
        self.p, self.pdf, self.model = provider, pdf, model
        self.lock = threading.Lock()
        self.proc = None
        self.primed = False

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def close(self):
        if self.alive():
            self.proc.kill()
        self.proc = None

    def ask(self, question, page, total, image_b64, context=""):
        with self.lock:
            if not self.alive():
                cmd = self.p._base(self.model) + ["--input-format", "stream-json", "--output-format", "stream-json",
                                                  "--verbose", "--include-partial-messages", "--system-prompt", TUTOR_PROMPT]
                self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                             cwd=config.WORK, text=True, bufsize=1, env=config.ENV)
                self.primed = False
            content = []
            if not self.primed:
                content += _claude_deck_blocks(self.pdf)
                if context:
                    content.append({"type": "text", "text": context})
            if image_b64:
                content.append({"type": "text", "text": f"Here is slide {page} of {total}, which I'm looking at right now:"})
                content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": image_b64}})
            content.append({"type": "text", "text": f"[I'm currently on slide {page} of {total}.]\n\n{question}"})
            try:
                self.proc.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": content}}) + "\n")
                self.proc.stdin.flush()
            except BrokenPipeError:
                self.close()
                yield "\n\n*(Claude restarted, please ask again.)*"
                return
            self.primed = True
            streamed = False
            for line in self.proc.stdout:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                t = ev.get("type")
                if t == "stream_event":
                    e = ev.get("event", {})
                    if e.get("type") == "content_block_delta" and e.get("delta", {}).get("type") == "text_delta":
                        streamed = True
                        yield e["delta"]["text"]
                elif t == "result":
                    if ev.get("is_error"):
                        yield f"\n\n**Error:** {ev.get('result') or ev.get('subtype')}"
                    elif not streamed and ev.get("result"):
                        yield ev["result"]
                    return
            err = self.proc.stderr.read()[-800:] if self.proc else ""
            self.close()
            yield f"\n\n**Claude exited unexpectedly.** {err}"


# ------------------------------------------------------------------ Codex CLI (ChatGPT sign-in)


NO_TOOLS = ("Do not run any commands or read any files: everything you need is in this message. "
            "Answer directly.")


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

    def _cmd(self, resume=None, model=None, images=(), ephemeral=False):
        model = model if model is not None else config.load()["codex_model"]
        if resume:
            cmd = [self.bin(), "exec", "resume", resume]
        else:
            cmd = [self.bin(), "exec", "-s", "read-only", "-C", str(config.WORK)]
        cmd += ["--json", "--skip-git-repo-check", "--ignore-user-config"]
        if ephemeral:
            cmd.append("--ephemeral")
        if model:
            cmd += ["-m", model]
        for img in images:
            cmd += ["-i", str(img)]
        return cmd + ["-"]  # prompt comes on stdin (-i would otherwise swallow it)

    def _run(self, cmd, prompt, timeout):
        """Run codex exec; yields ("thread", id) and ("text", message) events."""
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                cwd=config.WORK, env=config.ENV, bufsize=1)
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
        return CodexSession(self, pdf, model)

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


class CodexSession:
    """Codex keeps the conversation as a thread; the deck text goes in the first turn, follow-ups resume it."""

    def __init__(self, provider, pdf, model):
        self.p, self.pdf, self.model = provider, pdf, model
        self.lock = threading.Lock()
        self.thread = None
        self.dir = config.WORK / f"codex-{uuid.uuid4().hex[:8]}"
        self.dir.mkdir(parents=True, exist_ok=True)

    def close(self):
        self.thread = None

    def ask(self, question, page, total, image_b64, context=""):
        with self.lock:
            images = []
            if image_b64:
                img = self.dir / f"slide-{page}.jpg"
                img.write_bytes(base64.b64decode(image_b64))
                images.append(img)
            parts = []
            if not self.thread:
                parts += [TUTOR_PROMPT, NO_TOOLS,
                          f'FULL DECK TEXT of "{os.path.basename(self.pdf)}" ({total} slides):\n\n{deck_text(self.pdf)}']
                if context:
                    parts.append(context)
            if images:
                parts.append(f"The attached image is slide {page} of {total}, which I'm looking at right now.")
            parts.append(f"[I'm currently on slide {page} of {total}.]\n\n{question}")
            first = True
            got = False
            for kind, val in self.p._run(self.p._cmd(resume=self.thread, model=self.model or None, images=images),
                                         "\n\n".join(parts), 600):
                if kind == "thread" and val:
                    self.thread = val
                elif kind == "text" and val:
                    got = True
                    yield ("" if first else "\n\n") + val
                    first = False
                elif kind == "error" and not got:
                    yield f"\n\n**Codex error:** {val}"


PROVIDERS = {"claude": Claude(), "codex": Codex()}


def current():
    return PROVIDERS.get(config.load()["provider"], PROVIDERS["claude"])


def model_for(kind="chat"):
    cfg = config.load()
    if cfg["provider"] == "codex":
        return cfg["codex_model"] or None
    return cfg["claude_notes_model"] if kind == "notes" else cfg["claude_model"]


def open_login_terminal(name):
    """Sign-in flows are interactive, so run them in Terminal where the user can see them."""
    p = PROVIDERS[name]
    b = p.bin()
    if not b:
        return False
    cmd = f"'{b}' auth login" if name == "claude" else f"'{b}' login"
    script = f'tell application "Terminal"\nactivate\ndo script "{cmd}"\nend tell'
    subprocess.Popen(["osascript", "-e", script])
    return True
