# 09. 크롤러 파이프라인 (수집 → CSV → gate → COPY → merge)

> 2026-10-20 기준. 표기 규칙: **[확인]** = 코드·원문·실행으로 확인함 / **[미확인]** = 확인 못 함 또는 추정.
> 이 문서의 코드 동작 설명은 작업 시점의 **명세**이며, 구현은 다른 작업자가 병행했다. 코드와 다르면 코드가 기준이고 이 문서를 고친다.
> **목적 (사용자 확정 2026-10-24)**: 더미·테스트 데이터 확보. 정확한 시스템은 정확한 데이터가 전제라 크롤러는 필수 기반이며 제외하지 않는다. 운영 데이터 원천은 플랫폼 내부 데이터.
> **수집 방식 (사용자 확정 2026-10-24)**: 사람인 Open API 는 쓰지 않고 **직접 크롤링**한다. API 는 추후 공공데이터(워크넷/고용24 등)가 필요한 부분에만 적용. 직접 크롤링 모듈: `crawler/jdcrawler/platforms/saramin.py` (플랫폼별 분리, 아래 §12 "플랫폼별 분리 구조" 참고. `python -m jdcrawler platform saramin`, 기존 gate/적재 파이프라인과는 미연결) — 본문 텍스트 9/10, 자격요건 10/10, 주요업무 8/10, `skills_tags` 0/10 확보. `sources/saramin_api.py` 는 2026-10-25 **삭제**.
> **전제 조건**: UA 에 "비영리 개인 프로젝트"라고 밝히고 있으므로 수집 데이터는 **개발·테스트용 더미로만** 쓴다. 운영·고객 시연·상용 서비스로 넘어가면 UA 문구와 사실이 어긋나고 DB권(저작권법 제93조) 위험이 커진다. 사람인 약관 제23조③ 비회원 구속력은 **[미확인]**.
> 상위 문서: [08_redesign_master_guide.md](08_redesign_master_guide.md) §6·v2-5, [06_monitoring_observability.md](06_monitoring_observability.md) §5.

---

## 1. 구조

```
 사람(CLI) 또는 POST /v1/trigger   x-internal-key: <CRAWLER_API_KEY>
   ▼
 crawler FastAPI (127.0.0.1:8010)  ── 202 {job_id,status} / 409 중복 / 429 큐 가득
   │  자식 프로세스 spawn (허용목록 env 만, 하드 타임아웃 시 프로세스 트리 kill)
   ▼
 child: python -m jdcrawler site ...   → out/<batch>.csv  (DB 접속 정보 없음)
   │
   ▼  부모 프로세스
 sanity gate ──실패──► 적재 안 함(CSV 보존) ─┐
   │통과                                      │
   ▼                                          │
 COPY fit.job_postings_staging ← CSV          │
 select fit.merge_job_postings(batch_id)      │
   │
   └──► 결과: CLI stdout 요약 JSON / GET /v1/jobs/{job_id}
```

- 웹/오케스트레이터는 이 프로세스를 호출하지 않는다. DB(`fit.job_postings`)만 공유한다 (08 v2-3).
- orchestrator(Node, BullMQ)는 그대로 유지한다. 크롤러만 별도 Python 서버다 (08 v2-4 거부 근거).

## 2. 단계

| # | 단계 | 담당 | 비고 |
|---|---|---|---|
| 1 | 수집 | 자식 프로세스 | `saramin`(공식 Open API) 또는 `site`(Crawl4AI + CSS 스키마, LLM 미사용) |
| 2 | CSV | 자식 프로세스 | `crawler/out/` 에 기록. 자식은 DB URL·키를 받지 않는다 |
| 3 | sanity gate | 부모 | 아래 표 |
| 4 | COPY | 부모 | `COPY fit.job_postings_staging FROM STDIN (FORMAT csv)`, psycopg3, `SUPABASE_DB_URL`(Session pooler 5432) |
| 5 | merge | 부모 | `select * from fit.merge_job_postings(batch_id)` → `{inserted, updated, skipped}` |

