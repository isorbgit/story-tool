/* ui-panel.js — 우측 디테일 패널. 전부 schema.json 을 읽어 그린다.
   타입을 추가해도 이 파일은 수정하지 않는다(SPEC 5.3). */
(function (WM) {
  'use strict';
  var U = WM.util, el = U.el, store = WM.store;

  var root = null;
  var currentId = null;
  var openEdges = {};   // 펼쳐둔 엣지 편집 영역

  function mount(node) { root = node; }

  function select(id) {
    currentId = id;
    openEdges = {};
    render();
    WM.store.emit('selection', id);
  }

  function selected() { return currentId; }

  /* ---------- 위젯 ---------- */

  var pushField = U.debounce(function (id, key, value) { store.setField(id, key, value); }, 350);

  function widgetFor(id, node, f) {
    var val = node.fields[f.key];

    if (f.widget === 'select') {
      return el('select.input', {
        onchange: function (e) { store.setField(id, f.key, e.target.value); }
      }, [el('option', { value: '', text: '— 선택 —', selected: !val })].concat(
        (f.options || []).map(function (o) {
          return el('option', { value: o, text: o, selected: val === o });
        })
      ));
    }

    if (f.widget === 'markdown') {
      var ta = el('textarea.input.input--area', {
        rows: 4, value: val || '', spellcheck: 'false',
        oninput: function (e) { autogrow(e.target); pushField(id, f.key, e.target.value); }
      });
      requestAnimationFrame(function () { autogrow(ta); });
      return ta;
    }

    if (f.widget === 'when') return whenWidget(id, f, val);

    return el('input.input', {
      type: 'text', value: val || '', placeholder: f.hint || '',
      oninput: function (e) { pushField(id, f.key, e.target.value); }
    });
  }

  function autogrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(360, Math.max(64, ta.scrollHeight + 2)) + 'px';
  }

  /** SPEC 6장 — 가상 연대는 Date 로 파싱할 수 없어 sort/display/precision 3필드로 다룬다.
      저장 형태는 그대로 두고, 입력만 연·달·일로 받아 sort 를 계산한다.
      sort 가 원본이고 연·달·일은 거기서 역산하므로 새로 저장할 필드가 없다. */
  function whenWidget(id, f, val) {
    val = val || {};
    var C = WM.calendar;
    var precisions = store.state.schema.whenPrecision || [];
    var prec = val.precision || 'unknown';
    var parts = C.fromSort(typeof val.sort === 'number' ? val.sort : 0);
    if (typeof val.sort !== 'number') parts.year = '';

    // 사람이 손으로 고친 표기는 존중한다. 자동 문구와 같을 때만 계속 따라 쓴다.
    var manual = !!(val.display && val.display !== C.format(parts.year, parts.monthIndex, parts.day, prec));

    var yearIn, monthSel, dayIn, dispIn, sortOut;

    function commit() {
      if (prec === 'unknown' || yearIn.value === '') {
        store.setField(id, f.key, manual && dispIn.value ? { display: dispIn.value, precision: prec } : '');
        sync();
        return;
      }
      var y = Number(yearIn.value);
      var mi = Number(monthSel.value) || 0;
      /* 달 길이가 8~48 로 제각각이라 달을 바꾸면 일이 범위를 넘을 수 있다.
         여기서 한 번 잘라 두지 않으면 sort 는 잘린 값으로, 표기는 안 잘린 값으로
         계산돼 둘이 어긋난다. */
      var ms = C.months();
      var maxD = ms[Math.max(0, Math.min(ms.length - 1, mi))].days;
      var d = Math.max(1, Math.min(maxD, Number(dayIn.value) || 1));
      if (dayIn.value !== String(d)) dayIn.value = d;
      var sort = C.toSort(y, mi, d, prec);
      if (!manual) dispIn.value = C.format(y, mi, d, prec);
      store.setField(id, f.key, { sort: sort, display: dispIn.value, precision: prec });
      sync();
    }

    /** 정밀도에 따라 필요 없는 칸을 감추고, 일 상한을 그 달 길이로 맞춘다. */
    function sync() {
      var showMonth = prec === 'exact' || prec === 'month';
      var showDay = prec === 'exact';
      var showYear = prec !== 'unknown';
      yearIn.parentNode.hidden = !showYear;
      monthSel.parentNode.hidden = !showMonth;
      dayIn.parentNode.hidden = !showDay;

      var ms = C.months();
      var m = ms[Number(monthSel.value) || 0];
      dayIn.max = m.days;
      dayIn.title = m.label + ' 은 ' + m.days + '일까지';

      var cur = store.state.nodes[id].fields[f.key];
      sortOut.textContent = (cur && typeof cur.sort === 'number')
        ? 'sort ' + (Math.round(cur.sort * 10000) / 10000) : 'sort —';
    }

    function box(label, control) {
      return el('label.when__box', {}, [el('span.when__lbl', { text: label }), control]);
    }

    yearIn = el('input.input.input--sm', {
      type: 'number', step: '1', value: parts.year, placeholder: '981',
      oninput: commit
    });
    monthSel = el('select.input.input--sm', { onchange: commit },
      C.months().map(function (m, i) {
        return el('option', { value: i, text: m.label, selected: i === parts.monthIndex });
      }));
    dayIn = el('input.input.input--sm', {
      type: 'number', step: '1', min: '1', value: parts.day, oninput: commit
    });
    dispIn = el('input.input', {
      type: 'text', value: val.display || '', placeholder: '자동',
      oninput: function (e) {
        manual = true;
        var cur = store.state.nodes[id].fields[f.key] || {};
        store.setField(id, f.key, Object.assign({}, cur, { display: e.target.value }));
      }
    });
    sortOut = el('span.when__sortout.dim.small');

    var precSel = el('select.input.input--sm', {
      onchange: function (e) { prec = e.target.value; commit(); }
    }, precisions.map(function (p) {
      return el('option', { value: p.key, text: p.label, selected: prec === p.key });
    }));

    var root = el('div.when', {}, [
      el('div.when__grid', {}, [
        box('정밀도', precSel),
        box('연', yearIn),
        box('달', monthSel),
        box('일', dayIn)
      ]),
      dispIn,
      el('div.when__foot', {}, [
        sortOut,
        el('button.btn.btn--tiny.btn--ghost', {
          type: 'button', text: '표기 자동', title: '손으로 고친 표기를 버리고 다시 자동으로',
          onclick: function () { manual = false; commit(); }
        })
      ])
    ]);

    sync();
    return root;
  }

  function flagSelect(id, node, name) {
    var def = store.flagDef(name);
    return el('label.flag', {}, [
      el('span.flag__label', { text: def.label }),
      el('select.input.input--sm', {
        onchange: function (e) { store.updateNode(id, defObj(name, e.target.value)); }
      }, def.values.map(function (v) {
        return el('option', { value: v.key, text: v.label, selected: node[name] === v.key });
      }))
    ]);
  }

  function defObj(k, v) { var o = {}; o[k] = v; return o; }

  /* ---------- 소켓 ---------- */

  function socketBlock(id, node, sock) {
    var conns = store.connectionsOf(id, sock.key);
    var rows = conns.map(function (c) { return edgeRow(id, sock, c); });

    return el('div.socket', {}, [
      el('div.socket__head', {}, [
        el('span.socket__pin' + (sock.pin === 'causal' ? '.socket__pin--causal' : ''), {
          style: sock.pin === 'causal' ? null : { background: store.typeColor(sock.accepts[0]) },
          title: sock.pin === 'causal' ? '인과핀' : '관여핀'
        }),
        el('span.socket__label', { text: sock.label }),
        el('span.socket__accepts', { text: sock.accepts.map(store.typeLabel).join(' · ') }),
        el('span.socket__count', { text: conns.length ? String(conns.length) : '' }),
        el('button.btn.btn--tiny', {
          type: 'button', text: '+ 연결',
          disabled: !sock.multi && conns.length > 0,
          onclick: function () { addConnection(id, sock); }
        })
      ]),
      rows.length ? el('div.socket__body', {}, rows) : null
    ]);
  }

  function edgeRow(id, sock, c) {
    var other = c.other;
    var isOpen = !!openEdges[c.id];
    var head = el('div.edge__head', {}, [
      el('button.edge__jump', {
        type: 'button', title: '이 노드로 이동',
        onclick: function () { WM.table.gotoNode(c.otherId); }
      }, [
        el('span.dot', { style: { background: store.typeColor(other ? other.type : 'event') } }),
        el('span.edge__name', { text: other ? other.name : '(없는 노드 ' + c.otherId + ')' })
      ]),
      el('span.edge__arrow', { text: c.outgoing ? '→' : '←', title: c.outgoing ? '이 노드가 from' : '이 노드가 to' }),
      el('button.edge__label', {
        type: 'button',
        text: c.edge.label || '(라벨 없음)',
        onclick: function () { openEdges[c.id] = !isOpen; render(); }
      }),
      el('button.btn.btn--tiny.btn--danger', {
        type: 'button', text: '해제', title: '연결만 끊습니다. 노드는 남습니다.',
        onclick: function () { store.disconnect(c.id); render(); }
      })
    ]);
    return el('div.edge' + (isOpen ? '.is-open' : ''), {}, [head, isOpen ? edgeEditor(c, sock) : null]);
  }

  function edgeEditor(c, sock) {
    var preset = store.presetDef(sock.labelPreset);
    var e = c.edge;
    var kids = [];

    if (preset.options && preset.options.length) {
      kids.push(el('div.chips', {}, preset.options.map(function (o) {
        return el('button.chip' + (e.label === o ? '.is-on' : ''), {
          type: 'button', text: o,
          onclick: function () { store.updateEdge(c.id, { label: e.label === o ? '' : o }); render(); }
        });
      })));
    }
    if (preset.free) {
      kids.push(el('label.field', {}, [
        el('span.field__label', { text: '라벨 (자유 입력)' }),
        el('input.input', {
          type: 'text', value: e.label || '',
          oninput: U.debounce(function (ev) { store.updateEdge(c.id, { label: ev.target.value }); }, 350)
        })
      ]));
    }

    kids.push(el('label.field', {}, [
      el('span.field__label', { text: '메모' }),
      el('input.input', {
        type: 'text', value: e.note || '',
        oninput: U.debounce(function (ev) { store.updateEdge(c.id, { note: ev.target.value }); }, 350)
      })
    ]));

    (preset.extraFields || []).forEach(function (f) {
      if (f.key === 'note') return;   // 위에서 이미 다뤘다
      var cur = e.fields[f.key] === undefined ? (f.default || '') : e.fields[f.key];
      var input;
      if (f.widget === 'select') {
        input = el('select.input', {
          onchange: function (ev) { store.updateEdge(c.id, { fields: defObj(f.key, ev.target.value) }); }
        }, (f.options || []).map(function (o) {
          return el('option', { value: o, text: o, selected: cur === o });
        }));
      } else {
        input = el('input.input', {
          type: 'text', value: cur,
          oninput: U.debounce(function (ev) {
            store.updateEdge(c.id, { fields: defObj(f.key, ev.target.value) });
          }, 350)
        });
      }
      kids.push(el('label.field', {}, [el('span.field__label', { text: f.label }), input]));
    });

    var sdef = store.flagDef('status');
    kids.push(el('label.field', {}, [
      el('span.field__label', { text: '상태' }),
      el('select.input.input--sm', {
        onchange: function (ev) { store.updateEdge(c.id, { status: ev.target.value }); }
      }, sdef.values.map(function (v) {
        return el('option', { value: v.key, text: v.label, selected: e.status === v.key });
      }))
    ]));

    return el('div.edge__editor', {}, kids);
  }

  function addConnection(id, sock) {
    WM.picker.pickNode({
      title: '「' + sock.label + '」 에 연결',
      accepts: sock.accepts,
      exclude: sock.accepts.indexOf(store.state.nodes[id].type) >= 0 && !sock.undirected ? [] : [id]
    }).then(function (targetId) {
      if (!targetId) return;
      try {
        var r = store.connect(id, sock.key, targetId);
        if (r.existed) U.toast('이미 연결돼 있습니다.', 'warn');
      } catch (err) {
        U.toast(err.message, 'bad', 5000);
      }
      render();
    });
  }

  /* ---------- 삭제 (SPEC 4.2) ---------- */

  function deleteNodeFlow(id) {
    var node = store.state.nodes[id];
    var imp = store.impactOf(id);
    var listBox = el('ul.impact', { hidden: true }, imp.edges.map(function (e) {
      var a = store.state.nodes[e.from], b = store.state.nodes[e.to];
      return el('li', {
        text: (a ? a.name : e.from) + ' —' + (e.label || '') + '→ ' + (b ? b.name : e.to)
      });
    }).concat(imp.canvases.map(function (cid) {
      return el('li', { text: '캔버스: ' + ((store.state.canvases[cid] || {}).name || cid) });
    })));

    var body = [
      el('p', {}, [el('code', { text: id }), ' 를 완전히 삭제합니다.']),
      el('ul.impact-summary', {}, [
        el('li', {}, ['· 참조 엣지 ', el('b', { text: String(imp.edgeCount) }), ' 개가 함께 삭제됩니다']),
        el('li', {}, ['· ', el('b', { text: String(imp.canvasCount) }), ' 개 캔버스에서 배치가 제거됩니다'])
      ]),
      (imp.edgeCount + imp.canvasCount) ? el('button.btn.btn--ghost', {
        type: 'button', text: '영향 목록 보기',
        onclick: function (ev) {
          listBox.hidden = !listBox.hidden;
          ev.target.textContent = listBox.hidden ? '영향 목록 보기' : '접기';
        }
      }) : null,
      listBox
    ];

    U.modal({
      title: (node ? node.name : id) + ' 전역 삭제',
      body: body,
      actions: [{ label: '취소', value: null }, { label: '삭제', value: true, kind: 'danger' }]
    }).then(function (ok) {
      if (!ok) return;
      store.deleteNode(id);
      currentId = null;
      render();
      U.toast('삭제했습니다.', 'ok');
    });
  }

  /* ---------- 렌더 ---------- */

  function render() {
    if (!root) return;
    U.clear(root);

    var id = currentId;
    var node = id && store.state.nodes[id];
    if (!node) {
      root.appendChild(el('div.panel__empty', {}, [
        el('p', { text: '왼쪽 표에서 노드를 고르면 여기에 상세가 열립니다.' })
      ]));
      return;
    }

    var def = store.typeDef(node.type);
    var missing = store.missingRequired(id);

    root.appendChild(el('div.panel__head', { style: { '--type-color': store.typeColor(node.type) } }, [
      el('div.panel__toprow', {}, [
        el('span.type-chip', { style: { background: store.typeColor(node.type) }, text: def.label }),
        el('code.panel__id', { text: id }),
        el('button.btn.btn--tiny.btn--ghost', {
          type: 'button', text: '그래프', title: '그래프 뷰에서 이 노드 보기',
          onclick: function () { WM.app.showGraph(id); }
        }),
        el('button.icon-btn', {
          type: 'button', text: '✕', title: '패널 닫기',
          onclick: function () { select(null); }
        })
      ]),
      el('input.input.input--title', {
        type: 'text', value: node.name,
        oninput: U.debounce(function (e) { store.updateNode(id, { name: e.target.value }); }, 350)
      }),
      el('div.flags', {}, ['status', 'reveal', 'impl'].map(function (f) {
        return flagSelect(id, node, f);
      })),
      missing.length ? el('p.warn', { text: '필수 미입력: ' + missing.join(', ') }) : null
    ]));

    var body = el('div.panel__body');

    body.appendChild(el('section.group', {}, [
      el('h3.group__title', { text: '기본' }),
      el('label.field', {}, [
        el('span.field__label', { text: 'gameKey' }),
        el('input.input', {
          type: 'text', value: node.gameKey || '', placeholder: '게임 데이터 테이블 키',
          spellcheck: 'false',
          oninput: U.debounce(function (e) { store.updateNode(id, { gameKey: e.target.value }); }, 350)
        })
      ]),
      el('label.field', {}, [
        el('span.field__label', { text: '태그' }),
        el('input.input', {
          type: 'text', value: (node.tags || []).join(', '), placeholder: '주연, 1장',
          oninput: U.debounce(function (e) {
            store.updateNode(id, {
              tags: e.target.value.split(',').map(function (s) { return s.trim(); })
                .filter(function (s) { return s; })
            });
          }, 350)
        })
      ])
    ]));

    body.appendChild(el('section.group', {}, [
      el('h3.group__title', { text: '필드' })
    ].concat(def.fields.filter(function (f) {
      return !(f.reveal === 'spoiler' && WM.app.safeMode());   // 안전 모드에선 비밀 필드를 아예 안 그린다
    }).map(function (f) {
      return el('label.field' + (f.reveal === 'spoiler' ? '.field--spoiler' : ''), {}, [
        el('span.field__label', {}, [
          f.label,
          f.required ? el('em.req', { text: ' 필수' }) : null,
          f.reveal === 'spoiler' ? el('em.spoiler-tag', { text: ' 미공개' }) : null
        ]),
        widgetFor(id, node, f)
      ]);
    }))));

    body.appendChild(el('section.group', {}, [
      el('h3.group__title', {}, [
        '연결',
        el('span.group__sub', { text: ' 총 ' + store.edgeCount(id) + '건' })
      ])
    ].concat(def.sockets.map(function (s) { return socketBlock(id, node, s); }))));

    body.appendChild(el('section.group.group--danger', {}, [
      el('div.dim.small', { text: '만든 날 ' + (node.created || '') + ' · 고친 날 ' + (node.updated || '') }),
      el('button.btn.btn--danger', {
        type: 'button', text: '이 노드 전역 삭제',
        onclick: function () { deleteNodeFlow(id); }
      })
    ]));

    root.appendChild(body);
  }

  /** 외부 변경으로 다시 그릴 때, 사용자가 패널 안에서 타이핑 중이면 건드리지 않는다. */
  function refreshIfIdle() {
    if (root && root.contains(document.activeElement)) return;
    render();
  }

  WM.panel = {
    mount: mount, select: select, selected: selected,
    render: render, refreshIfIdle: refreshIfIdle
  };
})(window.WM);
