/* storage-supabase.js 스모크 테스트 —  node test/supabase.test.js

   fetch 를 가로채 요청을 기록하고 응답을 꾸며 준다. Supabase 프로젝트 없이 돌아가므로
   URL·헤더·메서드가 틀어지는 건 여기서 잡힌다. 실제 연결은 이걸로 대신할 수 없다.

   이 테스트가 처음 잡은 것: readAll() 이 파일 4개를 병렬로 읽는데 그 사이 토큰이
   만료돼 있으면 넷이 각자 갱신을 불렀다. refresh_token 은 쓸 때마다 회전하므로
   동시에 네 번 쓰면 세션이 통째로 날아간다. */
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');

const calls = [];
const idb = {};
let respond = () => ({ status: 200, body: '{}' });

/* Supabase 는 "파일 없음" 을 HTTP 404 가 아니라 400 + 본문 statusCode 404 로 준다.
   빈 버킷에 처음 연결하는 경로가 여기서 갈린다. */
const MISSING = { status: 400, body: '{"statusCode":"404","error":"not_found","message":"Object not found","code":"NoSuchKey"}' };

const ctx = vm.createContext({});
ctx.window = ctx;
ctx.console = console;
ctx.isSecureContext = true;
ctx.Date = Date; ctx.Promise = Promise; ctx.JSON = JSON; ctx.Object = Object;
ctx.encodeURIComponent = encodeURIComponent; ctx.Number = Number; ctx.String = String;
ctx.fetch = (url, opt) => {
  opt = opt || {};
  calls.push({ url, method: opt.method || 'GET', headers: opt.headers || {}, body: opt.body });
  const r = respond(url, opt);
  return Promise.resolve({
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    text: () => Promise.resolve(r.body),
    json: () => Promise.resolve(JSON.parse(r.body))
  });
};
ctx.WM = {
  util: {
    idbGet: k => Promise.resolve(k in idb ? idb[k] : null),
    idbSet: (k, v) => { idb[k] = v; return Promise.resolve(true); },
    idbDel: k => { delete idb[k]; return Promise.resolve(true); },
    el: () => ({}), modal: () => Promise.resolve(null), toast: () => {}
  },
  storage: { MAX_BACKUPS: 10 }
};

vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/storage-supabase.js'), 'utf8'), ctx);
const SA = ctx.WM.storage.SupabaseAdapter;

/* 어댑터 계약 (SPEC 3.0) 을 다 갖췄는가 */
const need = ['isAvailable'];
const needProto = ['connect', 'readAll', 'writeFiles', 'listBackups', 'writeBackup',
                   'deleteBackup', 'rotateBackups', 'isConnected', 'restore'];
let bad = 0;
for (const m of need) if (typeof SA[m] !== 'function') { console.log('X 정적 메서드 없음:', m); bad++; }
for (const m of needProto) if (typeof SA.prototype[m] !== 'function') { console.log('X 없음:', m); bad++; }
const a = new SA();
for (const p of ['id', 'canRotateBackup', 'isUserVisible']) if (a[p] === undefined) { console.log('X 속성 없음:', p); bad++; }
console.log(bad ? `계약 오류 ${bad}건` : '계약 OK — 필수 메서드·속성 전부 있음');

/* 로그인 → 세션 저장 */
a.cfg = { url: 'https://demo.supabase.co/', anonKey: 'ANON', bucket: 'worldmap' };
respond = () => ({ status: 200, body: JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }) });