**sanity gate (1차 검수 — HIL UI 는 2차로 연기, §9)**

| 조건 | 동작 | reason |
|---|---|---|
| fetched = 0 | 적재 중단 | `empty` |
| 유효 행 비율 < 0.9 | 적재 중단 | `low_valid_ratio` |
| crawl4ai 소스에서 짧은 description 비율 > 0.4 | 적재 중단 | `low_desc_ratio` |
| CSV 를 읽을 수 없음 | 적재 중단 | `bad_csv` |
| 최근 7일 중앙값의 30% 미만 | **경고만**(적재 진행) | `warnings` 에 기록 |

실패해도 CSV 는 남는다 → `python -m jdcrawler load <csv> --batch <id>` 로 수동 재적재 가능.

## 3. 트리거 명세 — `POST /v1/trigger`

- 위치: crawler FastAPI `127.0.0.1:8010`. 헤더 `x-internal-key: <CRAWLER_API_KEY>`.
- 경로가 `/v1/*` 인 이유: `/api/*` 는 orchestrator(Express) 네임스페이스다. 사용자가 말한 `/api/crawler/trigger` 는 폐기(§8).

Body:

| 필드 | 타입 | 설명 |
|---|---|---|
| `source` | `"site"` | 필수. 사람인 웹 크롤(`platform saramin`)은 트리거에 아직 미연결(13 문서 W2-b) |
| `max` | int 1..500, 기본 200 | 수집 상한 |
| `schema_name` | string | `site` 일 때 필수 (`crawler/schemas/` 의 스키마) |
| `load` | bool, 기본 true | false 면 CSV 만 만들고 적재 안 함 |
| `timeout_sec` | int, 기본 saramin 600 / site 3600, 상한 7200 | 자식 프로세스 하드 타임아웃 |

응답: `202 {job_id, status}` · `409` 같은 (source, schema_name) 이 이미 실행 중 · `429` 큐 가득 · `401/403` 키 불일치 · `503` 서버에 `CRAWLER_API_KEY` 없음.
상태 조회: `GET /v1/jobs/{job_id}`. (`/v1/saramin`, `/v1/site`, `/v1/load` 는 기존 엔드포인트.)

202 는 "접수"일 뿐이다. 성공/실패는 `GET /v1/jobs/{job_id}` 로 확인한다.

## 4. 결과 알림 — 없음

n8n 웹훅은 2026-10-25 제거했다 ([12_n8n_on_hold.md](12_n8n_on_hold.md)). 결과는 CLI 요약 JSON 또는 `GET /v1/jobs/{job_id}`.

## 5. 보안 모델

**키는 경계마다 서로 다른 값이다. 하나가 유출돼도 다른 경계가 뚫리지 않게 분리한다.**

| 키 | 방향 | 보관 |
|---|---|---|
| `CRAWLER_API_KEY` | 호출자 → 크롤러 HTTP (`x-internal-key`) | `crawler/.env` |
| `MCP_INTERNAL_KEY` | orchestrator → mcp-server | `.env.local`. **크롤러는 사용하지 않는다** (이전의 `MCP_INTERNAL_KEY` 폴백 제거) |

- `server.py` fail-closed: `CRAWLER_API_KEY` 없으면 기동 거부, 요청은 503.
- 바인드: 기본 `127.0.0.1`. 비루프백 바인드는 `CRAWLER_ALLOW_NON_LOOPBACK=1` 필요. 켜면 LAN 에 노출된다 → API 키 + 방화벽 필수.
- 자식 프로세스 env 는 **허용목록**만 전달한다. `SUPABASE_DB_URL`·`CRAWLER_API_KEY`·`MCP_INTERNAL_KEY` 는 전달하지 않는다. 사이트 크롤 중 악성/오류 페이지가 있어도 자식에게는 DB 접속 정보가 없다.
- 하드 타임아웃 시 자식 **프로세스 트리**를 kill (Playwright 브라우저가 고아로 남는 것 방지).
- 크롤러는 `crawler/.env` 만 읽는다. 루트 `.env.local`(Anthropic·Slack 키 등)과 공유하지 않는다.
- orchestrator 쪽 부수 조치: `GET /api/sourcing/actions` 는 토큰·userId·status 가 모두 없으면 400, review 의 `decidedBy` 는 토큰 신원 우선, 서버 바인드 기본 `127.0.0.1`(`ORCHESTRATOR_HOST`). **잔여 위험**: `AUTH_MODE=legacy` 에서는 pending 대기열을 토큰 없이 조회·승인할 수 있다 (talentfolio 의 `/sourcing/review` 가 팀 공용 대기열로 토큰 없이 호출하므로). talentfolio 가 Bearer 를 보내기 전까지 유지.
- `ADMIN_USER_IDS` — **2차(HIL)에서 사용 예정, 아직 미구현.**

