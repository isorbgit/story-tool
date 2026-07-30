/* validate.js — 검증 규칙 (SPEC 10장). 순수 계산만 한다. UI는 ui-issues.js.

   issue = { level, rule, label, message, nodeId?, edgeId?, nodes? } */
(function (WM) {
  'use strict';
  var U = WM.util, store = WM.store;

  var RULES = {
    orphan:      { level: 'warn',  label: '고아 노드' },
    required:    { level: 'warn',  label: '필수 필드 미입력' },
    cycle:       { level: 'error', label: '인과 순환' },
    sortConflict:{ level: 'error', label: '인과 방향과 시점 모순' },
    unplaced:    { level: 'info',  label: '배치되지 않은 노드' },
    duplicate:   { level: 'info',  label: '중복 의심' },
    draftBasis:  { level: 'info',  label: '가설이 확정의 근거' }
  };

  function issue(rule, message, extra) {
    return Object.assign({
      rule: rule, level: RULES[rule].level, label: RULES[rule].label, message: message
    }, extra || {});
  }

  function nodeName(id) {
    var n = store.state.nodes[id];
    return n ? n.name : id;
  }

  /* ---------- 개별 규칙 ---------- */

  function checkOrphans(out) {
    Object.keys(store.state.nodes).forEach(function (id) {
      if (store.state.nodes[id].status === 'dropped') return;   // 폐기물은 굳이 안 따진다
      if (store.edgeCount(id) === 0) {
        out.push(issue('orphan', nodeName(id) + ' 은(는) 아무것과도 연결돼 있지 않습니다.', { nodeId: id }));
      }
    });
  }

  function checkRequired(out) {
    Object.keys(store.state.nodes).forEach(function (id) {
      var miss = store.missingRequired(id);
      if (miss.length) {
        out.push(issue('required', nodeName(id) + ' — ' + miss.join(', ') + ' 미입력', { nodeId: id }));
      }
    });
  }

  /** 인과핀 그래프에서 순환을 찾는다. 색칠 DFS로 되돌아온 지점까지의 경로를 보고한다. */
  function checkCycles(out) {
    var adj = {};
    store.causalEdges().forEach(function (c) {
      (adj[c.edge.from] = adj[c.edge.from] || []).push({ to: c.edge.to, id: c.id });
    });

    var state = {};   // 0 미방문 / 1 방문중 / 2 완료
    var stack = [];
    var reported = {};

    function dfs(id) {
      state[id] = 1;
      stack.push(id);
      (adj[id] || []).forEach(function (e) {
        if (state[e.to] === 1) {
          var at = stack.indexOf(e.to);
          var path = stack.slice(at).concat([e.to]);
          var key = path.slice().sort().join('|');
          if (!reported[key]) {
            reported[key] = true;
            out.push(issue('cycle',
              path.map(nodeName).join(' → ') + ' — 원인이 돌아옵니다.',
              { nodeId: path[0], nodes: path }));
          }
        } else if (state[e.to] !== 2) {
          dfs(e.to);
        }
      });
      stack.pop();
      state[id] = 2;
    }

    Object.keys(adj).forEach(function (id) { if (!state[id]) dfs(id); });
  }

  function sortOf(id) {
    var n = store.state.nodes[id];
    if (!n) return undefined;
    var w = n.fields && n.fields.when;
    if (!w || w.precision === 'unknown') return undefined;
    return typeof w.sort === 'number' ? w.sort : undefined;
  }

  /** 결과가 원인보다 앞서면 오류 (SPEC 6장 마지막 줄). */
  function checkSortConflicts(out) {
    store.causalEdges().forEach(function (c) {
      var a = sortOf(c.edge.from), b = sortOf(c.edge.to);
      if (a === undefined || b === undefined) return;
      if (a > b) {
        out.push(issue('sortConflict',
          nodeName(c.edge.from) + ' (' + a + ') 가 원인인데 결과 ' +
          nodeName(c.edge.to) + ' (' + b + ') 보다 뒤입니다.',
          { nodeId: c.edge.from, edgeId: c.id }));
      }
    });
  }

  function checkUnplaced(out) {
    Object.keys(store.state.nodes).forEach(function (id) {
      if (store.state.nodes[id].status === 'dropped') return;
      if (store.canvasesWith(id).length === 0) {
        out.push(issue('unplaced', nodeName(id) + ' 은(는) 어떤 캔버스에도 없습니다.', { nodeId: id }));
      }
    });
  }

  /** 편집거리 ≤ 1 까지만 본다. 그 이상 느슨하게 잡으면 오탐이 목록을 덮는다. */
  function nearlySame(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    if (a.length < 3 || b.length < 3) return false;
    var i = 0, j = 0, diff = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++diff > 1) return false;
      if (a.length > b.length) i++;
      else if (b.length > a.length) j++;
      else { i++; j++; }
    }
    return diff + (a.length - i) + (b.length - j) <= 1;
  }

  function checkDuplicates(out) {
    var byType = {};
    Object.keys(store.state.nodes).forEach(function (id) {
      var n = store.state.nodes[id];
      (byType[n.type] = byType[n.type] || []).push({ id: id, norm: U.normalizeName(n.name) });
    });
    Object.keys(byType).forEach(function (t) {
      var list = byType[t];
      for (var i = 0; i < list.length; i++) {
        for (var j = i + 1; j < list.length; j++) {
          if (!list[i].norm || !list[j].norm) continue;
          if (nearlySame(list[i].norm, list[j].norm)) {
            out.push(issue('duplicate',
              nodeName(list[i].id) + ' 과(와) ' + nodeName(list[j].id) + ' 의 이름이 거의 같습니다.',
              { nodeId: list[i].id, nodes: [list[i].id, list[j].id] }));
          }
        }
      }
    });
  }

  function checkDraftBasis(out) {
    Object.keys(store.state.edges).forEach(function (eid) {
      var e = store.state.edges[eid];
      var a = store.state.nodes[e.from], b = store.state.nodes[e.to];
      if (!a || !b) return;
      if (a.status === 'draft' && b.status === 'confirmed') {
        out.push(issue('draftBasis',
          '가설 ' + a.name + ' 이(가) 확정 ' + b.name + ' 에 물려 있습니다.',
          { nodeId: e.from, edgeId: eid }));
      }
    });
  }

  /* ---------- 실행 ---------- */

  function run() {
    var out = [];
    checkCycles(out);
    checkSortConflicts(out);
    checkOrphans(out);
    checkRequired(out);
    checkUnplaced(out);
    checkDuplicates(out);
    checkDraftBasis(out);

    var order = { error: 0, warn: 1, info: 2 };
    out.sort(function (a, b) {
      return order[a.level] - order[b.level] || a.rule.localeCompare(b.rule);
    });
    return out;
  }

  function summarize(issues) {
    var s = { error: 0, warn: 0, info: 0, total: issues.length };
    issues.forEach(function (i) { s[i.level]++; });
    return s;
  }

  WM.validate = { run: run, summarize: summarize, RULES: RULES, nearlySame: nearlySame };
})(window.WM);
