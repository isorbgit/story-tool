/* build.js — index.html 과 딸린 파일 전부를 파일 하나로 합친다.

   왜 필요한가: 앱은 index.html + style.css + js/ 18개다. 아이패드로 옮길 때
   폴더째 옮기기가 번거롭고, 파일 앱에서 연 file:// 페이지가 형제 파일을 읽어 줄지도
   불확실하다. 한 파일이면 그 문제가 통째로 사라진다.

   빌드 도구는 쓰지 않는다(SPEC 1.3). 하는 일은 <link>/<script src> 를 그 자리에
   내용으로 바꿔 끼우는 것뿐이고, 순서도 원본 그대로 지킨다.

   실행:  build.cmd  또는  node build.js  */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'index.html');
const OUT = path.join(ROOT, 'worldmap-single.html');

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) throw new Error('없는 파일: ' + rel);
  return fs.readFileSync(p, 'utf8');
}

/* 인라인한 코드 안에 </script> 가 들어 있으면 파서가 거기서 스크립트를 끊는다.
   문자열이나 주석 속이어도 마찬가지라, 태그로 보일 수 있는 형태만 무해하게 쪼갠다. */
function safeForScript(js) {
  return js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}
function safeForStyle(css) {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}

function build() {
  let html = read('index.html');
  const used = [];

  html = html.replace(/[ \t]*<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>/gi, (m, href) => {
    used.push(href);
    return '<style>\n' + safeForStyle(read(href)).trimEnd() + '\n</style>';
  });

  html = html.replace(/[ \t]*<script\s+src="([^"]+)"\s*><\/script>/gi, (m, src) => {
    used.push(src);
    return '<script>\n/* ===== ' + src + ' ===== */\n' + safeForScript(read(src)).trimEnd() + '\n</script>';
  });

  if (!used.length) throw new Error('index.html 에서 인라인할 <link>/<script> 를 못 찾았습니다.');

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  html = html.replace(/<head>/i,
    '<head>\n<!-- build.js 가 ' + stamp + ' 에 ' + used.length +
    '개 파일을 합쳐 만든 단일 파일입니다. 여기서 고치지 말고 원본을 고친 뒤 다시 빌드하세요. -->');

  fs.writeFileSync(OUT, html, 'utf8');
  return { used, bytes: Buffer.byteLength(html, 'utf8') };
}

try {
  const r = build();
  console.log('합친 파일 ' + r.used.length + '개:');
  r.used.forEach(f => console.log('   ' + f));
  console.log('\n→ ' + path.basename(OUT) + '  (' + (r.bytes / 1024).toFixed(1) + ' KB)');
  console.log('\n이 파일 하나만 아이패드로 옮기면 됩니다.');
} catch (e) {
  console.error('빌드 실패: ' + e.message);
  process.exit(1);
}
