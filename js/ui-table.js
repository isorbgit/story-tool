/* ui-table.js — 표 뷰. 데이터 입력의 주 창구(SPEC 9장 우선도 1).
   컬럼 구성은 schema 의 cardFields 를 따른다. */
(function (WM) {
  'use strict';
  var U = WM.util, el = U.el, store = WM.store;

  var tabsRoot = null, paneRoot = null;
  var state = {
    type: null,
    query: '',
    tag: '',
    flags: { status: '', reveal: '', impl: '' },
    hideDropped: true,
    sort: { key: 'name', dir: 1 }
  };

  function mount(tabs, pane) {
    tabsRoot = tabs;
    paneRoot = pane;
    if (!state.type) state.type = store.typeKeys()[0];
  }

  function popupMenu(anchor, items) { return U.menu({ anchor: anchor }, items); }

  /* ---------- 셀 값 ---------- */

  function displayValue(node, f) {
    var v = node.fields[f.key];
    if (v === undefined || v === null || v === '') return '';
    if (f.widget === 'when') return v.display || (v.sort !== undefined ? String(v.sort) : '');
    return String(v).replace(/\s*\n\s*/g, ' ').slice(0, 120);
  }

  function inlineEditable(f) {
    return f.widget === 'text' || f.widget === 'select' || f.widget === 'markdown';
  }

  function startEdit(cell, id, f) {
    if (cell.querySelector('input,select,textarea')) return;
    var node = store.state.nodes[id];
    var input;
    function commit(value) {
      store.setField(id, f.key, value);
      renderRowsOnly();
    }
    if (f.widget === 'select') {
      input = el('select.input.input--cell', {
        onchange: function (e) { commit(e.target.value); },
        onblur: function () { renderRowsOnly(); }
      }, [el('option', { value: '', text: '—' })].concat((f.options || []).map(function (o) {
        return el('option', { value: o, text: o, selected: node.fields[f.key] === o });
      })));
    } else {
      input = el('input.input.input--cell', {
        type: 'text', value: node.fields[f.key] || '',
        onkeydown: function (e) {
          if (e.key === 'Enter') { e.preventDefault(); commit(e.target.value); }
          if (e.key === 'Escape') { renderRowsOnly(); }
        },
        onblur: function (e) { commit(e.target.value); }
      });
    }
    U.clear(cell).appendChild(input);
    input.focus();
    if (input.select) input.select();
  }

  /* ---------- 필터·정렬 ---------- */

  function visibleRows() {
    var rows = store.nodesOfType(state.type);
    var q = state.query.trim();

    rows = rows.filter(function (r) {
      var n = r.node;
      if (WM.app.hidden(r.id)) return false;          // 안전 모드
      if (state.tag && (n.tags || []).indexOf(state.tag) < 0) return false;
      if (state.hideDropped && n.status === 'dropped') return false;
      if (state.flags.status && n.status !== state.flags.status) return false;
      if (state.flags.reveal && n.reveal !== state.flags.reveal) return false;
      if (state.flags.impl && n.impl !== state.flags.impl) return false;
      if (!q) return true;
      if (U.matchScore(n.name, q) || U.matchScore(r.id, q)) return true;
      var hit = false;
      Object.keys(n.fields).forEach(function (k) {
        var v = n.fields[k];
        if (typeof v === 'string' && U.matchScore(v, q)) hit = true;
      });
      if ((n.tags || []).some(function (t) { return U.matchScore(t, q); })) hit = true;
      return hit;
    });

    var def = store.typeDef(state.type);
    var key = state.sort.key, dir = state.sort.dir;
    rows.sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.node.name; bv = b.node.name; }
      else if (key === 'id') { av = a.id; bv = b.id; }
      else if (key === 'edges') { av = store.edgeCount(a.id); bv = store.edgeCount(b.id); }
      else if (key === 'updated') { av = a.node.updated || ''; bv = b.node.updated || ''; }
      else {
        var f = store.fieldDef(state.type, key) || { key: key, widget: 'text' };
        if (f.widget === 'when') {
          av = (a.node.fields[key] || {}).sort; bv = (b.node.fields[key] || {}).sort;
          av = av === undefined ? Infinity : av; bv = bv === undefined ? Infinity : bv;
        } else { av = displayValue(a.node, f); bv = displayValue(b.node, f); }
      }
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), 'ko') * dir;
    });
    return { rows: rows, def: def };
  }

  /* ---------- 렌더 ---------- */

  function renderTabs() {
    if (!tabsRoot) return;
    U.clear(tabsRoot);
    var counts = store.countsByType();
    store.typeKeys().forEach(function (t) {
      tabsRoot.appendChild(el('button.tab' + (state.type === t ? '.is-on' : ''), {
        type: 'button',
        style: { '--type-color': store.typeColor(t) },
        onclick: function () { state.type = t; state.sort = { key: 'name', dir: 1 }; render(); }
      }, [
        el('span.dot', { style: { background: store.typeColor(t) } }),
        el('span.tab__label', { text: store.typeLabel(t) }),
        el('span.tab__count', { text: String(counts[t] || 0) })
      ]));
    });
  }

  function flagFilter(name) {
    var def = store.flagDef(name);
    return el('select.input.input--sm', {
      onchange: function (e) { state.flags[name] = e.target.value; render(); }
    }, [el('option', { value: '', text: def.label + ' 전체', selected: !state.flags[name] })].concat(
      def.values.map(function (v) {
        return el('option', { value: v.key, text: v.label, selected: state.flags[name] === v.key });
      })
    ));
  }

  function renderToolbar() {
    var searchInput = el('input.input.input--search', {
      type: 'search', value: state.query, placeholder: '이름 · ID · 필드 · 태그 검색',
      oninput: U.debounce(function (e) { state.query = e.target.value; renderRowsOnly(); }, 200)
    });
    var tags = {};
    store.nodesOfType(state.type).forEach(function (r) {
      (r.node.tags || []).forEach(function (t) { tags[t] = (tags[t] || 0) + 1; });
    });
    var tagNames = Object.keys(tags).sort(function (a, b) { return a.localeCompare(b, 'ko'); });
    var tagSelect = el('select.input.input--sm', {
      onchange: function (e) { state.tag = e.target.value; renderRowsOnly(); }
    }, [el('option', { value: '', text: '태그 전체', selected: !state.tag })].concat(
      tagNames.map(function (t) {
        return el('option', { value: t, text: t + ' (' + tags[t] + ')', selected: state.tag === t });
      })
    ));

    return el('div.toolbar', {}, [
      searchInput,
      tagNames.length ? tagSelect : null,
      flagFilter('status'), flagFilter('reveal'), flagFilter('impl'),
      el('label.check', {}, [
        el('input', {
          type: 'checkbox', checked: state.hideDropped,
          onchange: function (e) { state.hideDropped = e.target.checked; renderRowsOnly(); }
        }),
        el('span', { text: '폐기 숨김' })
      ]),
      el('span.spacer'),
      el('button.btn.btn--primary', {
        type: 'button', text: '+ 새 ' + store.typeLabel(state.type),
        onclick: function () {
          WM.picker.newNodeDialog(state.type).then(function (id) {
            if (!id) return;
            render();
            gotoNode(id);
          });
        }
      })
    ]);
  }

  function headerCell(label, key, cls) {
    var on = state.sort.key === key;
    return el('th' + (cls || '') + (on ? '.is-sorted' : ''), {
      onclick: function () {
        if (on) state.sort.dir *= -1; else state.sort = { key: key, dir: 1 };
        renderRowsOnly();
      }
    }, [label, on ? el('span.caret', { text: state.sort.dir > 0 ? ' ▲' : ' ▼' }) : null]);
  }

  function flagBadge(id, node, name) {
    var def = store.flagDef(name);
    var cur = node[name];
    return el('button.badge.badge--' + name + '.badge--' + cur, {
      type: 'button', title: def.label + ': ' + store.flagLabel(name, cur),
      onclick: function (e) {
        e.stopPropagation();
        popupMenu(e.currentTarget, def.values.map(function (v) {
          return {
            label: v.label, on: v.key === cur,
            onSelect: function () {
              var patch = {}; patch[name] = v.key;
              store.updateNode(id, patch);
              renderRowsOnly();
            }
          };
        }));
      }
    }, [store.flagLabel(name, cur)]);
  }

  var tbodyRef = null, theadRef = null;

  function renderRowsOnly() {
    if (!tbodyRef) { render(); return; }
    var r = visibleRows();
    var def = r.def;
    U.clear(tbodyRef);

    if (!r.rows.length) {
      tbodyRef.appendChild(el('tr.empty-row', {}, [
        el('td', { colspan: def.cardFields.length + 5 }, [
          el('div.empty', { text: state.query ? '조건에 맞는 노드가 없습니다.' : '아직 ' + def.label + ' 노드가 없습니다.' })
        ])
      ]));
    }

    var sel = WM.panel.selected();
    r.rows.forEach(function (row) {
      var n = row.node;
      var missing = store.missingRequired(row.id);
      var tr = el('tr.row' + (sel === row.id ? '.is-sel' : '') + '.status--' + n.status, {
        dataset: { id: row.id },
        onclick: function () { WM.panel.select(row.id); markSelected(row.id); }
      });

      tr.appendChild(el('td.cell--name', { dataset: { label: '이름' } }, [
        el('span.dot', { style: { background: store.typeColor(n.type) } }),
        el('span.name', { text: n.name }),
        n.reveal === 'spoiler' ? el('span.lock', { text: '🔒', title: '미공개' }) : null,
        missing.length ? el('span.miss', { text: '!', title: '필수 미입력: ' + missing.join(', ') }) : null
      ]));

      tr.appendChild(el('td.cell--id', { dataset: { label: 'ID' } }, [el('code', { text: row.id })]));

      def.cardFields.forEach(function (fk) {
        var f = store.fieldDef(state.type, fk);
        if (!f) return;
        var cell = el('td.cell--field' + (inlineEditable(f) ? '.is-editable' : ''), {
          dataset: { label: f.label },
          title: inlineEditable(f) ? '더블클릭해서 편집' : '',
          ondblclick: function (e) {
            if (!inlineEditable(f)) return;
            e.stopPropagation();
            startEdit(cell, row.id, f);
          }
        }, [displayValue(n, f) || el('span.dim', { text: '—' })]);
        tr.appendChild(cell);
      });

      tr.appendChild(el('td.cell--edges', { dataset: { label: '연결' } }, [
        String(store.edgeCount(row.id))
      ]));

      tr.appendChild(el('td.cell--flags', { dataset: { label: '상태' } }, [
        flagBadge(row.id, n, 'status'),
        flagBadge(row.id, n, 'impl')
      ]));

      tbodyRef.appendChild(tr);
    });

    var counter = U.$('#row-count');
    if (counter) counter.textContent = r.rows.length + ' / ' + store.nodesOfType(state.type).length;
  }

  function markSelected(id) {
    U.$$('.row.is-sel', tbodyRef).forEach(function (tr) { tr.classList.remove('is-sel'); });
    var tr = tbodyRef.querySelector('.row[data-id="' + id + '"]');
    if (tr) tr.classList.add('is-sel');
  }

  function render() {
    if (!paneRoot) return;
    renderTabs();
    U.clear(paneRoot);

    var def = store.typeDef(state.type);
    if (!def) {
      paneRoot.appendChild(el('div.empty', { text: '타입이 없습니다. schema.json 을 확인해 주세요.' }));
      return;
    }

    theadRef = el('thead', {}, [
      el('tr', {}, [
        headerCell('이름', 'name', '.cell--name'),
        headerCell('ID', 'id', '.cell--id')
      ].concat(def.cardFields.map(function (fk) {
        var f = store.fieldDef(state.type, fk);
        return headerCell(f ? f.label : fk, fk, '.cell--field');
      })).concat([
        headerCell('연결', 'edges', '.cell--edges'),
        el('th.cell--flags', { text: '상태' })
      ]))
    ]);
    tbodyRef = el('tbody');

    paneRoot.appendChild(renderToolbar());
    paneRoot.appendChild(el('div.table-wrap', {}, [
      el('table.table', {}, [theadRef, tbodyRef])
    ]));
    paneRoot.appendChild(el('div.table-foot', {}, [
      el('span#row-count.dim'),
      el('span.dim', { text: ' · 필드 칸은 더블클릭해서 바로 고칠 수 있습니다' })
    ]));

    renderRowsOnly();
  }

  /** 다른 타입에 있는 노드라도 탭을 옮겨가며 찾아 선택한다. */
  function gotoNode(id) {
    var n = store.state.nodes[id];
    if (!n) { U.toast('없는 노드입니다: ' + id, 'bad'); return; }
    if (state.type !== n.type) { state.type = n.type; render(); }
    state.query = '';
    WM.panel.select(id);
    renderRowsOnly();
    var tr = tbodyRef && tbodyRef.querySelector('.row[data-id="' + id + '"]');
    if (tr) {
      tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
      tr.classList.add('is-flash');
      setTimeout(function () { tr.classList.remove('is-flash'); }, 1200);
    }
    document.body.classList.add('panel-open');
  }

  /** 인라인 셀을 편집하는 중이면 다시 그리지 않는다. 다시 그리면 입력 중인 칸이 사라진다. */
  function refresh() {
    var a = document.activeElement;
    if (a && a.classList && a.classList.contains('input--cell')) return;
    /* 타입바 개수도 함께 갱신한다. 예전에는 renderRowsOnly 만 불러서 행은 사라지는데
       개수는 그대로 남았다 — 노드를 지워도 숫자가 안 줄어 합계가 어긋난다.
       renderTabs 는 버튼 몇 개를 다시 만드는 것뿐이라 매 변경에 불러도 부담이 없다. */
    renderTabs();
    if (tbodyRef) renderRowsOnly(); else render();
  }

  WM.table = {
    mount: mount, render: render, refresh: refresh, gotoNode: gotoNode, state: state
  };
})(window.WM);
