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
  chatMode: 'slide',  // 'all' is a temporary view: moving to another slide switches back (see setCurrent)
};

function toast(msg, err = false, ms = 3500) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
  return t;
}

// =====================================================================================
// Library
// =====================================================================================
let lib = { items: [], categories: [], sync: {}, inbox: 0, classifying: false, paths: {} };
let cardMap = new Map();  // deck path → its flashcard counts (see Flashcards)
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

function fileRow(i, extra = '') {
  const due = cardMap.get(i.path)?.counts.due;
  return `<button class="file${i.path === state.path ? ' active' : ''}" data-path="${esc(i.path)}" title="${esc(i.name)}">
      <span class="ttl">${extra}${esc(i.title)}</span>
      ${isNew(i) ? '<span class="new" title="New, not opened yet"></span>' : ''}
      ${i.hasChat ? icon('chat', 'has-chat') : ''}
      ${due ? `<span class="cards-due" title="${due} flashcard${due > 1 ? 's' : ''} due">${due}</span>` : ''}
      ${i.week != null ? `<span class="wk">W${i.week}</span>` : ''}
      <span class="more" data-fmenu="${esc(i.path)}" title="More">${icon('dots')}</span>
    </button>`;
}

function renderLibrary() {
  const q = $('#libSearch').value.trim().toLowerCase();
  const live = lib.items.filter((i) => !i.archived);
  const archived = lib.items.filter((i) => i.archived);
  const courses = [...new Set(live.map((i) => i.course))].sort((a, b) => (a === 'Unsorted') - (b === 'Unsorted') || a.localeCompare(b));
  renderChipsAndStatus(courses);
  let html = '';
  for (const course of courses) {
    if (hiddenCourses.has(course) && !q) continue;
    let items = live.filter((i) => i.course === course);
    if (q) items = items.filter((i) => (i.title + ' ' + i.name + ' ' + (i.category || '')).toLowerCase().includes(q));
    if (!items.length) continue;
    const cats = course === 'Unsorted'
      ? [...new Set(items.map((i) => i.category))].sort()
      : [...lib.categories.filter((c) => items.some((i) => i.category === c)), ...(items.some((i) => !i.category) ? [null] : [])];
    let catHtml = '';
    for (const cat of cats) {
      const its = sortItems(items.filter((i) => i.category === cat));
      if (cat === null) { catHtml += `<div class="sorting">${its.length} file${its.length > 1 ? 's' : ''} being sorted…</div>`; continue; }
      const files = its.map((i) => fileRow(i)).join('');
      catHtml += group(`${course}::${cat}`, `<span>${esc(cat)}</span><span class="count">${its.length}</span>`, files, 'cat');
    }
    const code = items[0].code || '';
    const title = course === 'Unsorted' ? 'Unsorted' : shortCourse(items[0].courseName || course);
    const head = `<span class="name">${esc(title)}</span>${code ? `<span class="code">${esc(code)}</span>` : ''}
      <span class="count">${items.length}</span><span class="focus" data-focus="${esc(course)}" title="Show only this course">${icon('focus')}</span>
      ${items[0].courseDir ? `<span class="more" data-cmenu="${esc(items[0].courseDir)}" title="More">${icon('dots')}</span>` : ''}`;
    html += group(course, head, catHtml, 'course');
  }
  // Archived: whole courses + single files, tucked away at the bottom (collapsed by default).
  let arch = archived;
  if (q) arch = arch.filter((i) => (i.title + ' ' + i.name + ' ' + i.courseName).toLowerCase().includes(q));
  if (arch.length) {
    const byCourse = {};
    arch.forEach((i) => (byCourse[i.course] ||= []).push(i));
    const archKids = Object.entries(byCourse).sort().map(([course, its]) => {
      const head = `<span class="name">${esc(shortCourse(its[0].courseName || course))}</span><span class="count">${its.length}</span>
        ${its[0].courseDir ? `<span class="more" data-cmenu="${esc(its[0].courseDir)}" data-archived="${lib.archivedCourses?.includes(its[0].courseDir) ? 1 : ''}" title="More">${icon('dots')}</span>` : ''}`;
      return group(`archived::${course}`, head, sortItems(its).map((i) => fileRow(i)).join(''), 'cat');
    }).join('');
    if (!collapsed.has('__archived_init')) { collapsed.add('__archived'); collapsed.add('__archived_init'); }
    html += group('__archived', `${icon('inbox')}<span class="name">Archived</span><span class="count">${arch.length}</span>`, archKids, 'course archived');
  }
  $('#libList').innerHTML = html || `<div class="sorting">No files${q ? ' match' : ''}.</div>`;
}

$('#libList').addEventListener('click', (e) => {
  const cm = e.target.closest('[data-cmenu]');
  if (cm) { e.stopPropagation(); return openCourseMenu(cm.dataset.cmenu, cm); }
  const fm = e.target.closest('[data-fmenu]');
  if (fm) { e.stopPropagation(); const r = fm.getBoundingClientRect(); return openFileMenu(fm.dataset.fmenu, r.right - 220, r.bottom + 4); }
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
function showLibMenu(x, y) {
  libMenu.hidden = false;
  libMenu.style.left = Math.max(8, Math.min(x, innerWidth - libMenu.offsetWidth - 8)) + 'px';
  libMenu.style.top = Math.max(8, Math.min(y, innerHeight - libMenu.offsetHeight - 8)) + 'px';
}
function openFileMenu(path, x, y) {
  const item = lib.items.find((i) => i.path === path);
  if (!item) return;
  const cats = item.course === 'Unsorted' || item.archived ? [] : lib.categories;
  const courseArchived = item.archived && !lib.archivedPaths?.includes(item.path);
  libMenu.innerHTML = (cats.length ? `<div class="label">Move to</div>` + cats.map((c) =>
    `<button data-cat="${esc(c)}" class="${c === item.category ? 'checked' : ''}">${esc(c)}</button>`).join('') + '<hr>' : '') +
    `<button data-lib="rename">${icon('edit')}Rename…</button>` +
    (courseArchived ? '' : `<button data-lib="${item.archived ? 'unarchive' : 'archive'}">${icon('inbox')}${item.archived ? 'Unarchive' : 'Archive'}</button>`) +
    `<button data-lib="reveal">${icon('folder')}Show in Finder</button><hr>` +
    `<button data-lib="trash" class="danger">${icon('stop')}Move to Trash…</button>`;
  libMenu.dataset.path = item.path;
  libMenu.dataset.kind = 'file';
  showLibMenu(x, y);
}
function openCourseMenu(dir, anchor) {
  const isArch = (lib.archivedCourses || []).includes(dir);
  libMenu.innerHTML = `<div class="label">Course</div>
    <button data-lib="rename">${icon('edit')}Rename…</button>
    <button data-lib="${isArch ? 'unarchive' : 'archive'}">${icon('inbox')}${isArch ? 'Unarchive course' : 'Archive course'}</button>
    <button data-lib="reveal">${icon('folder')}Show in Finder</button><hr>
    <button data-lib="trash" class="danger">${icon('stop')}Move course to Trash…</button>`;
  libMenu.dataset.path = dir;
  libMenu.dataset.kind = 'course';
  const r = anchor.getBoundingClientRect();
  showLibMenu(r.right - 220, r.bottom + 4);
}
$('#libList').addEventListener('contextmenu', (e) => {
  const f = e.target.closest('.file');
  if (f) { e.preventDefault(); return openFileMenu(f.dataset.path, e.clientX, e.clientY); }
  const c = e.target.closest('.course > .row-head [data-cmenu]') || e.target.closest('.course')?.querySelector(':scope > .row-head [data-cmenu]');
  if (c && e.target.closest('.row-head')) { e.preventDefault(); openCourseMenu(c.dataset.cmenu, c); }
});
libMenu.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const path = libMenu.dataset.path;
  libMenu.hidden = true;
  const kind = libMenu.dataset.kind, act = b.dataset.lib;
  const name = kind === 'course' ? (lib.items.find((i) => i.courseDir === path)?.courseName || path.split('/').pop())
    : (lib.items.find((i) => i.path === path)?.title || path.split('/').pop());
  const manage = async (action, extra = {}) => {
    const r = await post('/api/library/manage', { target: path, action, ...extra });
    if (r.error) toast(r.error, true);
    return !r.error;
  };
  if (b.dataset.cat) await post('/api/library/set', { path, category: b.dataset.cat });
  if (act === 'rename') {
    const t = prompt(kind === 'course' ? 'Course name (shown in SlideMate only; the folder isn\'t renamed)' : 'Display name', name);
    if (t != null) await manage('rename', { title: t.trim() });
  }
  if (act === 'archive' && await manage('archive')) toast(`Archived "${name}". Find it under Archived at the bottom.`);
  if (act === 'unarchive' && await manage('unarchive')) toast(`"${name}" is back in your library`);
  if (act === 'reveal') return post('/api/reveal', { path });
  if (act === 'trash') {
    const what = kind === 'course' ? `the whole "${name}" course folder and everything in it` : `"${name}"`;
    if (confirm(`Move ${what} to the Trash?\n\nYou can restore it from the Trash in Finder. Archive is the safer option if you just want it out of the way.`)) {
      if (await manage('trash')) toast(`Moved "${name}" to the Trash`);
    }
  }
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
    find.reset(); $('#findBar').hidden = true;
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
    loadDeckCards(path);
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
  visible.clear();  // stale entries from the previous deck/zoom (e.g. slide 45 of a longer deck) broke slide tracking
  if (observer) observer.disconnect();
  const first = await state.pdf.getPage(1);
  const vp1 = first.getViewport({ scale: 1 });
  state.base = { w: vp1.width, h: vp1.height };
  if (state.fit || !state.scale) state.scale = fitScale();
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
  syncGutter();
}
// "Fit" = the whole slide fits on screen, so there's always one clear current slide. Only a thin gutter is
// kept around it (room for the current-slide ring), so the slide gets as much of the screen as possible.
const FIT_GUTTER_X = 16, FIT_GUTTER_Y = 24;
const fitScale = () => Math.min((viewer.clientWidth - FIT_GUTTER_X) / state.base.w, (viewer.clientHeight - FIT_GUTTER_Y) / state.base.h);
// The slide number sits in the margin left of each slide; when there's no room for it there (Fit, or zoomed in),
// it moves inside the slide's top-left corner as a small badge.
function syncGutter() {
  const w = state.pages[0] ? parseFloat(state.pages[0].div.style.width) : 0;
  viewer.classList.toggle('tight', (viewer.clientWidth - w) / 2 < 44);
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
    if (!state.pages[n - 1]) continue;
    const r = state.pages[n - 1].div.getBoundingClientRect();
    const seen = Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top);
    const dist = Math.abs((r.top + r.bottom) / 2 - focus);
    if (seen > best + 2 || (Math.abs(seen - best) <= 2 && dist < bestDist)) { best = Math.max(seen, best); bestDist = dist; cur = n; }
  }
  if (best > 0 && performance.now() > (state.pinUntil || 0)) setCurrent(cur);
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
  if (changed && !state.busy) {
    // The chat follows the slide you're on. "All slides" is for browsing: scrolling to another slide brings back
    // that slide's chat, unless you got there by clicking a slide link inside the chat (then keep reading).
    if (state.chatMode === 'all' && performance.now() > (state.keepAllUntil || 0)) setChatMode('slide');
    else if (state.chatMode === 'slide') renderChat();
  }
  if (changed) onSlideChange(n);
}

async function renderPage(n) {
  const p = state.pages[n - 1];
  if (!p || p.rendered === state.scale || pinch.active) return;
  p.rendered = state.scale;
  const page = await state.pdf.getPage(n);
  const vp = page.getViewport({ scale: state.scale });
  // Very deep zoom: cap the canvas size (WebKit refuses canvases over ~16M pixels).
  const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(16e6 / (vp.width * vp.height)));
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width * dpr); c.height = Math.floor(vp.height * dpr);
  p.div.style.width = vp.width + 'px'; p.div.style.height = vp.height + 'px';
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
  if (p.rendered !== state.scale) return;  // zoom changed while rendering
  p.div.querySelector('canvas')?.remove();
  p.div.prepend(c);
  // Invisible, selectable text over the slide image (what makes text highlightable, copyable and findable).
  p.div.style.setProperty('--scale-factor', vp.scale);
  const tl = document.createElement('div');
  tl.className = 'textLayer';
  const layer = new pdfjsLib.TextLayer({ textContentSource: await page.getTextContent(), container: tl, viewport: vp });
  await layer.render();
  if (p.rendered !== state.scale) return;
  p.div.querySelector('.textLayer')?.remove();
  p.div.append(tl);
  p.textDivs = layer.textDivs;
  p.itemsStr = layer.textContentItemsStr;
  find.paintPage(n);
}

function goTo(n, smooth = true) {
  if (!state.pdf) return;
  n = Math.max(1, Math.min(state.pdf.numPages, n));
  const d = state.pages[n - 1].div;  // scroll the viewer itself (scrollIntoView can also shift the window)
  viewer.scrollTo({ top: d.offsetTop - (viewer.clientHeight - d.offsetHeight) / 2, behavior: smooth ? 'smooth' : 'instant' });
  state.pinUntil = performance.now() + (smooth ? 900 : 150);  // a jump wins over scroll tracking (e.g. slide 2 can't be centred)
  setCurrent(n);
}

