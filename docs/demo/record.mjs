// Records SlideMate demo scenes as high-res frame sequences (CDP screencast), with a fake cursor, captions and
// small presentation animations injected on top of the real app.  Usage: node record.mjs <scene...>
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = 'http://127.0.0.1:8769/';
const UNI = path.resolve('Uni');
const DECK = `${UNI}/Machine Learning/Week 03/Week 3 - Gradient Descent.pdf`;
const OUT = path.resolve('frames');
const W = 1440, H = 900;

const overlay = () => {
  const css = `
  #__cur{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);filter:drop-shadow(0 2px 4px rgba(0,0,0,.45))}
  .__ripple{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2.5px solid rgba(124,140,255,.95);background:rgba(124,140,255,.18);pointer-events:none;z-index:2147483646;animation:__rip .5s ease-out forwards}
  @keyframes __rip{from{transform:scale(.3);opacity:1}to{transform:scale(1.5);opacity:0}}
  #__cap{position:fixed;left:50%;bottom:28px;transform:translate(-50%,16px);opacity:0;z-index:2147483645;pointer-events:none;
    font:600 17px/1 -apple-system,'SF Pro Text',system-ui,sans-serif;color:#fff;letter-spacing:-.01em;padding:13px 20px 13px 16px;border-radius:999px;
    background:rgba(22,22,28,.78);backdrop-filter:blur(14px) saturate(1.4);-webkit-backdrop-filter:blur(14px) saturate(1.4);
    border:1px solid rgba(255,255,255,.14);box-shadow:0 10px 40px rgba(0,0,0,.35);transition:opacity .35s ease, transform .35s cubic-bezier(.2,.8,.2,1);display:flex;gap:10px;align-items:center;white-space:nowrap}
  #__cap.on{opacity:1;transform:translate(-50%,0)}
  #__cap .k{font:600 13px/1 ui-monospace,'SF Mono',monospace;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.18);padding:5px 7px;border-radius:6px}
  #__cap .dot{width:9px;height:9px;border-radius:50%;background:linear-gradient(135deg,#7c8cff,#b47cff);box-shadow:0 0 12px #8f7cff}
  #__ipad{position:fixed;right:40px;bottom:96px;width:440px;height:316px;border-radius:26px;background:#0d0d10;padding:12px;z-index:2147483640;pointer-events:none;
    box-shadow:0 0 0 1.5px #3a3a42,0 30px 80px rgba(0,0,0,.6);transform:translateX(620px) rotate(4deg);transition:transform .7s cubic-bezier(.2,.9,.25,1.05)}
  #__ipad.on{transform:translateX(0) rotate(0)}
  #__ipad .scr{width:100%;height:100%;border-radius:15px;background:linear-gradient(160deg,#fbfbfd,#ececf2);overflow:hidden;position:relative;display:flex;align-items:center;justify-content:center;padding-top:30px}
  #__ipad img{max-width:80%;max-height:76%;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.18);transform:scale(.6);opacity:0;transition:all .5s .45s cubic-bezier(.2,.9,.25,1.1)}
  #__ipad.on img{transform:scale(1);opacity:1}
  #__ipad .ban{position:absolute;top:8px;left:50%;transform:translate(-50%,-50px);background:rgba(255,255,255,.92);backdrop-filter:blur(10px);border-radius:12px;padding:7px 12px;
    font:600 11.5px -apple-system,system-ui;color:#111;box-shadow:0 4px 16px rgba(0,0,0,.15);white-space:nowrap;transition:transform .45s .25s cubic-bezier(.2,.9,.25,1.1);display:flex;gap:6px;align-items:center}
  #__ipad.on .ban{transform:translate(-50%,0)}
  `;
  const install = () => {
    if (document.getElementById('__cur')) return;
    const st = document.createElement('style'); st.textContent = css; document.head.append(st);
    const c = document.createElement('div'); c.id = '__cur';
    c.innerHTML = '<svg viewBox="0 0 26 26" width="26" height="26"><path d="M5 2.5 L5 20.5 L9.6 16.3 L12.6 23.2 L15.6 21.9 L12.7 15.1 L19 15.1 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.body.append(c);
    const cap = document.createElement('div'); cap.id = '__cap'; document.body.append(cap);
    const ip = document.createElement('div'); ip.id = '__ipad';
    ip.innerHTML = '<div class="scr"><div class="ban"><span style="font-size:13px">◉</span> AirDrop · SlideMate</div><img></div>';
    document.body.append(ip);
  };
  window.__demo = {
    x: -100, y: -100,
    move(x, y, ms) {
      install();
      const c = document.getElementById('__cur');
      const a = c.animate([{ transform: `translate(${this.x}px,${this.y}px)` }, { transform: `translate(${x}px,${y}px)` }],
        { duration: ms, easing: 'cubic-bezier(.45,.05,.25,1)', fill: 'forwards' });
      this.x = x; this.y = y;
      return a.finished.then(() => {});
    },
    ripple() { const r = document.createElement('div'); r.className = '__ripple'; r.style.left = this.x + 4 + 'px'; r.style.top = this.y + 3 + 'px'; document.body.append(r); setTimeout(() => r.remove(), 600); },
    caption(html) { install(); const c = document.getElementById('__cap'); if (!html) { c.classList.remove('on'); return; } c.innerHTML = '<span class="dot"></span><span>' + html + '</span>'; const v = document.querySelector('#viewerWrap')?.getBoundingClientRect(); if (v && v.width) c.style.left = (v.left + v.width / 2) + 'px'; c.classList.add('on'); },
    ipad(src) { install(); const ip = document.getElementById('__ipad'); ip.querySelector('img').src = src; ip.classList.add('on'); },
    ipadOff() { document.getElementById('__ipad')?.classList.remove('on'); },
    install,
  };
  document.addEventListener('DOMContentLoaded', install);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: 'dark' });
