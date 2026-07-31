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

  /* 3+4. 버킷 존재와 익명 쓰기 차단을 한 번에.

     GET /storage/v1/bucket/<name> 으로는 판정할 수 없다. 버킷 메타데이터를 읽으려면
     storage.buckets 에 SELECT 정책이 있어야 하는데, 우리 정책은 storage.objects 에만
     걸려 있고 그게 맞다. 권한이 없으면 Supabase 는 404 NoSuchBucket 으로 가려서
     "버킷이 없다" 와 "메타데이터를 못 본다" 가 똑같이 보인다.

     대신 쓰기를 실제로 시도해 **어디서 막히는지**를 본다. 없는 버킷 이름과 나란히
     찔러 보고 응답이 다른 것을 확인한다.
         버킷 있음 + 정책 정상 → 403 AccessDenied (버킷을 찾고 정책에서 막힘)
         버킷 없음            → 404 NoSuchBucket (버킷 단계에서 막힘) */
  async function probeWrite(bucket) {
    const r = await fetch(`${API}/storage/v1/object/${bucket}/.probe-anon.txt`, {
      method: 'POST', headers: { ...H, 'Content-Type': 'text/plain', 'x-upsert': 'true' }, body: 'probe'
    });
    let code = '';
    try { code = (await r.json()).code || ''; } catch (e) { /* 성공이면 본문이 다르다 */ }
    return { status: r.status, code, ok: r.ok };
  }

  const mine = await probeWrite(BUCKET);
  const ghost = await probeWrite('zzz-' + Math.random().toString(36).slice(2) + '-nope');

  if (mine.ok) {
    record(false, '익명 쓰기가 됩니다', '로그인 없이 쓰기가 허용돼 있습니다. 정책을 다시 보세요.');
    await fetch(`${API}/storage/v1/object/${BUCKET}/.probe-anon.txt`, { method: 'DELETE', headers: H }).catch(() => {});
    record(true, `버킷 '${BUCKET}' 존재`);
  } else if (mine.code === 'NoSuchBucket' && ghost.code === 'NoSuchBucket') {
    record(false, `버킷 '${BUCKET}' 존재`, 'Storage → New bucket 에서 만드세요 (Public 체크 해제)');
  } else {
    record(mine.code !== 'NoSuchBucket', `버킷 '${BUCKET}' 존재`,
      `없는 버킷은 ${ghost.code}, 이 버킷은 ${mine.code} — 버킷 단계를 지나 정책에서 막혔다`);
    record(true, `익명 쓰기 차단 (HTTP ${mine.status} ${mine.code})`);
  }

  // 5. 익명 읽기
  const r5 = await fetch(`${API}/storage/v1/object/${BUCKET}/data/nodes.json`, { headers: H });
  const t5 = await r5.text();
  record(!r5.ok, `익명 읽기 차단 (HTTP ${r5.status})`,
    !r5.ok
      ? (t5.includes('NoSuchKey') ? '아직 파일이 없어 404 — 데이터가 올라간 뒤 다시 볼 것' : '')
      : '로그인 없이 데이터가 읽힙니다.');

  /* 6. 공개 버킷인가.
     private 이면 공개 경로 자체가 NoSuchBucket 이다. 버킷이 public 이면 여기까지
     들어와 NoSuchKey(파일 없음)나 200 이 나온다 — 그건 누구나 읽는다는 뜻이다. */
  const r6 = await fetch(`${API}/storage/v1/object/public/${BUCKET}/data/nodes.json`);
  const t6 = await r6.text();
  const isPublic = r6.ok || t6.includes('NoSuchKey');
  record(!isPublic, '버킷이 private',
    isPublic ? '⚠ Public 버킷입니다 — 정책과 무관하게 누구나 읽습니다. Public 해제하세요.' : '');

  done();
}

function done() {
  const bad = results.filter(r => !r.ok);
  console.log(bad.length ? `\n문제 ${bad.length}건 — 위 안내대로 고친 뒤 다시 실행하세요.` : '\n전부 통과.');
  process.exit(bad.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
