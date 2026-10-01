import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';

const $ = (s) => document.querySelector(s);
const H = { 'X-SlideMate': '1' };
const api = (path, opts = {}) => fetch(path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) }).then((r) => r.json());
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (id, cls = '') => `<svg class="${cls}"><use href="#i-${id}"/></svg>`;

const state = {
  pdf: null, path: null, name: '', pages: [], current: 1, scale: null, fit: true,
  chats: {},   // path -> [{role, text, slide, ts, snip, image}]
  busy: false,
  chatMode: store.get('chatMode', 'slide'),
};

function toast(msg, err = false, ms = 3500) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

// =====================================================================================
// Library
// =====================================================================================
let lib = { items: [], categories: [], sync: {}, inbox: 0, classifying: false, paths: {} };
const collapsed = new Set(store.get('collapsed', []));
const hiddenCourses = new Set(store.get('hiddenCourses', []));
$('#libSort').value = store.get('libSort', 'week');
// "New" = arrived after SlideMate was first set up and not opened yet.
const newBaseline = store.get('newBaseline', null) ?? (store.set('newBaseline', Date.now() / 1000), Date.now() / 1000);
const opened = new Set(store.get('opened', []));
const isNew = (i) => i.mtime > newBaseline && !opened.has(i.path);

function shortCourse(name) {
  return name.replace(/Artificial Intelligence/g, 'AI').replace(/^Introduction to /, 'Intro to ').replace(/^Methods of /, 'Methods of ');
}

async function loadLibrary() {
  try { lib = await (await api('/api/library')).json(); } catch { return; }
  renderLibrary();
  schedulePoll();
}
let pollT;
function schedulePoll() {
  clearTimeout(pollT);
  const busy = lib.classifying || lib.sync?.running;
  pollT = setTimeout(loadLibrary, busy ? 2000 : 60000);
}

function renderChipsAndStatus(courses) {
  const chips = $('#courseChips');
  chips.innerHTML = '';
  const all = document.createElement('button');
  all.textContent = 'All';
  all.className = hiddenCourses.size ? '' : 'on';
  all.onclick = () => { hiddenCourses.clear(); saveHidden(); };
  chips.append(all);
  for (const c of courses) {
    const b = document.createElement('button');
    b.textContent = c === 'Unsorted' ? 'Unsorted' : shortCourse(c.replace(/^[A-Z]{2,6}\s?\d{3,6}[A-Z]?\s*[-–:]?\s+/, ''));
    b.title = c + ' (click to show/hide, ⌥-click to show only this)';
    b.className = hiddenCourses.has(c) ? 'off' : (hiddenCourses.size ? 'on' : '');
    b.onclick = (e) => {
      if (e.altKey) { hiddenCourses.clear(); courses.forEach((x) => x !== c && hiddenCourses.add(x)); }
      else hiddenCourses.has(c) ? hiddenCourses.delete(c) : hiddenCourses.add(c);
      saveHidden();
    };
    chips.append(b);
  }

  const st = $('#libStatus');
  const sy = lib.sync || {};
  const parts = [];
  $('#btnPull').hidden = !sy.configured;
  $('#btnPull span').textContent = sy.label || 'Sync now';
  $('#btnPull').title = sy.via ? `Runs ${sy.via}` : '';
  const verb = (sy.label || 'Sync').startsWith('Pull') ? sy.label.replace(/^Pull/, 'Pulling') : 'Syncing';
  $('#btnPull').classList.toggle('spin', !!sy.running);
  $('#btnPull').disabled = !!sy.running;
  if (!(lib.paths?.roots || []).length) {
    parts.push(`<div class="status"><div class="t">No library folder yet</div><div>Choose the folder that holds your course folders.</div>
      <div><button class="primary small" id="btnSetupLib">Choose folder…</button></div></div>`);
  }
  if (sy.running) {
    parts.push(`<div class="status"><div class="t">${esc(verb)}…</div><div class="log">${esc(sy.log?.at(-1) || 'Starting')}</div></div>`);
  } else if (sy.result === 'login_required') {
    parts.push(`<div class="status warn"><div class="t">Sign-in expired</div>
      ${sy.has_login ? `<div><button class="primary small" id="btnSyncLogin">Sign in &amp; ${esc((sy.label || 'sync').replace(/^Pull/, 'pull'))}</button></div>` : '<div>Run your sync tool\'s sign-in, then try again.</div>'}</div>`);
  } else if (sy.result === 'ok') {
    parts.push(`<div class="status"><div class="t">${(sy.label || '').startsWith('Pull') ? 'Pulled' : 'Synced'} ✓</div><div class="log">${esc(sy.log?.at(-1) || 'Up to date')}</div></div>`);
  } else if (sy.result === 'login_failed' || sy.result === 'error') {
    parts.push(`<div class="status warn"><div class="t">Sync didn't finish</div><div class="log">${esc(sy.log?.at(-1) || '')}</div></div>`);
  }
  if (lib.inbox) {
    parts.push(`<div class="status"><div class="t">${icon('inbox')} ${lib.inbox} new file${lib.inbox > 1 ? 's' : ''} in Inbox</div>
      <div><button class="small" id="btnSortInbox">${icon('sparkle')} Sort into courses</button></div></div>`);
  }
  if (lib.classifying) parts.push(`<div class="status"><div class="t">${icon('sparkle')} Organising library…</div><div>Sorting lectures, labs and readings.</div></div>`);
  st.innerHTML = parts.join('');
  $('#btnSyncLogin')?.addEventListener('click', () => startSync(true));
  $('#btnSetupLib')?.addEventListener('click', () => openSettings());
  $('#btnSortInbox')?.addEventListener('click', async () => { await post('/api/sort-inbox'); toast('Sorting inbox…'); setTimeout(loadLibrary, 4000); });
}
function saveHidden() { store.set('hiddenCourses', [...hiddenCourses]); renderLibrary(); }

function sortItems(items) {
  const mode = $('#libSort').value;
  const w = (i) => i.week ?? 999;
  const by = {
    week: (a, b) => w(a) - w(b) || a.title.localeCompare(b.title),
    weekdesc: (a, b) => (b.week ?? -1) - (a.week ?? -1) || a.title.localeCompare(b.title),
    recent: (a, b) => b.mtime - a.mtime,
    name: (a, b) => a.title.localeCompare(b.title),
  }[mode];
  return items.sort(by);
}

function group(key, head, kidsHtml, cls) {
  const isCollapsed = collapsed.has(key);
  return `<div class="${cls}${isCollapsed ? ' collapsed' : ''}" data-key="${esc(key)}">
    <button class="row-head">${icon('down', 'chev')}${head}</button><div class="kids">${kidsHtml}</div></div>`;
}

function renderLibrary() {
  const q = $('#libSearch').value.trim().toLowerCase();
  const courses = [...new Set(lib.items.map((i) => i.course))].sort((a, b) => (a === 'Unsorted') - (b === 'Unsorted') || a.localeCompare(b));
  renderChipsAndStatus(courses);
  let html = '';
  for (const course of courses) {
    if (hiddenCourses.has(course) && !q) continue;
    let items = lib.items.filter((i) => i.course === course);
    if (q) items = items.filter((i) => (i.title + ' ' + i.name + ' ' + (i.category || '')).toLowerCase().includes(q));
    if (!items.length) continue;
    const cats = course === 'Unsorted'
      ? [...new Set(items.map((i) => i.category))].sort()
      : [...lib.categories.filter((c) => items.some((i) => i.category === c)), ...(items.some((i) => !i.category) ? [null] : [])];
    let catHtml = '';
    for (const cat of cats) {
      const its = sortItems(items.filter((i) => i.category === cat));
      if (cat === null) { catHtml += `<div class="sorting">${its.length} file${its.length > 1 ? 's' : ''} being sorted…</div>`; continue; }
      const files = its.map((i) => `
        <button class="file${i.path === state.path ? ' active' : ''}" data-path="${esc(i.path)}" title="${esc(i.name)}">
          <span class="ttl">${esc(i.title)}</span>
          ${isNew(i) ? '<span class="new" title="New, not opened yet"></span>' : ''}
          ${i.hasChat ? icon('chat', 'has-chat') : ''}
          ${i.week != null ? `<span class="wk">W${i.week}</span>` : ''}
        </button>`).join('');
      catHtml += group(`${course}::${cat}`, `<span>${esc(cat)}</span><span class="count">${its.length}</span>`, files, 'cat');
    }
    const code = items[0].code || '';
    const title = course === 'Unsorted' ? 'Unsorted' : shortCourse(items[0].courseName || course);
    const head = `<span class="name">${esc(title)}</span>${code ? `<span class="code">${esc(code)}</span>` : ''}
      <span class="count">${items.length}</span><span class="focus" data-focus="${esc(course)}" title="Show only this course">${icon('focus')}</span>`;
    html += group(course, head, catHtml, 'course');
  }
  $('#libList').innerHTML = html || `<div class="sorting">No files${q ? ' match' : ''}.</div>`;
}

