# 17. 다출처 공고 설계 — 데이터·화면 배치 (v3.1, 2026-10-27)

> 상태: **설계, 루프 검토 중** (1회차: 데이터·코드 / 법적 / UX, 2회차: 종합, 3회차: 최종 — 반영 완료. 루프 종료). 조사 원자료 [16](16_platform_sources.md), 법적 기준 [09 §6·§7](09_crawler_pipeline.md).
> 루프 단계: **후보 탐색·핏 분석의 입력(공고)을 출처별 특징까지 살려 넓히고, 헤드헌터가 스카우트 건에서 원 공고 출처를 보게 한다.**
> SQL 은 파일만. **원격 적용·실제 크롤·공개 노출 범위 변경은 모두 사용자 승인 후 하나씩.**

## 0. 사용자 결정 항목

| # | 결정 | 권장 | 이유 |
|---|---|---|---|
| **D7** | **크롤 공고를 비로그인 공개(`/studio`, `/api/public/job-postings`)로 노출할지.** CLAUDE.md "수집분은 더미·테스트 전용"과 충돌. 현재 사람인 공고가 이미 공개 노출 중 | **내부·테스트 역할(JWT `app_metadata.role in (internal, tester)` 또는 허용 계정 목록)로 한정.** 일반 로그인 사용자·비로그인은 기업 직접 등록·공식 API 출처만 | 잡코리아 v. 사람인 판결의 쟁점(경쟁 서비스로 제공, DB권)에 가장 직접적으로 해당하는 부분 |
| D1 | 원본 테이블: 플랫폼별(011) → 공통 `crawled_postings`(014) | 공통 | 플랫폼 추가 = `platforms` 행 1개, 검수 코드 분기 없음 |
| D2 | 원티드: 크롤 대신 공식 OpenAPI "채용공고 수집 KEY" 신청 | 신청 | 약관 19조⑦ 자동 수집 금지, robots 403. 키 범위 안에서만 허락 |
| D3 | 리멤버: 약관 24호가 검색엔진 외 자동 수집 금지 → 수집할지 | **보류(제휴 문의)** | 위험이 사람인보다 큼 |
| D4 | 자소설닷컴: robots 허용, 약관 원문 **미확인** → 사람이 `/terms` 확인 | 확인 후 결정 | 16 의 "✅ 1순위"는 "⚠️ 약관 확인 대기"로 정정 필요 |
| D5 | 링크드인: 크롤 ⛔. **해당 공고를 게시한 기업(권리자)의 직접 등록**만, URL 은 외부 지원 링크로만 | 유지 | 운영자가 손으로 옮겨 적기는 "사람 수집"이라 금지 |
| D6 | 배치 승인 후 원본 삭제(현재 동작) 유지 여부. 제외 행까지 지워져 "제외한 광고가 재수집으로 되살아나지 않음"이 무력화됨 | **원본 삭제는 유지하되, 삭제 전에 제외 행을 `fit.crawl_blocklist(platform, external_id, reason, blocked_at)` 에 옮긴다.** 적재(`store.py`)는 upsert 전에 차단 목록을 확인해 건너뛴다 | 원본 테이블을 가볍게 유지하면서 재수집 보호 복구. 승인 행의 근거는 정본 `facts` 사본에 있다 |
| D8 | 대표 출처 우선순위 (중복 시, 동점일 때만) | 정보 완결도 → 최신 → wanted, jasoseol, saramin, remember, manual | |

## 1. 출처별 특징 → 화면 값

필드 확인 방식: 2026-10-27 조사 에이전트가 공개 상세 1~3건을 자동 요청(curl)으로 열어 SSR JSON 을 봄. **리멤버는 약관 24호를 확인한 상태에서 자동 요청이 있었으므로, D3 결정 전까지 아래 리멤버 필드는 "가설"로 취급하고 추가 조회하지 않는다.**

