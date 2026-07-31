/* supabase-login.js — 로그인해서 실제로 읽고 쓸 수 있는지 끝까지 확인한다.

     node test/supabase-login.js <프로젝트URL> <anon key> <이메일>

   비밀번호는 인자로 받지 않는다. 실행하면 물어본다 — 명령 기록에 남지 않게.

   supabase-check.js 는 **익명이 막혀 있는지**만 본다. 그건 anon key 만으로 되는
   검사다. 이 스크립트는 반대쪽, **로그인한 내가 되는지**를 본다. 둘 다 통과해야
   설정이 끝난 것이다.

   어느 단계에서 멈추는지가 곧 진단이다:
       로그인 실패   → 이메일·비밀번호, 또는 사용자 미확인(Auto Confirm)
       쓰기 실패     → 정책의 with check 절
       읽기 실패     → 정책의 using 절
       목록·삭제 실패 → 백업 로테이션이 이것들을 쓴다 */

'use strict';

const [, , URL_ARG, KEY, EMAIL] = process.argv;
if (!URL_ARG || !KEY || !EMAIL) {
  console.error('사용법: node test/supabase-login.js <프로젝트URL> <anon key> <이메일>');
  process.exit(2);
}

let API = URL_ARG.replace(/\/+$/, '');
const dash = API.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
if (dash) {
  API = 'https://' + dash[1] + '.supabase.co';
  console.log('! 대시보드 주소를 API 주소로 바꿨습니다: ' + API);
  console.log('  앱에도 이 주소를 넣어야 합니다.');
}
const BUCKET = process.env.WM_BUCKET || 'worldmap';

/* 제어문자는 코드로 쓴다. 소스에 그대로 박으면 편집 도구를 거치며 깨진다. */
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const EOT = String.fromCharCode(4);
const ETX = String.fromCharCode(3);          // Ctrl+C
const DEL = String.fromCharCode(127);
const BS = String.fromCharCode(8);

/** 비밀번호를 화면에 남기지 않고 받는다. 파이프로 넣어도 된다. */
function askPassword() {
  return new Promise(function (resolve) {
    const stdin = process.stdin;
    stdin.setEncoding('utf8');

    if (!stdin.isTTY) {                       // echo pw | node ... 로 넣는 경우
      let piped = '';
      stdin.on('data', function (d) { piped += d; });
      stdin.on('end', function () { stdin.pause(); resolve(piped.split(LF)[0].replace(CR, '')); });
      return;
    }

    process.stdout.write(EMAIL + ' 의 비밀번호: ');
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    stdin.on('data', function onData(ch) {
      if (ch === LF || ch === CR || ch === EOT) {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write(LF);
        resolve(buf);
      } else if (ch === ETX) {
        stdin.setRawMode(false);
        process.stdout.write(LF);
        process.exit(130);
      } else if (ch === DEL || ch === BS) {
        buf = buf.slice(0, -1);
      } else {
        buf += ch;
      }
    });
  });
}

function step(ok, label, detail) {
  console.log('  ' + (ok ? 'ok ' : 'X  ') + label + (detail ? LF + '        ' + detail : ''));
  return ok;
}

async function main() {
  const password = (await askPassword()).trim();
  if (!password) { console.error('비밀번호가 비었습니다.'); process.exit(2); }

  console.log(LF + '대상 ' + API + '  ·  버킷 ' + BUCKET + LF);

  // 1. 로그인
  const r1 = await fetch(API + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: password })
  });
  const j1 = await r1.json().catch(function () { return {}; });

  if (!r1.ok) {
    const msg = j1.error_description || j1.msg || j1.message || ('HTTP ' + r1.status);
    step(false, '로그인', msg);
    if (/not confirmed/i.test(msg)) {
      console.log(LF + '        → 사용자가 확인되지 않았습니다.');
      console.log('          Authentication → Users → 해당 사용자 → Confirm email');
      console.log('          또는 지우고 Add user 할 때 Auto Confirm User 를 켜세요.');
    } else if (/invalid/i.test(msg)) {
      console.log(LF + '        → 이메일 또는 비밀번호가 다릅니다.');
    } else if (/signups? not allowed|disabled/i.test(msg)) {
      console.log(LF + '        → 가입이 막혀 있는데 사용자가 없는 상태로 보입니다.');
    }
    process.exitCode = 1;
    return;
  }

  const token = j1.access_token;
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
  step(true, '로그인');
  step(!!claims.email, '토큰 클레임  role=' + claims.role + '  email=' + (claims.email || '(없음)'),
    claims.email ? '' : '토큰에 email 이 없어 이메일로 건 정책이 통하지 않습니다');

  const H = { apikey: KEY, Authorization: 'Bearer ' + token };
  const probe = 'data/.probe-' + Date.now() + '.json';
  let bad = claims.email ? 0 : 1;

  // 2. 쓰기 (with check)
  const r2 = await fetch(API + '/storage/v1/object/' + BUCKET + '/' + probe, {
    method: 'POST',
    headers: Object.assign({}, H, { 'Content-Type': 'application/json', 'x-upsert': 'true' }),
    body: '{"probe":true}'
  });
  const t2 = await r2.text();
  if (!step(r2.ok, '쓰기 (HTTP ' + r2.status + ')',
    r2.ok ? '' : t2.slice(0, 200) + LF + '        → 정책의 with check 절을 보세요')) bad++;

  // 3. 읽기 (using)
  if (r2.ok) {
    const r3 = await fetch(API + '/storage/v1/object/' + BUCKET + '/' + probe, { headers: H, cache: 'no-store' });
    const t3 = await r3.text();
    if (!step(r3.ok && t3.indexOf('probe') >= 0, '읽기 (HTTP ' + r3.status + ')',
      r3.ok ? '' : t3.slice(0, 200) + LF + '        → 정책의 using 절을 보세요')) bad++;
  }

  // 4. 목록 — 백업 로테이션이 쓴다
  const r4 = await fetch(API + '/storage/v1/object/list/' + BUCKET, {
    method: 'POST',
    headers: Object.assign({}, H, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefix: 'data', limit: 50 })
  });
  const j4 = await r4.json().catch(function () { return null; });
  if (!step(r4.ok && Array.isArray(j4), '목록 (HTTP ' + r4.status + ', ' + (Array.isArray(j4) ? j4.length : '?') + '건)',
    r4.ok ? '' : '→ select 권한. 백업 로테이션이 이걸 씁니다')) bad++;

  // 5. 삭제 — 오래된 백업을 지울 때 쓴다
  const r5 = await fetch(API + '/storage/v1/object/' + BUCKET, {
    method: 'DELETE',
    headers: Object.assign({}, H, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefixes: [probe] })
  });
  if (!step(r5.ok, '삭제 (HTTP ' + r5.status + ')',
    r5.ok ? '' : '→ delete 권한. 오래된 백업을 못 지웁니다')) bad++;

  console.log(bad ? LF + '문제 ' + bad + '건.' : LF + '전부 통과 — 앱에서도 연결됩니다.');
  console.log(LF + '앱에 넣을 값:');
  console.log('  URL    ' + API);
  console.log('  버킷    ' + BUCKET);
  console.log('  이메일  ' + EMAIL);
  process.exitCode = bad ? 1 : 0;
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