$('#libList').addEventListener('click', (e) => {
  const focus = e.target.closest('[data-focus]');
  if (focus) {
    e.stopPropagation();
    const c = focus.dataset.focus;
    hiddenCourses.clear();
    lib.items.forEach((i) => i.course !== c && hiddenCourses.add(i.course));
    collapsed.delete(c); store.set('collapsed', [...collapsed]);
    return saveHidden();
  }
  const head = e.target.closest('.row-head');
  if (head) {
    const g = head.parentElement, key = g.dataset.key;
    g.classList.toggle('collapsed');
    g.classList.contains('collapsed') ? collapsed.add(key) : collapsed.delete(key);
    store.set('collapsed', [...collapsed]);
    return;
  }
  const f = e.target.closest('.file');
  if (f) openPdf(f.dataset.path);
});

// right-click a file: move to another category / rename / reveal
const libMenu = $('#libMenu');
$('#libList').addEventListener('contextmenu', (e) => {
  const f = e.target.closest('.file');
  if (!f) return;
  e.preventDefault();
  const item = lib.items.find((i) => i.path === f.dataset.path);
  if (!item) return;
  const cats = item.course === 'Unsorted' ? [] : lib.categories;
  libMenu.innerHTML = (cats.length ? `<div class="label">Move to</div>` + cats.map((c) =>
    `<button data-cat="${esc(c)}" class="${c === item.category ? 'checked' : ''}">${esc(c)}</button>`).join('') + '<hr>' : '') +
    `<button data-lib="rename">${icon('edit')}Rename…</button><button data-lib="reveal">${icon('folder')}Show in Finder</button>`;
  libMenu.dataset.path = item.path;
  libMenu.hidden = false;
  libMenu.style.left = Math.min(e.clientX, innerWidth - 240) + 'px';
  libMenu.style.top = Math.min(e.clientY, innerHeight - libMenu.offsetHeight - 8) + 'px';
});
libMenu.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const path = libMenu.dataset.path;
  libMenu.hidden = true;
  if (b.dataset.cat) await post('/api/library/set', { path, category: b.dataset.cat });
  if (b.dataset.lib === 'rename') {
    const item = lib.items.find((i) => i.path === path);
    const t = prompt('Display name', item?.title || '');
    if (t) await post('/api/library/set', { path, title: t.trim() });
  }
  if (b.dataset.lib === 'reveal') return post('/api/reveal', { path });
  loadLibrary();
});

$('#libSearch').addEventListener('input', renderLibrary);
$('#libSort').addEventListener('change', () => { store.set('libSort', $('#libSort').value); renderLibrary(); });

async function startSync(login = false) {
  lib.sync = await post('/api/sync', { login });
  if (login) toast('Running your sign-in command. Finish signing in if a window opened.', false, 8000);
  renderLibrary();
  schedulePoll();
}
$('#btnPull').onclick = () => startSync(false);

// =====================================================================================
// Viewer
// =====================================================================================
const viewer = $('#viewer');
let observer = null;

async function openPdf(path, page) {
  try {
    const doc = await pdfjsLib.getDocument({ url: '/api/pdf?path=' + encodeURIComponent(path), httpHeaders: H }).promise;
    if (state.pdf) state.pdf.destroy();
    state.pdf = doc; state.path = path;
    const item = lib.items.find((i) => i.path === path);
    state.name = item?.title || path.split('/').pop().replace(/\.pdf$/i, '');
    document.body.classList.add('has-doc');
    $('#docTools').hidden = false;
    const crumb = item && item.course !== 'Unsorted' ? `<span class="crumb">${esc(shortCourse(item.courseName))} / ${esc(item.category || '')} / </span>` : '';
    $('#docTitle').innerHTML = crumb + esc(state.name);
    document.title = state.name + ' · SlideMate';
    store.set('lastPath', path);
    opened.add(path); store.set('opened', [...opened]);
    history.replaceState(null, '', '?file=' + encodeURIComponent(path));
    await loadChat(path);
    loadLectures(path);
    loadUsage(path);
    await buildPages();
    goTo(page || store.get('page:' + path, 1), false);
    renderLibrary();
    renderChat();
    if (window.innerWidth < 1000) document.body.classList.add('lib-hidden');
  } catch (e) {
    toast('Could not open PDF: ' + e.message, true);
  }
}

async function buildPages() {
  viewer.innerHTML = '';
  state.pages = [];
  if (observer) observer.disconnect();
  const first = await state.pdf.getPage(1);
  const vp1 = first.getViewport({ scale: 1 });
  // "Fit" = the whole slide fits on screen, so there's always one clear current slide.
  if (state.fit || !state.scale) state.scale = Math.min((viewer.clientWidth - 110) / vp1.width, (viewer.clientHeight - 48) / vp1.height);
  observer = new IntersectionObserver(onIntersect, { root: viewer, threshold: [0, 0.25, 0.5, 0.75, 1] });
  for (let i = 1; i <= state.pdf.numPages; i++) {
    const div = document.createElement('div');
    div.className = 'page';
    div.dataset.page = i;
    div.style.width = vp1.width * state.scale + 'px'; div.style.height = vp1.height * state.scale + 'px';
    div.innerHTML = `<span class="num">${i}</span>`;
    viewer.append(div);
    state.pages.push({ div, rendered: 0 });
    observer.observe(div);
  }
  markChattedSlides();
  markNoteSlides();
}

const visible = new Map();
function onIntersect(entries) {
  for (const e of entries) {
    const n = +e.target.dataset.page;
    if (e.isIntersecting) { visible.set(n, e.intersectionRatio); renderPage(n); renderPage(n + 1); }
    else visible.delete(n);
  }
  // current = the most visible slide; ties go to the one nearest the middle (or the ends at top/bottom of the deck)
  const vr = viewer.getBoundingClientRect();
  const atTop = viewer.scrollTop < 4, atEnd = viewer.scrollTop + viewer.clientHeight > viewer.scrollHeight - 4;
  const focus = atTop ? vr.top : atEnd ? vr.bottom : vr.top + vr.height / 2;
  let cur = state.current, best = -1, bestDist = Infinity;
  for (const n of visible.keys()) {
    const r = state.pages[n - 1].div.getBoundingClientRect();
    const seen = Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top);
    const dist = Math.abs((r.top + r.bottom) / 2 - focus);
    if (seen > best + 2 || (Math.abs(seen - best) <= 2 && dist < bestDist)) { best = Math.max(seen, best); bestDist = dist; cur = n; }
  }
  if (best > 0) setCurrent(cur);
}
viewer.addEventListener('scroll', () => requestAnimationFrame(() => onIntersect([])), { passive: true });

function setCurrent(n) {
  if (n === state.current && state.pages[n - 1]?.div.classList.contains('current')) return;
  const changed = n !== state.current;
  state.pages[state.current - 1]?.div.classList.remove('current');
  state.current = n;
  state.pages[n - 1]?.div.classList.add('current');
  $('#pageLabel').textContent = `${n} / ${state.pdf.numPages}`;
  $('#chatCtx').textContent = `Slide ${n} of ${state.pdf.numPages} · ${providerLabel()} has the whole deck`;
  store.set('page:' + state.path, n);
  if (changed && state.chatMode === 'slide' && !state.busy) renderChat();
  if (changed) onSlideChange(n);
}

async function renderPage(n) {
  const p = state.pages[n - 1];
  if (!p || p.rendered === state.scale) return;
  p.rendered = state.scale;
  const page = await state.pdf.getPage(n);
  const vp = page.getViewport({ scale: state.scale });
  const dpr = window.devicePixelRatio || 1;
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width * dpr); c.height = Math.floor(vp.height * dpr);
  p.div.style.width = vp.width + 'px'; p.div.style.height = vp.height + 'px';
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
  p.div.querySelector('canvas')?.remove();
  p.div.prepend(c);
}

function goTo(n, smooth = true) {
  if (!state.pdf) return;
  n = Math.max(1, Math.min(state.pdf.numPages, n));
  state.pages[n - 1].div.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant', block: 'center' });
  setCurrent(n);
}

async function setZoom(scale, fit = false) {
  const cur = state.current;
  state.fit = fit;
  state.scale = fit ? null : scale;
  await buildPages();
  goTo(cur, false);
}
$('#btnPrev').onclick = () => goTo(state.current - 1);
$('#btnNext').onclick = () => goTo(state.current + 1);
$('#btnZoomIn').onclick = () => setZoom(state.scale * 1.2);
$('#btnZoomOut').onclick = () => setZoom(state.scale / 1.2);
$('#btnFit').onclick = () => setZoom(null, true);
let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => state.pdf && state.fit && setZoom(null, true), 200); });

