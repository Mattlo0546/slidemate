# Getting started with SlideMate

[← SlideMate](../README.md) · [Architecture](architecture.md)

SlideMate is a macOS app for studying lecture PDFs with an AI tutor, university material pulls, AirDrop to iPad, lecture notes and flashcards. The app is free; your selected AI provider controls account eligibility and usage limits.

## Install the app

1. Open the [latest release](https://github.com/Mattlo0546/slidemate/releases/latest).
2. Download **SlideMate-0.6.0-macOS.dmg** (recommended) or **SlideMate-0.6.0-macOS.zip** from the release's Assets, not GitHub's automatically generated “Source code” archive.
3. Unzip the download, or open the DMG, and drag **SlideMate.app** to **Applications**.
4. Open **Applications → SlideMate**. If macOS blocks it, follow **First launch** below before continuing to the welcome flow.

Both v0.6.0 downloads include **Start Here.html** beside the app. Open it in your browser to keep the first-launch steps visible while you install; the guide works offline.

The app requires **macOS 13+** on Apple Silicon or Intel. Local audio transcription uses Parakeet MLX and requires Apple Silicon. Importing an existing transcript does not require Parakeet.

### First launch

The v0.6.0 downloads are not Apple-notarised. You may see “Apple could not verify” or an “unidentified developer” alert before SlideMate's welcome screen can open. If SlideMate opens normally, go straight to [Choose your AI](#choose-your-ai).

After checking that your copy came from [this repository's releases](https://github.com/Mattlo0546/slidemate/releases) and you trust it:

1. **Try opening SlideMate from Applications once.** Dismiss the verification alert with **Done**, **OK** or **Cancel**, depending on your macOS version. Keep the app in Applications.
2. Open the **Apple menu → System Settings → Privacy & Security**.
3. Scroll to **Security**, find the message about **SlideMate**, and click **Open Anyway**. If your version shows **Open** first, select it to reach **Open Anyway**.
4. Confirm **Open** if another alert appears, and enter your **Mac login password** if asked. SlideMate can now open and show its welcome screen.

macOS remembers this approval for this copy of SlideMate. You do not need to repeat it every time you study. On **macOS 13–14**, you can also Control-click SlideMate in Finder, choose **Open**, then confirm **Open**.

<details>
<summary><strong>Can't find Open Anyway, or still stuck?</strong></summary>

- **No Open Anyway button:** it only appears after an attempted launch, for about an hour. Open SlideMate from Applications again, dismiss the alert, then return to Privacy & Security and scroll down to Security.
- **A university or work Mac:** your administrator may restrict this option. Ask your IT team to approve SlideMate.
- **“Will damage your computer” or “contains malware”:** these are different alerts. Do not use these steps to override them; stop and [report the exact warning](https://github.com/Mattlo0546/slidemate/issues).
- **The app is missing:** if you chose Move to Bin in the alert, download a fresh copy from the official release and move it to Applications again.

</details>

This approval is for opening SlideMate. **Microphone** access is requested when you record; the optional AirDrop auto-select feature has its own **Accessibility** permission. You do not need to change those settings just to open the app.

Apple's instructions: [Safely open apps on your Mac](https://support.apple.com/en-gb/102445) · [Open an app by overriding security settings](https://support.apple.com/en-gb/guide/mac-help/mh40617/mac).

The source includes optional Developer ID signing and notarisation for future releases; that does not mean an existing download is notarised. Check the release notes for the build you install.

SlideMate checks GitHub for updates and offers **Install and Relaunch**. You can also use SlideMate → **Check for Updates…**.

## Choose your AI

SlideMate runs a provider's CLI using your own signed-in account. There is no separate SlideMate subscription or API key requirement for these sign-in paths. Provider plans, quotas, model availability and terms still apply.

| Adapter | Account or runtime | Context handling |
| --- | --- | --- |
| Claude | Claude Code with an eligible Claude account | Native PDF when size/page limits allow; text fallback otherwise |
| ChatGPT | Codex CLI with an eligible ChatGPT account | Deck text and current-slide image |
| Cursor | Cursor CLI with an eligible account | Deck text and image access through the CLI |
| Grok | Grok CLI with an eligible account | Deck text and current-slide image |
| Antigravity | Antigravity CLI with an eligible Google account | Deck text and image access through the CLI |
| Ollama | A downloaded model running locally | Deck text; images only with a vision-capable model |

The welcome flow helps install and sign in to the supported cloud options. Additional providers and models are available in Settings. Free-tier access depends on what the provider currently includes; “free SlideMate” does not promise unlimited cloud inference.

For Ollama, install the runtime and download a model compatible with your Mac. The code suggests `qwen3-vl:8b`; model memory, disk and performance requirements vary. Local models use a smaller context budget and do not use SlideMate's MCP tutor tools.

## Connect your university

Current `main` offers university search during setup and in **Settings → Your university**. Search by institution name or university email, or select the connector and enter the university site's address.

| System | Connector source | Setup |
| --- | --- | --- |
| Canvas | [canvas-mcp](https://github.com/Mattlo0546/canvas-mcp) | Connect the institution's Canvas site and sign in |
| Moodle | [moodle-mcp](https://github.com/Mattlo0546/moodle-mcp) | Connect the institution's Moodle site and sign in |
| Blackboard | [blackboard-mcp](https://github.com/Mattlo0546/blackboard-mcp) | Connect the institution's Blackboard site and sign in |
| Google Classroom | [classroom-mcp](https://github.com/Mattlo0546/classroom-mcp) | Supply your Google OAuth client file, then sign in |

SlideMate installs its connection tools in its application-support folder and opens the institution's sign-in flow. SSO and MFA follow the university's process. The first connection pulls materials; **Pull** fetches new materials afterwards. If a session expires, SlideMate can invoke the connector's sign-in tool and retry.

Institution names in the search directory help locate a service; they are not endorsements or a guarantee that every course at that institution works. Some university configurations require additional support.

**Release history:** v0.5.0 introduced the built-in Moodle/Blackboard connection flow. v0.6.0 adds university search, Canvas and the expanded directory.

### Tutor access and Pull are separate

Each connector has switches for whether the **tutor may use its tools** and whether it serves the **Pull** action. The tutor can retrieve course information such as deadlines and announcements through enabled connectors. Google Classroom's initial OAuth client setup is an exception to the otherwise guided sign-in flow.

Other MCP servers can be added under **Advanced**, or imported from supported AI app configurations. Local command-based MCP servers can be called directly by SlideMate; remote server support in tutor sessions depends on the provider adapter. Enable only tools you intend the tutor to use.

## Send a slide to your iPad

1. Enter your iPad's AirDrop name in SlideMate's settings.
2. Choose **Enable auto-select**, then allow **SlideMate AirDrop** in macOS System Settings → Privacy & Security → Accessibility.
3. Make the iPad discoverable and use **Send to iPad** on a slide or snip.

macOS does not expose a silent AirDrop API. SlideMate opens the system panel and the helper selects the named recipient. Without Accessibility permission, select the iPad manually. Normal receiving and import behaviour still applies on the iPad.

Images also go to the clipboard, for use with Universal Clipboard when configured, and are saved in `~/Pictures/SlideMate`. You can use the received image in Goodnotes, Notability or another note-taking app.

## Record or import a lecture

On Apple Silicon, SlideMate sets up **ffmpeg** and **Parakeet MLX** after onboarding. The speech model is a substantial download; Settings → Lecture recording shows installation progress.

Open the relevant PDF and press **Record**. SlideMate records audio and slide-view events, shows partial transcripts, then generates a summary and notes for the slides discussed when you stop. Transcript quotes retain timestamps for playback where audio is available. Follow your university's rules when recording lectures, tutorials and seminars.

Already have a transcript from Otter, Granola or lecture capture? Use **Lecture notes → Import transcript**. Developer integrations can submit timed sentences to `POST /api/lecture/import`; see the [architecture notes](architecture.md#the-lecture-to-revision-path).

Automatic retrieval/transcription of university-hosted recordings has not been verified in this source. The documented catch-up path is transcript import. A transcript is speech-recognition output, so its “verbatim” quotes can still contain recognition mistakes.

## Review flashcards

Completed lecture notes can trigger automatic flashcard generation. Cards draw on the slides, notes and tutor questions, and are organised by subtopic. Later revision questions can add cards to an existing deck after the conversation goes quiet. You can also request cards manually.

Press **R** to review. Rate each answer; FSRS-5 updates the next due time. **Study everything due** combines courses. Edit cards when needed, and export Anki-compatible text containing Basic or Cloze notes and tags. Export is a file you import into Anki, not two-way Anki synchronisation.

## Where your work lives

Default application data:

```text
~/Library/Application Support/SlideMate/
├── config.json       # settings, including configured connector secrets
├── Slides/           # course materials on a new installation
├── chats/            # per-deck conversations with slide references
├── chat-images/      # pictures attached to questions
├── lectures/         # audio, transcript, events, notes and job state
├── tools/            # managed tools and model dependencies
└── work/             # provider scratch space
```

You can add existing slide folders in Settings → Library. Display categories and titles are metadata; classification does not rearrange an existing library. Dropped/inbox PDFs can be filed into courses. Markdown exports are written alongside the course materials in **SlideMate Chats**, **Lectures (SlideMate)** and **SlideMate Flashcards** folders. Flashcard JSON and review data live under application support too.

With cloud AI, relevant study context is sent to the selected provider. [Full data boundaries](architecture.md#data-and-trust-boundaries).

## Build from source

Requires macOS 13+, Homebrew and Apple's command-line build tools. The installer manages supporting dependencies; follow its prompts and the AI sign-in flow.

```bash
git clone https://github.com/Mattlo0546/slidemate.git
cd slidemate
scripts/install.sh
```

`install.sh` installs dependencies, builds the app, copies it into Applications and opens it. For a build without installing the application:

```bash
scripts/install.sh --build-only
```

For development, `scripts/dev.sh` uses port 8768 and a separate `SlideMate-dev` data folder. See [development and validation](architecture.md#development-and-validation).

## Uninstall

Remove **SlideMate.app** from Applications. Application data remains in `~/Library/Application Support/SlideMate`; keep it if you want your study history later. Existing external slide folders are separate from the app. Remove generated screenshots from `~/Pictures/SlideMate` only if you no longer want them.
