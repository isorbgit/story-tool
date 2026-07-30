/* ui-picker.js — 노드 생성 다이얼로그와 노드 검색 선택기.
   엣지 생성은 Phase 1에서 이 선택기 하나로만 이뤄진다(SPEC 11장). */
(function (WM) {
  'use strict';
  var U = WM.util, el = U.el, store = WM.store;

  /* ---------- 새 노드 ---------- */

  function newNodeDialog(fixedType, prefillName) {
    var types = store.typeKeys();
    var type = fixedType || types[0];
    var nameInput, slugInput, prefixSpan, err;
    var slugTouched = false;

    function refreshPrefix() {
      prefixSpan.textContent = (store.typeDef(type) || {}).idPrefix || '';
    }
    function autoSlug() {
      if (slugTouched) return;
      slugInput.value = U.slugify(nameInput.value);
    }
    function preview() {
      var s = U.slugify(slugInput.value);
      var full = ((store.typeDef(type) || {}).idPrefix || '') + s;
      if (!s) { err.textContent = ''; return; }
      err.textContent = store.state.nodes[full]
        ? full + ' 은(는) 이미 있습니다 → 뒤에 _2 가 붙습니다'
        : '';
    }

    nameInput = el('input.input', {
      type: 'text', placeholder: '예: 레나', value: prefillName || '',
      oninput: function () { autoSlug(); preview(); }
    });
    slugInput = el('input.input.input--slug', {
      type: 'text', placeholder: 'lena', spellcheck: 'false',
      oninput: function () { slugTouched = true; preview(); }
    });
    prefixSpan = el('span.slug-prefix');
    err = el('div.field__err');

    var typeSelect = el('select.input', {
      onchange: function (e) { type = e.target.value; refreshPrefix(); preview(); }
    }, types.map(function (t) {
      return el('option', { value: t, text: store.typeLabel(t), selected: t === type });
    }));

    refreshPrefix();
    if (prefillName) autoSlug();

    var body = el('div.form', {}, [
      fixedType ? null : el('label.field', {}, [el('span.field__label', { text: '타입' }), typeSelect]),
      el('label.field', {}, [el('span.field__label', { text: '표시명' }), nameInput]),
      el('label.field', {}, [
        el('span.field__label', { text: 'ID' }),
        el('div.slug-row', {}, [prefixSpan, slugInput])
      ]),
      el('p.dim', { text: 'ID는 생성 후 바꿀 수 없습니다. 표시명은 언제든 수정할 수 있습니다. (SPEC 2.2)' }),
      err
    ]);

    return U.modal({
      title: '새 노드',
      body: body,
      actions: [{ label: '취소', value: null }, { label: '만들기', value: true, kind: 'primary' }]
    }).then(function (ok) {
      if (!ok) return null;
      var slug = U.slugify(slugInput.value);
      if (!slug) {
        U.toast('ID로 쓸 영문 slug를 입력해 주세요. 한글은 ID로 쓸 수 없습니다.', 'bad', 4500);
        return newNodeDialog(fixedType, nameInput.value);
      }
      var res = store.createNode(type, slug, nameInput.value.trim() || slug);
      if (res.deduped) U.toast('같은 ID가 있어 ' + res.id + ' 로 만들었습니다.', 'warn', 4000);
      return res.id;
    });
  }

  /* ---------- 노드 고르기 ---------- */

  function pickNode(opts) {
    opts = opts || {};
    var accepts = opts.accepts || null;
    var exclude = opts.exclude || [];
    var listEl = el('div.picker__list');
    var input = el('input.input', {
      type: 'text', placeholder: '이름 · ID · 이명으로 검색', spellcheck: 'false'
    });
    var resolveOuter = null;
    var promise = new Promise(function (r) { resolveOuter = r; });
    var closeModal = null;

    function choose(id) {
      resolveOuter(id);          // 모달의 취소 resolve 보다 먼저 확정시킨다
      if (closeModal) closeModal();
    }

    function render() {
      U.clear(listEl);
      var q = input.value.trim();
      var res = store.search(q, accepts, 60).filter(function (r) {
        return exclude.indexOf(r.id) < 0;
      });

      if (!res.length) {
        listEl.appendChild(el('p.dim', { text: q ? '일치하는 노드가 없습니다.' : '아직 노드가 없습니다.' }));
      }

      res.forEach(function (r) {
        listEl.appendChild(el('button.picker__item', {
          type: 'button', onclick: function () { choose(r.id); }
        }, [
          el('span.dot', { style: { background: store.typeColor(r.node.type) } }),
          el('span.picker__name', { text: r.node.name }),
          el('code.picker__id', { text: r.id }),
          r.node.fields && r.node.fields.alias
            ? el('span.picker__sub', { text: r.node.fields.alias }) : null
        ]));
      });

      // 타입이 하나로 좁혀졌을 때만 즉석 생성을 띄운다. 여러 타입이면 무엇을 만들지 모호하다.
      if (accepts && accepts.length === 1) {
        listEl.appendChild(el('button.picker__item.picker__item--new', {
          type: 'button',
          onclick: function () {
            newNodeDialog(accepts[0], q).then(function (id) { if (id) choose(id); });
          }
        }, ['+ 새 ' + store.typeLabel(accepts[0]) + ' 만들기' + (q ? ' — “' + q + '”' : '')]));
      }
    }

    input.addEventListener('input', render);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var first = listEl.querySelector('.picker__item:not(.picker__item--new)');
        if (first) { e.preventDefault(); first.click(); }
      }
    });
    render();

    var typeHint = accepts
      ? accepts.map(store.typeLabel).join(' · ') + ' 만'
      : '전체 타입';

    U.modal({
      title: opts.title || '노드 선택',
      body: el('div.picker', {}, [
        input,
        el('p.dim', { text: typeHint }),
        listEl
      ]),
      actions: [{ label: '취소', value: null }],
      onOpen: function (close) { closeModal = close; }
    }).then(function () { resolveOuter(null); });

    setTimeout(function () { input.focus(); }, 40);
    return promise;
  }

  WM.picker = { newNodeDialog: newNodeDialog, pickNode: pickNode };
})(window.WM);