await ctx.addInitScript(overlay);
const page = await ctx.newPage();
const sleep = (ms) => page.waitForTimeout(ms);

// Send to iPad: show the real snip arriving on a mock iPad instead of opening a real AirDrop panel.
await page.route('**/api/send', async (route) => {
  const body = route.request().postDataJSON();
  await new Promise((r) => setTimeout(r, 650));
  await route.fulfill({ json: { airdrop: { state: 'clicked', device: 'iPad' }, clipboard: true } });
  setTimeout(() => page.evaluate((img) => window.__demo.ipad(img), body.image).catch(() => {}), 350);
});

// ---------- frame capture ----------
const cdp = await ctx.newCDPSession(page);
let frames = null, marks = null, dir = null;
cdp.on('Page.screencastFrame', async (f) => {
  if (frames) {
    const file = path.join(dir, String(frames.length).padStart(5, '0') + '.jpg');
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ file, t: f.metadata.timestamp });
  }
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
async function start(name) {
  dir = path.join(OUT, name); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  frames = []; marks = [{ t: Date.now() / 1000, speed: 1 }];
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: W * 2, maxHeight: H * 2, everyNthFrame: 1 });
  await page.evaluate(() => { document.body.style.transform = 'translateZ(0)'; requestAnimationFrame(() => (document.body.style.transform = '')); });
}
const speed = (s) => marks.push({ t: Date.now() / 1000, speed: s });
async function stop() {
  await sleep(300);
  await cdp.send('Page.stopScreencast');
  fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify({ frames, marks, end: Date.now() / 1000 }));
  console.log('✓', dir, frames.length, 'frames');
  frames = null;
}

// ---------- cursor helpers ----------
let cx = W / 2, cy = H / 2;
async function moveTo(x, y, ms = 650) {
  const steps = Math.max(8, Math.round(ms / 16));
  await Promise.all([page.evaluate(([x, y, ms]) => window.__demo.move(x, y, ms), [x, y, ms]), page.mouse.move(x, y, { steps })]);
  cx = x; cy = y;
}
async function box(sel) { const b = await page.locator(sel).first().boundingBox(); if (!b) throw new Error('no ' + sel); return b; }
async function moveToSel(sel, ms, fx = 0.5, fy = 0.5) { const b = await box(sel); await moveTo(b.x + b.width * fx, b.y + b.height * fy, ms); }
async function click(button = 'left') { await page.evaluate(() => window.__demo.ripple()); await page.mouse.down({ button }); await sleep(60); await page.mouse.up({ button }); }
const caption = (h) => page.evaluate((h) => window.__demo.caption(h), h);
async function waitAnswer() {
  await page.waitForSelector('#askForm .send.stop', { timeout: 30000 });
  await page.waitForSelector('#askForm .send:not(.stop)', { timeout: 240000 });
}
async function openDeck(n = 1, theme) {
  await page.goto(BASE + '?file=' + encodeURIComponent(DECK) + '&page=' + n);
  await page.waitForSelector('.page canvas');
  await page.evaluate(() => window.__demo.install());
  await sleep(1200);
  await page.evaluate(([x, y]) => window.__demo.move(x, y, 1), [cx, cy]);
}
async function chatTab() { const t = page.locator('#panelTabs button', { hasText: 'Chat' }); if (await t.count()) await t.first().click(); }

