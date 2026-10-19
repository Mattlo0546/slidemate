# Third-party software

SlideMate bundles these libraries in `server/static/vendor/`:

| Library | Version | License |
| --- | --- | --- |
| [PDF.js](https://github.com/mozilla/pdf.js) | 4.10.38 | Apache-2.0 |
| [KaTeX](https://github.com/KaTeX/KaTeX) | 0.16 | MIT |
| [marked](https://github.com/markedjs/marked) | 14.1 | MIT |

At runtime SlideMate can call, if installed: Claude Code, Codex CLI, parakeet-mlx (NVIDIA Parakeet), ffmpeg and
poppler. These are not distributed with SlideMate.

The connector logos in `server/static/logos/` identify each learning platform. The Canvas, Moodle and Google Classroom
marks are from [Simple Icons](https://simpleicons.org) (CC0); the Blackboard mark is drawn. Canvas is a trademark of
Instructure, Moodle of Moodle Pty Ltd, Blackboard of Anthology Inc. and Google Classroom of Google LLC. SlideMate isn't
affiliated with them.