// Render a page (optionally a crop in 0..1 page coords) to a data URL at a target pixel width.
async function renderImage(n, { width = 2400, crop = null, type = 'image/png', quality = 0.9 } = {}) {
  const page = await state.pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const fullW = crop ? width / crop.w : width;
  const vp = page.getViewport({ scale: Math.min(fullW / base.width, 8) });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  if (!crop) return c.toDataURL(type, quality);
  const o = document.createElement('canvas');
  o.width = Math.max(1, Math.round(crop.w * c.width)); o.height = Math.max(1, Math.round(crop.h * c.height));
  o.getContext('2d').drawImage(c, crop.x * c.width, crop.y * c.height, o.width, o.height, 0, 0, o.width, o.height);
  return o.toDataURL(type, quality);
}

// =====================================================================================
// Send to iPad
// =====================================================================================
let cfg = {};
async function sendToIpad(dataUrl, label) {
  toast('Sending to iPad…', false, 1800);
  try {
    const r = await post('/api/send', { image: dataUrl, name: label });
    const ad = r.airdrop;
    const clip = r.clipboard ? ' Also on your clipboard.' : '';
    if (!ad) toast('Copied.' + clip);
    else if (ad.state === 'clicked') toast(`AirDropping to ${ad.device} ✓` + clip);
    else if (ad.state === 'failed') toast('AirDrop failed: ' + (ad.error || '') + clip, true, 6000);
    else if (ad.trusted === false) toast('Click your iPad in the AirDrop panel. (Enable auto-select in Settings.)' + clip, false, 6000);
    else toast(`AirDrop panel open. Couldn't spot "${cfg.ipad_name}" yet, click it when it appears.` + clip, false, 6000);
  } catch (e) {
    toast('Send failed: ' + e.message, true);
  }
}
async function sendSlide(n = state.current) {
  if (!state.pdf) return;
  sendToIpad(await renderImage(n), `${state.name} p${n}`);
}
$('#btnSend').onclick = () => sendSlide();

// ---------- snip ----------
const snipLayer = $('#snipLayer'), snipRect = $('#snipRect'), snipMenu = $('#snipMenu');
let snip = null, pendingSnip = null;
function startSnip() {
  if (!state.pdf) return;
  hideMenus();
  snipLayer.hidden = false; snipRect.style.display = 'none'; snip = null;
}
function endSnip() { snipLayer.hidden = true; snipMenu.hidden = true; snip = null; }
$('#btnSnip').onclick = startSnip;
snipLayer.addEventListener('mousedown', (e) => {
  snipMenu.hidden = true;
  snipLayer.style.pointerEvents = 'none';
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.page');
  snipLayer.style.pointerEvents = '';
  if (!el) return;
  const wrap = $('#viewerWrap').getBoundingClientRect();
  snip = { page: +el.dataset.page, pr: el.getBoundingClientRect(), x0: e.clientX, y0: e.clientY, wrap };
  Object.assign(snipRect.style, { display: 'block', left: e.clientX - wrap.left + 'px', top: e.clientY - wrap.top + 'px', width: 0, height: 0 });
});
window.addEventListener('mousemove', (e) => {
  if (!snip || snip.done) return;
  const { pr, wrap } = snip;
  const x1 = Math.max(pr.left, Math.min(pr.right, e.clientX)), y1 = Math.max(pr.top, Math.min(pr.bottom, e.clientY));
  snip.x1 = x1; snip.y1 = y1;
  Object.assign(snipRect.style, {
    left: Math.min(snip.x0, x1) - wrap.left + 'px', top: Math.min(snip.y0, y1) - wrap.top + 'px',
    width: Math.abs(x1 - snip.x0) + 'px', height: Math.abs(y1 - snip.y0) + 'px',
  });
});
window.addEventListener('mouseup', () => {
  if (!snip || snip.done) return;
  if (snip.x1 == null || Math.abs(snip.x1 - snip.x0) < 8 || Math.abs(snip.y1 - snip.y0) < 8) { snipRect.style.display = 'none'; snip = null; return; }
  snip.done = true;
  const { pr, wrap } = snip;
  snip.crop = {
    x: (Math.min(snip.x0, snip.x1) - pr.left) / pr.width, y: (Math.min(snip.y0, snip.y1) - pr.top) / pr.height,
    w: Math.abs(snip.x1 - snip.x0) / pr.width, h: Math.abs(snip.y1 - snip.y0) / pr.height,
  };
  snipMenu.hidden = false;
  snipMenu.style.left = Math.max(8, Math.min(Math.max(snip.x0, snip.x1) - wrap.left - snipMenu.offsetWidth, wrap.width - snipMenu.offsetWidth - 8)) + 'px';
  snipMenu.style.top = Math.min(Math.max(snip.y0, snip.y1) - wrap.top + 8, wrap.height - 50) + 'px';
});
snipMenu.addEventListener('mousedown', (e) => e.stopPropagation());
snipMenu.addEventListener('click', async (e) => {
  const act = e.target.closest('button')?.dataset.snip;
  if (!act || !snip) return;
  const { page, crop } = snip;
  endSnip();
  if (act === 'send') sendToIpad(await renderImage(page, { crop, width: 2000 }), `${state.name} p${page} snip`);
  if (act === 'ask') {
    pendingSnip = { page, img: await renderImage(page, { crop, width: 1200, type: 'image/jpeg', quality: 0.88 }) };
    showChat();
    $('#askInput').placeholder = `Ask about the snipped area of slide ${page}`;
    $('#askInput').focus();
  }
});

// ---------- slide context menu ----------
const ctx = $('#ctxMenu');
let ctxPage = null;
viewer.addEventListener('contextmenu', (e) => {
  const el = e.target.closest('.page');
  if (!el) return;
  e.preventDefault();
  ctxPage = +el.dataset.page;
  setCurrent(ctxPage);
  ctx.hidden = false;
  ctx.style.left = Math.min(e.clientX, innerWidth - 240) + 'px';
  ctx.style.top = Math.min(e.clientY, innerHeight - ctx.offsetHeight - 8) + 'px';
});
function hideMenus() { ctx.hidden = true; libMenu.hidden = true; }
window.addEventListener('mousedown', (e) => { if (!e.target.closest('.menu')) hideMenus(); });
ctx.addEventListener('click', async (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (!act) return;
  hideMenus();
  if (act === 'explain') ask('Explain this slide.');
  if (act === 'ask') { showChat(); $('#askInput').focus(); }
  if (act === 'send') sendSlide(ctxPage);
  if (act === 'snip') startSnip();
  if (act === 'copy') {
    const blob = await (await fetch(await renderImage(ctxPage))).blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Slide copied');
  }
});

// =====================================================================================
// Chat (saved per deck, shown per slide)
// =====================================================================================
function mdRender(text) {
  const math = [];
  const stash = (tex, display) => { math.push({ tex, display }); return `@@M${math.length - 1}@@`; };
  const t = text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => stash(m, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => stash(m, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => stash(m, false))
    .replace(/(^|[^\\$\w])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?![\w$])/g, (_, pre, m) => pre + stash(m, false));
  return marked.parse(t, { gfm: true }).replace(/@@M(\d+)@@/g, (_, i) => {
    const { tex, display } = math[+i];
    try { return katex.renderToString(tex, { displayMode: display, throwOnError: false }); } catch { return esc(tex); }
  });
}

async function loadChat(path) {
  try {
    const h = await (await api('/api/chat-history?path=' + encodeURIComponent(path))).json();
    state.chats[path] = h.messages || [];
  } catch { state.chats[path] ||= []; }
}
const chatFor = (path) => (state.chats[path] ||= []);

function markChattedSlides() {
  const slides = new Set(chatFor(state.path).map((m) => m.slide));
  state.pages.forEach((p, i) => p.div.querySelector('.num')?.classList.toggle('chat', slides.has(i + 1)));
}

function setChatMode(mode) {
  state.chatMode = mode;
  store.set('chatMode', mode);
  document.querySelectorAll('#chatMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  renderChat();
}
$('#chatMode').addEventListener('click', (e) => { if (e.target.dataset.mode) setChatMode(e.target.dataset.mode); });

function renderChat() {
  const box = $('#messages');
  box.innerHTML = '';
  if (!state.path) return;
  const all = chatFor(state.path);
  const msgs = state.chatMode === 'slide' ? all.filter((m) => m.slide === state.current) : all;
  if (!msgs.length) {
    const others = all.filter((m) => m.role === 'user').length;
    box.innerHTML = `<div class="empty-chat"><b>${state.chatMode === 'slide' ? `Nothing asked on slide ${state.current} yet` : 'No questions on this deck yet'}</b>
      The tutor has read the whole deck, so answers link back to the rest of the lecture. Right-click a slide or press <kbd>E</kbd>.
      ${state.chatMode === 'slide' && others ? `<br><button class="small" id="viewAll">${icon('history')}See ${others} question${others > 1 ? 's' : ''} on other slides</button>` : ''}</div>`;
    $('#viewAll')?.addEventListener('click', () => setChatMode('all'));
    return;
  }
  let lastDay = '';
  for (const m of msgs) {
    const day = new Date((m.ts || Date.now() / 1000) * 1000).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    if (day !== lastDay && m.role === 'user') { box.insertAdjacentHTML('beforeend', `<div class="msg-divider">${day}</div>`); lastDay = day; }
    box.append(msgEl(m));
  }
  box.scrollTop = box.scrollHeight;
}
function msgEl(m) {
  const d = document.createElement('div');
  m._el = d;
  d.className = 'msg ' + m.role;
  if (m.role === 'user') {
    d.innerHTML = `<button class="slide-tag" data-goto="${m.slide}">Slide ${m.slide}${m.snip ? ' · snip' : ''}</button><div class="q"></div>`;
    d.querySelector('.q').textContent = m.text;
    if (m.image) { const i = new Image(); i.src = m.image; d.append(i); }
  } else d.innerHTML = mdRender(m.text || '');
  return d;
}
$('#messages').addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) goTo(+g.dataset.goto); });

