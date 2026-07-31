/* prompt.test.js — node test/prompt.test.js

   한 번 물린 곳을 못박는다. 일반 모드에서는 엔터를 누른 순간 "y\r\n" 이 통째로
   한 덩어리로 들어온다. 들어온 것을 개행 문자 하나와 비교하면 영영 일치하지
   않아 프롬프트가 그대로 멈춘다. 실제로 그렇게 멈췄다. */

'use strict';

const { EventEmitter } = require('events');

let fails = 0;
const log = [];                       // stdout 을 스텁하는 동안의 출력이 삼켜지므로 모아 둔다
function check(label, got, want) {
  const ok = got === want;
  if (!ok) { fails++; log.push(`X  ${label}  got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`); }
  else log.push(`  ok  ${label}`);
}

/** process.stdin 을 가짜 터미널로 바꾼다. */
function fakeTty() {
  const s = new EventEmitter();
  s.isTTY = true;
  s.setEncoding = () => {};
  s.setRawMode = () => {};
  s.resume = () => {};
  s.pause = () => {};
  return s;
}

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
const realWrite = process.stdout.write.bind(process.stdout);
function withStdin(fake, fn) {
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  process.stdout.write = () => true;                 // 프롬프트 출력은 삼킨다
  return fn().finally(() => {
    process.stdout.write = realWrite;
    Object.defineProperty(process, 'stdin', realStdin);
  });
}

const { ask } = require('./_prompt.js');

async function main() {
  // 1. 일반 모드 — 한 덩어리로 들어온다 (여기서 멈췄었다)
  let s = fakeTty();
  await withStdin(s, async () => {
    const p = ask('덮어쓸까요? (y/N) ', false);
    setImmediate(() => s.emit('data', 'y\r\n'));
    check('일반 모드: "y\\r\\n" 한 덩어리', await p, 'y');
  });

  // 2. 일반 모드 — LF 만
  s = fakeTty();
  await withStdin(s, async () => {
    const p = ask('? ', false);
    setImmediate(() => s.emit('data', 'yes\n'));
    check('일반 모드: LF 만', await p, 'yes');
  });

  // 3. raw 모드 — 한 글자씩
  s = fakeTty();
  await withStdin(s, async () => {
    const p = ask('pw: ', true);
    setImmediate(() => {
      for (const ch of 'abc') s.emit('data', ch);
      s.emit('data', '\r');
    });
    check('raw 모드: 한 글자씩', await p, 'abc');
  });

  // 4. raw 모드 — 붙여넣기로 여러 글자가 한 번에
  s = fakeTty();
  await withStdin(s, async () => {
    const p = ask('pw: ', true);
    setImmediate(() => s.emit('data', 'pasted-secret\r'));
    check('raw 모드: 붙여넣기', await p, 'pasted-secret');
  });

  // 5. 백스페이스
  s = fakeTty();
  await withStdin(s, async () => {
    const p = ask('pw: ', true);
    setImmediate(() => {
      for (const ch of 'abX') s.emit('data', ch);
      s.emit('data', String.fromCharCode(127));
      s.emit('data', 'c\r');
    });
    check('백스페이스', await p, 'abc');
  });

  // 6. 개행 뒤에 딸려온 것은 버린다
  s = fakeTty();
  await withStdin(s, async () => {
    const p = ask('? ', false);
    setImmediate(() => s.emit('data', 'y\r\nnext-line-junk'));
    check('개행 뒤는 버린다', await p, 'y');
  });

  log.forEach(function (l) { console.log(l); });
  console.log(fails ? `\n실패 ${fails}건` : '\n전부 통과');
  process.exitCode = fails ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
