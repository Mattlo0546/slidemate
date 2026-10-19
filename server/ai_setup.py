"""Install and sign in to an AI tutor from inside SlideMate: no Terminal window.

Each provider's own CLI does the real work. Installs run in the background (the vendors' install scripts, or for
Codex its release binary, so Homebrew isn't needed). Sign-in runs the CLI's login command on a pseudo-terminal,
because some only behave interactively, and SlideMate reads what it prints:
  - a sign-in link, opened in the browser (unless the CLI opens it itself) and offered again as a button
  - a code to confirm in the browser (Grok's device sign-in), shown in the app
  - a "paste the code" prompt (Claude), answered from a field in the app
  - a menu (Antigravity asks how to sign in), answered with its first choice, Google
The job finishes when the provider's own status check says it's signed in.
"""
import json
import os
import platform
import pty
import re
import select
import shutil
import signal
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

import config
import providers

CURL_INSTALL = providers.CURL_INSTALL
LOGIN_CMD = {"claude": ["claude", "auth", "login"], "codex": ["codex", "login"], "cursor": ["cursor-agent", "login"],
             "grok": ["grok", "login"], "antigravity": ["agy"]}
SIGN_IN_TIMEOUT = 15 * 60
ANSI = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<>=$]*[A-Za-z~]|\x1b[()][A-Z0-9]|\x1b[=>78]")
URL = re.compile(r"https?://[^\s\x07\x1b'\"<>]+")

_jobs = {}  # provider -> job dict (see _new_job); "proc"/"fd"/"thread" are never sent to the UI
_lock = threading.Lock()


def _new_job():
    return {"state": "installing", "step": "Starting…", "url": "", "user_code": "", "needs_code": False,
            "error": "", "started": time.time()}


def status():
    return {n: {k: v for k, v in j.items() if k not in ("proc", "fd", "thread", "out", "answered", "opened")}
            for n, j in _jobs.items()}


def start(name):
    """Install (if needed) and sign in, in the background. Returns the job."""
    if name not in providers.PROVIDERS:
        return {"state": "failed", "error": "Unknown AI"}
    with _lock:
        job = _jobs.get(name)
        if job and job["state"] in ("installing", "signing_in"):
            return status()[name]
        cancel(name)
        job = _jobs[name] = _new_job()
        job["thread"] = threading.Thread(target=_run, args=(name, job), daemon=True)
        job["thread"].start()
    return status()[name]


def cancel(name):
    job = _jobs.pop(name, None)
    if job:
        _stop(job)


def submit_code(name, code):
    """The code Claude's sign-in page shows, typed back into the waiting CLI."""
    job = _jobs.get(name)
    code = (code or "").strip()
    if not job or job.get("fd") is None or not code:
        return {"ok": False}
    os.write(job["fd"], code.encode() + b"\r")
    job.update(needs_code=False, step="Checking the code…")
    return {"ok": True}


def _stop(job):
    p = job.get("proc")
    if p and p.poll() is None:
        try:
            os.killpg(p.pid, signal.SIGTERM)
        except Exception:
            p.terminate()
    if job.get("fd") is not None:
        try:
            os.close(job["fd"])
        except OSError:
            pass
        job["fd"] = None


def _ready(name):
    st = providers.PROVIDERS[name].status()
    return st.get("installed") and st.get("logged_in")


def _run(name, job):
    step = lambda s: job.update(step=s)  # noqa: E731
    label = PROVIDER_LABELS.get(name, name)
    try:
        if not providers.PROVIDERS[name].bin():
            step(f"Installing {label}…")
            _install(name, step)
            if not providers.PROVIDERS[name].bin():
                raise RuntimeError(f"{label} didn't install. Check your internet connection and try again.")
        if name == "ollama":
            _ollama_ready(step)
        elif not _ready(name):
            job["state"] = "signing_in"
            step("Opening your browser to sign in…")
            _sign_in(name, job)
        if job is _jobs.get(name):
            job.update(state="done", step="Ready", needs_code=False)
    except Exception as e:  # noqa: BLE001 - shown in the app
        if job is _jobs.get(name):
            job.update(state="failed", error=str(e)[:400], needs_code=False)
        print(f"ai_setup: {name} failed: {e}", flush=True)
    finally:
        _stop(job)


PROVIDER_LABELS = {"claude": "Claude", "codex": "ChatGPT", "cursor": "Cursor", "grok": "Grok",
                   "antigravity": "Gemini", "ollama": "Ollama"}


# ------------------------------------------------------------------ install


def _sh(script, timeout=900):
    p = subprocess.run(["/bin/bash", "-c", script], capture_output=True, text=True, timeout=timeout,
                       env={**config.ENV, "NONINTERACTIVE": "1"}, stdin=subprocess.DEVNULL)
    if p.returncode:
        tail = " ".join((p.stderr or p.stdout).strip().splitlines()[-2:])
        raise RuntimeError(f"The install didn't finish. {tail}"[:400])


def _arch():
    try:
        arm = subprocess.run(["sysctl", "-n", "hw.optional.arm64"], capture_output=True, text=True).stdout.strip() == "1"
    except Exception:
        arm = platform.machine() == "arm64"
    return "aarch64" if arm else "x86_64"


def _install(name, step):
    if name in CURL_INSTALL:
        _sh(f"curl -fsSL {CURL_INSTALL[name]} | bash")
    elif name == "codex":
        _install_codex(step)
    elif name == "ollama":
        _install_ollama(step)


