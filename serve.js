/* serve.js — 의존성 없는 정적 서버.
   왜 필요한가: file:// 로 열면 브라우저마다 저장소 API가 제각각 막힌다.
   http://localhost 는 보안 컨텍스트이면서 정상 오리진이라 FSA·OPFS·IndexedDB 가 전부 열린다.
   iOS 도 서빙이 필수라 어차피 있어야 한다.

   실행:  node serve.js [포트]        (기본 8777)
   또는:  serve.cmd 더블클릭 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8777;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  // 루트 밖으로 나가는 경로는 거부한다.
  const full = path.join(ROOT, path.normalize(rel));
  if (!full.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('없는 파일: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    }).end(buf);
  });
});

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(name => {
    (ifaces[name] || []).forEach(i => {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    });
  });
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  세계관 맵 —  ' + ROOT);
  console.log('');
  console.log('  이 PC        http://localhost:' + PORT);
  lanAddresses().forEach(a => {
    console.log('  같은 와이파이 http://' + a + ':' + PORT);
  });
  console.log('');
  console.log('  * localhost 는 보안 컨텍스트라 폴더 저장(FSA)이 전부 열립니다.');
  console.log('  * 아이패드에서 위 LAN 주소로 열면 화면은 뜨지만, 평문 http 는');
  console.log('    보안 컨텍스트가 아니라 OPFS 가 막혀 임시 모드로 돕니다.');
  console.log('    아이패드에서 제대로 저장하려면 https 가 필요합니다 (SPEC 12장).');
  console.log('');
  console.log('  Ctrl+C 로 종료');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('포트 ' + PORT + ' 가 이미 쓰이고 있습니다. 다른 포트로: node serve.js 8888');
  } else console.error(e.message);
  process.exit(1);
});