| 출처 | 성격 | 출처 하이라이트 (공통 칸에 없는 값 1개) | 상세 추가 | 근거 필드 |
|---|---|---|---|---|
| 사람인 | 종합, 정형 조건 | 근무형태 원문 ("정규직(수습 3개월)") | 근무조건 원문 블록 | `employment_type_text` 등 (운영 중) |
| 자소설닷컴 | 대기업·공기업 공채, 신입·인턴 | `공채 · 자소서 3문항` | 직무별 마감, 기업 규모 | `recruit_type`, `employments[].resume_count`, `business_size` (확인). **문항 원문은 저장 안 함** |
| 리멤버 (D3 승인 시) | 경력직·헤드헌터 | `헤드헌터 공고` (평문) / 응답률 | 경력 범위 | `organization.headhunter`(boolean 만), `applicationResponseMetrics` |
| 원티드 (API) | IT·스타트업 | 2단계 직군 태그 | 원격 여부, 경력 범위 | API 응답. **합격보상금은 지원자 화면에 표시 안 함**(원티드 경유 지원 시만 해당 → 오인) |
| 기업 직접 등록 | 외국계 등 | `외부 지원 링크` | 등록 기업 입력값 | 등록 폼 |

**공통 고정 칸 3개**(모든 카드 같은 위치): 경력 / 마감(D-day) / 급여 공개 여부. 출처 하이라이트는 이 셋과 겹치지 않는 값 하나, 없으면 칸을 그리지 않는다.

**저장 금지 (설계로 강제, §2.1)**: 담당자·헤드헌터 실명·연락처, 자소서 문항 원문, 기업 원문 HTML 전체(`content`), 다른 사이트의 이용 지표(조회수·찜 수).

## 2. 데이터 모델

### 2.1 원본 `fit.crawled_postings` — 014 확정안 (초안의 결함 수정 포함)

| 항목 | 내용 |
|---|---|
| rename | `saramin_postings→crawled_postings`, `rec_idx→external_id`, categories 테이블 rename (초안대로) |
| 유일성 | `unique(platform, external_id)` + **`unique(id, platform)`** (아래 FK 용) |
| 직군 연결 | `crawled_posting_categories` 에 **`foreign key (posting_id, platform) references crawled_postings(id, platform)`** 추가 → 공고·직군 플랫폼 혼입을 실제로 막음 (초안 주석의 "복합 FK 로 계속 강제"는 사실이 아니었음) |
| `fit.platforms` | `code PK, label, priority, crawl_allowed, public_enabled default false, facts_keys text[] not null default '{}', legal_basis_checked_at, terms_result, api_or_partner_note`. 시드: `saramin`(사전 점검 결과 키), legacy 행·`manual` 은 `facts_keys='{}'`. **`legal_basis_checked_at`·`terms_result` 가 비면 `crawl_allowed` 는 true 가 될 수 없다**(CHECK) |
| `platform` FK | `crawled_postings.platform → platforms.code` |
| `ingest_method` | `crawl`/`manual`/`official_api`. 트리거: `crawl_allowed=false` 플랫폼에 `crawl` 거부 |
| `extra_facts` | 이미 있음(012). **CHECK 추가**: object, ≤ 8KB, **최상위 키 ⊆ `platforms.facts_keys`**(트리거로 검사), **값은 스칼라 또는 스칼라 배열만**(중첩 객체 금지 → 하위에 실명이 숨는 경로 차단) |
| 허용목록 | 정본 1곳: `platforms.facts_keys text[]` + `docs/architecture/schemas/facts/<platform>.json`(JSON Schema). Python(`jsonschema`, `store.py` 적재 직전)과 TS(orchestrator 병합 시) 가 **같은 파일**을 읽는다. 금지 키(담당자명·연락처·자소서 문항 등)는 허용목록에 넣지 않는 것으로 막는다. manual 입력에도 이메일·전화 마스킹 |
| 사전 점검 | 014 앞에 `select key, count(*) from fit.saramin_postings, jsonb_object_keys(extra_facts) key group by 1` 로 기존 사람인 키를 확인해 `facts_keys` 시드에 반영하고, 값 모양도 센다(`jsonb_typeof(value)='object'` 행 수, 배열 원소가 객체인 행 수). 0건이 아니면 014 안에서 평탄화한 뒤 CHECK 를 건다 |
| 호환 뷰 | `create view fit.saramin_postings with (security_invoker = true) as select …, external_id as rec_idx … where platform='saramin'` + `alter view … alter column platform set default 'saramin'` + authenticated select / service_role all grant. **읽기·단순 update 호환용일 뿐, 크롤러 upsert 는 뷰로 못 한다**(단일 컬럼 conflict target 없음) |
| 같은 배포로 바꿔야 하는 것 | crawler `saramin_store` → 공통 `store.py`: 테이블 `crawled_postings`, `on conflict (platform, external_id)`, INSERT 에 `platform` 명시(카테고리 링크 포함). orchestrator `crawlReview.ts` 테이블 상수 |
| 차단 목록 | `fit.crawl_blocklist(platform, external_id, reason, blocked_at, primary key(platform, external_id))`. `deleteBatch` 는 삭제 전에 `rejected` 행을 여기로 옮긴다 |
| 재실행 | **014 적용 후 011~013 은 재실행 대상이 아님**(테이블·제약 이름이 바뀜). 적용 전 백업 |

