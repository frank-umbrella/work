// ==UserScript==
// @name         Tack - sticky notes on any site
// @namespace    https://github.com/frank-umbrella/work
// @version      0.1.1
// @description  Post-it style sticky notes pinned on top of any website. Draggable, resizable, collapsible, six skins, six colors. Notes stick to this page, this site, or everywhere. Saved in the browser, with optional backup and sync through your own Google Drive.
// @author       Umbrella Automation
// @match        *://*/*
// @exclude      *://accounts.google.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      www.googleapis.com
// @homepageURL  https://frank-umbrella.github.io/work/tack/
// @supportURL   https://github.com/frank-umbrella/work/issues
// @updateURL    https://frank-umbrella.github.io/work/tack/tack.user.js
// @downloadURL  https://frank-umbrella.github.io/work/tack/tack.user.js
// ==/UserScript==

/*
 * HOW THIS WORKS
 * --------------
 * Every note is a small object { id, text, color, scope, key, x, y, w, h,
 * min, z, created, updated }. All notes live in ONE Tampermonkey value
 * ("tack.notes") that is shared by every tab, so a note pinned "everywhere"
 * shows up on the next site you open without a reload.
 *
 *   scope "page" -> key is origin + path + query (no #hash)
 *   scope "site" -> key is the hostname
 *   scope "all"  -> key is "*"
 *
 * The UI is rendered inside a Shadow DOM under a <tack-notes> element that is
 * put in the browser TOP LAYER with the popover API, so it sits above host
 * overlays that use huge z-indexes. Styles are attached as a constructed
 * stylesheet (adoptedStyleSheets), which host CSP rules cannot block.
 *
 * Google Drive is optional. It uses the OAuth "implicit" flow: a popup to
 * accounts.google.com redirects to auth.html on the work site, and THIS
 * script (which also runs on that page) reads the token out of the URL hash
 * and stores it. The other tabs see the new token through
 * GM_addValueChangeListener. Notes are stored as one file (tack-notes.json)
 * that only this app can see (drive.file scope). Merge rule: newest wins per
 * note, and deletions travel as tombstones so a removed note never comes back.
 */

