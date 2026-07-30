/* ui-issues.js — 검증 결과 하단 패널 (SPEC 10장).
   수동 실행 + 저장 뒤 백그라운드 체크. */
(function (WM) {
  'use strict';
  var U = WM.util, el = U.el, store = WM.store;

  var root = null, listEl = null;
  var issues = [];
  var open = false;
  var levelFilter = '';
  var ruleFilter = '';
  var ran = false;

  function mount(node) {
    root = node;
    render();
  }

  function run(silent) {
    issues = WM.validate.run();
    ran = true;
    render();
    updateChip();
    if (!silent) {
      var s = WM.validate.summarize(issues);
      U.toast(s.total ? ('검증 완료 — 오류 ' + s.error + ' · 경고 ' + s.warn + ' · 정보 ' + s.info)
                      : '검증 완료 — 문제 없음', s.error ? 'bad' : 'ok', 3500);
      if (s.total) setOpen(true);
    }
  }

  /* 저장 직후에만 돌린다. 타이핑마다 500개 노드를 훑을 이유가 없다. */
  var backgroundRun = U.debounce(function () {
    if (!ran) return;          // 한 번도 안 돌렸으면 자동으로 열지 않는다
    issues = WM.validate.run();
    render();
    updateChip();
  }, 1200);

  function setOpen(v) {
    open = v;
    document.body.classList.toggle('issues-open', open);
    render();
  }

  function updateChip() {
    var chip = U.$('#issue-chip');
    if (!chip) return;
    var s = WM.validate.summarize(issues);
    U.clear(chip);
    if (!ran) {
      chip.appendChild(el('span', { text: '검증' }));
      chip.className = 'chip';
      return;
    }
    chip.className = 'chip' + (s.error ? ' chip--bad' : (s.warn ? ' chip--warn' : ' chip--ok'));
    chip.appendChild(el('span', {
      text: s.total ? (s.error ? '오류 ' + s.error : (s.warn ? '경고 ' + s.warn : '정보 ' + s.info)) : '이상 없음'
    }));
  }

  function jump(iss) {
    if (!iss.nodeId) return;
    if (WM.app.view() === 'graph') WM.canvas.reveal(iss.nodeId);
    else if (WM.app.view() === 'timeline') WM.app.showTable(iss.nodeId);
    else WM.table.gotoNode(iss.nodeId);
  }

  function filtered() {
    return issues.filter(function (i) {
      if (levelFilter && i.level !== levelFilter) return false;
      if (ruleFilter && i.rule !== ruleFilter) return false;
      return true;
    });
  }

  function render() {
    if (!root) return;
    U.clear(root);

    var s = WM.validate.summarize(issues);

    var head = el('div.issues__head', {}, [
      el('button.issues__toggle', {
        type: 'button', onclick: function () { setOpen(!open); }
      }, [el('span.caret', { text: open ? '▾' : '▸' }), ' 검증']),
      el('span.issues__tally', {}, [
        el('button.pill.pill--error' + (levelFilter === 'error' ? '.is-on' : ''), {
          type: 'button', text: '오류 ' + s.error,
          onclick: function () { levelFilter = levelFilter === 'error' ? '' : 'error'; setOpen(true); }
        }),
        el('button.pill.pill--warn' + (levelFilter === 'warn' ? '.is-on' : ''), {
          type: 'button', text: '경고 ' + s.warn,
          onclick: function () { levelFilter = levelFilter === 'warn' ? '' : 'warn'; setOpen(true); }
        }),
        el('button.pill.pill--info' + (levelFilter === 'info' ? '.is-on' : ''), {
          type: 'button', text: '정보 ' + s.info,
          onclick: function () { levelFilter = levelFilter === 'info' ? '' : 'info'; setOpen(true); }
        })
      ]),
      el('span.spacer'),
      ruleFilter ? el('button.btn.btn--tiny.btn--ghost', {
        type: 'button', text: '규칙 필터 해제', onclick: function () { ruleFilter = ''; render(); }
      }) : null,
      el('button.btn.btn--tiny', { type: 'button', text: '지금 검증', onclick: function () { run(false); } })
    ]);
    root.appendChild(head);

    if (!open) return;

    listEl = el('div.issues__list');
    var list = filtered();

    if (!ran) {
      listEl.appendChild(el('p.dim', { text: '[지금 검증] 을 누르면 SPEC 10장의 규칙을 전부 돌립니다.' }));
    } else if (!list.length) {
      listEl.appendChild(el('p.dim', { text: issues.length ? '이 조건에 걸린 항목이 없습니다.' : '문제를 찾지 못했습니다.' }));
    }

    list.slice(0, 400).forEach(function (i) {
      listEl.appendChild(el('div.issue.issue--' + i.level, {}, [
        el('button.issue__rule', {
          type: 'button', text: i.label, title: '이 규칙만 보기',
          onclick: function () { ruleFilter = ruleFilter === i.rule ? '' : i.rule; render(); }
        }),
        el('button.issue__msg', {
          type: 'button', text: i.message,
          onclick: function () { jump(i); }
        })
      ]));
    });

    if (list.length > 400) {
      listEl.appendChild(el('p.dim', { text: '…외 ' + (list.length - 400) + '건' }));
    }
    root.appendChild(listEl);
  }

  WM.issues = {
    mount: mount, run: run, render: render, setOpen: setOpen,
    backgroundRun: backgroundRun, updateChip: updateChip,
    all: function () { return issues; }
  };
})(window.WM);
