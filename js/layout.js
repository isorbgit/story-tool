/* layout.js — 패널 폭 조절 (스플리터).

   폭은 CSS 변수 하나로만 표현한다. 그리드 열 정의가 그 변수를 읽으므로
   JS 는 숫자만 바꾸면 되고, 레이아웃 규칙은 전부 style.css 에 남는다.

   저장은 localStorage 를 쓴다. 데이터가 아니라 이 브라우저에서의 보기 설정이라
   번들(3.4)에 들어가면 안 되고, 기기마다 화면 크기가 달라 따라다니면 오히려 방해다. */
(function (WM) {
  'use strict';

  var KEY = 'worldmap-layout';
  var MIN_CENTER = 320;          // 가운데 뷰가 이보다 좁아지면 표도 그래프도 못 읽는다
  var STEP = 16;                 // 화살표 키 한 번

  var PANES = {
    panel: { css: '--panel-w', min: 260, max: 760, def: 392, dir: -1 },
    tabs:  { css: '--tabs-w',  min: 120, max: 340, def: 172, dir: +1 }
  };

  /* ---------- 저장 ---------- */

  function readSaved() {
    try {
      var raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }     // file:// 에서 막히거나 사생활 보호 창이면 그냥 기본값
  }

  function writeSaved(obj) {
    try { localStorage.setItem(KEY, JSON.stringify(obj)); } catch (e) {}
  }

  var saved = readSaved();

  /* ---------- 폭 읽기/쓰기 ---------- */

  function px(name) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(PANES[name].css);
    var n = parseFloat(v);
    return isNaN(n) ? PANES[name].def : n;
  }

  function tabsVisible() {
    var c = document.body.classList;
    return !c.contains('view-graph') && !c.contains('view-timeline') && !c.contains('is-welcome');
  }

  function splitW() {
    var n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--split-w'));
    return isNaN(n) ? 6 : n;
  }

  /** 자기 한계 + "가운데가 MIN_CENTER 는 남아야 한다" 를 함께 본다. */
  function clamp(name, w) {
    var c = PANES[name];
    w = Math.max(c.min, Math.min(c.max, w));

    var other = name === 'panel'
      ? (tabsVisible() ? px('tabs') : 0)
      : px('panel');
    var splits = splitW() * (tabsVisible() ? 2 : 1);
    var room = document.documentElement.clientWidth - other - splits - MIN_CENTER;
    if (room >= c.min) w = Math.min(w, room);
    else w = c.min;                 // 화면이 너무 좁으면 최소폭을 지키고 가운데가 양보한다
    return Math.round(w);
  }

  function apply(name, w) {
    document.documentElement.style.setProperty(PANES[name].css, clamp(name, w) + 'px');
  }

  /** 저장된 값이 있는 것만 덮어쓴다. 손댄 적 없으면 CSS 기본값과 미디어쿼리가 그대로 산다. */
  function applySaved() {
    Object.keys(PANES).forEach(function (name) {
      if (typeof saved[name] === 'number') apply(name, saved[name]);
    });
  }

  function reset(name) {
    document.documentElement.style.removeProperty(PANES[name].css);
    delete saved[name];
    writeSaved(saved);
    afterResize();
  }

  /* ---------- 조절 후 후처리 ----------
     타임라인은 폭에 맞춰 막대 위치를 다시 계산해야 한다. 캔버스는 transform 이라
     따라오지만, 선택 상자 좌표 캐시가 있으므로 한 번 훑어준다. */

  function afterResize() {
    if (!WM.app || document.body.classList.contains('is-welcome')) return;
    var v = WM.app.view();
    if (v === 'timeline' && WM.timeline) WM.timeline.render();
    else if (v === 'graph' && WM.canvas) WM.canvas.refresh();
  }

  /* ---------- 드래그 ---------- */

  function wire(splitter) {
    var name = splitter.dataset.pane;
    if (!PANES[name]) return;
    var drag = null;

    splitter.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      drag = { x: e.clientX, w: px(name), id: e.pointerId };
      splitter.setPointerCapture(e.pointerId);
      splitter.classList.add('is-dragging');
      document.body.classList.add('is-splitting');
    });

    splitter.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      apply(name, drag.w + (e.clientX - drag.x) * PANES[name].dir);
    });

    function end(e) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      drag = null;
      splitter.classList.remove('is-dragging');
      document.body.classList.remove('is-splitting');
      saved[name] = px(name);
      writeSaved(saved);
      afterResize();
    }
    splitter.addEventListener('pointerup', end);
    splitter.addEventListener('pointercancel', end);

    // 더블클릭으로 기본 폭 복귀. 잘못 끌었을 때 되돌릴 방법이 없으면 답답하다.
    splitter.addEventListener('dblclick', function (e) { e.preventDefault(); reset(name); });

    splitter.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      if (d) {
        e.preventDefault();
        apply(name, px(name) + d * STEP * PANES[name].dir);
        saved[name] = px(name);
        writeSaved(saved);
        afterResize();
      } else if (e.key === 'Home' || e.key === 'Escape') {
        e.preventDefault();
        reset(name);
      }
    });
  }

  /* ---------- 부팅 ---------- */

  applySaved();     // 첫 페인트 전에 넣어야 폭이 튀지 않는다

  function mount() {
    Array.prototype.forEach.call(document.querySelectorAll('.splitter'), wire);

    var t = null;
    window.addEventListener('resize', function () {
      // 창이 줄면 저장된 폭이 MIN_CENTER 를 침범할 수 있다. 다시 재어 조인다.
      Object.keys(PANES).forEach(function (name) {
        if (typeof saved[name] === 'number') apply(name, saved[name]);
      });
      clearTimeout(t);
      t = setTimeout(afterResize, 160);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  WM.layout = {
    apply: apply, reset: reset, width: px,
    resetAll: function () { Object.keys(PANES).forEach(reset); }
  };
})(window.WM);