async function ask(question) {
  if (!state.pdf || !question.trim()) return;
  if (state.busy) return toast('Still answering the last question…');
  state.busy = true;
  try { await askInner(question); } catch (e) { toast('Error: ' + e.message, true); } finally { state.busy = false; }
}
async function askInner(question) {
  showChat();
  const path = state.path, total = state.pdf.numPages;
  const snipNow = pendingSnip;
  pendingSnip = null;
  $('#askInput').placeholder = 'Ask about this slide';
  const page = snipNow?.page || state.current;
  const image = snipNow ? snipNow.img : await renderImage(page, { width: 1400, type: 'image/jpeg', quality: 0.85 });
  const fullQ = snipNow ? `(The attached image is a snipped area of slide ${page}, not the whole slide.)\n\n${question}` : question;
  if (state.chatMode === 'slide' && page !== state.current) setChatMode('all');
  const msgs = chatFor(path);
  msgs.push({ role: 'user', text: question, slide: page, ts: Date.now() / 1000, snip: !!snipNow, image: snipNow?.img });
  const bot = { role: 'bot', text: '', slide: page, ts: Date.now() / 1000 };
  msgs.push(bot);
  renderChat();
  markChattedSlides();
  const box = $('#messages');
  bot._el.classList.add('thinking');
  try {
    const res = await api('/api/chat', { method: 'POST', body: JSON.stringify({ path, page, total, question: fullQ, display: question, snip: !!snipNow, image }) });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', raf = 0;
    const paint = () => {
      raf = 0;
      if (state.path !== path || !bot._el?.isConnected) return;
      if (!bot.text) { bot._el.dataset.status = bot.status || 'Thinking'; return; }
      bot._el.classList.remove('thinking');
      bot._el.innerHTML = (bot.status ? `<div class="tool-status"><span class="spinner"></span>${esc(bot.status)}</div>` : '') + mdRender(bot.text);
      if (box.scrollHeight - box.scrollTop - box.clientHeight < 140) box.scrollTop = box.scrollHeight;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (!line || block.startsWith('event: done')) continue;
        if (block.startsWith('event: usage')) { setUsage(JSON.parse(line.slice(6))); continue; }
        if (block.startsWith('event: status')) {  // e.g. "Using blackboard › bb_upcoming…" (live only)
          bot.status = JSON.parse(line.slice(6));
          if (!raf) raf = requestAnimationFrame(paint);
          continue;
        }
        bot.text += JSON.parse(line.slice(6));
        bot.status = null;
        if (!raf) raf = requestAnimationFrame(paint);
      }
    }
    paint();
    const item = lib.items.find((x) => x.path === path);
    if (item && !item.hasChat) { item.hasChat = true; renderLibrary(); }
  } catch (e) {
    bot.text += `\n\n**Error:** ${e.message}`;
    if (bot._el) bot._el.innerHTML = mdRender(bot.text);
  } finally {
    bot._el?.classList.remove('thinking');
  }
}

$('#askForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#askInput').value;
  $('#askInput').value = '';
  autosize();
  ask(v);
});
const autosize = () => { const t = $('#askInput'); t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; };
$('#askInput').addEventListener('input', autosize);
$('#askInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#askForm').requestSubmit(); }
  if (e.key === 'Escape') { pendingSnip = null; e.target.placeholder = 'Ask about this slide'; e.target.blur(); }
});
$('#chips').addEventListener('click', (e) => { if (e.target.dataset.q) ask(e.target.dataset.q); });
$('#btnReset').onclick = async () => {
  if (!state.path) return;
  if (chatFor(state.path).length && !confirm('Start a fresh chat for this deck?\n\nThe current conversation is archived (still saved on disk), and Claude starts over without it.')) return;
  await post('/api/reset', { path: state.path, clear: true });
  state.chats[state.path] = [];
  renderChat();
  markChattedSlides();
  loadLibrary();
};

// =====================================================================================
// Panels, settings, keyboard, drag & drop
// =====================================================================================
function showChat() { document.body.classList.remove('chat-hidden'); store.set('chatHidden', false); }
function refit() { if (state.pdf && state.fit) setTimeout(() => setZoom(null, true), 0); }
function toggleLib() { document.body.classList.toggle('lib-hidden'); store.set('libHidden', document.body.classList.contains('lib-hidden')); refit(); }
$('#btnChat').onclick = () => { document.body.classList.toggle('chat-hidden'); store.set('chatHidden', document.body.classList.contains('chat-hidden')); refit(); };
$('#btnLibrary').onclick = toggleLib;
$('#btnLibClose').onclick = toggleLib;
if (store.get('chatHidden', false)) document.body.classList.add('chat-hidden');
if (store.get('libHidden', false)) document.body.classList.add('lib-hidden');