### 2.2 정본 `fit.job_postings` — 015

| 컬럼 | 규칙 |
|---|---|
| `source` | **새 `platform` 컬럼을 만들지 않고** 기존 `source` 를 `platforms.code` FK 로 쓴다 (upsert 키 `(source, external_id)` 유지, 두 컬럼 불일치 원천 차단). 기존 `saramin` 값은 그대로 유효. 015 전에 `select source, count(*) from fit.job_postings group by 1` 로 실제 값 확인. 남은 옛 값(`saramin_api`, `crawl4ai:*`)은 `crawl_allowed=false, public_enabled=false` 인 **legacy 행**으로 시드한다(법적 칸 CHECK 는 crawl_allowed=true 일 때만 적용). 옛 CSV 경로(`job_postings_staging`/`merge_job_postings`) 폐기 여부는 P3 에서 확정 |
| `ingest_method` | `crawled_postings` 에서 병합 시 복사 (`crawl`/`manual`/`official_api`). 공개 범위(D7) 필터에 쓴다 |
| `deadline_type` | `date`/`rolling`/`until_filled`/`unknown` |
| `recruit_kind` | `open`(공채)/`rolling`(수시)/`intern`/`unknown` |
| `salary_disclosed` | "면접 후 결정·회사내규" → false |
| `highlights jsonb` | 화면 전용 ≤5개 `{label≤12, value≤40}`. **LLM 입력에 넣지 않는다** (헌법 3조) |
| `facts jsonb` | 병합 시점의 **허용목록 extra_facts 사본**. 원본이 배치 승인 후 삭제돼도 하이라이트·중복 판정을 다시 계산할 근거 |
| `dedup_group_id`, `is_canonical` | 중복 묶음. **`is_canonical boolean not null default true`** — 016 전에는 모두 대표라 목록·핏 분석 입력이 비지 않는다. 016 은 묶음의 비대표 행만 false 로 바꾼다 |
| 보존기간 | `last_seen_at` 기준 N일(사용자 결정, 기본 60일) 지난 크롤 공고는 비노출 후 **스텁화**: description·skills·highlights·facts 를 비우고 제목·회사·출처명·수집일·원문 URL 만 남긴다. 행은 지우지 않으므로 스카우트 건·`fit_reports`·`jd_runs` 의 참조가 끊기지 않는다 |

### 2.3 중복 판정 — 016

**기존 `dupKey()`(같은 배치·같은 플랫폼 중복 → 거절 대상)는 그대로 둔다.** 교차 출처용은 별도 `crossKey()` 로 `assignDedupGroup()` 에서만 쓴다 (정상 교차 중복이 `duplicate` 로 거절되지 않게).

| 단계 | 규칙 | 처리 |
|---|---|---|
| 1 | 같은 **외부 채용 홈페이지** URL (쿼리 제거는 외부 도메인 apply 링크에만, 플랫폼 상세 URL 은 제외 — 사람인은 ID 가 쿼리에 있음) | 자동 묶음 |
| 2 | `crossKey = norm(company)|norm(title)` 같음 **+ `recruit_kind` 같음 + 경력 범위 겹침** + (마감 차이 ≤ 7일, 또는 둘 다 rolling/NULL) | 자동 묶음 |
| 3 | 회사 같고 제목 유사도 ≥ 0.8 (pg_trgm) | 후보 플래그만, 검수자 결정 |

`norm`: (주)·주식회사·㈜·공백·특수문자 제거, 소문자. **신입/경력 괄호 접두어는 지우지 않는다**(신입·경력 공고가 묶이는 오탐). 대표 아닌 행도 `job_postings` 에는 남긴다(alsoOn).

**핏 분석 입력도 중복 제거**: orchestrator `listJobPostings`/`getJobPostingById` 기본값 `is_canonical=true`, 분석 사전필터는 dedup 그룹당 1건 (토큰 원칙).

