// Generates original demo lecture decks (PDF) for the SlideMate demo library.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const KATEX = new URL('../../server/static/vendor/katex', import.meta.url).pathname;
const OUT = process.argv[2];

const curve = (steps) => {
  // loss curve y = (x-0.62)^2 with gradient-descent steps
  const X = (x) => 60 + x * 520, Y = (y) => 330 - y * 700;
  let d = '';
  for (let i = 0; i <= 100; i++) { const x = i / 100, y = (x - 0.62) ** 2; d += (i ? 'L' : 'M') + X(x).toFixed(1) + ' ' + Y(y).toFixed(1); }
  let pts = [], x = 0.05;
  for (let i = 0; i < steps; i++) { pts.push(x); x = x - 0.16 * 2 * (x - 0.62); }
  const dots = pts.map((x, i) => `<circle cx="${X(x)}" cy="${Y((x - 0.62) ** 2)}" r="9" fill="#ff6b4a" opacity="${0.35 + 0.65 * (i + 1) / pts.length}"/>`).join('');
  const arrows = pts.slice(1).map((x, i) => { const a = pts[i]; return `<path d="M${X(a)} ${Y((a - 0.62) ** 2)} Q ${(X(a) + X(x)) / 2} ${Math.min(Y((a - 0.62) ** 2), Y((x - 0.62) ** 2)) - 30} ${X(x)} ${Y((x - 0.62) ** 2)}" stroke="#ff6b4a" stroke-width="2.5" fill="none" stroke-dasharray="6 5"/>`; }).join('');
  return `<svg viewBox="0 0 640 360" width="560"><line x1="60" y1="330" x2="600" y2="330" stroke="#c9ccd6" stroke-width="2"/><line x1="60" y1="20" x2="60" y2="330" stroke="#c9ccd6" stroke-width="2"/><path d="${d}" stroke="#3b5bdb" stroke-width="4" fill="none"/>${arrows}${dots}<text x="590" y="352" font-size="18" fill="#7a7f8f">w</text><text x="20" y="30" font-size="18" fill="#7a7f8f">L(w)</text></svg>`;
};

