/* ui-schema.js — 스키마 편집 화면 (SPEC 5.3).

   왜 필요한가: 스키마는 data/schema.json 이라 폴더 저장(Chrome)에서는 탐색기로 고치면
   된다. 그런데 OPFS(Firefox·iOS)에서는 그 파일이 아예 안 보인다. 앱 밖에 편집 수단이
   없으므로, 편집기가 없으면 그 환경에서는 타입을 하나도 늘릴 수 없다. */
(function (WM) {
  'use strict';
  var U = WM.util, el = U.el, store = WM.store, SE = WM.schemaEdit;

  var PALETTE = ['#E8A33D', '#4FA8E8', '#C75B5B', '#7FBF6A', '#A87FD0', '#8A8A8A',
                 '#D06FA8', '#5BC0BE', '#B58A5A', '#9AA75B'];

  function nodeCount(type) {
    var n = 0;
    Object.keys(store.state.nodes).forEach(function (id) {
      if (store.state.nodes[id].type === type) n++;
    });
    return n;
  }

  /* ---------- 적용 ----------
     검증 → 영향 요약 → 확인 → 백업 → 교체. 백업을 먼저 남기는 건 가져오기와 같은 이유다. */

  function applySchema(next, what) {
    var issues = SE.validate(next);
    var errors = issues.filter(function (i) { return i.level === 'error'; });
    var warns = issues.filter(function (i) { return i.level === 'warn'; });

    if (errors.length) {
      return U.modal({
        title: '적용할 수 없습니다',
        body: [
          el('p', { text: what + ' 을(를) 적용하면 스키마가 깨집니다. 먼저 고쳐 주세요.' }),
          issueList(errors)
        ],
        actions: [{ label: '닫기', value: null }]
      }).then(function () { return false; });
    }

    var imp = SE.impact(next);
    var body = [];
    if (warns.length) {
      body.push(el('p.warn', { text: '경고 ' + warns.length + '건 — 적용은 되지만 확인해 보세요.' }));
      body.push(issueList(warns));
    }
    if (SE.impactTotal(imp)) {
      body.push(el('h3', { text: '지금 데이터에 생기는 일' }));
      body.push(impactList(imp));
    }
    if (!body.length) body.push(el('p', { text: '기존 데이터에 영향이 없습니다.' }));
    body.push(el('p.dim.small', { text: '적용 직전에 백업 스냅샷을 남깁니다. 노드에 들어 있던 값은 지우지 않습니다.' }));

    return U.confirmModal(what, body, '적용', 'primary').then(function (ok) {
      if (!ok) return false;
      return store.maybeBackup(true).then(function () {
        store.setSchema(next);
        U.toast('스키마를 적용했습니다.', 'ok');
        return true;
      });
    });
  }

  function issueList(list) {
    return el('div.sc-issues', {}, list.map(function (i) {
      return el('div.sc-issue.sc-issue--' + i.level, {}, [
        el('span.sc-issue__tag', { text: i.level === 'error' ? '오류' : '경고' }),
        el('span', { text: i.msg })
      ]);
    }));
  }

  function impactList(imp) {
    var rows = [];
    imp.typeRemoved.forEach(function (x) {
      rows.push(['타입 삭제', x.label + ' 노드 ' + x.count + '개가 표시할 타입을 잃습니다. 데이터는 남지만 화면에서 사라집니다.', 'bad']);
    });
    imp.socketRemoved.forEach(function (x) {
      rows.push(['소켓 삭제', x.label + '.' + x.socket + ' 에 물린 연결 ' + x.count + '건이 화면에서 사라집니다.', 'bad']);
    });
    imp.fieldRemoved.forEach(function (x) {
      rows.push(['필드 삭제', x.label + '.' + x.field + ' 에 값이 든 노드 ' + x.count + '개. 값은 파일에 남고 화면에만 안 보입니다.', 'warn']);
    });
    imp.nowRequired.forEach(function (x) {
      rows.push(['필수 추가', x.label + '.' + x.field + ' 미입력 노드 ' + x.count + '개가 검증 경고로 뜹니다.', 'warn']);
    });
    imp.prefixChanged.forEach(function (x) {
      rows.push(['ID 접두사', x.label + ' 이(가) ' + x.from + ' → ' + x.to + '. 기존 노드 ' + x.count + '개의 ID는 그대로입니다(ID는 변경 불가).', 'warn']);
    });
    return el('div.sc-impact', {}, rows.map(function (r) {
      return el('div.sc-impact__row', {}, [
        el('span.sc-impact__tag.is-' + r[2], { text: r[0] }),
        el('span', { text: r[1] })
      ]);
    }));
  }

  /* ---------- 타입 추가 ---------- */

  function addTypeDialog() {
    var sc = store.state.schema;
    var targets = Object.keys(sc.types);
    var picked = {};
    var labelIn = el('input.input', { type: 'text', placeholder: '예: 종족' });
    var keyIn = el('input.input', { type: 'text', placeholder: 'race', spellcheck: 'false' });
    var prefixIn = el('input.input', { type: 'text', placeholder: 'rac_', spellcheck: 'false' });
    var color = PALETTE[Object.keys(sc.types).length % PALETTE.length];
    var swatches;

    // 표시명을 치면 키와 접두사를 지어 준다. 직접 고치면 그때부터 따라오지 않는다.
    var keyTouched = false, prefixTouched = false;
    keyIn.addEventListener('input', function () { keyTouched = true; });
    prefixIn.addEventListener('input', function () { prefixTouched = true; });
    labelIn.addEventListener('input', function () {
      var s = U.slugify(labelIn.value);
      if (!keyTouched) keyIn.value = s;
      if (!prefixTouched) prefixIn.value = s ? s.slice(0, 3) + '_' : '';
    });

    swatches = el('div.sc-swatches', {}, PALETTE.map(function (c) {
      var b = el('button.sc-swatch' + (c === color ? '.is-on' : ''), {
        type: 'button', style: { background: c }, title: c,
        onclick: function () {
          color = c;
          Array.prototype.forEach.call(swatches.children, function (x) { x.classList.remove('is-on'); });
          b.classList.add('is-on');
        }
      });
      return b;
    }));

    var links = el('div.sc-links', {}, targets.map(function (t) {
      var d = sc.types[t];
      var cb = el('input', {
        type: 'checkbox',
        onchange: function () { picked[t] = cb.checked; }
      });
      return el('label.sc-link', {}, [
        cb,
        el('span.sc-dot', { style: { background: d.color || '#888' } }),
        el('span', { text: d.label || t })
      ]);
    }));

    return U.modal({
      title: '타입 추가',
      body: [
        el('p.dim', { text: '연결할 상대를 고르면 양쪽 소켓을 같이 만듭니다. 한쪽만 있으면 캔버스에서 선이 안 그려집니다.' }),
        field('표시명', labelIn),
        field('키 (영문, 변경 불가)', keyIn),
        field('ID 접두사', prefixIn),
        field('색', swatches),
        el('h3', { text: '연결할 타입' }),
        links
      ],
      actions: [
        { label: '취소', value: null },
        { label: '추가', value: 'ok', kind: 'primary' }
      ]
    }).then(function (v) {
      if (v !== 'ok') return false;

      var key = U.slugify(keyIn.value);
      var label = labelIn.value.trim();
      var prefix = prefixIn.value.trim();

      if (!key) return fail('키는 영문으로 넣어야 합니다.');
      if (!label) return fail('표시명이 필요합니다.');
      if (sc.types[key]) return fail('"' + key + '" 타입이 이미 있습니다.');
      if (!/^[a-z][a-z0-9]*_$/.test(prefix)) return fail('ID 접두사는 영문 소문자로 시작하고 밑줄로 끝나야 합니다. 예: rac_');

      var chosen = Object.keys(picked).filter(function (t) { return picked[t]; });
      var next = SE.addType(sc, {
        key: key, label: label, idPrefix: prefix, color: color,
        links: chosen.map(function (t) {
          return {
            target: t,
            socketKey: t + 's',
            socketLabel: sc.types[t].label || t,
            backKey: key + 's',
            backLabel: label
          };
        })
      });
      return applySchema(next, '타입 "' + label + '" 추가');
    });
  }

  function fail(msg) {
    U.toast(msg, 'bad', 4000);
    return false;
  }

  function field(label, control) {
    return el('label.sc-field', {}, [el('span.sc-field__label', { text: label }), control]);
  }

  /* ---------- 타입 편집 (이름·색·접두사) ---------- */

  function editTypeDialog(key) {
    var sc = store.state.schema, d = sc.types[key];
    var labelIn = el('input.input', { type: 'text', value: d.label || '' });
    var prefixIn = el('input.input', { type: 'text', value: d.idPrefix || '', spellcheck: 'false' });
    var color = d.color || '#888';
    var swatches = el('div.sc-swatches', {}, PALETTE.concat(color).filter(function (c, i, a) { return a.indexOf(c) === i; }).map(function (c) {
      var b = el('button.sc-swatch' + (c === color ? '.is-on' : ''), {
        type: 'button', style: { background: c }, title: c,
        onclick: function () {
          color = c;
          Array.prototype.forEach.call(swatches.children, function (x) { x.classList.remove('is-on'); });
          b.classList.add('is-on');
        }
      });
      return b;
    }));

    return U.modal({
      title: (d.label || key) + ' 편집',
      body: [
        field('표시명', labelIn),
        field('ID 접두사', prefixIn),
        field('색', swatches),
        el('p.dim.small', { text: '소켓·필드는 [JSON 직접 편집] 에서 고칩니다. 키(' + key + ')는 바꿀 수 없습니다 — 노드가 타입 키로 자기를 가리킵니다.' })
      ],
      actions: [
        { label: '취소', value: null },
        { label: '저장', value: 'ok', kind: 'primary' }
      ]
    }).then(function (v) {
      if (v !== 'ok') return false;
      var next = SE.clone(sc);
      next.types[key].label = labelIn.value.trim() || key;
      next.types[key].idPrefix = prefixIn.value.trim();
      next.types[key].color = color;
      return applySchema(next, (labelIn.value.trim() || key) + ' 편집');
    });
  }

  function removeTypeDialog(key) {
    var sc = store.state.schema, d = sc.types[key];
    var n = nodeCount(key);
    if (Object.keys(sc.types).length <= 1) return Promise.resolve(fail('마지막 타입은 지울 수 없습니다.'));

    var next = SE.removeType(sc, key);
    var body = [
      el('p', {}, [el('b', { text: d.label || key }), ' 타입을 스키마에서 지웁니다.']),
      n ? el('p.warn', { text: '이 타입의 노드 ' + n + '개가 화면에서 사라집니다. nodes.json 에는 남으므로 타입을 되살리면 다시 보입니다.' })
        : el('p.dim', { text: '이 타입의 노드는 없습니다.' }),
      el('p.dim.small', { text: '다른 타입에서 이 타입만 받던 소켓도 함께 정리합니다. 안 그러면 짝이 깨집니다.' })
    ];
    return U.confirmModal('타입 삭제', body, '삭제', 'danger').then(function (ok) {
      if (!ok) return false;
      return applySchema(next, '타입 "' + (d.label || key) + '" 삭제');
    });
  }

  /* ---------- JSON 직접 편집 ---------- */

  function jsonDialog() {
    var ta = el('textarea.input.input--area.sc-json', {
      spellcheck: 'false', rows: 20,
      value: store.stringify(store.state.schema)
    });
    var report = el('div.sc-report');

    function check() {
      U.clear(report);
      var parsed;
      try {
        parsed = JSON.parse(ta.value);
      } catch (e) {
        report.appendChild(el('div.sc-issue.sc-issue--error', {}, [
          el('span.sc-issue__tag', { text: 'JSON' }),
          el('span', { text: e.message })
        ]));
        return null;
      }
      var issues = SE.validate(parsed);
      if (!issues.length) {
        report.appendChild(el('p.ok', { text: '문제 없습니다.' }));
      } else {
        report.appendChild(issueList(issues));
      }
      return parsed;
    }

    ta.addEventListener('input', U.debounce(check, 400));
    setTimeout(check, 0);

    return U.modal({
      title: 'JSON 직접 편집',
      wide: true,
      body: [
        el('p.dim', { text: '소켓·필드·라벨 프리셋까지 전부 여기서 고칩니다. 입력하는 동안 계속 검사합니다.' }),
        ta, report
      ],
      actions: [
        { label: '취소', value: null },
        { label: '적용', value: 'ok', kind: 'primary' }
      ]
    }).then(function (v) {
      if (v !== 'ok') return false;
      var parsed;
      try { parsed = JSON.parse(ta.value); }
      catch (e) { return fail('JSON 구문 오류: ' + e.message); }
      return applySchema(parsed, 'JSON 편집');
    });
  }

  /* ---------- 파일 ---------- */

  function exportSchema() {
    U.download('worldmap-schema-' + U.stamp() + '.json', store.stringify(store.state.schema));
    U.toast('스키마를 내려받았습니다.', 'ok');
  }

  function importSchema() {
    return U.pickTextFile('.json').then(function (f) {
      if (!f) return false;
      var parsed;
      try { parsed = JSON.parse(f.text); }
      catch (e) { return fail(f.name + ' 을(를) 읽을 수 없습니다: ' + e.message); }
      return applySchema(parsed, f.name + ' 불러오기');
    });
  }

  function resetSchema() {
    return applySchema(SE.clone(WM.DEFAULT_SCHEMA), '기본 스키마로 되돌리기');
  }

  /* ---------- 본 화면 ---------- */

  /* 이미 떠 있는데 또 열면 모달이 쌓인다. 적용 실패 후 되열기와 사용자 클릭이
     겹치면 실제로 일어난다. 열려 있던 쪽을 닫고 새로 연다. */
  var openFinish = null;

  function open() {
    if (openFinish) { openFinish(null); openFinish = null; }
    var sc = store.state.schema;
    var issues = SE.validate(sc);
    var bad = issues.filter(function (i) { return i.level === 'error'; }).length;

    var rows = Object.keys(sc.types).map(function (t) {
      var d = sc.types[t];
      return el('div.sc-row', {}, [
        el('span.sc-dot', { style: { background: d.color || '#888' } }),
        el('div.sc-row__main', {}, [
          el('div.sc-row__name', { text: d.label || t }),
          el('div.sc-row__meta', {
            text: t + ' · ' + (d.idPrefix || '?') + ' · 소켓 ' + (d.sockets || []).length +
                  ' · 필드 ' + (d.fields || []).length + ' · 노드 ' + nodeCount(t)
          })
        ]),
        el('button.btn.btn--ghost.btn--tiny', {
          type: 'button', text: '편집',
          onclick: function () { close(); editTypeDialog(t).then(reopenIfUnchanged); }
        }),
        el('button.btn.btn--ghost.btn--tiny', {
          type: 'button', text: '삭제',
          onclick: function () { close(); removeTypeDialog(t).then(reopenIfUnchanged); }
        })
      ]);
    });

    var closeFn = null;
    function close() { if (closeFn) closeFn(null); }
    function reopenIfUnchanged(applied) { if (!applied) open(); }

    var p = U.modal({
      title: '스키마',
      wide: true,
      onOpen: function (finish) { closeFn = finish; openFinish = finish; },
      body: [
        el('p.dim', {}, [
          '타입·소켓·필드 정의입니다. ',
          store.state.adapter && store.state.adapter.isUserVisible
            ? '폴더의 data/schema.json 과 같은 내용입니다.'
            : '이 저장소에서는 파일이 안 보이므로 여기서만 고칠 수 있습니다.'
        ]),
        bad ? el('div.sc-banner', {}, [
          el('b', { text: '지금 스키마에 오류 ' + bad + '건이 있습니다. ' }),
          '[JSON 직접 편집] 에서 내용을 볼 수 있습니다.'
        ]) : null,
        el('div.sc-rows', {}, rows),
        el('div.sc-actions', {}, [
          el('button.btn.btn--primary', {
            type: 'button', text: '타입 추가',
            onclick: function () { close(); addTypeDialog().then(reopenIfUnchanged); }
          }),
          el('button.btn.btn--ghost', {
            type: 'button', text: 'JSON 직접 편집',
            onclick: function () { close(); jsonDialog().then(reopenIfUnchanged); }
          }),
          el('span.spacer'),
          el('button.btn.btn--ghost', { type: 'button', text: '내보내기', onclick: exportSchema }),
          el('button.btn.btn--ghost', {
            type: 'button', text: '불러오기',
            onclick: function () { close(); importSchema().then(reopenIfUnchanged); }
          }),
          el('button.btn.btn--ghost', {
            type: 'button', text: '기본값',
            onclick: function () { close(); resetSchema().then(reopenIfUnchanged); }
          })
        ])
      ],
      actions: [{ label: '닫기', value: null }]
    });

    p.then(function () { if (openFinish === closeFn) openFinish = null; });
    return p;
  }

  WM.schemaUI = { open: open, applySchema: applySchema };
})(window.WM);
