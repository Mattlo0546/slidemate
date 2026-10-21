# SlideMate comparison sources

[← Comparison tables](../README.md#compare-study-apps) · [Getting started](getting-started.md) · [Architecture](architecture.md)

Reviewed **21 October 2026**. The README compares SlideMate with ChatGPT, Claude, NotebookLM / Gemini Notebook, StudyFetch and Quizlet using official product documentation. It compares student workflows, not model intelligence, learning outcomes or market share. The selection is not a popularity ranking.

## How to read the tables

Each cell describes a documented way to complete a task. A transcript-upload workflow does not imply that a competitor has no other audio features. “Not documented” is reserved for two precisely defined workflows that were not found in the reviewed sources:

- **University LMS → organised local course library:** authenticate to a supported university dashboard, pull course materials and classify local PDFs by course, type and week.
- **Slide/snip → named iPad:** send the current slide or selected region through AirDrop and automatically select a configured recipient.

Cloud-drive imports, generic sharing, custom agents and third-party integrations do not establish those exact built-in workflows. Absence from these sources is not proof of impossibility. These are documentation comparisons, not hands-on tests of every plan or integration. Availability may change after the review date.

## SlideMate

The entries describe the source on `main`, which can include features newer than a packaged release. [Installation and release distinctions](getting-started.md) explain the current download.

| Claim | Implementation / documentation |
| --- | --- |
| Provider choice and sign-in | [providers.py](../server/providers.py); [AI setup](getting-started.md#choose-your-ai) |
| University pulls and course library | [mcp.py](../server/mcp.py), [university.py](../server/university.py), [library.py](../server/library.py) |
| Named-recipient AirDrop | [airdrop.swift](../macos/AirDrop/airdrop.swift); [setup and requirements](getting-started.md#send-a-slide-to-your-ipad) |
| Local transcription and slide-linked notes | [lecture.py](../server/lecture.py); [lecture workflow](getting-started.md#record-or-import-a-lecture) |
| Personalised cards, FSRS and Anki text export | [flashcards.py](../server/flashcards.py); [review workflow](getting-started.md#review-flashcards) |

SlideMate is free and MIT-licensed. Cloud-provider eligibility and quotas still apply. Local transcription requires Apple Silicon; Ollama inference has model and hardware requirements. Local storage does not mean cloud-provider processing is offline. There is no standalone SlideMate iPad app.

## ChatGPT

- [Study Mode](https://help.openai.com/en/articles/11780217-using-study-mode-in-chatgpt): guided explanations, uploaded study material, practice questions and flashcard-style review. The reviewed documentation says Study Mode is not available inside Projects; the table does not imply these are one combined mode.
- [Projects](https://help.openai.com/en/articles/10169521-projects-in-chatgpt): related chats, files and instructions; supported app sources.
- [File and audio uploads](https://help.openai.com/en/articles/8555545-uploading-files-and-audio-to-chatgpt): document analysis and audio transcription, with plan-dependent access.
- [Record](https://help.openai.com/en/articles/11487532-chatgpt-record): recording, transcription and summaries in the Mac app on eligible plans.

ChatGPT's learning tools and recording are credited explicitly. SlideMate's FSRS scheduler should not be confused with generating flashcard-style text in a chat.

## Claude

- [File uploads](https://support.claude.com/en/articles/8241126-upload-files-to-claude): PDF and text-file analysis, with visual PDF processing subject to limits.
- [Projects](https://support.claude.com/en/articles/9517075-what-are-projects): reusable files and conversation context. The page also describes a staged project beta; availability differs by account.

The lecture comparison describes uploading a text transcript, a supported file type, and discussing it. It makes no blanket claim that Claude lacks recording or that a custom workflow could not be built. SlideMate's Claude integration uses eligible CLI access, which is distinct from simply having a free Claude chat account.

## NotebookLM / Gemini Notebook

Google's NotebookLM help URLs redirected to **Gemini Notebook** help at review time. Both names appear in the README to make the comparison recognisable.

- [Notebook workspace and generated formats](https://support.google.com/gemininotebook/answer/16206563): source-based chat, notes, Audio/Video Overviews and mind maps.
- [Sources and audio imports](https://support.google.com/gemininotebook/answer/16215270): files, Drive and web sources; uploaded audio becomes a transcribed source.
- [Flashcards and quizzes](https://support.google.com/gemininotebook/answer/16958963): generated cards/quizzes, progress tracking, missed-card review and CSV export.

The table credits its flashcards and audio capabilities; it does not describe NotebookLM as only a summariser or claim that its cards cannot be exported.

## StudyFetch

- [Product overview](https://www.studyfetch.com/): course-material study tools, tutoring and generated study formats.
- [Live Lecture](https://www.studyfetch.com/features/live-lecture): recording, transcription, enhanced notes and conversion into revision material.
- [Use Flashcards](https://sso.studyfetch.com/docs/docs/product-docs/6a52628f02a11a95bc7fcc0e): built-in spaced repetition and confidence ratings.
- [Flashcard study tools](https://www.studyfetch.com/docs/docs/product-docs/6a52637502a11a95bc7fcc17): practice tests, quizzes, audio recaps and other formats.

StudyFetch already connects lecture capture and revision. SlideMate's comparison therefore emphasises its Mac/iPad integration, university pulls and provider choice rather than treating recording or spaced repetition as exclusive features.

## Quizlet

- [AI study tools](https://quizlet.com/features/ai-study-tools): flashcards, Learn, study guides, PDF summaries and practice tests; some features are free and advanced features use paid plans.
- [Study Guide Maker](https://quizlet.com/features/study-guides/): notes/file uploads and Google Drive imports.
- [Study Guides upload interface](https://quizlet.com/study-guides/upload): its publicly indexed interface lists **Record audio** alongside text, file and Drive input. This supports the narrow table claim; it is not a test of recording limits, transcription quality or account eligibility.

Quizlet is credited for both material generation and study modes. The comparison does not imply that flashcards or AI study guides are exclusive to SlideMate.

## Keeping this accurate

When updating a comparison, revisit the official sources, check availability restrictions and change the review date. Add evidence before marking a feature present; use “Not documented” rather than an unsupported “No.” Keep the README and this source note in agreement, and distinguish current source capabilities from released SlideMate builds.
