#!/usr/bin/env bash
# 크롤 검수 기능 검증 (Verifier 가 루프마다 실행). 실패하면 0 이 아닌 코드로 끝난다.
#   bash scripts/verify-crawl-review.sh          # 순수 테스트만
#   bash scripts/verify-crawl-review.sh --db     # + 원격 DB 통합 (test- 배치 생성 후 삭제)
set -u
cd "$(dirname "$0")/.."
fail=0
step() { echo "== $1"; shift; if "$@" > /tmp/verify_step.log 2>&1; then echo "   통과"; else echo "   실패"; tail -15 /tmp/verify_step.log; fail=1; fi; }

step "orchestrator 타입체크" npx --prefix orchestrator tsc -p orchestrator/tsconfig.json --noEmit
step "web 타입체크" npx --prefix web tsc -p web/tsconfig.json --noEmit
if [ "${1:-}" = "--db" ]; then
  step "orchestrator 테스트 (+DB)" env CRAWL_REVIEW_DB_TEST=1 npm --prefix orchestrator test
else
  step "orchestrator 테스트" npm --prefix orchestrator test
fi
DBENV=""; [ "${1:-}" = "--db" ] && DBENV="CRAWL_REVIEW_DB_TEST=1"
step "crawler 테스트" bash -c "cd crawler && env $DBENV .venv/Scripts/python -m unittest discover -s tests -q"
# 헌법 1조: 구버전 Gemini SDK 금지
step "구버전 SDK 없음" bash -c "! grep -rn --include=*.ts '@google/generative-ai\|getGenerativeModel' orchestrator/src mcp-server/src shared web/src"
exit $fail
