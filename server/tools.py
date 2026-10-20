"""Tools SlideMate installs for itself, so nobody needs Terminal, Homebrew or Apple's Command Line Tools.

It downloads uv (a single file; checksum pinned), and uv brings its own Python and installs:
  - "parakeet":   speech-to-text for lecture recording (parakeet-mlx, Apple Silicon only), plus a self-contained
                  ffmpeg (from imageio-ffmpeg) and the speech model (~2.3 GB, downloaded once)
  - "moodle":     the Moodle connection (github.com/Mattlo0546/moodle-mcp)
  - "blackboard": the Blackboard connection (github.com/Mattlo0546/blackboard-mcp)
  - "canvas":     the Canvas connection (github.com/Mattlo0546/canvas-mcp)
  - "classroom":  the Google Classroom connection (github.com/Mattlo0546/classroom-mcp)
Everything lives in <SlideMate data>/tools, whose bin/ folder is first on SlideMate's PATH (config.EXTRA_PATH).
"""
import json
import os
import platform
import shutil
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.request
import wave
from pathlib import Path

import config

ROOT = config.TOOLS
BIN = ROOT / "bin"
UV_VERSION = "0.11.25"
UV_SHA256 = {"aarch64": "5fc334bb25d19806262efd1f6e7d380155c7e817d89bf426df4ba7ae873c9471",
             "x86_64": "65ff85b33212f75d34d7c0f0724aba9a742c74f62559f67dc0d6c543dc2fc52f"}
PYTHON = "3.13"
PACKAGES = {
    "parakeet": {"spec": "parakeet-mlx==0.5.3", "with": ["imageio-ffmpeg==0.6.0"], "exe": "parakeet-mlx",
                 "label": "speech-to-text"},
    "moodle": {"spec": "moodle-mcp @ https://github.com/Mattlo0546/moodle-mcp/archive/refs/tags/v0.3.0.zip",
               "exe": "moodle-mcp", "label": "the Moodle connection"},
    "blackboard": {"spec": "blackboard-mcp @ https://github.com/Mattlo0546/blackboard-mcp/archive/refs/tags/v0.2.0.zip",
                   "exe": "blackboard-mcp", "label": "the Blackboard connection"},
    "canvas": {"spec": "canvas-mcp @ https://github.com/Mattlo0546/canvas-mcp/archive/refs/tags/v0.2.0.zip",
               "exe": "canvas-mcp", "label": "the Canvas connection"},
    "classroom": {"spec": "classroom-mcp @ https://github.com/Mattlo0546/classroom-mcp/archive/refs/tags/v0.2.0.zip",
                  "exe": "classroom-mcp", "label": "the Google Classroom connection"},
}
SPEECH_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"  # parakeet-mlx's default
MIN_FREE_GB = 6  # don't start the automatic speech download on a nearly full disk

_jobs = {}  # name -> {"state": running|done|failed, "step": …, "error": …}
_lock = threading.Lock()


def apple_silicon():
    try:
        return subprocess.run(["sysctl", "-n", "hw.optional.arm64"], capture_output=True, text=True).stdout.strip() == "1"
    except Exception:
        return platform.machine() == "arm64"


def free_gb():
    return shutil.disk_usage(Path.home()).free / 1e9


def _installed_specs():
    try:
        return json.loads((ROOT / "installed.json").read_text())
    except (OSError, ValueError):
        return {}


def current(name):
    """Installed, and at the version this SlideMate pins (a connection installed by an older SlideMate isn't)."""
    have = _installed_specs().get(name)
    return (BIN / PACKAGES[name]["exe"]).exists() and (have == PACKAGES[name]["spec"] or
                                                      (have is None and name == "parakeet"))


def installed(name):
    exe = BIN / PACKAGES[name]["exe"]
    return exe.exists() and (name != "parakeet" or ((BIN / "ffmpeg").exists() and model_ready()))


def hf_cache():
    return Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface") / "hub"


def model_ready():
    snap = hf_cache() / ("models--" + SPEECH_MODEL.replace("/", "--")) / "snapshots"
    return any(snap.glob("*/*.safetensors"))


def status():
    """What's installed and any install in progress or failed, for Settings."""
    out = {}
    for n in PACKAGES:
        job = {k: v for k, v in (_jobs.get(n) or {}).items() if k != "thread"}
        out[n] = {"installed": installed(n), **job}
    # Parakeet set up some other way (Homebrew + uv) counts too.
    out["parakeet"]["installed"] = out["parakeet"]["installed"] or bool(
        config.which("parakeet-mlx") and config.which("ffmpeg") and model_ready())
    out["parakeet"]["supported"] = apple_silicon()
    return out


def _uv_env():
    return {**config.ENV, "UV_TOOL_DIR": str(ROOT / "venvs"), "UV_TOOL_BIN_DIR": str(BIN),
            "UV_PYTHON_INSTALL_DIR": str(ROOT / "python"), "UV_CACHE_DIR": str(ROOT / "cache"),
            "UV_MANAGED_PYTHON": "1", "UV_NO_MODIFY_PATH": "1", "UV_NO_PROGRESS": "1"}