(function () {
  'use strict';

  var VERSION = '0.1.1';
  var AUTH_URL = 'https://frank-umbrella.github.io/work/tack/auth.html';
  var DRIVE_FILE = 'tack-notes.json';
  var COLORS = { yellow: '#fff59d', green: '#c8f7c5', blue: '#bde0fe', pink: '#ffc8dd', purple: '#e0c3fc', orange: '#ffd6a5' };
  var THEMES = ['postit', 'onenote', 'glass', 'umbrella', 'slate', 'paper'];
  var THEME_NAMES = { postit: 'Post-it', onenote: 'OneNote', glass: 'Glass', umbrella: 'Umbrella', slate: 'Slate', paper: 'Paper' };
  var SCOPE_LABEL = { page: 'This page', site: 'This site', all: 'Everywhere' };
  var TOMBSTONE_DAYS = 30;

  // ---------------------------------------------------------------- storage
  var store = {
    get: function (k, d) { try { var v = GM_getValue(k); return v === undefined ? d : v; } catch (_) { return d; } },
    set: function (k, v) { try { GM_setValue(k, v); } catch (_) {} }
  };
  var cfg = Object.assign({
    theme: 'glass', defaultScope: 'site', defaultColor: 'yellow',
    launcher: true, corner: 'br', hidden: {},
    drive: { clientId: '', token: '', exp: 0, fileId: '', auto: true, lastSync: 0, error: '' }
  }, store.get('tack.cfg', {}));
  cfg.drive = Object.assign({ clientId: '', token: '', exp: 0, fileId: '', auto: true, lastSync: 0, error: '' }, cfg.drive || {});
  var notes = store.get('tack.notes', []);
  var tombstones = store.get('tack.tombstones', {});

  function saveCfg() { store.set('tack.cfg', cfg); }
  function saveNotes() {
    notes.forEach(function (n) { n.updated = n.updated || Date.now(); });
    store.set('tack.notes', notes);
    store.set('tack.tombstones', tombstones);
    scheduleBackup();
  }

  // ------------------------------------------------ Drive auth callback page
  // The script also runs on auth.html; grab the token from the hash and stop.
  if (location.hostname === 'frank-umbrella.github.io' && location.pathname.indexOf('/work/tack/auth.html') === 0) {
    var h = new URLSearchParams(location.hash.replace(/^#/, ''));
    var tok = h.get('access_token');
    var msg = document.getElementById('tack-auth-msg');
    if (tok) {
      cfg.drive.token = tok;
      cfg.drive.exp = Date.now() + (parseInt(h.get('expires_in') || '3600', 10) - 60) * 1000;
      cfg.drive.error = '';
      saveCfg();
      history.replaceState(null, '', location.pathname);
      if (msg) msg.textContent = 'Connected. You can close this window.';
      setTimeout(function () { try { window.close(); } catch (_) {} }, 800);
    } else if (h.get('error')) {
      cfg.drive.error = 'Google said: ' + h.get('error');
      saveCfg();
      if (msg) msg.textContent = 'Google refused the sign-in (' + h.get('error') + '). Close this window and try again.';
    } else if (msg) {
      msg.textContent = 'Tack is installed. Open the settings on any site and click Connect Google Drive.';
    }
    return;
  }

  // ------------------------------------------------------------------ keys
  function pageKey() { return location.origin + location.pathname + location.search; }
  function siteKey() { return location.hostname; }
  function keyFor(scope) { return scope === 'page' ? pageKey() : scope === 'site' ? siteKey() : '*'; }
  function isVisible(n) {
    return n.scope === 'all' || (n.scope === 'site' && n.key === siteKey()) || (n.scope === 'page' && n.key === pageKey());
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function ago(t) {
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 2) return 'yesterday';
    return new Date(t).toLocaleDateString();
  }

  // -------------------------------------------------------------------- CSS
  var CSS = [
    ':host{all:initial;position:fixed !important;inset:0 !important;width:100vw !important;height:100vh !important;margin:0 !important;padding:0 !important;border:0 !important;',
    '  background:transparent !important;overflow:visible !important;pointer-events:none !important;z-index:2147483647 !important;color:inherit;}',
    '*{box-sizing:border-box}',
    '.tk{--c1:#fff59d;--c2:#c8f7c5;--c3:#bde0fe;--c4:#ffc8dd;--c5:#e0c3fc;--c6:#ffd6a5;--umb:#1A9BE8;--umb-deep:#0C5E9C;--storm:#1A1F2B;--graphite:#6E6E6E;--cloud:#E8EBEF;',
    '  position:absolute;inset:0;pointer-events:none;font-family:"Segoe UI",system-ui,sans-serif;font-size:13px;line-height:1.4;}',
    'button,textarea,select,input{font:inherit;color:inherit}',
    'textarea{resize:none;border:0;outline:0;background:transparent;width:100%;height:100%;padding:0;margin:0;display:block;line-height:inherit;font:inherit;color:inherit}',

    /* note layout */
    '.n{position:absolute;pointer-events:auto;width:240px;height:200px;display:flex;flex-direction:column;overflow:hidden;resize:both;min-width:150px;min-height:70px;max-width:92vw;max-height:92vh}',
    '.n.min{height:auto !important;resize:none;min-height:0}',
    '.n.min .bd,.n.min .ft,.n.min .pal,.n.min .pin{display:none}',
    '.hd{display:flex;align-items:center;gap:4px;padding:6px 8px;user-select:none;cursor:grab;font-size:12px;flex:none;touch-action:none}',
    '.hd:active{cursor:grabbing}',
    '.hd .t{flex:1;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.hd b{width:20px;height:20px;display:grid;place-items:center;border-radius:5px;font-weight:400;font-size:13px;cursor:pointer;opacity:.75;flex:none}',
    '.hd b svg{width:14px;height:14px;display:block;pointer-events:none}',
    '.n.min .hd .chev{transform:rotate(180deg)}',
    '.hd b:hover{opacity:1;background:rgba(0,0,0,.08)}',
    '.hd .dot{width:12px;height:12px;border-radius:50%;border:1.5px solid rgba(0,0,0,.25);margin-right:3px;flex:none;background:var(--c)}',
    '.hd .del{display:none;align-items:center;gap:4px;font-size:11px}',
    '.hd.confirm .del{display:flex}.hd.confirm .t,.hd.confirm b:not(.dy):not(.dn){display:none}',
    '.hd .del span{cursor:pointer;padding:2px 7px;border-radius:4px;background:rgba(0,0,0,.1)}',
    '.hd .del span.dy{background:#dc2626;color:#fff}',
    '.bd{flex:1;min-height:0;padding:4px 10px 6px;font-size:13.5px;line-height:1.45}',
    '.bd textarea{overflow:auto}',
    '.ft{display:flex;align-items:center;padding:3px 18px 5px 10px;font-size:10.5px;opacity:.55;flex:none}',
    '.pal,.pin{display:flex;gap:6px;padding:6px 10px;flex:none;align-items:center;font-size:12px}',
    '.pal i{width:18px;height:18px;border-radius:50%;cursor:pointer;border:2px solid rgba(0,0,0,.15)}',
    '.pal i.on{border-color:rgba(0,0,0,.6)}',
    '.pin span{cursor:pointer;padding:2px 8px;border-radius:999px;background:rgba(0,0,0,.08)}',
    '.pin span.on{background:rgba(0,0,0,.6);color:#fff}',

    /* launcher + menu */
    '.lp{position:absolute;pointer-events:auto;width:44px;height:44px;border-radius:50%;display:grid;place-items:center;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.25);user-select:none}',
    '.lp.br{right:22px;bottom:22px}.lp.bl{left:22px;bottom:22px}.lp.tr{right:22px;top:22px}.lp.tl{left:22px;top:22px}',
    '.lp svg{width:22px;height:22px}',
    '.lp em{position:absolute;top:-4px;right:-4px;background:#ef4444;color:#fff;font:700 10px/16px sans-serif;border-radius:999px;min-width:16px;padding:0 4px;text-align:center;font-style:normal}',
    '.lp.off{opacity:.55}',
    '.menu{position:absolute;pointer-events:auto;background:#fff;color:#1f2430;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.25),0 0 0 1px rgba(0,0,0,.06);padding:6px;min-width:190px;font-size:13px}',
    '.menu div{padding:7px 10px;border-radius:6px;cursor:pointer;white-space:nowrap}.menu div:hover{background:#eef2f7}',
    '.menu div.sub{opacity:.55;font-size:11px;cursor:default;padding-top:2px}.menu div.sub:hover{background:none}',
    '.menu hr{border:0;border-top:1px solid #e5e7eb;margin:5px 0}',

    /* settings panel */
    '.sp{position:absolute;pointer-events:auto;width:340px;max-width:92vw;max-height:92vh;display:flex;flex-direction:column;background:#fff;color:#1f2430;border-radius:10px;',
    '  box-shadow:0 14px 40px rgba(0,0,0,.3),0 0 0 1px rgba(0,0,0,.06);overflow:hidden;font-size:13px}',
    '.sp .hd{background:#f3f4f6;border-bottom:1px solid #e5e7eb;font-weight:600}',
    '.sp .sb{flex:1;min-height:0;overflow-y:auto;padding:10px 14px 14px}',
    '.sp h4{margin:12px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280}',
    '.sp label.row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 0;cursor:pointer}',
    '.sp select,.sp input[type=text]{border:1px solid #d1d5db;border-radius:6px;padding:5px 8px;background:#fff;min-width:0}',
    '.sp input[type=text]{width:100%}',
    '.sp .btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}',
    '.sp button{border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:6px 10px;cursor:pointer}',
    '.sp button:hover{background:#f3f4f6}.sp button.pri{background:#1A9BE8;border-color:#1A9BE8;color:#fff}.sp button.pri:hover{background:#0C5E9C}',
    '.sp .st{font-size:12px;color:#6b7280;margin-top:6px;word-break:break-word}.sp .st.err{color:#b91c1c}.sp .st.ok{color:#15803d}',
    '.sp .sw{display:flex;gap:6px}.sp .sw i{width:20px;height:20px;border-radius:50%;cursor:pointer;border:2px solid rgba(0,0,0,.12)}.sp .sw i.on{border-color:#111}',
    '.sp code{background:#f3f4f6;padding:1px 4px;border-radius:3px;font-size:11px;word-break:break-all}',
    '.sp .hint{font-size:11.5px;color:#6b7280;line-height:1.45;margin:4px 0}',
    '.toast{position:absolute;pointer-events:none;left:50%;top:18px;transform:translateX(-50%);background:#1A1F2B;color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.3);opacity:0;transition:opacity .2s}',
    '.toast.on{opacity:1}',

    /* ===== skins ===== */
    '.th-postit .n{background:var(--c);color:#3b3300;font-family:"Segoe Print","Bradley Hand","Comic Sans MS",cursive;border-radius:2px;box-shadow:2px 4px 10px rgba(0,0,0,.28),0 0 0 1px rgba(0,0,0,.04) inset}',
    '.th-postit .n::before{content:"";position:absolute;left:50%;top:0;transform:translateX(-50%);width:70px;height:12px;background:rgba(255,255,255,.55);box-shadow:0 1px 2px rgba(0,0,0,.12);pointer-events:none}',
    '.th-postit .hd{background:rgba(0,0,0,.06);padding-top:8px;font-family:"Segoe UI",sans-serif}',
    '.th-postit .bd{font-size:15px}',
    '.th-postit .lp{background:var(--c1);color:#6b5b00}',

    '.th-onenote .n{background:var(--c);color:#1f1f1f;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.22),0 1px 3px rgba(0,0,0,.15)}',
    '.th-onenote .hd{background:color-mix(in srgb,var(--c) 82%,#000);padding:7px 8px}',
    '.th-onenote .hd b:hover{background:rgba(0,0,0,.12)}',
    '.th-onenote .ft{border-top:1px solid rgba(0,0,0,.08)}',
    '.th-onenote .lp{background:#7719aa;color:#fff}',

    '.th-glass .n{background:rgba(255,255,255,.72);backdrop-filter:blur(16px) saturate(1.4);-webkit-backdrop-filter:blur(16px) saturate(1.4);border:1px solid rgba(255,255,255,.7);border-radius:14px;color:#1f2430;box-shadow:0 10px 30px rgba(0,0,0,.18)}',
    '.th-glass.dark .n{background:rgba(30,34,44,.72);border-color:rgba(255,255,255,.14);color:#eef0f4}',
    '.th-glass .hd{border-bottom:1px solid rgba(0,0,0,.06)}',
    '.th-glass .hd .dot{width:10px;height:10px;border:0;box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 45%,transparent)}',
    '.th-glass .n::after{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--c);pointer-events:none}',
    '.th-glass .lp{background:rgba(255,255,255,.8);backdrop-filter:blur(12px);color:var(--storm);border:1px solid rgba(255,255,255,.8)}',
    '.th-glass.dark .lp{background:rgba(30,34,44,.8);color:#fff;border-color:rgba(255,255,255,.14)}',

    '.th-umbrella .n{background:#fff;color:var(--storm);border-radius:8px;border-top:4px solid var(--umb);box-shadow:0 6px 20px rgba(12,94,156,.18),0 0 0 1px var(--cloud)}',
    '.th-umbrella .hd{background:#f7f9fb;border-bottom:1px solid var(--cloud);font-family:"Arial Black","Segoe UI",sans-serif;letter-spacing:.06em;font-size:11px;text-transform:uppercase}',
    '.th-umbrella .hd .t{font-weight:900;color:var(--umb-deep)}',
    '.th-umbrella .hd .dot{border-radius:3px;border-color:transparent}',
    '.th-umbrella .ft{color:var(--graphite);opacity:.9}',
    '.th-umbrella .lp{background:linear-gradient(180deg,var(--umb),var(--umb-deep));color:#fff}',

    '.th-slate .n{background:var(--storm);color:#e6e8ee;border-radius:8px;border-left:4px solid var(--c);box-shadow:0 8px 24px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.06);font-family:Consolas,"Cascadia Mono",monospace}',
    '.th-slate .hd{background:rgba(255,255,255,.05);font-family:"Segoe UI",sans-serif}',
    '.th-slate .hd .t{color:var(--c)}',
    '.th-slate .hd b:hover{background:rgba(255,255,255,.1)}',
    '.th-slate .hd .dot{border-color:rgba(255,255,255,.35)}',
    '.th-slate .bd{font-size:12.5px}',
    '.th-slate .pin span{background:rgba(255,255,255,.1)}.th-slate .pin span.on{background:#fff;color:#111}',
    '.th-slate .lp{background:var(--storm);color:#7cc4f5;border:1px solid rgba(255,255,255,.12)}',

    '.th-paper .n{background:#fffdf5 repeating-linear-gradient(transparent 0 23px,rgba(60,120,200,.18) 23px 24px);background-position:0 30px;color:#2b2b2b;font-family:Georgia,"Times New Roman",serif;border-radius:3px;box-shadow:1px 3px 9px rgba(0,0,0,.25)}',
    '.th-paper .n::before{content:"";position:absolute;left:26px;top:0;bottom:0;width:1px;background:rgba(220,60,60,.35);pointer-events:none}',
    '.th-paper .hd{background:var(--c);font-family:"Segoe UI",sans-serif;border-bottom:1px solid rgba(0,0,0,.08)}',
    '.th-paper .bd{padding-left:34px;line-height:24px;font-size:14px}',
    '.th-paper .ft{padding-left:34px}',
    '.th-paper .lp{background:#fffdf5;color:#b91c1c;border:1px solid rgba(0,0,0,.12)}'
  ].join('\n');

  // ---------------------------------------------------------------- DOM util
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) for (var k in props) {
      if (k === 'class') n.className = props[k];
      else if (k === 'text') n.textContent = props[k];
      else if (k === 'html') n.innerHTML = props[k];
      else n.setAttribute(k, props[k]);
    }
    (kids || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }
  var ICON = {
    plus: { d: ['M12 3v18M6 9h12M9 15h6'] },
    color: { d: ['M12 6a6 6 0 1 0 0 12a6 6 0 1 0 0-12z'], fill: true },
    pin: { d: ['M9 4h6l-1 6 3 3v1H7v-1l3-3z', 'M12 14v6'] },
    chev: { d: ['M6 15l6-6 6 6'] },
    x: { d: ['M6 6l12 12M18 6L6 18'] }
  };
  function svgIcon(name) {
    var ic = ICON[name || 'plus'];
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', name || 'plus');
    if (ic.fill) s.setAttribute('fill', 'currentColor');
    else { s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2.2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); }
    ic.d.forEach(function (path) {
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', path); s.appendChild(p);
    });
    return s;
  }
  function hostIsDark() {
    try {
      var bg = getComputedStyle(document.body).backgroundColor;
      var m = bg && bg.match(/\d+(\.\d+)?/g);
      if (!m || m.length < 3 || (m.length > 3 && parseFloat(m[3]) < 0.4)) return false;
      return (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) < 110;
    } catch (_) { return false; }
  }

  // ----------------------------------------------------------------- mount
  var host = document.createElement('tack-notes');
  var shadow = host.attachShadow({ mode: 'open' });
  var styled = false;
  try {
    var sheet = new CSSStyleSheet(); sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet]; styled = true;
  } catch (_) {}
  if (!styled) shadow.appendChild(el('style', { text: CSS }));
  ['position', 'inset', 'width', 'height', 'margin', 'padding', 'border', 'background', 'pointer-events', 'z-index'].forEach(function (p) {
    var v = { position: 'fixed', inset: '0', width: '100vw', height: '100vh', margin: '0', padding: '0', border: '0', background: 'transparent', 'pointer-events': 'none', 'z-index': '2147483647' }[p];
    host.style.setProperty(p, v, 'important');
  });
  var root = el('div', { class: 'tk th-' + cfg.theme + (hostIsDark() ? ' dark' : '') });
  shadow.appendChild(root);

  // Keep the host page from seeing our keystrokes (Gmail-style single-key shortcuts).
  ['keydown', 'keyup', 'keypress'].forEach(function (t) {
    root.addEventListener(t, function (e) { e.stopPropagation(); });
  });

  var popoverMode = false;
  function mount() {
    var parent = document.documentElement || document.body;
    if (host.parentElement !== parent) { try { parent.appendChild(host); } catch (_) {} }
    if (!popoverMode && typeof host.showPopover === 'function' && !host.hasAttribute('popover')) {
      try { host.setAttribute('popover', 'manual'); host.showPopover(); popoverMode = true; } catch (_) { popoverMode = false; try { host.removeAttribute('popover'); } catch (__) {} }
    } else if (popoverMode && !host.matches(':popover-open')) {
      try { host.showPopover(); } catch (_) {}
    }
  }
  mount();
  setInterval(mount, 1500);
  document.addEventListener('fullscreenchange', function () {
    if (popoverMode) { try { host.hidePopover(); } catch (_) {} }
    mount();
  });

  // ----------------------------------------------------------------- toast
  var toastEl = el('div', { class: 'toast' }); root.appendChild(toastEl); var toastT;
  function toast(t) { toastEl.textContent = t; toastEl.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(function () { toastEl.classList.remove('on'); }, 2200); }

  // ----------------------------------------------------------------- notes
  var views = {};   // id -> { el, ta, hd, ft, ... }
  var maxZ = notes.reduce(function (m, n) { return Math.max(m, n.z || 0); }, 10);

  function clampPos(n) {
    var vw = window.innerWidth, vh = window.innerHeight;
    n.x = Math.max(0, Math.min(n.x, vw - Math.min(n.w || 240, vw) ));
    n.y = Math.max(0, Math.min(n.y, vh - 40));
  }

  function makeDraggable(handle, box, onEnd) {
    handle.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var tg = e.target;
      if (tg.closest('b') || (tg.tagName === 'SPAN' && tg.parentElement.classList.contains('del'))) return;
      var sx = e.clientX, sy = e.clientY, ox = box.offsetLeft, oy = box.offsetTop, moved = false;
      handle.setPointerCapture(e.pointerId);
      function mv(ev) {
        var nx = ox + ev.clientX - sx, ny = oy + ev.clientY - sy;
        nx = Math.max(0, Math.min(nx, window.innerWidth - box.offsetWidth));
        ny = Math.max(0, Math.min(ny, window.innerHeight - 30));
        box.style.left = nx + 'px'; box.style.top = ny + 'px'; moved = true;
      }
      function up() {
        handle.removeEventListener('pointermove', mv); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
        if (moved && onEnd) onEnd(box.offsetLeft, box.offsetTop);
      }
      handle.addEventListener('pointermove', mv); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
      e.preventDefault();
    });
  }

  function bringToFront(n) { n.z = ++maxZ; if (views[n.id]) views[n.id].el.style.zIndex = n.z; }

  function buildNote(n) {
    var box = el('div', { class: 'n' + (n.min ? ' min' : ''), 'data-id': n.id });
    box.style.setProperty('--c', COLORS[n.color] || COLORS.yellow);
    var dot = el('span', { class: 'dot' });
    var title = el('span', { class: 't', text: SCOPE_LABEL[n.scope] || '' });
    var bColor = el('b', { title: 'Color' }, [svgIcon('color')]);
    var bPin = el('b', { title: 'Pin to: this page / this site / everywhere' }, [svgIcon('pin')]);
    var bMin = el('b', { title: n.min ? 'Expand' : 'Collapse' }, [svgIcon('chev')]);
    var bDel = el('b', { title: 'Delete' }, [svgIcon('x')]);
    var dy = el('span', { class: 'dy', text: 'Delete' }), dn = el('span', { class: 'dn', text: 'Keep' });
    var del = el('span', { class: 'del' }, [el('span', { text: 'Delete this note?' }), dy, dn]);
    del.firstChild.style.background = 'none'; del.firstChild.style.cursor = 'default';
    var hd = el('div', { class: 'hd' }, [dot, title, del, bColor, bPin, bMin, bDel]);
    var ta = el('textarea', { placeholder: 'Type a note...', spellcheck: 'true' }); ta.value = n.text || '';
    var bd = el('div', { class: 'bd' }, [ta]);
    var ft = el('div', { class: 'ft', text: 'Edited ' + ago(n.updated || n.created) });
    var pal = el('div', { class: 'pal' }); pal.style.display = 'none';
    Object.keys(COLORS).forEach(function (c) {
      var i = el('i', { class: c === n.color ? 'on' : '', title: c }); i.style.background = COLORS[c];
      i.addEventListener('click', function () {
        n.color = c; box.style.setProperty('--c', COLORS[c]);
        [].forEach.call(pal.children, function (x) { x.classList.toggle('on', x === i); });
        pal.style.display = 'none'; n.updated = Date.now(); saveNotes();
      });
      pal.appendChild(i);
    });
    var pin = el('div', { class: 'pin' }); pin.style.display = 'none';
    ['page', 'site', 'all'].forEach(function (s) {
      var sp = el('span', { class: s === n.scope ? 'on' : '', text: SCOPE_LABEL[s], title: keyFor(s) });
      sp.addEventListener('click', function () {
        n.scope = s; n.key = keyFor(s); title.textContent = SCOPE_LABEL[s];
        [].forEach.call(pin.children, function (x) { x.classList.toggle('on', x === sp); });
        pin.style.display = 'none'; n.updated = Date.now(); saveNotes(); updateBadge();
      });
      pin.appendChild(sp);
    });
    box.appendChild(hd); box.appendChild(pal); box.appendChild(pin); box.appendChild(bd); box.appendChild(ft);

    box.style.left = n.x + 'px'; box.style.top = n.y + 'px'; box.style.zIndex = n.z || 10;
    if (n.w) box.style.width = n.w + 'px';
    if (n.h && !n.min) box.style.height = n.h + 'px';

    box.addEventListener('pointerdown', function () { if ((n.z || 0) !== maxZ) { bringToFront(n); saveQuiet(); } });
    makeDraggable(hd, box, function (x, y) { n.x = x; n.y = y; saveQuiet(); });

    bColor.addEventListener('click', function () { pin.style.display = 'none'; pal.style.display = pal.style.display === 'none' ? 'flex' : 'none'; });
    bPin.addEventListener('click', function () { pal.style.display = 'none'; pin.style.display = pin.style.display === 'none' ? 'flex' : 'none'; });
    bMin.addEventListener('click', function () {
      n.min = !n.min; box.classList.toggle('min', n.min);
      bMin.title = n.min ? 'Expand' : 'Collapse';
      if (!n.min && n.h) box.style.height = n.h + 'px';
      saveQuiet();
    });
    bDel.addEventListener('click', function () { hd.classList.add('confirm'); });
    dn.addEventListener('click', function () { hd.classList.remove('confirm'); });
    dy.addEventListener('click', function () { removeNote(n.id); });

    var typing;
    ta.addEventListener('input', function () {
      n.text = ta.value; n.updated = Date.now(); ft.textContent = 'Edited just now';
      clearTimeout(typing); typing = setTimeout(saveNotes, 500);
    });
    ta.addEventListener('blur', function () { clearTimeout(typing); if (n.text !== ta.value) { n.text = ta.value; n.updated = Date.now(); } saveNotes(); });

    // Persist the size after the native corner-resize. ResizeObserver covers
    // it in normal use; pointerup covers the case where the tab is not painting
    // (background window), since the observer only fires with rendering.
    function persistSize() {
      if (n.min || !box.isConnected) return;
      var r = box.getBoundingClientRect();
      if (r.width < 50 || r.height < 30) return; // hidden or mid-toggle, not a real size
      if (Math.round(r.width) === n.w && Math.round(r.height) === n.h) return;
      n.w = Math.round(r.width); n.h = Math.round(r.height); saveQuiet();
    }
    var sizeT;
    box.addEventListener('pointerup', function () { setTimeout(persistSize, 0); });
    try {
      new ResizeObserver(function () { clearTimeout(sizeT); sizeT = setTimeout(persistSize, 300); }).observe(box);
    } catch (_) {}

    views[n.id] = { el: box, ta: ta, ft: ft, title: title };
    return box;
  }

  // Save without triggering a Drive push for cosmetic changes (position, size, z).
  function saveQuiet() { store.set('tack.notes', notes); }

  function render() {
    var seen = {};
    notes.forEach(function (n) {
      if (!isVisible(n)) return;
      seen[n.id] = true;
      if (views[n.id]) return;
      clampPos(n);
      root.appendChild(buildNote(n));
    });
    Object.keys(views).forEach(function (id) {
      if (!seen[id]) { views[id].el.remove(); delete views[id]; }
    });
    updateBadge();
  }

  function addNote(opts) {
    opts = opts || {};
    var scope = opts.scope || cfg.defaultScope;
    var count = notes.filter(isVisible).length;
    var n = {
      id: uid(), text: '', color: cfg.defaultColor, scope: scope, key: keyFor(scope),
      x: 80 + (count % 6) * 28, y: 80 + (count % 6) * 28, w: 240, h: 200, min: false, z: ++maxZ,
      created: Date.now(), updated: Date.now()
    };
    notes.push(n); saveNotes(); render();
    if (views[n.id]) views[n.id].ta.focus();
  }

  function removeNote(id) {
    notes = notes.filter(function (n) { return n.id !== id; });
    tombstones[id] = Date.now();
    if (views[id]) { views[id].el.remove(); delete views[id]; }
    saveNotes(); updateBadge();
  }

  // Refresh footers every minute; clamp on resize.
  setInterval(function () {
    notes.forEach(function (n) { if (views[n.id]) views[n.id].ft.textContent = 'Edited ' + ago(n.updated || n.created); });
  }, 60000);
  window.addEventListener('resize', function () {
    notes.forEach(function (n) { if (views[n.id]) { clampPos(n); views[n.id].el.style.left = n.x + 'px'; views[n.id].el.style.top = n.y + 'px'; } });
  });

  // SPA navigation: page-scoped notes follow the URL.
  var lastUrl = location.href;
  setInterval(function () {
    if (location.href !== lastUrl) { lastUrl = location.href; render(); }
  }, 800);

  // Other tabs changed the notes.
  try {
    GM_addValueChangeListener('tack.notes', function (name, oldV, newV, remote) {
      if (!remote) return;
      var incoming = newV || [], byId = {};
      incoming.forEach(function (n) { byId[n.id] = n; });
      // Keep the text of a note that is being typed in here.
      notes.forEach(function (n) {
        var v = views[n.id];
        if (v && shadow.activeElement === v.ta && byId[n.id]) { byId[n.id].text = v.ta.value; byId[n.id].updated = n.updated; }
      });
      notes = incoming;
      notes.forEach(function (n) {
        var v = views[n.id]; if (!v) return;
        if (v.ta.value !== n.text && shadow.activeElement !== v.ta) v.ta.value = n.text;
        v.el.style.setProperty('--c', COLORS[n.color] || COLORS.yellow);
        v.el.style.left = n.x + 'px'; v.el.style.top = n.y + 'px';
        if (n.w) v.el.style.width = n.w + 'px';
        v.el.classList.toggle('min', !!n.min);
        v.title.textContent = SCOPE_LABEL[n.scope] || '';
      });
      render();
    });
    GM_addValueChangeListener('tack.cfg', function (name, oldV, newV, remote) {
      if (!remote || !newV) return;
      var hadToken = cfg.drive.token;
      cfg = newV; cfg.drive = cfg.drive || {};
      applyTheme(); applyLauncher();
      if (!hadToken && cfg.drive.token) { toast('Google Drive connected'); refreshSettings(); syncNow(true); }
      else refreshSettings();
    });
  } catch (_) {}

  // -------------------------------------------------------------- launcher
  var launcher = el('div', { class: 'lp ' + cfg.corner, title: 'Tack: click for a new note, right-click for the menu (Alt+N)' }, [svgIcon(), el('em', { text: '0' })]);
  var menu = null;
  function applyLauncher() {
    launcher.className = 'lp ' + cfg.corner + (cfg.hidden[siteKey()] ? ' off' : '');
    launcher.style.display = cfg.launcher ? 'grid' : 'none';
  }
  function updateBadge() {
    var c = notes.filter(isVisible).length;
    launcher.lastChild.textContent = c; launcher.lastChild.style.display = c ? 'block' : 'none';
    Object.keys(views).forEach(function (id) { views[id].el.style.display = cfg.hidden[siteKey()] ? 'none' : 'flex'; });
  }
  var menuClosedAt = 0;
  launcher.addEventListener('click', function () { if (menu) { closeMenu(); return; } if (Date.now() - menuClosedAt < 400) return; addNote(); });
  launcher.addEventListener('contextmenu', function (e) { e.preventDefault(); openMenu(); });
  function closeMenu() { if (menu) { menu.remove(); menu = null; menuClosedAt = Date.now(); } }
  document.addEventListener('pointerdown', function (e) {
    if (menu && e.composedPath().indexOf(menu) < 0) closeMenu();
  }, true);
  function openMenu() {
    closeMenu();
    var hiddenHere = !!cfg.hidden[siteKey()];
    var item = function (t, fn, cls) { var d = el('div', { text: t, class: cls || '' }); if (fn) d.addEventListener('click', function () { closeMenu(); fn(); }); return d; };
    menu = el('div', { class: 'menu' }, [
      item('New note here (Alt+N)', function () { addNote(); }),
      item('New note for this page', function () { addNote({ scope: 'page' }); }),
      item('New note everywhere', function () { addNote({ scope: 'all' }); }),
      el('hr'),
      item(hiddenHere ? 'Show notes on this site' : 'Hide notes on this site', function () {
        if (hiddenHere) delete cfg.hidden[siteKey()]; else cfg.hidden[siteKey()] = true;
        saveCfg(); applyLauncher(); updateBadge();
      }),
      item('Settings', openSettings),
      el('hr'),
      item(cfg.drive.token ? 'Back up to Google Drive now' : 'Connect Google Drive...', function () { if (cfg.drive.token) syncNow(false); else openSettings(); }),
      item(driveStatusLine(), null, 'sub'),
      item('Tack v' + VERSION, null, 'sub')
    ]);
    root.appendChild(menu);
    var r = launcher.getBoundingClientRect(), mw = 210, mh = menu.offsetHeight || 260;
    var left = cfg.corner.charAt(1) === 'r' ? r.right - mw : r.left;
    var top = cfg.corner.charAt(0) === 'b' ? r.top - mh - 8 : r.bottom + 8;
    menu.style.left = Math.max(8, left) + 'px'; menu.style.top = Math.max(8, top) + 'px';
  }
  root.appendChild(launcher);
  applyLauncher();

  document.addEventListener('keydown', function (e) {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); addNote(); }
  }, true);

  try {
    GM_registerMenuCommand('New sticky note', function () { addNote(); });
    GM_registerMenuCommand('Tack settings', openSettings);
  } catch (_) {}

  // -------------------------------------------------------------- settings
  var settings = null, stEls = {};
  function applyTheme() { root.className = 'tk th-' + cfg.theme + (hostIsDark() ? ' dark' : ''); }
  function driveStatusLine() {
    var d = cfg.drive;
    if (!d.clientId) return 'Drive: not set up';
    if (d.error) return 'Drive: ' + d.error;
    if (!d.token) return 'Drive: not connected';
    if (d.exp && Date.now() > d.exp) return 'Drive: session expired, reconnect';
    return 'Drive: connected' + (d.lastSync ? ', synced ' + ago(d.lastSync) : '');
  }
  function refreshSettings() {
    if (!settings) return;
    var d = cfg.drive, s = stEls.status;
    s.className = 'st ' + (d.error ? 'err' : (d.token && !(d.exp && Date.now() > d.exp)) ? 'ok' : '');
    s.textContent = driveStatusLine() + (d.fileId ? '. File: ' + DRIVE_FILE : '');
    stEls.connect.textContent = d.token ? 'Reconnect' : 'Connect Google Drive';
    stEls.connect.disabled = !d.clientId;
  }
  function openSettings() {
    if (settings) { settings.remove(); settings = null; }
    var hd = el('div', { class: 'hd' }, [el('span', { class: 't', text: 'Tack settings  v' + VERSION }), el('b', { title: 'Close' }, [svgIcon('x')])]);
    hd.lastChild.addEventListener('click', function () { settings.remove(); settings = null; });
    var body = el('div', { class: 'sb' });

    // Look
    body.appendChild(el('h4', { text: 'Look' }));
    var themeSel = el('select');
    THEMES.forEach(function (t) { var o = el('option', { value: t, text: THEME_NAMES[t] }); if (t === cfg.theme) o.selected = true; themeSel.appendChild(o); });
    themeSel.addEventListener('change', function () { cfg.theme = themeSel.value; saveCfg(); applyTheme(); });
    body.appendChild(el('label', { class: 'row' }, [el('span', { text: 'Note style' }), themeSel]));
    var scopeSel = el('select');
    ['site', 'page', 'all'].forEach(function (s) { var o = el('option', { value: s, text: SCOPE_LABEL[s] }); if (s === cfg.defaultScope) o.selected = true; scopeSel.appendChild(o); });
    scopeSel.addEventListener('change', function () { cfg.defaultScope = scopeSel.value; saveCfg(); });
    body.appendChild(el('label', { class: 'row', title: 'Where a brand-new note is pinned. You can change it per note with the pin button.' }, [el('span', { text: 'New notes stick to' }), scopeSel]));
    var sw = el('div', { class: 'sw' });
    Object.keys(COLORS).forEach(function (c) {
      var i = el('i', { class: c === cfg.defaultColor ? 'on' : '', title: c }); i.style.background = COLORS[c];
      i.addEventListener('click', function () { cfg.defaultColor = c; saveCfg(); [].forEach.call(sw.children, function (x) { x.classList.toggle('on', x === i); }); });
      sw.appendChild(i);
    });
    body.appendChild(el('label', { class: 'row', title: 'Color for new notes' }, [el('span', { text: 'Default color' }), sw]));
    var cornerSel = el('select');
    [['br', 'Bottom right'], ['bl', 'Bottom left'], ['tr', 'Top right'], ['tl', 'Top left']].forEach(function (p) { var o = el('option', { value: p[0], text: p[1] }); if (p[0] === cfg.corner) o.selected = true; cornerSel.appendChild(o); });
    cornerSel.addEventListener('change', function () { cfg.corner = cornerSel.value; saveCfg(); applyLauncher(); });
    body.appendChild(el('label', { class: 'row' }, [el('span', { text: 'Launcher button corner' }), cornerSel]));
    var lchk = el('input', { type: 'checkbox' }); lchk.checked = !!cfg.launcher;
    lchk.addEventListener('change', function () { cfg.launcher = lchk.checked; saveCfg(); applyLauncher(); });
    body.appendChild(el('label', { class: 'row', title: 'Hide the round button. Alt+N and the Tampermonkey menu still work.' }, [el('span', { text: 'Show launcher button' }), lchk]));

    // Data
    body.appendChild(el('h4', { text: 'Your notes' }));
    var exp = el('button', { text: 'Export JSON' }), imp = el('button', { text: 'Import JSON' }), file = el('input', { type: 'file', accept: '.json,application/json' });
    file.style.display = 'none';
    exp.addEventListener('click', function () {
      var blob = new Blob([JSON.stringify({ app: 'tack', version: VERSION, exported: new Date().toISOString(), notes: notes }, null, 2)], { type: 'application/json' });
      var a = el('a', { href: URL.createObjectURL(blob), download: 'tack-notes-' + new Date().toISOString().slice(0, 10) + '.json' });
      root.appendChild(a); a.click(); a.remove();
    });
    imp.addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () {
      var f = file.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          var data = JSON.parse(r.result); var list = Array.isArray(data) ? data : data.notes;
          if (!Array.isArray(list)) throw new Error('no notes array');
          var added = mergeNotes(list, {});
          saveNotes(); render(); toast('Imported ' + added + ' note' + (added === 1 ? '' : 's'));
        } catch (e) { toast('That file is not a Tack export'); }
      };
      r.readAsText(f); file.value = '';
    });
    body.appendChild(el('div', { class: 'btns' }, [exp, imp, file]));
    body.appendChild(el('div', { class: 'hint', text: notes.length + ' note' + (notes.length === 1 ? '' : 's') + ' stored in this browser. Export before reinstalling Tampermonkey or moving to a new PC.' }));

    // Drive
    body.appendChild(el('h4', { text: 'Google Drive backup' }));
    body.appendChild(el('div', { class: 'hint', html: 'Needs a Google Cloud OAuth client ID (one-time setup, see the <a href="https://frank-umbrella.github.io/work/tack/#drive" target="_blank" rel="noopener">install page</a>). Notes are kept in one file called <code>' + DRIVE_FILE + '</code> that only Tack can read. Newest change wins per note.' }));
    var cid = el('input', { type: 'text', placeholder: 'xxxxxxxx.apps.googleusercontent.com', spellcheck: 'false' }); cid.value = cfg.drive.clientId || '';
    cid.addEventListener('change', function () { cfg.drive.clientId = cid.value.trim(); saveCfg(); refreshSettings(); });
    body.appendChild(el('label', { class: 'row', title: 'The OAuth 2.0 Client ID from Google Cloud Console. It is a public identifier, not a secret.' }, [el('span', { text: 'Client ID' })]));
    body.appendChild(cid);
    var connect = el('button', { class: 'pri', text: 'Connect Google Drive' }), backup = el('button', { text: 'Back up now' }), restore = el('button', { text: 'Pull from Drive' }), disc = el('button', { text: 'Disconnect' });
    connect.addEventListener('click', startAuth);
    backup.addEventListener('click', function () { syncNow(false); });
    restore.addEventListener('click', function () { syncNow(true); });
    disc.addEventListener('click', function () { cfg.drive.token = ''; cfg.drive.exp = 0; cfg.drive.error = ''; saveCfg(); refreshSettings(); });
    body.appendChild(el('div', { class: 'btns' }, [connect, backup, restore, disc]));
    var auto = el('input', { type: 'checkbox' }); auto.checked = cfg.drive.auto !== false;
    auto.addEventListener('change', function () { cfg.drive.auto = auto.checked; saveCfg(); });
    body.appendChild(el('label', { class: 'row', title: 'Push to Drive a few seconds after every edit, and pull when a page loads (at most once a minute).' }, [el('span', { text: 'Auto-sync while connected' }), auto]));
    var status = el('div', { class: 'st' });
    body.appendChild(status);
    body.appendChild(el('div', { class: 'hint', text: 'Google sign-ins last about an hour. When it lapses, the launcher menu shows "reconnect" and you click Connect again. Nothing is lost in between; the browser copy is always the source of truth.' }));

    settings = el('div', { class: 'sp' }, [hd, body]);
    settings.style.left = Math.max(10, (window.innerWidth - 340) / 2) + 'px';
    settings.style.top = '60px';
    settings.style.zIndex = ++maxZ + 1;
    makeDraggable(hd, settings);
    root.appendChild(settings);
    stEls = { status: status, connect: connect };
    refreshSettings();
  }

  // ----------------------------------------------------------------- Drive
  var backupT;
  function scheduleBackup() {
    if (!cfg.drive.token || cfg.drive.auto === false) return;
    clearTimeout(backupT); backupT = setTimeout(function () { syncNow(false, true); }, 5000);
  }
  function startAuth() {
    if (!cfg.drive.clientId) { toast('Paste the Client ID first'); return; }
    var u = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=token' +
      '&client_id=' + encodeURIComponent(cfg.drive.clientId) +
      '&redirect_uri=' + encodeURIComponent(AUTH_URL) +
      '&scope=' + encodeURIComponent('https://www.googleapis.com/auth/drive.file') +
      '&include_granted_scopes=true&prompt=select_account&state=tack';
    var w = window.open(u, 'tack-auth', 'popup,width=520,height=640');
    if (!w) toast('Popup blocked. Allow popups for this site and try again.');
  }
  function tokenOk() { return cfg.drive.token && !(cfg.drive.exp && Date.now() > cfg.drive.exp); }
  function gapi(method, url, body) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: method, url: url,
        headers: Object.assign({ Authorization: 'Bearer ' + cfg.drive.token }, body ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}),
        data: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        onload: function (r) {
          if (r.status === 401) { cfg.drive.token = ''; cfg.drive.error = 'session expired, reconnect'; saveCfg(); refreshSettings(); return reject(new Error('401')); }
          if (r.status < 200 || r.status >= 300) return reject(new Error('Drive ' + r.status + ': ' + (r.responseText || '').slice(0, 120)));
          try { resolve(r.responseText ? JSON.parse(r.responseText) : {}); } catch (_) { resolve(r.responseText); }
        },
        onerror: function () { reject(new Error('network error')); },
        ontimeout: function () { reject(new Error('timeout')); },
        timeout: 20000
      });
    });
  }
  function findFile() {
    if (cfg.drive.fileId) return Promise.resolve(cfg.drive.fileId);
    return gapi('GET', 'https://www.googleapis.com/drive/v3/files?spaces=drive&fields=files(id,name,modifiedTime)&q=' +
      encodeURIComponent("name='" + DRIVE_FILE + "' and trashed=false")).then(function (r) {
      if (r.files && r.files.length) { cfg.drive.fileId = r.files[0].id; saveCfg(); return cfg.drive.fileId; }
      return gapi('POST', 'https://www.googleapis.com/drive/v3/files', { name: DRIVE_FILE, mimeType: 'application/json', description: 'Tack sticky notes backup' })
        .then(function (f) { cfg.drive.fileId = f.id; saveCfg(); return f.id; });
    });
  }
  function pull(id) {
    return gapi('GET', 'https://www.googleapis.com/drive/v3/files/' + id + '?alt=media').then(function (d) {
      if (!d || typeof d !== 'object') return { notes: [], tombstones: {} };
      return { notes: Array.isArray(d.notes) ? d.notes : [], tombstones: d.tombstones || {} };
    }).catch(function (e) { if (String(e.message).indexOf('404') >= 0) { cfg.drive.fileId = ''; saveCfg(); } throw e; });
  }
  function push(id) {
    var body = JSON.stringify({ app: 'tack', version: VERSION, savedAt: new Date().toISOString(), notes: notes, tombstones: tombstones });
    return gapi('PATCH', 'https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media', body);
  }
  // Merge a remote list into local notes. Returns how many were added or updated.
  function mergeNotes(remote, remoteTomb) {
    var changed = 0, byId = {};
    notes.forEach(function (n) { byId[n.id] = n; });
    Object.keys(remoteTomb || {}).forEach(function (id) {
      if (byId[id] && remoteTomb[id] >= (byId[id].updated || 0)) { notes = notes.filter(function (n) { return n.id !== id; }); delete byId[id]; changed++; }
      tombstones[id] = Math.max(tombstones[id] || 0, remoteTomb[id]);
    });
    remote.forEach(function (r) {
      if (!r || !r.id) return;
      if (tombstones[r.id] && tombstones[r.id] >= (r.updated || 0)) return;
      var l = byId[r.id];
      if (!l) { notes.push(r); byId[r.id] = r; changed++; }
      else if ((r.updated || 0) > (l.updated || 0)) { Object.assign(l, r); changed++; if (views[r.id] && shadow.activeElement !== views[r.id].ta) views[r.id].ta.value = r.text || ''; }
    });
    var cutoff = Date.now() - TOMBSTONE_DAYS * 86400000;
    Object.keys(tombstones).forEach(function (id) { if (tombstones[id] < cutoff) delete tombstones[id]; });
    if (changed) maxZ = notes.reduce(function (m, n) { return Math.max(m, n.z || 0); }, maxZ);
    return changed;
  }
  var syncing = false;
  function syncNow(pullFirst, quiet) {
    if (syncing) return; if (!tokenOk()) { if (!quiet) toast(cfg.drive.token ? 'Drive session expired, reconnect in settings' : 'Connect Google Drive in settings first'); return; }
    syncing = true;
    findFile().then(function (id) {
      var p = pullFirst ? pull(id).then(function (d) {
        var c = mergeNotes(d.notes, d.tombstones);
        if (c) { store.set('tack.notes', notes); store.set('tack.tombstones', tombstones); render(); }
        return c;
      }) : Promise.resolve(0);
      return p.then(function (c) { return push(id).then(function () { return c; }); });
    }).then(function (c) {
      cfg.drive.lastSync = Date.now(); cfg.drive.error = ''; saveCfg(); refreshSettings();
      if (!quiet) toast(pullFirst ? ('Synced with Drive' + (c ? ', ' + c + ' note' + (c === 1 ? '' : 's') + ' updated' : '')) : 'Backed up to Drive');
    }).catch(function (e) {
      cfg.drive.error = e.message === '401' ? 'session expired, reconnect' : e.message; saveCfg(); refreshSettings();
      if (!quiet) toast('Drive: ' + cfg.drive.error);
    }).then(function () { syncing = false; });
  }
  // Pull on load, at most once a minute across all tabs.
  if (tokenOk() && cfg.drive.auto !== false && Date.now() - (store.get('tack.lastPull', 0)) > 60000) {
    store.set('tack.lastPull', Date.now());
    setTimeout(function () { syncNow(true, true); }, 2500);
  }

  // ------------------------------------------------------------------ go
  render();
})();
