"""소스 어댑터. 각 어댑터는 `async def fetch(...) -> list[JobPosting]` 를 노출한다.

- crawl4ai_site : JSON 스키마로 지정한 임의 채용 보드를 Crawl4AI 로 수집 (CSS 셀렉터 기반, LLM 미사용)

LinkedIn 어댑터는 의도적으로 없다. 비로그인 authwall + 자동화 금지 약관 + 공격적 봇 차단으로
"정확하게" 수집할 수 없고, 수집해도 재사용이 불가하다. 링크드인 데이터가 필요하면 공식 Talent API 계약이 유일한 경로다.
"""