// ---------- settings + first-run setup ----------
let sysStatus = null;
const providerLabel = () => (cfg.provider === 'codex' ? 'ChatGPT' : 'Claude');
async function refreshTrust() {
  $('#trustStatus').textContent = 'Checking auto-select…';
  const { trusted } = await (await api('/api/trust')).json();
  if (trusted === null) { $('#trustStatus').textContent = 'AirDrop helper not installed: use the SlideMate app, or run scripts/build-app.sh'; $('#btnTrust').hidden = true; return; }
  $('#trustStatus').textContent = trusted ? '✓ Auto-select is on: your iPad gets picked automatically' : 'Auto-select is off: you click your iPad in the AirDrop panel';
  $('#btnTrust').hidden = trusted;
}
let draft = {};
function renderRoots() {
  $('#rootList').innerHTML = (draft.library_roots || []).map((r, i) => `<div class="root"><span title="${esc(r)}">${esc(r)}</span><button type="button" data-rm="${i}" title="Remove">✕</button></div>`).join('')
    || '<div class="hint">No folder chosen yet.</div>';
}
$('#rootList').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { draft.library_roots.splice(+b.dataset.rm, 1); renderRoots(); } });
$('#btnAddRoot').onclick = async () => {
  const { path } = await post('/api/pick-folder');
  if (path && !draft.library_roots.includes(path)) { draft.library_roots.push(path); renderRoots(); }
};
function renderProviders() {
  const ps = sysStatus?.providers || {};
  const card = (id, name, sub) => {
    const s = ps[id] || {};
    const state = !s.installed ? `<span class="st bad">Not installed</span><br><code>${esc(s.install || '')}</code>`
      : !s.logged_in ? `<span class="st bad">Installed, not signed in</span><div class="acts"><button type="button" class="small" data-login="${id}">Sign in…</button></div>`
      : `<span class="st ok">✓ Signed in${s.detail ? ' · ' + esc(s.detail) : ''}</span>`;
    return `<label class="pcard ${draft.provider === id ? 'on' : ''}"><input type="radio" name="prov" value="${id}" ${draft.provider === id ? 'checked' : ''}>
      <div class="body"><b>${name}</b><div class="st">${sub}</div>${state}</div></label>`;
  };
  $('#providerCards').innerHTML = card('claude', 'Claude', 'Claude Code · sign in with your Claude account (Pro/Max). Reads slides natively.')
    + card('codex', 'ChatGPT', 'Codex CLI · sign in with your ChatGPT account.')
    + `<button type="button" class="small ghost" id="btnRecheck">Re-check</button>`;
  $('#modelRow').innerHTML = draft.provider === 'codex'
    ? `<label>Model <span class="muted">(blank = Codex default)</span><input id="setCodexModel" value="${esc(draft.codex_model || '')}" placeholder="default"></label>`
    : `<label>Tutor model<select id="setClaudeModel">${['sonnet', 'opus', 'haiku'].map((m) => `<option ${draft.claude_model === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
       <label>Lecture-notes model<select id="setClaudeNotes">${['opus', 'sonnet', 'haiku'].map((m) => `<option ${draft.claude_notes_model === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>`;
}
$('#providerCards').addEventListener('change', (e) => { if (e.target.name === 'prov') { readModelFields(); draft.provider = e.target.value; renderProviders(); } });
$('#providerCards').addEventListener('click', async (e) => {
  const l = e.target.closest('[data-login]');
  if (l) { e.preventDefault(); await post('/api/login', { provider: l.dataset.login }); toast('Finish signing in in the Terminal window that opened, then press Re-check.', false, 9000); }
  if (e.target.id === 'btnRecheck') { e.preventDefault(); await loadStatus(); renderProviders(); }
});
function readModelFields() {
  if ($('#setCodexModel')) draft.codex_model = $('#setCodexModel').value.trim();
  if ($('#setClaudeModel')) { draft.claude_model = $('#setClaudeModel').value; draft.claude_notes_model = $('#setClaudeNotes').value; }
}
async function loadStatus() { sysStatus = await (await api('/api/status')).json(); }
async function openSettings(firstRun = false) {
  draft = JSON.parse(JSON.stringify(cfg));
  document.body.classList.toggle('first-run', firstRun);
  $('#welcome').hidden = !firstRun;
  $('#btnSettingsSave').textContent = firstRun ? 'Get started' : 'Save';
  renderRoots();
  $('#setIpad').value = cfg.ipad_name || '';
  $('#setAirdrop').checked = cfg.airdrop;
  $('#setClip').checked = cfg.copy_to_clipboard;
  $('#setSync').value = cfg.sync_command || '';
  $('#setSyncLogin').value = cfg.sync_login_command || '';
  $('#setSyncMode').value = cfg.sync_mcp?.server ? 'mcp' : (cfg.sync_command ? 'command' : '');
  $('#mcpImport').hidden = true; $('#mcpForm').hidden = true;
  renderMcp();
  renderSyncMode();
  $('#setMd').checked = cfg.write_markdown;
  $('#providerCards').innerHTML = '<div class="hint">Checking which AI apps are installed…</div>';
  $('#settings').showModal();
  await loadStatus();
  renderProviders();
  const r = sysStatus.recording;
  $('#recStatus').innerHTML = r.ffmpeg && r.parakeet ? '✓ Ready (Parakeet speech-to-text, runs on this Mac).'
    : `Recording needs ffmpeg and Parakeet: <code>${esc(r.install)}</code>. Importing a transcript works without them.`;
  const p = lib.paths || {};
  const rows = [['Your slides', (p.roots || []).join(', ')], ['Inbox: drop PDFs here to have them filed', p.inbox],
    ['SlideMate data (settings, chats, lecture notes, recordings)', p.data], ['Screenshots sent to iPad', p.snaps]];
  $('#storage').innerHTML = rows.filter(([, path]) => path).map(([label, path]) => `<div class="store"><b>${esc(label)}</b><code>${esc(path)}</code>
    <button type="button" class="small" data-reveal="${esc(path.split(', ')[0])}">Show</button></div>`).join('');
  refreshTrust();
}
// ---------- MCP connections ----------
const mcpTools = {};   // server → [tool names] (from the last Test)
function renderMcp() {
  const srv = cfg.mcp_servers || {};
  for (const [n, s] of Object.entries(srv)) if (s.tools && !mcpTools[n]) mcpTools[n] = { tools: s.tools };
  const names = Object.keys(srv);
  $('#mcpList').innerHTML = names.length ? names.map((n) => {
    const s = srv[n], t = mcpTools[n];
    const res = t?.error ? `<span class="res bad">${esc(t.error)}</span>` : t?.tools ? `<span class="res ok">✓ ${t.tools.length} tools</span>` : t?.remote ? '<span class="res">remote server</span>' : '';
    return `<div class="mcp"><div class="body"><b>${esc(n)}</b> ${res}<div class="sub">${esc(s.url || [s.command, ...(s.args || [])].join(' '))}${s.env_keys?.length ? ' · env: ' + esc(s.env_keys.join(', ')) : ''}</div></div>
      <label class="check" title="Let the tutor call this server's tools"><input type="checkbox" data-mcp-tutor="${esc(n)}" ${s.tutor !== false ? 'checked' : ''}> Tutor</label>
      <button type="button" class="small" data-mcp-test="${esc(n)}">Test</button>
      <button type="button" class="small ghost" data-mcp-rm="${esc(n)}" title="Remove">✕</button></div>`;
  }).join('') : '<div class="hint">No connections yet.</div>';
}
async function mcpTest(n) {
  mcpTools[n] = { pending: true }; renderMcp();
  const r = await post('/api/mcp/tools', { name: n });
  mcpTools[n] = r.error ? { error: r.error } : r.remote ? { remote: true } : { tools: r.tools.map((t) => t.name) };
  renderMcp(); renderSyncMode();
}
$('#mcpList').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-mcp-test]'); if (t) return mcpTest(t.dataset.mcpTest);
  const r = e.target.closest('[data-mcp-rm]');
  if (r && confirm(`Remove the "${r.dataset.mcpRm}" connection?`)) { cfg = await post('/api/mcp/remove', { name: r.dataset.mcpRm }); renderMcp(); renderSyncMode(); }
});
$('#mcpList').addEventListener('change', async (e) => {
  const c = e.target.closest('[data-mcp-tutor]');
  if (c) cfg = await post('/api/mcp/save', { name: c.dataset.mcpTutor, tutor: c.checked });
});
$('#btnMcpImport').onclick = async () => {
  const box = $('#mcpImport');
  box.hidden = false; $('#mcpForm').hidden = true;
  box.innerHTML = '<div class="hint">Looking for MCP servers in Claude Desktop, Claude Code and Codex…</div>';
  const found = await (await api('/api/mcp/discover')).json();
  const names = Object.keys(found).filter((n) => !found[n].added);
  box.innerHTML = names.length ? names.map((n) => `<label class="imp"><input type="checkbox" value="${esc(n)}"><b>${esc(n)}</b>
      <span class="muted">${esc(found[n].source)} · ${esc(found[n].command || '')}</span></label>`).join('')
      + '<div class="line" style="justify-content:flex-end"><button type="button" class="small ghost" id="btnImpCancel">Cancel</button><button type="button" class="small primary" id="btnImpDo">Import selected</button></div>'
    : '<div class="hint">Nothing new found. Everything is already imported, or no MCP servers are set up in those apps.</div>';
  $('#btnImpCancel')?.addEventListener('click', () => { box.hidden = true; });
  $('#btnImpDo')?.addEventListener('click', async () => {
    const sel = [...box.querySelectorAll('input:checked')].map((i) => i.value);
    if (!sel.length) return;
    box.innerHTML = '<div class="hint"><span class="spinner"></span>Importing and checking tools…</div>';
    cfg = await post('/api/mcp/import', { names: sel });
    box.hidden = true; renderMcp();
    if (cfg.sync_mcp?.server && sel.includes(cfg.sync_mcp.server)) {
      $('#setSyncMode').value = 'mcp'; renderSyncMode();
      toast(`${cfg.sync_mcp.server} can sync, so a Pull button now appears in your library.`, false, 6000);
    }
    loadLibrary();
  });
};
$('#btnMcpAdd').onclick = () => { $('#mcpForm').hidden = false; $('#mcpImport').hidden = true; ['#mcpName', '#mcpCmd', '#mcpArgs', '#mcpEnv'].forEach((s) => ($(s).value = '')); };
$('#btnMcpCancel').onclick = () => { $('#mcpForm').hidden = true; };
$('#btnMcpSave').onclick = async () => {
  const name = $('#mcpName').value.trim();
  let [command, ...pre] = $('#mcpCmd').value.trim().split(/\s+/);
  const args = [...pre, ...($('#mcpArgs').value.trim() ? $('#mcpArgs').value.trim().split(/\s+/) : [])];
  const env = Object.fromEntries($('#mcpEnv').value.split('\n').map((l) => l.trim()).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
  if (!name || !command) return toast('Name and command are required', true);
  const body = /^https?:\/\//.test(command) ? { name, url: command, enabled: true, tutor: true } : { name, command, args, env, enabled: true, tutor: true };
  const r = await post('/api/mcp/save', body);
  if (r.error) return toast(r.error, true);
  cfg = r; $('#mcpForm').hidden = true; renderMcp(); mcpTest(name);
};
function renderSyncMode() {
  const mode = $('#setSyncMode').value;
  $('#syncMcpRow').hidden = mode !== 'mcp';
  $('#syncCmdRow').hidden = mode !== 'command';
  if (mode !== 'mcp') return;
  const servers = Object.keys(cfg.mcp_servers || {}).filter((n) => !(cfg.mcp_servers[n].url));
  const cur = cfg.sync_mcp || {};
  const sel = $('#syncServer').value || cur.server || servers[0] || '';
  $('#syncServer').innerHTML = servers.length ? servers.map((n) => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('') : '<option value="">Add a connection first</option>';
  const tools = mcpTools[sel]?.tools;
  if (sel && !tools && !mcpTools[sel]?.pending && !mcpTools[sel]?.error) { mcpTest(sel); return; }
  const opts = (list, val, blank) => (blank ? `<option value="">${blank}</option>` : '') + (list || (val ? [val] : [])).map((t) => `<option ${t === val ? 'selected' : ''}>${esc(t)}</option>`).join('');
  const guess = (...res) => { for (const re of res) { const t = (tools || []).find((x) => re.test(x)); if (t) return t; } return ''; };
  $('#syncTool').innerHTML = opts(tools, cur.server === sel && cur.tool ? cur.tool : guess(/(^|_)sync$/i, /sync(?!_status)/i, /pull/i, /download/i));
  $('#syncLoginTool').innerHTML = opts(tools, cur.server === sel ? cur.login_tool : guess(/(^|_)login$/i, /login|sign.?in|auth/i), 'None');
}
$('#setSyncMode').addEventListener('change', renderSyncMode);
$('#syncServer').addEventListener('change', renderSyncMode);

// ---------- model / effort picker + usage ring (bottom right of the composer) ----------
let catalog = null, usage = {};
const EFFORT_LABEL = { '': 'Auto', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', minimal: 'Minimal' };
const fmtTok = (n) => n == null ? '–' : n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n);
async function loadModels() {
  try { catalog = await (await api('/api/models')).json(); } catch { return; }
  renderModelBtn();
}
function provCat() { return catalog ? catalog[catalog.provider] : null; }
function renderModelBtn() {
  const c = provCat();
  if (!c) return;
  const m = c.models.find((x) => x.id === c.model);
  const name = m ? m.label : (catalog.provider === 'codex' ? 'Default model' : c.model);
  $('#modelLabel').textContent = `${name}${c.effort ? ' · ' + (EFFORT_LABEL[c.effort] || c.effort) : ''}`;
}
function effortsFor(c) {
  if (catalog.provider === 'claude') return c.efforts;
  const m = c.models.find((x) => x.id === c.model);
  return m?.efforts || ['low', 'medium', 'high', 'xhigh'];
}
function openModelMenu() {
  const c = provCat();
  if (!c) return;
  const menu = $('#modelMenu');
  const models = catalog.provider === 'codex' ? [{ id: '', label: 'Default', desc: 'Whatever Codex is set to use' }, ...c.models] : c.models;
  menu.innerHTML = `<div class="label">${catalog.provider === 'codex' ? 'ChatGPT model' : 'Claude model'}</div>`
    + models.map((m) => `<button class="mrow" data-model="${esc(m.id)}"><b>${esc(m.label)}${m.id === c.model ? '<span class="chk">✓</span>' : ''}</b>${m.desc ? `<span>${esc(m.desc)}</span>` : ''}</button>`).join('')
    + `<hr><div class="label">Effort</div><div class="efforts">${['', ...effortsFor(c)].map((e) => `<button data-effort="${e}" class="${e === (c.effort || '') ? 'on' : ''}">${EFFORT_LABEL[e] || e}</button>`).join('')}</div>`;
  menu.hidden = false;
  placeAbove(menu, $('#modelBtn'));
}
function placeAbove(menu, anchor) {
  const place = () => {
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, r.top - menu.offsetHeight - 6) + 'px';
  };
  place();
  requestAnimationFrame(place);  // fonts/layout can settle a frame later on first open
}
$('#modelBtn').onclick = (e) => { e.stopPropagation(); $('#modelMenu').hidden ? openModelMenu() : ($('#modelMenu').hidden = true); };
$('#modelMenu').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const prov = catalog.provider;
  const change = b.dataset.model !== undefined ? { [`${prov}_model`]: b.dataset.model } : { [`${prov}_effort`]: b.dataset.effort };
  cfg = await post('/api/config', change);
  await loadModels();
  if (b.dataset.model !== undefined) $('#modelMenu').hidden = true; else openModelMenu();
  toast(`Now using ${$('#modelLabel').textContent} (from your next question)`, false, 2200);
});
async function loadUsage(path) {
  try { setUsage(await (await api('/api/usage?path=' + encodeURIComponent(path))).json(), true); } catch {}
}
function setUsage(u, replace = false) {
  usage = replace ? (u || {}) : { ...usage, ...u };
  const frac = usage.context_window ? Math.min(1, (usage.context_used || 0) / usage.context_window) : 0;
  $('#ringFg').style.strokeDashoffset = String(47.12 * (1 - frac));
  $('#ctxRing').classList.toggle('warn', frac > 0.7 && frac <= 0.9);
  $('#ctxRing').classList.toggle('full', frac > 0.9);
  $('#ctxRing').title = usage.context_window ? `${fmtTok(usage.context_window - usage.context_used)} tokens left in this conversation` : 'Context and plan usage';
  if (!$('#usagePop').hidden) openUsage();
}
function resetText(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return 'resets ' + (sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }));
}
function openUsage() {
  const pop = $('#usagePop'), u = usage;
  const pct = u.context_window ? Math.round(100 * u.context_used / u.context_window) : 0;
  const ctx = u.context_window
    ? `<div class="big">${fmtTok(u.context_window - u.context_used)} tokens left</div>
       <div class="bar"><i class="${pct > 70 ? 'warn' : ''}" style="width:${Math.max(1, pct)}%"></i></div>
       <div class="muted">${fmtTok(u.context_used)} / ${fmtTok(u.context_window)} used (${pct}%) by this deck's conversation</div>`
    : '<div class="muted">Ask a question to see how much of the context window this conversation uses.</div>';
  const lims = (u.limits || []).map((l) => {
    const p = Math.round(100 * (l.used || 0));
    return `<div class="lim"><div class="row"><span>${esc(l.label)}</span><span>${p}% used</span></div>
      <div class="bar"><i class="${p > 80 ? 'warn' : ''}" style="width:${Math.max(1, p)}%"></i></div><div class="muted">${resetText(l.resets_at)}</div></div>`;
  }).join('');
  pop.innerHTML = `<h4>Context window</h4>${ctx}<hr><h4>Plan usage · ${providerLabel()}</h4>${lims || '<div class="muted">Shown after your first question.</div>'}`;
  pop.hidden = false;
  placeAbove(pop, $('#ctxRing'));
}
$('#ctxRing').onclick = (e) => { e.stopPropagation(); $('#usagePop').hidden ? openUsage() : ($('#usagePop').hidden = true); };
window.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#modelMenu') && !e.target.closest('#modelBtn')) $('#modelMenu').hidden = true;
  if (!e.target.closest('#usagePop') && !e.target.closest('#ctxRing')) $('#usagePop').hidden = true;
});

