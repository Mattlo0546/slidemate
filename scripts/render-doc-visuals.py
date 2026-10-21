#!/usr/bin/env python3
"""Render deterministic README artwork. Run from any directory; no dependencies."""
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / 'docs' / 'media'
THEMES = {
    'light': dict(bg='#ffffff', fg='#1f2328', muted='#59636e', line='#8c959f',
                  border='#d1d9e0', surface='#f6f8fa', accent='#315fdd', solid='#1f2328', onsolid='#ffffff'),
    'dark': dict(bg='#0d1117', fg='#e6edf3', muted='#a0a9b4', line='#8b949e',
                 border='#3d444d', surface='#161b22', accent='#8aabff', solid='#e6edf3', onsolid='#0d1117'),
}


class SVG:
    def __init__(self, w, h, title, desc, theme):
        self.c = THEMES[theme]
        self.parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-labelledby="title desc">',
                      f'<title id="title">{escape(title)}</title><desc id="desc">{escape(desc)}</desc>',
                      f'<rect width="{w}" height="{h}" fill="{self.c["bg"]}"/>',
                      f'<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="{self.c["line"]}" stroke-width="1.5"/></marker></defs>',
                      '<g font-family="Helvetica Neue, Helvetica, Arial, sans-serif">']

    def text(self, x, y, text, size=22, weight=400, color='fg', anchor='start', mono=False, tracking=None):
        attr = ' font-family="SFMono-Regular, Consolas, Liberation Mono, monospace"' if mono else ''
        if tracking is not None:
            attr += f' letter-spacing="{tracking}"'
        self.parts.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{self.c.get(color, color)}" text-anchor="{anchor}"{attr}>{escape(text)}</text>')

    def rect(self, x, y, w, h, fill='bg', stroke='border', radius=7, dashed=False):
        dash = ' stroke-dasharray="5 5"' if dashed else ''
        self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{self.c.get(fill, fill)}" stroke="{self.c.get(stroke, stroke)}" stroke-width="1.5"{dash}/>')

    def path(self, d, arrow=True, dashed=False, both=False):
        attrs = ' marker-end="url(#arrow)"' if arrow else ''
        if both:
            attrs += ' marker-start="url(#arrow)"'
        if dashed:
            attrs += ' stroke-dasharray="5 5"'
        self.parts.append(f'<path d="{d}" fill="none" stroke="{self.c["line"]}" stroke-width="1.5" stroke-linejoin="round"{attrs}/>')

    def box(self, x, y, w, title, sub, *, h=84, solid=False, external=False, small=False):
        self.rect(x, y, w, h, 'solid' if solid else 'surface' if small else 'bg',
                  'solid' if solid else 'line' if external else 'border', dashed=external)
        self.text(x+w/2, y+33, title, 23 if not small else 21, 600, 'onsolid' if solid else 'fg', 'middle')
        self.text(x+w/2, y+61, sub, 17, 400, 'onsolid' if solid else 'muted', 'middle', mono=True)

    def logo(self, x, y, size, *, lifted=False):
        # Preserve the approved white body and straight, centred black eyes.
        scale = size / 864
        self.parts.append(f'<g transform="translate({x} {y}) scale({scale})">')
        if lifted:
            # A contact shadow and inset edge keep the white icon legible on white.
            self.parts.append('<defs><filter id="icon-shadow" x="-25%" y="-25%" width="150%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="24"/><feOffset dy="20" result="shadow"/><feFlood flood-color="#1f2328" flood-opacity="0.18"/><feComposite in2="shadow" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>')
            self.parts.append('<rect width="864" height="864" rx="190" fill="#fff" filter="url(#icon-shadow)"/><rect x="5" y="5" width="854" height="854" rx="185" fill="none" stroke="#b7bec8" stroke-width="10"/>')
        else:
            self.parts.append('<rect width="864" height="864" rx="190" fill="#fff" stroke="#d1d9e0" stroke-width="7"/>')
        self.parts.append('<rect x="268" y="306" width="104" height="252" rx="52" fill="#000"/><rect x="492" y="306" width="104" height="252" rx="52" fill="#000"/></g>')

    def save(self, name, theme):
        suffix = '-dark' if theme == 'dark' else ''
        (MEDIA / f'{name}{suffix}.svg').write_text('\n'.join(self.parts + ['</g></svg>'])+'\n')


