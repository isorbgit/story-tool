/* timeline.js — 타임라인 뷰 (SPEC 9장 / 6장).
   사건을 when.sort 순으로 가로 배치한다.
   precision 이 exact 면 점, 뭉개졌으면 막대, unknown 이면 하단 트레이로 격리. */
(function (WM) {
  'use strict';
  var U = WM.util, el = U.el, store = WM.store;

  var pane = null, bodyEl = null;
  var lanes = [];        // 레인으로 세운 인물 id 들
  var pxPerUnit = 26;    // 1년당 픽셀 (sort 의 1 단위가 1년)
  var zoomTouched = false;
  var showDropped = false;

  var LANE_H = 34, PAD_L = 150, PAD_T = 46;

  function mount(paneEl) { pane = paneEl; }

  var precDef = function (key) { return WM.calendar.precDef(key); };

  /** 사건 노드를 시점 유무로 갈라 낸다. */
  function collect() {
    var dated = [], undated = [];
    store.nodesOfType('event').forEach(function (r) {
      if (!showDropped && r.node.status === 'dropped') return;
      if (WM.app.safeMode() && r.node.reveal === 'spoiler') return;
      var w = r.node.fields.when || {};
      var p = precDef(w.precision || 'unknown');
      if (p.timeline === 'tray' || typeof w.sort !== 'number') undated.push(r);
      // 막대 폭은 달마다 다르므로 여기서 한 번 재서 들고 다닌다 (SPEC 6장).
      else dated.push({
        id: r.id, node: r.node, sort: w.sort, prec: p,
        span: WM.calendar.spanOf(w), display: w.display || ''
      });
    });
    dated.sort(function (a, b) { return a.sort - b.sort; });
    return { dated: dated, undated: undated };
  }

  /** 그 인물·조직이 관여한 사건인가 (레인 필터용). */
  function involves(actorId, eventId) {
    return store.edgesOf(eventId).some(function (e) {
      return e.from === actorId || e.to === actorId;
    });
  }

  function render() {
    if (!pane) return;
    U.clear(pane);

    var data = collect();
    pane.appendChild(toolbar(data));

    bodyEl = el('div.tl-body');
    if (!data.dated.length && !data.undated.length) {
      bodyEl.appendChild(el('div.empty', { text: '사건 노드가 없습니다.' }));
      pane.appendChild(bodyEl);
      return;
    }

    var min = data.dated.length ? data.dated[0].sort : 0;
    var max = data.dated.length ? data.dated[data.dated.length - 1].sort : 0;
    var maxSpan = 0;
    data.dated.forEach(function (d) { maxSpan = Math.max(maxSpan, d.span || 0); });

    /* 기본 배율은 데이터에 맞춘다. 고정값이면 사건이 한 해 안에 몰렸을 때 막대가
       전부 최소폭으로 뭉개져, 달마다 폭을 달리 계산한 의미가 화면에서 사라진다.
       사용자가 배율을 건드린 뒤에는 그 값을 존중한다. */
    if (!zoomTouched && data.dated.length) {
      var avail = Math.max(400, (pane.clientWidth || 900) - PAD_L - 200);
      pxPerUnit = Math.max(2, Math.min(400, avail / Math.max(max - min + maxSpan, 0.4)));
    }

    var width = PAD_L + Math.max(600, (max - min + maxSpan) * pxPerUnit) + 160;

    function xOf(sort) { return PAD_L + (sort - min) * pxPerUnit; }

    var laneList = lanes.length ? lanes : [null];   // null = 전체 레인
    var height = PAD_T + laneList.length * LANE_H + 24;

    var track = el('div.tl-track', { style: { width: width + 'px', height: height + 'px' } });

    /* 눈금 */
    track.appendChild(axis(min, max, xOf, height));

    laneList.forEach(function (actorId, li) {
      var y = PAD_T + li * LANE_H;
      track.appendChild(el('div.tl-lane', { style: { top: y + 'px', width: width + 'px' } }));
      track.appendChild(el('div.tl-lane__name', {
        style: { top: y + 'px' },
        text: actorId ? (store.state.nodes[actorId] || {}).name || actorId : '전체',
        title: actorId ? '이 인물이 관여한 사건만' : '모든 사건'
      }));

      // 이름표는 다음 막대가 시작하기 전까지만 쓸 수 있다. 미리 걸러 두고 그 여백을 넘긴다.
      var visible = data.dated.filter(function (d) { return !actorId || involves(actorId, d.id); });
      visible.forEach(function (d, i) {
        var next = visible[i + 1];
        track.appendChild(mark(d, xOf, y, next ? xOf(next.sort) : Infinity));
      });
    });

    bodyEl.appendChild(track);
    pane.appendChild(bodyEl);

    if (data.undated.length) pane.appendChild(tray(data.undated));
  }

  /* 한글은 10px 폰트에서 글자당 약 10px, 숫자는 tabular-nums 로 약 6px.
     정확히 재려면 DOM 에 붙였다 떼야 하는데 눈금마다 그러면 비싸다. 어림으로 충분하다. */
  function textW(s) {
    var w = 0;
    for (var i = 0; i < s.length; i++) w += /[0-9.]/.test(s[i]) ? 6 : 10;
    return w + 8;
  }

  function niceStep(minStep) {
    var steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
    for (var i = 0; i < steps.length; i++) if (steps[i] >= minStep) return steps[i];
    return Math.ceil(minStep / 1000) * 1000;
  }

  /* sort 의 1 단위가 곧 1년이므로 눈금은 연이 기본이다.
     충분히 확대해 한 해가 넓어지면 달 경계로 갈아 끼운다. 달 길이가 제각각이라
     눈금 간격도 제각각인데, 그게 이 세계의 달력이 실제로 생긴 모양이다. */
  function axis(min, max, xOf, height) {
    var g = el('div.tl-axis');

    if (pxPerUnit >= 340) {
      var D = WM.calendar.daysPerYear();
      var ms = WM.calendar.months();
      for (var y = Math.floor(min); y <= Math.floor(max) + 1; y++) {
        for (var i = 0; i < ms.length; i++) {
          var mx = xOf(y + (ms[i].start - 1) / D);
          if (mx < PAD_L - 40) continue;
          var isYear = i === 0;
          var label = isYear ? y + '년' : ms[i].label;
          /* 각 라벨이 **제 칸 안에** 들어가는지만 본다. 앞뒤 순서로 따지면 좁은 달의
             넘친 라벨이 바로 뒤의 넓은 달을 밀어낸다 — 삼위일체의 달(8일)이 하늘의
             달(48일) 이름을 지우는 식으로. 칸 기준이면 넓은 달이 항상 이긴다. */
          var slot = ms[i].days / D * pxPerUnit;
          var fits = isYear || textW(label) <= slot;
          g.appendChild(el('div.tl-tick' + (isYear ? '.tl-tick--major' : ''), {
            style: { left: mx + 'px', height: height + 'px' }
          }, fits ? [el('span.tl-tick__label', { text: label })] : null));
        }
      }
      return g;
    }

    var range = Math.max(1, max - min);
    // 라벨이 들어갈 만큼 간격을 벌린다. 촘촘한 눈금보다 읽히는 눈금이 낫다.
    var step = niceStep(Math.max(range / 12, 44 / pxPerUnit));
    var start = Math.floor(min / step) * step;
    for (var v = start; v <= max + step; v += step) {
      var x = xOf(v);
      if (x < PAD_L - 40) continue;
      g.appendChild(el('div.tl-tick', { style: { left: x + 'px', height: height + 'px' } },
        [el('span.tl-tick__label', { text: v + '년' })]));
    }
    return g;
  }

  function mark(d, xOf, y, nextX) {
    var isPoint = (d.span || 0) === 0;
    var w = isPoint ? 0 : Math.max(6, d.span * pxPerUnit);
    var color = store.typeColor('event');
    var label = d.node.name + (d.display ? ' · ' + d.display : '');

    var node = el('div.tl-mark' + (isPoint ? '.tl-mark--point' : '.tl-mark--range') +
      '.status--' + d.node.status, {
      style: {
        left: xOf(d.sort) + 'px', top: (y + 6) + 'px',
        width: isPoint ? null : w + 'px',
        borderColor: color, background: isPoint ? color : color + '33'
      },
      title: label + '  (' + d.prec.label + ', sort ' + d.sort + ')',
      onclick: function () { WM.panel.select(d.id); highlight(d.id); }
    }, [
      d.node.reveal === 'spoiler' ? el('span.tl-mark__lock', { text: '🔒' }) : null
    ]);
    node.dataset.id = d.id;

    /* 사건이 몰리면 이름표가 옆 막대와 다음 이름표를 덮어 아무것도 못 읽게 된다.
       다음 막대 전까지 다 들어갈 때만 그린다. 막대는 그대로 남고, 마우스를 올리면
       제목에 이름·정밀도·sort 가 전부 나온다. 안 보이면 확대하거나 레인을 나누면 된다. */
    var lx = xOf(d.sort) + (isPoint ? 8 : w + 8);
    var showLabel = textW(d.node.name) <= (nextX === undefined ? Infinity : nextX) - lx - 4;
    var text = showLabel ? el('div.tl-label', {
      style: { left: lx + 'px', top: (y + 5) + 'px' },
      text: d.node.name,
      onclick: function () { WM.panel.select(d.id); highlight(d.id); }
    }) : null;

    var wrap = el('div.tl-markwrap');
    wrap.appendChild(node);
    if (text) wrap.appendChild(text);
    return wrap;
  }

  function highlight(id) {
    U.$$('.tl-mark.is-sel', pane).forEach(function (m) { m.classList.remove('is-sel'); });
    var m = pane.querySelector('.tl-mark[data-id="' + id + '"]');
    if (m) m.classList.add('is-sel');
  }

  function tray(list) {
    return el('div.tl-tray', {}, [
      el('div.tl-tray__head', { text: '시점 미정 ' + list.length + '건' }),
      el('div.tl-tray__items', {}, list.map(function (r) {
        return el('button.tl-tray__item', {
          type: 'button',
          onclick: function () { WM.panel.select(r.id); }
        }, [
          el('span.dot', { style: { background: store.typeColor('event') } }),
          r.node.name
        ]);
      }))
    ]);
  }

  function toolbar(data) {
    return el('div.tl-toolbar', {}, [
      el('span.dim.small', { text: '사건 ' + data.dated.length + '건 · 미정 ' + data.undated.length + '건' }),
      el('span.spacer'),
      el('span.dim.small', { text: '레인' }),
      el('button.btn.btn--tiny', {
        type: 'button', text: lanes.length ? '인물 ' + lanes.length + '명' : '전체',
        onclick: function () {
          WM.picker.pickNode({
            title: '레인으로 세울 인물·조직', accepts: ['character', 'organization'], exclude: lanes
          }).then(function (id) {
            if (!id) return;
            lanes.push(id);
            render();
          });
        }
      }),
      lanes.length ? el('button.btn.btn--tiny.btn--ghost', {
        type: 'button', text: '레인 지우기', onclick: function () { lanes = []; render(); }
      }) : null,
      el('span.dim.small', { text: '배율' }),
      el('span.segbar', {}, [
        el('button.seg', { type: 'button', text: '−', onclick: function () { zoom(1 / 1.6); } }),
        el('button.seg', { type: 'button', text: '+', onclick: function () { zoom(1.6); } }),
        el('button.seg', {
          type: 'button', text: '맞춤', title: '전체가 보이도록 배율을 맞춥니다',
          onclick: function () { zoomTouched = false; render(); }
        })
      ]),
      el('label.check', {}, [
        el('input', {
          type: 'checkbox', checked: showDropped,
          onchange: function (e) { showDropped = e.target.checked; render(); }
        }),
        el('span', { text: '폐기 포함' })
      ])
    ]);
  }

  function zoom(f) {
    zoomTouched = true;
    pxPerUnit = Math.max(0.5, Math.min(400, pxPerUnit * f));
    render();
  }

  WM.timeline = { mount: mount, render: render, fitZoom: function () { zoomTouched = false; render(); } };
})(window.WM);