### 2.4 API DTO v2
- 공개(`/api/public/job-postings`): **D7 결정 전에는 크롤 출처(`job_postings.ingest_method='crawl'`) 제외**. 015 전(P0)에는 컬럼이 없으므로 임시로 `PUBLIC_POSTING_SOURCES=[]`(크롤 출처 0개) 로 둔다. 필드는 최소(제목·회사·마감·원문 링크·출처명). `public_enabled` 는 기본 false.
- 내부·테스트 역할용(신규 `/api/jobs/feed`, JWT + 역할 검사. 역할이 없으면 공개 DTO 와 같은 범위): 추가 필드 `sourceLabel`, `deadline{type,date}`, `recruitKind`, `salaryDisclosed`, `highlights[]`, `alsoOn[{label,url}]`(≤4). `source`·`firstSeenAt` 은 기존 필드 유지.
- `PUBLIC_POSTING_SOURCES` 하드코딩 제거 → `platforms.public_enabled` 조회(캐시) — P3 작업.
- alsoOn 은 group id `in()` 1회 조회 (N+1 금지).

## 3. 화면 배치

### 3.1 결론
- 지원자: **`/studio` "회사 공고" 탭 확장**(별도 /jobs 없음). D7 에 따라 크롤 출처는 **내부·테스트 역할에게만**, 일반 로그인 사용자·비로그인은 `manual`·`official_api` 출처만.
- **헤드헌터: 공고 목록 페이지는 만들지 않고**, 스카우트 건·`/sourcing` 상세의 "원 공고" 칸에 출처·수집일·다른 출처를 읽기 전용으로 붙인다.
  ```
  스카우트 건 #12  Northline · FE
  원 공고: [원티드] 10/25 수집 · 다른 출처 사람인, 자소설닷컴  원문 ↗
  후보 18 → 핏 분석 → 승인 대기 3
  ```
- 출처 구분: **칩·배지 모두 짧은 정식 표기**: 사람인 · 자소설닷컴 · 리멤버 · 원티드 · 기업 등록 (줄임말 없음). 약어를 쓰지 않으므로 "JS"↔JavaScript 혼동도 없다. 배지는 테두리 사각형(스킬 태그 = 채운 pill 과 모양 구분), `aria-label="출처: 자소설닷컴"`. **DESIGN.md Badge 규격(10–12px, role color)의 예외**: 출처 배지는 하한 11px, 글자 `--text-primary`, 테두리 `--border-color` (대비는 구현 전 도구로 측정).
- 브랜드 색·로고 금지. 문구는 "출처: 원티드"(텍스트 표기), **"공식·연동·가져옴" 같은 제휴 암시 표현 금지**. 기업 직접 등록은 "기업 직접 등록 · 외부 지원 링크".
- 색만으로 정보 전달 금지: 마감 임박은 Crimson + 굵기/아이콘.

### 3.2 카드 (데스크톱)
```
┌────────────────────────────────────────────┐
│ [원티드] 외 1곳                       서울 │
│ Northline · Frontend Engineer              │
│ 경력 3년+ │ D-12 │ 급여 비공개              │ ← 공통 고정 칸
│ ┊ 직군: 프론트엔드 ┊                        │ ← 출처 하이라이트(있을 때만)
│ React · TypeScript · Next.js  작업물 2건 일치│
│ [관심] [⋯]                          상세 › │
└────────────────────────────────────────────┘
```
원문 ↗ 은 상세 패널로만. 레인 버튼은 [관심] + 메뉴(지원/보류).

### 3.3 목록 컨트롤
- 출처 칩: 다중 선택 토글(`aria-pressed`), 건수는 현재 필터 반영. 실패 출처는 `aria-label="사람인 불러오기 실패"` + 목록 위 상태 문구.
- 정렬 드롭다운 `[추천 / 마감 임박 / 최신]` 과 필터 `[경력 / 신입·인턴 / 원격]` 분리. 작업물 0건이면 기본 정렬 = 마감 임박 + "작업물을 올리면 추천순" 안내.
- 칩·필터·정렬은 URL 쿼리에 반영(`?tab=jobs&src=…&sort=…`).

### 3.4 상세 패널 (`?job=<id>`)
순서: 출처·수집일 → 공통 조건 → 출처 하이라이트 → **[내 작업물로 지원] [원문 ↗] + "다른 출처: …" 한 줄** + 작은 고지 "요약 정보이며 원문이 우선합니다". 원문 본문 전체는 싣지 않는다.

