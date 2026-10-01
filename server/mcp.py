"""MCP (Model Context Protocol) support.

Servers you add in Settings are used in two ways:
  1. The tutor can call their tools while answering (Claude Code via --mcp-config, Codex via -c mcp_servers.*).
  2. SlideMate itself can call a tool directly, e.g. a Blackboard/Canvas "sync" tool behind the Sync button.

Config shape (config.json → "mcp_servers"):
  {"blackboard": {"command": "/path/blackboard-mcp", "args": ["serve"], "env": {}, "enabled": true}}
or for remote servers: {"url": "https://…/mcp", "enabled": true}
"""
import json
import os
import queue
import re
import subprocess
import threading
import time
from pathlib import Path

import config

PROTOCOL = "2025-06-18"
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


def servers(tutor_only=False):
    out = {}
    for name, s in (config.load().get("mcp_servers") or {}).items():
        if not NAME_RE.match(name) or not s.get("enabled", True):
            continue
        if tutor_only and not s.get("tutor", True):
            continue
        if s.get("command") or s.get("url"):
            out[name] = s
    return out


def fingerprint():
    return json.dumps(servers(tutor_only=True), sort_keys=True)


# ------------------------------------------------------------------ CLI config builders


def claude_args():
    """Extra `claude -p` arguments that expose the tutor's MCP servers (and allow their tools)."""
    srv = servers(tutor_only=True)
    if not srv:
        return []
    cfg = {}
    for name, s in srv.items():
        if s.get("url"):
            cfg[name] = {"type": "http", "url": s["url"], **({"headers": s["headers"]} if s.get("headers") else {})}
        else:
            cfg[name] = {"command": s["command"], "args": s.get("args", []), "env": s.get("env", {})}
    return ["--mcp-config", json.dumps({"mcpServers": cfg}), "--allowedTools", ",".join(f"mcp__{n}" for n in srv)]


def _toml(v):
    if isinstance(v, dict):
        return "{" + ", ".join(f"{json.dumps(k)} = {_toml(x)}" for k, x in v.items()) + "}"
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(_toml(x) for x in v) + "]"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    return json.dumps(str(v))  # JSON strings are valid TOML basic strings


def codex_args():
    """`codex exec -c …` overrides that add the tutor's MCP servers with their tools pre-approved."""
    out = []
    for name, s in servers(tutor_only=True).items():
        key = f"mcp_servers.{name}"
        if s.get("url"):
            out += ["-c", f"{key}.url={_toml(s['url'])}"]
        else:
            out += ["-c", f"{key}.command={_toml(s['command'])}", "-c", f"{key}.args={_toml(s.get('args', []))}"]
            if s.get("env"):
                out += ["-c", f"{key}.env={_toml(s['env'])}"]
        out += ["-c", f'{key}.default_tools_approval_mode="approve"', "-c", f"{key}.startup_timeout_sec=60"]
    return out


# ------------------------------------------------------------------ a tiny stdio MCP client


class MCPError(RuntimeError):
    pass


class Client:
    """Minimal MCP client for local (stdio) servers: initialize → tools/list → tools/call."""

    def __init__(self, spec, timeout=60):
        if not spec.get("command"):
            raise MCPError("Only local (command-based) servers can be called directly.")
        self.timeout = timeout
        env = {**config.ENV, **(spec.get("env") or {})}
        self.proc = subprocess.Popen([spec["command"], *spec.get("args", [])], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1, env=env,
                                     cwd=spec.get("cwd") or str(config.WORK))
        self.msgs = queue.Queue()
        self.next_id = 0
        threading.Thread(target=self._reader, daemon=True).start()
        self.request("initialize", {"protocolVersion": PROTOCOL, "capabilities": {},
                                    "clientInfo": {"name": "SlideMate", "version": "0.1"}})
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _reader(self):
        for line in self.proc.stdout:
            line = line.strip()
            if line:
                try:
                    self.msgs.put(json.loads(line))
                except ValueError:
                    pass  # servers sometimes log to stdout
        self.msgs.put(None)

    def _send(self, msg):
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def request(self, method, params=None, timeout=None):
        self.next_id += 1
        rid = self.next_id
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        while True:
            try:
                msg = self.msgs.get(timeout=timeout or self.timeout)
            except queue.Empty:
                raise MCPError(f"{method} timed out")
            if msg is None:
                err = self.proc.stderr.read()[-500:] if self.proc.stderr else ""
                raise MCPError(f"server exited. {err}".strip())
            if msg.get("id") == rid:
                if "error" in msg:
                    raise MCPError(msg["error"].get("message", str(msg["error"])))
                return msg.get("result", {})
            if "method" in msg and "id" in msg:  # server → client request (e.g. ping): reply empty
                self._send({"jsonrpc": "2.0", "id": msg["id"], "result": {}})

    def tools(self):
        return self.request("tools/list").get("tools", [])

    def call(self, tool, args=None, timeout=1800):
        res = self.request("tools/call", {"name": tool, "arguments": args or {}}, timeout=timeout)
        text = "\n".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
        return {"text": text, "is_error": bool(res.get("isError"))}

    def close(self):
        try:
            self.proc.terminate()
        except Exception:
            pass


