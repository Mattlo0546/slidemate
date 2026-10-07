// Renders the "stage" PNGs the demo videos are composited onto: gradient backdrop + macOS window chrome, and a mask.
import { chromium } from 'playwright';
const OW = 1920, OH = 1200, CW = 1600, CH = 1000, TB = 40, X = (OW - CW) / 2, Y = (OH - CH - TB) / 2, R = 14;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: OW, height: OH } });
await page.setContent(`<style>
*{margin:0}body{width:${OW}px;height:${OH}px;overflow:hidden;
background:radial-gradient(900px 700px at 12% 8%, #3a2f8f 0, transparent 60%),radial-gradient(1000px 800px at 95% 100%, #1f4aa8 0, transparent 60%),radial-gradient(700px 500px at 80% 0%, #6a2f8f55 0, transparent 70%),#0b0b12}
.grain{position:absolute;inset:0;opacity:.06;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E")}
.win{position:absolute;left:${X}px;top:${Y}px;width:${CW}px;height:${CH + TB}px;border-radius:${R}px;background:#1b1b1f;
box-shadow:0 0 0 1px rgba(255,255,255,.10),0 40px 120px rgba(0,0,0,.65),0 12px 40px rgba(0,0,0,.4)}
.tb{height:${TB}px;display:flex;align-items:center;padding-left:16px;gap:8px;border-bottom:1px solid rgba(255,255,255,.06)}
.tb i{width:12px;height:12px;border-radius:50%;display:block}
.tb b{position:absolute;left:0;right:0;text-align:center;font:600 13px -apple-system,system-ui;color:#b9b9c2;top:12px}
</style><div class="grain"></div><div class="win"><div class="tb"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><b>SlideMate</b></div></div>`);
await page.screenshot({ path: 'stage-bg.png' });
await page.setViewportSize({ width: CW, height: CH });
await page.setContent(`<style>*{margin:0}body{background:#000;width:${CW}px;height:${CH}px}div{width:100%;height:100%;background:#fff;border-radius:0 0 ${R}px ${R}px}</style><div></div>`);
await page.screenshot({ path: 'stage-mask.png' });
await browser.close();
console.log(JSON.stringify({ OW, OH, CW, CH, X, Y: Y + TB }));