## 6. 사이트(`site`) 추가 절차

1. **수집원 확인**: 공식 API 가 있으면 API 를 쓴다(§7 표). HTML 크롤은 약관·DB권 위험을 사용자가 감수한 경우에만 (§7.1).
2. **스키마 작성** `crawler/schemas/<name>.json` (`example_board.json` 참고). 필수 항목:
   - `"enabled": true` — 없거나 false 면 실행 거부
   - `"legal_basis"` — 허용 근거 기록 (아래 체크리스트 요약)
   - `allowed_hosts` — 이 호스트 밖 URL 은 따라가지 않음
   - 선택 `delay` — 랜덤 지연 범위 override
3. **legal_basis 체크리스트** (모두 날짜와 함께 문장으로 기록):
   - [ ] robots.txt 를 **직접 조회한 날짜**와 대상 경로의 Allow/Disallow 결과. 조회 불가(403/봇 챌린지)면 "미확인"으로 적는다 — 추정 금지
   - [ ] 이용약관의 자동화 수집·크롤링 조항 검토 날짜와 결과(금지/허용/해당 없음)
   - [ ] 공식 API 존재 여부와 신청 가능 여부
   - [ ] 연락처가 포함된 식별 UA (`CRAWLER_USER_AGENT` 또는 `CRAWLER_CONTACT` 필수)
   - [ ] 사용자의 위험 감수 확인 (§7.2)
4. **안전장치(코드)**: `ignore_https_errors=False`, robots.txt 준수(차단되면 재시도 안 함), 랜덤 지연 3~7초(`CRAWL_DELAY_MIN`/`CRAWL_DELAY_MAX`), URL 스킴·호스트 검증, 이메일·전화 마스킹, 목록 첫 페이지 실패 시 `failed`.
5. **검증**: `python -m jdcrawler site schemas/<name>.json --headful --max 5` 로 셀렉터 확인 → `--max 5` 적재 테스트.

## 7. 법적 근거·위험 요약

> 법률 자문이 아니다. 아래는 조사 결과이고 **[미확인]** 표시는 사실로 취급하면 안 된다.

### 7.1 근거 표