def list_tools(name):
    spec = (config.load().get("mcp_servers") or {}).get(name)
    if not spec:
        raise MCPError("unknown server")
    if spec.get("url"):
        return {"remote": True, "tools": []}
    c = Client(spec)
    try:
        tools = [{"name": t["name"], "description": (t.get("description") or "")[:200]} for t in c.tools()]
    finally:
        c.close()
    config.set_mcp(name, {"tools": [t["name"] for t in tools]})  # cached for sync auto-detection
    return {"tools": tools}


# ------------------------------------------------------------------ "Pull" through an MCP tool

SYNC_RE = [re.compile(r"(^|_)(sync|pull)$", re.I), re.compile(r"sync(?!_status)|pull", re.I)]
LOGIN_RE = [re.compile(r"(^|_)login$", re.I), re.compile(r"login|sign.?in|auth", re.I)]


def _pick(tools, patterns):
    for rx in patterns:
        for t in tools:
            if rx.search(t):
                return t
    return ""


def detect_sync(name):
    """If this server has a sync-style tool, return {"server", "tool", "login_tool"}."""
    spec = (config.load().get("mcp_servers") or {}).get(name) or {}
    tools = spec.get("tools") or []
    tool = _pick(tools, SYNC_RE)
    return {"server": name, "tool": tool, "login_tool": _pick(tools, LOGIN_RE)} if tool else None


def autoconfigure(name):
    """After a server is added: learn its tools, and if it can sync and nothing else is set up, use it for Pull."""
    try:
        list_tools(name)
    except Exception as e:
        print("mcp autoconfigure", name, e, flush=True)
        return
    cfg = config.load()
    cur = cfg.get("sync_mcp") or {}
    if (cur.get("server") and cur.get("tool")) or cfg.get("sync_command", "").strip():
        return
    found = detect_sync(name)
    if found:
        config.update({"sync_mcp": found})


def _parse(text):
    try:
        return json.loads(text)
    except ValueError:
        return None


def _login_needed(d):
    return isinstance(d, dict) and (d.get("login_required") or (isinstance(d.get("report"), dict) and d["report"].get("login_required")))


