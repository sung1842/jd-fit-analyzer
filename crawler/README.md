# crawler — 채용공고 수집기 (Python, 웹 서버와 완전 분리)

파이프라인: **source adapter → JobPosting 정규화 → CSV → sanity gate → `COPY fit.job_postings_staging` → `fit.merge_job_postings()` upsert** (사이트 스키마 경로)
board_a 는 플랫폼 전용 경로: **`platforms/board_a.py` 직접 크롤 → JSON(+partial/plan) → `platform-load` → `fit.crawled_postings`**

웹/오케스트레이터는 이 프로세스를 호출하지 않는다. DB(`fit.job_postings`)만 공유한다 (08 문서 v2-3).
설계·결정·법적 조사·사이트 추가 절차는 [docs/architecture/09_crawler_pipeline.md](../docs/architecture/09_crawler_pipeline.md).

> **현재 상태 (2026-10-25)**: board_a 는 직접 크롤(`platform board_a`)로 10건 적재 완료. Crawl4AI 사이트 스키마 어댑터는 실사이트 미실행. 이 PC 에 Playwright 브라우저 미설치(`python -m playwright install chromium`).

## 설치

```powershell
cd crawler
python -m venv .venv; .venv\Scripts\activate
pip install -r requirements.txt
crawl4ai-setup                                      # Playwright 브라우저 설치 (site 어댑터 쓸 때만)
copy .env.example .env                              # 아래 env 채우기
```

`SUPABASE_DB_URL` 은 **Postgres 직결 문자열**이다 (Dashboard → Connect → Session pooler, 5432). PostgREST 로는 COPY 가 안 된다.
사전 조건: talentfolio 프로젝트에 `docs/architecture/sql/010_single_db_fit_schema.sql` 적용.
크롤러는 `crawler/.env` 만 읽는다 (루트 `.env.local` 의 Anthropic/Slack 키 등을 이 프로세스에 넘기지 않기 위함).

## 환경변수 (`crawler/.env`)

| 변수 | 필수 | 설명 |
|---|---|---|
| `SUPABASE_DB_URL` | 적재 시 | Postgres 직결. 자식 크롤 프로세스에는 전달되지 않음 |
| `FIT_DB_SCHEMA` | | 기본 `fit` |
| `CRAWLER_API_KEY` | **서버 기동 시** | `x-internal-key` 값. 없으면 서버 기동 거부(fail-closed). `MCP_INTERNAL_KEY` 폴백 없음 |
| `CRAWLER_API_HOST` / `CRAWLER_API_PORT` | | 기본 `127.0.0.1` / `8010` |
| `CRAWLER_ALLOW_NON_LOOPBACK` | | `1` 이어야 loopback 외 바인드 허용 |
| `CRAWLER_CONTACT` 또는 `CRAWLER_USER_AGENT` | site | 식별 UA. 둘 다 없으면 사이트 어댑터 거부 |
| `CRAWL_DELAY_MIN` / `CRAWL_DELAY_MAX` | | 사이트 어댑터 랜덤 지연(초), 기본 3~7 |

## HTTP 트리거 (FastAPI, 127.0.0.1:8010)

CLI 와 같은 함수를 호출한다. 오케스트레이터(BullMQ)와 talentfolio 를 대체하지 않는다.

**기동 조건**: `CRAWLER_API_KEY` 가 있어야 한다(없으면 기동 거부). 호스트가 `127.0.0.1`/`::1`/`localhost` 가 아니면 `CRAWLER_ALLOW_NON_LOOPBACK=1` 도 필요하다.

```powershell
cd crawler; .venv\Scripts\python -m jdcrawler.server
```

모든 요청에 헤더 `x-internal-key: <CRAWLER_API_KEY>` 가 필요하다 (`GET /health` 만 키 불필요 — 2026-10-20 시점 `server.py` 기준).

