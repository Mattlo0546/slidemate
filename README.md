# SlideMate

**Study lecture slides with an AI tutor that has read the whole deck.** Ask "explain this slide" and get an answer that
knows what came before and what comes next. Send any slide (or a snipped part of one) to your iPad in one click.
Record a lecture and get a skimmable summary plus notes for every slide, with the lecturer's exact words.

Runs locally on your Mac and uses the AI app you're already signed in to: **Claude** (Claude Code) or **ChatGPT**
(Codex CLI). No API keys.

## Features

- **Whole-deck tutor**: right-click a slide → *Explain this slide*, or ask anything. The tutor sees the slide you're on
  plus the entire deck, and links answers to other slides ("this builds on slide 7").
- **Chats saved per slide**: come back to a slide while revising and your questions and answers are still there.
  Also saved as Markdown next to your slides.
- **Send to iPad**: one click AirDrops the slide (or a snipped area) to your iPad, and copies it to the clipboard for
  pasting into GoodNotes or Notability via Universal Clipboard. Optional auto-select picks your iPad for you.
- **Lecture notes**: hit *Record* in class. SlideMate transcribes on-device with NVIDIA Parakeet, logs which slide
  you were viewing, then writes:
  - a **summary**: what you learned, to-dos, deadlines, exam tips
  - **notes for each slide**, with verbatim quotes and ▶ buttons that play that moment of the recording

  You can also import a transcript, e.g. from Granola or Otter.
- **Organised library**: point SlideMate at your course folders. It sorts files into Lectures, Labs, Readings,
  Exercises and so on by week, without moving anything. PDFs dropped into the app or the `_Inbox` folder get filed
  into the right course automatically.
- **MCP connections**: connect MCP servers, such as your university's Blackboard or Canvas, so the tutor can check
  deadlines, announcements and materials while it answers. You can import the servers you already use in Claude
  Desktop, Claude Code or Codex with one click.
- **Optional sync**: point the *Sync now* button at an MCP tool (e.g. `bb_sync`) or at any shell command that
  downloads slides.

## Install

Requirements: macOS 13+, [Homebrew](https://brew.sh), and Claude Code **or** Codex CLI signed in.

```bash
git clone https://github.com/YOUR-USERNAME/slidemate.git
cd slidemate
scripts/install.sh
```

The installer adds `poppler` and `ffmpeg`, plus `parakeet-mlx` on Apple Silicon. It then builds `SlideMate.app` and
copies it to Applications. On first launch, **right-click → Open** (the app is ad-hoc signed, not notarised). A setup
screen asks for your slides folder and your AI provider.

**AI provider (pick one or both):**

| Provider | Install | Sign in |
| --- | --- | --- |
| Claude | `curl -fsSL https://claude.ai/install.sh \| bash` | `claude auth login` (Pro/Max account) |
| ChatGPT | `brew install codex` | `codex login` (ChatGPT account) |

SlideMate runs these CLIs on your behalf with your own subscription. Check each provider's terms for your plan.

## How your files are organised

```
Uni/                      ← the folder you choose in setup
├── Robotics/             ← each sub-folder is a course
│   ├── Week 01/...pdf
│   └── Lectures (SlideMate)/   ← lecture summaries, slide notes, transcripts (Markdown)
├── Philosophy of AI/
│   └── SlideMate Chats/        ← your tutor chats (Markdown)
└── _Inbox/               ← drop PDFs here and they get filed into the right course
```

SlideMate's own data lives in `~/Library/Application Support/SlideMate`: settings, chats, lecture recordings and
notes. Screenshots you send to the iPad are saved in `~/Pictures/SlideMate`.

## Send to iPad auto-select

macOS has no silent AirDrop API, so SlideMate opens the AirDrop panel and clicks your iPad for you. To enable it,
open Settings, enter your iPad's AirDrop name, click **Enable auto-select**, and turn on **SlideMate AirDrop** under
System Settings → Privacy & Security → Accessibility. Without it, you click your iPad once in the panel.

## MCP connections

Settings → **Connections (MCP)** → *Import from Claude / Codex…*, or *Add server…* with a command and arguments
(the same format as Claude Desktop's `mcpServers`).

- **Tutor**: when this is ticked, the tutor can call the server's tools mid-answer, and you'll see "Using
  blackboard › bb_upcoming…" while it works. With Claude, servers are passed via `--mcp-config` with their tools
  allowed. With Codex, they're passed as `-c mcp_servers.*` overrides with `default_tools_approval_mode="approve"`.
- **Sync**: set *Sync using → An MCP tool* to have the Sync button call a tool directly, such as `bb_sync`, with an
  optional sign-in tool for expired sessions. SlideMate includes a small stdio MCP client for this.
- **Credentials**: environment variables, such as API tokens, stay in `config.json`, which only you can read. They
  are never sent to the UI.

## How it works

SlideMate is a small local web app: a Python server (standard library only) on `127.0.0.1`, and a web UI using
PDF.js, KaTeX and marked. `SlideMate.app` is a thin native window (WKWebView) that starts the server and shows the UI.

| Piece | Where |
| --- | --- |
| Server, library, chats | `server/server.py`, `server/library.py` |
| AI providers (Claude Code / Codex) | `server/providers.py` |
| MCP connections + client | `server/mcp.py` |
| Lecture recording → notes | `server/lecture.py` |
| UI | `server/static/` |
| Native app + AirDrop helper | `macos/` |

The server only listens on localhost and requires a custom header on every API call, so web pages can't reach it.

## Development

```bash
scripts/dev.sh            # runs the server from source on http://127.0.0.1:8768 with a separate data folder
scripts/build-app.sh      # builds build/SlideMate.app
```

UI changes in `server/static/` only need a page refresh. Optional: `chrome-extension/` adds an "Open in SlideMate"
button for PDFs open in Chrome. To install it, load it unpacked from `chrome://extensions`.

## License

MIT. Bundled third-party libraries are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
