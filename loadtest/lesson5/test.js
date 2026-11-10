import http from 'k6/http';
import { check } from 'k6';

// 사용: k6 run -e TARGET=slow -e RATE=5 test.js
const BASE = __ENV.BASE || 'http://localhost:3100';
const TARGET = '/' + (__ENV.TARGET || 'slow').replace(/^\/+/, ''); // Git Bash 경로 변환 회피: TARGET=slow 처럼 슬래시 없이
const RATE = Number(__ENV.RATE || 5);

export const options = {
  scenarios: {
    main: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 50,
      maxVUs: 500,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<200'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const res = http.get(`${BASE}${TARGET}`);
  check(res, {
    '상태 코드 200': (r) => r.status === 200,
    '응답 내용 ok': (r) => r.body === 'ok',
  });
}
