# 매칭 엔진 레인 작업 노트 (2026-10-30~)

> 22 문서 E4~E7 + 보완을 레인별 에이전트가 병렬로 진행한다. 각 레인은 끝날 때 아래 자기 칸만 갱신한다.

## 공통 규칙
- 다른 레인 소유 파일은 고치지 않는다. 필요하면 노트에 "요청"으로 적는다.
- 원격 DB SQL 적용·컨테이너 재빌드는 하지 않는다 (리드 세션이 사용자 크롬으로 적용). SQL 파일만 만든다.
- 공유 규약: `shared/matchTypes.ts` (RankWeights, EffectiveWeights).
- SQL 번호: 022_match_vector_search(E4, 이미 초안) · 024 레인 A · 025 레인 B · 026 레인 D · 027 레인 C
- Redis 가 필요한 테스트는 임시 컨테이너(`docker run -d --rm -p 63xx:6379 redis:7-alpine`, 레인별 다른 포트)로. 끝나면 stop.
- 실데이터 확인은 tsx 스크립트(서비스 롤 db, MCP는 http://localhost:3002/mcp)로. 테스트용으로 만든 행은 지운다.
- Slack 발송 금지 (화면·로그만).

## 파일 소유
| 레인 | 소유 |
|---|---|
| A 매칭 핵심 (E4→E5) | orchestrator/src/lib/jdPlan.ts, lib/matchEngine.ts(신규), lib/jobRequirements.ts, sql/022_match_vector_search.sql, sql/024_*, test/matchEngine.test.ts, test/requiredFilter.test.ts |
| B 품질·보정 (E6→E6b) | orchestrator/src/lib/matchQuality.ts(신규), lib/rankingWeights.ts(신규), queue/weightsScheduler.ts(신규), sql/025_*, test/matchQuality.test.ts, test/rankingWeights.test.ts |
| C 데이터·보완 (D→F1→F2→F3) | crawler/ 실행, scripts/seed-*(신규), lib/candidateNorm.ts, queue/normalizeQueue.ts, mcp-server/src/tools/normalizeCandidate.ts, sql/027_*, talentfolio 저장 API 훅 |
| D 상시 수색 (E7) | queue/watchQueue.ts(신규), lib/watch*.ts(신규), sql/026_* — 레인 A 완료 후 |
| 공용 (리드만) | orchestrator/src/index.ts, server.ts, docs/architecture/22_*.md, 10_env_reference.md |

index.ts·server.ts 에 등록이 필요하면 노트에 "등록 요청: 함수명·경로"를 적는다. 리드가 한 번에 넣는다.

## 레인 상태
### A
**완료 (2026-10-30, E4·E5 코드 — SQL 미적용 경로로 실데이터 확인)**
- 바뀐 파일: `orchestrator/src/lib/matchEngine.ts`(신규, C 계산식·`loadEffectiveWeights`·`inputsHash`), `lib/jdPlan.ts`(B 단계 합집합·C 순위·match_scores 저장·응답 필드), `lib/jobRequirements.ts`(`getJobEmbedding`), `docs/architecture/sql/022_match_vector_search.sql`(검토 — 내용 유지, 순서 주석), `sql/024_match_scores.sql`(신규), `test/matchEngine.test.ts`(신규), `scripts/verify-match-engine.ts`(신규)
- **SQL 적용 순서**: 022_match_vector_search → 024_match_scores (025 레인 B 와 독립). 적용 후 `cd orchestrator && npx tsx ../scripts/verify-match-engine.ts` 로 vectorStage=applied·scoresSaved=숫자 확인.
- 등록 요청: 없음 (server.ts `/api/jd/plan` 은 buildJdPlan 반환값을 그대로 json 으로 내보내므로 수정 불필요).
- 설계 결정
  - match_scores 키 = `(jd_hash, candidate_id)` (jd_hash = cache.ts `jdHash`, fit_reports·Redis 캐시와 같음), `jd_run_id` 는 nullable. 근거: /api/jd/plan·스카우트 건·채널 초대 소싱은 jd_runs 행 생성 전에 순위를 만들고, jd_runs 는 (user, jd_hash) 단위라 같은 JD 에 여러 행. 22 문서 §5 갱신 요청(리드).
  - 벡터 단계 생략 시(022 미적용·임베딩 실패) vector 항목을 빼고 남은 가중치로 100점 환산 (`breakdown.excluded`). 아니면 모든 후보 최대 85점이 되어 D_MIN_RANK 의미가 바뀜.
  - 벡터 상위 K 밖·의미 지문 없는 후보 vector=0. 공고 직무 없음 role=1, 후보 직무 모름 role=0.5, 경력 정보 없음 years=0.5, 우대/필수 없음 해당 항목 1.
  - activity 근사: 최근 로그인·수정 시각이 없어 `candidate_profiles_norm.changed_at`(정규화 결과가 바뀐 시각) 사용. 30일 1.0 / 90일 0.5 / 그 외·없음 0.2. 22 문서 §6.4 주석 요청.
  - 필수 미충족 상한 50 동점은 상한 전 점수(raw) → id 순 (실데이터에서 전원 50 동점 발견 후 수정, 회귀 테스트 추가).
  - 가중치: `matchEngine.loadEffectiveWeights` 가 `./rankingWeights.js` 를 동적 import (없거나 실패 시 기본값·version "default"). `buildJdPlan` 5번째 인자 `scope` 추가 — scoutCases(client_name) 연결은 리드 판단.
  - match_scores 저장: 상위 C_TOP_N upsert, 이번에 빠진 ranked 행 삭제, stage≠ranked(D 진행 중) 행은 inputs_hash 가 같으면 덮지 않음.
  - D 단계: 후보별 `analyzable`(rank ≥ D_MIN_RANK) + `analyzableCount` 표시만. runFitAnalysis 흐름 변경 없음.
  - 응답 추가 필드: 후보별 `rankScore`·`scoreBreakdown`·`analyzable`·`via`, 전체 `vectorStage`·`weightsVersion`·`analyzableCount`·`scoresSaved`. `ranked` 정렬이 rankScore 순으로 바뀜(기존 필드 유지).
  - SSE `ranked`: /api/jd/plan 은 동기 JSON(SSE 없음)이라 넣지 않음. 설계: E7 상시 수색/202 전환 시 `ranked {jdHash, top:[{candidateId,rankScore}]}` 이벤트를 match_scores 저장 직후 발행.
- 헌법 점검: 2조 — HTTP 안 추가 비용은 임베딩 1회(022 적용 후, 캐시 행 없을 때만) + RPC 1회 + DB 3회, LLM 생성 호출 증가 없음. 3조 — RPC 는 (id, similarity)만 반환, 임베딩은 DB 내부 비교.
- 테스트: `test/matchEngine.test.ts` 7건 (T5·T6·벡터 없음 호환·가중치 주입·rankingWeights 실패 폴백·상한 동점) + requiredFilter 5건 통과. 전체 실행 시 crawlReview.test.ts 만 실패(기존 Redis 환경 문제). tsc orchestrator·mcp-server 통과.
  - 주의: matchEngine 은 db 를 import 하지 않게 함 (db/redis 를 여는 모듈을 테스트에서 불러오면 Windows 에서 force-exit 시 libuv assertion 으로 파일 실패).
- 실데이터(미적용 경로, 2회 실행 동일 순위·점수 확인): 백엔드 JD → 개발자 9명 중 직무 제외 2, 기술 일치 6, vector=skipped, 저장=skipped(PGRST205), 1.7초. 디자이너 JD → 9명 전원 통과, 기술 일치 8.
- 남은 문제
  - 공고 정규화가 "MySQL 또는 PostgreSQL" 을 필수 2개로, "디자인 시스템 구축 경험" 을 기술명으로 뽑음 → 전원 필수 미충족 → 상한 50, D 후보 0명. normalize_job 의 OR 그룹·경험 문장 분리 개선 필요(mcp-server, 레인 C 또는 리드).
  - 직군·키워드 직접 입력 경로(talentfolio JdMatchModal)는 job_requirements_norm 행이 없어 022 적용 후 매 요청 임베딩 1회 재계산(저장 불가). 필요하면 Redis 캐시 또는 행 생성 결정 필요.
  - activity 는 지금 전원 1.0 (정규화가 최근) — 실제 활동 시각 컬럼 생기면 교체.
  - 호스트에 Redis 미노출이라 스크립트 실행 시 ioredis ECONNREFUSED 로그(동작엔 영향 없음).
- **리뷰 1라운드 반영 (2026-10-31)**
  1. match_scores 요건 구분: `score_breakdown.reqHash`(사용 요건 sha256) 기록. 저장 키 = 기본(LLM 정규화) 경로는 `jdHash` 그대로(fit_reports 조인 유지), reqOverride·직접 키워드 경로는 `${jdHash}:${reqHash 앞 8자}`. 삭제는 같은 키·같은 reqHash 의 ranked 행만, `.in()` + id 검증(영숫자/-/_).
  2. 재순위 upsert 에 `fit_report_id: null` 명시.
  3. 헌법 2조: match_scores 저장(select·upsert·delete)을 응답 뒤 fire-and-forget(실패 로그+Sentry). 응답 `scoresSaved` = `"queued" | "skipped"`. 임베딩은 캐시 행 없을 때만 1회라 유지(주석).
  4. `vectorStage`·`vectorAvailable` 은 RPC 결과가 1건 이상일 때만 applied.
  5. **근사 명시**: 기술 일치 후보가 벡터 상위 B_TOP_K 밖이면 유사도를 받지 않아 vector=0 (B_TOP_K=300 이라 현 데이터 규모에선 영향 없음).
  6. channelInviteSourcing: analyzable 우선 후 나머지로 채워 slice.
  7. 테스트 추가 4건(yearsItem 경계, activityItem 30/90일, 계층 0.7 → 필수 충족, 빈 벡터 → vector 제외). matchEngine 11건 통과, tsc 통과. requiredFilter 5건 통과하나 Redis 미노출 시 프로세스가 안 끝나 파일 단위 실패(환경). verify 스크립트: vector=applied, 저장 queued → 백엔드 7행·디자이너 8행 reqHash 기록 확인 후 삭제.
### B
**완료 (2026-10-30) — E6 품질 지표 + E6b 층별 보정**
- 바뀐 파일(모두 신규): `orchestrator/src/lib/matchQuality.ts`, `lib/rankingWeights.ts`, `lib/matchQualityRoutes.ts`, `queue/weightsScheduler.ts`, `docs/architecture/sql/025_ranking_weights.sql`, `test/matchQuality.test.ts`, `test/rankingWeights.test.ts`, `scripts/verify-match-quality.ts`
- 적용 필요 SQL: `025_ranking_weights.sql` (fit.ranking_weights, RLS on·정책 없음 = 서비스 롤 전용). 미적용이어도 기본값으로 동작.
- 등록 요청 (리드):
  - api 역할: `startWeightsScheduler()` (queue/weightsScheduler.ts, 매주 월 05:00, env `RANKING_WEIGHTS_CRON`), `registerMatchQualityRoutes(app)` (lib/matchQualityRoutes.ts → `GET /api/admin/match/quality?from&to&company&recruiter`, `GET /api/admin/match/weights?company&recruiter`, adminPasswordGate — server.ts publicPaths 에 `/api/admin/match` 추가 필요 시 candidateNorm 과 동일하게)
  - worker 역할: `startWeightsWorker()`, 종료 시 `closeWeightsQueue()`
  - 10 문서: `RANKING_WEIGHTS_CRON` 추가
- 설계 메모 (22 문서 §7 반영 요청):
  - 결정 = fit_reports.report.review 우선, 없으면 status approved/rejected 로 근사(decidedAt=updated_at, 결정자=user_id). 기업 = jd_runs.client_name ((user_id, jd_hash) 매칭), 헤드헌터 = review.decidedBy. 거절 사유 = status_events.reason_code 우선, 없으면 deskMetrics.reasonCode(review.reason). 수락율 = 결정에 연결된(payload.fitReportId) 발송 candidate_offer 중 interested.
  - 학습은 로지스틱 회귀 대신 **그룹 평균 차이**: b_i = clamp(gap_i(층) − gap_i(전체), ±0.2), gap = 승인 평균 − 거절 평균. 층별 수십 건·항목 상관으로 회귀가 불안정해서. 승인/거절 한쪽만 있는 층은 보정 없음. global 행은 학습하지 않음(수동 절대 가중치, 없으면 DEFAULT).
  - 반환 boost 는 α 를 곱한 실제 반영 비율. version = `g{v}-c{v}-r{v}` (행 없으면 "default").
- 테스트: 신규 12개 통과. 전체 108 중 107 통과, 실패 1 = crawlReview.test.ts (기존 Redis 미노출 문제). matchEngine.test.ts(레인 A)도 통과 — 레인 A 의 동적 import 와 호환 확인. `tsc --noEmit` 통과. Redis 필요한 테스트 없음(학습·결합은 순수 함수).
- 실데이터 (읽기 전용): fit_reports 3, 결정 3(전부 review 있음), 승인율 1/3, 뒤집기율 0/3, 거절 사유 career_mismatch 2, 수락율 1/1, jd_runs 0행 → 기업 필터 대상 없음, status_events 거절 0행, match_scores 없음 → 학습 샘플 0, 유효 가중치 = 기본값 "default".
- **리뷰 1라운드 반영 (2026-10-30)**
  1. [high] 학습 샘플이 024 형태 `score_breakdown.items[k]` 를 읽음. `excluded`(예: vector) 항목은 평균에서 뺌. 순수 함수 `buildTrainingSamples` 로 분리.
  2. [high] `fit_report_id` 대신 `(jd_hash, candidate_id)` 로 fit_reports 결정과 조인 (024 PK와 같은 키). 결정의 jd_hash 목록으로 100개씩 `in()` 조회.
  3. [low] 이번 학습에 없는 기존 company/recruiter 행은 boost `{}`, sample_n 0, version+1 로 덮음 (`planWeightUpserts`). global 행은 건드리지 않음.
  4. [low] PostgREST `or()` 문자열 조립을 없애고 `in("scope_id")` 조회 후 코드에서 (scope, scope_id) 필터.
  5. 테스트 추가: 024 형태와 excluded, 조인 누락, version 증가와 리셋, table_missing / no_samples 경로(`recomputeRankingWeights(deps)` 주입), global 절대 가중치 + company + recruiter 동시 결합. 테이블이 없으면 이제 샘플 로드 전에 바로 table_missing 으로 끝남.
  - 결과: `tsc --noEmit` 통과. 전체 113 중 112 통과(실패 = crawlReview.test.ts 기존 문제). rankingWeights 테스트 7→11, matchQuality 5. 실데이터 학습 샘플은 여전히 0 (match_scores 미적용/빈 테이블).
- 남은 문제: ① 데이터가 적어 모든 지표 smallSample(<30) — 더미 결정 데이터(레인 C) 필요 ② jd_runs 가 비어 기업별 보정 불가 (fit_reports→jd_runs 연결이 실제로 기록되는지 확인 필요) ③ status_events 에 fit_report 거절이 기록되지 않음 — HIL 거절 경로에서 recordStatusEvent 호출 여부 확인 ④ 024(match_scores) 적용 후 학습 재확인.
### C
**완료 (2026-11-02, D1·D2 데이터 + F1·F2 코드)**
- **D1 크롤 (승인 대기, 사용자 /crawling 승인 필요)**: 배치 `lanec-test-20261030-k11`~`k19` 9개 × 10건 = **90건** (prepare 까지만, 행 승인 안 함). robots 2026-10-30 재확인(`/zf_user/search`·relay 상세 Disallow 아님), 기존 지연·UA 그대로.
  | 배치 | 키워드 | ok | needs_review |
  |---|---|---|---|
  | k11 | 백엔드 개발자 | 6 | 4 |
  | k12 | 프론트엔드 개발자 | 8 | 2 |
  | k13 | 풀스택 개발자 | 8 | 2 |
  | k14 | 안드로이드 iOS 개발자 | 9 | 1 |
  | k15 | 데이터 엔지니어 | 8 | 2 |
  | k16 | 머신러닝 엔지니어 | 7 | 3 |
  | k17 | DevOps 엔지니어 | 8 | 2 |
  | k18 | UI UX 디자이너 | 4 | 6 |
  | k19 | 그래픽 디자이너 | 5 | 5 |
  - 사고: 첫 시도(k1~k9)는 Git Bash curl 이 한글 검색어를 깨뜨려(U+FFFD) 무관 공고 수집 → 대기 잡 제거, k2 배치(10건) DELETE API 로 삭제(k1·k3 는 0건). 재실행은 Python 으로 UTF-8 전송. CRAWLER_API_KEY 2중 정의는 실행에 영향 없었음(뒤 값 = orchestrator 값), 정리 권장.
- **D2 후보 — 원격 삽입 멈춤**: `public.profiles.id` → `auth.users(id)` FK (`profiles_id_fkey`, ON DELETE CASCADE) 확인. 후보 1명 = 인증 계정 1개가 필요(talentfolio `scripts/seed-profiles.mjs` 도 signUp 방식) → 금지 조건이라 계정 생성·삽입 스크립트 안 만듦. 사용자 결정 필요: (a) 테스트 계정 80개 생성(auth admin API, 이메일 `@talentfolio.test`) 허용 여부, 또는 (b) 매칭 테스트를 profiles 없이 `candidate_profiles_norm`/별도 fit 테스트 테이블로 직접 넣는 방식.
  - 생성 데이터만 저장: `scripts/data/test-candidates.json` **80명**(가명, 회사 "(가짜)", long_bio 끝 `[TEST]`, 연락처 없음). 분포: Java/Spring 백엔드 16(경계 2 포함, 리드 요청 반영) · Node 백엔드 6 · Python 백엔드 4 · 프론트 11 · 풀스택 7 · 안드로이드 5 · iOS 3 · Flutter 1 · 데이터 6 · ML 5 · DevOps 6 · UI/UX 7 · 그래픽 3. 연차 신입~12년, 지역 서울 중심 11개 시도, 원격 가능 약 20%.
  - 경계 사례 10명(test_id `edge-*`): 풀스택→백엔드, Java만, JavaScript만, 경력 1년 부족, 원격+부산, 디자인만, 신입 프론트, DE vs ML, Kotlin 안드로이드, 시니어 DevOps.
  - `scripts/data/match-scenarios.json` 8개 시나리오 (crawled_postings id 기준 — 승인·병합 후 job_postings id 로 치환 필요).
- **F1**: `candidateNorm.ts` — mapSkills 가 사전 밖 기술의 연수·실무(unmappedDetails) 반환, 저장 시 `unmapped_skill_details` (027 미적용이면 컬럼 없음 오류 감지 후 기존대로 저장, 프로세스 내 캐시 → 027 적용 후 orchestrator 재시작 필요). `remapStored`(순수)·`remapAllCandidates`(LLM 0회, 바뀐 행만 changed_at 갱신). `normalizeQueue.ts` 에 `remap` 잡 + `enqueueRemap`, 바뀐 후보는 추천 재계산.
- **F2**: orchestrator `selfNormalizeHandler`·`registerCandidateSelfNormalizeRoutes` (`POST /api/candidates/me/normalize`, 사용자 JWT sub 만 사용·body 무시, 토큰 없으면 401, 큐 실패 503). talentfolio `src/lib/profileNormalizeHook.ts`(2초 묶음, 5초 타임아웃, 절대 throw 안 함) → `ProfileEditModal` 저장·`studioData` saveBasics/saveItem/deleteItem 성공 뒤 호출.
- 바뀐 파일: orchestrator/src/lib/candidateNorm.ts, lib/candidateNormRoutes.ts, queue/normalizeQueue.ts, test/candidateRemap.test.ts(신규), docs/architecture/sql/027_candidate_unmapped_skill_details.sql(신규), scripts/data/test-candidates.json·match-scenarios.json(신규), talentfolio src/lib/profileNormalizeHook.ts(신규)·src/components/ProfileEditModal.tsx·src/components/studio/studioData.ts.
- **적용 필요 SQL**: 027 (리드 요청).
- **등록 요청**: ① server.ts 에서 `registerCandidateSelfNormalizeRoutes(app)` (authGate 뒤, publicPaths 에 넣지 말 것) ② publicPaths 정규식 `/^\/admin\/candidates\/normalize(\/stats|\/remap)?$/` 로 확장 (관리자 remap 라우트는 registerCandidateNormRoutes 안에 이미 있음).
- 테스트: candidateRemap 7건 + candidateNorm 기존 = 15/15 통과. tsc 통과(orchestrator·mcp-server·talentfolio).
- **D2 투입 (2026-11-02, 사용자 승인 "테스트 계정 생성")**: `scripts/seed-test-candidates.ts` 로 80계정(`<test_id>@talentfolio.test`, metadata test=true, 비번 랜덤·미저장) + profiles(본인 세션 update — service_role 은 public.profiles 권한 없음, 행은 가입 트리거가 생성) + resume_basics·resume_experiences(154행)·consents(matching). 매핑 `scripts/data/test-candidates.ids.json`. 정규화 80건 큐 투입(진행 중 확인 필요). 시나리오 7/8 은 job_postings.raw.crawled_posting_id 로 매핑, 1건(Node 신입 백엔드) 미병합 → 1b81f947(주니어 풀스택 Node) 대체. 삭제 `scripts/delete-test-candidates.ts --yes`.
- 남은 문제: 시나리오 대체 1건 검토, skillDictionary 10분 캐시라 사전 수정 직후 remap 은 최대 10분 지연, crawler/.env CRAWLER_API_KEY 중복 정리.
### D
**완료 (2026-10-30, E7 코드 — 026 미적용 경로로 실데이터 확인)**
- 바뀐 파일: 신규 `orchestrator/src/lib/watchCore.ts`(순수 로직), `lib/watch.ts`(DB·Redis·큐 연결), `lib/watchRank.ts`(buildJdPlan 래퍼, 레인 A 파일 수정 없음), `lib/watchRoutes.ts`, `queue/watchQueue.ts`, `docs/architecture/sql/026_watch.sql`, `test/watch.test.ts`, `scripts/verify-watch.ts`. 수정: `shared/types.ts` SlackNotifyPayload.autoSource 에 `"watch"` 추가(1줄).
- 적용 SQL: `026_watch.sql` (선행 010·017·020). jd_runs 에 watch_enabled·watch_until·daily_llm_cap·scan_cursor·scan_completed_at·watch_checked_at + `fit.watch_hits`(PK (jd_run_id,candidate_id) = 1회 보장) · `fit.watch_digests`(unique(jd_run_id,digest_date)). RLS on·서비스 롤 전용. 미적용이면 활성 의뢰 건 0 으로 취급 → 잡 없음.
- 등록 요청 (리드):
  - api 역할: `startWatchSchedulers()` (queue/watchQueue.ts — tick 매시 20분 `WATCH_TICK_CRON`, digest 매일 08:00 `WATCH_DIGEST_CRON`), `registerWatchRoutes(app)` (lib/watchRoutes.ts → `GET|PATCH /api/jd-runs/:id/watch`, authGate 뒤, isOwner 소유자 확인 — publicPaths 추가 불필요)
  - worker 역할: `startWatchWorkers()`, 종료 시 `closeWatchQueues()`
  - 10 문서 env: `WATCH_DELTA_RATIO`(0.7) `SCAN_BATCH`(500) `WATCH_TICK_CRON` `WATCH_DIGEST_CRON` `WATCH_DRY_RUN`(1=잡 투입 안 함) `WATCH_REQUIRE_CONSENT`(1=fit.consents matching 동의자만) `WATCH_MAX_DAILY_CAP`(100) `WATCH_MAX_DAYS`(90) `WATCH_SOURCING_CHANNEL`
- 설계
  - 큐 `match-delta`(tick·delta·digest)·`match-scan`(scan), 모든 잡 priority 10, 의뢰 건별 dedup id. fit-analysis 잡은 paid 큐 priority 10(즉시 1·2 뒤), jobId=buildJobId, createFitReport 선행(기존 라우트와 동일).
  - 일일 상한 = 하루 fit-analysis 잡 수(daily_llm_cap, 잡당 LLM ≤5회). Redis Lua 로 total·scan 동시 예약(UTC 날짜 키). scan 은 cap×(1−ratio) 까지, delta 는 나머지 전부(delta 우선). 같은 (jd, 후보) 리포트가 이미 있으면 상한을 쓰지 않고 재사용.
  - 순위: buildJdPlan 이 후보 집합 인자가 없어 직군 전체를 코드로 순위 → 대상 집합으로 거름. 공고 정규화·임베딩은 jd 해시 캐시. 부수효과로 match_scores 갱신(즉시 매칭과 같은 키). 후보 집합 인자 추가는 레인 A 판단(요청, 필수 아님).
  - strong_fit → `sourcing_actions`(slack_notify, pending, autoSource "watch") 행만 생성 — autoSourcingFromJd/createSourcingWithApproval 은 notify_slack_approval 을 항상 호출해 재사용 안 함. 승인은 웹 /sourcing/review. 이미 approved/rejected 된 리포트는 다시 요청 안 함. 수확은 delta 주기에서만.
  - delta 첫 주기는 과거 변경 안 봄(PATCH 로 켤 때 watch_checked_at=now). 한 바퀴 끝나면 scan_completed_at → 이후 delta 만. 만료·마감은 tick 에서 빠지고 실행 시 재확인(per-run 반복 잡이 없어 제거할 반복 잡 없음).
  - 설정 PATCH: until 미래·90일 이내, 켜는데 기간 없으면 30일, 마감 건 켜기 409, 026 미적용 501.
- 테스트: `test/watch.test.ts` 14건 통과 (T9 상한 초과 시 D 잡 미생성, 리포트 재사용은 상한 미사용, rank<D_MIN_RANK 제외, 같은 후보 1회, 수확 1회·결정된 리포트 제외, 만료 건 제외, 커서 전진·한 바퀴 후 delta 만, delta 우선 배분 3/7, 요약·설정 검증). Redis 불필요(가짜 의존성). 전체 136 중 135 통과, 실패 = crawlReview.test.ts(기존). tsc 통과.
- 실데이터: `cd orchestrator && npx tsx ../scripts/verify-watch.ts` → 026 적용 false, 활성 0, watch_hits 없음, digest 건너뜀 = 호환 경로 OK. 항상 dry-run(잡·DB 쓰기 없음). 적용 후 절차는 스크립트 머리 주석.
- **리뷰 반영 (2026-10-31, 리드 지적 1~9)**
  - 1 등록 요청(server.ts): `reviewSourcingAction` 승인 분기, `try { const result = await callMcpTool(... "notify_slack" ...)` 바로 앞(현재 116행 근처)에
    `if (isWatchNoSend(sourcingAction.payload)) { const updated = await updateSourcingAction(id, { status: "approved", result: { ...baseResult, send: { skipped: "watch_no_slack" }, decidedBy: decidedBy ?? null } }); return { ok: true, status: updated.status }; }`
    (`import { isWatchNoSend } from "./lib/watchCore.js"`). Notion sync 가 필요하면 이 분기 안에서도 호출. `WATCH_APPROVAL_SEND_SLACK=1` 이면 기존처럼 발송.
  - 2 상한 초과(overCap>0)면 scan 커서·delta 기준 시각을 저장하지 않음 → 다음 날 같은 범위 재처리, 이미 넣은 후보는 hit 로 제외. (026 stage check 에 deferred 가 없어 SQL 변경 없이 처리)
  - 3 delta keyset: 기준 시각 = 읽은 마지막 행 changed_at (`WATCH_DELTA_PAGE`, 기본 2000), 빈 페이지면 유지.
  - 4 consents·digest 표시 `.in` 200 단위 분할, 실패 시 throw(진행 저장 없음).
  - 5 사용자 단위 상한 `WATCH_USER_DAILY_CAP`(기본 100) 을 같은 Lua 에 KEYS[3] 로 추가. 순수 기준 구현 `reserveCalc`. 10 문서 env 추가 요청: `WATCH_USER_DAILY_CAP`, `WATCH_DELTA_PAGE`, `WATCH_APPROVAL_SEND_SLACK`.
  - 6 createApproval 멱등: 같은 jdRunId·autoSource watch 승인 건에 이미 실린 후보는 재생성 안 함(`uncoveredCandidates`).
  - 7 tick 이 분석 중 hit 남은 비활성 건도 delta 로 넣고(수확만), processWatchRun 은 비활성이어도 수확.
  - 8 watchRoutes: run.user_id 없으면 403 (`watchAccessAllowed`).
  - 9 같은 날 digest 재실행은 `mergeDigest` 로 병합.
  - 테스트: watch.test.ts 23건 통과(항목별 1건씩 추가), 전체 150 중 149(crawlReview 기존 실패). tsc 통과.
  - 실데이터(026 적용 후): 026 적용 true, 활성 의뢰 건 0, watch_hits 0행, consents(matching) 1행. **jd_runs 가 0행**이라 dry-run 주기는 못 돌림 — 의뢰 건 생성·PATCH 로 켠 뒤 `npx tsx ../scripts/verify-watch.ts --run <id>`.
- 남은 문제
  - 개인정보: 후보 쪽 구직 동의 플래그가 candidate_profiles_norm·profiles 에 없음. 015 `fit.consents(purpose='matching')` 가 있으나 현재 1행이라 기본 off(`WATCH_REQUIRE_CONSENT=1` 로 켬, 후보 id = auth user id 전제). 운영 전 동의 기준 결정 필요(리드/사용자).
  - 상한이 계속 모자라면 같은 scan 배치를 매시 다시 순위 계산(코드 비용만, LLM 0).
  - 승인 시 Slack 미발송은 위 1 등록 요청이 server.ts 에 들어가야 완성.
  - SSE `ranked` 이벤트(레인 A 제안)는 미구현 — 화면은 GET /api/jd-runs/:id/watch 로 조회.

### A2 공고 정규화 수정
- 문제: `normalize_job` 이 "MySQL 또는 PostgreSQL" 택일을 필수 2개로, "디자인 시스템 구축 경험" 같은 문장을 기술로 뽑아 후보 전원 필수 미충족(상한 50).
- 바뀐 파일
  - `mcp-server/src/tools/normalizeJob.ts`: 스키마에 `must_any_of`(string[][]), `must_experiences`(string[]) 추가, 프롬프트에 3칸 분리 규칙. 1개짜리 그룹은 필수로, 그룹 항목은 must 에서 제거.
  - `orchestrator/src/lib/jobRequirements.ts`: `JOB_NORM_VERSION` 기본 2, `isCurrentRow`(버전 낮은 행 재정규화), `parseGroups`, `refineRequirements`(사전 이름=기술, 사전 밖 문장=경험), `splitAltGroups`(JD 원문 "A 또는/혹은/or B" 로 이어진 필수 쌍 → 택일 그룹; LLM 이 놓쳐도 결정적 보정). 새 칸은 jsonb `req_groups` 에 저장, 028 미적용이면 택일 항목을 must_skills 에 펼쳐 저장(읽을 때 splitAltGroups 로 복원).
  - `orchestrator/src/lib/matchEngine.ts`: `mustCoverage()` — 필수 기술 각 1칸 + 택일 그룹당 1칸(그룹 내 최고 matchScore), 누락은 "A 또는 B". `scoreCandidate` 가 사용.
  - `orchestrator/src/lib/jdPlan.ts`: `rankByRequirements` 가 mustCoverage 사용, LLM 경로에서만 refineRequirements 적용(헤드헌터 조정본·직접 키워드는 그대로), keywords·unmapped 에 그룹 포함.
- SQL: `docs/architecture/sql/028_job_requirements_groups.sql` (`req_groups jsonb` 추가, 원격 미적용 — 현재 컬럼 없음 42703 확인, 미적용 경로로 동작).
- 테스트: `orchestrator/test/jobNormGroups.test.ts` 10건(택일 충족·전부 누락·rankByRequirements·경험 분리·옛 형식·캐시 버전·parseGroups·원문 택일 보정). 전체 137 중 135 통과, 실패 crawlReview(Redis 미노출, 기존) · life.test(Redis 연결/Windows 핸들 크래시, 이번 변경과 무관 — 동시 작업 중인 lifeRoutes 쪽).
- 실데이터(host mcp-server :3012, 확인 후 종료): 새 프롬프트 출력 backend must=[Java,Spring Boot] any_of=[[MySQL,PostgreSQL]] exp=[REST API 설계 경험] / designer must=[Figma] exp=[디자인 시스템 구축 경험, 경력 2년 이상].
  - designer: D후보 0 → **8** (must=1, 최고 84.73).
  - backend: 누락이 "Java,Spring Boot" 만 남음(DB 택일은 5명 충족), D후보는 여전히 0 — 백엔드 후보 9명(직무 통과 7) 중 Java/Spring Boot 보유자가 없음 = 정규화가 아니라 **데이터 문제**(더미 물량, 레인 C).
- 남은 것: ① 028 원격 적용 ② 이전에 옛 MCP 로 저장된 v2 캐시 2행(must 에 MySQL·PostgreSQL 동시 포함)은 splitAltGroups 로 보정되어 쓰임, 정리 원하면 `delete … where norm_version < 2` 및 해당 행 삭제 ③ 검증용으로 v3·v4 키 행이 생김(무해) ④ 도커 mcp-server 재빌드 전까지 운영 경로는 옛 프롬프트(오케스트레이터 보정으로 택일은 복구, 경험 문장은 사전 밖이면 경험으로 이동) ⑤ scoutCases 의 CaseRequirements 는 택일 그룹을 아직 표현하지 못함(toCaseRequirements 에서 그룹 손실).
- 리뷰 보정(리드, 028 원격 적용 후): ① `getJobRequirements` 첫 select 오류는 `isMissingColumn`(42703/PGRST204)일 때만 028 미적용으로 보고, 다른 오류는 LLM 경로로(잘못된 미적용 판단·펼침 저장 방지) ② `normalizeJob` 1개짜리 택일 그룹 승격분을 must 상한(8) 자른 뒤 붙이고 전체 상한 12 로(잘림 방지). 테스트 +1(isMissingColumn).
