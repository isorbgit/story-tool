/* calendar.js — 가상 연대 계산 (SPEC 6장).

   달력은 코드가 아니라 schema.json 의 데이터다. 달 이름이나 일수가 바뀌어도
   이 파일은 손대지 않는다.

   sort 는 **연 단위 실수 하나**다.
       sort = 연 + (연중일 - 1) / 1년의일수
   연이 정수부라 정렬·비교·눈금이 전부 자연스럽고, 나중에 달력을 고쳐도
   "연" 의 의미는 안 변한다. 기(era)는 쓰지 않기로 했다(SPEC 12장). */
(function (WM) {
  'use strict';

  /* 스키마에 calendar 가 없을 때 기대는 값. 손으로 편집한 옛 스키마가 들어와도
     타임라인이 죽지 않아야 한다. */
  var FALLBACK = {
    daysPerYear: 199,
    months: [
      { key: 'dew', label: '이슬의 달', days: 24 },
      { key: 'rain', label: '비의 달', days: 16 },
      { key: 'sky', label: '하늘의 달', days: 48 },
      { key: 'rune', label: '룬의 달', days: 31 },
      { key: 'wind', label: '바람의 달', days: 28 },
      { key: 'trinity', label: '삼위일체의 달', days: 8 },
      { key: 'one', label: '하나의 달', days: 44 }
    ]
  };

  function raw() {
    var sc = WM.store && WM.store.state && WM.store.state.schema;
    var c = sc && sc.calendar;
    if (!c || !Array.isArray(c.months) || !c.months.length) return FALLBACK;
    return c;
  }

  /** 각 달에 연중 시작일(1부터)을 붙여서 준다. */
  function months() {
    var d = 1;
    return raw().months.map(function (m) {
      var o = { key: m.key, label: m.label, days: Math.max(1, m.days | 0), start: d };
      d += o.days;
      return o;
    });
  }

  /** 선언된 daysPerYear 보다 달 일수의 합을 우선한다. 둘이 어긋나면 합이 진실이다. */
  function daysPerYear() {
    var ms = months();
    return ms[ms.length - 1].start + ms[ms.length - 1].days - 1;
  }

  function clampMonth(mi) {
    var n = months().length;
    return Math.max(0, Math.min(n - 1, mi | 0));
  }

  function dayOfYear(mi, day) {
    var m = months()[clampMonth(mi)];
    return m.start + (Math.max(1, Math.min(m.days, day | 0 || 1)) - 1);
  }

  /** precision 에 따라 그 구간의 **시작점**을 sort 로 준다. 막대는 여기서 오른쪽으로 뻗는다. */
  function toSort(year, mi, day, precision) {
    var y = Number(year) || 0;
    if (precision === 'decade') return Math.floor(y / 10) * 10;
    if (precision === 'year' || precision === 'unknown') return y;
    if (precision === 'month') return y + (dayOfYear(mi, 1) - 1) / daysPerYear();
    return y + (dayOfYear(mi, day) - 1) / daysPerYear();      // exact
  }

  function fromSort(sort) {
    var D = daysPerYear();
    var s = Number(sort) || 0;
    var year = Math.floor(s);
    var doy = Math.round((s - year) * D) + 1;
    if (doy > D) { year += 1; doy -= D; }
    if (doy < 1) doy = 1;
    var ms = months(), mi = 0;
    for (var i = 0; i < ms.length; i++) if (doy >= ms[i].start) mi = i;
    return { year: year, monthIndex: mi, day: doy - ms[mi].start + 1, dayOfYear: doy };
  }

  function format(year, mi, day, precision) {
    var ms = months();
    if (precision === 'decade') return (Math.floor(year / 10) * 10) + '년대';
    if (precision === 'year') return year + '년';
    if (precision === 'month') return year + '년 ' + ms[clampMonth(mi)].label;
    if (precision === 'unknown') return '';
    return year + '년 ' + ms[clampMonth(mi)].label + ' ' + day + '일';
  }

  function precDef(key) {
    var sc = WM.store.state.schema || {};
    var list = sc.whenPrecision || [];
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return { key: 'unknown', label: '미상', timeline: 'tray', span: 0 };
  }

  /**
   * 막대 폭(연 단위). 달마다 일수가 8~48 로 다르므로 "달" 정밀도는 고정값을 쓸 수 없다.
   * spanFrom:'month' 면 sort 에서 어느 달인지 역산해 그 달의 길이로 잰다.
   */
  function spanOf(when) {
    var p = precDef(when && when.precision);
    if (p.spanFrom === 'month') {
      var f = fromSort(when.sort);
      return months()[f.monthIndex].days / daysPerYear();
    }
    return Number(p.span) || 0;
  }

  WM.calendar = {
    months: months,
    daysPerYear: daysPerYear,
    dayOfYear: dayOfYear,
    toSort: toSort,
    fromSort: fromSort,
    format: format,
    precDef: precDef,
    spanOf: spanOf,
    FALLBACK: FALLBACK
  };
})(window.WM);