def run_sync(name, tool, log, timeout=3600):
    """Call a sync tool and follow it to completion.

    Long syncs often run in the background and return {"running": true, …}; then we keep the server
    alive and poll its matching status tool (e.g. bb_sync → bb_sync_status), logging progress.
    Returns "ok" | "login_required" | "error".
    """
    spec = (config.load().get("mcp_servers") or {}).get(name)
    if not spec:
        log(f"MCP server '{name}' isn't set up")
        return "error"
    c = Client(spec)
    try:
        tools = [t["name"] for t in c.tools()]
        status_tool = next((t for t in (f"{tool}_status", tool.replace("sync", "sync_status")) if t in tools), None)
        log(f"Running {name} › {tool}…")
        res = c.call(tool, {}, timeout=timeout)
        d = _parse(res["text"])
        t0, last = time.time(), None
        while isinstance(d, dict) and d.get("running") and status_tool and time.time() - t0 < timeout:
            msg = d.get("progress")
            if msg and msg != last:
                log(str(msg))
                last = msg
            time.sleep(3)
            d = _parse(c.call(status_tool, {}, timeout=120)["text"])
        if _login_needed(d):
            log("Sign-in needed.")
            return "login_required"
        report = d.get("report") if isinstance(d, dict) and isinstance(d.get("report"), dict) else d
        if isinstance(report, dict) and report.get("error"):
            log(str(report["error"]))
            # 401/403/404 on "who am I" or an auth error means the session is stale: let the caller sign in again.
            if re.search(r"\b40[134]\b.*(users/me|auth|session|login)|unauthori[sz]ed|LoginRequired", str(report["error"]), re.I):
                return "login_required"
            return "error"
        if isinstance(report, dict) and report.get("summary"):
            log(str(report["summary"]))
        elif d is None:
            lines = [l for l in res["text"].splitlines() if l.strip()]
            for l in lines[-10:]:
                log(l)
            if res["is_error"]:
                return "login_required" if re.search(r"not signed in|sign.?in|expired|unauthori", res["text"], re.I) else "error"
        else:
            log("Done.")
        return "ok"
    except Exception as e:
        log(f"Error: {e}")
        return "error"
    finally:
        c.close()


def run_login(name, tool, log):
    log(f"Signing in with {name} › {tool}… (finish in the window that opens, if one does)")
    try:
        d = _parse(call_tool(name, tool, timeout=600)["text"]) or {}
    except Exception as e:
        log(f"Error: {e}")
        return False
    ok = not (isinstance(d, dict) and (d.get("ok") is False or d.get("login_required")))
    log("Signed in." if ok else f"Sign-in didn't finish: {d.get('reason') or d.get('message') or ''}")
    return ok


def call_tool(name, tool, args=None, timeout=1800):
    spec = (config.load().get("mcp_servers") or {}).get(name)
    if not spec:
        raise MCPError(f"MCP server '{name}' isn't set up")
    c = Client(spec)
    try:
        return c.call(tool, args, timeout)
    finally:
        c.close()


# ------------------------------------------------------------------ import from other apps


def _from_json(path, key="mcpServers"):
    try:
        data = json.loads(Path(path).expanduser().read_text())
    except Exception:
        return {}
    return data.get(key) or {}


def _from_codex_toml(path):
    """Read [mcp_servers.<name>] tables from Codex's config.toml (simple subset, no tomllib on Python 3.9)."""
    try:
        text = Path(path).expanduser().read_text()
    except Exception:
        return {}
    out, cur, sub = {}, None, None
    for raw in text.splitlines():
        line = raw.strip()
        m = re.match(r"^\[mcp_servers\.([A-Za-z0-9_-]+)(\.env)?\]$", line)
        if m:
            cur, sub = m.group(1), m.group(2)
            out.setdefault(cur, {})
            continue
        if line.startswith("["):
            cur = None
            continue
        if cur and "=" in line and not line.startswith("#"):
            k, v = [x.strip() for x in line.split("=", 1)]
            try:
                val = json.loads(v.replace("'", '"')) if v[:1] in "[\"'" else (v == "true" if v in ("true", "false") else v)
            except ValueError:
                val = v.strip("\"'")
            if sub:
                out[cur].setdefault("env", {})[k] = val
            else:
                out[cur][k] = val
    return {n: s for n, s in out.items() if s.get("enabled", True) is not False}


def discover():
    """MCP servers already configured in Claude Desktop, Claude Code and Codex."""
    found = {}
    sources = [
        ("Claude Desktop", _from_json("~/Library/Application Support/Claude/claude_desktop_config.json")),
        ("Claude Code", _from_json("~/.claude.json")),
        ("Codex", _from_codex_toml("~/.codex/config.toml")),
    ]
    for source, srvs in sources:
        for name, s in srvs.items():
            if not isinstance(s, dict) or not (s.get("command") or s.get("url")):
                continue
            if s.get("command", "").startswith("."):
                continue  # relative paths only make sense inside that app
            spec = {k: s[k] for k in ("command", "args", "env", "url", "headers") if s.get(k)}
            found.setdefault(re.sub(r"[^A-Za-z0-9_-]", "-", name)[:40], {**spec, "source": source})
    return found