async function setZoom(scale, fit = false) {
  const cur = state.current;
  state.fit = fit;
  state.scale = fit ? null : scale;
  await buildPages();
  goTo(cur, false);
}
// Trackpad pinch: zoom live around the cursor (like Photoshop), then re-render sharp when the fingers lift.
// WebKit (the Mac app) sends gesture* events; Chromium sends ctrl+wheel.
const ZOOM_MIN = 0.2, ZOOM_MAX = 8;
const pinch = { active: false, base: 1, t: 0 };
function zoomAround(scale, cx, cy) {
  if (!state.pdf || !state.pages.length) return;
  scale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale));
  const old = state.scale;
  if (!old || Math.abs(scale - old) < 1e-4) return;
  // The point under the cursor: which slide, and where on it.
  const vr = viewer.getBoundingClientRect();
  let anchor = null;
  for (const n of [...visible.keys(), state.current]) {
    const r = state.pages[n - 1]?.div.getBoundingClientRect();
    if (r && cy >= r.top - 10 && cy <= r.bottom + 10) { anchor = { n, fx: (cx - r.left) / r.width, fy: (cy - r.top) / r.height }; break; }
  }
  anchor ||= { n: state.current, fx: 0.5, fy: 0.5 };
  rescaleInPlace(scale);
  state.fit = false;
  const d = state.pages[anchor.n - 1].div;
  viewer.scrollLeft = d.offsetLeft + anchor.fx * d.offsetWidth - (cx - vr.left);
  viewer.scrollTop = d.offsetTop + anchor.fy * d.offsetHeight - (cy - vr.top);
}
// Resize every slide in place; the existing canvases stretch until they're re-rendered (no white flash).
function rescaleInPlace(scale) {
  const k = scale / state.scale;
  for (const p of state.pages) {
    p.div.style.width = parseFloat(p.div.style.width) * k + 'px';
    p.div.style.height = parseFloat(p.div.style.height) * k + 'px';
    if (p.div.style.getPropertyValue('--scale-factor')) p.div.style.setProperty('--scale-factor', scale);
  }
  state.scale = scale;
  syncGutter();
}
// Fit mode while a panel is dragged or the window resized: refit the slides every frame, live (like Claude's
// panels), keeping the current slide where it sits; they re-render sharp once the resizing stops.
function fitNow() {
  if (!state.pdf || !state.fit || !state.pages.length || !state.base) return;
  const s = fitScale();
  if (!(s > 0) || Math.abs(s - state.scale) < 1e-4) return;
  const d = state.pages[state.current - 1].div, vr = viewer.getBoundingClientRect(), r = d.getBoundingClientRect();
  const frac = (r.top + r.height / 2 - vr.top) / viewer.clientHeight;  // where the current slide's middle sits
  pinch.active = true;  // no re-rendering mid-resize
  state.pinUntil = performance.now() + 400;  // and the current slide stays the current slide
  rescaleInPlace(s);
  viewer.scrollTop = d.offsetTop + d.offsetHeight / 2 - frac * viewer.clientHeight;
}
let fitRaf = 0, fitEndT = 0;
function liveFit(settle = 180) {
  cancelAnimationFrame(fitRaf);
  fitRaf = requestAnimationFrame(fitNow);
  clearTimeout(fitEndT);
  fitEndT = setTimeout(() => { fitNow(); if (pinch.active) endPinch(); }, settle);
}
function endPinch() {
  pinch.active = false;
  for (const n of visible.keys()) { renderPage(n); renderPage(n + 1); }
}
viewer.addEventListener('gesturestart', (e) => { e.preventDefault(); pinch.active = true; pinch.base = state.scale; });
viewer.addEventListener('gesturechange', (e) => { e.preventDefault(); zoomAround(pinch.base * e.scale, e.clientX, e.clientY); });
viewer.addEventListener('gestureend', (e) => { e.preventDefault(); endPinch(); });
viewer.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;  // a pinch (not ⌘+scroll)
  e.preventDefault();
  pinch.active = true;
  zoomAround(state.scale * Math.exp(-e.deltaY / 100), e.clientX, e.clientY);
  clearTimeout(pinch.t);
  pinch.t = setTimeout(endPinch, 160);
}, { passive: false });

$('#btnPrev').onclick = () => goTo(state.current - 1);
$('#btnNext').onclick = () => goTo(state.current + 1);
$('#btnZoomIn').onclick = () => setZoom(state.scale * 1.2);
$('#btnZoomOut').onclick = () => setZoom(state.scale / 1.2);
$('#btnFit').onclick = () => setZoom(null, true);
window.addEventListener('resize', () => { liveFit(); syncGutter(); });

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
  // Finding the iPad can take several seconds, so keep this up until the server answers.
  const pending = toast(cfg.airdrop ? 'Looking for your iPad…' : 'Sending to iPad…', false, 40000);
  try {
    const r = await post('/api/send', { image: dataUrl, name: label }).finally(() => pending.remove());
    const ad = r.airdrop;
    const clip = r.clipboard ? ' Also on your clipboard.' : '';
    if (!ad) toast('Copied.' + clip);
    else if (ad.state === 'clicked') {
      toast(`AirDropping to ${ad.device} ✓` + (ad.renamed ? ` (saved that spelling of its name in Settings)` : '') + clip);
      if (ad.renamed) cfg.ipad_name = ad.device;
    } else if (ad.state === 'notfound') toast(ad.nearby?.length
      ? `Couldn't find "${ad.device}". AirDrop shows ${ad.nearby.map((n) => `"${n}"`).join(', ')}: put that name in Settings → Send to iPad. The slide is saved.` + clip
      : `Couldn't find "${ad.device}". Is it on and unlocked? The slide is saved.` + clip, true, 9000);
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

// ---------- snip (a slide area, or part of the chat panel) ----------
const snipLayer = $('#snipLayer'), chatSnipLayer = $('#chatSnipLayer'), snipRect = $('#snipRect'), snipMenu = $('#snipMenu');
let snip = null, pendingSnip = null;
function startSnip() {
  if (!state.pdf) return;
  hideMenus();
  snipLayer.hidden = chatSnipLayer.hidden = false; snipRect.style.display = 'none'; snip = null;
}
function endSnip() { snipLayer.hidden = chatSnipLayer.hidden = true; snipMenu.hidden = true; snip = null; }
$('#btnSnip').onclick = startSnip;
snipLayer.addEventListener('mousedown', (e) => {
  snipMenu.hidden = true;
  snipLayer.style.pointerEvents = 'none';
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.page');
  snipLayer.style.pointerEvents = '';
  if (!el) return;
  snipLayer.append(snipRect);
  $('#viewerWrap').append(snipMenu);
  const wrap = $('#viewerWrap').getBoundingClientRect();
  snip = { kind: 'slide', page: +el.dataset.page, pr: el.getBoundingClientRect(), x0: e.clientX, y0: e.clientY, wrap };
  Object.assign(snipRect.style, { display: 'block', left: e.clientX - wrap.left + 'px', top: e.clientY - wrap.top + 'px', width: 0, height: 0 });
});
chatSnipLayer.addEventListener('mousedown', (e) => {
  snipMenu.hidden = true;
  chatSnipLayer.append(snipRect);
  $('#chat').append(snipMenu);
  const wrap = $('#chat').getBoundingClientRect();
  snip = { kind: 'chat', pr: wrap, x0: e.clientX, y0: e.clientY, wrap };
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
  snipMenu.querySelector('[data-snip="ask"]').hidden = snip.kind === 'chat';
  snipMenu.hidden = false;
  snipMenu.style.left = Math.max(8, Math.min(Math.max(snip.x0, snip.x1) - wrap.left - snipMenu.offsetWidth, wrap.width - snipMenu.offsetWidth - 8)) + 'px';
  snipMenu.style.top = Math.min(Math.max(snip.y0, snip.y1) - wrap.top + 8, wrap.height - 50) + 'px';
});
snipMenu.addEventListener('mousedown', (e) => e.stopPropagation());
snipMenu.addEventListener('click', async (e) => {
  const act = e.target.closest('button')?.dataset.snip;
  if (!act || !snip) return;
  const { kind, page, crop, x0, y0, x1, y1 } = snip;
  endSnip();
  if (kind === 'chat') {
    if (act !== 'send') return;
    const img = await snapshotRegion(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    if (img) sendToIpad(img, `${state.name} chat snip`);
    return;
  }
  if (act === 'send') sendToIpad(await renderImage(page, { crop, width: 2000 }), `${state.name} p${page} snip`);
  if (act === 'ask') {
    pendingSnip = { page, img: await renderImage(page, { crop, width: 1200, type: 'image/jpeg', quality: 0.88 }) };
    showChat();
    updatePlaceholder();
    $('#askInput').focus();
  }
});

// The chat isn't a PDF we can re-render, so a chat snip is a screenshot of that part of the window, taken by the Mac app.
async function snapshotRegion(x, y, w, h) {
  const native = window.webkit?.messageHandlers?.slidemate;
  if (!native) { toast('Snipping the chat works in the SlideMate app', true); return null; }
  await new Promise((ok) => setTimeout(ok, 60));  // let the snip overlay disappear first (the app waits for the repaint)
  const img = await new Promise((done) => {
    const timer = setTimeout(() => done(null), 8000);
    window.__slidemateSnapshot = (url) => { clearTimeout(timer); done(url); };
    native.postMessage({ action: 'snapshot', x, y, w, h });
  });
  if (!img) toast("Couldn't capture that part of the chat", true);
  return img;
}

// ---------- slide context menu ----------
const ctx = $('#ctxMenu');
let ctxPage = null, ctxSelection = '';
viewer.addEventListener('contextmenu', (e) => {
  const el = e.target.closest('.page');
  if (!el) return;
  e.preventDefault();
  ctxPage = +el.dataset.page;
  setCurrent(ctxPage);
  ctxSelection = String(window.getSelection() || '').trim().slice(0, 600);
  ctx.querySelector('[data-act="asksel"]').hidden = !ctxSelection;
  ctx.querySelector('[data-act="copysel"]').hidden = !ctxSelection;
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
  if (act === 'asksel') ask(`Explain this part of the slide: "${ctxSelection}"`);
  if (act === 'copysel') { navigator.clipboard.writeText(ctxSelection); toast('Copied'); }
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
function mdRender(text, links = true) {
  const math = [];
  const stash = (tex, display) => { math.push({ tex, display }); return `@@M${math.length - 1}@@`; };
  const t = text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => stash(m, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => stash(m, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => stash(m, false))
    .replace(/(^|[^\\$\w])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?![\w$])/g, (_, pre, m) => pre + stash(m, false));
  const html = marked.parse(t, { gfm: true }).replace(/@@M(\d+)@@/g, (_, i) => {
    const { tex, display } = math[+i];
    try { return katex.renderToString(tex, { displayMode: display, throwOnError: false }); } catch { return esc(tex); }
  });
  return links ? linkSlides(html) : html;
}

// "slide 26" / "slides 24–28" / "slides 7 and 9" in answers and notes → links (hover to preview, click to go).
const SLIDE_RE = /\b(slides?)(\s+)(\d{1,3}(?:\s*(?:,|–|—|-|to|and|&|or)\s*\d{1,3})*)/gi;
function linkSlides(html) {
  const max = state.pdf?.numPages || 0;
  if (!max || !/slide/i.test(html)) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('code, pre, a, .katex') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const link = (n, label) => { const el = document.createElement('a'); el.className = 'slide-ref'; el.dataset.slide = n; el.textContent = label; return el; };
  for (const node of nodes) {
    const text = node.nodeValue;
    SLIDE_RE.lastIndex = 0;
    if (!SLIDE_RE.test(text)) continue;
    SLIDE_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = SLIDE_RE.exec(text))) {
      frag.append(text.slice(last, m.index));
      const nums = m[3];
      if (/^\d+$/.test(nums)) {  // single slide: link the whole "slide 26"
        frag.append(+nums >= 1 && +nums <= max ? link(nums, m[1] + m[2] + nums) : m[0]);
      } else {                     // a list or range: link each number
        frag.append(m[1] + m[2]);
        nums.split(/(\d{1,3})/).forEach((part) => frag.append(/^\d+$/.test(part) && +part >= 1 && +part <= max ? link(part, part) : part));
      }
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  return tpl.innerHTML;
}

// Hover preview of a referenced slide.
const peek = { el: null, t: 0, cache: new Map(), cur: null };
function peekEl() {
  if (!peek.el) {
    peek.el = document.createElement('div');
    peek.el.id = 'slidePeek';
    peek.el.hidden = true;
    peek.el.innerHTML = '<img alt=""><div class="cap"></div>';
    document.body.append(peek.el);
  }
  return peek.el;
}
async function showPeek(a) {
  const n = +a.dataset.slide, el = peekEl(), key = state.path + '#' + n;
  peek.cur = a;
  el.querySelector('.cap').textContent = `Slide ${n}${n === state.current ? ' (you are here)' : ''} · click to open`;
  if (!peek.cache.has(key)) peek.cache.set(key, renderImage(n, { width: 520, type: 'image/jpeg', quality: 0.82 }));
  const src = await peek.cache.get(key);
  if (peek.cur !== a) return;
  // The chat re-renders while an answer streams in, replacing the link under the mouse. A detached link has
  // no position (the preview would pin to the top-left) and never gets a mouseout, so the preview would stick.
  if (!a.isConnected) return hidePeek();
  el.querySelector('img').src = src;
  el.hidden = false;
  const r = a.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8)) + 'px';
  el.style.top = (r.top - h - 8 > 8 ? r.top - h - 8 : r.bottom + 8) + 'px';
}
function hidePeek() { peek.cur = null; clearTimeout(peek.t); if (peek.el) peek.el.hidden = true; }
document.addEventListener('mouseover', (e) => {
  const a = e.target.closest?.('.slide-ref');
  if (!a) { if (peek.cur) hidePeek(); return; }  // over anything else: no preview (catches links that were replaced)
  if (a === peek.cur) return;
  clearTimeout(peek.t);
  peek.t = setTimeout(() => showPeek(a), 120);
});
document.addEventListener('mouseout', (e) => { if (e.target.closest?.('.slide-ref') && !e.relatedTarget?.closest?.('.slide-ref')) hidePeek(); });
document.addEventListener('scroll', hidePeek, true);  // the link moved out from under the preview
window.addEventListener('blur', hidePeek);
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('.slide-ref');
  if (!a) return;
  e.preventDefault();
  hidePeek();
  if (a.closest('#messages')) state.keepAllUntil = performance.now() + 1500;
  goTo(+a.dataset.slide);
});