const decks = {
  'Machine Learning/Week 03/Week 3 - Gradient Descent.pdf': { course: 'COMS 2400 · Machine Learning', week: 'Week 3', slides: [
    { kind: 'title', title: 'Gradient Descent', sub: 'How models actually learn' },
    { title: 'Where we are', bullets: ['Week 1: what it means to “learn” from data', 'Week 2: linear regression and the squared-error loss', 'Today: finding the best parameters <b>without</b> a closed-form answer', 'Next week: backpropagation (gradient descent for deep networks)'] },
    { title: 'The loss landscape', bullets: ['A loss function scores how wrong the model is: $L(w)$', 'Training = finding the $w$ with the smallest loss', 'For one parameter, picture a valley: we want the bottom'], fig: curve(0) },
    { title: 'Follow the slope downhill', bullets: ['The gradient $\\nabla L(w)$ points <b>uphill</b>', 'So step the other way:', '$$w \\leftarrow w - \\eta\\,\\nabla L(w)$$', '$\\eta$ is the <b>learning rate</b> (step size)'] },
    { title: 'Gradient descent, step by step', bullets: ['Start anywhere', 'Compute the gradient at the current point', 'Take a small step against it', 'Repeat until the steps get tiny'], fig: curve(9) },
    { title: 'Example: fitting a line', bullets: ['Model: $\\hat y = w x$', 'Loss: $L(w) = \\sum_i (w x_i - y_i)^2$', 'Gradient: $\\nabla L = 2\\sum_i (w x_i - y_i)\\,x_i$', 'Update: $w \\leftarrow w - 2\\eta \\sum_i (w x_i - y_i)\\,x_i$'] },
    { title: 'Choosing the learning rate', bullets: ['Too small: painfully slow progress', 'Too large: overshoot, bounce, even diverge', 'For the line fit it converges when $0 < \\eta < \\dfrac{1}{\\sum_i x_i^2}$', 'In practice: try a few values, watch the loss curve'] },
    { title: 'Batch vs. stochastic', bullets: ['<b>Batch GD</b>: gradient over the whole dataset (exact, slow)', '<b>Stochastic GD</b>: one example at a time (noisy, fast)', '<b>Mini-batch</b>: a few dozen at a time (the default today)', 'Noise can even help escape shallow local minima'] },
    { title: 'Local minima & saddle points', bullets: ['Non-convex losses have many valleys', 'GD finds <i>a</i> minimum, not necessarily <i>the</i> minimum', 'In high dimensions, saddle points are the bigger problem', 'Momentum and Adam help push through flat regions'] },
    { title: 'Momentum', bullets: ['Keep a running “velocity” of past gradients:', '$$v \\leftarrow \\beta v + \\nabla L(w), \\quad w \\leftarrow w - \\eta v$$', 'Smooths out zig-zags in narrow valleys', 'Typical $\\beta = 0.9$'] },
    { title: 'Summary', bullets: ['Gradient descent: repeatedly step against the gradient', 'The learning rate makes or breaks training', 'Mini-batches + momentum = how real models are trained', '<b>Exam tip:</b> be able to derive the update for a simple loss'] },
    { kind: 'title', title: 'Questions?', sub: 'Problem sheet 3 is due Friday' },
  ] },
  'Machine Learning/Week 02/Week 2 - Linear Regression.pdf': { course: 'COMS 2400 · Machine Learning', week: 'Week 2', slides: [
    { kind: 'title', title: 'Linear Regression', sub: 'Our first model' },
    { title: 'The model', bullets: ['Predict $\\hat y = w x + b$', 'Choose $w, b$ to fit the data', 'Squared error: $L = \\sum_i (\\hat y_i - y_i)^2$'] },
    { title: 'Closed-form solution', bullets: ['Set the derivative to zero', '$w^* = \\dfrac{\\langle x, y\\rangle}{\\langle x, x\\rangle}$ (no intercept)', 'Works here, but not for most models'] },
  ] },
  'Machine Learning/Week 01/Week 1 - What is Learning.pdf': { course: 'COMS 2400 · Machine Learning', week: 'Week 1', slides: [
    { kind: 'title', title: 'What is Learning?', sub: 'Course introduction' },
    { title: 'Learning from data', bullets: ['Programs that improve with experience', 'Supervised, unsupervised, reinforcement', 'Generalisation is the whole game'] },
  ] },
  'Machine Learning/Labs/Lab 2 - Fitting a Line in NumPy.pdf': { course: 'COMS 2400 · Machine Learning', week: 'Lab 2', slides: [
    { kind: 'title', title: 'Lab 2: Fitting a Line', sub: 'NumPy warm-up' },
    { title: 'Tasks', bullets: ['Load the dataset', 'Implement the squared-error loss', 'Implement one gradient step', 'Plot the loss over 100 steps'] },
  ] },
  'Robotics/Week 02/Week 2 - Sensors and Actuators.pdf': { course: 'ENGR 2100 · Intro to Robotics', week: 'Week 2', slides: [
    { kind: 'title', title: 'Sensors & Actuators', sub: 'How robots feel and move' },
    { title: 'Sensors', bullets: ['Encoders, IMUs, lidar, cameras', 'Every sensor is noisy', 'Fusion beats any single sensor'] },
  ] },
  'Robotics/Week 01/Week 1 - What is a Robot.pdf': { course: 'ENGR 2100 · Intro to Robotics', week: 'Week 1', slides: [
    { kind: 'title', title: 'What is a Robot?', sub: 'Sense · Think · Act' },
  ] },
  'Philosophy of AI/Week 02/Week 2 - Can Machines Think.pdf': { course: 'PHIL 2069 · Philosophy of AI', week: 'Week 2', slides: [
    { kind: 'title', title: 'Can Machines Think?', sub: 'Turing, 1950' },
    { title: 'The imitation game', bullets: ['Replace “can machines think?” with a test', 'Objections and Turing’s replies', 'Is behaviour enough?'] },
  ] },
  'Philosophy of AI/Readings/Searle - Minds, Brains and Programs (notes).pdf': { course: 'PHIL 2069 · Philosophy of AI', week: 'Reading', slides: [
    { kind: 'title', title: 'The Chinese Room', sub: 'Reading notes' },
  ] },
};