def hero(theme):
    s = SVG(1280, 280, 'SlideMate', 'Your slides. Your tutor. One study space. An all-in-one study app for Mac.', theme)
    s.logo(100, 86, 108, lifted=True)
    s.text(236, 162, 'SlideMate', 76, 650, tracking=-2.7)
    s.text(758, 127, 'Your slides. Your tutor.', 30, 500)
    s.text(758, 171, 'One study space.', 30, 500, 'accent')
    s.save('hero', theme)


def social():
    s = SVG(1280, 640, 'SlideMate for Mac', 'Your slides. Your tutor. One study space. Free and open source.', 'light')
    s.logo(104, 204, 168)
    s.text(316, 275, 'SlideMate', 100, 650, tracking=-4)
    s.text(321, 338, 'Your slides. Your tutor. One study space.', 34, 400)
    s.text(105, 557, 'Free & open source · Built for Mac', 23, color='muted')
    s.text(1175, 557, 'github.com/Mattlo0546/slidemate', 21, color='muted', anchor='end')
    s.save('social-preview', 'light')


def architecture(theme):
    s = SVG(1280, 860, 'SlideMate system architecture', 'A native Swift shell hosts a PDF.js web view. A loopback Python API coordinates local files, university connectors, provider sessions, lectures and revision. Dashed boxes identify university services, cloud AI and the iPad. Ollama and Parakeet run locally.', theme)
    s.text(40, 43, 'SlideMate / system architecture', 24, 500)
    s.text(1240, 43, 'Dashed outline = outside this Mac', 18, color='muted', anchor='end')
    # Connections are drawn first and terminate at the edges of components.
    s.path('M384 126 H448')
    s.path('M212 168 V218 H490 V264')
    s.text(350, 205, 'starts', 17, color='muted', anchor='middle')
    s.path('M792 306 H856')
    s.path('M1028 264 V168')
    s.text(1049, 222, 'AirDrop', 18, color='muted')
    s.path('M620 168 V264', both=True)
    s.text(642, 222, 'HTTP + SSE', 18, color='muted', mono=True)
    s.path('M448 306 H384')
    s.text(416, 290, 'I/O', 16, color='muted', anchor='middle', mono=True)
    s.path('M620 348 V402', arrow=False)
    s.path('M212 402 H1028', arrow=False)
    for x in (212, 620, 1028):
        s.path(f'M{x} 402 V460')
    s.path('M212 552 V674', both=True)
    s.text(232, 619, 'MCP connectors', 18, color='muted', mono=True)
    s.path('M620 552 V608', arrow=False)
    s.path('M530 608 H710', arrow=False)
    s.path('M530 608 V674', both=True)
    s.path('M710 608 V674', both=True)
    s.path('M1028 552 V674')
    s.text(1048, 619, 'local ASR', 18, color='muted', mono=True)
    s.box(40, 84, 344, 'Native shell', 'Swift · AppKit')
    s.box(448, 84, 344, 'Study interface', 'WKWebView · PDF.js')
    s.box(856, 84, 344, 'Your iPad', 'AirDrop + clipboard', external=True)
    s.box(40, 264, 344, 'Local files', 'PDF · JSON · Markdown', small=True)
    s.box(448, 264, 344, 'Python API', '127.0.0.1 · server.py', solid=True)
    s.box(856, 264, 344, 'Share helper', 'Swift · Accessibility')
    s.box(40, 460, 344, 'Library + connectors', 'library.py · mcp.py', h=92)
    s.box(448, 460, 344, 'AI sessions', 'providers.py', h=92)
    s.box(856, 460, 344, 'Lectures + revision', 'lecture.py · flashcards.py', h=92)
    s.box(40, 674, 344, 'University services', 'Canvas · Moodle · more', external=True)
    s.box(448, 674, 164, 'Cloud AI', 'CLI sign-in', external=True, small=True)
    s.box(628, 674, 164, 'Ollama', 'local model', small=True)
    s.box(856, 674, 344, 'Parakeet MLX', 'on-device transcription', small=True)
    s.text(40, 819, 'Lecture notes and flashcard generation use the same provider layer. Study state is saved locally.', 20, color='muted')
    s.save('architecture', theme)