// Copying from chat / notes: maths comes out once, as LaTeX ($\hat y$), not duplicated by KaTeX's hidden MathML.
function copyCleanMath(e) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const frag = sel.getRangeAt(0).cloneContents();
  if (!frag.querySelector('.katex, .katex-mathml, .katex-html')) return;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-99999px;top:0;white-space:pre-wrap';
  box.append(frag);
  box.querySelectorAll('.katex-display, .katex').forEach((k) => {
    if (!k.isConnected && !box.contains(k)) return;
    const tex = k.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (tex) k.replaceWith(k.classList.contains('katex-display') ? `$$${tex}$$` : `$${tex}$`);
  });
  box.querySelectorAll('.katex-mathml').forEach((x) => x.remove());
  document.body.append(box);
  e.clipboardData.setData('text/plain', box.innerText.trim());
  box.remove();
  e.preventDefault();
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
    if (m.images?.length) {
      const pics = document.createElement('div');
      pics.className = 'pics';
      for (const src of m.images) {
        const i = new Image();
        i.alt = 'Attached picture';
        if (src.startsWith('data:')) i.src = src;
        else chatPic(src).then((u) => { i.src = u; }, () => i.remove());
        pics.append(i);
      }
      d.append(pics);
    }
  } else d.innerHTML = mdRender(m.text || '');
  return d;
}
$('#messages').addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) { state.keepAllUntil = performance.now() + 1500; return goTo(+g.dataset.goto); }
  const pic = e.target.closest('.pics img');
  if (pic?.src) { $('#picViewImg').src = pic.src; $('#picView').showModal(); }
});
// Saved pictures need the X-SlideMate header, so fetch them and show as blob URLs.
const picCache = new Map();
function chatPic(name) {
  if (!picCache.has(name)) {
    picCache.set(name, api('/api/chat-image?name=' + encodeURIComponent(name))
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('missing'))))
      .then((b) => URL.createObjectURL(b)));
  }
  return picCache.get(name);
}
$('#picView').addEventListener('click', () => $('#picView').close());

// ---------- attached pictures (e.g. photos of handwritten notes): drop, paste or 📎 ----------
const MAX_PICS = 10;
let pendingPics = [];  // [{id, name, url (JPEG data URL once read), ready (Promise)}]
const isImageFile = (f) => f.type.startsWith('image/') || /\.(heic|heif|png|jpe?g|gif|webp|tiff?|bmp)$/i.test(f.name);

// Downscale to what the AI actually looks at (~1568px long side), so big phone photos upload fast.
async function downscale(file, maxSide = 1568) {
  const bmp = await createImageBitmap(file);  // throws for formats the web view can't decode
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';  // transparent PNGs become white, not black
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL('image/jpeg', 0.88);
}
async function readPicture(file) {
  try { return await downscale(file); } catch {}
  const r = await (await api('/api/convert-image', { method: 'POST', body: file })).json();  // macOS converts it
  if (r.error) throw new Error(r.error);
  return r.image;
}

function addPictures(files) {
  const imgs = [...files].filter(isImageFile);
  if (!imgs.length) return;
  if (!state.pdf) return toast('Open the lecture slides first, then add your pictures', true);
  const room = MAX_PICS - pendingPics.length;
  if (room <= 0) return toast(`Up to ${MAX_PICS} pictures per question`, true);
  if (imgs.length > room) toast(`Attached the first ${room}: max ${MAX_PICS} pictures per question`, true);
  if (panelTab !== 'chat') setPanelTab('chat');
  showChat();
  for (const f of imgs.slice(0, room)) {
    const pic = { id: Math.random().toString(36).slice(2), name: f.name, url: null };
    pic.ready = readPicture(f)
      .then((u) => { pic.url = u; })
      .catch((e) => { toast(`Couldn't read ${f.name}: ${e.message}`, true); pendingPics = pendingPics.filter((p) => p !== pic); })
      .finally(renderTray);
    pendingPics.push(pic);
  }
  renderTray();
  $('#askInput').focus();
}
function renderTray() {
  const tray = $('#attachTray');
  tray.hidden = !pendingPics.length;
  tray.innerHTML = pendingPics.map((p) => `<div class="att${p.url ? '' : ' loading'}" title="${esc(p.name)}">
    ${p.url ? `<img src="${p.url}" alt="">` : ''}<button type="button" data-rm="${p.id}" title="Remove">${icon('x')}</button></div>`).join('');
  updatePlaceholder();
}
function updatePlaceholder() {
  const n = pendingPics.length;
  $('#askInput').placeholder = pendingSnip ? `Ask about the snipped area of slide ${pendingSnip.page}`
    : n ? `Ask about your picture${n > 1 ? 's' : ''}` : 'Ask about this slide';
}
$('#attachTray').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rm]');
  if (b) { pendingPics = pendingPics.filter((p) => p.id !== b.dataset.rm); renderTray(); }
});
$('#btnAttach').onclick = () => $('#attachInput').click();
$('#attachInput').addEventListener('change', (e) => { addPictures(e.target.files); e.target.value = ''; });
$('#askInput').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.some(isImageFile)) { e.preventDefault(); addPictures(files); }
});

$('#messages').addEventListener('copy', copyCleanMath);
$('#notesPane').addEventListener('copy', copyCleanMath);

async function ask(question) {
  if (!state.pdf) return;
  if (!question.trim()) {
    if (!pendingPics.length) return;
    question = 'Read my notes in the attached picture' + (pendingPics.length > 1 ? 's' : '') + ' and help me understand them.';
  }
  if (state.busy) return toast('Still answering. Press ■ Stop (or Esc) to cancel it.');
  state.busy = true;
  state.abort = new AbortController();
  setStopMode(true);
  try { await askInner(question); } catch (e) { if (e.name !== 'AbortError') toast('Error: ' + e.message, true); }
  finally { state.busy = false; state.abort = null; setStopMode(false); }
}
// While an answer is running, the send button turns into Stop.
function setStopMode(on) {
  const b = $('#askForm .send');
  b.classList.toggle('stop', on);
  b.title = on ? 'Stop (Esc)' : 'Send (Enter)';
  b.innerHTML = `<svg><use href="#i-${on ? 'stop' : 'up'}"/></svg>`;
}
async function stopAnswer() {
  if (!state.busy) return;
  const path = state.path;
  state.stopping = true;
  post('/api/stop', { path }).catch(() => {});
  state.abort?.abort();
}
async function askInner(question) {
  showChat();
  const path = state.path, total = state.pdf.numPages;
  const snipNow = pendingSnip;
  const picsNow = pendingPics;
  pendingSnip = null;
  pendingPics = [];
  renderTray();
  await Promise.all(picsNow.map((p) => p.ready));
  const attachments = picsNow.filter((p) => p.url).map((p) => p.url);
  const page = snipNow?.page || state.current;
  const image = snipNow ? snipNow.img : await renderImage(page, { width: 1400, type: 'image/jpeg', quality: 0.85 });
  const fullQ = snipNow ? `(The attached image is a snipped area of slide ${page}, not the whole slide.)\n\n${question}` : question;
  if (state.chatMode === 'slide' && page !== state.current) setChatMode('all');
  const msgs = chatFor(path);
  msgs.push({ role: 'user', text: question, slide: page, ts: Date.now() / 1000, snip: !!snipNow, image: snipNow?.img, images: attachments });
  const bot = { role: 'bot', text: '', slide: page, ts: Date.now() / 1000 };
  msgs.push(bot);
  renderChat();
  markChattedSlides();
  const box = $('#messages');
  bot._el.classList.add('thinking');
  const t0 = Date.now();
  const tick = setInterval(() => {  // live "Thinking it through… · 12s" so you can see it's alive
    if (!bot.text && bot._el?.isConnected) bot._el.dataset.status = `${bot.status || 'Thinking'} · ${Math.round((Date.now() - t0) / 1000)}s`;
  }, 1000);
  state.stopping = false;
  try {
    const res = await api('/api/chat', { method: 'POST', signal: state.abort?.signal, body: JSON.stringify({ path, page, total, question: fullQ, display: question, snip: !!snipNow, image, attachments }) });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', raf = 0;
    const paint = () => {
      raf = 0;
      if (state.path !== path || !bot._el?.isConnected) return;
      if (!bot.text) { bot._el.dataset.status = `${bot.status || 'Thinking'} · ${Math.round((Date.now() - t0) / 1000)}s`; return; }
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
    if (e.name === 'AbortError' || state.stopping) {
      bot.text = bot.text.trim() ? bot.text.trimEnd() + '\n\n_(stopped)_' : '_Stopped before answering._';
    } else {
      bot.text += `\n\n**Error:** ${e.message}`;
    }
    bot.status = null;
    if (bot._el) bot._el.innerHTML = mdRender(bot.text);
  } finally {
    clearInterval(tick);
    bot._el?.classList.remove('thinking');
  }
}

$('#askForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.busy) {  // the button is "Stop" while answering; Enter shouldn't cancel by accident
    return e.submitter ? stopAnswer() : toast('Still answering. Press ■ Stop (or Esc) to cancel it.');
  }
  const v = $('#askInput').value;
  $('#askInput').value = '';
  autosize();
  ask(v);
});
// Grow the box with its text; only show a scrollbar once it hits the max height. (With ⌘+ text zoom,
// WebKit can report the content a few px taller than the box, which used to show a pointless scrollbar.)
const ASK_MAX = 180;
const autosize = () => {
  const t = $('#askInput');
  t.style.height = 'auto';
  const h = t.scrollHeight;
  t.style.height = Math.min(h + 2, ASK_MAX) + 'px';
  t.style.overflowY = h > ASK_MAX ? 'auto' : 'hidden';
};
$('#askInput').addEventListener('input', autosize);
$('#askInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#askForm').requestSubmit(); }
  if (e.key === 'Escape') { pendingSnip = null; updatePlaceholder(); e.target.blur(); }
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
function refit() { if (state.pdf && state.fit) liveFit(0); syncGutter(); }
function toggleLib() { document.body.classList.toggle('lib-hidden'); store.set('libHidden', document.body.classList.contains('lib-hidden')); refit(); }
$('#btnChat').onclick = () => { document.body.classList.toggle('chat-hidden'); store.set('chatHidden', document.body.classList.contains('chat-hidden')); refit(); };
$('#btnLibrary').onclick = toggleLib;
$('#btnLibClose').onclick = toggleLib;
if (store.get('chatHidden', false)) document.body.classList.add('chat-hidden');
if (store.get('libHidden', false)) document.body.classList.add('lib-hidden');

