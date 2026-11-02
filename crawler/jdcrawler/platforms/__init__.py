"""플랫폼 전용 수집기 레지스트리.

수집 코드는 플랫폼별, 저장은 공통 테이블 fit.crawled_postings (SQL 014, platform 컬럼).
플랫폼 이름은 불투명 코드(board_a …)다. 실제 수집처 주소는 crawler/.env 에만 둔다.
새 플랫폼 추가 절차:
  1) jdcrawler/platforms/<name>.py       — fetch(): 그 플랫폼 값을 그대로 담은 레코드(dict) 목록 생성
  2) 저장은 공통 jdcrawler/platforms/store.py (load_records(..., platform=<name>))
  3) fit.job_categories 시드(platform='<name>')
  4) 아래 PLATFORMS 에 등록
정본 fit.job_postings 병합은 orchestrator 검수(/crawling) 승인 시.

`site`(Crawl4AI 스키마) 명령은 건드리지 않는다. 이 패키지는 `platform <name>` 명령으로만 호출된다.
"""
from __future__ import annotations

# 이름 -> (수집 모듈, 저장 모듈). 문자열로 두어 DB 의존성(psycopg)을 수집 단계에서 import 하지 않는다.
PLATFORMS: dict[str, tuple[str, str]] = {
    "board_a": ("jdcrawler.platforms.board_a", "jdcrawler.platforms.store"),
}