def sequence(theme):
    s = SVG(1280, 890, 'A slide question through SlideMate', 'The slide viewer sends context to the local API and provider session. The model streams events back through the session and API; chat files preserve the conversation.', theme)
    s.text(40, 43, 'Tutor / request lifecycle', 24, 500)
    centers = [144, 392, 640, 888, 1136]
    labels = [('Slide viewer', 'PDF.js'), ('Local API', 'server.py'), ('Deck session', 'providers.py'), ('AI / Ollama', 'selected model'), ('Chat files', 'local JSON')]
    for x, (name, sub) in zip(centers, labels):
        s.box(x-104, 86, 208, name, sub, small=True)
        s.path(f'M{x} 172 V810', arrow=False, dashed=True)
    steps = [
        (0, 1, 230, 'Question + slide + image', False),
        (1, 2, 308, 'Deck + notes context', False),
        (2, 3, 386, 'Prime / resume', False),
        (3, 2, 464, 'Text + tool events', True),
        (2, 1, 542, 'Normalised events', True),
        (1, 0, 620, 'Stream answer (SSE)', True),
        (1, 4, 718, 'Save messages with slide references', False),
    ]
    for a, b, y, label, dashed in steps:
        s.path(f'M{centers[a]} {y} H{centers[b]}', dashed=dashed)
        s.text((centers[a]+centers[b])/2, y-14, label, 19, anchor='middle')
    s.text(40, 858, 'Cloud models receive relevant study context. Ollama inference stays on the Mac.', 20, color='muted')
    s.save('tutor-sequence', theme)


def lecture(theme):
    s = SVG(1280, 920, 'From a lecture to revision', 'A local recording or an imported transcript feeds numbered transcript sentences. The AI selects slide notes and line references; the app rebuilds quotes from source text. Saved notes feed the tutor and flashcards; FSRS schedules review.', theme)
    s.text(40, 43, 'Lectures / capture to revision', 24, 500)
    # A three-column flow with one direction per row.
    s.path('M384 138 H448')
    s.path('M792 138 H856')
    s.path('M212 222 V198 H1028 V180')
    s.text(620, 220, 'transcript import skips ASR', 17, color='muted', anchor='middle', mono=True)
    s.path('M1028 180 V370')
    s.path('M856 412 H792')
    s.path('M448 412 H384')
    s.path('M212 454 V510 H620 V566')
    s.path('M212 510 V566')
    s.path('M792 608 H856')
    s.path('M620 650 V726')
    s.path('M1028 726 V690 H690 V650')
    s.box(40, 96, 344, 'Record on your Mac', 'audio chunks + slide events')
    s.box(448, 96, 344, 'Transcribe locally', 'ffmpeg → Parakeet MLX')
    s.box(856, 96, 344, 'Numbered transcript', 'sentences + timestamps')
    s.box(40, 222, 344, 'Or import captions', 'timed captions / plain text', h=70, small=True)
    s.box(856, 370, 344, 'Generate lecture notes', 'summary + slide line ranges', solid=True)
    s.box(448, 370, 344, 'Rebuild source quotes', 'read original transcript lines')
    s.box(40, 370, 344, 'Save notes', 'local files + Markdown')
    s.box(40, 566, 344, 'Tutor context', 'explanations beside slides', small=True)
    s.box(448, 566, 344, 'Generate flashcards', 'slides + notes + questions')
    s.box(856, 566, 344, 'FSRS-5', 'schedule the next review', small=True)
    s.box(448, 726, 344, 'Export cards', 'Markdown / Anki text', small=True)
    s.box(856, 726, 344, 'Tutor questions', 'topics that needed help', small=True)
    s.text(40, 886, 'Quotes link back to transcript evidence; ASR and generated notes can still make mistakes.', 19, color='muted')
    s.save('lecture-pipeline', theme)


if __name__ == '__main__':
    for theme in THEMES:
        hero(theme)
        architecture(theme)
        sequence(theme)
        lecture(theme)
    social()
    print('Rendered 9 SVGs in docs/media')
