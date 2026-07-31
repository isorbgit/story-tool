/* _prompt.js — 터미널에서 한 줄 받기. supabase-* 스크립트가 함께 쓴다.

   한 번 데인 곳이라 적어 둔다.
   raw 모드(비밀번호)는 키를 하나씩 주지만, 일반 모드(y/N)는 **엔터를 누른 순간
   "y\r\n" 을 통째로 한 덩어리로** 준다. 그래서 들어온 것을 개행 문자 하나와
   비교하면 일반 모드에서는 영영 일치하지 않고 그대로 멈춘다.
   붙여넣기를 하면 raw 모드에서도 여러 글자가 한 번에 온다.

   그래서 낱글자를 비교하지 않고 **버퍼 안에 개행이 있는지**로 판정한다.
   두 모드와 붙여넣기가 같은 코드로 처리된다. */

'use strict';

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const EOT = String.fromCharCode(4);
const ETX = String.fromCharCode(3);      // Ctrl+C
const DEL = String.fromCharCode(127);
const BS = String.fromCharCode(8);

/**
 * @param {string} prompt  화면에 띄울 문구
 * @param {boolean} hidden 입력을 화면에 찍지 않는다 (비밀번호)
 */
function ask(prompt, hidden) {
  return new Promise(function (resolve) {
    const stdin = process.stdin;
    stdin.setEncoding('utf8');

    // 파이프로 넣은 경우 — 첫 줄만 쓴다
    if (!stdin.isTTY) {
      let piped = '';
      stdin.on('data', function (d) { piped += d; });
      stdin.on('end', function () {
        stdin.pause();
        resolve(piped.split(LF)[0].replace(CR, ''));
      });
      return;
    }

    process.stdout.write(prompt);
    if (hidden) stdin.setRawMode(true);
    stdin.resume();

    let buf = '';
    function finish() {
      if (hidden) stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write(LF);
      // 개행 앞까지가 답이다
      const cut = buf.search(/[\r\n]/);
      resolve((cut >= 0 ? buf.slice(0, cut) : buf).trim());
    }

    function onData(chunk) {
      if (chunk.indexOf(ETX) >= 0) {
        if (hidden) stdin.setRawMode(false);
        process.stdout.write(LF);
        process.exit(130);
      }

      for (const ch of chunk) {
        if (ch === DEL || ch === BS) {
          if (buf.length) {
            buf = buf.slice(0, -1);
            if (!hidden) process.stdout.write('\b \b');
          }
        } else {
          buf += ch;
          if (!hidden && ch !== CR && ch !== LF) process.stdout.write(ch);
        }
      }

      // raw 모드든 일반 모드든, 붙여넣기든 — 개행이 보이면 끝이다
      if (/[\r\n]/.test(buf) || chunk.indexOf(EOT) >= 0) finish();
    }

    stdin.on('data', onData);
  });
}

module.exports = { ask: ask, LF: LF, CR: CR };