| 항목 | 내용 | 상태 |
|---|---|---|
| 잡코리아 v. 사람인HR 1심 | 서울중앙지법 2015가합517982. 간접강제금 집행문 약 1.98억. 법원이 VPN IP 분산·UA 미표기·robots 미확인을 부정경쟁 판단 근거로 삼음 | 요약 기준. 판결문 원문 **[미확인]** |
| 같은 사건 항소심 | 서울고법 2016나2019365. 간접강제 2억 + DB권(저작권법 제93조) 침해 손해배상 2.5억 = 4.5억 | 요약 사이트 근거. 판결문 원문 **[미확인]** |
| 상고심 | 대법원 2017.8.24. 2017다224395 심리불속행 기각 | 요약 기준 |
| 사람인 기업회원약관 제23조③ | 자동화 수단(크롤링 등)의 정보 수집 금지 | **[확인]** 원문. 비회원에 대한 구속력은 **[미확인]** |
| 사람인 robots.txt | `/recruit/recruit_view.php`, `/zf_user/recruit/view/`, `/zf_user/jobs/view/etc` 등 **옛 상세 경로**가 Disallow. **2026-10-24 재측정: 현재 쓰는 `/zf_user/search`(목록), `/zf_user/jobs/relay/view`(상세), `/zf_user/jobs/relay/view-detail`(본문)은 Disallow 목록에 없음.** 이전에 "상세 페이지는 robots 금지"라고 쓴 것은 옛 경로 기준이라 부정확했다 | **[확인]** 2026-10-24 직접 조회 (매 크롤 전 재측정) |
| 사람인 이미지 CDN robots | `Disallow: /` (일부만 Allow), 공고 본문 이미지 경로는 Allow 아님 → 이미지 미수집 | **[미확인]** 실험 스크립트 주석 근거, 내가 직접 조회하지 않음 |
| 사람인 Open API | 미사용 결정(2026-10-24), 어댑터 코드 삭제(2026-10-25) | — |
| 잡코리아 robots | 일반 경로 허용, 스크래퍼·AI 크롤러 전면 Disallow. 채용정보 API 는 DB 수집 목적 신청 거절 | **[확인]** |
| 원티드 | 약관: IP 변경·스크래퍼 금지. robots 는 403 으로 조회 불가 | 약관 확인 / robots **[미확인]** |
| 캐치 | 약관: 크롤러 금지. robots 는 봇 챌린지로 조회 불가 | 약관 확인 / robots **[미확인]** |
| 점핏 | 사람인 계열 | 약관 **[미확인]** |
| 고용24(워크넷) 채용정보 API | 공공데이터포털 이용허락범위: 출처표시·**상업적 이용금지**·변경금지. 목록 응답에 직무내용/자격요건 본문 필드 없음 | 목록 응답 확인. 상세 호출은 미실행 → 본문 제공 여부 **[미확인]**. 상업 이용 해당 여부는 사용자 판단 |
| 링크드인 | 약관 위반 + authwall + 개인정보 | 수집 대상에서 **제외** |

**해석(조사자 의견, 사실 아님)**: 위 판결에서 법원이 문제 삼은 요소(IP 분산, UA 위장, robots 무시)를 피하는 것이 §6 안전장치의 설계 근거다. 그러나 안전장치를 갖춰도 약관 위반·DB권 침해 주장 가능성은 남는다. 외부 본문(description) 저장은 DB권 위험을 키운다 (§10).

### 7.2 사용자 위험 감수 결정 기록 (2026-10-20)

- 추가 사이트(HTML) 크롤링은 위 위험을 **알고도 진행**한다. **법적 책임은 사용자에게 있다.** (사용자 결정)
- 이 문서와 스키마 `legal_basis` 는 허용 근거를 기록하기 위한 것이지 합법성을 보증하지 않는다.
- 사람인은 **직접 크롤**한다 (2026-10-24 사용자 확정, 위 위험 감수). Open API 는 쓰지 않는다.

## 8. 폐기한 설계

| 설계 | 폐기 이유 |
|---|---|
| 프록시 로테이션 / UA 랜덤화 | 위 1심이 IP 분산·UA 미표기를 부정경쟁 근거로 판단. 식별 가능한 고정 UA + 단일 IP + robots 준수가 방어에 유리 |
| 사람인 Open API 어댑터 | 직접 크롤로 결정(2026-10-24). 응답에 본문이 없어 핏 분석 품질이 낮음. 코드 삭제(2026-10-25) |
| `/api/crawler/trigger` | `/api/*` 는 Express(orchestrator) 네임스페이스. 크롤러는 별도 서버라 `/v1/*` |
| 정규식 전면 구조화(JD 본문 파싱) | 사이트마다 깨지고 환각성 오류가 조용히 쌓인다. 셀렉터 스키마 + gate 로 대체 |
| `MCP_INTERNAL_KEY` 를 크롤러 인증 폴백으로 사용 | 키 1개 유출 시 두 경계가 동시에 뚫림 |

## 9. 2차 계획 — HIL 검수 (미구현, 설계 합의안만)

