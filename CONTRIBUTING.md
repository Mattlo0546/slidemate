# Contributing to SlideMate

SlideMate helps students move from lecture materials to understanding and revision with less setup. Changes should make that workflow clearer, more reliable or easier to use.

## Start here

- [Product overview](README.md)
- [Architecture and code map](docs/architecture.md)
- [Setup and source installation](docs/getting-started.md)
- [Issues](https://github.com/Mattlo0546/slidemate/issues)

Use `scripts/dev.sh` for a separate development data folder. Do not test against another student's course files or publish private lecture materials, transcripts, sign-in state or connector credentials. Original sample lectures are supported by the [demo tooling](docs/demo/README.md).

## Propose a change

For bugs, include SlideMate and macOS versions, the provider/connector involved, reproduction steps, expected behaviour and what happened. Redact secrets from logs and use a minimal original PDF when a document is needed to reproduce the problem.

For a new university connector, describe its authentication flow, supported operations and how it fits the separate Tutor and Pull permissions. An institution's presence in the directory is not evidence that all of its courses or authentication configurations have been tested.

Keep pull requests focused. Explain the user-visible problem, resulting behaviour and validation. Include screenshots for visual changes and describe any manual steps needed to verify a device/account integration.

## Validate what changed

The existing build workflow checks Python syntax, JavaScript parsing, the native app build and a local server health response. Run the relevant checks for your change; verify provider streaming/cancellation, recording recovery or connector login manually when those paths change. Documentation-only updates need working links, accurate claims and a visual rendering check.

If a feature is only on `main`, distinguish it from the latest downloadable release. When changing product behaviour, update the README, relevant guide and `llms.txt` together. Keep the AI-readable reference factual and aligned with visible documentation.

## Logo assets

`server/static/logo.svg` is the tightly framed web mark. `macos/icon.svg` uses the same white rounded-square body and two black eyes, inset on a 1024 × 1024 transparent canvas for the macOS icon build. Keep both geometries consistent. Hero and social graphics embed the same mark.

All contributions use the repository's [MIT license](LICENSE); retain applicable third-party notices.