def _uv(step):
    """The uv binary, downloaded (and checked) the first time."""
    uv = ROOT / "uv"
    if uv.exists():
        return uv
    step("Downloading the installer…")
    arch = "aarch64" if apple_silicon() else "x86_64"
    url = f"https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/uv-{arch}-apple-darwin.tar.gz"
    ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
        tgz = Path(tmp) / "uv.tar.gz"
        urllib.request.urlretrieve(url, tgz)
        import hashlib
        if hashlib.sha256(tgz.read_bytes()).hexdigest() != UV_SHA256[arch]:
            raise RuntimeError("The installer download was damaged. Check your internet connection and try again.")
        with tarfile.open(tgz) as t:
            member = next(m for m in t.getmembers() if m.name.endswith("/uv"))
            member.name = "uv"
            t.extract(member, tmp)
        shutil.move(str(Path(tmp) / "uv"), uv)
    uv.chmod(0o755)
    return uv


def _run(cmd, step, label, timeout=1800):
    p = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, timeout=timeout, env=_uv_env())
    if p.returncode:
        tail = (p.stderr or p.stdout).strip().splitlines()[-3:]
        raise RuntimeError(f"Couldn't install {label}. " + " ".join(tail)[:400])
    return p.stdout


def _venv_python(name):
    return ROOT / "venvs" / name_of(name) / "bin" / "python"


def name_of(name):
    return PACKAGES[name]["spec"].split()[0].split("==")[0]


def _install(name, step):
    pkg = PACKAGES[name]
    if name == "parakeet" and not apple_silicon():
        raise RuntimeError("Lecture recording needs a Mac with Apple Silicon (M1 or later).")
    uv = _uv(step)
    if not current(name):
        step(f"{'Updating' if (BIN / pkg['exe']).exists() else 'Installing'} {pkg['label']}…")
        cmd = [uv, "tool", "install", "--force", "--python", PYTHON, pkg["spec"]]
        for w in pkg.get("with", []):
            cmd += ["--with", w]
        _run(cmd, step, pkg["label"])
        _run([uv, "cache", "clean"], step, "the cleanup")  # the installed copies stay; frees a few hundred MB
        specs = _installed_specs()
        specs[name] = pkg["spec"]
        (ROOT / "installed.json").write_text(json.dumps(specs, indent=1))
    if name == "parakeet":
        if not (BIN / "ffmpeg").exists():
            exe = _run([_venv_python(name), "-c", "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"],
                       step, "ffmpeg").strip()
            (BIN / "ffmpeg").symlink_to(exe)
        if not model_ready():
            _download_model(step)
    elif not Path("/Applications/Google Chrome.app").exists():
        # Signing in to the university opens a browser window: without Chrome, use Playwright's own Chromium.
        playwright = ROOT / "venvs" / name_of(name) / "bin" / "playwright"
        if playwright.exists() and not any((Path.home() / "Library/Caches/ms-playwright").glob("chromium-*")):
            step("Downloading a browser window for signing in…")
            _run([playwright, "install", "chromium"], step, "the sign-in browser")


def _download_model(step):
    """Transcribe a second of silence: Parakeet downloads its model the first time. Reports MB downloaded."""
    work = Path(tempfile.mkdtemp(dir=ROOT))
    try:
        wav = work / "silence.wav"
        with wave.open(str(wav), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(b"\0\0" * 16000)
        p = subprocess.Popen([str(BIN / "parakeet-mlx"), str(wav), "--output-dir", str(work)],
                             stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, env=config.ENV)
        t0 = time.time()
        while p.poll() is None:
            # Hugging Face writes the file only when it's complete, so show the time it's been going.
            secs = int(time.time() - t0)
            step(f"Downloading the speech model (about 2.3 GB, once)… {secs // 60}:{secs % 60:02d}")
            time.sleep(1)
        if p.returncode or not model_ready():
            raise RuntimeError("Couldn't download the speech model. " + (p.stderr.read() or "").strip()[-300:])
    finally:
        shutil.rmtree(work, ignore_errors=True)


def install(name, wait=False):
    """Install in the background (or wait for it). Returns the job state."""
    with _lock:
        job = _jobs.get(name)
        if job and job["state"] == "running":
            t = job.get("thread")
        else:
            job = _jobs[name] = {"state": "running", "step": "Starting…"}

            def go():
                try:
                    _install(name, lambda s: job.update(step=s))
                    job.update(state="done", step="Ready")
                except Exception as e:  # noqa: BLE001 - shown in Settings
                    job.update(state="failed", error=str(e))
                    print(f"tools: installing {name} failed: {e}", flush=True)
            t = job["thread"] = threading.Thread(target=go, daemon=True)
            t.start()
    if wait:
        t.join()
    return {k: v for k, v in job.items() if k != "thread"}


def update_connections():
    """At startup: a university connection installed by an older SlideMate is updated to the version this one pins
    (e.g. Moodle/Blackboard that skip posters and guidance sites), and its tool list re-read."""
    import mcp
    for name in ("canvas", "moodle", "blackboard", "classroom"):
        spec = (config.load().get("mcp_servers") or {}).get(name) or {}
        if str(spec.get("command", "")).startswith(str(BIN)) and not current(name):
            if install(name, wait=True).get("state") == "done":
                try:
                    mcp.list_tools(name)
                except Exception as e:  # noqa: BLE001 - the next Pull tries again
                    print("tools: re-reading", name, e, flush=True)


def auto():
    """After setup: get lecture recording ready in the background, on Macs that can run it with room to spare."""
    cfg = config.load()
    if not cfg.get("setup_done") or not apple_silicon() or status()["parakeet"]["installed"]:
        return
    if free_gb() < MIN_FREE_GB:
        _jobs["parakeet"] = {"state": "failed", "error": f"Not enough free disk space (needs about {MIN_FREE_GB} GB)."}
        return
    install("parakeet")
