# 11. 재설계 체크리스트 (상태 요약표)

> CLAUDE.md 에서 이관(2026-10-24, 내용 동일). 재설계 항목 작업·상태 갱신 때만 읽는다. 원문·판단 근거는 08.

## 🔧 재설계 체크리스트 (Master Architecture Redesign, 2026-10-19~)

> 원문·판단 근거·세부 상태는 [docs/architecture/08_redesign_master_guide.md](08_redesign_master_guide.md).
> **한 번에 한 항목만** 진행하고, 끝나면 여기와 08 문서를 같이 갱신한다. **같은 지침을 두 세션에 동시에 넣지 말 것** (파일 충돌 발생 이력).

| # | 항목 | 상태 |
|---|---|---|
| 1 | Single DB — `fit` 스키마 SQL(010) + 백엔드 클라이언트 전환(legacy 폴백) + `verify-setup.ts` single 기준 | ✅ 코드 · ✅ **`fit` 스키마 원격 적용·조회 확인(2026-10-20)** / ⬜ 구 DB 데이터 이전, 모든 테이블 0행 / ✅ Exposed schemas 에 `fit` 추가(`public` 유지, anon 은 42501 로 차단 확인) |
| 2 | Supabase JWT — orchestrator 미들웨어(jose/JWKS), 라우트 userId→토큰 sub, 소유권 검사, web 로그인 게이트+Bearer | ✅ 코드 / ✅ talentfolio Bearer 전송·`AUTH_MODE=required` (2026-11-03, 23 문서 G2) + 계정 유형 가드 / ⛔ MCP 서버 JWT는 내부 키로 대체(의도) |
| 3 | BullMQ concurrency 3 + Gemini 호출단 RPM 리미터(`GEMINI_RPM`) | ✅ (지침의 `Queue({limiter})` 예시는 BullMQ v5에 없음 — Worker 옵션) |
| 4 | MCP Streamable HTTP(기존) + 내부 키 `MCP_INTERNAL_KEY` | ✅ 코드 / ⬜ 키 값 설정 |
| 5 | `NEXT_PUBLIC_API_URL`(우선) / `NEXT_PUBLIC_ORCHESTRATOR_URL` 폴백 + CORS 화이트리스트 | ✅ / ⬜ 배포 시 `CORS_ALLOWED_ORIGINS` |
| 6 | 크롤러 — DB 측 SQL ✅, `crawler/` `py_compile` 통과, Crawl4AI 스키마 어댑터 + 사람인 직접 크롤(`platforms/`) 있음 (사람인 API 어댑터 2026-10-25 삭제) | ✅ `crawler/.env` 의 `SUPABASE_DB_URL` 키 존재 / ⚠ 이 PC에서 Session pooler 직결은 2026-10-24 `ConnectionTimeout` (2026-10-20 성공 기록과 불일치) / ✅ 수집원 확정(2026-10-24): **직접 크롤링** — `saramin.py` 10건 수집 / ✅ 011·012 원격 적용: `fit.job_categories`(21), `fit.saramin_postings`(10행 테스트 적재, MCP SQL), `fit.saramin_posting_categories` / ⬜ `platform-load` 로컬 직결 재확인 / ⬜ 어댑터화(JobPosting 변환→gate→적재) / ⛔ 링크드인 / ✅ `POST /v1/trigger` 코드 / 🟡 HIL 검수 UI: 코드 완료(2026-10-25, web `/crawling` + orchestrator `/api/admin/crawl/*` + SQL 013) — ✅ 013 원격 적용(2026-10-25, 직결 성공), 10행 prepare: 통과 9(전부 샘플)·격리 1 |
| v2-2 | Postgres 검색 — tsvector/skills GIN ✅, pg_trgm·임베딩 컬럼 ⬜ | ⛔ "한국어 형태소 분석기"는 Supabase에 없음 → pg_trgm+simple+pgvector 조합 |
| v2-4 | FastAPI 전면 전환 | ⛔ orchestrator 는 Node 유지(BullMQ 는 Node 전용, talentfolio 가 `:3001` 호출). ✅ 대신 **크롤러만 FastAPI 서버**(`crawler/jdcrawler/server.py`, 127.0.0.1:8010, 내부 키 인증) |
| 7 | DB 보안 하드닝 (Supabase 어드바이저) | ✅ 2026-10-20: `vector` 를 `extensions` 로 이동, `handle_new_user`·`rls_auto_enable` EXECUTE 회수, `search_path` 고정 2건. 롤백 테스트로 가입 트리거·자동 RLS·`updated_at` 검증. 보안 WARN 은 유출 비밀번호 보호(유료, 스킵)만 남음 / 🟡 fit 소유 성능 경고(RLS initplan·FK 인덱스 2건) — SQL 033 작성(2026-11-03), SQL Editor 실행 대기 |
| 8 | `.cursorignore` (검색 제외) | ✅ 사용자 생성 |
| v2-5 | n8n 스케줄러/적재 알림/매칭 이메일 | ⏸ 2026-10-25 보류 (에러 웹훅 코드 유지, 크롤러 연동 삭제). [12_n8n_on_hold.md](12_n8n_on_hold.md) |
