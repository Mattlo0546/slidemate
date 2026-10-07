# Demo tooling

How the GIFs in the main README (and the launch videos) are made. Everything is scripted, so they can be re-shot
after UI changes.

```bash
cd docs/demo && npm i playwright@1.49 && npx playwright install chromium
node decks.mjs Uni                 # original sample lecture decks (PDF) → Uni/
# start a sandboxed SlideMate on port 8769 with library root = docs/demo/Uni, then import transcript.txt
# as the lecture for "Week 3 - Gradient Descent" (Lecture notes → ⋯ → Import transcript)
node stage.mjs && node cards.mjs   # window frame, backdrop, title/end cards
node record.mjs explain snip notes zoom library   # drives the real app; fake cursor + captions are overlays
for s in explain snip notes zoom library; do ./compose.sh $s; done   # → out/<scene>.mp4 + .gif
```

- `record.mjs` captures high-res frames with the Chrome DevTools screencast, and only `/api/send` is stubbed (so no
  real AirDrop panel opens); the iPad that slides in shows the actual snipped image. Tutor answers are real.
- `assemble.py` keeps real timing but speeds up the "thinking" wait (marked in the script).
