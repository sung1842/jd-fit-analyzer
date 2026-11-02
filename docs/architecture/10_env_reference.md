# 10. 환경변수 레퍼런스

> CLAUDE.md 에서 이관(2026-10-24, 내용 동일). 키 추가·설정·배포 작업 때만 읽는다.
> 값은 출력·로그·커밋 금지. 루트 `.env.local` = mcp-server/orchestrator, `crawler/.env` = 크롤러 전용.

## 루트 `.env.local` (gitignore)

```env
# talentfolio Supabase (읽기 전용)
NEXT_PUBLIC_SUPABASE_URL=https://xbirvfebdwsjzohwoymm.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...

# 분석 에이전트용 (Gemini Flash, 저비용)
GEMINI_API_KEY=...

# CEO 에이전트용 (Claude Sonnet, 최종 판단)
ANTHROPIC_API_KEY=...

# 비동기 큐
REDIS_URL=redis://localhost:6379

# mcp-server (Streamable HTTP)
MCP_SERVER_PORT=3002
MCP_SERVER_URL=http://localhost:3002/mcp

# Langfuse (LLM 트레이싱, Phase 4 — 비워두면 비활성화)
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com

# Phase 5: B2B 사내 소싱 — Slack Bot Token (OAuth, chat:write scope 필요)
SLACK_BOT_TOKEN=xoxb-...

# Phase M2: Slack 인터랙티비티(승인 버튼 콜백) 서명 검증 (Basic Information > Signing Secret)
# 미설정 시 /api/slack/interactivity는 401. 변경 시 orchestrator 재시작 필수.
SLACK_SIGNING_SECRET=...

# Phase M2.5: auto-from-jd 기본 Slack 채널 (선택, 기본 #recruiting)
SLACK_DEFAULT_CHANNEL=#recruiting

# Phase M2.6: Slack Card Brief 링크·unfurl 기준 URL
TALENTFOLIO_URL=http://localhost:3000

# 재설계(08 문서): Single DB / JWT / 내부 키 / CORS / 리미터
SUPABASE_SERVICE_ROLE_KEY=      # talentfolio 프로젝트 service_role → fit 스키마 (미설정 시 FIT_ANALYZER_* legacy 폴백)
FIT_DB_SCHEMA=fit
AUTH_MODE=required              # talentfolio 가 Bearer 를 보내기 전까지는 legacy
MCP_INTERNAL_KEY=               # orchestrator↔mcp-server. 프로덕션 필수
CRAWL_ADMIN_PASSWORD=           # web /crawling 검수 비밀번호 (orchestrator 가 X-Admin-Password 와 비교). 없으면 검수 API 503
# 매칭 엔진 E2 (22 문서) — 모두 선택, 기본값 있음
# MATCH_NORM_VERSION=1              후보 정규화 버전. 올리면 다음 처리 때 전원 재정규화
# NARRATIVE_SAME_THRESHOLD=0.95     자유 서술 의미 지문 동일 판정 (코사인)
# NORMALIZE_DEBOUNCE_MS=600000      같은 후보 수정 디바운스
# NORMALIZE_DAILY_MAX=1             후보당 하루 재정규화 횟수 (관리자 force 는 무시)
# NORMALIZE_SWEEP_CRON=0 4 * * *    전체 후보 변경 감지 sweep 주기
# NORMALIZE_WORKER_CONCURRENCY=1
# 매칭 엔진 E3~E7 (22 문서) — 모두 선택, 기본값 있음
# JOB_NORM_VERSION=2                공고 정규화 버전 (택일 그룹·경험 문장). 올리면 공고 재정규화
# RANKING_WEIGHTS_CRON              층별 가중치 보정 주기 (기본 매주 월 05:00)
# WATCH_TICK_CRON / WATCH_DIGEST_CRON  상시 수색 점검(매시 20분) / 하루 요약(08:00)
# WATCH_DELTA_RATIO=0.7             하루 상한 중 신규·수정 후보 몫
# SCAN_BATCH=500                    전체 훑기 1회 후보 수
# WATCH_DRY_RUN=1                   잡 투입 안 함 (점검용)
# WATCH_REQUIRE_CONSENT=1           fit.consents(matching) 동의 후보만 (기본 off)
# WATCH_MAX_DAILY_CAP=100 / WATCH_MAX_DAYS=90  의뢰 건 설정 상한
# WATCH_SOURCING_CHANNEL            승인 대기 행에 기록할 채널
# WATCH_USER_DAILY_CAP=100          사용자 단위 하루 D 단계 합계 상한
# WATCH_DELTA_PAGE=2000             delta 한 번에 읽는 후보 수 (keyset)
# WATCH_APPROVAL_SEND_SLACK=1       상시 수색 승인 시 Slack 발송 (기본 off = 화면만)
# 구직자 공고 추천 (SQL 022·023) — 모두 선택, 기본값 있음
# RECOMMEND_TOP_N=20                사용자당 저장 건수
# RECOMMEND_SCAN_MAX=5000           한 번에 훑는 마감 전 공고 수
# RECOMMEND_DEDUP_MS=300000         같은 사용자 재계산 합치기
# RECOMMEND_SWEEP_CRON=0 5 * * *    야간 재계산 (새 공고 반영)
# RECOMMEND_ACTIVE_DAYS=14          야간 재계산 대상: 이 기간 안에 추천을 본 사용자만
CORS_ALLOWED_ORIGINS=           # 콤마 구분 배포 도메인. 미설정 시 개발만 localhost:3000, localhost:3010
GEMINI_RPM=5                    # 모델별 분당 호출 상한 (mcp-server)
FIT_WORKER_CONCURRENCY=3
# SUPABASE_DB_URL(크롤러 COPY 용 Postgres 직결, Session pooler)은 여기가 아니라 crawler/.env 에 둔다.
# 크롤러는 crawler/.env 만 읽는다 — Anthropic/Slack 키 등을 크롤러 프로세스에 넘기지 않기 위함.
ORCHESTRATOR_HOST=127.0.0.1 # orchestrator 바인드 주소 (기본 loopback)
# 아래는 전부 crawler/.env (상세: crawler/.env.example, 09 문서)
# CRAWLER_API_KEY= 크롤러 FastAPI x-internal-key. 없으면 서버 기동 거부. 루트 .env.local 에도 같은 값 → orchestrator 크롤 검수 "수집 실행"(crawl-run 잡)이 사용
# CRAWLER_URL= (orchestrator) 크롤러 주소. 기본 http://127.0.0.1:8010, compose 는 http://host.docker.internal:8010
# CRAWLER_ALLOW_NON_LOOPBACK=1 loopback 외 바인드 허용 시만
# CRAWLER_CONTACT= / CRAWLER_USER_AGENT= 사이트 어댑터 식별 UA (둘 중 하나 필수)
# CRAWL_DELAY_MIN=3 / CRAWL_DELAY_MAX=7 사이트 어댑터 랜덤 지연(초)
```

> RLS 정책상 `profiles` 테이블은 모든 유저 SELECT 가능 → anon key로 읽기 전용 조회 가능