- 1차는 배치 단위 sanity gate. **행 단위 검수 UI(`/admin/crawling`)와 staging row_id/status 변경은 연기.**
- DB 에이전트 합의안: staging 에 `row_id uuid PK` + `status` + `url_key` + `edits`, UNLOGGED → LOGGED 전환, `merge_job_postings(p_batch_id, p_row_ids uuid[])` 로 **승인된 행만 승격**, 구 `merge(text)` drop.
- 마이그레이션 번호(정정 2026-10-25): 011 = 플랫폼 테이블, 012 = site_facts, **013 = 크롤 검수**(아래). pg_trgm·임베딩은 014 이후.
- 접근 제어는 `ADMIN_USER_IDS`(2차, 미구현).
- 주의: `SET LOGGED` 는 실행해 본 적 없다 **[미검증]**.

## 10. 보류 결정

- **description 원문(상세 Markdown) 저장 정책** — 외부 본문 저장은 DB권(저작권법 제93조) 위험 → **사용자 결정 대기.** 그때까지 gate 의 `low_desc_ratio` 는 "본문을 저장하는 소스"에만 의미가 있다.

## 11. 스케줄 — 없음

주기 수집을 하지 않는다. 필요할 때 사람이 CLI 로 돌린다 (n8n 스케줄 계획은 [12_n8n_on_hold.md](12_n8n_on_hold.md)).

## 12. 알려진 한계 / 미검증

- 사람인 `start` 가 **페이지 인덱스**라는 가정은 코드 주석 기준이며 실호출로 검증하지 않았다.
- Crawl4AI 실크롤: 2026-10-24 `books.toscrape.com` 스모크(5건 CSV)·사람인 샘플(10건)로 **동작 확인**. 이 두 건은 `--load`/DB 적재와 무관.
- **사람인 HTML 샘플 실험 (2026-10-24, 사용자 위험 감수·개인 비영리·미배포)** — 현재 구현은 `crawler/jdcrawler/platforms/saramin.py` (옛 `scripts/saramin_sample.py` 는 삭제·대체됨).
  - `www.saramin.co.kr/robots.txt` 확인(200): 검색 `/zf_user/search`·상세 `/zf_user/jobs/relay/view`·`view-detail` 은 Disallow 목록에 없음(§사람인 robots 의 `view/etc` 와 경로 다름).
  - **`www.saraminimage.co.kr/robots.txt` = `User-agent: * / Disallow: /`**, 공고 본문 이미지 경로(`/recruit/os_hk_*`)는 Allow 목록에 없음 → **이미지 자동 다운로드·OCR 하지 않는다**(브라우저도 `text_mode`). 이미지 전용 공고 1/10 은 본문 미수집.
  - 약관 제23조③ 은 여전히 **[미확인]**(비회원 구속력). 법적 허용 보증 아님.
  - 10건 중 9건은 본문이 이미지가 아닌 텍스트(주요업무/자격요건/우대사항). 급여는 10/10 "면접 후 결정".
  - 본문 압축: `mcp-server/src/scripts/compress_jd_sample.ts` (generateStructured). 원문 대조 2건 중 1건에 왜곡("정규직(수습 3개월)" → "수습 3개월 후 정규직 전환"). **compressed_text 대신 구조화 배열(duties/must/nice/tech)을 쓰고, 근무조건은 크롤 원본 필드를 쓸 것.**