$('#btnSettings').onclick = () => openSettings();
$('#storage').addEventListener('click', (e) => { const b = e.target.closest('[data-reveal]'); if (b) post('/api/reveal', { path: b.dataset.reveal, open: true }); });
$('#btnTrust').onclick = async () => {
  await post('/api/trust');
  toast('In System Settings → Privacy & Security → Accessibility, turn on "SlideMate AirDrop".', false, 9000);
  setTimeout(refreshTrust, 8000);
};
$('#settings').addEventListener('cancel', (e) => { if (document.body.classList.contains('first-run')) e.preventDefault(); });
$('#settings').addEventListener('close', async () => {
  if ($('#settings').returnValue !== 'ok') return;
  readModelFields();
  const firstRun = document.body.classList.contains('first-run');
  if (firstRun && !draft.library_roots.length) { toast('Choose your slides folder first', true); return openSettings(true); }
  cfg = await post('/api/config', {
    library_roots: draft.library_roots, provider: draft.provider, claude_model: draft.claude_model,
    claude_notes_model: draft.claude_notes_model, codex_model: draft.codex_model,
    ipad_name: $('#setIpad').value.trim(), airdrop: $('#setAirdrop').checked, copy_to_clipboard: $('#setClip').checked,
    sync_command: $('#setSyncMode').value === 'command' ? $('#setSync').value.trim() : '',
    sync_login_command: $('#setSyncMode').value === 'command' ? $('#setSyncLogin').value.trim() : '',
    sync_mcp: $('#setSyncMode').value === 'mcp' ? { server: $('#syncServer').value, tool: $('#syncTool').value, login_tool: $('#syncLoginTool').value } : { server: '', tool: '', login_tool: '' },
    write_markdown: $('#setMd').checked,
    setup_done: true,
  });
  document.body.classList.remove('first-run');
  toast(firstRun ? 'All set. Your courses are being organised.' : 'Settings saved');
  loadModels();
  loadLibrary();
  if (state.pdf) setCurrent(state.current);
});

// ---------- resizable panels ----------
const PANEL = {
  library: { v: '--lib-w', def: 272, min: 200, max: () => Math.min(560, innerWidth * 0.4) },
  chat: { v: '--chat-w', def: 400, min: 300, max: () => innerWidth * 0.65 },
};
function setPanelWidth(name, w, save = true) {
  const p = PANEL[name];
  w = Math.round(Math.max(p.min, Math.min(p.max(), w)));
  document.documentElement.style.setProperty(p.v, w + 'px');
  if (save) store.set('w:' + name, w);
}
for (const name of Object.keys(PANEL)) setPanelWidth(name, store.get('w:' + name, PANEL[name].def), false);
document.querySelectorAll('.resizer').forEach((r) => {
  const name = r.dataset.panel;
  r.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    r.setPointerCapture(e.pointerId);
    r.classList.add('dragging');
    document.body.classList.add('resizing');
    const panel = r.parentElement.getBoundingClientRect();
    const move = (ev) => setPanelWidth(name, name === 'library' ? ev.clientX - panel.left : panel.right - ev.clientX);
    const up = () => {
      r.removeEventListener('pointermove', move);
      r.classList.remove('dragging');
      document.body.classList.remove('resizing');
      refit();
    };
    r.addEventListener('pointermove', move);
    r.addEventListener('pointerup', up, { once: true });
  });
  r.addEventListener('dblclick', () => { setPanelWidth(name, PANEL[name].def); refit(); });
});

