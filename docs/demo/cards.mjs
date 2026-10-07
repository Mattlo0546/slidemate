import { chromium } from 'playwright';
import fs from 'fs';
const logo = fs.readFileSync(new URL('../../server/static/logo.svg', import.meta.url), 'utf8');
const bg = `radial-gradient(900px 700px at 12% 8%, #3a2f8f 0, transparent 60%),radial-gradient(1000px 800px at 95% 100%, #1f4aa8 0, transparent 60%),radial-gradient(700px 500px at 80% 0%, #6a2f8f55 0, transparent 70%),#0b0b12`;
const card = (inner) => `<style>*{margin:0}body{width:1920px;height:1200px;background:${bg};display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:-apple-system,'SF Pro Display',system-ui;color:#fff;text-align:center}
.logo{width:120px;height:120px;border-radius:28px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.12);margin-bottom:40px}.logo svg{width:100%;height:100%}
h1{font-size:96px;font-weight:700;letter-spacing:-.035em}h2{font-size:42px;font-weight:500;color:#c9c9d6;margin-top:22px;letter-spacing:-.01em;line-height:1.3}
.g{background:linear-gradient(90deg,#9fb0ff,#c79bff);-webkit-background-clip:text;color:transparent}
.pills{display:flex;gap:16px;margin-top:56px}.pills span{font-size:26px;padding:14px 26px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);color:#e6e6f0}
.url{margin-top:52px;font:500 34px ui-monospace,'SF Mono',monospace;color:#b9c3ff}</style>${inner}`;
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1920, height: 1200 } });
await p.setContent(card(`<div class="logo">${logo}</div><h1>SlideMate</h1><h2>Study your lecture slides with an AI tutor<br>that has read <span class="g">the whole deck</span>.</h2>`));
await p.screenshot({ path: 'card-title.png' });
await p.setContent(card(`<div class="logo">${logo}</div><h1>Free &amp; open source</h1><h2>Runs on your Mac. Uses the Claude or ChatGPT<br>subscription you already have. No API keys.</h2><div class="pills"><span>Whole-deck tutor</span><span>Send to iPad</span><span>Lecture notes</span></div><div class="url">github.com/Mattlo0546/slidemate</div>`));
await p.screenshot({ path: 'card-end.png' });
await b.close();
