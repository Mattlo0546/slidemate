import { chromium } from 'playwright';
import fs from 'fs';
const logo = fs.readFileSync(new URL('../../server/static/logo.svg', import.meta.url), 'utf8');
const shot = 'data:image/png;base64,' + fs.readFileSync('shot.png').toString('base64');
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });
await p.setContent(`<style>*{margin:0}body{width:1280px;height:640px;overflow:hidden;font-family:-apple-system,'SF Pro Display',system-ui;color:#fff;
background:radial-gradient(700px 500px at 10% 0%, #3a2f8f 0, transparent 60%),radial-gradient(800px 600px at 100% 100%, #1f4aa8 0, transparent 60%),#0b0b12;position:relative}
.t{position:absolute;left:64px;top:0;bottom:0;width:470px;display:flex;flex-direction:column;justify-content:center}
.logo{width:72px;height:72px;border-radius:18px;overflow:hidden;box-shadow:0 0 0 1px rgba(255,255,255,.12);margin-bottom:26px}.logo svg{width:100%;height:100%}
h1{font-size:64px;letter-spacing:-.035em}p{font-size:27px;line-height:1.35;color:#c9c9d6;margin-top:16px;letter-spacing:-.01em}
.g{background:linear-gradient(90deg,#9fb0ff,#c79bff);-webkit-background-clip:text;color:transparent;font-weight:600}
.k{margin-top:28px;font-size:17px;color:#9a9ab0}
img{position:absolute;left:580px;top:70px;width:820px;border-radius:12px;box-shadow:0 0 0 1px rgba(255,255,255,.12),0 30px 80px rgba(0,0,0,.6)}</style>
<div class="t"><div class="logo">${logo}</div><h1>SlideMate</h1><p>Study lecture slides with an AI tutor that has read <span class="g">the whole deck</span>.</p><div class="k">macOS · Claude or ChatGPT · open source</div></div><img src="${shot}">`);
await p.screenshot({ path: '../media/social-preview.png' });
await b.close();
