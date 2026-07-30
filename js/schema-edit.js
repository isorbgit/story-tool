/* schema-edit.js — 스키마 검증·영향 분석·타입 생성 (SPEC 5.3). 순수 계산만. UI는 ui-schema.js.

   스키마는 데이터지만 아무 데이터나 아니다. 여기가 깨지면 표·패널·캔버스가 전부 같이
   깨지므로, 적용 전에 두 가지를 따로 본다.
     validate(sc)  — 스키마 자체가 말이 되는가 (기존 데이터와 무관)
     impact(next)  — 지금 쌓인 노드·엣지에 무슨 일이 생기는가 */
(function (WM) {
  'use strict';

  var WIDGETS = ['text', 'markdown', 'select', 'when', 'number'];
  var PINS = ['causal', 'involve'];
  var DIRS = ['in', 'out'];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function isPlain(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }

  /* ---------- 검증 ---------- */

  function validate(sc) {
    var out = [];
    var seen = {};
    function push(level, msg) {
      if (seen[msg]) return;          // 같은 문장을 소켓마다 반복하면 목록이 못 읽게 된다
      seen[msg] = true;
      out.push({ level: level, msg: msg });
    }
    function err(m) { push('error', m); }
    function warn(m) { push('warn', m); }

    if (!isPlain(sc)) { err('스키마가 객체가 아닙니다.'); return out; }
    if (!isPlain(sc.types) || !Object.keys(sc.types).length) {
      err('types 가 비어 있습니다. 최소 한 타입은 있어야 합니다.');
      return out;                     // 여기부터는 볼 것도 없다
    }

    var tkeys = Object.keys(sc.types);
    function name(t) {
      var d = sc.types[t];
      return (d && d.label) ? d.label + '(' + t + ')' : t;
    }

    /* 타입 자체 */
    var prefixes = {};
    tkeys.forEach(function (t) {
      var d = sc.types[t];
      if (!isPlain(d)) { err(t + ' 의 정의가 객체가 아닙니다.'); return; }
      if (!d.label) err(t + ' 에 label 이 없습니다.');
      if (!/^[a-z][a-z0-9]*_$/.test(String(d.idPrefix || ''))) {
        err(name(t) + ' 의 idPrefix 는 영문 소문자 + 밑줄로 끝나야 합니다 (예: chr_). 지금: ' + JSON.stringify(d.idPrefix));
      } else if (prefixes[d.idPrefix]) {
        err('idPrefix "' + d.idPrefix + '" 를 ' + name(prefixes[d.idPrefix]) + ' 와 ' + name(t) + ' 가 같이 씁니다. ID가 섞입니다.');
      } else {
        prefixes[d.idPrefix] = t;
      }
      if (d.color && !/^#[0-9a-fA-F]{3,8}$/.test(String(d.color))) warn(name(t) + ' 의 color 가 색상 코드가 아닙니다.');
      if (!Array.isArray(d.sockets)) err(name(t) + ' 의 sockets 가 배열이 아닙니다.');
      if (!Array.isArray(d.fields)) err(name(t) + ' 의 fields 가 배열이 아닙니다.');
    });

    /* 소켓 */
    tkeys.forEach(function (t) {
      var d = sc.types[t];
      if (!isPlain(d) || !Array.isArray(d.sockets)) return;
      var keys = {};
      d.sockets.forEach(function (s) {
        if (!isPlain(s) || !s.key) { err(name(t) + ' 에 key 없는 소켓이 있습니다.'); return; }
        if (keys[s.key]) err(name(t) + ' 에 소켓 키 "' + s.key + '" 가 두 번 있습니다.');
        keys[s.key] = true;
        if (!s.label) warn(name(t) + '.' + s.key + ' 에 label 이 없습니다.');
        if (!Array.isArray(s.accepts) || !s.accepts.length) {
          err(name(t) + '.' + s.key + ' 의 accepts 가 비었습니다. 무엇을 꽂을지 정해야 합니다.');
        } else {
          s.accepts.forEach(function (a) {
            if (!sc.types[a]) err(name(t) + '.' + s.key + ' 가 없는 타입 "' + a + '" 를 받습니다.');
          });
        }
        if (s.pin && PINS.indexOf(s.pin) < 0) warn(name(t) + '.' + s.key + ' 의 pin 은 ' + PINS.join('/') + ' 중 하나여야 합니다.');
        if (s.dir && DIRS.indexOf(s.dir) < 0) warn(name(t) + '.' + s.key + ' 의 dir 은 in/out 이어야 합니다.');
        if (s.labelPreset && !(isPlain(sc.labelPresets) && sc.labelPresets[s.labelPreset])) {
          warn(name(t) + '.' + s.key + ' 의 labelPreset "' + s.labelPreset + '" 가 없습니다. generic 으로 대체됩니다.');
        }
        if (s.reciprocal) {
          var p = String(s.reciprocal).split('.');
          if (p.length !== 2 || !sc.types[p[0]]) {
            warn(name(t) + '.' + s.key + ' 의 reciprocal "' + s.reciprocal + '" 가 가리키는 타입이 없습니다.');
          } else if (!(sc.types[p[0]].sockets || []).some(function (x) { return x.key === p[1]; })) {
            warn(name(t) + '.' + s.key + ' 의 reciprocal "' + s.reciprocal + '" 가 가리키는 소켓이 없습니다.');
          }
        }
      });
    });

    /* 양쪽 짝 — 이 스키마의 핵심 불변식.
       캔버스 연결선은 양 끝에 핀이 있어야 그릴 수 있다(SPEC 12장). 한쪽만 있으면
       패널에서는 이어지는 것처럼 보이는데 그래프에서 선이 안 나온다. */
    tkeys.forEach(function (t) {
      var d = sc.types[t];
      if (!isPlain(d) || !Array.isArray(d.sockets)) return;
      d.sockets.forEach(function (s) {
        (Array.isArray(s.accepts) ? s.accepts : []).forEach(function (a) {
          var target = sc.types[a];
          if (!target || !Array.isArray(target.sockets)) return;
          var back = target.sockets.some(function (s2) {
            return Array.isArray(s2.accepts) && s2.accepts.indexOf(t) >= 0;
          });
          if (!back) {
            err(name(t) + ' 는 ' + name(a) + ' 를 받는데 ' + name(a) + ' 에는 ' +
                name(t) + ' 를 받는 소켓이 없습니다. 캔버스에서 선이 그려지지 않습니다.');
          }
        });
      });
    });

    /* 필드 */
    tkeys.forEach(function (t) {
      var d = sc.types[t];
      if (!isPlain(d) || !Array.isArray(d.fields)) return;
      var keys = {};
      d.fields.forEach(function (f) {
        if (!isPlain(f) || !f.key) { err(name(t) + ' 에 key 없는 필드가 있습니다.'); return; }
        if (keys[f.key]) err(name(t) + ' 에 필드 키 "' + f.key + '" 가 두 번 있습니다.');
        keys[f.key] = true;
        if (!f.label) warn(name(t) + '.' + f.key + ' 에 label 이 없습니다.');
        if (f.widget && WIDGETS.indexOf(f.widget) < 0) {
          warn(name(t) + '.' + f.key + ' 의 widget "' + f.widget + '" 은 모르는 종류입니다. 텍스트로 그려집니다.');
        }
        if (f.widget === 'select' && (!Array.isArray(f.options) || !f.options.length)) {
          err(name(t) + '.' + f.key + ' 는 select 인데 options 가 없습니다. 고를 수가 없습니다.');
        }
      });
      (Array.isArray(d.cardFields) ? d.cardFields : []).forEach(function (k) {
        if (!keys[k]) warn(name(t) + ' 의 cardFields 에 없는 필드 "' + k + '" 가 있습니다.');
      });
    });

    /* 플래그 — 3종은 코드가 이름으로 직접 참조한다 */
    ['status', 'reveal', 'impl'].forEach(function (k) {
      var f = isPlain(sc.flags) ? sc.flags[k] : null;
      if (!f) { err('flags.' + k + ' 이 없습니다. 노드·엣지의 필수 플래그입니다.'); return; }
      if (!Array.isArray(f.values) || !f.values.length) { err('flags.' + k + '.values 가 비었습니다.'); return; }
      if (!f.values.some(function (v) { return v.key === f.default; })) {
        err('flags.' + k + ' 의 default "' + f.default + '" 가 values 에 없습니다.');
      }
    });
    if (isPlain(sc.flags) && isPlain(sc.flags.status)) {
      ['confirmed', 'draft', 'dropped'].forEach(function (v) {
        if (!(sc.flags.status.values || []).some(function (x) { return x.key === v; })) {
          warn('flags.status 에 "' + v + '" 가 없습니다. 검증 규칙과 필터가 이 값을 이름으로 씁니다.');
        }
      });
    }

    /* 달력 (SPEC 6장) — sort 계산이 전부 여기서 나온다 */
    var cal = isPlain(sc.calendar) ? sc.calendar : null;
    if (!cal || !Array.isArray(cal.months) || !cal.months.length) {
      warn('calendar.months 가 없습니다. 내장 기본 달력(1년 199일)으로 계산합니다.');
    } else {
      var sum = 0, mkeys = {};
      cal.months.forEach(function (m, i) {
        if (!isPlain(m) || !m.key) { err('calendar.months[' + i + '] 에 key 가 없습니다.'); return; }
        if (mkeys[m.key]) err('달 키 "' + m.key + '" 가 두 번 있습니다.');
        mkeys[m.key] = true;
        if (!m.label) warn('달 "' + m.key + '" 에 label 이 없습니다.');
        if (!(typeof m.days === 'number' && m.days > 0 && m.days === Math.floor(m.days))) {
          err('달 "' + (m.label || m.key) + '" 의 days 는 1 이상의 정수여야 합니다.');
        } else { sum += m.days; }
      });
      if (typeof cal.daysPerYear === 'number' && sum && cal.daysPerYear !== sum) {
        warn('calendar.daysPerYear(' + cal.daysPerYear + ') 와 달 일수의 합(' + sum + ')이 다릅니다. 합을 씁니다.');
      }
    }

    /* 시점 정밀도 */
    if (!Array.isArray(sc.whenPrecision) || !sc.whenPrecision.length) {
      err('whenPrecision 이 비었습니다. 시점 필드를 그릴 수 없습니다.');
    } else {
      if (!sc.whenPrecision.some(function (p) { return p.key === 'unknown'; })) {
        warn('whenPrecision 에 "unknown" 이 없습니다. 시점 미정 사건을 둘 자리가 없어집니다.');
      }
      sc.whenPrecision.forEach(function (p) {
        if (p.spanFrom === 'month') return;      // 달력에서 계산한다
        if (typeof p.span !== 'number') warn('whenPrecision "' + p.key + '" 의 span 이 숫자가 아닙니다.');
      });
    }

    if (!isPlain(sc.labelPresets) || !sc.labelPresets.generic) {
      warn('labelPresets.generic 이 없습니다. 프리셋을 못 찾을 때 기댈 곳이 사라집니다.');
    }

    return out;
  }

  /* ---------- 영향 분석 ----------
     지금 쌓인 데이터 기준으로 "적용하면 무엇이 사라지는가" 를 센다. 지우지는 않는다. */

  function impact(next) {
    var S = WM.store.state;
    var cur = S.schema || {};
    var res = { typeRemoved: [], socketRemoved: [], fieldRemoved: [], nowRequired: [], prefixChanged: [] };
    if (!isPlain(next) || !isPlain(next.types)) return res;

    var nodesByType = {};
    Object.keys(S.nodes).forEach(function (id) {
      var t = S.nodes[id].type;
      (nodesByType[t] = nodesByType[t] || []).push(id);
    });

    Object.keys(cur.types || {}).forEach(function (t) {
      var before = cur.types[t], after = next.types[t];
      var ids = nodesByType[t] || [];

      if (!after) {
        if (ids.length) res.typeRemoved.push({ type: t, label: before.label || t, count: ids.length });
        return;
      }

      if (before.idPrefix !== after.idPrefix) {
        res.prefixChanged.push({ type: t, label: after.label || t, from: before.idPrefix, to: after.idPrefix, count: ids.length });
      }

      /* 사라진 소켓에 물린 엣지 */
      var afterSocketKeys = (after.sockets || []).map(function (s) { return s.key; });
      (before.sockets || []).forEach(function (s) {
        if (afterSocketKeys.indexOf(s.key) >= 0) return;
        var n = 0;
        Object.keys(S.edges).forEach(function (eid) {
          var e = S.edges[eid];
          var fromT = S.nodes[e.from] && S.nodes[e.from].type;
          var toT = S.nodes[e.to] && S.nodes[e.to].type;
          if ((fromT === t && e.fromSocket === s.key) || (toT === t && e.toSocket === s.key)) n++;
        });
        if (n) res.socketRemoved.push({ type: t, label: after.label || t, socket: s.label || s.key, key: s.key, count: n });
      });

      /* 사라진 필드에 들어 있던 값 */
      var afterFieldKeys = (after.fields || []).map(function (f) { return f.key; });
      (before.fields || []).forEach(function (f) {
        if (afterFieldKeys.indexOf(f.key) >= 0) return;
        var n = ids.filter(function (id) {
          var v = S.nodes[id].fields && S.nodes[id].fields[f.key];
          return v !== undefined && v !== null && String(v).trim && String(v).trim() !== '';
        }).length;
        if (n) res.fieldRemoved.push({ type: t, label: after.label || t, field: f.label || f.key, key: f.key, count: n });
      });

      /* 새로 필수가 된 필드 */
      (after.fields || []).forEach(function (f) {
        if (!f.required) return;
        var wasRequired = (before.fields || []).some(function (b) { return b.key === f.key && b.required; });
        if (wasRequired) return;
        var n = ids.filter(function (id) {
          var v = S.nodes[id].fields && S.nodes[id].fields[f.key];
          if (f.widget === 'when') return !(v && (v.display || v.sort !== undefined));
          return v === undefined || v === null || String(v).trim() === '';
        }).length;
        if (n) res.nowRequired.push({ type: t, label: after.label || t, field: f.label || f.key, count: n });
      });
    });

    return res;
  }

  function impactTotal(imp) {
    return imp.typeRemoved.length + imp.socketRemoved.length + imp.fieldRemoved.length +
           imp.nowRequired.length + imp.prefixChanged.length;
  }

  /* ---------- 타입 추가 ----------
     연결할 상대를 고르면 양쪽 소켓을 같이 만든다. 한쪽만 만들면 선이 안 그려지는데,
     그 사실을 나중에 캔버스에서 발견하게 두면 원인을 찾기 어렵다. */

  function addType(schema, spec) {
    var sc = clone(schema);
    var key = spec.key;
    var links = spec.links || [];

    sc.types[key] = {
      label: spec.label,
      idPrefix: spec.idPrefix,
      color: spec.color,
      icon: spec.icon || 'circle',
      sockets: links.map(function (l) {
        return {
          key: l.socketKey,
          label: l.socketLabel,
          accepts: [l.target],
          multi: true,
          pin: 'involve',
          dir: 'out',
          reciprocal: l.target + '.' + l.backKey,
          labelPreset: 'generic'
        };
      }),
      fields: [
        { key: 'summary', label: '요약', widget: 'text', hint: '1줄' },
        { key: 'detail', label: '상세', widget: 'markdown' }
      ],
      cardFields: ['summary']
    };

    links.forEach(function (l) {
      var t = sc.types[l.target];
      if (!t) return;
      if (!Array.isArray(t.sockets)) t.sockets = [];
      if (t.sockets.some(function (s) { return s.key === l.backKey; })) return;
      t.sockets.push({
        key: l.backKey,
        label: l.backLabel,
        accepts: [key],
        multi: true,
        pin: 'involve',
        dir: 'in',
        reciprocal: key + '.' + l.socketKey,
        labelPreset: 'generic'
      });
    });

    return sc;
  }

  /** 타입 삭제. 그 타입을 받던 상대 소켓도 같이 정리해야 짝이 안 깨진다. */
  function removeType(schema, key) {
    var sc = clone(schema);
    delete sc.types[key];
    Object.keys(sc.types).forEach(function (t) {
      var d = sc.types[t];
      if (!Array.isArray(d.sockets)) return;
      d.sockets = d.sockets.filter(function (s) {
        var accepts = (s.accepts || []).filter(function (a) { return a !== key; });
        if (!accepts.length) return false;          // 이 타입만 받던 소켓은 존재 이유가 사라진다
        s.accepts = accepts;
        if (s.reciprocal && String(s.reciprocal).split('.')[0] === key) delete s.reciprocal;
        return true;
      });
    });
    return sc;
  }

  WM.schemaEdit = {
    clone: clone,
    validate: validate,
    impact: impact,
    impactTotal: impactTotal,
    addType: addType,
    removeType: removeType,
    WIDGETS: WIDGETS
  };
})(window.WM);
