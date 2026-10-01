const SERVER = 'http://127.0.0.1:8767';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'page', title: 'Open this PDF in SlideMate', contexts: ['page', 'frame'] });
  chrome.contextMenus.create({ id: 'link', title: 'Open linked PDF in SlideMate', contexts: ['link'] });
});
chrome.action.onClicked.addListener((tab) => openInSlideMate(tab.url));
chrome.contextMenus.onClicked.addListener((info, tab) => openInSlideMate(info.menuItemId === 'link' ? info.linkUrl : (info.frameUrl || tab.url)));

function notify(msg) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icon128.png', title: 'SlideMate', message: msg });
}

function openApp(query) {
  chrome.windows.create({ url: `${SERVER}/${query}`, type: 'popup', width: 1500, height: 950 });
}

async function openInSlideMate(url) {
  if (!url) return;
  try {
    if (url.startsWith('file://')) {
      openApp('?file=' + encodeURIComponent(decodeURIComponent(new URL(url).pathname)));
      return;
    }
    // Chrome's PDF viewer sometimes wraps the real URL.
    const inner = url.match(/[?&]src=([^&]+)/);
    if (url.startsWith('chrome-extension://') && inner) url = decodeURIComponent(inner[1]);
    const res = await fetch(url, { credentials: 'include' }); // uses your logged-in session (e.g. Blackboard)
    const blob = await res.blob();
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (String.fromCharCode(...head) !== '%PDF') return notify("This page isn't a PDF.");
    let name = decodeURIComponent(new URL(res.url).pathname.split('/').pop() || 'slides.pdf');
    const cd = res.headers.get('content-disposition');
    const m = cd && cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
    if (m) name = decodeURIComponent(m[1]);
    const up = await fetch(`${SERVER}/api/upload`, {
      method: 'POST', body: blob, headers: { 'X-SlideMate': '1', 'X-Filename': encodeURIComponent(name) },
    });
    const { path, error } = await up.json();
    if (error) return notify(error);
    openApp('?file=' + encodeURIComponent(path));
  } catch (e) {
    notify('Could not reach SlideMate — open the SlideMate app once, then try again. (' + e.message + ')');
  }
}