const css = `
@page { size: 1280px 720px; margin: 0 }
* { box-sizing: border-box; margin: 0 }
body { font-family: -apple-system, 'SF Pro Display', 'Helvetica Neue', sans-serif; color: #1d2130; }
.s { width: 1280px; height: 720px; position: relative; overflow: hidden; page-break-after: always; background: #fff; padding: 64px 80px; }
.s .top { position: absolute; left: 80px; right: 80px; top: 40px; display: flex; justify-content: space-between; font-size: 17px; color: #8a90a2; letter-spacing: .02em; }
.s h1 { font-size: 50px; font-weight: 700; letter-spacing: -.02em; margin-top: 46px; }
.s .bar { width: 64px; height: 6px; border-radius: 3px; background: linear-gradient(90deg, #3b5bdb, #7c5cff); margin: 22px 0 30px; }
.s ul { list-style: none; padding: 0; font-size: 29px; line-height: 1.5; }
.s li { padding-left: 34px; position: relative; margin-bottom: 10px; }
.s li::before { content: ''; position: absolute; left: 4px; top: 18px; width: 11px; height: 11px; border-radius: 50%; background: #3b5bdb; opacity: .8; }
.s li.math::before { display: none }
.s .row { display: flex; gap: 40px; align-items: center; }
.s .row ul { flex: 1 }
.s .num { position: absolute; right: 80px; bottom: 34px; font-size: 16px; color: #a3a8b8; }
.t { background: radial-gradient(1200px 600px at 85% 110%, #ece8ff 0, transparent 60%), radial-gradient(900px 500px at -10% -20%, #e3ebff 0, transparent 55%), #fbfbfe; display: flex; flex-direction: column; justify-content: center; }
.t h1 { font-size: 92px; margin: 0; letter-spacing: -.035em; background: linear-gradient(90deg, #1d2130, #3b5bdb 70%, #7c5cff); -webkit-background-clip: text; color: transparent; }
.t .sub { font-size: 34px; color: #5b6175; margin-top: 18px; }
.t .meta { position: absolute; left: 80px; bottom: 56px; font-size: 20px; color: #8a90a2; }
`;

function slideHTML(d, s, i, n) {
  const top = `<div class="top"><span>${d.course}</span><span>${d.week}</span></div>`;
  if (s.kind === 'title') return `<section class="s t">${top}<h1>${s.title}</h1><div class="sub">${s.sub}</div><div class="meta">Demo lecture · made for SlideMate</div></section>`;
  const lis = s.bullets.map((b) => `<li class="${b.startsWith('$$') ? 'math' : ''}">${b}</li>`).join('');
  const body = s.fig ? `<div class="row"><ul>${lis}</ul>${s.fig}</div>` : `<ul>${lis}</ul>`;
  return `<section class="s">${top}<h1>${s.title}</h1><div class="bar"></div>${body}<div class="num">${i + 1} / ${n}</div></section>`;
}

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [rel, d] of Object.entries(decks)) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="file://${KATEX}/katex.min.css"><style>${css}</style>
<script src="file://${KATEX}/katex.min.js"></script></head><body>
${d.slides.map((s, i) => slideHTML(d, s, i, d.slides.length)).join('\n')}
<script src="file://${KATEX}/auto-render.min.js"></script><script>renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}]});</script></body></html>`;
  const tmp = path.join(OUT, '_tmp.html');
  fs.writeFileSync(tmp, html);
  await page.goto('file://' + tmp);
  await page.waitForTimeout(300);
  const out = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.pdf({ path: out, width: '1280px', height: '720px', printBackground: true });
  console.log('✓', rel);
}
fs.unlinkSync(path.join(OUT, '_tmp.html'));
await browser.close();
