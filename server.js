const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

http.createServer(async (req, res) => {
  // 항상 즉시 성공
  if (req.url === '/fast') return res.end('ok');

  // 50~200ms 사이 무작위로 기다렸다 성공 (DB 조회 흉내)
  if (req.url === '/slow') {
    await sleep(50 + Math.random() * 150);
    return res.end('ok');
  }

  // 10% 확률로 500 에러
  if (req.url === '/flaky') {
    if (Math.random() < 0.1) { res.statusCode = 500; return res.end('error'); }
    return res.end('ok');
  }

  // 요청마다 CPU를 5ms 점유 (처리 능력에 한계가 있는 서버)
  if (req.url === '/work') {
    const end = Date.now() + 5;
    while (Date.now() < end) {}
    return res.end('ok');
  }

  res.statusCode = 404;
  res.end('not found');
}).listen(3000, () => console.log('http://localhost:3000'));