### 3.5 모바일 (<768px)
레인 → 요약 한 줄. 출처 선택은 **필터 바텀시트 안 체크리스트(전체 이름)**, 목록 위엔 "출처 2개 선택됨 ×" 요약 칩. 상세는 **전체 화면 패널**(바텀시트 중첩 없음), 뒤로가기가 `?job=` 제거. 스택은 2개 + `+N`.

## 4. 코드 변경 범위

| 위치 | 변경 |
|---|---|
| crawler `platforms/` | `base.py`, `record.py`(허용목록 JSON Schema 검증), 공통 `store.py`(upsert 전 `crawl_blocklist` 확인), `jasoseol.py`(D4 후: sitemap → 상세 `__NEXT_DATA__`, 일일 요청 상한), `remember.py`(D3 후). 레지스트리가 `crawl_allowed=false` 면 즉시 종료. **크롤마다 robots 재측정 결과를 배치 메타에 기록** |
| 원티드 | `sources/wanted_api.py`(D2 키 발급 후). 키 이용범위 원문을 `platforms.api_or_partner_note`·legal_basis 에 기록, 저장 필드·캐시 기간을 그 조건에 맞춤. 같은 호스트 HTML 보조 조회 금지 |
| 기업 직접 등록 | 등록 폼(권리 확인 체크 + 등록자 ID 기록, 본문 길이 상한) → 같은 검수 큐, `ingest_method='manual'`, platform `manual`, URL 은 `external_apply_url` |
| orchestrator | `crawlReview.ts`: 테이블 상수, `CrawledRow`, `adapters[platform]`, `crossKey`/`assignDedupGroup`, 병합 시 `facts`·`ingest_method` 사본, **병합 후 링크 매핑 키를 `external_id` → `(source, external_id)`**(여러 플랫폼이 섞인 배치에서 ID 충돌), `deleteBatch` 전 제외 행 → `crawl_blocklist`. `jobPostings.ts`: DTO v2, `is_canonical`, 공개 범위(D7) |
| `/crawling` | 플랫폼 탭, 행 배지, facts 읽기 전용 표, 직접 등록 검수 |
| talentfolio | `lib/jobSources.ts`, `JobPost` 확장, `components/jobs/*`(SourceBadge, SourceFilter, JobCard, highlights/*, JobDetailPanel). 스카우트 건/`/sourcing` 상세에 "원 공고" 칸 |

## 5. 단계

| 단계 | 내용 | 사람 승인 |
|---|---|---|
| P0 | **D7 공개 범위 결정**, 결정에 맞춰 공개 API 범위 조정 | D7 |
| P1 | 014 확정 SQL(+`crawl_blocklist`, 사전 점검) + crawler `store.py`(차단 목록 확인) + crawlReview 테이블 상수·`deleteBatch` 차단 목록 이관을 **같은 배포**로. 사람인 회귀(적재·검수·배치 승인·공개 API) 통과 | 014 원격 적용(백업 후) |
| P2 | talentfolio 배지·칩·공통 고정 칸 (서버 변경 없이 `source` 로) | — |
| P3 | 015 + DTO v2 + 하이라이트·상세 + 스카우트 건 "원 공고" 칸 + `public_enabled` 전환 | 015 |
| P4 | 자소설 어댑터 소량 배치 → 검수 루프 | D4, legal_basis 갱신, **09 §7.2 위험 감수 재확인** |
| P5 | 016 중복 묶음 | 016 |
| P6 | 기업 직접 등록, 원티드 API(D2), 리멤버(D3) | 각각 + §7.2 재확인 |

## 6. 위험

| 위험 | 대응 |
|---|---|
| 공개 노출 = 경쟁 서비스 제공 주장 | D7, 크롤 출처 공개 기본 차단, 최소 필드, 보존기간 |
| 개인정보 유입(담당자명 등) | 키 허용목록(2곳) + DB 금지 키 CHECK + manual 마스킹 |
| 권리자 삭제 요청 | `platforms.public_enabled=false` 로 출처 단위 즉시 비노출 → 해당 행 삭제 절차(운영 문서) |
| 중복 오탐 | 자동 묶음은 1·2단계(recruit_kind·경력 범위 조건), 3단계는 검수자, 상세 "분리" 버튼 |
| 014 배포 장애 | 같은 배포 묶음 + 호환 뷰(읽기용) + 백업 |
| 약관 위반 | platforms CHECK(법적 확인 없으면 crawl 불가) + 트리거 + 레지스트리 + 크롤마다 robots 기록, 우회 금지 |
