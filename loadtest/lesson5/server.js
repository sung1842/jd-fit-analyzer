const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = process.env.PORT || 3100; // 3000 은 talentfolio 가 사용

http.createServer(async (req, res) => {
  if (req.url === '/fast') return res.end('ok');
  if (req.url === '/slow') {
    await sleep(50 + Math.random() * 150);
    return res.end('ok');
  }
  if (req.url === '/flaky') {
    if (Math.random() < 0.1) { res.statusCode = 500; return res.end('error'); }
    return res.end('ok');
  }
  if (req.url === '/work') {
    const end = Date.now() + 5;
    while (Date.now() < end) {}
    return res.end('ok');
  }
  res.statusCode = 404;
  res.end('not found');
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