// ---------- settings + first-run setup ----------
let sysStatus = null;
const PROVIDER_NAMES = { claude: 'Claude', codex: 'ChatGPT', cursor: 'Cursor', grok: 'Grok', antigravity: 'Antigravity', ollama: 'Ollama' };
// Providers whose model is picked from a list in Settings (the list comes from the CLI or app).
const MODEL_FIELDS = { cursor: 'setCursorModel', grok: 'setGrokModel', antigravity: 'setAntigravityModel', ollama: 'setOllamaModel' };
const providerLabel = () => PROVIDER_NAMES[cfg.provider] || 'Claude';
async function refreshTrust() {
  $('#trustStatus').textContent = 'Checking auto-select…';
  const { trusted } = await (await api('/api/trust')).json();
  if (trusted === null) { $('#trustStatus').textContent = 'AirDrop helper not installed: use the SlideMate app, or run scripts/build-app.sh'; $('#btnTrust').hidden = true; return; }
  $('#trustStatus').textContent = trusted ? 'On: your iPad is picked automatically in the AirDrop panel.'
    : 'Off: you click your iPad in the AirDrop panel. Turning it on needs Accessibility permission.';
  $('#btnTrust').hidden = trusted;
}
let draft = {};
function renderRoots() {
  $('#rootList').innerHTML = (draft.library_roots || []).map((r, i) => `<div class="root"><span title="${esc(r)}">${esc(r)}</span><button type="button" data-rm="${i}" title="Remove">✕</button></div>`).join('')
    || '<div class="hint">No folder chosen yet.</div>';
}
$('#rootList').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { draft.library_roots.splice(+b.dataset.rm, 1); renderRoots(); saveSettings(); updateGate(); } });
async function pickFolder() {
  const native = window.webkit?.messageHandlers?.slidemate;
  if (native) return new Promise((done) => { window.__slidemateFolder = done; native.postMessage({ action: 'pickFolder' }); });
  return (await post('/api/pick-folder')).path;  // browser / dev mode: AppleScript dialog
}
function addRoot(path) { if (path && !draft.library_roots.includes(path)) { draft.library_roots.push(path); renderRoots(); saveSettings(); updateGate(); } }
$('#btnAddRoot').onclick = async () => addRoot(await pickFolder());
$('#btnStarter').onclick = async () => { addRoot((await post('/api/starter-folder')).path); toast('Created Documents/SlideMate: add a folder per course, or drop PDFs into it'); };
// Install / sign-in run in a Terminal window; while one is open (or the chosen AI isn't ready) the status is
// re-checked every few seconds, so the setup screen updates by itself when the user finishes.
const providerReady = (id) => !!(sysStatus?.providers?.[id]?.installed && sysStatus.providers[id].logged_in);
const setupPending = {};
let statusPoll = null, statusBusy = false;
function watchStatus() {
  if (statusPoll) return;
  statusPoll = setInterval(async () => {
    if (!$('#settings').open) { clearInterval(statusPoll); statusPoll = null; return; }
    if (statusBusy) return;
    statusBusy = true;
    const before = JSON.stringify(sysStatus?.providers);
    // Only re-check the AI that's chosen or being set up: some checks are network calls (Antigravity, Cursor).
    const only = [...new Set([draft.provider, ...Object.keys(setupPending)])].join(',');
    try {
      const fresh = await (await api('/api/status?only=' + only)).json();
      sysStatus = { ...fresh, providers: { ...sysStatus?.providers, ...fresh.providers } };
    } catch { /* try again next time */ } finally { statusBusy = false; }
    if (JSON.stringify(sysStatus.providers) === before) return;
    for (const id of Object.keys(setupPending)) {
      if (providerReady(id)) { delete setupPending[id]; toast(`✓ ${PROVIDER_NAMES[id]} is ready`); }
    }
    readModelFields();
    if (!providerReady(draft.provider)) {  // pick whichever AI just became ready
      const ok = Object.keys(PROVIDER_NAMES).find(providerReady);
      if (ok) { draft.provider = ok; saveSettings(); }
    }
    renderProviders();
    if (providerReady(draft.provider) && !Object.keys(setupPending).length) { clearInterval(statusPoll); statusPoll = null; }
  }, 3000);
}
function updateGate() {
  if (!document.body.classList.contains('first-run')) return;
  const need = !(draft.library_roots || []).length ? 'Next: choose the folder with your lecture slides.'
    : !providerReady(draft.provider) ? `Next: ${sysStatus?.providers?.[draft.provider]?.installed && draft.provider !== 'ollama' ? 'sign in to' : 'set up'} ${PROVIDER_NAMES[draft.provider]} (or pick another AI).`
    : '';
  $('#btnSettingsSave').disabled = !!need;
  $('#setFootHint').textContent = need || 'All set. You can change any of this later in Settings (⌘,).';
}
function renderProviders() {
  const ps = sysStatus?.providers || {};
  const card = (id, name, sub) => {
    const s = ps[id] || {};
    const waiting = setupPending[id] && !(s.installed && s.logged_in);
    const state = waiting ? `<span class="pill-status"><span class="spinner"></span>Finish in the Terminal window…</span>`
      : !s.installed ? `<span class="pill-status bad">Not installed</span><div class="acts"><button type="button" class="small primary" data-install="${id}">Install &amp; ${id === 'ollama' ? 'set up' : 'sign in'}</button></div>`
      : !s.logged_in ? `<span class="pill-status bad">${esc(s.not_ready || 'Not signed in')}</span><div class="acts"><button type="button" class="small primary" data-login="${id}">${esc(s.login_label || 'Sign in…')}</button></div>`
      : `<span class="pill-status ok">✓ Signed in${s.detail ? ' · ' + esc(s.detail) : ''}</span>`;
    return `<label class="pcard ${draft.provider === id ? 'on' : ''}"><input type="radio" name="prov" value="${id}" ${draft.provider === id ? 'checked' : ''}>
      <div class="body"><b>${name}</b><div class="st">${sub}</div></div>${state}</label>`;
  };
  $('#providerCards').innerHTML = card('claude', 'Claude', 'Your Claude Pro or Max plan (via Claude Code). Reads slides natively.')
    + card('codex', 'ChatGPT', 'Your ChatGPT plan (via the Codex app).')
    + card('antigravity', 'Gemini (Antigravity)', 'Your Google account, free plan included. Gemini, plus Claude and GPT-OSS models.')
    + card('cursor', 'Cursor', 'Your Cursor plan, with any model Cursor offers.')
    + card('grok', 'Grok', 'Your grok.com / SuperGrok account.')
    + card('ollama', 'On this Mac (Ollama)', 'Free and offline. Simpler answers; best with 16 GB of memory or more.');
  const pdfHint = draft.provider !== 'claude' && sysStatus && !sysStatus.pdftools
    ? `<div class="set-label" style="grid-column:1/-1"><span>${PROVIDER_NAMES[draft.provider]} reads slides as text, which needs poppler: <code>brew install poppler</code></span></div>` : '';
  $('#providerCards').insertAdjacentHTML('beforeend', pdfHint);
  const sel = (id, opts, cur) => `<select id="${id}" class="set-input">${opts.map(([v, l]) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const claudeModels = [['sonnet', 'Sonnet 5.5 · fast'], ['opus', 'Opus 5.5 · deepest'], ['fable', 'Fable 5.1 · most powerful'], ['haiku', 'Haiku 4.5 · fastest']];
  const p = draft.provider;
  if (p === 'codex') {
    $('#modelRow').innerHTML = `<label class="set-row"><div class="set-label"><b>Model</b><span>Leave blank to use your Codex default. You can also switch from the chat box.</span></div>
         <input id="setCodexModel" class="set-input" value="${esc(draft.codex_model || '')}" placeholder="Codex default"></label>`;
  } else if (MODEL_FIELDS[p]) {
    const list = setCat?.[p]?.models, cur = draft[`${p}_model`] || '';
    const opts = [['', p === 'ollama' ? 'Best downloaded model' : `${PROVIDER_NAMES[p]} default`], ...(list || []).map((m) => [m.id, m.label])];
    if (cur && !opts.some(([v]) => v === cur)) opts.push([cur, cur]);
    const hint = !list ? (p === 'ollama' ? 'Looking for models on this Mac…' : 'Loading the models on your account…')
      : p === 'ollama' && !list.length ? 'No models yet. Download one with the button above (qwen3-vl:8b, about 6 GB, can see slides).'
      : 'Used for chat and lecture notes. You can also switch it from the chat box.';
    $('#modelRow').innerHTML = `<label class="set-row"><div class="set-label"><b>Model</b><span>${hint}</span></div>${sel(MODEL_FIELDS[p], opts, cur)}</label>`;
    if (!list && !setCatLoading) loadSetCat();
  } else {
    $('#modelRow').innerHTML = `<label class="set-row"><div class="set-label"><b>Tutor model</b><span>Used for chat. You can also switch it from the chat box.</span></div>${sel('setClaudeModel', claudeModels, draft.claude_model)}</label>
       <label class="set-row"><div class="set-label"><b>Lecture-notes model</b><span>Writes the summary and per-slide notes after a lecture.</span></div>${sel('setClaudeNotes', claudeModels, draft.claude_notes_model)}</label>`;
  }
  updateGate();
  if (!providerReady(draft.provider) || Object.keys(setupPending).length) watchStatus();
}
let setCat = null, setCatLoading = false;  // every provider's model list, for the settings pane
async function loadSetCat() {
  setCatLoading = true;
  try { setCat = await (await api('/api/models?all=1')).json(); } catch { setCat = {}; }
  setCatLoading = false;
  if ($('#settings').open) { readModelFields(); renderProviders(); }
}
$('#providerCards').addEventListener('change', (e) => { if (e.target.name === 'prov') { readModelFields(); draft.provider = e.target.value; renderProviders(); } });
$('#providerCards').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-login], [data-install]');
  if (!b) return;
  e.preventDefault();
  const id = b.dataset.login || b.dataset.install;
  readModelFields();
  if (draft.provider !== id) { draft.provider = id; saveSettings(); }
  const r = await post('/api/login', { provider: id, install: !!b.dataset.install });
  if (!r.ok) return toast("Couldn't open Terminal. Try again, or see the README for the manual steps.", true);
  setupPending[id] = true;
  renderProviders();
  toast(b.dataset.install ? 'A Terminal window opened: it installs, then opens your browser to sign in. SlideMate notices when you’re done.'
    : 'Sign in in your browser (from the Terminal window that opened). SlideMate notices when you’re done.', false, 9000);
});
function readModelFields() {
  if ($('#setCodexModel')) draft.codex_model = $('#setCodexModel').value.trim();
  if ($('#setCursorModel')) draft.cursor_model = $('#setCursorModel').value;
  if ($('#setGrokModel')) draft.grok_model = $('#setGrokModel').value;
  if ($('#setAntigravityModel')) draft.antigravity_model = $('#setAntigravityModel').value;
  if ($('#setOllamaModel')) draft.ollama_model = $('#setOllamaModel').value;
  if ($('#setClaudeModel')) { draft.claude_model = $('#setClaudeModel').value; draft.claude_notes_model = $('#setClaudeNotes').value; }
}
async function loadStatus() { sysStatus = await (await api('/api/status')).json(); }
const PANE_TITLES = { general: 'Library', ai: 'AI tutor', ipad: 'Send to iPad', recording: 'Lecture recording', cards: 'Flashcards', connections: 'Connections & sync', storage: 'Storage' };
function showPane(name) {
  if (!PANE_TITLES[name]) name = 'general';
  document.querySelectorAll('#settings .pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === name));
  document.querySelectorAll('.set-nav button').forEach((b) => b.classList.toggle('on', b.dataset.pane === name));
  $('#paneTitle').textContent = PANE_TITLES[name];
  store.set('settingsPane', name);
}
document.querySelector('.set-nav').addEventListener('click', (e) => { const b = e.target.closest('[data-pane]'); if (b) showPane(b.dataset.pane); });
async function openSettings(firstRun = false, pane) {
  draft = JSON.parse(JSON.stringify(cfg));
  document.body.classList.toggle('first-run', firstRun);
  $('#welcome').hidden = !firstRun;
  $('#setFoot').hidden = !firstRun;
  $('#savedHint').textContent = '';
  showPane(pane || store.get('settingsPane', 'general'));
  renderRoots();
  $('#setIpad').value = cfg.ipad_name || '';
  $('#setRecLimit').value = cfg.rec_limit_min ?? 120;
  $('#setCardsAuto').checked = cfg.cards_auto !== false;
  $('#setCardsChats').checked = cfg.cards_from_chats !== false;
  $('#setCardsNew').value = cfg.cards_new_per_day ?? 20;
  $('#setCardsRetention').value = String(cfg.cards_retention ?? 0.9);
  $('#setAirdrop').checked = cfg.airdrop;
  $('#setClip').checked = cfg.copy_to_clipboard;
  $('#setSync').value = cfg.sync_command || '';
  $('#setSyncLogin').value = cfg.sync_login_command || '';
  $('#setSyncMode').value = cfg.sync_mcp?.server ? 'mcp' : (cfg.sync_command ? 'command' : '');
  $('#mcpImport').hidden = true; $('#mcpForm').hidden = true;
  renderMcp();
  renderSyncMode();
  $('#setMd').checked = cfg.write_markdown;
  $('#providerCards').innerHTML = '<div class="set-label"><span>Checking which AI apps are installed…</span></div>';
  if (!$('#settings').open) $('#settings').showModal();
  await loadStatus();
  renderProviders();
  const r = sysStatus.recording, ready = r.ffmpeg && r.parakeet;
  $('#recStatus').innerHTML = ready ? 'Parakeet runs on this Mac, so audio never leaves your computer.'
    : `Needs ffmpeg and Parakeet: <code>${esc(r.install)}</code>. Importing a transcript works without them.`;
  $('#recBadge').textContent = ready ? '✓ Ready' : 'Not installed';
  $('#recBadge').className = 'pill-status ' + (ready ? 'ok' : 'bad');
  renderRecList();
  const p = lib.paths || {};
  const rows = [['Your slides', (p.roots || []).join(', ')], ['Inbox', p.inbox, 'Drop PDFs here and they get filed into the right course.'],
    ['SlideMate data', p.data, 'Settings, chats, lecture notes and recordings.'], ['Screenshots sent to iPad', p.snaps]];
  $('#storage').innerHTML = rows.filter(([, path]) => path).map(([label, path, desc]) => `<div class="store"><div class="t"><b>${esc(label)}</b>
    ${desc ? `<span class="muted small">${esc(desc)}</span>` : ''}<code title="${esc(path)}">${esc(path)}</code></div>
    <button type="button" class="small" data-reveal="${esc(path.split(', ')[0])}">Show in Finder</button></div>`).join('');
  refreshTrust();
}
// ---------- Settings → Lecture recording → Your recordings ----------
const REC_STATUS = { recording: 'Recording now', transcribing: 'Transcribing…', writing: 'Writing notes…', error: 'Failed' };
async function renderRecList() {
  const el = $('#recList');
  let all;
  try { all = await (await api('/api/lectures/all')).json(); } catch { all = []; }
  el.innerHTML = all.length ? all.map((m) => {
    const when = m.started ? new Date(m.started * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : (m.date || '');
    const bits = [m.course && shortCourse(m.course), when, m.duration && fmtT(m.duration), REC_STATUS[m.status],
                  m.source && m.source !== 'recorded' && 'imported'].filter(Boolean);
    return `<div class="mcp"><div class="body"><b title="${esc(m.deck || '')}">${esc(m.deck_title || 'Lecture')}</b>
      <div class="sub">${esc(bits.join(' · '))}</div></div>
      <button type="button" class="small ghost" data-rec-rm="${esc(m.id)}" title="Delete this recording">${rec?.id === m.id ? 'Discard' : 'Delete'}</button></div>`;
  }).join('') : '<div class="hint">No recordings yet.</div>';
}
$('#recList').addEventListener('click', async (e) => {
  const id = e.target.closest('[data-rec-rm]')?.dataset.recRm;
  if (!id) return;
  if (rec?.id === id) { await discardRecording(); return renderRecList(); }
  if (!confirm('Delete this recording? Its audio, transcript and notes (including the Markdown files) are removed for good.')) return;
  await post('/api/lecture/delete', { id });
  if (lec.cur === id) lec.cur = null;
  if (state.path) loadLectures(state.path, lec.cur);
  renderRecList();
  toast('Recording deleted');
});
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
  box.innerHTML = '<div class="hint">Looking for MCP servers in Claude Desktop, Claude Code, Codex, Cursor, Grok and Antigravity…</div>';
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
  // Default to a server that has a sync-style tool (e.g. moodle_sync), not just the first one.
  const canSync = (n) => (cfg.mcp_servers[n].tools || []).some((t) => /sync(?!_status)|pull/i.test(t));
  const sel = $('#syncServer').value || cur.server || servers.find(canSync) || servers[0] || '';
  $('#syncServer').innerHTML = servers.length ? servers.map((n) => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('') : '<option value="">Add a connection first</option>';
  const tools = mcpTools[sel]?.tools;
  if (sel && !tools && !mcpTools[sel]?.pending && !mcpTools[sel]?.error) { mcpTest(sel); return; }
  const opts = (list, val, blank) => (blank ? `<option value="">${blank}</option>` : '') + (list || (val ? [val] : [])).map((t) => `<option ${t === val ? 'selected' : ''}>${esc(t)}</option>`).join('');
  const guess = (...res) => { for (const re of res) { const t = (tools || []).find((x) => re.test(x)); if (t) return t; } return ''; };
  // A blank first choice: without it the browser picks the server's first tool (e.g. a JavaScript tool), and Pull
  // would call it with no arguments and fail.
  $('#syncTool').innerHTML = opts(tools, cur.server === sel && cur.tool ? cur.tool : guess(/(^|_)sync$/i, /sync(?!_status)/i, /pull/i, /download/i),
    tools && !tools.some((t) => /sync(?!_status)|pull|download/i.test(t)) ? 'This server has no sync tool' : 'Choose a tool…');
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
  const name = m ? m.label : (catalog.provider === 'claude' ? c.model : c.model || 'Default model');
  $('#modelLabel').textContent = `${name}${c.effort ? ' · ' + (EFFORT_LABEL[c.effort] || c.effort) : ''}`;
}
function effortsFor(c) {
  if (c.efforts) return c.efforts;  // Claude: one list; Cursor: none (effort is part of the model name)
  const m = c.models.find((x) => x.id === c.model);
  return m?.efforts || c.default_efforts || ['low', 'medium', 'high', 'xhigh'];
}
function openModelMenu() {
  const c = provCat();
  if (!c) return;
  const menu = $('#modelMenu');
  const cli = { codex: 'Codex', cursor: 'Cursor', grok: 'Grok', antigravity: 'Antigravity', ollama: 'Ollama' }[catalog.provider];
  const models = cli ? [{ id: '', label: 'Default', desc: `Whatever ${cli} is set to use` }, ...c.models] : c.models;
  if (cli && c.model && !models.some((m) => m.id === c.model)) models.push({ id: c.model, label: c.model, desc: '' });
  const efforts = effortsFor(c);
  const long = models.length > 12;
  menu.innerHTML = `<div class="label">${providerLabel()} model</div>`
    + (long ? '<input class="mfilter" placeholder="Search models…" autocomplete="off" spellcheck="false">' : '')
    + `<div class="mlist">${models.map((m) => `<button class="mrow" data-model="${esc(m.id)}" data-q="${esc((m.label + ' ' + m.id).toLowerCase())}"><b>${esc(m.label)}${m.id === (c.model || '') ? '<span class="chk">✓</span>' : ''}</b>${m.desc ? `<span>${esc(m.desc)}</span>` : ''}</button>`).join('')}</div>`
    + (efforts.length ? `<hr><div class="label">Effort</div><div class="efforts">${['', ...efforts].map((e) => `<button data-effort="${e}" class="${e === (c.effort || '') ? 'on' : ''}">${EFFORT_LABEL[e] || e}</button>`).join('')}</div>` : '');
  menu.hidden = false;
  if (long) { menu.querySelector('.mfilter').focus(); menu.querySelector('.mrow .chk')?.closest('.mrow').scrollIntoView({ block: 'nearest' }); }
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
$('#modelMenu').addEventListener('input', (e) => {
  if (!e.target.matches('.mfilter')) return;
  const q = e.target.value.trim().toLowerCase().split(/\s+/);
  $('#modelMenu').querySelectorAll('.mrow').forEach((r) => { r.hidden = !q.every((w) => r.dataset.q.includes(w)); });
  placeAbove($('#modelMenu'), $('#modelBtn'));
});
$('#modelMenu').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.mfilter')) [...$('#modelMenu').querySelectorAll('.mrow')].find((r) => !r.hidden)?.click();
});
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
function settingsPayload() {
  readModelFields();
  const mode = $('#setSyncMode').value;
  return {
    library_roots: draft.library_roots, provider: draft.provider, claude_model: draft.claude_model,
    claude_notes_model: draft.claude_notes_model, codex_model: draft.codex_model,
    cursor_model: draft.cursor_model, grok_model: draft.grok_model, antigravity_model: draft.antigravity_model,
    ollama_model: draft.ollama_model,
    ipad_name: $('#setIpad').value.trim(), airdrop: $('#setAirdrop').checked, copy_to_clipboard: $('#setClip').checked,
    sync_command: mode === 'command' ? $('#setSync').value.trim() : '',
    sync_login_command: mode === 'command' ? $('#setSyncLogin').value.trim() : '',
    sync_mcp: mode === 'mcp' ? { server: $('#syncServer').value, tool: $('#syncTool').value, login_tool: $('#syncLoginTool').value } : { server: '', tool: '', login_tool: '' },
    write_markdown: $('#setMd').checked,
    rec_limit_min: Math.max(0, Math.min(1440, Math.round(+$('#setRecLimit').value || 0))),
    cards_auto: $('#setCardsAuto').checked, cards_from_chats: $('#setCardsChats').checked,
    cards_new_per_day: Math.max(0, Math.min(500, Math.round(+$('#setCardsNew').value || 0))),
    cards_retention: +$('#setCardsRetention').value || 0.9,
  };
}
// Changes apply as you make them (no Save button), like Cursor.
let saveT;
async function saveSettings(now = false) {
  if (document.body.classList.contains('first-run')) return;  // first run saves on "Get started"
  clearTimeout(saveT);
  const go = async () => {
    const before = cfg;
    cfg = await post('/api/config', settingsPayload());
    $('#savedHint').textContent = 'Saved'; $('#savedHint').style.opacity = 1;
    setTimeout(() => { $('#savedHint').style.opacity = 0; }, 1200);
    if (['provider', 'claude_model', 'codex_model', 'cursor_model', 'grok_model', 'antigravity_model', 'ollama_model'].some((k) => before[k] !== cfg[k])) loadModels();
    if (JSON.stringify(before.library_roots) !== JSON.stringify(cfg.library_roots)) loadLibrary();
    if (before.sync_mcp?.tool !== cfg.sync_mcp?.tool || before.sync_command !== cfg.sync_command) loadLibrary();
    if (before.cards_new_per_day !== cfg.cards_new_per_day || before.cards_retention !== cfg.cards_retention) { loadCardsOverview(); if (state.path) loadDeckCards(); }
  };
  if (now) return go();
  saveT = setTimeout(go, 400);
}
$('#settings').addEventListener('change', (e) => { if (!e.target.closest('#mcpForm, #mcpImport, .mcp')) saveSettings(); });
$('#settings').addEventListener('input', (e) => { if (e.target.matches('#setIpad, #setSync, #setSyncLogin, #setCodexModel, #setRecLimit, #setCardsNew')) saveSettings(); });
$('#btnSettingsClose').onclick = () => $('#settings').close();
$('#settings').addEventListener('cancel', (e) => { if (document.body.classList.contains('first-run')) e.preventDefault(); });
$('#settings').addEventListener('close', () => { if (!document.body.classList.contains('first-run')) saveSettings(true); });
$('#btnSettingsSave').onclick = async () => {  // first run: "Get started"
  const payload = settingsPayload();
  if (!payload.library_roots.length) { showPane('general'); return toast('Choose your slides folder first', true); }
  if (!providerReady(payload.provider)) return toast('Set up an AI tutor first', true);
  cfg = await post('/api/config', { ...payload, setup_done: true });
  document.body.classList.remove('first-run');
  $('#settings').close();
  toast('All set. Your courses are being organised.');
  loadModels();
  loadLibrary();
  if (state.pdf) setCurrent(state.current);
};

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
    const move = (ev) => { setPanelWidth(name, name === 'library' ? ev.clientX - panel.left : panel.right - ev.clientX); liveFit(250); };
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
  if (typeof autosize === 'function') requestAnimationFrame(autosize);
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
  if (e.key === 'Escape') {
    if (!$('#findBar').hidden) { closeFind(); return; }
    if (state.busy && !snip && ctx.hidden) stopAnswer();
    endSnip(); hideMenus(); return;
  }
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || $('#settings').open || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === 'l' || k === 'L') return toggleLib();
  if (k === 'r' || k === 'R') return openHub();
  if (!state.pdf) return;
  if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'j' || k === 'PageDown' || k === ' ') { e.preventDefault(); goTo(state.current + 1); }
  else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'k' || k === 'PageUp') { e.preventDefault(); goTo(state.current - 1); }
  else if (k === 'e') ask('Explain this slide.');
  else if (k === 's') sendSlide();
  else if (k === 'x') startSnip();
  else if (k === '/') { e.preventDefault(); showChat(); $('#askInput').focus(); }
  else if (k === 't') $('#btnChat').click();
  else if (k === 'n') setPanelTab(panelTab === 'notes' ? 'chat' : 'notes');
  else if (k === 'c') setPanelTab(panelTab === 'cards' ? 'chat' : 'cards');
  else if (k === '+' || k === '=') $('#btnZoomIn').click();
  else if (k === '-') $('#btnZoomOut').click();
});

let dragDepth = 0;
function dropMessage(dt) {
  const types = [...(dt.items || [])].filter((i) => i.kind === 'file').map((i) => i.type);
  const pdf = types.some((t) => t === 'application/pdf'), img = types.some((t) => t.startsWith('image/'));
  if (img && !pdf) return 'Drop pictures to ask about them';
  if (pdf && !img) return "Drop PDF: it'll be filed into the right course";
  return 'Drop pictures to ask about them · PDFs get filed into your library';
}
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  if (!dragDepth++) $('#dropMsg').textContent = dropMessage(e.dataTransfer);
  $('#dropOverlay').hidden = false;
});
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('#dropOverlay').hidden = true;
  const files = [...e.dataTransfer.files];
  if (files.some(isImageFile)) {
    if (files.some((f) => f.name.toLowerCase().endsWith('.pdf'))) toast('Attached the pictures. Drop PDFs on their own to file them.', false, 5000);
    return addPictures(files);
  }
  const f = files.find((f) => f.name.toLowerCase().endsWith('.pdf'));
  if (!f) return toast('Drop a PDF or a picture', true);
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
  recorder.ondataavailable = (e) => { if (e.data.size) { rec.lastData = performance.now(); rec.queue.push({ seq: ++rec.seq, blob: e.data }); pump(); } };
  // If the microphone goes away (headphones unplugged, device switched), the recorder stops delivering audio
  // without telling anyone. Notice it, and finish the lecture with what was captured.
  recorder.onerror = () => micLost();
  stream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => micLost()));
  recorder.start(15000);
  rec.lastData = performance.now();
  rec.timer = setInterval(() => {
    $('#recTime').textContent = fmtT(audioTime());
    if (!rec.paused && performance.now() - rec.lastData > 45000) micLost();
    checkRecLimit();
  }, 500);
  // Tell the server this page is still recording (even while paused); if it goes quiet, the server finishes it.
  rec.beat = setInterval(() => post('/api/lecture/heartbeat', { id }).catch(() => {}), 20000);
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
        if (r.discarded) return;
        await new Promise((ok) => setTimeout(ok, delay));
        delay = Math.min(delay * 2, 30000);
      }
      r.queue.shift();
      if (r.discarded) return;
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
  markCardsHere();
}

function togglePause() {
  if (!rec) return;
  if (rec.paused) { rec.recorder.resume(); rec.paused = false; rec.resumedAt = rec.lastData = performance.now(); rec.events.push({ t: audioTime(), slide: state.current, deck: state.path }); }
  else { rec.acc = audioTime(); rec.recorder.pause(); rec.paused = true; }
  $('#recPill').classList.toggle('paused', rec.paused);
  $('#btnRecPause').innerHTML = `<svg><use href="#i-${rec.paused ? 'play' : 'pause'}"/></svg>`;
  $('#btnRecPause').title = rec.paused ? 'Resume' : 'Pause';
}

// Time limit (Settings → Lecture recording; default 2 h, 0 = none): warn 5 min before, then stop and save.
function checkRecLimit() {
  const lim = Math.max(0, +(cfg.rec_limit_min ?? 120) || 0) * 60, t = audioTime();
  if (!rec || rec.lost || !lim) return;
  const label = lim % 3600 ? `${Math.round(lim / 60)}-minute` : `${lim / 3600}-hour`;
  if (lim >= 900 && t >= lim - 300 && !rec.limitWarned) {
    rec.limitWarned = true;
    toast(`Recording stops automatically in 5 minutes (${label} limit, change it in Settings → Lecture recording).`, false, 9000);
  }
  if (t >= lim) {
    rec.lost = true;
    toast(`Reached the ${label} recording limit, so SlideMate stopped and saved the recording. Your notes are being written.`, false, 12000);
    stopRecording(false);
  }
}
function micLost() {
  if (!rec || rec.lost) return;
  rec.lost = true;
  toast('Recording stopped: the microphone went away (headphones disconnected or the input changed). Everything up to now is saved, and your notes are being written.', true, 15000);
  stopRecording(false);
}
async function stopRecording(askFirst = true) {
  if (!rec) return;
  if (askFirst && !confirm('Stop recording and write your lecture notes?')) return;
  const r = rec;
  clearInterval(r.timer);
  if (r.recorder.state !== 'inactive') {  // a recorder that already died can't be stopped (stop() would throw)
    await new Promise((ok) => { r.recorder.onstop = ok; try { r.recorder.stop(); } catch { ok(); } setTimeout(ok, 5000); });
  }
  r.stream.getTracks().forEach((t) => t.stop());
  toast('Saving the recording…', false, 2500);
  while (r.queue.length || r.pumping) { await pump(); await new Promise((ok) => setTimeout(ok, 300)); }
  if (r.events.length) await post('/api/lecture/events', { id: r.id, events: r.events.splice(0) });
  await post('/api/lecture/stop', { id: r.id });
  clearInterval(r.beat);
  rec = null;
  $('#btnRec').hidden = false; $('#recPill').hidden = true;
  $('#btnRecPause').innerHTML = '<svg><use href="#i-pause"/></svg>';
  setPanelTab('notes');
  loadLectures(r.deck, r.id);
}
// Recorded by accident (left it on, chatting with friends)? Throw it away: nothing is transcribed or kept.
async function discardRecording() {
  if (!rec || !confirm('Discard this recording? The audio and live transcript are deleted and no notes are written.')) return;
  const r = rec;
  r.discarded = true;
  clearInterval(r.timer); clearInterval(r.beat);
  r.queue.length = 0; r.events.length = 0;
  r.recorder.ondataavailable = null;
  try { if (r.recorder.state !== 'inactive') r.recorder.stop(); } catch {}
  r.stream.getTracks().forEach((t) => t.stop());
  rec = null;
  $('#btnRec').hidden = false; $('#recPill').hidden = true;
  $('#btnRecPause').innerHTML = '<svg><use href="#i-pause"/></svg>';
  await post('/api/lecture/delete', { id: r.id });
  if (lec.cur === r.id) lec.cur = null;
  if (state.path === r.deck) loadLectures(r.deck);
  toast('Recording discarded');
}
$('#btnRec').onclick = startRecording;
$('#btnRecStop').onclick = () => stopRecording(true);
$('#btnRecDiscard').onclick = discardRecording;
// Used by the Mac app before quitting / closing the window (see macos/SlideMate/main.swift).
window.__slidemateRecording = () => (rec ? { recording: true, seconds: Math.round(audioTime()), deck: state.name } : { recording: false });
window.__slidemateStopRecording = async () => { await stopRecording(false); return true; };
$('#btnRecPause').onclick = togglePause;
window.addEventListener('beforeunload', (e) => { if (rec) { e.preventDefault(); e.returnValue = ''; } });

// =====================================================================================
// Flashcards: cards per lecture (by subtopic), written from the slides, the lecture notes and your questions;
// reviewed with active recall on a spaced-repetition schedule (FSRS, like Anki)
// =====================================================================================
const cards = { overview: null, deck: null, open: new Set(store.get('cardsOpen', [])), expanded: null, editing: null };
const RATE = [[1, 'Again'], [2, 'Hard'], [3, 'Good'], [4, 'Easy']];
const courseLabel = (c) => (c ? shortCourse(c.replace(/^[A-Z]{2,6}\s?\d{3,6}[A-Z]?\s*[-–:]?\s+/, '')) : 'Other');
const isLearning = (c) => c.srs.state === 'learning' || c.srs.state === 'relearning';
const overlayOpen = () => !$('#study').hidden || !$('#hub').hidden;

let cardsPollT;
async function loadCardsOverview() {
  clearTimeout(cardsPollT);
  try { cards.overview = await (await api('/api/cards/overview')).json(); } catch { return; }
  cardMap = new Map(cards.overview.decks.map((d) => [d.path, d]));
  renderReviewBtn();
  renderLibrary();
  if (!$('#hub').hidden) renderHub();
  const busy = [...cards.overview.decks, ...cards.overview.backlog].some((d) => d.job);
  cardsPollT = setTimeout(loadCardsOverview, busy ? 5000 : 60000);
}
function totals() {
  const ds = cards.overview?.decks || [], t = cards.overview?.today || {};
  const due = ds.reduce((a, d) => a + d.counts.due, 0), fresh = ds.reduce((a, d) => a + d.counts.new, 0);
  return { due, fresh, newToday: Math.min(fresh, t.new_left ?? 0) };
}
function renderReviewBtn() {
  const { due, newToday } = totals();
  const n = $('#reviewCount');
  n.textContent = due ? `${due} due` : newToday ? `${newToday} new` : '';
  n.className = 'n' + (due ? ' due' : '');
}

// Card text → HTML. Cloze cards hide {{c::…}} on the front and highlight it on the back. Slide links only make
// sense for the deck that's open, so the study view (cards from any deck) renders without them.
const CLOZE_RE = /\{\{c\d*::([\s\S]+?)(?:::([\s\S]*?))?\}\}/g;
function cardFront(c, links = true) {
  const t = c.type === 'cloze' ? c.front.replace(CLOZE_RE, (_, a, hint) => `<span class="cloze">${hint ? esc(hint) : '…'}</span>`) : c.front;
  return mdRender(t, links);
}
function cardBack(c, links = true) {
  if (c.type !== 'cloze') return mdRender(c.back, links);
  return mdRender(c.front.replace(CLOZE_RE, (_, a) => `<mark class="cloze-a">${a}</mark>`), links) + (c.back ? `<div class="extra">${mdRender(c.back, links)}</div>` : '');
}
const plainCard = (s) => (s || '').replace(CLOZE_RE, '$1').replace(/\s+/g, ' ').trim();
function badges(c) {
  return (c.exam ? `<span class="badge exam" title="The lecturer flagged this as important or examinable">${icon('star')}Exam</span>` : '')
    + (c.struggle ? `<span class="badge asked" title="Made from a question you asked the tutor">${icon('chat')}You asked</span>` : '')
    + (c.leech ? '<span class="badge leech" title="You\'ve forgotten this one several times">Keeps slipping</span>' : '')
    + (c.suspended ? '<span class="badge">Suspended</span>' : '');
}
function dueText(c) {
  const s = c.srs, now = Date.now() / 1000;
  if (c.suspended) return '';
  if (s.state === 'new') return '<span class="st new">new</span>';
  if (s.due <= now || isLearning(c)) return '<span class="st due">due</span>';
  const d = (s.due - now) / 86400;
  return `<span class="st">in ${d < 1 ? Math.max(1, Math.round(d * 24)) + 'h' : d < 60 ? Math.round(d) + 'd' : Math.round(d / 30) + 'mo'}</span>`;
}
function masteryBar(cs) {
  const n = cs.length || 1;
  const learned = cs.filter((c) => c.srs.state === 'review' && (c.srs.stability || 0) >= 21).length;
  const seen = cs.filter((c) => c.srs.state !== 'new').length - learned;
  return `<div class="mbar" title="${learned} learned · ${seen} learning · ${cs.length - learned - seen} not seen yet"><i class="l" style="width:${100 * learned / n}%"></i><i class="s" style="width:${100 * seen / n}%"></i></div>`;
}

// ---------- the Cards tab: this deck's cards, by subtopic ----------
let deckPollT;
async function loadDeckCards(path = state.path) {
  clearTimeout(deckPollT);
  if (!path) return;
  let d;
  try { d = await (await api('/api/cards/deck?path=' + encodeURIComponent(path))).json(); } catch { return; }
  if (state.path !== path) return;
  const was = cards.deck?.path === path ? cards.deck : null;
  cards.deck = d;
  if (!was && d.cards.length && ![...cards.open].some((k) => k.startsWith(path + '#'))) {  // first look: open the subtopic you're on
    const here = d.subtopics.find((t) => t.slides?.includes(state.current)) || d.subtopics[0];
    if (here) cards.open.add(path + '#' + here.id);
  }
  renderCardsPane();
  if (d.job) {
    deckPollT = setTimeout(() => loadDeckCards(path), 4000);
  } else if (was?.job) {
    loadCardsOverview();
    toast(d.error ? 'Couldn\'t write the flashcards. Try again from the Cards tab.' : d.last_added ? `${d.last_added} new flashcard${d.last_added > 1 ? 's' : ''} ready ✓` : 'Flashcards are up to date ✓', !!d.error, 5000);
  }
}
async function makeCards(path, mode = 'auto', why = 'manual') {
  await post('/api/cards/make', { path, mode, why });
  if (path === state.path) loadDeckCards(path);
  loadCardsOverview();
}

function renderCardsPane() {
  const pane = $('#cardsPane');
  if (panelTab !== 'cards') return;
  const d = cards.deck;
  if (!state.path) { pane.innerHTML = ''; return; }
  if (!d || d.path !== state.path) { pane.innerHTML = '<div class="muted"><span class="spinner"></span>Loading…</div>'; return; }
  const job = d.job;
  if (!d.cards.length) {
    if (job) {
      pane.innerHTML = `<div class="state-card"><b><span class="spinner"></span>${job.state === 'queued' ? 'Waiting for another deck to finish…' : `${providerLabel()} is writing your flashcards…`}</b>
        Reading the slides${d.lectures_done ? ', what your lecturer said' : ''}${d.questions ? ` and the ${d.questions} question${d.questions > 1 ? 's' : ''} you asked` : ''}, then splitting it into subtopics. This takes a few minutes; you can keep studying.</div>`;
      return;
    }
    const src = (ok, text) => `<li class="${ok ? 'ok' : 'no'}">${ok ? '✓' : '–'} ${text}</li>`;
    pane.innerHTML = `${d.error ? `<div class="state-card warn"><b>Couldn't write the flashcards</b><span class="muted">${esc(d.error)}</span></div>` : ''}
      <div class="state-card"><b>Flashcards for this lecture</b>
      ${providerLabel()} turns the deck into active-recall cards, split by subtopic, and SlideMate schedules each one to come back just before you'd forget it (spaced repetition, as in Anki).
      <ul class="srcs">${src(true, 'The slides')}
        ${src(d.lectures_done, d.lectures_done ? 'What your lecturer said, exam hints first' : 'No lecture notes yet')}
        ${src(d.questions, d.questions ? `${d.questions} question${d.questions > 1 ? 's' : ''} you asked the tutor (the hard bits get their own cards)` : 'Your questions to the tutor (none yet)')}</ul>
      ${d.lectures_done ? '' : '<div class="muted small">Best after the lecture: record it (or import a transcript) and the cards follow what the lecturer stressed. They\'re made automatically when the notes are written.</div>'}
      <div class="actions"><button class="primary" data-ca="make">${icon('sparkle')}${d.error ? 'Try again' : 'Make flashcards'}</button></div></div>`;
    return;
  }
  const c = d.counts;
  const newNow = Math.min(c.new, cards.overview?.today?.new_left ?? c.new);
  let html = `<div class="deck-head">
      <div class="nums"><div><b>${c.due}</b><span>due</span></div><div><b>${c.new}</b><span>new</span></div><div><b>${c.mature}</b><span>of ${c.total - c.suspended} learned</span></div></div>
      ${masteryBar(d.cards.filter((x) => !x.suspended))}
      <div class="actions"><button class="primary" data-ca="study" ${c.due + newNow ? '' : 'disabled'}>${icon('cards')}${c.due + newNow ? `Study ${c.due + newNow} card${c.due + newNow > 1 ? 's' : ''}` : 'All caught up'}</button>
        <button class="ghost icon" data-ca="menu" title="More">${icon('dots')}</button></div>
    </div>`;
  if (job) html += `<div class="status-line"><span class="spinner"></span>${job.state === 'queued' ? 'Waiting to add cards…' : 'Adding cards…'}</div>`;
  else if (d.new_questions) html += `<div class="nudge">${icon('chat')}<span>You've asked ${d.new_questions} new question${d.new_questions > 1 ? 's' : ''} since these cards were made.</span><button class="small" data-ca="chats">Add cards</button></div>`;
  if (d.error && !job) html += `<div class="status-line warn">Last update failed: ${esc(d.error)}</div>`;
  for (const t of d.subtopics) {
    const cs = d.cards.filter((x) => x.subtopic === t.id);
    if (!cs.length) continue;
    const key = d.path + '#' + t.id, open = cards.open.has(key);
    const due = cs.filter((x) => !x.suspended && x.srs.state !== 'new' && (x.srs.due <= Date.now() / 1000 + 3600 * 6 || isLearning(x))).length;
    const fresh = cs.filter((x) => !x.suspended && x.srs.state === 'new').length;
    const here = t.slides?.includes(state.current);
    html += `<div class="sub${open ? ' open' : ''}${here ? ' here' : ''}" data-sub="${t.id}">
      <button class="sub-head">${icon('down', 'chev')}<span class="ttl">${esc(t.title)}</span><span class="cnt">${due ? `${due} due · ` : ''}${fresh ? `${fresh} new · ` : ''}${cs.length}</span></button>
      ${masteryBar(cs)}
      <div class="sub-body">${t.summary ? `<div class="sum">${esc(t.summary)}${t.slides?.length ? ` · slides ${t.slides[0]}–${t.slides.at(-1)}` : ''}</div>` : ''}
        <button class="small" data-ca="studysub" data-sid="${t.id}">${icon('cards')}Study this subtopic</button>
        ${cs.map(cardRow).join('')}</div></div>`;
  }
  pane.innerHTML = html;
}
function cardRow(c) {
  const open = cards.expanded === c.id, editing = cards.editing === c.id;
  const here = c.slides?.includes(state.current);
  let body = '';
  if (editing) body = editForm(c);
  else if (open) {
    body = `<div class="crd-back">${cardBack(c)}${c.why ? `<div class="why">${mdRender(c.why)}</div>` : ''}</div>
      <div class="crd-acts"><button class="small ghost" data-ca="edit">${icon('edit')}Edit</button>
        <button class="small ghost" data-ca="suspend">${icon('pause-card')}${c.suspended ? 'Unsuspend' : 'Suspend'}</button>
        ${c.srs.reps ? `<button class="small ghost" data-ca="reset">${icon('history')}Forget</button>` : ''}
        <button class="small ghost danger" data-ca="del">${icon('trash')}Delete</button></div>`;
  }
  return `<div class="crd${open || editing ? ' open' : ''}${here ? ' here' : ''}${c.suspended ? ' off' : ''}" data-card="${c.id}">
    <div class="crd-front">${cardFront(c)}</div>
    <div class="crd-meta">${badges(c)}${(c.slides || []).map((n) => `<a class="slide-ref" data-slide="${n}">slide ${n}</a>`).join('')}${dueText(c)}</div>${body}</div>`;
}
function editForm(c) {
  return `<div class="crd-edit"><label>${c.type === 'cloze' ? 'Text (hide a part with {{c::…}})' : 'Question'}<textarea data-f="front" rows="3">${esc(c.front)}</textarea></label>
    <label>${c.type === 'cloze' ? 'Extra (optional)' : 'Answer'}<textarea data-f="back" rows="3">${esc(c.back)}</textarea></label>
    <label>Why it matters (optional)<textarea data-f="why" rows="2">${esc(c.why || '')}</textarea></label>
    <div class="crd-acts"><button class="small ghost" data-ca="cancel">Cancel</button><button class="small primary" data-ca="save">Save</button></div></div>`;
}
function markCardsHere() {
  if (panelTab !== 'cards' || !cards.deck?.cards?.length) return;
  const byId = new Map(cards.deck.cards.map((c) => [c.id, c]));
  $('#cardsPane').querySelectorAll('[data-card]').forEach((el) => el.classList.toggle('here', !!byId.get(el.dataset.card)?.slides?.includes(state.current)));
  $('#cardsPane').querySelectorAll('[data-sub]').forEach((el) => el.classList.toggle('here', !!cards.deck.subtopics.find((t) => t.id === el.dataset.sub)?.slides?.includes(state.current)));
}
async function editCard(path, id, change) {
  const r = await post('/api/cards/edit', { path, id, ...change });
  if (r.error) { toast(r.error, true); return null; }
  return r.card;
}
$('#cardsPane').addEventListener('click', async (e) => {
  const d = cards.deck;
  const b = e.target.closest('[data-ca]'), a = b?.dataset.ca;
  if (e.target.closest('.slide-ref')) return;  // handled globally (jump to the slide)
  const row = e.target.closest('[data-card]'), card = row && d.cards.find((c) => c.id === row.dataset.card);
  if (a === 'make') return makeCards(d.path);
  if (a === 'study') return startStudy('deck:' + d.path, '', d.title);
  if (a === 'studysub') return startStudy('deck:' + d.path, b.dataset.sid, d.subtopics.find((t) => t.id === b.dataset.sid)?.title);
  if (a === 'chats') return makeCards(d.path, 'auto', 'chats');
  if (a === 'menu') {
    const r = b.getBoundingClientRect(), m = $('#cardsMenu');
    m.querySelector('[data-cm="chats"]').hidden = !d.questions;
    m.hidden = false;
    m.style.left = Math.max(8, r.right - m.offsetWidth) + 'px';
    m.style.top = r.bottom + 6 + 'px';
    return;
  }
  if (card && a === 'edit') { cards.editing = card.id; return renderCardsPane(); }
  if (card && a === 'cancel') { cards.editing = null; return renderCardsPane(); }
  if (card && a === 'save') {
    const f = Object.fromEntries([...row.querySelectorAll('[data-f]')].map((t) => [t.dataset.f, t.value]));
    const upd = await editCard(d.path, card.id, f);
    if (upd) Object.assign(card, upd);
    cards.editing = null;
    return renderCardsPane();
  }
  if (card && a === 'suspend') { Object.assign(card, await editCard(d.path, card.id, { suspended: !card.suspended }) || {}); loadCardsOverview(); return renderCardsPane(); }
  if (card && a === 'reset' && confirm('Forget your progress on this card? It becomes a new card again.')) { Object.assign(card, await editCard(d.path, card.id, { reset: true }) || {}); loadCardsOverview(); return renderCardsPane(); }
  if (card && a === 'del' && confirm('Delete this card?')) {
    if (await editCard(d.path, card.id, { delete: true })) d.cards = d.cards.filter((c) => c !== card);
    loadCardsOverview();
    return renderCardsPane();
  }
  if (b) return;
  const head = e.target.closest('.sub-head');
  if (head) {
    const key = d.path + '#' + head.parentElement.dataset.sub;
    cards.open.has(key) ? cards.open.delete(key) : cards.open.add(key);
    store.set('cardsOpen', [...cards.open].slice(-200));
    head.parentElement.classList.toggle('open');
    return;
  }
  if (card && !cards.editing && !e.target.closest('.crd-edit') && !window.getSelection()?.toString()) {
    cards.expanded = cards.expanded === card.id ? null : card.id;
    renderCardsPane();
  }
});
$('#cardsMenu').addEventListener('click', async (e) => {
  const a = e.target.closest('button')?.dataset.cm, d = cards.deck;
  $('#cardsMenu').hidden = true;
  if (!a || !d) return;
  if (a === 'chats') makeCards(d.path, 'auto', 'chats');
  if (a === 'rebuild' && confirm('Rewrite the cards you haven\'t studied yet?\n\nCards you\'ve already reviewed (and their progress) are kept; the rest are written again from the slides, lecture notes and your questions.')) makeCards(d.path, 'rebuild');
  if (a === 'export') {
    const r = await post('/api/cards/export', { path: d.path });
    if (r.error) return toast(r.error, true);
    post('/api/reveal', { path: r.file });
    toast(`Saved ${r.count} cards for Anki. In Anki: File → Import, and pick this file.`, false, 8000);
  }
  if (a === 'delete' && confirm(`Delete all ${d.cards.length} flashcards for "${d.title}", including your review history?`)) {
    await post('/api/cards/delete-deck', { path: d.path });
    loadDeckCards(d.path); loadCardsOverview();
  }
});
window.addEventListener('mousedown', (e) => { if (!e.target.closest('#cardsMenu') && !e.target.closest('[data-ca="menu"]')) $('#cardsMenu').hidden = true; });

