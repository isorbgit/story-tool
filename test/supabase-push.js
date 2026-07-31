/* push-remote.js — data/ 를 원격 저장소로 올린다.

     node test/supabase-push.js <프로젝트URL> <anon key> <이메일>

   비밀번호는 인자로 받지 않는다. 실행하면 묻는다.

   왜 브라우저 밖에서 올리는가 —
   원격이 비어 있는 동안에는 앱의 어느 경로로 들어가든 "빈 저장소" 라는 애매한
   상태를 통과해야 한다. 한 번 채워 두면 그 상태 자체가 없어지고, 이후로는
   읽어서 열기만 하면 된다. 첫 씨앗은 밖에서 심는 편이 확실하다.

   덮어쓰기다. 원격에 이미 데이터가 있으면 먼저 알려주고 물어본다. */

'use strict';

const fs = require('fs');
const path = require('path');

const [, , URL_ARG, KEY, EMAIL] = process.argv;
if (!URL_ARG || !KEY || !EMAIL) {
  console.error('사용법: node test/supabase-push.js <프로젝트URL> <anon key> <이메일>');
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const FILES = ['schema.json', 'nodes.json', 'edges.json', 'canvases.json'];
const BUCKET = process.env.WM_BUCKET || 'worldmap';

let API = URL_ARG.replace(/\/+$/, '');
const dash = API.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
if (dash) API = 'https://' + dash[1] + '.supabase.co';

const { ask, LF } = require('./_prompt.js');

async function main() {
  // 올릴 것이 실제로 있는지 먼저 본다. 빈 것을 올려 원격을 덮으면 안 된다.
  const payload = {};
  for (const f of FILES) {
    const p = path.join(DATA, f);
    if (!fs.existsSync(p)) { console.error('없는 파일: data/' + f); process.exit(1); }
    const text = fs.readFileSync(p, 'utf8');
    const n = Object.keys(JSON.parse(text)).length;
    payload[f] = text;
    console.log('  data/' + f.padEnd(15) + String(n).padStart(4) + '개');
  }
  if (Object.keys(JSON.parse(payload['nodes.json'])).length === 0) {
    console.error(LF + 'nodes.json 이 비어 있습니다. 올리지 않습니다.');
    process.exit(1);
  }

  const password = (process.env.WM_PASSWORD || await ask(LF + EMAIL + ' 의 비밀번호: ', true)).trim();
  if (!password) {
    console.error('비밀번호를 받지 못했습니다. 진짜 터미널 창에서 실행하세요.');
    process.exit(2);
  }

  const r1 = await fetch(API + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: password })
  });
  const j1 = await r1.json().catch(function () { return {}; });
  if (!r1.ok) {
    console.error('로그인 실패: ' + (j1.error_description || j1.msg || j1.message || r1.status));
    process.exit(1);
  }
  const H = { apikey: KEY, Authorization: 'Bearer ' + j1.access_token };
  console.log(LF + '로그인 OK');

  // 원격에 이미 있으면 덮기 전에 알린다.
  const chk = await fetch(API + '/storage/v1/object/' + BUCKET + '/data/nodes.json', { headers: H, cache: 'no-store' });
  if (chk.ok) {
    const existing = Object.keys(JSON.parse(await chk.text())).length;
    const yn = (await ask('원격에 이미 노드 ' + existing + '개가 있습니다. 덮어쓸까요? (y/N) ', false)).trim().toLowerCase();
    if (yn !== 'y') { console.log('취소했습니다.'); process.exit(0); }
  }

  for (const f of FILES) {
    const r = await fetch(API + '/storage/v1/object/' + BUCKET + '/data/' + f, {
      method: 'POST',
      headers: Object.assign({}, H, { 'Content-Type': 'application/json', 'x-upsert': 'true' }),
      body: payload[f]
    });
    if (!r.ok) {
      console.error('  X ' + f + ' 실패 (' + r.status + ') ' + (await r.text()).slice(0, 200));
      console.error(LF + '정책의 with check 절을 보세요.');
      process.exit(1);
    }
    console.log('  올림  data/' + f);
  }

  // 되읽어서 확인한다. 올렸다고 믿지 않는다.
  const back = await fetch(API + '/storage/v1/object/' + BUCKET + '/data/nodes.json', { headers: H, cache: 'no-store' });
  if (!back.ok) {
    console.error(LF + '올린 뒤 되읽기 실패 — 정책의 using 절을 보세요.');
    process.exit(1);
  }
  const n = Object.keys(JSON.parse(await back.text())).length;
  console.log(LF + '확인 — 원격에서 노드 ' + n + '개를 되읽었습니다.');
  console.log(LF + '이제 앱에서 [원격 저장소 연결] 하면 이 데이터가 열립니다.');
}

main().catch(function (e) { console.error(e); process.exitCode = 1; });
