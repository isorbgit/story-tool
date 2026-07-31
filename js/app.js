/* app.js — 부팅, 저장소 연결, 상단 바. */
(function (WM) {
  'use strict';
  var U = WM.util, el = U.el, store = WM.store;

  var adapter = null;
  var env = WM.storage.describeEnvironment();
  var currentView = 'table';   // 'table' | 'graph' | 'timeline'
  var safeMode = false;        // reveal:spoiler 숨김 — 방송/스크린샷용 (SPEC 7장)

  /* ---------- 뷰 전환 ---------- */

  var VIEWS = [
    { key: 'table', label: '표', pane: '#table-pane' },
    { key: 'graph', label: '그래프', pane: '#canvas-pane' },
    { key: 'timeline', label: '타임라인', pane: '#timeline-pane' }
  ];

  function setView(v) {
    currentView = v;
    VIEWS.forEach(function (def) { U.$(def.pane).hidden = def.key !== v; });
    // 타입바 노출과 #main 열 정의가 이 클래스에 걸려 있다 (style.css).
    document.body.classList.toggle('view-graph', v === 'graph');
    document.body.classList.toggle('view-timeline', v === 'timeline');
    U.$$('#view-switch .seg').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.view === v);
    });
    if (v === 'graph') WM.canvas.render();
    else if (v === 'timeline') WM.timeline.render();
    else WM.table.refresh();
  }

  function showTable(nodeId) {
    setView('table');
    if (nodeId) WM.table.gotoNode(nodeId);
  }

  function showGraph(nodeId) {
    setView('graph');
    if (nodeId) WM.canvas.reveal(nodeId);
  }

  function showFocus(nodeId) {
    setView('graph');
    WM.canvas.focusOn(nodeId);
  }

  function viewSwitch() {
    return el('div#view-switch.segbar', {}, VIEWS.map(function (def) {
      return el('button.seg' + (def.key === currentView ? '.is-on' : ''), {
        type: 'button', text: def.label, dataset: { view: def.key },
        onclick: function () { setView(def.key); }
      });
    }));
  }

  /* ---------- 안전 모드 ----------
     미공개(spoiler) 노드를 모든 뷰에서 감춘다. 방송이나 스크린샷 찍을 때 켠다. */

  function isHidden(nodeId) {
    if (!safeMode) return false;
    var n = store.state.nodes[nodeId];
    return !!n && n.reveal === 'spoiler';
  }

  function setSafeMode(v) {
    safeMode = v;
    document.body.classList.toggle('safe-mode', safeMode);
    var b = U.$('#safe-toggle');
    if (b) {
      b.classList.toggle('is-on', safeMode);
      b.textContent = safeMode ? '🔒 안전 모드' : '안전 모드';
    }
    if (WM.panel.selected() && isHidden(WM.panel.selected())) WM.panel.select(null);
    WM.table.refresh();
    WM.canvas.refresh();
    if (currentView === 'timeline') WM.timeline.render();
    U.toast(safeMode ? '미공개 항목을 숨깁니다.' : '안전 모드를 껐습니다.', 'ok');
  }

  /* ---------- 상단 바 ---------- */

  function renderTopbar() {
    var bar = U.$('#topbar');
    U.clear(bar);

    bar.appendChild(el('div.brand', {}, [
      el('strong', { text: '가면을 벗다' }),
      el('span.dim', { text: ' 세계관 맵' })
    ]));

    if (!document.body.classList.contains('is-welcome')) bar.appendChild(viewSwitch());

    bar.appendChild(el('div.topbar__mid', {}, [
      el('span#save-state.save-state'),
      el('span#issue-chip.chip', {
        title: '검증 결과',
        onclick: function () { WM.issues.setOpen(true); }
      }, ['검증']),
      el('span#store-chip.chip', {
        title: '저장 위치',
        onclick: function () { showStorageInfo(); }
      })
    ]));

    bar.appendChild(el('div.topbar__right', {}, [
      el('button#safe-toggle.btn.btn--ghost' + (safeMode ? '.is-on' : ''), {
        type: 'button', text: safeMode ? '🔒 안전 모드' : '안전 모드',
        title: '미공개(spoiler) 항목을 모든 뷰에서 숨깁니다',
        onclick: function () { setSafeMode(!safeMode); }
      }),
      el('button.btn.btn--ghost', {
        type: 'button', text: '내보내기', title: '번들 또는 마크다운 문서',
        onclick: function (e) {
          U.menu({ anchor: e.currentTarget }, [
            { label: '번들 (.wmap.json) — PC ↔ iOS 이동용', onSelect: function () { WM.bundle.exportBundle(); } },
            { label: '마크다운 문서 일괄', onSelect: function () { WM.exportMd.dialog(); } }
          ]);
        }
      }),
      el('button.btn.btn--ghost', {
        type: 'button', text: '가져오기', title: '번들 파일을 병합합니다',
        onclick: function () { WM.bundle.importBundle(); }
      }),
      el('button.btn.btn--ghost.only-wide', {
        type: 'button', text: '스키마', title: '타입·소켓·필드 정의를 고칩니다',
        onclick: function () { WM.schemaUI.open(); }
      }),
      el('button.btn.btn--ghost.only-wide', {
        type: 'button', text: '저장', title: 'Ctrl+S',
        onclick: function () { store.flush().then(function () { U.toast('저장했습니다.', 'ok'); }); }
      }),
      el('button.icon-btn.only-narrow', {
        type: 'button', text: '☰', title: '상세 패널',
        onclick: function () { document.body.classList.toggle('panel-open'); }
      })
    ]));

    updateSaveState();
    updateStoreChip();
  }

  function updateSaveState() {
    var s = U.$('#save-state');
    if (!s) return;
    var S = store.state;
    s.className = 'save-state';
    if (!adapter || !adapter.isConnected()) { s.textContent = '연결 안 됨'; s.classList.add('is-warn'); return; }
    if (S.saveError) { s.textContent = '저장 실패'; s.classList.add('is-bad'); s.title = S.saveError; return; }
    if (S.saving) { s.textContent = '저장 중…'; return; }
    if (store.isDirty()) { s.textContent = '변경됨'; s.classList.add('is-dirty'); return; }
    s.textContent = S.lastSavedAt
      ? '저장됨 ' + S.lastSavedAt.toTimeString().slice(0, 5)
      : '저장됨';
    s.classList.add('is-ok');
  }

  function updateStoreChip() {
    var c = U.$('#store-chip');
    if (!c) return;
    c.textContent = adapter ? adapter.label : '—';
    c.classList.toggle('chip--warn', !!adapter && adapter.id === 'memory');
  }

  function showStorageInfo() {
    var lines = [];
    if (!adapter) lines.push('저장소가 연결되지 않았습니다.');
    else if (adapter.id === 'fsa') {
      lines.push('선택한 로컬 폴더의 data/ 에 4개 JSON으로 저장합니다.');
      lines.push('탐색기에서 그대로 보이고 git으로 관리할 수 있습니다.');
      if (adapter.handleNotPersisted) lines.push('※ 이 브라우저에서 폴더 기억이 안 돼 매번 다시 골라야 합니다.');
    } else if (adapter.id === 'opfs') {
      lines.push('브라우저 내부 저장소(OPFS)에 저장합니다. 파일 앱에서는 보이지 않습니다.');
      lines.push('PC로 옮기려면 [내보내기] 로 번들 파일을 만들어야 합니다.');
      lines.push('사이트 데이터를 지우면 함께 사라집니다. 정기적으로 내보내 두세요.');
    } else {
      lines.push('메모리에만 있습니다. 새로고침하면 사라집니다.');
    }
    U.modal({
      title: '저장 위치',
      body: lines.map(function (t) { return el('p', { text: t }); }).concat([
        adapter && adapter.id === 'fsa' ? el('button.btn.btn--ghost', {
          type: 'button', text: '다른 폴더 선택',
          onclick: function () { reconnect(); }
        }) : null
      ]),
      actions: [{ label: '닫기', value: null }]
    });
  }

  /* ---------- 연결 ---------- */

  /** 이미 한 번이라도 저장된 적이 있는가. 첫 실행이면 4개 파일이 아직 없다. */
  function hasSavedData(data) {
    return !!(data && (data.nodes || data.edges || data.canvases));
  }

  /** data 를 넘기면 그걸 쓰고, 없으면 직접 읽는다. 부팅 때 readAll 을 두 번 부르지 않으려고. */
  function bootData(data) {
    return (data ? Promise.resolve(data) : adapter.readAll()).then(function (data) {
      var seeded = false;
      if (!data.schema) { data.schema = WM.DEFAULT_SCHEMA; seeded = true; }
      store.load(adapter, data);
      if (seeded) {
        // 폴더에 schema.json 이 없으면 내장 기본 스키마를 써넣어 사용자가 고칠 수 있게 한다.
        store.state.dirty['schema.json'] = true;
      }
      ['nodes', 'edges', 'canvases'].forEach(function (k) {
        if (!data[k]) store.state.dirty[k + '.json'] = true;
      });
      if (Object.keys(store.state.dirty).length) store.save();
      return true;
    });
  }

  function startApp() {
    document.body.classList.remove('is-welcome');
    WM.table.mount(U.$('#typebar'), U.$('#table-pane'));
    WM.panel.mount(U.$('#detail-pane'));
    WM.canvas.mount(U.$('#canvas-pane'));
    WM.timeline.mount(U.$('#timeline-pane'));
    WM.issues.mount(U.$('#issues-panel'));
    WM.table.render();
    WM.panel.render();
    renderTopbar();
    setView('table');
  }

  function connectFsa() {
    return adapter.connect()
      .then(function () { return bootData(); })
      .then(startApp)
      .catch(function (e) {
        if (e && e.name === 'AbortError') return;      // 사용자가 폴더 선택을 취소함
        console.error(e);
        U.toast('연결 실패: ' + (e.message || e), 'bad', 6000);
      });
  }

  function reconnect() {
    if (adapter.id !== 'fsa') return;
    store.flush().then(function () { return connectFsa(); });
  }

  function useMemory() {
    adapter = new WM.storage.MemoryAdapter();
    return bootData().then(startApp);
  }

  /* ---------- 원격 저장소 ----------
     FSA/OPFS 와 달리 기기를 가리지 않는 유일한 저장소다. 설정돼 있으면 이게 우선이고,
     연결에 실패하면 조용히 로컬로 내려간다 — 비행기 안에서 앱이 안 열리면 안 된다. */

  var remoteError = null;

  function connectRemote() {
    return WM.storage.SupabaseAdapter.setup().then(function (a) {
      if (!a) return;
      return store.flush().then(function () { return a.readAll(); }).then(function (remote) {
        var localCount = Object.keys(store.state.nodes || {}).length;

        /* 빈 원격에 그냥 붙으면 화면이 비고, 곧이어 그 빈 상태가 원격에 저장된다.
           로컬 데이터가 있는데 원격이 비었으면 반드시 물어본다. */
        if (localCount && !hasSavedData(remote)) {
          return U.confirmModal('원격 저장소가 비어 있습니다', [
            el('p', {}, ['지금 열려 있는 ', el('b', { text: localCount + '개' }), ' 노드를 원격으로 올릴까요?']),
            el('p.dim', { text: '올리지 않으면 빈 상태로 시작합니다. 지금 데이터는 로컬에 그대로 남습니다.' })
          ], '올리고 연결', 'primary').then(function (up) {
            if (!up) return;
            adapter = a;
            store.state.adapter = a;
            return store.save(true).then(startApp);        // force — 4개 파일 전부
          });
        }

        adapter = a;
        return bootData(remote).then(startApp);
      });
    }).catch(function (e) {
      console.error(e);
      U.toast('원격 저장소 연결 실패: ' + (e.message || e), 'bad', 6000);
    });
  }

  function remoteButton() {
    return el('div.welcome__hint', {}, [
      el('h3', { text: '여러 기기에서 쓰려면' }),
      el('p', { text: '원격 저장소에 연결하면 PC 와 아이패드가 같은 데이터를 봅니다. 번들을 주고받을 필요가 없어집니다.' }),
      remoteError ? el('p.warn', { text: '지난번 연결이 실패했습니다: ' + remoteError }) : null,
      el('button.btn', { type: 'button', text: '원격 저장소 연결', onclick: connectRemote })
    ]);
  }

  /* ---------- 시작 화면 ---------- */

  /** 무엇이 되고 무엇이 안 되는지 화면에 그대로 보여준다. 저장이 안 되는 이유를 추측하게 두지 않는다. */
  function diagnostics() {
    var rows = [
      ['브라우저', env.browser],
      ['주소 방식', env.protocol + (env.isFile ? '  (파일 직접 열기)' : '')],
      ['보안 컨텍스트', env.isSecureContext ? '예' : '아니오'],
      ['폴더 저장 (File System Access)', env.hasFsa ? '가능' : '없음 — Chrome/Edge 전용'],
      ['브라우저 내부 저장소 (OPFS)', adapter.id === 'opfs' ? '가능 (실제 쓰기 확인)'
        : (env.hasOpfs ? '있지만 쓰기 실패' : '없음')],
      ['IndexedDB', env.hasIdb ? '가능' : '없음']
    ];
    return el('details.diag', {}, [
      el('summary', { text: '이 환경에서 무엇이 되는지 보기' }),
      el('table.diag__table', {}, rows.map(function (r) {
        return el('tr', {}, [el('th', { text: r[0] }), el('td', { text: r[1] })]);
      })),
      adapter.reason ? el('p.dim.small', { text: '사유: ' + adapter.reason }) : null
    ]);
  }

  function serveHint() {
    return el('div.welcome__hint', {}, [
      el('h3', { text: '폴더에 저장하고 싶다면' }),
      el('p', {}, [
        '이 파일을 ', el('b', { text: 'Chrome 또는 Edge' }), ' 로 여세요. ',
        'Firefox·Safari 에는 폴더 접근 API 자체가 없습니다.'
      ]),
      el('p.dim', { text: '기본 브라우저가 Firefox 라면, index.html 을 우클릭 → 연결 프로그램 → Chrome.' }),
      el('h3', { text: '또는 로컬 서버로' }),
      el('p', {}, ['프로젝트 폴더의 ', el('code', { text: 'serve.cmd' }), ' 를 더블클릭하면 ',
        el('code', { text: 'http://localhost:8777' }), ' 로 열립니다. 아이패드에서 쓰려면 어차피 필요합니다.']),
    ]);
  }

  function renderWelcome() {
    document.body.classList.add('is-welcome');
    var pane = U.$('#table-pane');
    U.clear(pane);

    var kids = [el('h1', { text: '가면을 벗다 — 세계관 맵' })];

    if (adapter.id === 'fsa') {
      kids.push(el('p', { text: '데이터를 둘 폴더를 고르세요. 그 안에 data/ 와 backup/ 이 만들어집니다.' }));
      kids.push(el('button.btn.btn--primary.btn--big', {
        type: 'button', text: '폴더 선택', onclick: connectFsa
      }));
      kids.push(el('p.dim', { text: '한 번 고르면 다음부터는 자동으로 다시 연결됩니다.' }));

    } else if (adapter.id === 'opfs') {
      kids.push(el('p', {}, [
        '이 브라우저(', env.browser, ')에는 폴더 접근 API가 없어 ',
        el('b', { text: '브라우저 내부 저장소' }), ' 를 씁니다. ',
        '저장은 정상으로 되고 껐다 켜도 남습니다.'
      ]));
      kids.push(el('button.btn.btn--primary.btn--big', {
        type: 'button', text: '시작하기',
        onclick: function () {
          adapter.connect().then(function () { return bootData(); }).then(startApp).catch(function (e) {
            console.error(e);
            U.toast('내부 저장소를 열 수 없습니다: ' + (e.message || e), 'bad', 6000);
          });
        }
      }));
      kids.push(el('p.warn', {
        text: '다만 탐색기에서는 안 보이고 git 으로도 못 봅니다. 사이트 데이터를 지우면 함께 사라집니다. ' +
              '정기적으로 [내보내기] 해 두세요.'
      }));
      kids.push(serveHint());

    } else {
      kids.push(el('p.warn', { text: '이 환경에서는 저장할 방법을 찾지 못했습니다.' }));
      kids.push(serveHint());
      kids.push(el('button.btn.btn--big', {
        type: 'button', text: '저장 없이 둘러보기', onclick: useMemory
      }));
      kids.push(el('p.dim', { text: '둘러보기 모드에서도 [가져오기]로 번들을 열고 [내보내기]로 파일을 받을 수는 있습니다. 새로고침하면 사라집니다.' }));
    }

    kids.push(remoteButton());
    kids.push(el('div.welcome__import', {}, [diagnostics()]));

    pane.appendChild(el('div.welcome', {}, kids));
    renderTopbar();
  }

  /* ---------- 전역 배선 ---------- */

  function wire() {
    store.on('nodes', function () {
      WM.table.refresh();
      WM.panel.refreshIfIdle();
      WM.canvas.refresh();
      if (currentView === 'timeline') WM.timeline.render();
      WM.issues.backgroundRun();
    });
    store.on('edges', function () {
      WM.table.refresh();
      WM.canvas.refresh();
      WM.issues.backgroundRun();
    });
    store.on('canvases', function () { updateSaveState(); WM.issues.backgroundRun(); });
    /* 스키마가 바뀌면 타입 탭·필드 폼·노드 렌더링이 전부 낡는다. 부분 갱신으로는 못 따라간다. */
    store.on('schema', function () {
      WM.table.render();
      WM.panel.render();
      WM.canvas.refresh();
      if (currentView === 'timeline') WM.timeline.render();
      WM.issues.backgroundRun();
    });
    store.on('dirty', updateSaveState);
    store.on('loaded', function () {
      updateStoreChip();
      if (currentView === 'graph') WM.canvas.render();
    });

    document.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        store.flush().then(function () { U.toast('저장했습니다.', 'ok'); });
      }
      if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        if (!store.state.schema) return;
        WM.picker.pickNode({ title: '노드 찾기' }).then(function (id) {
          if (!id) return;
          if (currentView === 'graph') WM.canvas.reveal(id);
          else WM.table.gotoNode(id);
        });
      }
    });

    window.addEventListener('beforeunload', function (e) {
      if (!store.isDirty()) return;
      store.save();
      e.preventDefault();
      e.returnValue = '';
    });

    // 탭을 숨기거나 앱을 배경으로 보낼 때 확실히 눌러 담는다. iOS에서 특히 중요하다.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && store.isDirty()) store.flush();
    });
  }

  /* ---------- 부팅 ---------- */

  function readFailed(e) {
    console.error(e);
    U.toast('데이터를 읽지 못했습니다: ' + (e.message || e), 'bad', 8000);
    renderWelcome();
  }

  function boot() {
    wire();
    /* 원격 저장소가 설정돼 있으면 먼저 시도한다. 기기 간 공통 저장소는 이것뿐이라
       로컬보다 우선이다. 실패하면 이유만 들고 로컬 경로로 내려간다. */
    WM.storage.SupabaseAdapter.loadConfig().then(function (cfg) {
      if (!cfg) return null;
      var a = new WM.storage.SupabaseAdapter();
      return a.connect().then(function () { return a; }).catch(function (e) {
        remoteError = e.message || String(e);
        console.warn('[wm] 원격 저장소를 쓸 수 없어 로컬로 내려갑니다 —', remoteError);
        return null;
      });
    }).then(function (remote) {
      if (remote) {
        adapter = remote;
        return bootData().then(startApp).catch(readFailed);
      }
      return localBoot();
    });
  }

  function localBoot() {
    // 어댑터 선택은 OPFS 실사용 확인을 포함하므로 비동기다.
    return WM.storage.pickAdapter().then(function (a) {
      adapter = a;

      if (adapter.id === 'fsa') {
        // 폴더 권한이 남아 있을 때만 조용히 재연결된다. 없으면 사용자가 다시 골라야 한다.
        return adapter.restore(false).then(function (ok) {
          if (!ok) { renderWelcome(); return; }
          return bootData().then(startApp).catch(readFailed);
        });
      }

      if (adapter.id === 'opfs') {
        /* OPFS 는 권한 프롬프트가 없어 조용히 열 수 있다. 저장된 데이터가 이미 있으면
           안내 화면을 건너뛰고 바로 들어간다 — 첫 실행에서 이미 한 번 읽은 안내다.
           데이터가 없을 때(첫 실행)만 저장 위치 설명을 띄운다. */
        return adapter.connect().then(function () {
          return adapter.readAll();
        }).then(function (data) {
          if (!hasSavedData(data)) { renderWelcome(); return; }
          return bootData(data).then(startApp);
        }).catch(readFailed);
      }

      renderWelcome();   // memory — 저장이 안 된다는 사실을 반드시 먼저 알려야 한다
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  WM.app = {
    reconnect: reconnect, env: env,
    setView: setView, showTable: showTable, showGraph: showGraph, showFocus: showFocus,
    view: function () { return currentView; },
    safeMode: function () { return safeMode; },
    setSafeMode: setSafeMode,
    hidden: isHidden
  };
})(window.WM);