// ---------- slide pictures for the back of a card (dual coding: the words plus the slide they came from) ----------
const thumbDocs = new Map(), thumbs = new Map();
async function slideThumb(path, n, width = 640) {
  const key = `${path}#${n}`;
  if (!thumbs.has(key)) {
    thumbs.set(key, (async () => {
      let doc = path === state.path ? state.pdf : null;
      if (!doc) {
        if (!thumbDocs.has(path)) {
          thumbDocs.set(path, pdfjsLib.getDocument({ url: '/api/pdf?path=' + encodeURIComponent(path), httpHeaders: H }).promise);
          if (thumbDocs.size > 4) { const [k, p] = thumbDocs.entries().next().value; thumbDocs.delete(k); p.then((x) => x.destroy()).catch(() => {}); }
        }
        doc = await thumbDocs.get(path);
      }
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp }).promise;
      return c.toDataURL('image/jpeg', 0.85);
    })().catch((e) => { thumbs.delete(key); throw e; }));
  }
  return thumbs.get(key);
}

// ---------- studying: active recall, then rate how well you remembered ----------
let study = null;
async function startStudy(scope = 'all', subtopic = '', title = '') {
  let r;
  try { r = await (await api(`/api/cards/queue?scope=${encodeURIComponent(scope)}&subtopic=${encodeURIComponent(subtopic)}`)).json(); }
  catch { return toast('Couldn\'t load your cards', true); }
  study = { scope, subtopic, title: title || 'All courses', main: r.cards.filter((c) => !isLearning(c)), learning: r.cards.filter(isLearning),
            learnAhead: r.learn_ahead, moreNew: r.more_new, cur: null, revealed: false, done: 0, firstTry: 0, seen: new Set(), history: [], busy: false };
  study.total = r.cards.length;
  $('#hub').hidden = true;
  $('#study').hidden = false;
  document.body.classList.add('studying');
  nextCard();
}
function closeStudy() {
  $('#study').hidden = true;
  study = null;
  if ($('#hub').hidden) document.body.classList.remove('studying');
  loadCardsOverview();
  if (state.path) loadDeckCards(state.path);
}
function nextCard() {
  const now = Date.now() / 1000;
  study.learning.sort((a, b) => a.srs.due - b.srs.due);
  const l = study.learning[0];
  let c = null;
  if (l && l.srs.due <= now) c = study.learning.shift();
  else if (study.main.length) c = study.main.shift();
  else if (l && l.srs.due - now <= study.learnAhead) c = study.learning.shift();  // nothing else left: show it a little early
  Object.assign(study, { cur: c, revealed: false, typed: '', editing: false });
  renderStudy();
}
const remaining = () => study.main.length + study.learning.length + (study.cur ? 1 : 0);
function renderStudy() {
  const el = $('#study'), c = study.cur;
  const left = remaining(), prog = study.total ? Math.min(1, study.done / (study.done + left)) : 1;
  const top = `<div class="study-top">
      <button class="ghost icon" data-sa="close" title="Close (Esc)">${icon('x')}</button>
      <div class="ttl">${icon('cards')}<span>${esc(study.title)}</span></div>
      <div class="prog"><i style="width:${100 * prog}%"></i></div>
      <span class="left">${left ? `${left} left` : ''}</span>
      <button class="ghost icon" data-sa="undo" title="Undo last answer (Z)" ${study.history.length ? '' : 'disabled'}>${icon('undo')}</button>
    </div>`;
  if (!c) {
    const pct = study.seen.size ? Math.round(100 * study.firstTry / study.seen.size) : 0;
    const later = study.learning.length ? study.learning[0].srs.due : 0;
    el.innerHTML = top + `<div class="study-done">
      <div class="big">${study.done ? 'Session done' : 'Nothing due right now'}</div>
      ${study.done ? `<p>${study.done} review${study.done > 1 ? 's' : ''} · ${study.seen.size} card${study.seen.size > 1 ? 's' : ''} · remembered ${pct}% on the first try.</p>` : '<p>Every card here is scheduled for later. Coming back when they\'re due is what makes them stick.</p>'}
      ${later ? `<p class="muted">${study.learning.length} card${study.learning.length > 1 ? 's are' : ' is'} still in learning: back at ${new Date(later * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</p>` : ''}
      ${study.moreNew ? `<p class="muted">${study.moreNew} more new card${study.moreNew > 1 ? 's' : ''} wait${study.moreNew > 1 ? '' : 's'} for the next few days (${cards.overview?.today?.new_limit ?? 20} new a day, change it in Settings).</p>` : ''}
      <div class="actions"><button class="primary" data-sa="close">Done</button><button data-sa="hub">${icon('cards')}All flashcards</button></div></div>`;
    return;
  }
  const meta = `<div class="meta"><span>${esc(courseLabel(c.course))} · ${esc(c.deck_title || '')}${c.subtopic_title ? ' · ' + esc(c.subtopic_title) : ''}</span>${badges(c)}
      <span class="sp"></span><button class="small ghost" data-sa="edit" title="Edit this card">${icon('edit')}Edit</button>
      <button class="small ghost" data-sa="suspend" title="Don't show this card again">${icon('pause-card')}Suspend</button></div>`;
  let body;
  if (study.editing) {
    body = `<div class="face">${editForm(c)}</div>`;
  } else if (!study.revealed) {
    body = `<div class="face front">${cardFront(c, false)}</div>
      ${c.type === 'problem' ? '<div class="hint">Work it out on paper first, then check.</div>' : ''}
      <textarea id="typed" rows="2" placeholder="Say it or type it from memory first (optional). Enter shows the answer."></textarea>
      <div class="reveal"><button class="primary" data-sa="reveal">Show answer<kbd>Space</kbd></button></div>`;
  } else {
    const slides = (c.slides || []).slice(0, 2);
    body = `<div class="face front small">${cardFront(c, false)}</div>
      ${study.typed ? `<div class="yours"><span class="lbl">You said</span>${esc(study.typed)}</div>` : ''}
      <div class="face back">${cardBack(c, false)}</div>
      ${c.why ? `<div class="why">${mdRender(c.why, false)}</div>` : ''}
      <div class="from">${slides.map((n) => `<button class="thumb" data-sa="slide" data-n="${n}" title="Open slide ${n}"><img data-thumb="${n}" alt=""><span>Slide ${n}</span></button>`).join('')}
        <button class="small ghost" data-sa="ask">${icon('sparkle')}Still unclear? Ask the tutor</button></div>`;
  }
  const rate = study.revealed && !study.editing ? `<div class="study-rate">${RATE.map(([g, l]) => `<button data-rate="${g}" class="r${g}"><b>${l}</b><span>${c.previews?.[g] || ''}</span><kbd>${g}</kbd></button>`).join('')}</div>` : '';
  el.innerHTML = top + `<div class="study-scroll"><div class="study-card${study.revealed ? ' revealed' : ''}">${meta}${body}</div></div>${rate}`;
  if (study.revealed) {
    el.querySelectorAll('img[data-thumb]').forEach((img) => slideThumb(c.path, +img.dataset.thumb).then((u) => { img.src = u; }, () => img.closest('.thumb').remove()));
  } else if (!study.editing) {
    const t = $('#typed');
    t.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); reveal(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); t.blur(); }
    });
  }
}
function reveal() {
  if (!study?.cur || study.revealed) return;
  study.typed = ($('#typed')?.value || '').trim();
  study.revealed = true;
  renderStudy();
}
async function rate(g) {
  const c = study?.cur;
  if (!c || !study.revealed || study.busy) return;
  study.busy = true;
  let r;
  try { r = await post('/api/cards/review', { path: c.path, id: c.id, rating: g }); } finally { if (study) study.busy = false; }
  if (!study) return;
  if (r.error) return toast(r.error, true);
  study.history.push({ card: c, g, firstSeen: !study.seen.has(c.id) });
  if (!study.seen.has(c.id)) { study.seen.add(c.id); if (g > 1) study.firstTry++; }
  study.done++;
  const upd = { ...c, ...r.card };
  if (isLearning(upd)) study.learning.push(upd);  // back again in a few minutes
  if (upd.leech && !c.leech) toast('This card keeps slipping. Try "Ask the tutor" for a different angle, or reword it with Edit.', false, 7000);
  nextCard();
}
async function undoLast() {
  const h = study?.history.pop();
  if (!h) return;
  const r = await post('/api/cards/undo', { path: h.card.path, id: h.card.id });
  if (r.error) return toast(r.error, true);
  study.learning = study.learning.filter((x) => x.id !== h.card.id);
  study.main = study.main.filter((x) => x.id !== h.card.id);
  if (study.cur && study.cur.id !== h.card.id) study.main.unshift(study.cur);
  study.done--;
  if (h.firstSeen) { study.seen.delete(h.card.id); if (h.g > 1) study.firstTry--; }
  Object.assign(study, { cur: { ...h.card, ...r.card }, revealed: true, editing: false });
  renderStudy();
}
async function askAboutCard(c) {
  const slide = c.slides?.[0];
  closeStudy();
  if (state.path !== c.path) await openPdf(c.path, slide);
  else if (slide) goTo(slide);
  setPanelTab('chat');
  const answer = c.type === 'cloze' ? plainCard(c.front) + (c.back ? ' ' + c.back : '') : c.back;
  ask(`I'm revising with flashcards and this one didn't stick:\n\nQ: ${c.type === 'cloze' ? c.front.replace(CLOZE_RE, '[…]') : c.front}\nA: ${answer}\n\nHelp me actually understand it (a different angle from the card, tied to the slides), then check me with one quick question.`);
}
$('#study').addEventListener('click', async (e) => {
  const rb = e.target.closest('[data-rate]');
  if (rb) return rate(+rb.dataset.rate);
  const a = e.target.closest('[data-sa], [data-ca]');
  const act = a?.dataset.sa || a?.dataset.ca, c = study?.cur;
  if (act === 'close') return closeStudy();
  if (act === 'hub') { closeStudy(); return openHub(); }
  if (act === 'reveal') return reveal();
  if (act === 'undo') return undoLast();
  if (!c) return;
  if (act === 'ask') return askAboutCard(c);
  if (act === 'slide') { const n = +a.dataset.n; closeStudy(); return state.path === c.path ? goTo(n) : openPdf(c.path, n); }
  if (act === 'edit') { study.editing = true; return renderStudy(); }
  if (act === 'cancel') { study.editing = false; return renderStudy(); }
  if (act === 'save') {
    const f = Object.fromEntries([...$('#study').querySelectorAll('[data-f]')].map((t) => [t.dataset.f, t.value]));
    const upd = await editCard(c.path, c.id, f);
    if (upd) Object.assign(c, { front: upd.front, back: upd.back, why: upd.why, type: upd.type });
    study.editing = false;
    return renderStudy();
  }
  if (act === 'suspend') {
    if (await editCard(c.path, c.id, { suspended: true })) { toast('Suspended: it won\'t come up again (unsuspend it from the Cards tab).'); study.total--; nextCard(); }
  }
});

