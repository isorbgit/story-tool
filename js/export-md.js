/* export-md.js — 마크다운 문서 일괄 내보내기 (SPEC Phase 4).

   노드 하나당 문서 하나. 연결은 상대 문서로 가는 상대경로 링크로 건다.
   그래야 Obsidian 이나 GitHub 에서 그대로 걸어다닐 수 있고, 이 툴 없이도 읽힌다.

   출력 위치는 저장 방식에 따라 갈린다.
     폴더 저장(FSA) → 폴더 안 export/markdown/ 에 직접 쓴다. git 으로 볼 수 있다
     그 외(OPFS 등)  → 폴더가 안 보이므로 ZIP 으로 내려받는다 */
(function (WM) {
  'use strict';
  var U = WM.util, store = WM.store;

  var ROOT = 'export/markdown';

  /* ---------- 마크다운 조각 ---------- */

  function yamlStr(s) {
    return '"' + String(s === undefined || s === null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  /** 표기용 문자열에 들어간 마크다운 특수문자를 죽인다. 이름에 *나 [ 가 있으면 링크가 깨진다. */
  function inline(s) {
    return String(s === undefined || s === null ? '' : s).replace(/([\\`*_\[\]<>])/g, '\\$1').replace(/\r?\n/g, ' ');
  }

  function isEmpty(v) {
    if (v === undefined || v === null) return true;
    if (typeof v === 'object') return !(v.display || v.sort !== undefined);
    return String(v).trim() === '';
  }

  function whenText(v) {
    if (!v) return '';
    var parts = [];
    if (v.display) parts.push(inline(v.display));
    var meta = [];
    // 원형 그대로 두면 981.2010050251256 처럼 찍힌다. 문서에 실릴 값이라 자른다.
    if (typeof v.sort === 'number') meta.push('sort ' + (Math.round(v.sort * 10000) / 10000));
    if (v.precision) {
      var p = (store.state.schema.whenPrecision || []).filter(function (x) { return x.key === v.precision; })[0];
      meta.push(p ? p.label : v.precision);
    }
    if (meta.length) parts.push('<sub>' + meta.join(' · ') + '</sub>');
    return parts.join(' ');
  }

  /* ---------- 노드 문서 ---------- */

  function nodePath(id) {
    var n = store.state.nodes[id];
    return n.type + '/' + id + '.md';
  }

  /** character/chr_a.md 에서 organization/org_b.md 로 가는 상대경로. 타입 폴더가 한 겹이라 ../ 하나면 된다. */
  function relLink(fromId, toId) {
    return '../' + nodePath(toId);
  }

  function renderNode(id, opts, included) {
    var S = store.state, n = S.nodes[id];
    var def = store.typeDef(n.type) || { label: n.type, sockets: [], fields: [] };
    var L = [];

    L.push('---');
    L.push('id: ' + yamlStr(id));
    L.push('type: ' + yamlStr(n.type));
    L.push('name: ' + yamlStr(n.name));
    if (n.gameKey) L.push('gameKey: ' + yamlStr(n.gameKey));
    L.push('status: ' + yamlStr(n.status));
    L.push('reveal: ' + yamlStr(n.reveal));
    L.push('impl: ' + yamlStr(n.impl));
    L.push('tags: [' + (n.tags || []).map(yamlStr).join(', ') + ']');
    L.push('created: ' + yamlStr(n.created));
    L.push('updated: ' + yamlStr(n.updated));
    L.push('---');
    L.push('');
    L.push('# ' + inline(n.name));
    L.push('');
    L.push('`' + id + '` · ' + inline(def.label) + ' · ' +
           store.flagLabel('status', n.status) + ' · ' +
           store.flagLabel('reveal', n.reveal) + ' · ' +
           store.flagLabel('impl', n.impl));

    /* 필드 */
    var fieldLines = [];
    (def.fields || []).forEach(function (f) {
      if (opts.excludeSpoiler && f.reveal === 'spoiler') return;
      var v = n.fields ? n.fields[f.key] : undefined;
      if (isEmpty(v)) return;
      if (f.widget === 'when') {
        fieldLines.push('**' + inline(f.label) + '** ' + whenText(v));
      } else if (f.widget === 'markdown') {
        fieldLines.push('**' + inline(f.label) + '**');
        fieldLines.push('');
        fieldLines.push(String(v).trim());          // 본문은 마크다운 그대로 통과시킨다
      } else {
        fieldLines.push('**' + inline(f.label) + '** ' + inline(v));
      }
      fieldLines.push('');
    });
    if (fieldLines.length) {
      L.push('');
      L.push('## 필드');
      L.push('');
      L.push.apply(L, fieldLines);
    }

    /* 연결 */
    var linkLines = [];
    (def.sockets || []).forEach(function (s) {
      var conns = store.connectionsOf(id, s.key).filter(function (c) {
        return c.other && included[c.otherId];
      });
      if (!conns.length) return;
      linkLines.push('### ' + inline(s.label || s.key));
      conns.forEach(function (c) {
        var e = c.edge;
        var bits = ['- [' + inline(c.other.name) + '](' + relLink(id, c.otherId) + ')'];
        if (e.label) bits.push('— ' + inline(e.label));
        var extra = [];
        Object.keys(e.fields || {}).forEach(function (k) {
          if (isEmpty(e.fields[k])) return;
          var preset = store.presetDef(s.labelPreset);
          var fd = (preset.extraFields || []).filter(function (x) { return x.key === k; })[0];
          extra.push((fd ? fd.label : k) + ': ' + inline(e.fields[k]));
        });
        if (e.note) extra.push(inline(e.note));
        if (extra.length) bits.push('*(' + extra.join(' · ') + ')*');
        linkLines.push(bits.join(' '));
      });
      linkLines.push('');
    });
    if (linkLines.length) {
      L.push('## 연결');
      L.push('');
      L.push.apply(L, linkLines);
    }

    /* 등장 캔버스 */
    if (opts.includeCanvases) {
      var cvs = store.canvasesWith(id);
      if (cvs.length) {
        L.push('## 등장 캔버스');
        L.push('');
        cvs.forEach(function (cid) {
          L.push('- ' + inline((S.canvases[cid] || {}).name || cid));
        });
        L.push('');
      }
    }

    return L.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  }

  /* ---------- 목차 ---------- */

  function renderIndex(ids, opts, skipped) {
    var S = store.state;
    var L = ['# 가면을 벗다 — 세계관 맵', ''];
    L.push('내보낸 시각: ' + new Date().toLocaleString('ko-KR'));

    var edgeCount = Object.keys(S.edges).filter(function (eid) {
      var e = S.edges[eid];
      return ids.indexOf(e.from) >= 0 && ids.indexOf(e.to) >= 0;
    }).length;
    L.push('');
    L.push('노드 ' + ids.length + ' · 연결 ' + edgeCount);
    if (skipped.spoiler) L.push('');
    if (skipped.spoiler) L.push('> 미공개(spoiler) 항목 ' + skipped.spoiler + '개를 뺐습니다.');
    if (skipped.dropped) L.push('> 폐기(dropped) 항목 ' + skipped.dropped + '개를 뺐습니다.');
    L.push('');

    store.typeKeys().forEach(function (t) {
      var mine = ids.filter(function (id) { return S.nodes[id].type === t; });
      if (!mine.length) return;
      var def = store.typeDef(t);
      L.push('## ' + inline(def.label) + ' (' + mine.length + ')');
      L.push('');
      mine.sort(function (a, b) { return S.nodes[a].name.localeCompare(S.nodes[b].name, 'ko'); });
      mine.forEach(function (id) {
        var n = S.nodes[id];
        var card = (def.cardFields || []).map(function (k) {
          var v = n.fields && n.fields[k];
          if (isEmpty(v)) return null;
          return typeof v === 'object' ? (v.display || '') : String(v).split('\n')[0].slice(0, 60);
        }).filter(Boolean).join(' · ');
        L.push('- [' + inline(n.name) + '](' + nodePath(id) + ')' + (card ? ' — ' + inline(card) : ''));
      });
      L.push('');
    });

    return L.join('\n') + '\n';
  }

  /* ---------- 파일 묶음 만들기 ---------- */

  function buildFiles(opts) {
    var S = store.state;
    var skipped = { spoiler: 0, dropped: 0 };

    var ids = Object.keys(S.nodes).filter(function (id) {
      var n = S.nodes[id];
      if (opts.excludeSpoiler && n.reveal === 'spoiler') { skipped.spoiler++; return false; }
      if (opts.excludeDropped && n.status === 'dropped') { skipped.dropped++; return false; }
      return true;
    });

    var included = {};
    ids.forEach(function (id) { included[id] = true; });

    var files = {};
    files['index.md'] = renderIndex(ids, opts, skipped);
    ids.forEach(function (id) { files[nodePath(id)] = renderNode(id, opts, included); });
    return { files: files, count: ids.length, skipped: skipped };
  }

  /* ---------- ZIP (무압축 STORE) ----------
     외부 라이브러리를 쓸 수 없으므로(빌드 도구 없음) 직접 쓴다.
     문서는 텍스트라 압축이 아쉽지만, 의존성 하나 없이 도는 편이 낫다. */

  var crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c >>> 0;
      }
    }
    var r = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) r = crcTable[(r ^ bytes[i]) & 0xFF] ^ (r >>> 8);
    return (r ^ 0xFFFFFFFF) >>> 0;
  }

  function dosTime(d) { return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF; }
  function dosDate(d) { return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF; }

  function zip(files) {
    var enc = new TextEncoder();
    var now = new Date(), t = dosTime(now), d = dosDate(now);
    var local = [], central = [], offset = 0;

    Object.keys(files).forEach(function (path) {
      var name = enc.encode(path);
      var data = enc.encode(files[path]);
      var crc = crc32(data);

      var lh = new Uint8Array(30 + name.length);
      var lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);      // 파일명 UTF-8
      lv.setUint16(8, 0, true);           // 무압축
      lv.setUint16(10, t, true);
      lv.setUint16(12, d, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lh.set(name, 30);
      local.push(lh, data);

      var ch = new Uint8Array(46 + name.length);
      var cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, t, true);
      cv.setUint16(14, d, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      ch.set(name, 46);
      central.push(ch);

      offset += lh.length + data.length;
    });

    var centralSize = central.reduce(function (a, c) { return a + c.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    return new Blob(local.concat(central, [eocd]), { type: 'application/zip' });
  }

  /* ---------- 출력 ---------- */

  function toFolder(built) {
    var a = store.state.adapter;
    var prefixed = {};
    Object.keys(built.files).forEach(function (p) { prefixed[ROOT + '/' + p] = built.files[p]; });
    // 먼저 지우는 이유: 안 지우면 삭제된 노드의 문서가 계속 남는다.
    return a.removePath(ROOT).then(function () { return a.writeTree(prefixed); });
  }

  function toZip(built) {
    U.download('worldmap-md-' + U.stamp() + '.zip', zip(built.files));
    return Promise.resolve();
  }

  /* ---------- 화면 ---------- */

  function dialog() {
    var el = U.el;
    var a = store.state.adapter;
    var canFolder = !!(a && a.isUserVisible && a.writeTree);

    function cb(label, checked, hint) {
      var input = el('input', { type: 'checkbox', checked: checked });
      var row = el('label.sc-link', {}, [input, el('span', {}, [
        label, hint ? el('span.dim.small', { text: '  ' + hint }) : null
      ])]);
      row.input = input;
      return row;
    }

    var safe = WM.app && WM.app.safeMode && WM.app.safeMode();
    var cSpoiler = cb('미공개(spoiler) 항목 제외', !!safe, '공유용 문서를 만들 때');
    var cDropped = cb('폐기(dropped) 항목 제외', true);
    var cCanvas = cb('등장 캔버스 목록 포함', true);

    var count = el('p.dim.small.md-count');
    function refresh() {
      var b = buildFiles(opts());
      count.textContent = '문서 ' + (b.count + 1) + '개 (노드 ' + b.count + ' + 목차 1)' +
        (b.skipped.spoiler ? ' · 미공개 ' + b.skipped.spoiler + '개 제외' : '') +
        (b.skipped.dropped ? ' · 폐기 ' + b.skipped.dropped + '개 제외' : '');
    }
    function opts() {
      return {
        excludeSpoiler: cSpoiler.input.checked,
        excludeDropped: cDropped.input.checked,
        includeCanvases: cCanvas.input.checked
      };
    }
    [cSpoiler, cDropped, cCanvas].forEach(function (c) { c.input.addEventListener('change', refresh); });
    refresh();

    var actions = [{ label: '취소', value: null }, { label: 'ZIP 내려받기', value: 'zip' }];
    if (canFolder) actions.push({ label: '폴더에 쓰기', value: 'folder', kind: 'primary' });

    return U.modal({
      title: '마크다운 문서 내보내기',
      body: [
        el('p.dim', { text: '노드 하나당 문서 하나. 연결은 서로의 문서로 가는 링크가 됩니다.' }),
        cSpoiler, cDropped, cCanvas,
        count,
        canFolder
          ? el('p.dim.small', {}, ['폴더의 ', el('code', { text: ROOT + '/' }), ' 에 씁니다. ',
              el('b', { text: '기존 내용은 지우고 새로 씁니다.' })])
          : el('p.dim.small', { text: '이 저장소는 폴더가 안 보이므로 ZIP 으로만 받을 수 있습니다.' })
      ],
      actions: actions
    }).then(function (v) {
      if (!v) return false;
      var built = buildFiles(opts());
      var p = v === 'folder' ? toFolder(built) : toZip(built);
      return p.then(function () {
        U.toast(v === 'folder'
          ? ROOT + '/ 에 문서 ' + (built.count + 1) + '개를 썼습니다.'
          : '문서 ' + (built.count + 1) + '개를 ZIP 으로 받았습니다.', 'ok', 4000);
        return true;
      }).catch(function (e) {
        console.error(e);
        U.toast('내보내기 실패: ' + (e.message || e), 'bad', 6000);
        return false;
      });
    });
  }

  WM.exportMd = {
    ROOT: ROOT,
    dialog: dialog,
    buildFiles: buildFiles,
    renderNode: renderNode,
    renderIndex: renderIndex,
    zip: zip,
    crc32: crc32,
    toFolder: toFolder,
    toZip: toZip
  };
})(window.WM);
