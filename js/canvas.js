/* canvas.js — 그래프 뷰 (SPEC 4장 / 11장 Phase 2).
   노드는 HTML div, 연결선은 SVG path, 팬·줌은 wrapper 하나의 transform (SPEC 1.4).

   핀 좌표는 DOM을 재지 않고 고정 메트릭으로 계산한다. 팬·줌·드래그마다
   getBoundingClientRect 를 부르면 80개 노드에서 바로 버벅인다. */
(function (WM) {
  'use strict';
  var U = WM.util, el = U.el, store = WM.store;

  /* 이 값들은 style.css 의 .cv-node 관련 규칙과 반드시 일치해야 한다. */
  var M = { W: 208, HEAD: 30, ROW: 22, PAD_B: 8, GRID: 8 };
  var ZOOM_MIN = 0.2, ZOOM_MAX = 2.4;

  var pane = null, tabsEl = null, toolbarEl = null, viewportEl = null;
  var worldEl = null, edgeSvg = null, edgeGroup = null, tempPath = null;
  var nodeLayer = null, commentLayer = null, marqueeEl = null;

  var view = { x: 80, y: 80, k: 1 };
  var cid = null;
  var sel = {};                 // 선택된 nodeId
  var selComment = null;
  var touchSelectMode = false;  // 터치에서 빈 곳 드래그를 박스선택으로 (SPEC 4.4)
  var nodeEls = {}, edgePaths = {};

  /* ---------- 기하 ---------- */

  function involveSockets(type) {
    return store.typeDef(type).sockets.filter(function (s) { return s.pin !== 'causal'; });
  }
  function causalSockets(type) {
    return store.typeDef(type).sockets.filter(function (s) { return s.pin === 'causal'; });
  }

  /* ---------- 배치 소스 ----------
     보통은 store 의 캔버스를 쓰지만, 포커스 뷰는 저장되지 않는 임시 배치 위에서 돈다.
     렌더러를 통째로 재사용하려고 여기서 한 겹 감싼다. */

  var ephemeral = null;   // { name, placements, comments }

  function curCanvas() { return ephemeral || store.state.canvases[cid]; }
  function curPlacements() { return (curCanvas() || {}).placements || {}; }
  function isEph() { return !!ephemeral; }
  function isPlacedHere(id) { return !!curPlacements()[id]; }

  function doPlace(id, x, y) {
    if (!isEph()) return store.place(cid, id, x, y);
    if (!curPlacements()[id]) {
      ephemeral.placements[id] = { x: Math.round(x), y: Math.round(y), collapsed: false };
    }
  }
  function doUnplace(id) {
    if (!isEph()) return store.unplace(cid, id);
    delete ephemeral.placements[id];
  }
  function doMove(moves, commit) {
    if (!isEph()) return store.moveNodes(cid, moves, commit);
    moves.forEach(function (m) {
      var p = ephemeral.placements[m.id];
      if (p) { p.x = Math.round(m.x); p.y = Math.round(m.y); }
    });
  }
  function doCollapse(id, val) {
    if (!isEph()) return store.setCollapsed(cid, id, val);
    var p = ephemeral.placements[id];
    if (p) p.collapsed = val === undefined ? !p.collapsed : !!val;
  }

  function placementOf(nodeId) { return curPlacements()[nodeId]; }

  function nodeHeight(nodeId) {
    var p = placementOf(nodeId);
    if (!p || p.collapsed) return M.HEAD;
    var n = store.state.nodes[nodeId];
    return M.HEAD + involveSockets(n.type).length * M.ROW + M.PAD_B;
  }

  /** 소켓 핀의 월드 좌표와 선이 빠져나갈 방향. */
  function pinPos(nodeId, socketKey) {
    var p = placementOf(nodeId);
    var n = store.state.nodes[nodeId];
    if (!p || !n) return null;
    var sock = store.socketDef(n.type, socketKey);
    if (!sock) return null;
    var side = sock.dir === 'in' ? 'l' : 'r';
    var x = side === 'l' ? p.x : p.x + M.W;

    if (p.collapsed || sock.pin === 'causal') {
      return { x: x, y: p.y + M.HEAD / 2, side: side, causal: sock.pin === 'causal' };
    }
    var rows = involveSockets(n.type);
    var i = 0;
    for (var r = 0; r < rows.length; r++) if (rows[r].key === socketKey) { i = r; break; }
    return { x: x, y: p.y + M.HEAD + i * M.ROW + M.ROW / 2, side: side, causal: false };
  }

  function pathD(a, b) {
    var dx = Math.max(40, Math.min(190, Math.abs(b.x - a.x) * 0.55));
    var c1 = a.x + (a.side === 'r' ? dx : -dx);
    var c2 = b.x + (b.side === 'r' ? dx : -dx);
    return 'M' + a.x + ',' + a.y + ' C' + c1 + ',' + a.y + ' ' + c2 + ',' + b.y + ' ' + b.x + ',' + b.y;
  }

  /** 선 색: 인과선은 흰색, 관여선은 "사건이 아닌 쪽" 타입 색. */
  function edgeColor(e) {
    var fromT = (store.state.nodes[e.from] || {}).type;
    var toT = (store.state.nodes[e.to] || {}).type;
    var sock = store.socketDef(fromT, e.fromSocket);
    if (sock && sock.pin === 'causal') return '#e8ecf2';
    if (fromT === 'event' && toT !== 'event') return store.typeColor(toT);
    if (toT === 'event' && fromT !== 'event') return store.typeColor(fromT);
    return store.typeColor(fromT);
  }

  function screenToWorld(cx, cy) {
    var r = viewportEl.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
  }

  function applyTransform() {
    worldEl.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')';
    var z = U.$('#cv-zoom');
    if (z) z.textContent = Math.round(view.k * 100) + '%';
  }

  function snap(v) { return Math.round(v / M.GRID) * M.GRID; }

  /* ---------- 캔버스 목록 ---------- */

  function ensureCanvas() {
    var list = store.canvasList();
    if (!list.length) { cid = store.createCanvas('1장'); return; }
    if (!cid || !store.state.canvases[cid]) cid = list[0].id;
  }

  function renderTabs() {
    U.clear(tabsEl);

    if (isEph()) {
      tabsEl.appendChild(el('button.cv-tab.cv-tab--eph.is-on', {
        type: 'button', title: '임시 화면입니다. 배치는 저장되지 않습니다.'
      }, [ephemeral.name, el('span.cv-tab__n', { text: String(Object.keys(ephemeral.placements).length) })]));
      tabsEl.appendChild(el('button.cv-tab', {
        type: 'button', text: '✕ 포커스 끄기',
        onclick: function () { exitEphemeral(); }
      }));
    }

    store.canvasList().forEach(function (c) {
      tabsEl.appendChild(el('button.cv-tab' + (!isEph() && c.id === cid ? '.is-on' : ''), {
        type: 'button',
        onclick: function () { switchTo(c.id); },
        oncontextmenu: function (e) {
          e.preventDefault();
          U.menu({ x: e.clientX, y: e.clientY }, [
            { label: '이름 바꾸기', onSelect: function () { renameCanvas(c.id); } },
            { sep: true },
            { label: '캔버스 삭제', danger: true, onSelect: function () { deleteCanvasFlow(c.id); } }
          ]);
        }
      }, [
        c.canvas.name,
        el('span.cv-tab__n', { text: String(Object.keys(c.canvas.placements || {}).length) })
      ]));
    });
    tabsEl.appendChild(el('button.cv-tab.cv-tab--add', {
      type: 'button', text: '+', title: '새 캔버스',
      onclick: function () {
        U.modal({
          title: '새 캔버스',
          body: el('label.field', {}, [
            el('span.field__label', { text: '이름' }),
            el('input.input#new-cv-name', { type: 'text', placeholder: '2장 — 은가면의 행방' })
          ]),
          actions: [{ label: '취소', value: null }, { label: '만들기', value: true, kind: 'primary' }]
        }).then(function (ok) {
          if (!ok) return;
          var name = (U.$('#new-cv-name') || {}).value;
          switchTo(store.createCanvas(name || '새 캔버스'));
        });
      }
    }));
  }

  function renameCanvas(id) {
    var c = store.state.canvases[id];
    U.modal({
      title: '캔버스 이름',
      body: el('input.input#cv-rename', { type: 'text', value: c.name }),
      actions: [{ label: '취소', value: null }, { label: '저장', value: true, kind: 'primary' }]
    }).then(function (ok) {
      if (!ok) return;
      store.updateCanvas(id, { name: U.$('#cv-rename').value || c.name });
      renderTabs();
    });
  }

  function deleteCanvasFlow(id) {
    var c = store.state.canvases[id];
    var n = Object.keys(c.placements || {}).length;
    U.confirmModal('캔버스 삭제', [
      el('p', {}, ['「', el('b', { text: c.name }), '」 를 삭제합니다.']),
      el('p.dim', { text: '배치 ' + n + '건이 사라집니다. 노드와 엣지는 그대로 남습니다.' })
    ], '삭제', 'danger').then(function (ok) {
      if (!ok) return;
      store.deleteCanvas(id);
      cid = null;
      ensureCanvas();
      render();
    });
  }

  function switchTo(id) {
    ephemeral = null;
    cid = id;
    sel = {}; selComment = null;
    render();
    fitAll();
  }

  /* ---------- 포커스 뷰 (SPEC 9장) ----------
     선택 노드 기준 N단계 이웃만 자동 배치해 임시로 보여준다. 저장하지 않는다.
     노드가 100개를 넘으면 캔버스는 읽을 수 없게 되므로, 규모 대응은 이쪽이 담당한다. */

  function autoLayout(centerId, depths) {
    var byDepth = {};
    Object.keys(depths).forEach(function (id) {
      (byDepth[depths[id]] = byDepth[depths[id]] || []).push(id);
    });
    var placements = {};
    Object.keys(byDepth).map(Number).sort(function (a, b) { return a - b; }).forEach(function (d) {
      var ring = byDepth[d].sort(function (a, b) {
        var na = store.state.nodes[a], nb = store.state.nodes[b];
        return na.type.localeCompare(nb.type) || na.name.localeCompare(nb.name, 'ko');
      });
      if (d === 0) { placements[ring[0]] = { x: 0, y: 0, collapsed: false }; return; }
      // 동심원 배치. 링마다 반지름을 키우고, 노드가 많으면 세로 간격을 넓힌다.
      var radius = d * Math.max(340, ring.length * 26);
      ring.forEach(function (id, i) {
        var t = (i / ring.length) * Math.PI * 2 - Math.PI / 2;
        placements[id] = {
          x: snap(Math.cos(t) * radius),
          y: snap(Math.sin(t) * radius * 0.62),
          collapsed: d >= 2       // 바깥 링은 접어서 화면을 아낀다
        };
      });
    });
    return placements;
  }

  function focusOn(nodeId, depth) {
    var node = store.state.nodes[nodeId];
    if (!node) { U.toast('없는 노드입니다.', 'bad'); return; }
    depth = Math.max(1, Math.min(3, depth || focusDepth));
    focusDepth = depth;
    focusCenter = nodeId;
    var depths = store.neighborhood(nodeId, depth);
    ephemeral = {
      name: '포커스: ' + node.name + ' · ' + depth + '단계',
      placements: autoLayout(nodeId, depths),
      comments: []
    };
    sel = {}; selComment = null;
    render();
    fitAll();
    WM.panel.select(nodeId);
  }

  function exitEphemeral() {
    if (!isEph()) return;
    ephemeral = null;
    focusCenter = null;
    ensureCanvas();
    render();
    fitAll();
  }

  var focusDepth = 1, focusCenter = null;

  /* ---------- 툴바 ---------- */

  function renderToolbar() {
    U.clear(toolbarEl);
    toolbarEl.appendChild(el('button.btn.btn--tiny', {
      type: 'button', text: '전체 보기', title: 'Home', onclick: fitAll
    }));
    toolbarEl.appendChild(el('button.btn.btn--tiny', {
      type: 'button', text: '선택 포커스', title: 'F', onclick: focusSelection
    }));
    toolbarEl.appendChild(el('button.btn.btn--tiny', {
      type: 'button', text: '+ 노드 배치',
      onclick: function () {
        var c = viewportEl.getBoundingClientRect();
        var w = screenToWorld(c.left + c.width / 2, c.top + c.height / 3);
        placeExisting(w.x, w.y);
      }
    }));
    toolbarEl.appendChild(el('button.btn.btn--tiny', {
      type: 'button', text: '코멘트', title: 'C', onclick: function () { addCommentBox(); }
    }));

    if (isEph() && focusCenter) {
      toolbarEl.appendChild(el('span.cv-depth', {}, [
        el('span.dim.small', { text: '단계' }),
        el('span.segbar', {}, [1, 2, 3].map(function (d) {
          return el('button.seg' + (focusDepth === d ? '.is-on' : ''), {
            type: 'button', text: String(d),
            onclick: function () { focusOn(focusCenter, d); }
          });
        })),
        el('span.dim.small', { text: Object.keys(ephemeral.placements).length + '개' })
      ]));
    } else {
      toolbarEl.appendChild(el('button.btn.btn--tiny', {
        type: 'button', text: '포커스', title: '선택 노드 기준 이웃만 임시로 펼칩니다',
        onclick: function () {
          var ids = Object.keys(sel);
          if (!ids.length) { U.toast('노드를 먼저 선택해 주세요.', 'warn'); return; }
          focusOn(ids[0], focusDepth);
        }
      }));
    }

    toolbarEl.appendChild(el('span.spacer'));
    toolbarEl.appendChild(el('button.btn.btn--tiny.only-touch' + (touchSelectMode ? '.is-on' : ''), {
      type: 'button', text: '선택 모드', title: '터치에서 빈 곳 드래그를 박스 선택으로',
      onclick: function () { touchSelectMode = !touchSelectMode; renderToolbar(); }
    }));
    toolbarEl.appendChild(el('span#cv-zoom.dim.small', { text: '100%' }));
    toolbarEl.appendChild(el('button.btn.btn--tiny', {
      type: 'button', text: '?', title: '조작법', onclick: showHelp
    }));
  }

  function showHelp() {
    var rows = [
      ['팬', '우클릭 드래그 / 스페이스+드래그 / 휠 클릭', '한 손가락 드래그'],
      ['줌', '휠', '핀치'],
      ['전체 보기 · 포커스', 'Home · F', '툴바 버튼'],
      ['노드 생성', '빈 곳 우클릭 → 타입 선택', '길게 누르기'],
      ['연결', '핀에서 드래그 → 다른 핀에 놓기', '동일'],
      ['빈 곳에 놓기', '타입이 맞는 노드 검색 팝업', '동일'],
      ['다중 선택', '드래그 박스 / Ctrl+클릭', '선택 모드 켠 뒤 드래그'],
      ['배치만 제거', 'Delete', '길게 누르기 → 메뉴'],
      ['전역 삭제', '노드 우클릭 → 전역 삭제', '길게 누르기 → 메뉴'],
      ['노드 접기', 'Alt+클릭', '헤더 더블탭'],
      ['코멘트 박스', 'C', '툴바 버튼'],
      ['검색 팔레트', 'Ctrl+P', '—']
    ];
    U.modal({
      title: '조작법',
      body: el('table.help-table', {}, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: '' }), el('th', { text: '마우스' }), el('th', { text: '터치' })
        ])]),
        el('tbody', {}, rows.map(function (r) {
          return el('tr', {}, [
            el('td', { text: r[0] }), el('td', { text: r[1] }), el('td.dim', { text: r[2] })
          ]);
        }))
      ]),
      actions: [{ label: '닫기', value: null }]
    });
  }

  /* ---------- 노드 렌더 ---------- */

  function buildNode(nodeId) {
    var n = store.state.nodes[nodeId];
    var p = placementOf(nodeId);
    var def = store.typeDef(n.type);
    var color = store.typeColor(n.type);

    var head = el('div.cv-node__head', { style: { background: color } }, [
      el('span.cv-node__name', { text: n.name, title: n.name + ' · ' + nodeId }),
      n.reveal === 'spoiler' ? el('span.cv-node__lock', { text: '🔒', title: '미공개' }) : null,
      el('span.cv-node__caret', { text: p.collapsed ? '▸' : '▾' })
    ]);

    causalSockets(n.type).forEach(function (s) {
      head.appendChild(el('span.cv-pin.cv-pin--causal.cv-pin--' + (s.dir === 'in' ? 'l' : 'r'), {
        dataset: { node: nodeId, socket: s.key, side: s.dir === 'in' ? 'l' : 'r' },
        title: s.label
      }));
    });

    var kids = [head];

    if (!p.collapsed) {
      var rows = involveSockets(n.type).map(function (s) {
        var conns = store.connectionsOf(nodeId, s.key);
        var ghosts = conns.filter(function (c) { return !isPlacedHere(c.otherId); });
        var side = s.dir === 'in' ? 'l' : 'r';
        return el('div.cv-row.cv-row--' + side, { dataset: { socket: s.key } }, [
          el('span.cv-pin.cv-pin--' + side + (conns.length ? '.is-linked' : ''), {
            dataset: { node: nodeId, socket: s.key, side: side },
            style: { background: conns.length ? store.typeColor(s.accepts[0]) : 'transparent',
                     borderColor: store.typeColor(s.accepts[0]) },
            title: s.label + ' — ' + s.accepts.map(store.typeLabel).join(', ')
          }),
          el('span.cv-row__label', { text: s.label }),
          ghosts.length ? el('span.cv-ghost', {
            dataset: { node: nodeId, socket: s.key },
            text: '↗' + ghosts.length,
            title: '이 캔버스에 없는 연결 ' + ghosts.length + '건'
          }) : null
        ]);
      });
      kids.push(el('div.cv-node__rows', {}, rows));
    }

    var box = el('div.cv-node.status--' + n.status + (sel[nodeId] ? '.is-sel' : ''), {
      dataset: { id: nodeId },
      style: {
        left: p.x + 'px', top: p.y + 'px', width: M.W + 'px',
        '--type-color': color
      }
    }, kids);

    if (n.impl === 'done') box.appendChild(el('span.cv-node__impl', { text: '✓', title: '구현됨' }));
    return box;
  }

  function renderNodes() {
    U.clear(nodeLayer);
    nodeEls = {};
    var pl = curPlacements();
    Object.keys(pl).forEach(function (nodeId) {
      if (!store.state.nodes[nodeId]) return;   // 노드가 지워졌는데 배치가 남은 경우
      if (WM.app.hidden(nodeId)) return;        // 안전 모드
      var box = buildNode(nodeId);
      nodeEls[nodeId] = box;
      nodeLayer.appendChild(box);
    });
  }

  /* ---------- 연결선 ---------- */

  function renderEdges() {
    U.clear(edgeGroup);
    edgePaths = {};
    store.edgesForPlacements(curPlacements()).forEach(function (item) {
      var e = item.edge;
      if (WM.app.hidden(e.from) || WM.app.hidden(e.to)) return;   // 숨긴 노드로 가는 선도 숨긴다
      var a = pinPos(e.from, e.fromSocket), b = pinPos(e.to, e.toSocket);
      if (!a || !b) return;
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathD(a, b));
      path.setAttribute('class', 'cv-edge status--' + e.status + (a.causal ? ' cv-edge--causal' : ''));
      path.setAttribute('stroke', edgeColor(e));
      path.setAttribute('data-id', item.id);
      edgeGroup.appendChild(path);
      edgePaths[item.id] = path;
    });
  }

  /** 드래그 중에는 움직인 노드에 걸린 선만 다시 계산한다. */
  function updateEdgesFor(nodeIds) {
    var set = {};
    nodeIds.forEach(function (id) { set[id] = true; });
    Object.keys(edgePaths).forEach(function (eid) {
      var e = store.state.edges[eid];
      if (!e || (!set[e.from] && !set[e.to])) return;
      var a = pinPos(e.from, e.fromSocket), b = pinPos(e.to, e.toSocket);
      if (a && b) edgePaths[eid].setAttribute('d', pathD(a, b));
    });
  }

  /* ---------- 코멘트 박스 ---------- */

  function renderComments() {
    U.clear(commentLayer);
    var list = (curCanvas() || {}).comments || [];
    list.forEach(function (c, i) {
      commentLayer.appendChild(el('div.cv-comment' + (selComment === i ? '.is-sel' : ''), {
        dataset: { i: String(i) },
        style: {
          left: c.x + 'px', top: c.y + 'px', width: c.w + 'px', height: c.h + 'px',
          borderColor: c.color, background: c.color + '22'
        }
      }, [
        el('div.cv-comment__head', { style: { background: c.color } }, [
          el('span.cv-comment__text', { text: c.text || '코멘트' })
        ]),
        el('div.cv-comment__grip')
      ]));
    });
  }

  function addCommentBox() {
    if (isEph()) { U.toast('포커스 뷰는 임시 화면이라 코멘트를 남길 수 없습니다.', 'warn'); return; }
    var ids = Object.keys(sel);
    var box;
    if (ids.length) {
      var b = boundsOf(ids);
      box = { x: b.x1 - 24, y: b.y1 - 44, w: b.x2 - b.x1 + 48, h: b.y2 - b.y1 + 68 };
    } else {
      var r = viewportEl.getBoundingClientRect();
      var w = screenToWorld(r.left + r.width / 2 - 160, r.top + r.height / 2 - 100);
      box = { x: snap(w.x), y: snap(w.y), w: 320, h: 200 };
    }
    box.text = '새 코멘트';
    var i = store.addComment(cid, box);
    selComment = i;
    renderComments();
    editComment(i);
  }

  function editComment(i) {
    var c = curCanvas().comments[i];
    U.modal({
      title: '코멘트',
      body: el('div.form', {}, [
        el('label.field', {}, [
          el('span.field__label', { text: '내용' }),
          el('input.input#cm-text', { type: 'text', value: c.text || '' })
        ]),
        el('label.field', {}, [
          el('span.field__label', { text: '색' }),
          el('div.cm-colors', {}, ['#3a4a5c', '#4a3a5c', '#3a5c46', '#5c4a3a', '#5c3a3a'].map(function (col) {
            return el('button.cm-color' + (c.color === col ? '.is-on' : ''), {
              type: 'button', style: { background: col }, dataset: { col: col },
              onclick: function (e) {
                U.$$('.cm-color').forEach(function (b) { b.classList.remove('is-on'); });
                e.currentTarget.classList.add('is-on');
              }
            });
          }))
        ])
      ]),
      actions: [
        { label: '삭제', value: 'del', kind: 'danger' },
        { label: '취소', value: null },
        { label: '저장', value: true, kind: 'primary' }
      ]
    }).then(function (v) {
      if (v === 'del') { store.deleteComment(cid, i); selComment = null; renderComments(); return; }
      if (!v) return;
      var picked = U.$('.cm-color.is-on');
      store.updateComment(cid, i, {
        text: U.$('#cm-text').value,
        color: picked ? picked.dataset.col : c.color
      });
      renderComments();
    });
  }

  /* ---------- 선택 ---------- */

  function boundsOf(ids) {
    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    ids.forEach(function (id) {
      var p = placementOf(id);
      if (!p) return;
      x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
      x2 = Math.max(x2, p.x + M.W); y2 = Math.max(y2, p.y + nodeHeight(id));
    });
    if (x1 === Infinity) return null;
    return { x1: x1, y1: y1, x2: x2, y2: y2 };
  }

  function setSelection(ids, additive) {
    if (!additive) sel = {};
    ids.forEach(function (id) { sel[id] = true; });
    selComment = null;
    syncSelectionClasses();
    var only = Object.keys(sel);
    if (only.length === 1) WM.panel.select(only[0]);
  }

  function syncSelectionClasses() {
    Object.keys(nodeEls).forEach(function (id) {
      nodeEls[id].classList.toggle('is-sel', !!sel[id]);
    });
    U.$$('.cv-comment', commentLayer).forEach(function (c) {
      c.classList.toggle('is-sel', selComment !== null && Number(c.dataset.i) === selComment);
    });
  }

  function fitTo(b, pad) {
    if (!b) return;
    pad = pad || 60;
    var r = viewportEl.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var k = Math.min((r.width - pad * 2) / Math.max(1, b.x2 - b.x1),
                     (r.height - pad * 2) / Math.max(1, b.y2 - b.y1));
    view.k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, k));
    view.x = r.width / 2 - ((b.x1 + b.x2) / 2) * view.k;
    view.y = r.height / 2 - ((b.y1 + b.y2) / 2) * view.k;
    applyTransform();
  }

  function fitAll() {
    var ids = Object.keys(curPlacements()).filter(function (i) { return store.state.nodes[i]; });
    if (!ids.length) { view = { x: 80, y: 80, k: 1 }; applyTransform(); return; }
    fitTo(boundsOf(ids));
  }

  function focusSelection() {
    var ids = Object.keys(sel);
    if (!ids.length) { fitAll(); return; }
    var b = boundsOf(ids);
    if (b && ids.length === 1) { b.x1 -= 220; b.x2 += 220; b.y1 -= 140; b.y2 += 140; }
    fitTo(b);
  }

  /* ---------- 배치 / 생성 ---------- */

  function placeExisting(wx, wy) {
    WM.picker.pickNode({
      title: '이 캔버스에 배치할 노드',
      exclude: Object.keys(curPlacements())
    }).then(function (id) {
      if (!id) return;
      doPlace(id, snap(wx), snap(wy));
      render();
      setSelection([id]);
    });
  }

  function createAt(type, wx, wy) {
    WM.picker.pickNode({
      title: '배치할 ' + store.typeLabel(type),
      accepts: [type],
      exclude: Object.keys(curPlacements())
    }).then(function (id) {
      if (!id) return;
      doPlace(id, snap(wx), snap(wy));
      render();
      setSelection([id]);
    });
  }

  /* ---------- 고스트 핀 팝오버 (SPEC 4.1) ---------- */

  function showGhosts(nodeId, socketKey, x, y) {
    var ghosts = store.ghostsForPlacements(curPlacements(), nodeId, socketKey);
    var sock = store.socketDef(store.state.nodes[nodeId].type, socketKey);

    var rows = ghosts.map(function (g) {
      var other = g.other || {};
      var where = store.canvasesWith(g.otherId);
      return el('div.ghost-row', {}, [
        el('div.ghost-row__main', {}, [
          el('span.dot', { style: { background: store.typeColor(other.type) } }),
          el('span.ghost-row__name', { text: other.name || g.otherId }),
          g.edge.label ? el('span.ghost-row__label', { text: g.edge.label }) : null
        ]),
        el('div.ghost-row__acts', {}, [
          el('button.btn.btn--tiny', {
            type: 'button', text: '이 캔버스로 가져오기',
            onclick: function () {
              var base = placementOf(nodeId);
              var dir = sock.dir === 'in' ? -1 : 1;
              doPlace(g.otherId, snap(base.x + dir * (M.W + 90)), snap(base.y + spread(nodeId)));
              closePopover();
              render();
              setSelection([g.otherId]);
            }
          }),
          where.length ? el('button.btn.btn--tiny.btn--ghost', {
            type: 'button', text: '있는 캔버스로 점프',
            onclick: function () {
              closePopover();
              cid = where[0];
              render();
              setSelection([g.otherId]);
              focusSelection();
            }
          }) : el('span.dim.small', { text: '어느 캔버스에도 없음' })
        ])
      ]);
    });

    openPopover(x, y, el('div.ghost-pop', {}, [
      el('div.ghost-pop__head', { text: sock.label + ' — 이 캔버스에 없는 연결 ' + ghosts.length + '건' }),
      el('div.ghost-pop__list', {}, rows),
      ghosts.length > 1 ? el('button.btn.btn--tiny', {
        type: 'button', text: '전부 가져오기',
        onclick: function () {
          var base = placementOf(nodeId);
          var dir = sock.dir === 'in' ? -1 : 1;
          ghosts.forEach(function (g, i) {
            doPlace(g.otherId, snap(base.x + dir * (M.W + 90)), snap(base.y + (i - (ghosts.length - 1) / 2) * 90));
          });
          closePopover();
          render();
        }
      }) : null
    ]));
  }

  var spreadCounter = {};
  function spread(nodeId) {
    spreadCounter[nodeId] = (spreadCounter[nodeId] || 0) + 1;
    return (spreadCounter[nodeId] - 1) * 80;
  }

  var popoverEl = null;
  function openPopover(x, y, content) {
    closePopover();
    popoverEl = el('div.cv-popover', {}, content);
    document.body.appendChild(popoverEl);
    var w = popoverEl.offsetWidth, h = popoverEl.offsetHeight;
    popoverEl.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    popoverEl.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + 'px';
    setTimeout(function () { document.addEventListener('pointerdown', outsideClose, true); }, 0);
  }
  function outsideClose(e) {
    if (popoverEl && !popoverEl.contains(e.target)) closePopover();
  }
  function closePopover() {
    document.removeEventListener('pointerdown', outsideClose, true);
    if (popoverEl && popoverEl.parentNode) popoverEl.parentNode.removeChild(popoverEl);
    popoverEl = null;
  }

  /* ---------- 컨텍스트 메뉴 ---------- */

  function nodeMenu(nodeId, x, y) {
    var p = placementOf(nodeId);
    var many = Object.keys(sel).length > 1 && sel[nodeId];
    var targets = many ? Object.keys(sel) : [nodeId];
    U.menu({ x: x, y: y }, [
      { label: p.collapsed ? '펴기' : '접기', onSelect: function () {
        targets.forEach(function (id) { doCollapse(id, !p.collapsed); });
        render();
      } },
      { label: '표 뷰에서 보기', onSelect: function () { WM.app.showTable(nodeId); } },
      { label: '이 노드로 포커스', onSelect: function () { WM.app.showFocus(nodeId); } },
      { sep: true },
      { label: '배치만 제거' + (many ? ' (' + targets.length + '개)' : '') + ' — Delete',
        onSelect: function () { targets.forEach(doUnplace); sel = {}; render(); } },
      { label: '전역 삭제…', danger: true, onSelect: function () { globalDelete(nodeId); } }
    ]);
  }

  /** SPEC 4.2 — 노드 자체를 지운다. 경고 모달은 패널과 같은 흐름을 쓴다. */
  function globalDelete(nodeId) {
    var node = store.state.nodes[nodeId];
    var imp = store.impactOf(nodeId);
    U.modal({
      title: node.name + ' 전역 삭제',
      body: [
        el('p', {}, [el('code', { text: nodeId }), ' 를 완전히 삭제합니다.']),
        el('ul.impact-summary', {}, [
          el('li', {}, ['· 참조 엣지 ', el('b', { text: String(imp.edgeCount) }), ' 개가 함께 삭제됩니다']),
          el('li', {}, ['· ', el('b', { text: String(imp.canvasCount) }), ' 개 캔버스에서 배치가 제거됩니다'])
        ])
      ],
      actions: [{ label: '취소', value: null }, { label: '삭제', value: true, kind: 'danger' }]
    }).then(function (ok) {
      if (!ok) return;
      store.deleteNode(nodeId);
      delete sel[nodeId];
      render();
    });
  }

  function emptyMenu(x, y) {
    var w = screenToWorld(x, y);
    U.menu({ x: x, y: y }, store.typeKeys().map(function (t) {
      return { label: store.typeLabel(t) + ' 배치·생성', onSelect: function () { createAt(t, w.x, w.y); } };
    }).concat([
      { sep: true },
      { label: '기존 노드 배치…', onSelect: function () { placeExisting(w.x, w.y); } },
      { label: '코멘트 박스', onSelect: function () { addCommentBox(); } },
      { label: '전체 보기', onSelect: fitAll }
    ]));
  }

  /* ---------- 입력 ----------
     Pointer Events 하나로 마우스·터치·펜을 함께 다룬다. */

  var drag = null;
  var pointers = {};
  var pinch = null;
  var spaceDown = false;
  var longPressTimer = null;
  var lastTap = { t: 0, id: null };

  function onPointerDown(e) {
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (Object.keys(pointers).length === 2) { startPinch(); return; }
    if (Object.keys(pointers).length > 2) return;

    closePopover();
    var t = e.target;
    var isTouch = e.pointerType === 'touch';

    var ghost = t.closest('.cv-ghost');
    if (ghost) {
      e.preventDefault();
      showGhosts(ghost.dataset.node, ghost.dataset.socket, e.clientX, e.clientY);
      return;
    }

    var pin = t.closest('.cv-pin');
    if (pin) {
      e.preventDefault();
      startLink(pin, e);
      return;
    }

    var grip = t.closest('.cv-comment__grip');
    if (grip) {
      e.preventDefault();
      var ci = Number(grip.closest('.cv-comment').dataset.i);
      var cm = store.state.canvases[cid].comments[ci];
      drag = { type: 'comment-resize', i: ci, w0: cm.w, h0: cm.h, sx: e.clientX, sy: e.clientY };
      viewportEl.setPointerCapture(e.pointerId);
      return;
    }

    var comment = t.closest('.cv-comment');
    if (comment) {
      e.preventDefault();
      var i = Number(comment.dataset.i);
      selComment = i; sel = {}; syncSelectionClasses();
      var c = curCanvas().comments[i];
      drag = { type: 'comment', i: i, x0: c.x, y0: c.y, sx: e.clientX, sy: e.clientY };
      viewportEl.setPointerCapture(e.pointerId);
      if (isTouch) armLongPress(function () { editComment(i); });
      return;
    }

    var nodeEl = t.closest('.cv-node');
    if (nodeEl) {
      var id = nodeEl.dataset.id;

      if (e.altKey) {                       // Alt+클릭 = 접기 (SPEC 4.3)
        e.preventDefault();
        doCollapse(id);
        render();
        return;
      }
      if (isTouch && t.closest('.cv-node__head')) {
        var now = Date.now();
        if (lastTap.id === id && now - lastTap.t < 320) {   // 헤더 더블탭 = 접기 (SPEC 4.4)
          lastTap = { t: 0, id: null };
          store.setCollapsed(cid, id);
          render();
          return;
        }
        lastTap = { t: now, id: id };
      }

      e.preventDefault();
      var additive = e.ctrlKey || e.metaKey || e.shiftKey;
      if (!sel[id]) setSelection([id], additive);
      else if (additive) { delete sel[id]; syncSelectionClasses(); return; }
      else WM.panel.select(id);

      var moving = Object.keys(sel);
      drag = {
        type: 'node', ids: moving, sx: e.clientX, sy: e.clientY, moved: false,
        start: moving.map(function (nid) {
          var p = placementOf(nid);
          return { id: nid, x: p.x, y: p.y };
        })
      };
      viewportEl.setPointerCapture(e.pointerId);
      if (isTouch) armLongPress(function () { drag = null; nodeMenu(id, e.clientX, e.clientY); });
      return;
    }

    /* 빈 곳 */
    var wantPan = e.button === 2 || e.button === 1 || spaceDown || (isTouch && !touchSelectMode);
    if (wantPan) {
      drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
      viewportEl.setPointerCapture(e.pointerId);
      viewportEl.classList.add('is-panning');
    } else if (e.button === 0) {
      var w0 = screenToWorld(e.clientX, e.clientY);
      drag = { type: 'marquee', sx: e.clientX, sy: e.clientY, wx: w0.x, wy: w0.y,
               additive: e.ctrlKey || e.metaKey || e.shiftKey };
      viewportEl.setPointerCapture(e.pointerId);
    }
    if (isTouch) armLongPress(function () { drag = null; emptyMenu(e.clientX, e.clientY); });
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {
      sel = {}; selComment = null; syncSelectionClasses();
    }
  }

  function armLongPress(fn) {
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(function () {
      longPressTimer = null;
      if (navigator.vibrate) navigator.vibrate(12);
      fn();
    }, 520);
  }
  function cancelLongPress() { clearTimeout(longPressTimer); longPressTimer = null; }

  function onPointerMove(e) {
    if (pointers[e.pointerId]) { pointers[e.pointerId] = { x: e.clientX, y: e.clientY }; }
    if (pinch) { updatePinch(); return; }
    if (!drag) return;

    var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) cancelLongPress();

    if (drag.type === 'pan') {
      view.x = drag.vx + dx; view.y = drag.vy + dy;
      applyTransform();

    } else if (drag.type === 'node') {
      drag.moved = true;
      var moves = drag.start.map(function (s) {
        return { id: s.id, x: snap(s.x + dx / view.k), y: snap(s.y + dy / view.k) };
      });
      doMove(moves, false);
      moves.forEach(function (m) {
        var elx = nodeEls[m.id];
        if (elx) { elx.style.left = m.x + 'px'; elx.style.top = m.y + 'px'; }
      });
      updateEdgesFor(drag.ids);

    } else if (drag.type === 'link') {
      var w = screenToWorld(e.clientX, e.clientY);
      var target = hitPin(e.clientX, e.clientY);
      tempPath.setAttribute('d', pathD(drag.from, {
        x: target ? target.pos.x : w.x, y: target ? target.pos.y : w.y,
        side: drag.from.side === 'r' ? 'l' : 'r'
      }));
      highlightDropTargets(target);

    } else if (drag.type === 'marquee') {
      var r = viewportEl.getBoundingClientRect();
      var x1 = Math.min(drag.sx, e.clientX) - r.left, x2 = Math.max(drag.sx, e.clientX) - r.left;
      var y1 = Math.min(drag.sy, e.clientY) - r.top, y2 = Math.max(drag.sy, e.clientY) - r.top;
      marqueeEl.hidden = false;
      marqueeEl.style.left = x1 + 'px'; marqueeEl.style.top = y1 + 'px';
      marqueeEl.style.width = (x2 - x1) + 'px'; marqueeEl.style.height = (y2 - y1) + 'px';

    } else if (drag.type === 'comment') {
      store.updateComment(cid, drag.i, {
        x: snap(drag.x0 + dx / view.k), y: snap(drag.y0 + dy / view.k)
      }, false);
      var cel = commentLayer.querySelector('.cv-comment[data-i="' + drag.i + '"]');
      var cc = store.state.canvases[cid].comments[drag.i];
      if (cel) { cel.style.left = cc.x + 'px'; cel.style.top = cc.y + 'px'; }

    } else if (drag.type === 'comment-resize') {
      store.updateComment(cid, drag.i, {
        w: Math.max(120, snap(drag.w0 + dx / view.k)),
        h: Math.max(80, snap(drag.h0 + dy / view.k))
      }, false);
      var cel2 = commentLayer.querySelector('.cv-comment[data-i="' + drag.i + '"]');
      var cc2 = store.state.canvases[cid].comments[drag.i];
      if (cel2) { cel2.style.width = cc2.w + 'px'; cel2.style.height = cc2.h + 'px'; }
    }
  }

  function onPointerUp(e) {
    delete pointers[e.pointerId];
    cancelLongPress();
    if (pinch && Object.keys(pointers).length < 2) { pinch = null; return; }
    if (!drag) return;
    var d = drag;
    drag = null;
    viewportEl.classList.remove('is-panning');

    if (d.type === 'node') {
      if (d.moved) doMove(d.start.map(function (s) {
        var p = placementOf(s.id);
        return { id: s.id, x: p.x, y: p.y };
      }), true);

    } else if (d.type === 'link') {
      finishLink(e, d);

    } else if (d.type === 'marquee') {
      marqueeEl.hidden = true;
      var w1 = screenToWorld(Math.min(d.sx, e.clientX), Math.min(d.sy, e.clientY));
      var w2 = screenToWorld(Math.max(d.sx, e.clientX), Math.max(d.sy, e.clientY));
      var hits = Object.keys(curPlacements()).filter(function (id) {
        var p = placementOf(id);
        if (!store.state.nodes[id]) return false;
        return p.x < w2.x && p.x + M.W > w1.x && p.y < w2.y && p.y + nodeHeight(id) > w1.y;
      });
      if (hits.length) setSelection(hits, d.additive);

    } else if (d.type === 'comment' || d.type === 'comment-resize') {
      store.updateComment(cid, d.i, {}, true);
    }
  }

  /* ---------- 핀 드래그 연결 ---------- */

  function startLink(pinEl, e) {
    var nodeId = pinEl.dataset.node, socketKey = pinEl.dataset.socket;
    var pos = pinPos(nodeId, socketKey);
    drag = { type: 'link', nodeId: nodeId, socketKey: socketKey, from: pos };
    tempPath.setAttribute('d', pathD(pos, { x: pos.x, y: pos.y, side: pos.side === 'r' ? 'l' : 'r' }));
    tempPath.setAttribute('stroke', store.typeColor(
      store.socketDef(store.state.nodes[nodeId].type, socketKey).accepts[0]));
    tempPath.style.display = '';
    viewportEl.setPointerCapture(e.pointerId);
    viewportEl.classList.add('is-linking');
  }

  function hitPin(cx, cy) {
    var elx = document.elementFromPoint(cx, cy);
    var pinEl = elx && elx.closest ? elx.closest('.cv-pin') : null;
    if (!pinEl) return null;
    var pos = pinPos(pinEl.dataset.node, pinEl.dataset.socket);
    if (!pos) return null;
    return { el: pinEl, nodeId: pinEl.dataset.node, socketKey: pinEl.dataset.socket, pos: pos };
  }

  /** 드래그 중 꽂을 수 있는 핀만 밝힌다. 블루프린트의 타입 감응. */
  function highlightDropTargets(hover) {
    if (!drag || drag.type !== 'link') return;
    var srcNode = store.state.nodes[drag.nodeId];
    var srcSock = store.socketDef(srcNode.type, drag.socketKey);
    U.$$('.cv-pin', nodeLayer).forEach(function (p) {
      var tgtNode = store.state.nodes[p.dataset.node];
      if (!tgtNode) return;
      var okType = srcSock.accepts.indexOf(tgtNode.type) >= 0 &&
        store.socketDef(tgtNode.type, p.dataset.socket).accepts.indexOf(srcNode.type) >= 0;
      p.classList.toggle('is-droppable', okType && p.dataset.node !== drag.nodeId);
      p.classList.toggle('is-hover', !!hover && hover.el === p);
    });
  }

  function clearDropHighlights() {
    U.$$('.cv-pin', nodeLayer).forEach(function (p) {
      p.classList.remove('is-droppable', 'is-hover');
    });
  }

  function finishLink(e, src) {
    tempPath.style.display = 'none';
    viewportEl.classList.remove('is-linking');
    clearDropHighlights();

    var target = hitPin(e.clientX, e.clientY);
    if (target) {
      if (target.nodeId === src.nodeId) return;
      try {
        var r = store.connect(src.nodeId, src.socketKey, target.nodeId);
        if (r.existed) U.toast('이미 연결돼 있습니다.', 'warn');
      } catch (err) {
        U.toast(err.message, 'bad', 5000);
      }
      render();
      return;
    }

    // 빈 곳에 놓으면 타입이 맞는 노드 검색 팝업 (SPEC 4.3 컨텍스트 감응)
    var sock = store.socketDef(store.state.nodes[src.nodeId].type, src.socketKey);
    var w = screenToWorld(e.clientX, e.clientY);
    WM.picker.pickNode({
      title: '「' + sock.label + '」 에 연결',
      accepts: sock.accepts,
      exclude: [src.nodeId]
    }).then(function (id) {
      if (!id) return;
      try { store.connect(src.nodeId, src.socketKey, id); }
      catch (err) { U.toast(err.message, 'bad', 5000); return; }
      if (!isPlacedHere(id)) doPlace(id, snap(w.x), snap(w.y - 20));
      render();
      setSelection([id]);
    });
  }

  /* ---------- 핀치 줌 ---------- */

  function startPinch() {
    var ps = Object.keys(pointers).map(function (k) { return pointers[k]; });
    if (ps.length < 2) return;
    drag = null;
    cancelLongPress();
    pinch = {
      d0: dist(ps[0], ps[1]),
      k0: view.k,
      mid: mid(ps[0], ps[1]),
      vx: view.x, vy: view.y
    };
    var r = viewportEl.getBoundingClientRect();
    pinch.world = {
      x: (pinch.mid.x - r.left - view.x) / view.k,
      y: (pinch.mid.y - r.top - view.y) / view.k
    };
  }

  function updatePinch() {
    var ps = Object.keys(pointers).map(function (k) { return pointers[k]; });
    if (ps.length < 2) return;
    var d = dist(ps[0], ps[1]);
    var m2 = mid(ps[0], ps[1]);
    var r = viewportEl.getBoundingClientRect();
    view.k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinch.k0 * (d / pinch.d0)));
    view.x = m2.x - r.left - pinch.world.x * view.k;
    view.y = m2.y - r.top - pinch.world.y * view.k;
    applyTransform();
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  function onWheel(e) {
    e.preventDefault();
    var r = viewportEl.getBoundingClientRect();
    var w = screenToWorld(e.clientX, e.clientY);
    var factor = Math.exp(-e.deltaY * 0.0015);
    view.k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, view.k * factor));
    view.x = e.clientX - r.left - w.x * view.k;
    view.y = e.clientY - r.top - w.y * view.k;
    applyTransform();
  }

  /* ---------- 키보드 ---------- */

  function onKeyDown(e) {
    if (!isActive()) return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.code === 'Space') { spaceDown = true; viewportEl.classList.add('can-pan'); return; }

    var k = e.key.toLowerCase();
    if (k === 'delete' || k === 'backspace') {
      var ids = Object.keys(sel);
      if (selComment !== null && !isEph()) {
        store.deleteComment(cid, selComment); selComment = null; renderComments(); return;
      }
      if (!ids.length) return;
      e.preventDefault();
      ids.forEach(doUnplace);   // 배치만 (SPEC 4.2)
      sel = {};
      render();
      U.toast('배치 ' + ids.length + '개 제거 (노드는 남아 있습니다)', 'ok');
    } else if (k === 'f') { e.preventDefault(); focusSelection(); }
    else if (k === 'home') { e.preventDefault(); fitAll(); }
    else if (k === 'c') { e.preventDefault(); addCommentBox(); }
    else if (k === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setSelection(Object.keys(curPlacements()).filter(function (i) { return store.state.nodes[i]; }));
    }
  }

  function onKeyUp(e) {
    if (e.code === 'Space') { spaceDown = false; viewportEl.classList.remove('can-pan'); }
  }

  function isActive() { return pane && !pane.hidden; }

  /* ---------- 조립 ---------- */

  function mount(paneEl) {
    pane = paneEl;
    U.clear(pane);

    tabsEl = el('div.cv-tabs');
    toolbarEl = el('div.cv-toolbar');

    edgeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    edgeSvg.setAttribute('class', 'cv-edges');
    edgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    tempPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tempPath.setAttribute('class', 'cv-edge cv-edge--temp');
    // SVG 요소에는 HTML 의 hidden 속성이 안 먹는다. display 로 감춰야 한다.
    tempPath.style.display = 'none';
    edgeSvg.appendChild(edgeGroup);
    edgeSvg.appendChild(tempPath);

    commentLayer = el('div.cv-layer.cv-layer--comments');
    nodeLayer = el('div.cv-layer.cv-layer--nodes');
    worldEl = el('div.cv-world', {}, [commentLayer, edgeSvg, nodeLayer]);
    marqueeEl = el('div.cv-marquee', { hidden: true });

    viewportEl = el('div.cv-viewport', {
      oncontextmenu: function (e) {
        e.preventDefault();
        var n = e.target.closest('.cv-node');
        if (n) nodeMenu(n.dataset.id, e.clientX, e.clientY);
        else emptyMenu(e.clientX, e.clientY);
      }
    }, [worldEl, marqueeEl]);

    viewportEl.addEventListener('pointerdown', onPointerDown);
    viewportEl.addEventListener('pointermove', onPointerMove);
    viewportEl.addEventListener('pointerup', onPointerUp);
    viewportEl.addEventListener('pointercancel', onPointerUp);
    viewportEl.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);

    pane.appendChild(tabsEl);
    pane.appendChild(toolbarEl);
    pane.appendChild(viewportEl);
  }

  function render() {
    if (!pane) return;
    ensureCanvas();
    spreadCounter = {};
    renderTabs();
    renderToolbar();
    renderComments();
    renderNodes();
    renderEdges();
    applyTransform();
    syncSelectionClasses();
  }

  /** 다른 뷰에서 넘어올 때: 없으면 현재 캔버스에 놓고 포커스한다. */
  function reveal(nodeId) {
    ephemeral = null;
    ensureCanvas();
    if (!isPlacedHere(nodeId)) {
      var where = store.canvasesWith(nodeId);
      if (where.length) cid = where[0];
      else {
        var r = viewportEl.getBoundingClientRect();
        var w = screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
        doPlace(nodeId, snap(w.x - M.W / 2), snap(w.y));
      }
    }
    render();
    setSelection([nodeId]);
    focusSelection();
  }

  /** 외부 변경(패널 편집·번들 가져오기)으로 다시 그린다. 조작 중이면 건드리지 않는다. */
  function refresh() {
    if (!isActive() || drag || pinch || popoverEl) return;
    render();
  }

  WM.canvas = {
    mount: mount, render: render, refresh: refresh, reveal: reveal, fitAll: fitAll,
    focusOn: focusOn, exitFocus: exitEphemeral,
    isFocus: function () { return isEph(); },
    current: function () { return cid; },
    placements: curPlacements,
    metrics: M, pinPos: pinPos, pathD: pathD, nodeHeight: nodeHeight
  };
})(window.WM);