// ---------- the hub: everything due, per course and lecture ----------
function openHub() {
  $('#hub').hidden = false;
  document.body.classList.add('studying');
  renderHub();
  loadCardsOverview();
}
function closeHub() { $('#hub').hidden = true; if ($('#study').hidden) document.body.classList.remove('studying'); }
function renderHub() {
  const ov = cards.overview;
  const el = $('#hub');
  if (!ov) { el.innerHTML = '<div class="hub-wrap"><span class="spinner"></span>Loading…</div>'; return; }
  const t = ov.today, { due, fresh, newToday } = totals();
  const byCourse = {};
  ov.decks.forEach((d) => (byCourse[d.course || ''] ||= []).push(d));
  const courses = Object.keys(byCourse).sort((a, b) => courseLabel(a).localeCompare(courseLabel(b)));
  const deckRow = (d) => {
    const c = d.counts, n = c.total - c.suspended || 1;
    return `<div class="hub-deck">
      <button class="name" data-ha="open" data-path="${esc(d.path)}" title="Open this deck">${esc(d.title || '')}</button>
      <span class="cnt">${c.due ? `<b>${c.due}</b> due · ` : ''}${c.new} new · ${c.mature}/${c.total - c.suspended} learned${d.new_questions ? ` · ${icon('chat')}${d.new_questions}` : ''}</span>
      <div class="mbar"><i class="l" style="width:${100 * c.mature / n}%"></i><i class="s" style="width:${100 * (n - c.new - c.mature) / n}%"></i></div>
      ${d.job ? `<span class="muted small"><span class="spinner"></span>${d.job.state === 'queued' ? 'waiting' : 'adding cards'}</span>` : ''}
      <button class="small" data-ha="study" data-scope="deck:${esc(d.path)}" data-title="${esc(d.title || '')}" ${c.due + Math.min(c.new, t.new_left) ? '' : 'disabled'}>Study</button></div>`;
  };
  const backlog = ov.backlog.map((b) => `<div class="hub-deck">
      <span class="name plain">${esc(b.title || '')}<span class="muted small"> · ${esc(courseLabel(b.course))}${b.date ? ' · ' + esc(b.date) : ''}</span></span>
      ${b.job ? `<span class="muted small"><span class="spinner"></span>${b.job.state === 'queued' ? 'waiting' : 'writing cards…'}</span>` : b.error ? `<span class="warn small" title="${esc(b.error)}">failed</span>` : ''}
      ${b.job ? '' : `<button class="small" data-ha="make" data-path="${esc(b.path)}">${b.error ? 'Retry' : 'Make cards'}</button>`}</div>`).join('');
  const idle = ov.backlog.filter((b) => !b.job);
  el.innerHTML = `<div class="hub-wrap">
    <div class="hub-top"><h1>${icon('cards')}Flashcards</h1><button class="ghost icon" data-ha="close" title="Close (Esc)">${icon('x')}</button></div>
    <div class="tiles">
      <div><b>${due}</b><span>due today</span></div>
      <div><b>${newToday}</b><span>new today${fresh > newToday ? ` (of ${fresh})` : ''}</span></div>
      <div><b>${t.reviewed}</b><span>reviewed today</span></div>
      <div><b>${t.streak}</b><span>day streak</span></div>
    </div>
    <div class="hub-go"><button class="primary big" data-ha="study" data-scope="all" ${due + newToday ? '' : 'disabled'}>${icon('cards')}${due + newToday ? `Study everything due (${due + newToday})` : ov.decks.length ? 'All caught up for today' : 'No cards yet'}</button>
      <span class="muted small">Mixed across your courses: switching between topics feels harder, but it sticks better than one topic at a time.</span></div>
    ${courses.map((co) => {
      const ds = byCourse[co], cd = ds.reduce((a, d) => a + d.counts.due, 0), cn = ds.reduce((a, d) => a + d.counts.new, 0);
      return `<section class="hub-course"><div class="hc-head"><b>${esc(courseLabel(co))}</b><span class="muted small">${cd ? `${cd} due · ` : ''}${cn} new</span>
        <button class="small ghost" data-ha="study" data-scope="course:${esc(co)}" data-title="${esc(courseLabel(co))}" ${cd + Math.min(cn, t.new_left) ? '' : 'disabled'}>Study course</button></div>
        ${ds.sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { numeric: true })).map(deckRow).join('')}</section>`;
    }).join('')}
    ${ov.backlog.length ? `<section class="hub-course"><div class="hc-head"><b>Lectures without flashcards yet</b><span class="muted small">they have lecture notes</span>
        ${idle.length > 1 ? `<button class="small ghost" data-ha="makeall">Make all ${idle.length}</button>` : ''}</div>${backlog}</section>` : ''}
    ${!ov.decks.length && !ov.backlog.length ? '<div class="state-card"><b>No flashcards yet</b>Record a lecture (or open a deck and use the Cards tab). When the lecture notes are written, its flashcards are made automatically.</div>' : ''}
    <details class="how"><summary>How this works</summary>
      <ul><li><b>Active recall.</b> You see the question first and answer from memory (say it, or type it) before you look. Pulling it out of memory is what strengthens it; re-reading isn't.</li>
      <li><b>Spaced repetition.</b> How you rate each card (Again / Hard / Good / Easy) sets when it comes back. FSRS, the scheduler Anki uses, aims for the moment you're about to forget, so easy cards drift months away and hard ones come back tomorrow.</li>
      <li><b>What gets a card.</b> Each lecture's cards come from the slides and what the lecturer said. ${icon('star')} marks points they flagged as examinable, and ${icon('chat')} marks cards made from the questions you asked the tutor, because those are the bits you found hard.</li>
      <li><b>Subject-aware.</b> Philosophy gets arguments, objections and distinctions. Maths gets formulas, derivation steps and short problems to do on paper. Code gets "what does this do / output" cards.</li></ul></details>
  </div>`;
}
$('#hub').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-ha]');
  if (!b) return;
  const a = b.dataset.ha;
  if (a === 'close') return closeHub();
  if (a === 'study') return startStudy(b.dataset.scope, '', b.dataset.title);
  if (a === 'open') { closeHub(); await openPdf(b.dataset.path); return setPanelTab('cards'); }
  if (a === 'make') { await makeCards(b.dataset.path, 'auto', 'lecture'); return toast('Writing flashcards: you can keep going, they appear when ready.'); }
  if (a === 'makeall') {
    const paths = cards.overview.backlog.filter((x) => !x.job).map((x) => x.path);
    await post('/api/cards/make', { paths, why: 'lecture' });
    toast(`Writing flashcards for ${paths.length} lectures, one at a time. This takes a while; you can keep studying.`, false, 7000);
    loadCardsOverview();
  }
});
$('#btnReview').onclick = openHub;