```powershell
# board_a 수집 + 적재 (gate 통과 시에만 적재)
curl.exe -X POST http://127.0.0.1:8010/v1/trigger `
  -H "x-internal-key: <CRAWLER_API_KEY>" -H "Content-Type: application/json" `
  -d '{\"source\":\"site\",\"schema_name\":\"example_board.json\",\"max\":50,\"load\":true}'
# → 202 {"job_id":"...","status":"..."}   같은 작업이 진행 중이면 409

# 상태 조회
curl.exe http://127.0.0.1:8010/v1/jobs/<job_id> -H "x-internal-key: <CRAWLER_API_KEY>"
```

| 필드 | 설명 |
|---|---|
| `source` | `"site"` (필수. board_a 웹 크롤은 아직 트리거에 미연결 — CLI 사용) |
| `max` | 1..500, 기본 200 |
| `schema_name` | `source=site` 일 때 필수 (`schemas/` 의 스키마) |
| `load` | 기본 `true`. `false` 면 CSV 만 생성 |
| `timeout_sec` | 60..7200. 기본 board_a 900 / site 3600. 초과 시 프로세스 트리 kill |

크롤은 **자식 프로세스**(환경변수 허용목록, DB URL·내부 키 제외, `JDCRAWLER_SKIP_DOTENV=1`)에서 돈다. 적재(COPY→merge)는 부모가 gate 통과 후에만 한다.
기존 `/v1/site`, `/v1/load` 도 있다.

### sanity gate

fetched==0(`empty`), 필수필드(title + http(s) url) 유효율<0.9(`low_valid_ratio`), crawl4ai 소스 description 짧음 비율>0.4(`low_desc_ratio`), CSV 헤더 불일치(`bad_csv`) 중 하나라도 걸리면 **적재하지 않고 CSV 를 보존**한다. 최근 7회 중앙값의 30% 미만이면 경고만 한다. 히스토리: `crawler/out/_history.json`. gate 는 구조만 본다 — 내용의 정확성은 검증하지 못한다.

## CLI 실행

```powershell
# board_a 직접 크롤 (최대 100건, 관련도순 목록 → 최신순 정렬). 멈추면 출력의 resume 명령으로 이어 받기
python -m jdcrawler platform board_a --max 100
python -m jdcrawler platform board_a --resume out/board_a_postings_<ts>
python -m jdcrawler platform-load board_a out/board_a_postings_<ts>.json --compressed out/board_a_postings_<ts>_compressed.json

# Crawl4AI + CSS 스키마 (LLM 미사용). 스키마에 enabled:true + legal_basis 가 있어야 실행된다.
# 먼저 --headful --max 5 로 셀렉터 검증. 사이트 추가 절차는 09 문서 §8
python -m jdcrawler site schemas/example_board.json --headful --max 5

# CSV 만 다시 적재
python -m jdcrawler load out/site-20261019T130000Z.csv --batch site-20261019T130000Z
```

출력은 JSON 한 덩어리: `{batch_id, fetched, csv_rows, copied, inserted, updated, skipped, elapsed_sec}`.

## 하지 않는 것

- **LinkedIn**: 어댑터 없음. authwall + 자동화 금지 약관 + 개인정보. Crawl4AI 로 "돌파"하는 건 가능하지도, 합법적이지도 않다.
- **board_a Open API**: 쓰지 않는다(2026-10-24 결정, 코드 2026-10-25 삭제). 직접 크롤의 법적 전제는 09 문서 §7.
- **프록시 로테이션·UA 랜덤화·무료 공용 프록시**: 의도적으로 미구현. 식별 가능한 UA + robots 준수 + 느린 속도가 기본선이다 (09 문서 §5).
- **LLM 추출**: 셀렉터로 못 뽑는 사이트는 스키마를 고친다. LLM 에 HTML 을 던지는 순간 비용·환각·비결정성이 들어온다.

## 검증

```powershell
cd crawler
.venv\Scripts\python -m unittest discover -s tests -t .
python -m py_compile jdcrawler/*.py jdcrawler/sources/*.py     # PowerShell 은 와일드카드를 확장하지 않을 수 있음 → 실패하면 파일별로
# 적재 후
psql "$env:SUPABASE_DB_URL" -c "select source, count(*), max(last_seen_at) from fit.job_postings group by 1"
```