- **플랫폼별 분리 구조 (사용자 확정 2026-10-24: 공고 스타일이 플랫폼마다 달라 크롤 코드·DB 모두 분리)**
  - 코드: `crawler/jdcrawler/platforms/<name>.py`(수집·파싱·품질판정) + `<name>_store.py`(적재), `platforms/__init__.py::PLATFORMS` 에 등록. CLI: `python -m jdcrawler platform <name> [--max 10]` → `out/<name>_postings_<ts>.json`, `platform-load <name> <json> [--compressed <json>]`(`SUPABASE_DB_URL` 필요). 새 플랫폼 = 파일 2개 + 레지스트리 1줄 + SQL 1개.
  - DB: `docs/architecture/sql/011_platform_postings.sql` (**실 Supabase 적용 완료** — 011·012 모두 반영, `saramin_postings` 56컬럼·10행·`job_categories` 21행 **[확인]** 2026-10-24 직접 조회. 적용 전 일회용 Docker Postgres 에서 14/14 검증). 플랫폼별 원본 테이블 `fit.saramin_postings` + 공통 정본 `fit.job_postings`(병합 미구현, `job_posting_id` FK nullable). 직군은 플랫폼 자체 필터 분류를 `fit.job_categories(platform, …)` + 플랫폼별 m2m 로 보관(사람인 대분류 21개 시드, `site_code` 는 **미검증 NULL**).
  - 글자 수 방어 3중: ① Gemini schema `maxItems`(50) ② zod 검증 + 위반 시 1회 재시도 + 코드 clamp(`mcp-server/src/lib/jdCompress.ts`; Gemini 는 `maxLength` 무시) ③ DB CHECK(배열 ≤50, 항목 ≤200/skills ≤60, `compressed_text` ≤350). `skills` = 기술명만, 업무/자격은 별도 배열.
  - 빈 값 원인 4분류 → 처리: `by_design`(상시채용 등, 종료) / `fetch_failed`(보충 없이 `retry_later`) / `extract_failed`(셀렉터 이상 → 행 단위 보충 금지, 배치 `selector_alert`·코드 수정) / `not_in_source`(본문 정규식 보충 → 실패 시 이미지형이면 `needs_review`, 텍스트형이면 기록만). 검토 UI·LLM 재추출은 **설계만, 미구현**.
  - 실측(2026-10-24, 10건): 본문 텍스트 7 ok · fetch 실패 1(`retry_later`) · 이미지형 의심 2(`needs_review`). 본문 상한 1500 → **6/10 잘림** → 4000 으로 상향. `clean()` 이 본문을 한 줄로 납작하게 만들어 목록이 안 보였음 → `format_body` 가 줄바꿈·불릿을 유지. **목록은 코드가 `split_body_sections` 로 쪼개고, LLM 은 미분류 항목 분류 + skills + 카드 요약만** (`compressed_text` 350자 유지, 배열 상한 50 유지). 상세 dt/dd 는 영어 키 `site_facts`(복지·기업정보·Q&A, SQL 012). 자격요건/우대사항 사이드바 원문은 UI 오염이라 저장하지 않음. 본문 숨은 텍스트(직군/기술스택 태그)는 text_mode 렌더에서 **0/10** → 직군은 본문으로 못 얻음(검색 필터 파라미터 필요, 코드 미확보).
