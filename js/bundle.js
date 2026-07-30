/* bundle.js — PC ↔ iOS 교환 (SPEC 3.4).
   OPFS는 사용자에게 안 보이므로 파일 4개를 개별로 주고받게 하면 실수가 난다.
   단일 번들 1개로 오가고, 가져올 때는 절대 통째로 덮어쓰지 않는다. */
(function (WM) {
  'use strict';
  var U = WM.util, el = U.el;
  var LASTSYNC_KEY = 'worldmap-last-sync';

  /* ---------- 내보내기 ---------- */

  function build() {
    var S = WM.store.state;
    return {
      format: 'wmap-bundle',
      version: 1,
      exportedAt: U.nowIso(),
      exportedFrom: S.adapter ? S.adapter.id : 'unknown',
      nodes: S.nodes,
      edges: S.edges,
      canvases: S.canvases,
      schema: S.schema
    };
  }

  function exportBundle() {
    var b = build();
    var name = 'worldmap-' + U.stamp() + '.wmap.json';
    U.download(name, WM.store.stringify(b));
    U.idbSet(LASTSYNC_KEY, b.exportedAt);
    U.toast(name + ' 내보냄', 'ok');
  }

  /* ---------- 비교 ----------
     엣지 ID(e_0001)는 기기마다 독립 증가하므로 서로 다른 연결에 같은 ID가 붙는다.
     따라서 엣지는 ID가 아니라 (from|fromSocket|to|toSocket) 조합으로 대조한다. */

  function edgeKey(e) { return e.from + '|' + e.fromSocket + '|' + e.to + '|' + e.toSocket; }

  function contentOf(obj) {
    var c = {};
    Object.keys(obj).forEach(function (k) {
      if (k !== 'created' && k !== 'updated') c[k] = obj[k];
    });
    return WM.store.stringify(c);
  }

  function changedSince(obj, sinceIso) {
    if (!sinceIso) return null;               // 기준 없음 → 판정 불가
    return String(obj.updated || '') > sinceIso;
  }

  /**
   * 항목 하나의 처리 방침 결정.
   * lastSync 가 있으면 "양쪽 모두 그 이후 수정" 만 진짜 충돌로 본다.
   * 없으면 타임스탬프 비교로 격하한다(로컬이 더 최신이면 충돌로 올려 사람이 보게 한다).
   */
  function classify(local, incoming, lastSync) {
    if (!local) return 'add';
    if (contentOf(local) === contentOf(incoming)) return 'same';

    var localChanged = changedSince(local, lastSync);
    var incomingChanged = changedSince(incoming, lastSync);
    if (localChanged !== null) {
      if (localChanged && incomingChanged) return 'conflict';
      if (incomingChanged) return 'update';
      return 'keep';                          // 로컬만 바뀜
    }
    var lu = String(local.updated || ''), iu = String(incoming.updated || '');
    if (iu > lu) return 'update';
    if (lu > iu) return 'conflict';
    return 'conflict';
  }

  function analyze(b, lastSync) {
    var S = WM.store.state;
    var r = {
      nodes: { add: [], update: [], conflict: [], keep: [], same: 0 },
      edges: { add: [], update: [], conflict: [], keep: [], same: 0 },
      canvases: { add: [], mergePlacements: [], same: 0 },
      schemaDiffers: false,
      lastSync: lastSync
    };

    Object.keys(b.nodes || {}).forEach(function (id) {
      var verdict = classify(S.nodes[id], b.nodes[id], lastSync);
      if (verdict === 'same') { r.nodes.same++; return; }
      r.nodes[verdict].push({ id: id, local: S.nodes[id], incoming: b.nodes[id] });
    });

    var localByKey = {};
    Object.keys(S.edges).forEach(function (id) { localByKey[edgeKey(S.edges[id])] = { id: id, edge: S.edges[id] }; });

    Object.keys(b.edges || {}).forEach(function (id) {
      var inc = b.edges[id];
      // 참조 노드가 양쪽 어디에도 없으면 가져와봐야 끊어진 엣지가 된다.
      var haveFrom = S.nodes[inc.from] || (b.nodes && b.nodes[inc.from]);
      var haveTo = S.nodes[inc.to] || (b.nodes && b.nodes[inc.to]);
      if (!haveFrom || !haveTo) return;

      var k = edgeKey(inc);
      var hit = localByKey[k];
      var verdict = classify(hit && hit.edge, inc, lastSync);
      if (verdict === 'same') { r.edges.same++; return; }
      r.edges[verdict].push({
        id: hit ? hit.id : id, incomingId: id, key: k,
        local: hit && hit.edge, incoming: inc
      });
    });

    Object.keys(b.canvases || {}).forEach(function (id) {
      var loc = S.canvases[id], inc = b.canvases[id];
      if (!loc) { r.canvases.add.push({ id: id, incoming: inc }); return; }
      var newPlacements = Object.keys(inc.placements || {}).filter(function (nid) {
        return !(loc.placements && loc.placements[nid]);
      });
      if (newPlacements.length) r.canvases.mergePlacements.push({ id: id, incoming: inc, keys: newPlacements });
      else r.canvases.same++;
    });

    r.schemaDiffers = !!b.schema && WM.store.stringify(b.schema) !== WM.store.stringify(S.schema);
    return r;
  }

  /* ---------- 적용 ----------
     resolutions: { 'node:chr_lena': 'incoming' | 'local', ... } — 충돌 항목만 담긴다. */

  function apply(b, r, resolutions, takeSchema) {
    var S = WM.store.state;
    var applied = { nodes: 0, edges: 0, canvases: 0 };

    function wants(kind, id) {
      return resolutions[kind + ':' + id] !== 'local';
    }

    r.nodes.add.forEach(function (it) { S.nodes[it.id] = it.incoming; applied.nodes++; });
    r.nodes.update.forEach(function (it) { S.nodes[it.id] = it.incoming; applied.nodes++; });
    r.nodes.conflict.forEach(function (it) {
      if (wants('node', it.id)) { S.nodes[it.id] = it.incoming; applied.nodes++; }
    });

    function putEdge(it) {
      var id = it.id;
      // 로컬에 없던 엣지인데 ID가 이미 다른 연결에 쓰이고 있으면 새 번호를 딴다.
      if (!it.local && S.edges[id] && edgeKey(S.edges[id]) !== it.key) {
        var n = 1;
        while (S.edges[id + '_i' + n]) n++;
        id = id + '_i' + n;
      }
      S.edges[id] = it.incoming;
      applied.edges++;
    }
    r.edges.add.forEach(putEdge);
    r.edges.update.forEach(putEdge);
    r.edges.conflict.forEach(function (it) { if (wants('edge', it.key)) putEdge(it); });

    r.canvases.add.forEach(function (it) { S.canvases[it.id] = it.incoming; applied.canvases++; });
    r.canvases.mergePlacements.forEach(function (it) {
      var loc = S.canvases[it.id];
      loc.placements = loc.placements || {};
      it.keys.forEach(function (nid) { loc.placements[nid] = it.incoming.placements[nid]; });
      applied.canvases++;
    });

    if (takeSchema && b.schema) S.schema = b.schema;

    WM.store.normalize();
    ['nodes.json', 'edges.json', 'canvases.json'].forEach(function (f) { S.dirty[f] = true; });
    if (takeSchema) S.dirty['schema.json'] = true;
    WM.store.emit('nodes'); WM.store.emit('edges'); WM.store.emit('loaded');
    WM.store.save();
    U.idbSet(LASTSYNC_KEY, U.nowIso());
    return applied;
  }

  /* ---------- 가져오기 UI ---------- */

  function row(label, n, kind) {
    return el('span.tally' + (kind ? '.tally--' + kind : ''), {}, [
      el('b', { text: String(n) }), ' ' + label
    ]);
  }

  function conflictList(r, resolutions) {
    var items = [];
    r.nodes.conflict.forEach(function (it) {
      items.push(conflictRow('node', it.id, it.local.name + ' (' + it.id + ')',
        it.local.updated, it.incoming.updated, resolutions));
    });
    r.edges.conflict.forEach(function (it) {
      var S = WM.store.state;
      var a = (S.nodes[it.incoming.from] || {}).name || it.incoming.from;
      var b2 = (S.nodes[it.incoming.to] || {}).name || it.incoming.to;
      items.push(conflictRow('edge', it.key, a + ' → ' + b2,
        it.local && it.local.updated, it.incoming.updated, resolutions));
    });
    return items;
  }

  function conflictRow(kind, id, title, localAt, incomingAt, resolutions) {
    var key = kind + ':' + id;
    var name = 'res_' + key.replace(/[^a-zA-Z0-9]/g, '_');
    function radio(value, text, sub) {
      return el('label.choice', {}, [
        el('input', {
          type: 'radio', name: name, value: value,
          checked: (resolutions[key] || 'incoming') === value,
          onchange: function () { resolutions[key] = value; }
        }),
        el('span', {}, [el('b', { text: text }), sub ? el('em', { text: ' ' + sub }) : null])
      ]);
    }
    return el('div.conflict', {}, [
      el('div.conflict__title', { text: title }),
      el('div.conflict__opts', {}, [
        radio('incoming', '가져온 것', incomingAt || ''),
        radio('local', '이쪽 것', localAt || '')
      ])
    ]);
  }

  function importBundle() {
    return U.pickTextFile('.json,application/json').then(function (picked) {
      if (!picked) return;
      var b;
      try { b = JSON.parse(picked.text); }
      catch (e) { U.toast('JSON을 읽을 수 없습니다: ' + e.message, 'bad', 5000); return; }
      if (!b || b.format !== 'wmap-bundle') {
        U.toast('이 툴의 번들 파일이 아닙니다 (format ≠ wmap-bundle)', 'bad', 5000);
        return;
      }
      return U.idbGet(LASTSYNC_KEY).then(function (lastSync) {
        var r = analyze(b, lastSync);
        return showPlan(picked.name, b, r);
      });
    });
  }

  function showPlan(filename, b, r) {
    var resolutions = {};
    var takeSchema = { value: false };
    var conflicts = r.nodes.conflict.length + r.edges.conflict.length;
    var nothing = !r.nodes.add.length && !r.nodes.update.length && !r.edges.add.length &&
      !r.edges.update.length && !r.canvases.add.length && !r.canvases.mergePlacements.length && !conflicts;

    var details = el('div.conflict-box', { hidden: true }, conflictList(r, resolutions));

    var body = [
      el('p.dim', { text: filename + ' · ' + (b.exportedFrom || '?') + ' 에서 ' + (b.exportedAt || '') }),
      el('div.tallies', {}, [
        row('추가', r.nodes.add.length + r.edges.add.length + r.canvases.add.length, 'add'),
        row('갱신', r.nodes.update.length + r.edges.update.length, 'up'),
        row('변경 없음', r.nodes.same + r.edges.same + r.canvases.same),
        conflicts ? row('충돌', conflicts, 'bad') : null
      ]),
      r.lastSync
        ? el('p.dim', { text: '마지막 동기화: ' + r.lastSync })
        : el('p.warn', { text: '이전 동기화 기록이 없어 수정 시각만으로 비교했습니다. 충돌 판정이 느슨할 수 있습니다.' }),
      conflicts ? el('button.btn.btn--ghost', {
        type: 'button', text: '충돌 ' + conflicts + '건 보기',
        onclick: function (e) {
          details.hidden = !details.hidden;
          e.target.textContent = (details.hidden ? '충돌 ' + conflicts + '건 보기' : '충돌 접기');
        }
      }) : null,
      details,
      r.schemaDiffers ? el('label.choice.choice--block', {}, [
        el('input', { type: 'checkbox', onchange: function (e) { takeSchema.value = e.target.checked; } }),
        el('span', { text: '스키마도 가져오기 (타입·소켓 정의가 이쪽과 다릅니다)' })
      ]) : null,
      nothing ? el('p.dim', { text: '적용할 변경이 없습니다.' }) : null,
      el('p.dim', { text: '가져오기 직전에 백업 스냅샷을 남깁니다. 삭제는 동기화하지 않습니다.' })
    ];

    return U.modal({
      title: '가져오기',
      body: body,
      actions: nothing
        ? [{ label: '닫기', value: null }]
        : [{ label: '취소', value: null }, { label: '가져오기', value: true, kind: 'primary' }]
    }).then(function (ok) {
      if (!ok) return;
      return WM.store.maybeBackup(true).then(function () {
        var applied = apply(b, r, resolutions, takeSchema.value);
        U.toast('가져오기 완료 — 노드 ' + applied.nodes + ' · 엣지 ' + applied.edges +
          ' · 캔버스 ' + applied.canvases, 'ok', 4000);
      });
    });
  }

  WM.bundle = {
    build: build, exportBundle: exportBundle, importBundle: importBundle,
    analyze: analyze, apply: apply, edgeKey: edgeKey
  };
})(window.WM);