// Keys while the hub or a study session is open (they win over the viewer's shortcuts).
window.addEventListener('keydown', (e) => {
  if (!overlayOpen()) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopImmediatePropagation();
    if (typing) return document.activeElement.blur();
    if (!$('#study').hidden) { if (study?.editing) { study.editing = false; return renderStudy(); } return closeStudy(); }
    return closeHub();
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || $('#study').hidden) { if (!e.metaKey && !e.ctrlKey && !typing) e.stopImmediatePropagation(); return; }
  e.stopImmediatePropagation();
  if (!study?.cur || study.editing) return;
  if ((e.key === ' ' || e.key === 'Enter') && !study.revealed) { e.preventDefault(); reveal(); }
  else if (/^[1-4]$/.test(e.key) && study.revealed) { e.preventDefault(); rate(+e.key); }
  else if (e.key === ' ' && study.revealed) { e.preventDefault(); rate(3); }  // Anki habit: space = Good
  else if (e.key === 'z' || e.key === 'Z') undoLast();
}, { capture: true });
window.addEventListener('keydown', (e) => {  // ⌘Z undoes the last answer while studying
  if (!$('#study').hidden && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) {
    e.preventDefault(); e.stopImmediatePropagation(); undoLast();
  }
}, { capture: true });

// ---------- panel tabs ----------
function setPanelTab(tab) {
  panelTab = tab;
  store.set('panelTab', tab);
  document.body.classList.toggle('tab-notes', tab === 'notes');
  document.body.classList.toggle('tab-cards', tab === 'cards');
  document.querySelectorAll('#panelTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  showChat();
  if (tab === 'notes') renderNotes();
  if (tab === 'cards') { renderCardsPane(); if (state.path && cards.deck?.path !== state.path) loadDeckCards(); }
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
  pick.innerHTML = lec.list.map((l) => `<option value="${l.id}">${esc(l.date)} · ${{ imported: 'imported', replay: 'Re/Play' }[l.source] || 'recorded'}${l.status !== 'done' ? ' · ' + l.status : ''}</option>`).join('');
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
      ${q.start != null && d.has_audio && !q.lecture ? `<button class="play" data-t="${q.start}">${icon('play')}${fmtT(q.start)}</button>`
        : q.start != null && m.replay_url && !q.lecture ? `<a class="muted small" href="${esc(m.replay_url)}?playFrom=${Math.round(q.start * 1000)}" title="Watch this moment on Re/Play">${fmtT(q.start)} ↗</a>`
        : (q.start != null ? `<span class="muted small">${fmtT(q.start)}</span>` : '')}
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
  if (a === 'delete' && rec?.id === lec.cur) discardRecording();
  else if (a === 'delete' && lec.cur && confirm('Delete this lecture? Its recording, transcript and notes (including the Markdown files) are removed.')) {
    post('/api/lecture/delete', { id: lec.cur }).then(() => { lec.cur = null; loadLectures(state.path); });
  }
});
window.addEventListener('mousedown', (e) => { if (!e.target.closest('#notesMenu') && !e.target.closest('#btnNotesMenu')) notesMenu.hidden = true; });
setPanelTab(panelTab);