- **대량 1회 수집 (2026-10-24)**: 크롤은 주기 수집이 아니라 "실제 값이 있는 더미 데이터" 확보용 1회성이다. `HARD_CAP` 20 → **100** (목록 1페이지 `recruitPageCount=100`, 페이지 넘김 없음), 목록은 **관련도순**(`recruitSort=relation`)으로 받고 코드가 `rec_idx` 내림차순(= 최신 등록순으로 추정)으로 다시 정렬. 100건 ≈ 요청 201회 × 지연 3~7초 → **약 20~30분**. `BROWSER_CHUNK`=25건마다 브라우저 재기동(메모리 누적 방지).
- **이어하기 (`jdcrawler/checkpoint.py`)**: 수집 1회 = `<stem>.plan.json`(시작 시 확정한 목록) + `<stem>.partial.jsonl`(1건마다 1줄) → 전부 끝나면 `<stem>.json` 만 남김. 멈추면 stdout 에 `status:"stopped"` + `resume` 명령 → `python -m jdcrawler platform saramin --resume out/<stem>`. 이어하기는 목록을 다시 검색하지 않고 plan 을 쓴다(관련도순은 시간이 지나면 바뀌어 중복·누락). 완료 건은 건너뛰고 `retry_later` 만 다시 받는다. DB 쪽 중복은 `rec_idx` unique upsert 가 막는다.
- **중단 조건 (우회 없음)**: 차단 문구(`BLOCK_MARKERS`) 발견 → 즉시 `CrawlBlocked`. 상세 3건 연속 실패/구조 없음 → 브라우저 1회 재기동 후에도 실패하면 `CrawlBlocked`. 그 외 브라우저 예외는 남은 건부터 새 브라우저로 최대 3회. IP 변경·UA 위장·캡차 풀이는 하지 않는다.
- **페이지 로딩**: `networkidle` → `domcontentloaded` + `wait_for`(상세 `h1.tit_job, section.jview`, 본문 `.user_content`), `page_timeout` 60s → 30s, `avoid_ads=True`. 실사이트 확인 **[미검증]** (2026-10-24 시도 시 `crawler/.env` 에 `CRAWLER_CONTACT` 없음으로 수집 전 거부).
- **content_hash**: `saramin_store.build_row` 가 내용 필드(`HASH_FIELDS`)로 32자 sha256 저장. `raw` 는 DB 에 넣지 않음(로컬 `out/*.json` 이 원본).
- **적재 행 단위 격리**: `saramin_store.load_records` 는 행마다 savepoint. CHECK 위반 등 실패 행은 `failed:[{rec_idx,error,constraint}]` 로 보고하고 나머지는 계속 적재 (실 DB 롤백 테스트로 확인). `loader.py` 에 `connect_timeout=15` 추가.
- **2026-10-24 Cursor 세션의 "풀러 타임아웃"**: 같은 `.env` 로 이 PC 에서 5432·6543 TCP·psycopg 모두 정상(0.1초) → URL·풀러 문제 아님, Cursor 실행 환경 쪽 네트워크 문제로 추정 **[미확인]**. 그 세션이 MCP SQL 로 우회 적재한 10행은 body_text 9건 누락·목록 축약 → `platform-load` 재적재 필요.
- 신규 공고량은 추정치.
- `SET LOGGED` 실행 미검증 (2차).
- 010 SQL 의 인덱스 `job_postings_title_trgm` 은 이름과 달리 `simple` tsvector GIN 이다(이름 오류, **미수정**). pg_trgm 인덱스가 아니다.
- 판결 요약은 2차 자료. 원문 미확인.


## 크롤 검수 구현 (2026-10-25)

- 대상: `fit.saramin_postings` = 원본 + 검수 상태. **승인된 행만** `fit.job_postings` 로 병합 (source=`saramin`, external_id=`rec_idx`).
- SQL `013_crawl_review.sql`: `load_batch_id`, `is_sample`, `review_flags`, `reject_reason`, `edits`(원본은 두고 수정분만), `reviewed_by/at`. 상태에 `approved`/`rejected` 추가.
- 크롤러: `platform-load` 가 `load_batch_id`(기본 JSON 파일 이름, `--batch-id`) 기록. 재수집은 `resolved/approved/rejected` 행을 덮어쓰지 않는다 (제외한 광고가 되살아나지 않음).
- orchestrator `lib/crawlReview.ts`: 코드 규칙 판정(이미지형·본문 짧음·회사 없음·기술 0·업무 없음·광고 키워드·마감·중복, LLM 없음) → 통과분에서 결정적 샘플 `max(5%, 10건)` → 샘플 판정 끝·오류 없음일 때만 배치 승인 → 병합. description 은 배열 + 근무조건 원본 필드.
- 인증: JWT 게이트 제외, 대신 `X-Admin-Password` = `.env.local` `CRAWL_ADMIN_PASSWORD` (없으면 503, IP 당 10분 5회 실패 시 429). web 은 기존 로그인 게이트도 그대로 거친다.
- 화면: web `:3010/crawling` — 배치 선택 / 배치 준비 / 배치 승인, 탭(예외·샘플·전체), 행 펼침(원문 링크·배열·본문), 승인·수정·제외(사유)·재수집·판정 취소.

### 검수 개선 루프 (2026-10-25)

