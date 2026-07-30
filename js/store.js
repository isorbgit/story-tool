/* store.js — 인메모리 모델, 스키마 조회, CRUD, 자동저장.
   SPEC 2.1 3분리 원칙: 노드/엣지는 전역, 배치는 캔버스별. 캔버스는 엣지를 소유하지 않는다. */
(function (WM) {
  'use strict';
  var U = WM.util;

  var AUTOSAVE_MS = 2000;
  /* 저장할 때마다 백업을 뜨면 10개 슬롯이 편집 20초치로 채워져 무의미해진다.
     세션 첫 저장 + 이후 10분 간격 + 가져오기 직전으로 제한한다. */
  var BACKUP_INTERVAL_MS = 10 * 60 * 1000;

  var listeners = {};

  var S = {
    adapter: null,
    schema: null,
    nodes: {},
    edges: {},
    canvases: {},
    dirty: {},          // { 'nodes.json': true }
    saving: false,
    lastSavedAt: null,
    lastBackupAt: 0,
    saveError: null,
    edgeSeq: 0
  };

  /* ---------- 이벤트 ---------- */

  function on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); }
  function emit(name, payload) {
    (listeners[name] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error('[wm] listener', name, e); }
    });
  }

  /* ---------- 직렬화 ----------
     git diff 가독성이 파일을 4개로 나눈 이유이므로(SPEC 3장), 키 순서를 항상 정렬해
     같은 데이터가 항상 같은 바이트로 나오게 한다. */

  function sortedReplacer(_key, value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce(function (acc, k) { acc[k] = value[k]; return acc; }, {});
    }
    return value;
  }

  function stringify(obj) { return JSON.stringify(obj, sortedReplacer, 2) + '\n'; }

  function fileContents(which) {
    var map = {
      'schema.json': function () { return stringify(S.schema); },
      'nodes.json': function () { return stringify(S.nodes); },
      'edges.json': function () { return stringify(S.edges); },
      'canvases.json': function () { return stringify(S.canvases); }
    };
    if (which) return map[which]();
    return Object.keys(map).reduce(function (acc, k) { acc[k] = map[k](); return acc; }, {});
  }

  /* ---------- 스키마 조회 ---------- */

  function typeKeys() { return Object.keys(S.schema.types); }
  function typeDef(t) { return S.schema.types[t] || null; }
  function typeLabel(t) { var d = typeDef(t); return d ? d.label : t; }
  function typeColor(t) { var d = typeDef(t); return d ? d.color : '#888'; }

  function socketDef(type, key) {
    var d = typeDef(type);
    if (!d) return null;
    for (var i = 0; i < d.sockets.length; i++) if (d.sockets[i].key === key) return d.sockets[i];
    return null;
  }

  function fieldDef(type, key) {
    var d = typeDef(type);
    if (!d) return null;
    for (var i = 0; i < d.fields.length; i++) if (d.fields[i].key === key) return d.fields[i];
    return null;
  }

  function presetDef(name) {
    return (S.schema.labelPresets && S.schema.labelPresets[name]) ||
      S.schema.labelPresets.generic || { free: true, options: [], extraFields: [] };
  }

  function flagDef(name) { return S.schema.flags[name]; }
  function flagLabel(name, value) {
    var f = flagDef(name);
    if (!f) return value;
    for (var i = 0; i < f.values.length; i++) if (f.values[i].key === value) return f.values[i].label;
    return value;
  }

  /**
   * 반대편 소켓 찾기. reciprocal 은 'character.items' 처럼 특정 타입으로 적혀 있지만
   * accepts 가 여러 타입이면(예: item.owners ← character | organization) 그대로 못 쓴다.
   * 키만 떼어 대상 타입에서 같은 키를 찾고, 없으면 역참조/수용타입 순으로 넓혀 찾는다.
   */
  function counterSocket(fromType, fromSocketKey, toType) {
    var sock = socketDef(fromType, fromSocketKey);
    var target = typeDef(toType);
    if (!sock || !target) return null;

    function accepts(s) { return s.accepts.indexOf(fromType) >= 0; }

    if (sock.reciprocal) {
      var key = String(sock.reciprocal).split('.')[1];
      var byKey = socketDef(toType, key);
      if (byKey && accepts(byKey)) return byKey;
    }
    var back = fromType + '.' + fromSocketKey;
    for (var i = 0; i < target.sockets.length; i++) {
      if (target.sockets[i].reciprocal === back && accepts(target.sockets[i])) return target.sockets[i];
    }
    for (var j = 0; j < target.sockets.length; j++) {
      if (accepts(target.sockets[j]) && target.sockets[j].dir !== sock.dir) return target.sockets[j];
    }
    for (var k = 0; k < target.sockets.length; k++) {
      if (accepts(target.sockets[k])) return target.sockets[k];
    }
    return null;
  }

  /* ---------- ID ---------- */

  function makeNodeId(type, slug) {
    var prefix = (typeDef(type) || {}).idPrefix || (type.slice(0, 3) + '_');
    var base = U.slugify(slug);
    if (!base) return null;
    var id = prefix + base;
    if (!S.nodes[id]) return id;
    var n = 2;
    while (S.nodes[prefix + base + '_' + n]) n++;
    return prefix + base + '_' + n;
  }

  function nextEdgeId() {
    do { S.edgeSeq++; } while (S.edges['e_' + String(S.edgeSeq).padStart(4, '0')]);
    return 'e_' + String(S.edgeSeq).padStart(4, '0');
  }

  function recomputeEdgeSeq() {
    var max = 0;
    Object.keys(S.edges).forEach(function (id) {
      var m = /^e_(\d+)$/.exec(id);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    S.edgeSeq = max;
  }

  /* ---------- 엣지 조회 ----------
     역방향은 저장하지 않는다(SPEC 3.2). 조회 시 양방향으로 훑는다. */

  var edgeIndex = null;   // { nodeId: [edgeId] }

  function buildIndex() {
    edgeIndex = {};
    Object.keys(S.edges).forEach(function (eid) {
      var e = S.edges[eid];
      (edgeIndex[e.from] = edgeIndex[e.from] || []).push(eid);
      if (e.to !== e.from) (edgeIndex[e.to] = edgeIndex[e.to] || []).push(eid);
    });
  }

  function edgesOf(nodeId) {
    if (!edgeIndex) buildIndex();
    return (edgeIndex[nodeId] || []).map(function (id) { return S.edges[id]; }).filter(Boolean);
  }

  /** 이 노드의 특정 소켓에 꽂힌 연결들. { edgeId, edge, otherId, other, outgoing } */
  function connectionsOf(nodeId, socketKey) {
    if (!edgeIndex) buildIndex();
    var out = [];
    (edgeIndex[nodeId] || []).forEach(function (eid) {
      var e = S.edges[eid];
      if (!e) return;
      if (e.from === nodeId && e.fromSocket === socketKey) {
        out.push({ id: eid, edge: e, otherId: e.to, other: S.nodes[e.to], outgoing: true });
      } else if (e.to === nodeId && e.toSocket === socketKey) {
        out.push({ id: eid, edge: e, otherId: e.from, other: S.nodes[e.from], outgoing: false });
      }
    });
    return out;
  }

  function edgeCount(nodeId) { return edgesOf(nodeId).length; }

  /* ---------- 노드 CRUD ---------- */

  function defaultFlags() {
    return {
      status: S.schema.flags.status.default,
      reveal: S.schema.flags.reveal.default,
      impl: S.schema.flags.impl.default
    };
  }

  function createNode(type, slug, name) {
    if (!typeDef(type)) throw new Error('알 수 없는 타입: ' + type);
    var id = makeNodeId(type, slug);
    if (!id) throw new Error('ID로 쓸 영문 slug가 필요합니다.');
    var dup = id !== (typeDef(type).idPrefix + U.slugify(slug));
    var now = U.nowIso();
    var f = defaultFlags();
    S.nodes[id] = {
      type: type,
      name: name || slug,
      gameKey: '',
      tags: [],
      status: f.status,
      reveal: f.reveal,
      impl: f.impl,
      fields: {},
      created: now,
      updated: now
    };
    edgeIndex = null;
    markDirty('nodes.json');
    emit('nodes');
    return { id: id, deduped: dup };
  }

  function updateNode(id, patch) {
    var n = S.nodes[id];
    if (!n) return null;
    Object.keys(patch).forEach(function (k) {
      if (k === 'fields') Object.assign(n.fields, patch.fields);
      else n[k] = patch[k];
    });
    n.updated = U.nowIso();
    markDirty('nodes.json');
    emit('nodes');
    return n;
  }

  function setField(id, key, value) {
    var n = S.nodes[id];
    if (!n) return;
    if (value === '' || value === null || value === undefined) delete n.fields[key];
    else n.fields[key] = value;
    n.updated = U.nowIso();
    markDirty('nodes.json');
    emit('nodes');
  }

  /** 전역 삭제 전 영향 범위 (SPEC 4.2) */
  function impactOf(id) {
    var edges = edgesOf(id);
    var canvasIds = Object.keys(S.canvases).filter(function (cid) {
      return S.canvases[cid].placements && S.canvases[cid].placements[id];
    });
    return { edges: edges, edgeCount: edges.length, canvases: canvasIds, canvasCount: canvasIds.length };
  }

  function deleteNode(id) {
    if (!S.nodes[id]) return null;
    var impact = impactOf(id);
    impact.edges.forEach(function (e) {
      Object.keys(S.edges).forEach(function (eid) { if (S.edges[eid] === e) delete S.edges[eid]; });
    });
    impact.canvases.forEach(function (cid) { delete S.canvases[cid].placements[id]; });
    delete S.nodes[id];
    edgeIndex = null;
    markDirty('nodes.json'); markDirty('edges.json');
    if (impact.canvasCount) markDirty('canvases.json');
    emit('nodes'); emit('edges');
    return impact;
  }

  /* ---------- 엣지 CRUD ---------- */

  /** 이 노드의 소켓에서 대상 노드로 연결. 방향은 소켓의 dir 이 정한다. */
  function connect(nodeId, socketKey, targetId) {
    var node = S.nodes[nodeId], target = S.nodes[targetId];
    if (!node || !target) throw new Error('노드를 찾을 수 없습니다.');
    var sock = socketDef(node.type, socketKey);
    if (!sock) throw new Error('알 수 없는 소켓: ' + socketKey);
    if (sock.accepts.indexOf(target.type) < 0) {
      throw new Error('「' + sock.label + '」 소켓은 ' +
        sock.accepts.map(typeLabel).join(', ') + ' 만 받습니다. (' + typeLabel(target.type) + ' 시도)');
    }
    var counter = counterSocket(node.type, socketKey, target.type);
    if (!counter) throw new Error('대상 타입에 대응하는 소켓이 없습니다.');

    var outgoing = sock.dir !== 'in';
    var from = outgoing ? nodeId : targetId;
    var fromSocket = outgoing ? socketKey : counter.key;
    var to = outgoing ? targetId : nodeId;
    var toSocket = outgoing ? counter.key : socketKey;

    var existing = null;
    Object.keys(S.edges).forEach(function (eid) {
      var e = S.edges[eid];
      if (e.from === from && e.to === to && e.fromSocket === fromSocket && e.toSocket === toSocket) existing = eid;
      // 무방향 소켓은 반대로 저장된 것도 같은 연결로 본다.
      if (sock.undirected && e.from === to && e.to === from &&
        e.fromSocket === toSocket && e.toSocket === fromSocket) existing = eid;
    });
    if (existing) return { id: existing, existed: true };

    if (!sock.multi && connectionsOf(nodeId, socketKey).length > 0) {
      throw new Error('「' + sock.label + '」 소켓은 하나만 연결할 수 있습니다.');
    }

    var preset = presetDef(sock.labelPreset);
    var now = U.nowIso();
    var id = nextEdgeId();
    S.edges[id] = {
      from: from, fromSocket: fromSocket,
      to: to, toSocket: toSocket,
      label: preset.free ? '' : (preset.options[0] || ''),
      note: '',
      status: S.schema.flags.status.default,
      fields: {},
      created: now, updated: now
    };
    edgeIndex = null;
    markDirty('edges.json');
    emit('edges');
    return { id: id, existed: false };
  }

  function updateEdge(id, patch) {
    var e = S.edges[id];
    if (!e) return null;
    Object.keys(patch).forEach(function (k) {
      if (k === 'fields') Object.assign(e.fields, patch.fields);
      else e[k] = patch[k];
    });
    e.updated = U.nowIso();
    markDirty('edges.json');
    emit('edges');
    return e;
  }

  function disconnect(edgeId) {
    if (!S.edges[edgeId]) return false;
    delete S.edges[edgeId];
    edgeIndex = null;
    markDirty('edges.json');
    emit('edges');
    return true;
  }

  /* ---------- 캔버스 ----------
     캔버스는 배치만 갖는다. 엣지를 소유하지 않는다(SPEC 2.1).
     선은 "양쪽 노드가 모두 이 캔버스에 배치돼 있으면" 그린다. */

  function canvasList() {
    return Object.keys(S.canvases).map(function (id) {
      return { id: id, canvas: S.canvases[id] };
    }).sort(function (a, b) {
      return (a.canvas.order || 0) - (b.canvas.order || 0) ||
        a.canvas.name.localeCompare(b.canvas.name, 'ko');
    });
  }

  function createCanvas(name, slug) {
    var base = U.slugify(slug || name) || 'canvas';
    var id = 'cv_' + base;
    var n = 2;
    while (S.canvases[id]) { id = 'cv_' + base + '_' + n; n++; }
    var maxOrder = 0;
    Object.keys(S.canvases).forEach(function (c) { maxOrder = Math.max(maxOrder, S.canvases[c].order || 0); });
    S.canvases[id] = { name: name || base, order: maxOrder + 1, placements: {}, comments: [] };
    markDirty('canvases.json');
    emit('canvases');
    return id;
  }

  function updateCanvas(id, patch) {
    var c = S.canvases[id];
    if (!c) return null;
    Object.assign(c, patch);
    markDirty('canvases.json');
    emit('canvases');
    return c;
  }

  function deleteCanvas(id) {
    if (!S.canvases[id]) return false;
    delete S.canvases[id];
    markDirty('canvases.json');
    emit('canvases');
    return true;
  }

  function placements(cid) { return (S.canvases[cid] || {}).placements || {}; }
  function isPlaced(cid, nodeId) { return !!placements(cid)[nodeId]; }

  function place(cid, nodeId, x, y) {
    var c = S.canvases[cid];
    if (!c || !S.nodes[nodeId]) return null;
    c.placements = c.placements || {};
    if (!c.placements[nodeId]) c.placements[nodeId] = { x: Math.round(x), y: Math.round(y), collapsed: false };
    markDirty('canvases.json');
    emit('canvases');
    return c.placements[nodeId];
  }

  /** Delete 키는 배치만 지운다. 노드·엣지는 DB에 그대로 남는다(SPEC 4.2). */
  function unplace(cid, nodeId) {
    var c = S.canvases[cid];
    if (!c || !c.placements || !c.placements[nodeId]) return false;
    delete c.placements[nodeId];
    markDirty('canvases.json');
    emit('canvases');
    return true;
  }

  /** 드래그 중에는 좌표만 갱신하고, 손을 뗄 때 commit=true 로 한 번만 저장한다. */
  function moveNodes(cid, moves, commit) {
    var c = S.canvases[cid];
    if (!c) return;
    moves.forEach(function (m) {
      var p = c.placements[m.id];
      if (p) { p.x = Math.round(m.x); p.y = Math.round(m.y); }
    });
    if (commit) markDirty('canvases.json');
  }

  function setCollapsed(cid, nodeId, val) {
    var p = placements(cid)[nodeId];
    if (!p) return;
    p.collapsed = val === undefined ? !p.collapsed : !!val;
    markDirty('canvases.json');
    emit('canvases');
  }

  /** 양 끝이 모두 배치돼 있는 엣지만. 포커스 뷰는 저장되지 않는 임시 배치를 넘긴다. */
  function edgesForPlacements(pl) {
    return Object.keys(S.edges).filter(function (eid) {
      var e = S.edges[eid];
      return pl[e.from] && pl[e.to];
    }).map(function (eid) { return { id: eid, edge: S.edges[eid] }; });
  }

  function edgesForCanvas(cid) { return edgesForPlacements(placements(cid)); }

  /** 고스트 핀(SPEC 4.1) — 이 소켓의 연결 중 상대가 여기 없는 것들. */
  function ghostsForPlacements(pl, nodeId, socketKey) {
    return connectionsOf(nodeId, socketKey).filter(function (c) { return !pl[c.otherId]; });
  }

  function ghostsOf(cid, nodeId, socketKey) {
    return ghostsForPlacements(placements(cid), nodeId, socketKey);
  }

  /* ---------- 그래프 탐색 ---------- */

  /** 인과핀으로 이어진 방향 그래프. 순환 검사와 타임라인 정합성 검사에 쓴다. */
  function causalEdges() {
    return Object.keys(S.edges).map(function (eid) {
      var e = S.edges[eid];
      var n = S.nodes[e.from];
      if (!n) return null;
      var sock = socketDef(n.type, e.fromSocket);
      return (sock && sock.pin === 'causal') ? { id: eid, edge: e } : null;
    }).filter(Boolean);
  }

  /** N단계 이웃 (SPEC 9장 포커스 뷰). → { id: depth } */
  function neighborhood(nodeId, depth) {
    var seen = {};
    if (!S.nodes[nodeId]) return seen;
    seen[nodeId] = 0;
    var frontier = [nodeId];
    for (var d = 1; d <= depth; d++) {
      var next = [];
      frontier.forEach(function (id) {
        edgesOf(id).forEach(function (e) {
          var other = e.from === id ? e.to : e.from;
          if (seen[other] === undefined && S.nodes[other]) { seen[other] = d; next.push(other); }
        });
      });
      frontier = next;
      if (!frontier.length) break;
    }
    return seen;
  }

  /** 그 노드가 배치돼 있는 캔버스 목록 — 고스트 팝오버의 "점프" 대상. */
  function canvasesWith(nodeId) {
    return Object.keys(S.canvases).filter(function (cid) {
      return isPlaced(cid, nodeId);
    });
  }

  /* ---------- 코멘트 박스 ---------- */

  function addComment(cid, box) {
    var c = S.canvases[cid];
    if (!c) return -1;
    c.comments = c.comments || [];
    c.comments.push(Object.assign({ x: 0, y: 0, w: 320, h: 200, text: '', color: '#3a4a5c' }, box));
    markDirty('canvases.json');
    emit('canvases');
    return c.comments.length - 1;
  }

  function updateComment(cid, index, patch, commit) {
    var c = S.canvases[cid];
    if (!c || !c.comments || !c.comments[index]) return;
    Object.assign(c.comments[index], patch);
    if (commit !== false) { markDirty('canvases.json'); emit('canvases'); }
  }

  function deleteComment(cid, index) {
    var c = S.canvases[cid];
    if (!c || !c.comments) return;
    c.comments.splice(index, 1);
    markDirty('canvases.json');
    emit('canvases');
  }

  /* ---------- 조회 ---------- */

  function nodesOfType(type) {
    return Object.keys(S.nodes)
      .filter(function (id) { return S.nodes[id].type === type; })
      .map(function (id) { return { id: id, node: S.nodes[id] }; });
  }

  function countsByType() {
    var out = {};
    typeKeys().forEach(function (t) { out[t] = 0; });
    Object.keys(S.nodes).forEach(function (id) {
      var t = S.nodes[id].type;
      out[t] = (out[t] || 0) + 1;
    });
    return out;
  }

  /** 필수 필드 미입력 목록. 표 뷰의 경고 점에 쓴다. */
  function missingRequired(id) {
    var n = S.nodes[id];
    if (!n) return [];
    var d = typeDef(n.type);
    if (!d) return [];
    return d.fields.filter(function (f) {
      if (!f.required) return false;
      var v = n.fields[f.key];
      if (f.widget === 'when') return !(v && (v.display || v.sort !== undefined));
      return v === undefined || v === null || String(v).trim() === '';
    }).map(function (f) { return f.label; });
  }

  /** 타입 필터 + 텍스트 검색. 연결 대상 고르기에도 쓴다. */
  function search(query, acceptTypes, limit) {
    var q = String(query || '').trim();
    var res = [];
    Object.keys(S.nodes).forEach(function (id) {
      var n = S.nodes[id];
      if (acceptTypes && acceptTypes.indexOf(n.type) < 0) return;
      if (WM.app && WM.app.hidden && WM.app.hidden(id)) return;    // 안전 모드
      var s = Math.max(U.matchScore(n.name, q), U.matchScore(id, q),
        U.matchScore(n.fields && n.fields.alias, q));
      (n.tags || []).forEach(function (t) { s = Math.max(s, U.matchScore(t, q) - 1); });
      if (!s) return;
      res.push({ id: id, node: n, score: s });
    });
    res.sort(function (a, b) { return b.score - a.score || a.node.name.localeCompare(b.node.name); });
    return limit ? res.slice(0, limit) : res;
  }

  /* ---------- 저장 ---------- */

  function markDirty(file) {
    S.dirty[file] = true;
    S.saveError = null;
    emit('dirty');
    autosave();
  }

  var autosave = U.debounce(function () { save(); }, AUTOSAVE_MS);

  var inFlight = null;

  function save(force) {
    if (!S.adapter || !S.adapter.isConnected()) return Promise.resolve(false);

    /* 저장이 이미 돌고 있으면 그냥 반환해선 안 된다.
       진행 중인 저장은 시작 시점의 스냅샷을 쓰고 있으므로, 그 뒤에 들어온 편집은
       이 호출이 포기하는 순간 사라진다. 탭을 닫을 때 부르는 flush() 가 특히 위험하다.
       끝나기를 기다렸다가 한 번 더 돌린다. */
    if (S.saving && inFlight) {
      S.saveAgain = true;
      return inFlight.then(function () {
        if (!S.saveAgain) return false;
        S.saveAgain = false;
        return save(force);
      });
    }

    var files = force ? WM.storage.DATA_FILES.slice() : Object.keys(S.dirty);
    if (!files.length) return Promise.resolve(false);

    /* dirty 는 "아직 쓰기용으로 뜨지 않은 변경이 있다" 는 뜻이다.
       내용을 뜨는 순간 비워야, 쓰는 도중에 들어온 편집이 자기 몫의 dirty 를 다시 세우고
       뒤따르는 저장에서 잡힌다. 다 쓰고 나서 비우면 그 편집이 통째로 지워진다. */
    var payload = {};
    files.forEach(function (f) { payload[f] = fileContents(f); delete S.dirty[f]; });

    S.saving = true;
    S.saveAgain = false;
    emit('dirty');

    inFlight = maybeBackup()
      .then(function () { return S.adapter.writeFiles(payload); })
      .then(function () {
        S.lastSavedAt = new Date();
        S.saveError = null;
      })
      .catch(function (e) {
        console.error('[wm] 저장 실패', e);
        S.saveError = e && e.message ? e.message : String(e);
        files.forEach(function (f) { S.dirty[f] = true; });   // 실패했으니 되돌려 다시 시도하게 한다
      })
      .then(function () {
        S.saving = false;
        emit('dirty');
        return true;
      });

    return inFlight;
  }

  function maybeBackup(forceNow) {
    if (!S.adapter || !S.adapter.rotateBackups) return Promise.resolve();
    var now = Date.now();
    if (!forceNow && S.lastBackupAt && now - S.lastBackupAt < BACKUP_INTERVAL_MS) return Promise.resolve();
    S.lastBackupAt = now;
    var snapshot = fileContents();
    return S.adapter.writeBackup(U.stamp(), snapshot)
      .then(function () { return S.adapter.rotateBackups(); })
      .catch(function (e) { console.warn('[wm] 백업 실패', e); });
  }

  function flush() {
    autosave.cancel();
    return save();
  }

  function isDirty() { return Object.keys(S.dirty).length > 0; }

  /* ---------- 부팅 ---------- */

  function load(adapter, data) {
    S.adapter = adapter;
    S.schema = (data && data.schema) || WM.DEFAULT_SCHEMA;
    S.nodes = (data && data.nodes) || {};
    S.edges = (data && data.edges) || {};
    S.canvases = (data && data.canvases) || {};
    edgeIndex = null;
    S.dirty = {};
    S.lastBackupAt = 0;
    recomputeEdgeSeq();
    normalize();
    emit('loaded');
  }

  /** 스키마 교체. 타입 탭·패널·노드 렌더링이 전부 스키마를 읽으므로 통째로 다시 그려야 한다.
      노드/엣지 데이터는 건드리지 않는다 — 사라진 필드의 값도 남겨 둔다.
      되돌리고 싶을 때 값이 이미 지워져 있으면 방법이 없기 때문이다. */
  function setSchema(sc) {
    S.schema = sc;
    edgeIndex = null;
    normalize();
    markDirty('schema.json');
    emit('schema');
  }

  /** 손으로 편집한 JSON이나 예전 번들이 들어와도 UI가 터지지 않게 최소 형태를 보정한다. */
  function normalize() {
    Object.keys(S.nodes).forEach(function (id) {
      var n = S.nodes[id];
      if (!n.fields || typeof n.fields !== 'object') n.fields = {};
      if (!Array.isArray(n.tags)) n.tags = [];
      if (typeof n.gameKey !== 'string') n.gameKey = '';
      var f = defaultFlags();
      if (!n.status) n.status = f.status;
      if (!n.reveal) n.reveal = f.reveal;
      if (!n.impl) n.impl = f.impl;
      if (!n.created) n.created = U.nowIso();
      if (!n.updated) n.updated = n.created;
    });
    Object.keys(S.edges).forEach(function (id) {
      var e = S.edges[id];
      if (!e.fields || typeof e.fields !== 'object') e.fields = {};
      if (typeof e.label !== 'string') e.label = '';
      if (typeof e.note !== 'string') e.note = '';
      if (!e.status) e.status = S.schema.flags.status.default;
      if (!e.created) e.created = U.nowIso();
      if (!e.updated) e.updated = e.created;
      // 끊어진 참조는 조용히 버린다. 두면 인덱스와 UI 전반에서 계속 터진다.
      if (!S.nodes[e.from] || !S.nodes[e.to]) {
        console.warn('[wm] 참조가 끊긴 엣지 제거:', id, e.from, '→', e.to);
        delete S.edges[id];
      }
    });
  }

  WM.store = {
    state: S,
    on: on, emit: emit,
    load: load, normalize: normalize, setSchema: setSchema,
    fileContents: fileContents, stringify: stringify,

    typeKeys: typeKeys, typeDef: typeDef, typeLabel: typeLabel, typeColor: typeColor,
    socketDef: socketDef, fieldDef: fieldDef, presetDef: presetDef,
    flagDef: flagDef, flagLabel: flagLabel, counterSocket: counterSocket,

    makeNodeId: makeNodeId,
    createNode: createNode, updateNode: updateNode, setField: setField,
    impactOf: impactOf, deleteNode: deleteNode,
    connect: connect, updateEdge: updateEdge, disconnect: disconnect,

    edgesOf: edgesOf, connectionsOf: connectionsOf, edgeCount: edgeCount,
    nodesOfType: nodesOfType, countsByType: countsByType,

    canvasList: canvasList, createCanvas: createCanvas, updateCanvas: updateCanvas,
    deleteCanvas: deleteCanvas, placements: placements, isPlaced: isPlaced,
    place: place, unplace: unplace, moveNodes: moveNodes, setCollapsed: setCollapsed,
    edgesForCanvas: edgesForCanvas, edgesForPlacements: edgesForPlacements,
    ghostsOf: ghostsOf, ghostsForPlacements: ghostsForPlacements,
    canvasesWith: canvasesWith, causalEdges: causalEdges, neighborhood: neighborhood,
    addComment: addComment, updateComment: updateComment, deleteComment: deleteComment,

    missingRequired: missingRequired, search: search,

    save: save, flush: flush, isDirty: isDirty, maybeBackup: maybeBackup
  };
})(window.WM);