// ---------- text size (⌘+ / ⌘− / ⌘0) for the library and chat; slides keep their own zoom ----------
let uiZoom = store.get('uiZoom', 1);
function setUiZoom(z, announce = true) {
  uiZoom = Math.round(Math.max(0.8, Math.min(1.6, z)) * 10) / 10;
  document.documentElement.style.setProperty('--ui-zoom', uiZoom);
  store.set('uiZoom', uiZoom);
  if (announce) toast(`Text size ${Math.round(uiZoom * 100)}%`, false, 1200);
}
setUiZoom(uiZoom, false);
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  if (e.key === '=' || e.key === '+') { e.preventDefault(); setUiZoom(uiZoom + 0.1); }
  else if (e.key === '-' || e.key === '_') { e.preventDefault(); setUiZoom(uiZoom - 0.1); }
  else if (e.key === '0') { e.preventDefault(); setUiZoom(1); }
}, { capture: true });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { endSnip(); hideMenus(); return; }
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || $('#settings').open || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === 'l' || k === 'L') return toggleLib();
  if (!state.pdf) return;
  if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'j' || k === 'PageDown' || k === ' ') { e.preventDefault(); goTo(state.current + 1); }
  else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'k' || k === 'PageUp') { e.preventDefault(); goTo(state.current - 1); }
  else if (k === 'e') ask('Explain this slide.');
  else if (k === 's') sendSlide();
  else if (k === 'x') startSnip();
  else if (k === '/') { e.preventDefault(); showChat(); $('#askInput').focus(); }
  else if (k === 't') $('#btnChat').click();
  else if (k === 'n') setPanelTab(panelTab === 'notes' ? 'chat' : 'notes');
  else if (k === '+' || k === '=') $('#btnZoomIn').click();
  else if (k === '-') $('#btnZoomOut').click();
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('#dropOverlay').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('#dropOverlay').hidden = true;
  const f = [...e.dataTransfer.files].find((f) => f.name.toLowerCase().endsWith('.pdf'));
  if (!f) return toast('That is not a PDF', true);
  toast('Filing into your library…', false, 6000);
  const r = await (await api('/api/upload', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(f.name) }, body: f })).json();
  if (r.error) return toast(r.error, true);
  await loadLibrary();
  const it = lib.items.find((i) => i.path === r.path);
  toast(it ? `Filed under ${shortCourse(it.courseName)} / ${it.category || '…'}` : 'Added');
  openPdf(r.path);
});

// =====================================================================================
// Lecture capture: record → Parakeet transcript → Claude summary + per-slide notes
// =====================================================================================
const fmtT = (t) => { t = Math.max(0, Math.floor(t || 0)); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s).padStart(2, '0'); };
let rec = null;          // active recording
let lec = { list: [], cur: null, data: null, mode: store.get('notesMode', 'slide') };
let panelTab = store.get('panelTab', 'chat');

function audioTime() { return rec ? rec.acc + (rec.paused ? 0 : (performance.now() - rec.resumedAt) / 1000) : 0; }

