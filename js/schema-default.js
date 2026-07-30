/* schema-default.js — 내장 기본 스키마 (SPEC 5장/8장).
   file:// 에서는 fetch가 막히므로 스키마를 JS로 내장한다. 이 객체가 유일한 원본이고,
   폴더를 처음 연결할 때 어댑터가 이걸 data/schema.json 으로 써넣는다.
   이후에는 폴더 안의 schema.json 이 우선한다. */
window.WM = window.WM || {};
WM.DEFAULT_SCHEMA = {
  schemaVersion: 1,

  flags: {
    status: {
      label: '상태', default: 'draft',
      values: [
        { key: 'confirmed', label: '확정', style: 'solid' },
        { key: 'draft', label: '가설', style: 'dashed' },
        { key: 'dropped', label: '폐기', style: 'struck', hiddenByDefault: true }
      ]
    },
    reveal: {
      label: '공개', default: 'public',
      values: [
        { key: 'public', label: '공개' },
        { key: 'spoiler', label: '미공개', icon: 'lock' }
      ]
    },
    impl: {
      label: '구현', default: 'todo',
      values: [
        { key: 'done', label: '구현됨', badge: 'check' },
        { key: 'todo', label: '미구현', badge: 'dot' },
        { key: 'na', label: '해당없음' }
      ]
    }
  },

  /* 「가면을 벗다」의 달력 (SPEC 6장). 1년 7달 199일, 윤달 없음.
     위성 세 개의 위치와 형태로 정해진 시간표라 달 길이가 균등하지 않다.
     sort 계산은 전부 이 데이터에서 나온다 — calendar.js 는 숫자를 갖고 있지 않다. */
  calendar: {
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
  },

  /* span = 타임라인 막대가 차지하는 폭, 단위는 연.
     "달" 은 고정값을 못 쓴다. 삼위일체의 달(8일)과 하늘의 달(48일)이 6배 차이라
     하나로 뭉뚱그리면 막대가 나타내는 불확실성이 거짓말이 된다.
     spanFrom:'month' 는 sort 에서 어느 달인지 역산해 그 달의 길이로 재라는 뜻이다. */
  whenPrecision: [
    { key: 'exact', label: '정확(일)', timeline: 'point', span: 0 },
    { key: 'month', label: '달', timeline: 'range', spanFrom: 'month' },
    { key: 'year', label: '연', timeline: 'range', span: 1 },
    { key: 'decade', label: '십년대', timeline: 'range', span: 10 },
    { key: 'unknown', label: '미상', timeline: 'tray', span: 0 }
  ],

  labelPresets: {
    event_cause: {
      free: false, options: ['직접원인', '간접원인', '계기', '저지'],
      extraFields: [{ key: 'note', label: '메모', widget: 'text' }]
    },
    char_event: {
      free: false, options: ['주도', '가담', '목격', '피해', '무관'],
      extraFields: [{ key: 'note', label: '메모', widget: 'text' }]
    },
    org_event: {
      free: false, options: ['주도', '관여', '대립', '피해'],
      extraFields: [{ key: 'note', label: '메모', widget: 'text' }]
    },
    org_role: {
      free: true, options: [],
      extraFields: [
        { key: 'position', label: '직위', widget: 'text' },
        { key: 'period', label: '기간', widget: 'text' }
      ]
    },
    char_char: {
      free: true, options: ['스승', '제자', '혈연', '원수', '연인', '동료'],
      extraFields: [
        { key: 'note', label: '메모', widget: 'text' },
        {
          key: 'direction', label: '방향성', widget: 'select',
          options: ['무방향', 'from→to', 'to→from'], default: '무방향'
        }
      ]
    },
    char_item: {
      free: false, options: ['소유', '제작', '상실', '갈망'],
      extraFields: [{ key: 'period', label: '기간', widget: 'text' }]
    },
    char_concept: {
      free: false, options: ['신봉', '창시', '배격', '이용'],
      extraFields: [{ key: 'note', label: '메모', widget: 'text' }]
    },
    concept_event: {
      free: false, options: ['기원', '관여', '확산', '억압'],
      extraFields: [{ key: 'note', label: '메모', widget: 'text' }]
    },
    generic: {
      free: true, options: [],
      extraFields: [{ key: 'note', label: '메모', widget: 'text' }]
    }
  },

  types: {
    event: {
      label: '사건', idPrefix: 'evt_', color: '#E8A33D', icon: 'zap',
      sockets: [
        { key: 'causeIn', label: '인과In', accepts: ['event'], multi: true, pin: 'causal', dir: 'in', reciprocal: 'event.causeOut', labelPreset: 'event_cause' },
        { key: 'causeOut', label: '인과Out', accepts: ['event'], multi: true, pin: 'causal', dir: 'out', reciprocal: 'event.causeIn', labelPreset: 'event_cause' },
        { key: 'characters', label: '인물', accepts: ['character'], multi: true, pin: 'involve', dir: 'in', reciprocal: 'character.events', labelPreset: 'char_event' },
        { key: 'orgs', label: '조직', accepts: ['organization'], multi: true, pin: 'involve', dir: 'in', reciprocal: 'organization.events', labelPreset: 'org_event' },
        { key: 'items', label: '물건', accepts: ['item'], multi: true, pin: 'involve', dir: 'in', reciprocal: 'item.events', labelPreset: 'generic' },
        { key: 'concepts', label: '개념', accepts: ['concept'], multi: true, pin: 'involve', dir: 'out', reciprocal: 'concept.events', labelPreset: 'concept_event' },
        { key: 'locations', label: '장소', accepts: ['location'], multi: true, pin: 'involve', dir: 'in', reciprocal: 'location.events', labelPreset: 'generic' }
      ],
      fields: [
        { key: 'when', label: '시점', widget: 'when' },
        { key: 'summary', label: '요약', widget: 'text', required: true, hint: '1줄' },
        { key: 'detail', label: '상세', widget: 'markdown' },
        { key: 'result', label: '결과', widget: 'markdown' }
      ],
      cardFields: ['when', 'summary']
    },

    character: {
      label: '인물', idPrefix: 'chr_', color: '#4FA8E8', icon: 'user',
      sockets: [
        { key: 'events', label: '관여 사건', accepts: ['event'], multi: true, pin: 'involve', dir: 'out', reciprocal: 'event.characters', labelPreset: 'char_event' },
        { key: 'orgs', label: '소속', accepts: ['organization'], multi: true, pin: 'involve', dir: 'out', reciprocal: 'organization.members', labelPreset: 'org_role' },
        { key: 'items', label: '소지·제작', accepts: ['item'], multi: true, pin: 'involve', dir: 'out', reciprocal: 'item.holders', labelPreset: 'char_item' },
        { key: 'concepts', label: '신념', accepts: ['concept'], multi: true, pin: 'involve', dir: 'out', reciprocal: 'concept.believers', labelPreset: 'char_concept' },
        { key: 'relations', label: '인물관계', accepts: ['character'], multi: true, pin: 'involve', dir: 'out', undirected: true, reciprocal: 'character.relations', labelPreset: 'char_char' },
        { key: 'bases', label: '거점', accepts: ['location'], multi: true, pin: 'involve', dir: 'out', reciprocal: 'location.residents', labelPreset: 'generic' }
      ],
      fields: [
        { key: 'alias', label: '이명', widget: 'text' },
        { key: 'lifespan', label: '생몰', widget: 'text', hint: '예: 3기 981 ~ ' },
        { key: 'intro', label: '소개', widget: 'markdown', required: true },
        { key: 'secret', label: '비밀', widget: 'markdown', reveal: 'spoiler' },
        { key: 'appearance', label: '외형 메모', widget: 'markdown' }
      ],
      cardFields: ['alias', 'intro']
    },

    organization: {
      label: '조직', idPrefix: 'org_', color: '#C75B5B', icon: 'flag',
      sockets: [
        { key: 'events', label: '관여 사건', accepts: ['event'], multi: true, pin: 'involve', dir: 'out', reciprocal: 'event.orgs', labelPreset: 'org_event' },
        { key: 'parents', label: '상위 조직', accepts: ['organization'], multi: true, pin: 'involve', dir: 'out', reciprocal: 'organization.children', labelPreset: 'generic' },
        { key: 'children', label: '하위 조직', accepts: ['organization'], multi: true, pin: 'involve', dir: 'in', reciprocal: 'organization.parents', labelPreset: 'generic' },
        { key: 'members', label: '구성원', accepts: ['character'], multi: true, pin: 'involve', dir: 'in', reciprocal: 'character.orgs', labelPreset: 'org_role' },
        { key: 'concepts', label: '이념', accepts: ['concept'], multi: true, pin: 'involve', dir: 'out', reciprocal: 'concept.believers', labelPreset: 'char_concept' },
        { key: 'items', label: '보유물', accepts: ['item'], multi: true, pin: 'involve', dir: 'out', reciprocal: 'item.holders', labelPreset: 'char_item' },
        { key: 'territory', label: '세력권', accepts: ['location'], multi: true, pin: 'involve', dir: 'out', reciprocal: 'location.rulers', labelPreset: 'generic' }
      ],
      fields: [
        {
          key: 'scale', label: '규모등급', widget: 'select', required: true,
          options: ['패거리', '조직', '도시세력', '국가', '초국가'],
          affects: 'nodeSize', hint: '필터 및 노드 크기 차별화에 사용'
        },
        { key: 'founded', label: '설립 시점', widget: 'when' },
        { key: 'dissolved', label: '해체 시점', widget: 'when' },
        { key: 'overview', label: '개요', widget: 'markdown', required: true }
      ],
      cardFields: ['scale', 'overview']
    },

    item: {
      label: '물건·작품', idPrefix: 'itm_', color: '#7FBF6A', icon: 'package',
      sockets: [
        { key: 'events', label: '관여 사건', accepts: ['event'], multi: true, pin: 'involve', dir: 'out', reciprocal: 'event.items', labelPreset: 'generic' },
        // 소유자/제작자를 쪼개지 않는다. 성격은 엣지 라벨(소유·제작·상실·갈망)이 갖는다.
        { key: 'holders', label: '소지자·제작자', accepts: ['character', 'organization'], multi: true, pin: 'involve', dir: 'in', reciprocal: 'character.items', labelPreset: 'char_item' },
        { key: 'concepts', label: '담은 개념', accepts: ['concept'], multi: true, pin: 'involve', dir: 'out', reciprocal: 'concept.media', labelPreset: 'generic' },
        { key: 'location', label: '소재 장소', accepts: ['location'], multi: true, pin: 'involve', dir: 'out', reciprocal: 'location.items', labelPreset: 'generic' }
      ],
      fields: [
        { key: 'category', label: '분류', widget: 'select', required: true, options: ['무기', '유물', '서적', '가면', '악곡', '기타'] },
        { key: 'desc', label: '설명', widget: 'markdown', required: true },
        { key: 'history', label: '내력', widget: 'markdown' }
      ],
      cardFields: ['category', 'desc']
    },

    concept: {
      label: '개념', idPrefix: 'cpt_', color: '#A87FD0', icon: 'lightbulb',
      sockets: [
        { key: 'parents', label: '상위 개념', accepts: ['concept'], multi: true, pin: 'involve', dir: 'out', reciprocal: 'concept.derived', labelPreset: 'generic' },
        { key: 'derived', label: '파생 개념', accepts: ['concept'], multi: true, pin: 'involve', dir: 'in', reciprocal: 'concept.parents', labelPreset: 'generic' },
        { key: 'believers', label: '신봉자', accepts: ['character', 'organization'], multi: true, pin: 'involve', dir: 'in', reciprocal: 'character.concepts', labelPreset: 'char_concept' },
        { key: 'media', label: '전파 매체', accepts: ['item'], multi: true, pin: 'involve', dir: 'in', reciprocal: 'item.concepts', labelPreset: 'generic' },
        { key: 'events', label: '관여 사건', accepts: ['event'], multi: true, pin: 'involve', dir: 'in', reciprocal: 'event.concepts', labelPreset: 'concept_event' }
      ],
      fields: [
        { key: 'category', label: '분류', widget: 'select', required: true, options: ['사상', '이론', '종교', '기술', '미신'] },
        { key: 'gist', label: '요지', widget: 'text', required: true, hint: '1줄' },
        { key: 'detail', label: '상세', widget: 'markdown' }
      ],
      cardFields: ['category', 'gist']
    },

    location: {
      label: '장소', idPrefix: 'loc_', color: '#8A8A8A', icon: 'map-pin',
      sockets: [
        { key: 'events', label: '관여 사건', accepts: ['event'], multi: true, pin: 'involve', dir: 'out', reciprocal: 'event.locations', labelPreset: 'generic' },
        { key: 'parents', label: '상위 장소', accepts: ['location'], multi: true, pin: 'involve', dir: 'out', reciprocal: 'location.children', labelPreset: 'generic' },
        { key: 'children', label: '하위 장소', accepts: ['location'], multi: true, pin: 'involve', dir: 'in', reciprocal: 'location.parents', labelPreset: 'generic' },
        { key: 'rulers', label: '지배 조직', accepts: ['organization'], multi: true, pin: 'involve', dir: 'in', reciprocal: 'organization.territory', labelPreset: 'generic' },
        { key: 'residents', label: '거점 인물', accepts: ['character'], multi: true, pin: 'involve', dir: 'in', reciprocal: 'character.bases', labelPreset: 'generic' },
        { key: 'items', label: '소재 물건', accepts: ['item'], multi: true, pin: 'involve', dir: 'in', reciprocal: 'item.location', labelPreset: 'generic' }
      ],
      fields: [
        { key: 'category', label: '분류', widget: 'select', required: true, options: ['지역', '도시', '시설', '이계'] },
        { key: 'desc', label: '설명', widget: 'markdown', required: true }
      ],
      cardFields: ['category', 'desc']
    }
  }
};
