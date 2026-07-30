/* util.js — DOM/문자열/시간/IndexedDB 유틸. 다른 모든 모듈보다 먼저 로드된다. */
window.WM = window.WM || {};
(function (WM) {
  'use strict';

  /* ---------- DOM ---------- */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /** el('div.row', {onclick: fn}, ['텍스트', el('span')]) */
  function el(spec, attrs, children) {
    var parts = String(spec).split(/(?=[.#])/);
    var node = document.createElement(parts[0] || 'div');
    parts.slice(1).forEach(function (p) {
      if (p[0] === '.') node.classList.add(p.slice(1));
      else if (p[0] === '#') node.id = p.slice(1);
    });
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') node[k] = !!v;
      else node.setAttribute(k, v);
    });
    append(node, children);
    return node;
  }

  function append(node, children) {
    if (children === null || children === undefined || children === false) return node;
    if (Array.isArray(children)) { children.forEach(function (c) { append(node, c); }); return node; }
    node.appendChild(children instanceof Node ? children : document.createTextNode(String(children)));
    return node;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

  /* ---------- 문자열 ---------- */

  /** 라틴 문자만 남긴 slug. 한글 등은 남길 수 없으므로 빈 문자열이 나올 수 있다(호출부에서 직접 입력받는다). */
  function slugify(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/['"]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48);
  }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 부분일치 점수. 0이면 불일치. 앞쪽에서 매치될수록 높다. */
  function matchScore(haystack, needle) {
    if (!needle) return 1;
    var h = String(haystack || '').toLowerCase(), n = needle.toLowerCase();
    var i = h.indexOf(n);
    if (i < 0) return 0;
    return 1000 - i;
  }

  /** 중복 의심 판정용 정규화 (검증 규칙에서 사용) */
  function normalizeName(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, '');
  }

  /* ---------- 시간 ---------- */

  function pad(n) { return String(Math.floor(Math.abs(n))).padStart(2, '0'); }

  /** 로컬 타임존 오프셋을 포함한 ISO 문자열. 예: 2026-07-30T11:07:00+09:00 */
  function nowIso() {
    var d = new Date();
    var off = -d.getTimezoneOffset();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
      (off >= 0 ? '+' : '-') + pad(off / 60) + ':' + pad(off % 60);
  }

  /** 백업 폴더명. 예: 20260730-1107 */
  function stamp() {
    var d = new Date();
    return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) +
      '-' + pad(d.getHours()) + pad(d.getMinutes());
  }

  function debounce(fn, ms) {
    var t = null;
    var wrapped = function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
    };
    wrapped.cancel = function () { clearTimeout(t); t = null; };
    wrapped.pending = function () { return t !== null; };
    wrapped.flush = function () { if (t !== null) { clearTimeout(t); t = null; fn.call(this); } };
    return wrapped;
  }

  /* ---------- IndexedDB (폴더 핸들 보관용) ----------
     file:// 오리진에서는 브라우저가 IDB를 막을 수 있다. 그 경우 조용히 실패시키고
     "매번 폴더를 다시 고르는" 동작으로 격하한다. 앱 자체는 계속 쓸 수 있어야 한다. */

  var idbPromise = null;
  function idbOpen() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise(function (res, rej) {
      var req;
      try { req = indexedDB.open('wm-meta', 1); }
      catch (e) { rej(e); return; }
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
      req.onblocked = function () { rej(new Error('idb blocked')); };
    }).catch(function (e) { console.warn('[wm] IndexedDB 사용 불가:', e && e.message); return null; });
    return idbPromise;
  }

  function idbGet(key) {
    return idbOpen().then(function (db) {
      if (!db) return null;
      return new Promise(function (res) {
        var tx = db.transaction('kv', 'readonly');
        var r = tx.objectStore('kv').get(key);
        r.onsuccess = function () { res(r.result === undefined ? null : r.result); };
        r.onerror = function () { res(null); };
      });
    });
  }

  function idbSet(key, val) {
    return idbOpen().then(function (db) {
      if (!db) return false;
      return new Promise(function (res) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { res(false); };
        tx.onabort = function () { res(false); };
      });
    });
  }

  function idbDel(key) {
    return idbOpen().then(function (db) {
      if (!db) return false;
      return new Promise(function (res) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete(key);
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { res(false); };
      });
    });
  }

  /* ---------- 토스트 ---------- */

  function toast(msg, kind, ms) {
    var root = $('#toast-root');
    if (!root) return;
    var t = el('div.toast' + (kind ? '.toast--' + kind : ''), { text: msg });
    root.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('is-in'); });
    setTimeout(function () {
      t.classList.remove('is-in');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 250);
    }, ms || 2600);
  }

  /* ---------- 모달 ----------
     actions: [{ label, value, kind }]  → 선택한 value로 resolve. 배경/ESC는 null. */

  function modal(opts) {
    return new Promise(function (resolve) {
      var root = $('#modal-root');
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        back.classList.remove('is-in');
        setTimeout(function () { if (back.parentNode) back.parentNode.removeChild(back); }, 160);
        resolve(v);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
      }

      var buttons = (opts.actions || [{ label: '확인', value: true }]).map(function (a) {
        return el('button.btn' + (a.kind ? '.btn--' + a.kind : ''), {
          type: 'button', text: a.label, onclick: function () { finish(a.value); }
        });
      });

      var box = el('div.modal' + (opts.wide ? '.modal--wide' : ''), { role: 'dialog', 'aria-modal': 'true' }, [
        el('h2.modal__title', { text: opts.title || '' }),
        el('div.modal__body', {}, opts.body || null),
        el('div.modal__actions', {}, buttons)
      ]);
      var back = el('div.modal-back', {
        onclick: function (e) { if (e.target === back && opts.dismissable !== false) finish(null); }
      }, box);

      root.appendChild(back);
      document.addEventListener('keydown', onKey, true);
      // 호출부가 자기 판단으로 닫아야 할 때가 있다(예: 선택기에서 항목 클릭).
      if (typeof opts.onOpen === 'function') opts.onOpen(finish);
      requestAnimationFrame(function () {
        back.classList.add('is-in');
        var f = box.querySelector('input,textarea,select,button');
        if (f) f.focus();
      });
    });
  }

  function confirmModal(title, bodyNodes, okLabel, kind) {
    return modal({
      title: title,
      body: bodyNodes,
      actions: [
        { label: '취소', value: null },
        { label: okLabel || '확인', value: true, kind: kind || 'primary' }
      ]
    }).then(function (v) { return v === true; });
  }

  /* ---------- 팝업 메뉴 ----------
     opts: { anchor } 또는 { x, y }, items: [{label, on, danger, sep, onSelect}] */

  function menu(opts, items) {
    var existing = $('.popmenu');
    if (existing) existing.remove();

    var box = el('div.popmenu', {}, items.filter(Boolean).map(function (it) {
      if (it.sep) return el('div.popmenu__sep');
      return el('button.popmenu__item' + (it.on ? '.is-on' : '') + (it.danger ? '.is-danger' : ''), {
        type: 'button', text: it.label,
        onclick: function (e) { e.stopPropagation(); box.remove(); it.onSelect(); }
      });
    }));
    document.body.appendChild(box);

    var top, left;
    if (opts.anchor) {
      var r = opts.anchor.getBoundingClientRect();
      top = r.bottom + 4; left = r.left;
      if (top + box.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - box.offsetHeight - 4);
    } else {
      top = opts.y; left = opts.x;
      if (top + box.offsetHeight > window.innerHeight - 8) top = Math.max(8, window.innerHeight - box.offsetHeight - 8);
    }
    if (left + box.offsetWidth > window.innerWidth - 8) left = Math.max(8, window.innerWidth - box.offsetWidth - 8);
    box.style.top = top + 'px';
    box.style.left = left + 'px';

    setTimeout(function () {
      function close() {
        document.removeEventListener('click', close);
        document.removeEventListener('contextmenu', close);
        box.remove();
      }
      document.addEventListener('click', close);
      document.addEventListener('contextmenu', close);
    }, 0);
    return box;
  }

  function download(filename, data, mime) {
    var blob = (typeof Blob !== 'undefined' && data instanceof Blob)
      ? data : new Blob([data], { type: mime || 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /** <input type="file">로 텍스트 1개 읽기. iOS는 이 경로로만 가져오기가 된다. */
  function pickTextFile(accept) {
    return new Promise(function (resolve) {
      var input = el('input', { type: 'file', accept: accept || '.json', style: { display: 'none' } });
      document.body.appendChild(input);
      // 취소를 감지할 표준 이벤트가 없어, 포커스 복귀 후에도 파일이 없으면 취소로 본다.
      var settled = false;
      function cleanup() { if (input.parentNode) input.parentNode.removeChild(input); }
      input.addEventListener('change', function () {
        settled = true;
        var f = input.files && input.files[0];
        if (!f) { cleanup(); resolve(null); return; }
        var fr = new FileReader();
        fr.onload = function () { cleanup(); resolve({ name: f.name, text: String(fr.result) }); };
        fr.onerror = function () { cleanup(); resolve(null); };
        fr.readAsText(f);
      });
      window.addEventListener('focus', function once() {
        window.removeEventListener('focus', once);
        setTimeout(function () { if (!settled) { cleanup(); resolve(null); } }, 500);
      });
      input.click();
    });
  }

  WM.util = {
    $: $, $$: $$, el: el, append: append, clear: clear,
    slugify: slugify, escapeHtml: escapeHtml, matchScore: matchScore, normalizeName: normalizeName,
    nowIso: nowIso, stamp: stamp, debounce: debounce,
    idbGet: idbGet, idbSet: idbSet, idbDel: idbDel,
    toast: toast, modal: modal, confirmModal: confirmModal, menu: menu,
    download: download, pickTextFile: pickTextFile
  };
})(window.WM);