a.signIn('me@example.com', 'pw')
  .then(() => {
    const c = calls.at(-1);
    check('로그인 URL', c.url, 'https://demo.supabase.co/auth/v1/token?grant_type=password');
    check('로그인 apikey', c.headers.apikey, 'ANON');
    check('세션 저장', !!idb['worldmap-supabase-session'], true);

    calls.length = 0;
    respond = (url) => url.includes('canvases') ? MISSING : { status: 200, body: '{"x":1}' };
    return a.readAll();
  })
  .then(data => {
    check('readAll 요청 수', calls.length, 4);
    check('첫 요청 URL', calls[0].url, 'https://demo.supabase.co/storage/v1/object/worldmap/data/schema.json');
    check('Authorization', calls[0].headers.Authorization, 'Bearer AT');
    check('없는 파일(400+NoSuchKey) 은 null', data.canvases, null);
    check('키 이름', Object.keys(data).sort().join(','), 'canvases,edges,nodes,schema');

    /* 빈 버킷 전체 — 네 파일이 다 없어도 readAll 이 터지면 안 된다 */
    calls.length = 0;
    respond = () => MISSING;
    return a.readAll();
  })
  .then(empty => {
    check('빈 버킷 readAll 성공', Object.keys(empty).length, 4);
    check('전부 null', Object.keys(empty).every(k => empty[k] === null), true);

    /* 권한 거부는 절대 null 로 삼키면 안 된다 — 정책 오류가 "빈 저장소" 로 보이면
       곧이어 그 빈 상태가 저장되어 데이터를 덮는다. */
    calls.length = 0;
    respond = () => ({ status: 400, body: '{"statusCode":"403","error":"Unauthorized","message":"denied","code":"AccessDenied"}' });
    return a.readAll().then(
      () => check('권한 거부는 오류로', 'null 로 삼켰다', '예외를 던져야 한다'),
      (e) => check('권한 거부는 오류로', /AccessDenied/.test(e.message), true)
    );
  })
  .then(() => {
    calls.length = 0;
    respond = () => ({ status: 200, body: '{}' });
    return a.writeFiles({ 'nodes.json': '{"a":1}', 'edges.json': '{}' });
  })
  .then(() => {
    check('writeFiles 요청 수', calls.length, 2);
    check('메서드', calls[0].method, 'POST');
    check('upsert 헤더', calls[0].headers['x-upsert'], 'true');
    check('본문 그대로', calls[0].body, '{"a":1}');
    check('경로', calls[0].url.endsWith('/worldmap/data/nodes.json'), true);

    calls.length = 0;
    respond = () => ({ status: 200, body: JSON.stringify([
      { name: '20260101-0900', id: null }, { name: '20260102-0900', id: null }, { name: '.keep', id: 'x' }
    ]) });
    return a.listBackups();
  })
  .then(list => {
    check('백업 목록 (폴더만)', list.join(','), '20260101-0900,20260102-0900');
    check('list 메서드', calls[0].method, 'POST');
    check('list URL', calls[0].url, 'https://demo.supabase.co/storage/v1/object/list/worldmap');
    check('prefix', JSON.parse(calls[0].body).prefix, 'backup');

    calls.length = 0;
    return a.writeBackup('20260731-1300', { 'nodes.json': '{}', 'edges.json': '{}' });
  })
  .then(() => {
    check('백업 경로', calls[0].url.endsWith('/worldmap/backup/20260731-1300/nodes.json'), true);

    calls.length = 0;
    return a.deleteBackup('20260101-0900');
  })
  .then(() => {
    check('삭제 메서드', calls[0].method, 'DELETE');
    check('삭제 prefixes', JSON.parse(calls[0].body).prefixes[0], 'backup/20260101-0900/schema.json');

    /* 만료된 토큰이면 요청 전에 갱신하는가 */
    calls.length = 0;
    a.session.expires_at = Date.now() - 1000;
    respond = (url) => url.includes('grant_type=refresh_token')
      ? { status: 200, body: JSON.stringify({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 }) }
      : { status: 200, body: '{}' };
    return a.readAll();
  })
  .then(() => {
    const refreshes = calls.filter(c => c.url.includes('grant_type=refresh_token'));
    check('만료 시 갱신 먼저', calls[0].url.includes('grant_type=refresh_token'), true);
    check('갱신은 단 한 번 (병렬 4개여도)', refreshes.length, 1);
    check('총 요청 수 = 갱신1 + 읽기4', calls.length, 5);
    check('새 토큰 사용', calls[1].headers.Authorization, 'Bearer AT2');
    check('마지막 요청도 새 토큰', calls.at(-1).headers.Authorization, 'Bearer AT2');
    console.log(fails ? `\n실패 ${fails}건` : '\n전부 통과');
    process.exit(fails ? 1 : 0);
  })
  .catch(e => { console.error('예외:', e); process.exit(1); });

let fails = 0;
function check(label, got, want) {
  const ok = got === want;
  if (!ok) { fails++; console.log(`X ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
  else console.log(`  ok  ${label}`);
}
