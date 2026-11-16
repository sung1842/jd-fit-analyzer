const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// [레슨 6] 메트릭 변수들. 그냥 숫자 몇 개예요.
let totalRequests = 0;   // 카운터: 계속 증가만 함
let inFlight = 0;        // 게이지: 지금 처리 중인 수, 오르내림
let totalErrors = 0;     // 카운터

const fs = require('fs');
function getFailRate() {
  try { return parseFloat(fs.readFileSync('failrate.txt', 'utf8')); }
  catch { return 0.1; }  // 파일 없으면 기본 10%
}

http.createServer(async (req, res) => {
  totalRequests++;
  inFlight++;

  // [레슨 6] 메트릭을 보여주는 주소. 실제로는 Prometheus가 이 형식을 읽어갑니다.
  if (req.url === '/metrics') {
    inFlight--;
    res.setHeader('Content-Type', 'text/plain');
    return res.end(
      `total_requests ${totalRequests}\n` +
      `in_flight ${inFlight}\n` +
      `total_errors ${totalErrors}\n`
    );
  }

  if (req.url === '/slow') {
    await sleep(50 + Math.random() * 150);
    inFlight--;
    return res.end('ok');
  }

  if (req.url === '/work') {
    const end = Date.now() + 5;
    while (Date.now() < end) {}
    inFlight--;
    return res.end('ok');
  }

  if (req.url === '/flaky') {
    if (Math.random() < getFailRate()) {
      totalErrors++;
      res.statusCode = 500;
      inFlight--;
      return res.end('error');
    }
    inFlight--;
    return res.end('ok');
  }

  inFlight--;
  res.statusCode = 404;
  res.end('not found');
}).listen(3000, () => console.log('http://localhost:3000'));