import http from 'k6/http';
import { check } from 'k6';

export const options = {
  // [레슨 4] 부하의 모양
  scenarios: {
    main: {
      executor: 'constant-arrival-rate', // [레슨 4] 열린 모델: 매초 정해진 수가 도착
      rate: 250,                // 1초에 5개 요청
      timeUnit: '1s',
      duration: '30s',        // 30초 동안
      preAllocatedVUs: 50,    // 미리 준비해 둘 가상 사용자 수
      maxVUs: 500,            // 부족하면 여기까지 늘림
    },
  },

  // [레슨 3] SLO: 테스트 끝에 통과/실패를 자동 판정
  thresholds: {
    http_req_failed: ['rate<0.01'],     // 에러율 1% 미만
    http_req_duration: ['p(95)<200'],   // p95 200ms 미만
  },

  // [레슨 2] 결과에 p50(med), p95, p99를 보여 달라
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const res = http.get('http://localhost:3000/work');

  // [레슨 3] 실패의 정의: 내가 기대한 응답인가
  check(res, {
    '상태 코드 200': (r) => r.status === 200,
    '응답 내용 ok': (r) => r.body === 'ok',
  });
}