- 도구: `.claude/agents/crawl-verifier.md`, `crawl-reviewer.md`, 절차 `.claude/skills/crawl-review-loop/SKILL.md`, 검증 `scripts/verify-crawl-review.sh [--db]`.
- 테스트: `orchestrator/test/crawlReview.test.ts` (`npm test --prefix orchestrator`, DB 통합은 `CRAWL_REVIEW_DB_TEST=1`), `crawler/tests/test_saramin_store_db.py` (같은 변수). DB 테스트는 `test-` 배치를 만들고 지운다.
- 1회차: verifier PASS(공백 5) / reviewer high 2·medium 3·low 3 → 수정 — 배치 승인 상태 조건, 재수집 시 샘플·사유 초기화(+내용 바뀌면 edits 비움), 묶음 update, 페이지 단위 읽기, 정본 삭제 먼저, 재병합 생략, 500 원문 비노출.
- 2회차: verifier PASS / reviewer high 1·medium 2 → 수정 — prepare 묶음 update 에 읽을 때 상태 조건, 병합 조회 200개 분할, 연결 update 동시 20.
- 3회차: reviewer medium 1·low 1 → medium 수정 — 연결 update 에 승인 상태 조건, 그 사이 제외됐으면 방금 올린 정본 삭제. 상한(3회차) 도달로 종료, 전체 검증 통과.
- 배치 승인 BullMQ 이전 (2026-10-26): `POST /batches/:id/approve` 는 사전 검사(409)만 하고 202 `{jobId}` 반환 → `crawl-approve` 큐 워커(`queue/crawlApproveQueue.ts`)가 승인 update + 병합. jobId 는 배치 해시로 고정(대기·실행 중이면 같은 잡, 끝난 잡은 지우고 재등록), 워커가 사전 검사를 다시 해 큐 대기 중 샘플 판정 변경도 막음(재시도 없이 실패), 상태는 `GET /jobs/:jobId`(비밀번호 게이트), 영구 실패는 Sentry. 웹은 1.5초 폴링.
  - 루프 1회차: verifier PASS / reviewer high 0·medium 0·low 4 → low 2건 반영(워커 concurrency 주석, 폴링 일시 오류 재시도), `/jobs` 게이트 테스트 추가.
- 남은 과제 (low): 재승인 동시 클릭 시 remove→add 경합으로 한쪽이 거짓 500을 볼 수 있음(데이터 무해). 링크 update 행별 왕복은 SQL 014 RPC 로 줄일 수 있음(원격 SQL — 사용자 승인 필요).

## 수집처 이름 제거·일반화 (2026-10-27, SQL 014 원격 적용)

- 사용자 요청: 코드·화면·DB 이름에 수집처 이름을 남기지 않고, 다른 수집처가 추가돼도 같은 구조로 동작하게.
- DB: `saramin_postings`→`crawled_postings`, `saramin_posting_categories`→`crawled_posting_categories`, `rec_idx`→`external_id`, `platform` 컬럼(불투명 코드 `board_a`), unique(platform, external_id), 직군 연결은 (posting_id, platform) 복합 FK. 제약·인덱스·정책·트리거 이름 `crawled_*`. 값: `job_postings.source`·`job_categories.platform`·배치 ID → `board_a`, raw 키 → `crawled_posting_id`/`external_id`, 본문 등 텍스트의 수집처 이름 → "채용 사이트". 백업 `crawler/out/backup_014/`.
- 크롤러: `platforms/board_a.py`(수집), 공통 `platforms/store.py`(적재, platform 인자). 수집처 주소는 `crawler/.env` `BOARD_A_BASE_URL`, 텍스트 마스킹 단어는 `CRAWL_MASK_TERMS`. orchestrator 검색 URL 허용 호스트는 `.env.local` `BOARD_A_HOSTS`. 옛 JSON/partial 의 `rec_idx` 키는 읽을 때 호환.
- 원문 링크: 공고 `url` 은 수집처 주소 그대로 둔다 (2026-10-27 사용자 결정 — 지원자가 실제로 지원하려면 필요).
- 이 문서 위쪽의 "사람인" 서술은 2026-10-27 이전 기록·법적 근거라 그대로 둔다.