// ---------- scenes ----------
const scenes = {
  // Right-click → Explain; answer streams in with slide links; hover a link to preview, click to jump.
  async explain() {
    await openDeck(5);
    await chatTab();
    await page.locator('#subBar button:has-text("All slides")').click();
    await page.evaluate(() => window.__demo.move(900, 640, 1));
    cx = 900; cy = 640;
    await start('explain');
    await sleep(500);
    await caption('Right-click any slide → <b>Explain this slide</b>');
    const p = await box('.page.current');
    await moveTo(p.x + p.width * 0.42, p.y + p.height * 0.45, 900);
    await sleep(250);
    await click('right');
    await sleep(500);
    await moveToSel('#ctxMenu [data-act="explain"]', 450);
    await sleep(200);
    await click();
    await caption('The tutor has read the <b>whole deck</b> and your <b>lecture notes</b>');
    await page.waitForSelector('#askForm .send.stop', { timeout: 30000 });
    await moveTo(1000, 560, 900);
    // "Reading the deck / thinking" gets sped up in the edit; streaming plays at real speed.
    speed(3);
    await page.waitForFunction(() => (document.querySelector('#messages .msg.bot:last-child')?.innerText || '').length > 40, null, { timeout: 120000 });
    speed(1.6);
    await page.waitForSelector('#askForm .send:not(.stop)', { timeout: 240000 });
    speed(1);
    await sleep(600);
    // hover a slide link
    const ref = page.locator('#messages .msg.bot:last-child .slide-ref:not([data-slide="5"])').first();
    if (await ref.count()) {
      await ref.scrollIntoViewIfNeeded();
      await sleep(400);
      await caption('Slide references are links: <b>hover to preview</b>, click to jump');
      const b = await ref.boundingBox();
      await moveTo(b.x + b.width / 2, b.y + b.height / 2, 800);
      await sleep(1800);
      await click();
      await sleep(1600);
    }
    await caption('');
    await sleep(500);
    await stop();
  },

  // Snip an area → Send to iPad.
  async snip() {
    await openDeck(5);
    await chatTab();
    await page.evaluate(() => window.__demo.move(700, 60, 1)); cx = 700; cy = 60;
    await start('snip');
    await sleep(400);
    await caption('Snip any part of a slide → <b>Send to iPad</b> <span class="k">X</span>');
    await moveToSel('#btnSnip', 700);
    await sleep(200);
    await click();
    await sleep(400);
    const p = await box('.page.current');
    const x0 = p.x + p.width * 0.555, y0 = p.y + p.height * 0.22, x1 = p.x + p.width * 0.93, y1 = p.y + p.height * 0.72;
    await moveTo(x0, y0, 700);
    await page.mouse.down();
    await page.evaluate(() => window.__demo.ripple());
    const steps = 28;
    for (let i = 1; i <= steps; i++) {
      const e = 1 - Math.pow(1 - i / steps, 3);
      const x = x0 + (x1 - x0) * e, y = y0 + (y1 - y0) * e;
      await page.evaluate(([x, y]) => window.__demo.move(x, y, 16), [x, y]);
      await page.mouse.move(x, y);
      await sleep(16);
    }
    cx = x1; cy = y1;
    await page.mouse.up();
    await sleep(450);
    await moveToSel('#snipMenu [data-snip="send"]', 500);
    await sleep(200);
    await click();
    await caption('AirDrops straight to your iPad, and copies it to your clipboard');
    await sleep(3600);
    await caption('');
    await page.evaluate(() => window.__demo.ipadOff());
    await sleep(800);
    await stop();
  },

  // Lecture notes: summary + per-slide notes with the lecturer's exact words.
  async notes() {
    await openDeck(3);
    await chatTab();
    await page.evaluate(() => window.__demo.move(640, 400, 1)); cx = 640; cy = 400;
    await start('notes');
    await sleep(400);
    await caption('Hit <b>Record</b> in class → on-device transcription');
    await moveToSel('#btnRec', 800);
    await sleep(1300);
    await caption('…and you get <b>notes for every slide</b>, with the lecturer’s exact words');
    await moveToSel('#panelTabs button:has-text("Lecture notes")', 800);
    await sleep(150);
    await click();
    await sleep(1600);
    // walk through a few slides; the notes follow along
    for (const n of [4, 5]) {
      await moveToSel('#btnNext', 600);
      await sleep(150);
      await click();
      await sleep(1700);
    }
    await caption('Plus a <b>summary</b>: key ideas, to-dos, deadlines, exam tips');
    await moveToSel('#subBar button:has-text("Summary")', 700);
    await sleep(150);
    await click();
    await sleep(900);
    await moveTo(1050, 500, 600);
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 110); await sleep(130); }
    await sleep(1300);
    await caption('');
    await sleep(400);
    await stop();
  },

  // Pinch to zoom + ⌘F search inside the slides.
  async zoom() {
    await openDeck(6);
    await chatTab();
    await page.evaluate(() => window.__demo.move(640, 700, 1)); cx = 640; cy = 700;
    await start('zoom');
    await sleep(400);
    await caption('Pinch to zoom, right where you point');
    const p = await box('.page.current');
    const tx = p.x + p.width * 0.3, ty = p.y + p.height * 0.55;
    await moveTo(tx, ty, 800);
    await sleep(300);
    for (let i = 0; i < 13; i++) { await page.evaluate(([x, y]) => document.querySelector('#viewer').dispatchEvent(new WheelEvent('wheel', { deltaY: -9, ctrlKey: true, clientX: x, clientY: y, bubbles: true, cancelable: true })), [tx, ty]); await sleep(40); }
    await sleep(1800);
    for (let i = 0; i < 13; i++) { await page.evaluate(([x, y]) => document.querySelector('#viewer').dispatchEvent(new WheelEvent('wheel', { deltaY: 9, ctrlKey: true, clientX: x, clientY: y, bubbles: true, cancelable: true })), [tx, ty]); await sleep(22); }
    await sleep(700);
    await page.click('#btnFit');
    await sleep(600);
    await caption('<span class="k">⌘F</span> searches every slide in the deck');
    await page.keyboard.press('Meta+f');
    await sleep(400);
    await page.keyboard.type('learning rate', { delay: 70 });
    await sleep(900);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Enter'); await sleep(900); }
    await caption('');
    await sleep(500);
    await stop();
  },

  // Library: courses → Lectures / Labs / Readings → weeks, sorted automatically.
  async library() {
    await page.goto(BASE);
    await page.waitForSelector('#libList');
    await page.evaluate(() => window.__demo.install());
    await sleep(800);
    await page.evaluate(() => window.__demo.move(640, 420, 1)); cx = 640; cy = 420;
    await start('library');
    await sleep(400);
    await caption('Point it at your course folders. It sorts everything <b>by course, type and week</b>');
    // collapse and re-open a course
    await moveToSel('#libList :text("Philosophy of AI")', 900);
    await sleep(150); await click(); await sleep(700);
    await moveToSel('#libList :text("Robotics")', 500);
    await sleep(150); await click(); await sleep(900);
    await moveToSel('#libList :text("Philosophy of AI")', 500);
    await sleep(150); await click(); await sleep(800);
    await moveToSel('#libList :text("Robotics")', 500);
    await sleep(150); await click(); await sleep(700);
    await moveToSel('#libList :text("Gradient Descent")', 800);
    await sleep(200); await click();
    await page.waitForSelector('.page canvas');
    await sleep(1600);
    await caption('');
    await sleep(400);
    await stop();
  },
};

for (const name of process.argv.slice(2)) await scenes[name]();
await browser.close();