async function startRecording() {
  if (!state.pdf) return toast('Open the lecture slides first');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 } });
  } catch (e) {
    return toast('Microphone blocked: allow it for SlideMate (click the icon in the address bar, or System Settings → Privacy → Microphone → Chrome).', true, 9000);
  }
  const { id } = await post('/api/lecture/start', { path: state.path, ext: MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus') ? 'webm' : 'mp4' });
  const webm = MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus');
  const recorder = new MediaRecorder(stream, { mimeType: webm ? 'audio/webm;codecs=opus' : 'audio/mp4', audioBitsPerSecond: 48000 });
  rec = { id, deck: state.path, recorder, stream, seq: -1, queue: [], events: [{ t: 0, slide: state.current, deck: state.path }],
          acc: 0, resumedAt: performance.now(), paused: false, pumping: false };
  recorder.ondataavailable = (e) => { if (e.data.size) { rec.queue.push({ seq: ++rec.seq, blob: e.data }); pump(); } };
  recorder.start(15000);
  rec.timer = setInterval(() => { $('#recTime').textContent = fmtT(audioTime()); }, 500);
  $('#btnRec').hidden = true; $('#recPill').hidden = false; $('#recPill').classList.remove('paused');
  setPanelTab('notes');
  await loadLectures(state.path, id);
  toast('Recording. Keep SlideMate open; slides you view are timestamped.', false, 5000);
}

async function pump() {
  if (!rec || rec.pumping) return;
  rec.pumping = true;
  const r = rec;
  try {
    while (r.queue.length) {
      const { seq, blob } = r.queue[0];
      let delay = 1000;
      for (;;) {
        try {
          const res = await api(`/api/lecture/chunk?id=${r.id}&seq=${seq}`, { method: 'POST', body: blob });
          if (res.ok || res.status === 409) break;
        } catch {}
        await new Promise((ok) => setTimeout(ok, delay));
        delay = Math.min(delay * 2, 30000);
      }
      r.queue.shift();
      if (r.events.length) {
        const ev = r.events.splice(0);
        post('/api/lecture/events', { id: r.id, events: ev }).catch(() => r.events.unshift(...ev));
      }
    }
  } finally { r.pumping = false; }
}

function onSlideChange(n) {
  if (rec && !rec.paused) rec.events.push({ t: Math.round(audioTime() * 10) / 10, slide: n, deck: state.path });
  if (panelTab === 'notes' && lec.mode === 'slide') renderNotes();
}

function togglePause() {
  if (!rec) return;
  if (rec.paused) { rec.recorder.resume(); rec.paused = false; rec.resumedAt = performance.now(); rec.events.push({ t: audioTime(), slide: state.current, deck: state.path }); }
  else { rec.acc = audioTime(); rec.recorder.pause(); rec.paused = true; }
  $('#recPill').classList.toggle('paused', rec.paused);
  $('#btnRecPause').innerHTML = `<svg><use href="#i-${rec.paused ? 'play' : 'pause'}"/></svg>`;
  $('#btnRecPause').title = rec.paused ? 'Resume' : 'Pause';
}

async function stopRecording() {
  if (!rec) return;
  if (!confirm('Stop recording and write your lecture notes?')) return;
  const r = rec;
  clearInterval(r.timer);
  await new Promise((ok) => { r.recorder.onstop = ok; r.recorder.stop(); });
  r.stream.getTracks().forEach((t) => t.stop());
  toast('Saving the recording…', false, 2500);
  while (r.queue.length || r.pumping) { await pump(); await new Promise((ok) => setTimeout(ok, 300)); }
  if (r.events.length) await post('/api/lecture/events', { id: r.id, events: r.events.splice(0) });
  await post('/api/lecture/stop', { id: r.id });
  rec = null;
  $('#btnRec').hidden = false; $('#recPill').hidden = true;
  $('#btnRecPause').innerHTML = '<svg><use href="#i-pause"/></svg>';
  setPanelTab('notes');
  loadLectures(r.deck, r.id);
}
$('#btnRec').onclick = startRecording;
$('#btnRecStop').onclick = stopRecording;
$('#btnRecPause').onclick = togglePause;
window.addEventListener('beforeunload', (e) => { if (rec) { e.preventDefault(); e.returnValue = ''; } });

// ---------- panel tabs ----------
function setPanelTab(tab) {
  panelTab = tab;
  store.set('panelTab', tab);
  document.body.classList.toggle('tab-notes', tab === 'notes');
  document.querySelectorAll('#panelTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  showChat();
  if (tab === 'notes') renderNotes();
}
$('#panelTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setPanelTab(b.dataset.tab); });
$('#notesMode').addEventListener('click', (e) => {
  const m = e.target.dataset.nmode;
  if (!m) return;
  lec.mode = m; store.set('notesMode', m);
  document.querySelectorAll('#notesMode button').forEach((b) => b.classList.toggle('on', b.dataset.nmode === m));
  renderNotes();
});
document.querySelectorAll('#notesMode button').forEach((b) => b.classList.toggle('on', b.dataset.nmode === lec.mode));

// ---------- loading lectures ----------
let lecPoll;
async function loadLectures(path, selectId) {
  clearTimeout(lecPoll);
  if (!path) return;
  lec.list = await (await api('/api/lectures?path=' + encodeURIComponent(path))).json();
  if (state.path !== path) return;
  const keep = selectId || (lec.cur && lec.list.some((l) => l.id === lec.cur) ? lec.cur : null);
  lec.cur = keep || lec.list.find((l) => l.status === 'done')?.id || lec.list[0]?.id || null;
  const pick = $('#lecturePick');
  pick.innerHTML = lec.list.map((l) => `<option value="${l.id}">${esc(l.date)} · ${l.source === 'imported' ? 'imported' : 'recorded'}${l.status !== 'done' ? ' · ' + l.status : ''}</option>`).join('');
  pick.value = lec.cur || '';
  pick.hidden = lec.list.length < 2;
  await loadLecture();
}
async function loadLecture() {
  clearTimeout(lecPoll);
  lec.data = lec.cur ? await (await api('/api/lecture?id=' + lec.cur)).json() : null;
  if (lecAudioFor !== lec.cur) { lecAudio.pause(); lecAudioFor = null; }
  renderNotes();
  markNoteSlides();
  const st = lec.data?.meta?.status;
  if (['recording', 'transcribing', 'writing'].includes(st)) {
    lecPoll = setTimeout(async () => {
      await loadLecture();
      if (lec.data?.meta?.status === 'done') { toast('Lecture notes are ready ✓', false, 5000); loadLectures(state.path, lec.cur); }
    }, st === 'recording' ? 10000 : 4000);
  }
}
$('#lecturePick').addEventListener('change', (e) => { lec.cur = e.target.value; loadLecture(); });

function markNoteSlides() {
  const slides = new Set(Object.keys(lec.data?.notes?.slides || {}).map(Number));
  state.pages.forEach((p, i) => p.div.querySelector('.num')?.classList.toggle('notes', slides.has(i + 1)));
}

// ---------- rendering notes ----------
function renderNotes() {
  const pane = $('#notesPane');
  if (panelTab !== 'notes') return;
  if (!state.path) { pane.innerHTML = ''; return; }
  const d = lec.data, m = d?.meta, st = m?.status;
  $('#notesMode').hidden = st !== 'done';
  if (!d) {
    pane.innerHTML = `<div class="state-card"><b>No lecture notes for this deck yet</b>
      Hit <b>Record</b> when the lecture starts. SlideMate transcribes it with Parakeet and Claude writes a summary plus notes for every slide, with the lecturer's exact words.
      <div class="actions"><button class="primary" data-na="rec"><span class="recdot"></span>Record lecture</button><button data-na="import">Import a transcript</button></div></div>`;
    return;
  }
  if (st === 'recording') {
    const lines = (d.live || []).slice(-30).map((s) => `<div class="live-line"><span class="ts">${fmtT(s.start)}</span>${esc(s.text)}</div>`).join('');
    pane.innerHTML = `<div class="state-card"><b><span class="recdot live" style="display:inline-block;margin:0 8px 0 0"></span>Recording in progress</b>
      Live transcript updates about every minute. Stop when the lecture ends and your notes get written.</div>
      <div style="margin-top:14px">${lines || '<div class="muted">Waiting for the first minute of audio…</div>'}</div>`;
    return;
  }
  if (st === 'transcribing' || st === 'writing') {
    pane.innerHTML = `<div class="state-card"><b><span class="spinner"></span>${st === 'transcribing' ? 'Transcribing the lecture…' : `${providerLabel()} is writing your notes…`}</b>
      ${st === 'transcribing' ? 'Parakeet is doing a full, accurate pass over the recording.' : 'Reading the whole deck and the transcript, then matching what was said to each slide. This takes a few minutes.'}
      You can keep using SlideMate.</div>`;
    return;
  }
  if (st === 'error') {
    pane.innerHTML = `<div class="state-card"><b>Couldn't finish these notes</b><span class="muted">${esc(m.error || '')}</span>
      <div class="actions"><button class="primary" data-na="regen">Try again</button></div></div>`;
    return;
  }
  const notes = d.notes || { slides: {}, summary_md: '' };
  if (lec.mode === 'summary') {
    pane.innerHTML = `<h2>${esc(m.deck_title)}</h2><div class="muted small" style="margin:-6px 0 10px">Lecture · ${esc(m.date)}${m.duration ? ' · ' + fmtT(m.duration) : ''}</div>${mdRender(notes.summary_md || '_No summary._')}`;
    return;
  }
  const n = state.current, s = notes.slides[String(n)];
  if (!s) {
    const covered = Object.keys(notes.slides).map(Number).sort((a, b) => a - b);
    const near = covered.sort((a, b) => Math.abs(a - n) - Math.abs(b - n)).slice(0, 6).sort((a, b) => a - b);
    pane.innerHTML = `<div class="note-empty"><b style="color:var(--text)">Slide ${n}</b><br>The lecturer didn't talk about this slide specifically.
      ${near.length ? `<div class="jump">${near.map((x) => `<button data-goto="${x}">Slide ${x}</button>`).join('')}</div>` : ''}</div>`;
    return;
  }
  const quotes = (s.quotes || []).map((q) => `<div class="quote">
      ${q.start != null && d.has_audio ? `<button class="play" data-t="${q.start}">${icon('play')}${fmtT(q.start)}</button>` : (q.start != null ? `<span class="muted small">${fmtT(q.start)}</span>` : '')}
      <blockquote>${esc(q.text)}</blockquote></div>`).join('');
  pane.innerHTML = `<h2>Slide ${n}: what the lecturer said</h2>${mdRender(s.notes_md || '')}
    ${quotes ? `<div class="said"><div class="lbl">Verbatim from the lecture</div>${quotes}</div>` : ''}`;
}
$('#notesPane').addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]'); if (g) return goTo(+g.dataset.goto);
  const p = e.target.closest('.play'); if (p) return playAt(+p.dataset.t, p);
  const a = e.target.closest('[data-na]')?.dataset.na;
  if (a === 'rec') startRecording();
  if (a === 'import') openImport();
  if (a === 'regen') regenNotes();
});

// ---------- audio playback of quotes ----------
const lecAudio = $('#lecAudio');
let lecAudioFor = null, playingBtn = null;
async function playAt(t, btn) {
  if (playingBtn === btn && !lecAudio.paused) { lecAudio.pause(); return; }
  if (lecAudioFor !== lec.cur) {
    toast('Loading audio…', false, 1500);
    const blob = await (await api('/api/lecture/audio?id=' + lec.cur)).blob();
    if (lecAudio.src) URL.revokeObjectURL(lecAudio.src);
    lecAudio.src = URL.createObjectURL(blob);
    lecAudioFor = lec.cur;
    await new Promise((ok) => { lecAudio.onloadedmetadata = ok; });
  }
  lecAudio.currentTime = Math.max(0, t - 1);
  lecAudio.play();
  playingBtn?.classList.remove('playing');
  playingBtn = btn; btn.classList.add('playing');
}
lecAudio.addEventListener('pause', () => playingBtn?.classList.remove('playing'));

// ---------- import / regenerate / menu ----------
function openImport() {
  if (!state.path) return toast('Open the lecture slides first');
  $('#importText').value = '';
  $('#importDate').value = new Date().toISOString().slice(0, 10);
  $('#importDlg').showModal();
}
$('#importDlg').addEventListener('close', async () => {
  if ($('#importDlg').returnValue !== 'ok') return;
  const text = $('#importText').value.trim();
  if (!text) return;
  const { id } = await post('/api/lecture/import', { path: state.path, text, date: $('#importDate').value });
  setPanelTab('notes');
  loadLectures(state.path, id);
});
async function regenNotes() {
  if (!lec.cur) return;
  await post('/api/lecture/regenerate', { id: lec.cur });
  loadLecture();
}
const notesMenu = $('#notesMenu');
$('#btnNotesMenu').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  notesMenu.hidden = false;
  notesMenu.style.left = Math.min(r.left, innerWidth - 240) + 'px';
  notesMenu.style.top = r.bottom + 6 + 'px';
};
notesMenu.addEventListener('click', (e) => {
  const a = e.target.closest('button')?.dataset.nm;
  notesMenu.hidden = true;
  if (a === 'import') openImport();
  if (a === 'regen') regenNotes();
  if (a === 'reveal') { const f = lec.data?.meta?.files?.summary; f ? post('/api/reveal', { path: f }) : toast('No notes written yet'); }
  if (a === 'delete' && lec.cur && confirm('Delete this lecture? Its recording, transcript and notes (including the Markdown files) are removed.')) {
    if (rec?.id === lec.cur) return toast('Stop the recording first', true);
    post('/api/lecture/delete', { id: lec.cur }).then(() => { lec.cur = null; loadLectures(state.path); });
  }
});
window.addEventListener('mousedown', (e) => { if (!e.target.closest('#notesMenu') && !e.target.closest('#btnNotesMenu')) notesMenu.hidden = true; });
setPanelTab(panelTab);

(async () => {
  cfg = await (await api('/api/config')).json();
  loadModels();
  await loadLibrary();
  if (!cfg.setup_done) openSettings(true);
  const params = new URLSearchParams(location.search);
  const file = params.get('file') || store.get('lastPath', null);
  if (file) openPdf(file, +params.get('page') || undefined);
  else setChatMode(state.chatMode);
  document.querySelectorAll('#chatMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.chatMode));
})();
