/* supabase-check.js — 원격 저장소 설정이 안전한지 실제로 눌러서 확인한다.

     node test/supabase-check.js <프로젝트URL> <anon key> [버킷=worldmap]

   이 프로젝트가 저장 어댑터를 고를 때 쓴 태도와 같다(SPEC 3.0) — 설정값을 보고
   넘겨짚지 않고 실제로 요청을 보내 본다.

   가장 중요한 검사는 "회원가입이 막혀 있는가" 다.
   anon key 는 공개 앱 안에 그대로 실린다. 그래서 정책을 auth.role()='authenticated'
   로 걸어두고 회원가입을 열어두면, 아무나 키를 꺼내 가입한 뒤 authenticated 가 되어
   전부 읽는다. 그 조합에서는 'authenticated' 가 경계 구실을 하지 못한다. */

'use strict';

const [, , URL_ARG, KEY, BUCKET = 'worldmap'] = process.argv;
if (!URL_ARG || !KEY) {
  console.error('사용법: node test/supabase-check.js <프로젝트URL> <anon key> [버킷]');
  console.error('예:     node test/supabase-check.js https://xxxx.supabase.co eyJhbG... worldmap');
  process.exit(2);
}

/* 대시보드 주소를 넣는 실수가 잦다. API 주소로 바로잡아 준다. */
let API = URL_ARG.replace(/\/+$/, '');
const dash = API.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
if (dash) {
  API = `https://${dash[1]}.supabase.co`;
  console.log(`! 대시보드 주소를 받았습니다. API 주소로 바꿔 검사합니다:\n  ${API}\n`);
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const results = [];
function record(ok, label, detail) {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? 'ok ' : 'X  '} ${label}${detail ? '\n        ' + detail : ''}`);
}

async function main() {
  console.log(`대상 ${API}  ·  버킷 ${BUCKET}\n`);

  // 0. 키가 anon 인지
  try {
    const p = JSON.parse(Buffer.from(KEY.split('.')[1], 'base64').toString());
    record(p.role === 'anon', `키 role = ${p.role}`,
      p.role !== 'anon' ? 'service_role 키는 절대 클라이언트에 넣지 않는다' : '');
    if (p.ref && !API.includes(p.ref)) {
      record(false, 'URL 과 키의 프로젝트가 다릅니다', `키의 ref=${p.ref}`);
    }
  } catch (e) {
    record(false, '키를 JWT 로 해석할 수 없습니다');
  }

  // 1. 프로젝트 도달
  let settings = null;
  try {
    const r = await fetch(`${API}/auth/v1/settings`, { headers: { apikey: KEY } });
    settings = r.ok ? await r.json() : null;
    record(r.ok, `프로젝트 도달 (HTTP ${r.status})`);
  } catch (e) {
    record(false, '프로젝트에 닿지 못했습니다', e.message);
    return done();
  }

  // 2. 회원가입 — 여기가 핵심이다
  if (settings) {
    record(settings.disable_signup === true, '회원가입 차단',
      settings.disable_signup === true ? ''
        : '열려 있습니다. 누구나 anon key 로 가입해 authenticated 가 됩니다.\n        ' +
          'Authentication → Sign In / Providers → "Allow new users to sign up" 끄기');
  }

  // 3. 버킷 존재
  const b = await fetch(`${API}/storage/v1/bucket/${BUCKET}`, { headers: H });
  const bj = await b.json().catch(() => null);
  const bucketExists = b.ok;
  record(bucketExists, `버킷 '${BUCKET}' 존재`,
    bucketExists ? (bj && bj.public ? '⚠ Public 버킷입니다 — 누구나 읽습니다' : 'private')
      : 'Storage → New bucket 에서 만드세요 (Public 체크 해제)');
  if (bucketExists && bj && bj.public) record(false, '버킷이 Public', '설정 → Public 해제');

  // 4. 익명 쓰기는 반드시 막혀야 한다
  const w = await fetch(`${API}/storage/v1/object/${BUCKET}/.probe-anon.txt`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'text/plain', 'x-upsert': 'true' }, body: 'probe'
  });
  const denied = w.status === 401 || w.status === 403 || w.status === 400;
  record(denied, `익명 쓰기 차단 (HTTP ${w.status})`,
    denied ? '' : '로그인 없이 쓰기가 됩니다. 정책을 다시 보세요.');
  if (!denied) {
    await fetch(`${API}/storage/v1/object/${BUCKET}/.probe-anon.txt`, { method: 'DELETE', headers: H })
      .catch(() => {});
  }

  // 5. 익명 읽기도 막혀야 한다
  const r5 = await fetch(`${API}/storage/v1/object/${BUCKET}/data/nodes.json`, { headers: H });
  const j5 = await r5.text();
  const readBlocked = !r5.ok;
  record(readBlocked, `익명 읽기 차단 (HTTP ${r5.status})`,
    readBlocked ? (j5.includes('NoSuchKey') ? '아직 파일이 없어 404 — 정책 판정은 데이터가 올라간 뒤 다시 볼 것' : '')
      : '로그인 없이 데이터가 읽힙니다.');

  // 6. 공개 경로
  const r6 = await fetch(`${API}/storage/v1/object/public/${BUCKET}/data/nodes.json`);
  record(!r6.ok, `공개 경로 차단 (HTTP ${r6.status})`);

  done();
}

function done() {
  const bad = results.filter(r => !r.ok);
  console.log(bad.length ? `\n문제 ${bad.length}건 — 위 안내대로 고친 뒤 다시 실행하세요.` : '\n전부 통과.');
  process.exit(bad.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