def _install_codex(step):
    """Codex's own release binary into SlideMate's tools folder (no Homebrew or npm)."""
    arch = _arch()
    url = f"https://github.com/openai/codex/releases/latest/download/codex-{arch}-apple-darwin.tar.gz"
    bin_dir = config.TOOLS / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=config.TOOLS) as tmp:
        tgz = Path(tmp) / "codex.tar.gz"
        urllib.request.urlretrieve(url, tgz)
        with tarfile.open(tgz) as t:
            member = next(m for m in t.getmembers() if m.isfile() and Path(m.name).name.startswith("codex"))
            member.name = "codex"
            t.extract(member, tmp)
        dest = bin_dir / "codex"
        shutil.move(str(Path(tmp) / "codex"), dest)
    dest.chmod(0o755)


def _install_ollama(step):
    apps = Path("/Applications")
    if not os.access(apps, os.W_OK):
        apps = config.HOME / "Applications"
        apps.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        z = Path(tmp) / "Ollama.zip"
        step("Downloading Ollama…")
        urllib.request.urlretrieve("https://ollama.com/download/Ollama-darwin.zip", z)
        subprocess.run(["ditto", "-x", "-k", str(z), str(apps)], check=True)


def _ollama_ready(step):
    """Start Ollama and download a model that can read slides, with progress."""
    def up():
        try:
            urllib.request.urlopen("http://127.0.0.1:11434/api/version", timeout=2)
            return True
        except Exception:
            return False
    if not up():
        subprocess.run(["open", "-g", "-a", "Ollama"], capture_output=True)
        for _ in range(40):
            if up():
                break
            time.sleep(1)
        else:
            raise RuntimeError("Ollama didn't start. Open the Ollama app once, then try again.")
    if providers.ollama_models():
        return
    req = urllib.request.Request("http://127.0.0.1:11434/api/pull", method="POST",
                                 data=json.dumps({"model": providers.OLLAMA_SUGGESTED}).encode())
    with urllib.request.urlopen(req, timeout=3600) as r:
        for line in r:
            d = json.loads(line or b"{}")
            if d.get("error"):
                raise RuntimeError(d["error"])
            if d.get("total"):
                step(f"Downloading a model that can read slides… {d.get('completed', 0) / d['total']:.0%} of "
                     f"{d['total'] / 1e9:.1f} GB")


# ------------------------------------------------------------------ sign-in


def _sign_in(name, job):
    cmd = list(LOGIN_CMD[name])
    cmd[0] = providers.PROVIDERS[name].bin() or cmd[0]
    env = {**config.ENV, "TERM": "xterm-256color", "COLUMNS": "200", "LINES": "50"}
    env.pop("BROWSER", None)
    master, slave = pty.openpty()
    proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, env=env, cwd=str(config.WORK),
                            start_new_session=True, close_fds=True)
    os.close(slave)
    job.update(proc=proc, fd=master, out="", answered=False, opened=False)
    t0, last_check, eof = time.time(), 0, False
    while job is _jobs.get(name):
        if time.time() - t0 > SIGN_IN_TIMEOUT:
            raise RuntimeError("Sign-in timed out. Try again.")
        if eof:
            time.sleep(0.5)
        elif select.select([master], [], [], 0.5)[0]:
            try:
                chunk = os.read(master, 8192)
            except OSError:  # the CLI has exited and closed its terminal
                chunk = b""
            if chunk:
                new = ANSI.sub("", chunk.decode(errors="replace"))
                job["out"] = (job["out"] + new)[-20000:]
                _react(job, new)
            else:
                eof = True
        if time.time() - last_check > 3:
            last_check = time.time()
            if _ready(name):
                return
        if proc.poll() is not None and (eof or not select.select([master], [], [], 0)[0]):
            # The CLI exited: it either signed in (the check below) or gave up.
            if _ready(name):
                return
            tail = " ".join(job["out"].strip().splitlines()[-2:])
            raise RuntimeError("Sign-in didn't finish. " + tail[:300])


def _react(job, new):
    out = job["out"]
    low, new_low = out.lower(), new.lower()
    urls = [u.rstrip(".,)") for u in URL.findall(out)]
    auth = [u for u in urls if re.search(r"oauth|auth|login|device|signin|sign-in", u, re.I) and "localhost" not in u
            and "127.0.0.1" not in u]
    if auth and not job["url"]:
        job["url"] = auth[0]
        # Some CLIs open the browser themselves ("Opening browser", "If your browser didn't open"); the others
        # only print the link, so open it for them.
        if not re.search(r"opening (your )?browser|browser (did not|didn't) open|if the browser", low):
            subprocess.Popen(["open", job["url"]])
        job["step"] = "Sign in in your browser…"
    m = re.search(r"user_code=([A-Z0-9-]{4,})", out) or re.search(r"(?:confirm|enter) this code[^\n]*\n\s*([A-Z0-9]{3,}-[A-Z0-9]{3,})", out, re.I)
    if m:
        job["user_code"] = m.group(1)
    if re.search(r"paste (the |your )?(authorization )?code", new_low):  # a new prompt (again after a wrong code)
        job["needs_code"] = True
        job["step"] = "Paste the code from your browser"
    if not job["answered"] and "select login method" in low:  # Antigravity: 1. Google OAuth
        job["answered"] = True
        os.write(job["fd"], b"\r")