// =====================================================================================
// Find in slides (⌘F / Ctrl+F)
// =====================================================================================
const find = {
  q: '', matches: [], cur: -1, pageText: {}, token: 0,
  async pageItems(n) {  // text items of a page, cached (same order as the text layer's spans)
    if (!this.pageText[n]) {
      const tc = await (await state.pdf.getPage(n)).getTextContent();
      this.pageText[n] = tc.items.filter((it) => 'str' in it).map((it) => it.str);
    }
    return this.pageText[n];
  },
  reset() { this.matches = []; this.cur = -1; this.pageText = {}; },
  async search(q) {
    this.q = q.trim().toLowerCase();
    const token = ++this.token;
    this.matches = []; this.cur = -1;
    this.clearAll();
    if (!this.q || !state.pdf) return this.updateCount();
    for (let n = 1; n <= state.pdf.numPages; n++) {
      const items = await this.pageItems(n);
      if (token !== this.token) return;  // a newer search started
      const full = items.join('').toLowerCase();
      let i = full.indexOf(this.q);
      while (i >= 0) { this.matches.push({ page: n, start: i, end: i + this.q.length }); i = full.indexOf(this.q, i + 1); }
      if (n % 10 === 0) this.updateCount(true);
    }
    // Start from the first match at or after the slide you're on.
    const from = this.matches.findIndex((m) => m.page >= state.current);
    this.cur = this.matches.length ? (from >= 0 ? from : 0) : -1;
    this.updateCount();
    state.pages.forEach((p, i) => this.paintPage(i + 1));
    this.reveal();
  },
  step(d) {
    if (!this.matches.length) return;
    const prevPage = this.matches[this.cur]?.page;
    this.cur = (this.cur + d + this.matches.length) % this.matches.length;
    this.updateCount();
    if (prevPage) this.paintPage(prevPage);
    this.paintPage(this.matches[this.cur].page);
    this.reveal();
  },
  reveal() {
    const m = this.matches[this.cur];
    if (!m) return;
    if (m.page !== state.current) goTo(m.page, false);
    requestAnimationFrame(() => {  // centre the match inside the slide viewer only (never scroll the window)
      const mk = document.querySelector(`.page[data-page="${m.page}"] mark.current`);
      if (!mk) return;
      const vr = viewer.getBoundingClientRect(), r = mk.getBoundingClientRect();
      if (r.top < vr.top + 60 || r.bottom > vr.bottom - 40) viewer.scrollTop += r.top - vr.top - viewer.clientHeight / 2;
    });
  },
  updateCount(partial = false) {
    const n = this.matches.length;
    $('#findCount').textContent = !this.q ? '' : n ? `${this.cur + 1 || 1} of ${n}${partial ? '…' : ''}` : (partial ? 'Searching…' : 'No results');
    $('#findBar').classList.toggle('none', !!this.q && !n && !partial);
  },
  clearPage(p) {
    p.div?.querySelectorAll('.textLayer mark').forEach((mk) => { const s = mk.parentNode; s.replaceChildren(document.createTextNode(s.textContent)); });
  },
  clearAll() { state.pages.forEach((p) => this.clearPage(p)); },
  // Wrap the matched characters (which can span several text spans) in <mark>.
  paintPage(n) {
    const p = state.pages[n - 1];
    if (!p?.textDivs) return;
    this.clearPage(p);
    const ms = this.matches.map((m, idx) => ({ ...m, idx })).filter((m) => m.page === n);
    if (!ms.length) return;
    const offs = []; let acc = 0;
    p.itemsStr.forEach((s) => { offs.push(acc); acc += s.length; });
    const perDiv = new Map();
    for (const m of ms) {
      for (let k = 0; k < p.itemsStr.length; k++) {
        const a = offs[k], b = a + p.itemsStr[k].length;
        if (b <= m.start || a >= m.end) continue;
        (perDiv.get(k) || perDiv.set(k, []).get(k)).push([Math.max(m.start, a) - a, Math.min(m.end, b) - a, m.idx === this.cur]);
      }
    }
    for (const [k, ranges] of perDiv) {
      const div = p.textDivs[k], text = p.itemsStr[k];
      if (!div) continue;
      const frag = document.createDocumentFragment(); let pos = 0;
      ranges.sort((x, y) => x[0] - y[0]).forEach(([s, e, cur]) => {
        if (s > pos) frag.append(text.slice(pos, s));
        const mk = document.createElement('mark'); mk.textContent = text.slice(s, e); if (cur) mk.className = 'current';
        frag.append(mk); pos = e;
      });
      if (pos < text.length) frag.append(text.slice(pos));
      div.replaceChildren(frag);
    }
  },
};
function openFind() {
  if (!state.pdf) return;
  $('#findBar').hidden = false;
  const sel = String(window.getSelection() || '').trim();
  if (sel && sel.length < 80 && !sel.includes('\n')) $('#findInput').value = sel;
  $('#findInput').focus(); $('#findInput').select();
  if ($('#findInput').value.trim().toLowerCase() !== find.q) find.search($('#findInput').value);
}
function closeFind() { $('#findBar').hidden = true; find.q = ''; find.matches = []; find.clearAll(); $('#findInput').blur(); }
let findT;
$('#findInput').addEventListener('input', () => { clearTimeout(findT); findT = setTimeout(() => find.search($('#findInput').value), 180); });
$('#findInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); find.step(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
});
$('#findPrev').onclick = () => find.step(-1);
$('#findNext').onclick = () => find.step(1);
$('#findClose').onclick = closeFind;
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f' && state.pdf && !overlayOpen()) { e.preventDefault(); openFind(); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g' && !$('#findBar').hidden) { e.preventDefault(); find.step(e.shiftKey ? -1 : 1); }
}, { capture: true });

(async () => {
  cfg = await (await api('/api/config')).json();
  loadModels();
  loadCardsOverview();
  await loadLibrary();
  if (!cfg.setup_done) openSettings(true);
  const params = new URLSearchParams(location.search);
  const file = params.get('file') || store.get('lastPath', null);
  if (file) openPdf(file, +params.get('page') || undefined);
  else setChatMode(state.chatMode);
  document.querySelectorAll('#chatMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.chatMode));
})();
