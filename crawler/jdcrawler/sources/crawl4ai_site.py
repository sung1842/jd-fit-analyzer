"""Crawl4AI 범용 어댑터 — JSON 스키마 파일 하나로 임의 채용 보드를 수집한다.

LLM 추출은 쓰지 않는다. `JsonCssExtractionStrategy`(CSS 셀렉터) 로만 뽑는다 → 결과가 결정적이고, 깨지면 어디가 깨졌는지 보인다.

스키마 파일 (crawler/schemas/*.json):
{
  "enabled": false,                                # 필수. true 가 아니면 fetch 가 RuntimeError (사이트별 명시적 켜기)
  "legal_basis": "",                               # 필수. 이 사이트를 수집해도 되는 근거(robots.txt 확인일, 약관 조항, 서면 허락 등). 공백이면 거부
  "source": "crawl4ai:example-board",              # fit.job_postings.source 값. 반드시 `crawl4ai:` 로 시작
  "base_url": "https://example.com",
  "allowed_hosts": [],                             # base_url 호스트 외에 따라가도 되는 호스트(하위 도메인 포함). 비면 base_url 호스트(+하위 도메인)만
  "delay": [3.0, 7.0],                             # 요청 사이 random.uniform(min, max) 초. 없으면 CRAWL_DELAY_MIN/MAX 환경변수 → (3.0, 7.0). min>=1, min<=max
  "max_runtime_sec": 3000,                         # 전체 실행 상한(초). 넘으면 남은 수집을 중단하고 지금까지 모은 것만 반환
  "list": {
    "url": "https://example.com/jobs?page={page}", # {page} 치환. 없으면 1페이지만
    "pages": 3,                                     # 상한 20 (초과 시 20 으로 줄임)
    "wait_for": "css:div.job-card",                 # 선택 (동적 렌더링 대기)
    "js_code": null,                                # 선택 (더보기 클릭 등)
    "schema": {                                     # Crawl4AI JsonCssExtractionStrategy 스키마
      "name": "jobs", "baseSelector": "div.job-card",
      "fields": [
        {"name": "title",       "selector": "h3",          "type": "text"},
        {"name": "url",         "selector": "a",           "type": "attribute", "attribute": "href"},
        {"name": "company",     "selector": ".company",    "type": "text"},
        {"name": "location",    "selector": ".location",   "type": "text"},
        {"name": "external_id", "selector": "a",           "type": "attribute", "attribute": "data-id"}
      ]
    }
  },
  "detail": {                                      # 선택. 각 공고 URL 을 열어 본문을 마크다운으로
    "css_selector": "section.job-description",     # 본문 영역만 (없으면 페이지 전체)
    "wait_for": null,
    "fields": {                                    # 선택. 상세 페이지에서 추가로 뽑을 단일 값
      "schema": {"name": "detail", "baseSelector": "body", "fields": [
        {"name": "salary", "selector": ".salary", "type": "text"},
        {"name": "skills", "selector": ".skill-tag", "type": "list", "fields": [{"name": "v", "type": "text"}]}
      ]}
    }
  },
  "defaults": {"employment_type": null}
}

필드 매핑: title, url, company, location, employment_type, experience_level, salary, skills, external_id, posted_at(ISO), description
external_id 가 없으면 url 의 sha1 앞 20자.

안전장치 (사용자가 위험을 감수하고 추가 사이트 수집을 결정했으나, 아래는 코드로 강제한다):
- 봇 UA 에 연락처 명시: `CRAWLER_USER_AGENT` 또는 `CRAWLER_CONTACT`(이메일/URL) 환경변수 필수. UA 는 `jdfit-crawler/1.0 (+contact:<연락처>)`.
- 실패 재시도 최대 2회(2s, 4s 백오프). 첫 목록 페이지 실패/빈 결과는 RuntimeError("list_failed_or_empty ...").
- robots.txt 준수(`check_robots_txt=True`). robots 에 걸린 URL 은 재시도 없이 포기.
- `ignore_https_errors=False` (Crawl4AI 기본값은 True 라서 명시).
- 오프사이트·비 http(s)·사용자정보 포함 URL 은 따라가지 않고 저장하지도 않는다.
- description·raw 의 이메일/전화번호는 `[email]`/`[phone]` 으로 마스킹.
- 로그는 stderr 로만 (CLI 가 stdout 마지막에 JSON 요약을 내므로 stdout 오염 금지).

프록시/UA 로테이션을 구현하지 않는 이유:
1. 채용정보 DB 크롤링 판례(서울중앙지법 2015가합517982)가 VPN·IP 분산, UA 미표기, robots 미확인을 부정경쟁(업무방해) 판단 근거로 들었다 → 식별 가능한 고정 UA + robots 준수가 최소 방어선이다.
2. 무료 공용 프록시는 운영자가 TLS 를 가로채는(MITM) 경우가 흔해 수집 데이터·세션이 변조/유출될 수 있다.
3. 차단을 우회하는 행위 자체가 '차단 의사 무시' 증거가 된다 → 차단되면 우회하지 말고 해당 사이트를 포기한다.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import random
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Collection, Mapping, Optional
from urllib.parse import urljoin, urlparse

from ..models import JobPosting
from ..pii import mask_pii
from ..redact import redact, safe_error

POSTING_FIELDS = {
    "title", "url", "company", "location", "employment_type", "experience_level",
    "salary", "skills", "external_id", "posted_at", "expires_at", "description",
}

DEFAULT_DELAY_RANGE: tuple[float, float] = (3.0, 7.0)
DEFAULT_MAX_RUNTIME_SEC = 3000.0
MIN_DELAY_FLOOR = 1.0
MAX_LIST_PAGES = 20
RETRY_BACKOFF_SEC: tuple[float, ...] = (2.0, 4.0)  # 실패 후 최대 2회 재시도(지수 백오프)


def _log(msg: str) -> None:
    """진단 로그는 stderr 로만 — stdout 은 CLI 의 JSON 요약 전용."""
    print(msg, file=sys.stderr, flush=True)


# ── 순수 함수(브라우저·네트워크 없이 테스트 가능) ──────────────────────────────

def validate_site_config(cfg: dict) -> None:
    """스키마가 '명시적으로 켜졌고, 허용 근거가 기록됐고, source 접두사가 맞는지' 검증한다."""
    if cfg.get("enabled") is not True:
        raise RuntimeError("사이트가 비활성화됨: enabled=true 가 아닙니다. 사이트별로 허용 근거를 확인한 뒤 명시적으로 켜세요")
    legal_basis = cfg.get("legal_basis")
    if not isinstance(legal_basis, str) or not legal_basis.strip():
        raise RuntimeError("legal_basis(허용 근거 기록) 필요: robots.txt 확인일·약관 조항·서면 허락 등을 적으세요")
    source = cfg.get("source")
    if not isinstance(source, str) or not source.startswith("crawl4ai:") or source == "crawl4ai:":
        raise RuntimeError("source 는 'crawl4ai:<이름>' 형식이어야 합니다")


def build_user_agent(env: Mapping[str, str]) -> str:
    """봇 UA 결정. CRAWLER_USER_AGENT 가 있으면 그대로, 없으면 CRAWLER_CONTACT 로 식별 UA 를 만든다."""
    custom = (env.get("CRAWLER_USER_AGENT") or "").strip()
    if custom:
        return custom
    contact = (env.get("CRAWLER_CONTACT") or "").strip()
    if not contact:
        raise RuntimeError("CRAWLER_CONTACT(연락처 이메일/URL) 필요: 신원을 밝히지 않는 크롤은 하지 않는다")
    # UA 헤더 인젝션/형식 깨짐 방지: 공백·제어문자·괄호·세미콜론 불가, 이메일 또는 http(s) URL 만
    if any(ch.isspace() or ord(ch) < 32 or ch in "();" for ch in contact) or not (
        "@" in contact or contact.lower().startswith(("http://", "https://"))
    ):
        raise RuntimeError("CRAWLER_CONTACT 형식이 올바르지 않습니다: 이메일 또는 http(s) URL 이어야 합니다")
    return f"jdfit-crawler/1.0 (+contact:{contact})"


def safe_url(base_url: str, href: Optional[str], allowed_hosts: Collection[str]) -> Optional[str]:
    """href 를 base_url 기준으로 절대화하고, http(s) + 허용 호스트(또는 그 하위 도메인)일 때만 반환. 아니면 None.

    allowed_hosts 가 비어 있어도 base_url 의 호스트는 항상 허용한다. `evilexample.com` 같은 접미사 위장은 `.` 경계로 막는다."""
    if not isinstance(href, str) or not href.strip():
        return None
    try:
        joined = urljoin(base_url, href.strip())
        parsed = urlparse(joined)
        base_host = (urlparse(base_url).hostname or "").lower()
        host = parsed.hostname
        _ = parsed.port  # 잘못된 포트(:abc, :99999)는 여기서 ValueError
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or not host:
        return None
    # 사용자정보(http://a@evil.com)·백슬래시 우회(http://good.com\@evil.com) 차단
    if "@" in parsed.netloc or "\\" in parsed.netloc:
        return None
    allowed = {h.strip().lower() for h in allowed_hosts if isinstance(h, str) and h.strip()}
    if base_host:
        allowed.add(base_host)
    host = host.lower().rstrip(".")
    if not any(host == a or host.endswith("." + a) for a in allowed):
        return None
    return joined


def is_robots_block(msg: Optional[str]) -> bool:
    """Crawl4AI 의 error_message 가 robots.txt 차단인지(대소문자 무시)."""
    return bool(msg) and "robots" in str(msg).lower()


def _to_float(value: Any, name: str) -> float:
    try:
        num = float(value)
    except (TypeError, ValueError) as e:
        raise ValueError(f"{name} 는 숫자여야 합니다: {value!r}") from e
    if num != num or num < 0:  # NaN, 음수
        raise ValueError(f"{name} 는 0 이상의 숫자여야 합니다: {value!r}")
    return num


def _pick_delay(cfg: Mapping[str, Any], env: Mapping[str, str]) -> tuple[float, float]:
    """요청 간 지연 범위 결정: 스키마 "delay":[min,max] → 환경변수 CRAWL_DELAY_MIN/MAX → 기본 (3.0, 7.0).

    min>max 또는 min<1 이면 ValueError (1초 미만 간격은 서버 부담이라 허용하지 않는다)."""
    raw = cfg.get("delay")
    if raw is not None:
        if not isinstance(raw, (list, tuple)) or len(raw) != 2:
            raise ValueError(f'스키마 "delay" 는 [min, max] 두 숫자여야 합니다: {raw!r}')
        lo, hi = _to_float(raw[0], "delay[0]"), _to_float(raw[1], "delay[1]")
    else:
        env_min = (env.get("CRAWL_DELAY_MIN") or "").strip()
        env_max = (env.get("CRAWL_DELAY_MAX") or "").strip()
        lo = _to_float(env_min, "CRAWL_DELAY_MIN") if env_min else DEFAULT_DELAY_RANGE[0]
        hi = _to_float(env_max, "CRAWL_DELAY_MAX") if env_max else DEFAULT_DELAY_RANGE[1]
    if lo > hi:
        raise ValueError(f"지연 범위의 min({lo}) 이 max({hi}) 보다 큽니다")
    if lo < MIN_DELAY_FLOOR:
        raise ValueError(f"지연 범위의 min({lo}) 은 {MIN_DELAY_FLOOR:g}초 이상이어야 합니다")
    return lo, hi


resolve_delay_range = _pick_delay  # 하위 호환 별칭


# ── 변환 헬퍼 ────────────────────────────────────────────────────────────────

def _load_crawl4ai():
    try:
        from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig, JsonCssExtractionStrategy
    except ImportError as e:  # pragma: no cover
        raise RuntimeError("crawl4ai 가 설치되지 않았습니다: pip install -r crawler/requirements.txt && crawl4ai-setup") from e
    return AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig, JsonCssExtractionStrategy


def _markdown_of(result: Any) -> Optional[str]:
    md = getattr(result, "markdown", None)
    if md is None:
        return None
    fit = getattr(md, "fit_markdown", None)
    raw = getattr(md, "raw_markdown", None)
    text = fit or raw or (md if isinstance(md, str) else str(md))
    return text or None


def _flatten_list_field(value: Any) -> list[str]:
    """type:list 로 뽑은 [{'v': 'Java'}, ...] 또는 문자열 리스트를 평탄화."""
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    out: list[str] = []
    for item in value:
        if isinstance(item, dict):
            out.extend(str(v) for v in item.values() if v)
        elif item:
            out.append(str(item))
    return out


def _parse_dt(value: Any) -> Optional[datetime]:
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _mask_value(value: Any) -> Any:
    """문자열은 mask_pii, dict/list 는 재귀적으로 문자열 값만 마스킹."""
    if isinstance(value, str):
        return mask_pii(value)
    if isinstance(value, dict):
        return {k: _mask_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_mask_value(v) for v in value]
    return value


def _record_to_posting(
    source: str,
    base_url: str,
    rec: dict[str, Any],
    defaults: dict[str, Any],
    allowed_hosts: Collection[str] = (),
) -> Optional[JobPosting]:
    merged = {**defaults, **{k: v for k, v in rec.items() if v not in (None, "", [])}}
    title = merged.get("title")
    if not title:
        return None
    raw_url = merged.get("url")
    url = safe_url(base_url, str(raw_url), allowed_hosts) if raw_url else None  # 오프사이트/비 http(s) 는 저장하지 않는다
    external_id = merged.get("external_id") or (hashlib.sha1(str(url or title).encode("utf-8")).hexdigest()[:20])

    extra = {k: v for k, v in rec.items() if k not in POSTING_FIELDS}
    return JobPosting(
        source=source,
        external_id=str(external_id),
        url=url,
        company=merged.get("company"),
        title=str(title),
        description=_mask_value(merged.get("description")),
        skills=_flatten_list_field(merged.get("skills")),
        location=merged.get("location"),
        employment_type=merged.get("employment_type"),
        experience_level=merged.get("experience_level"),
        salary=merged.get("salary"),
        posted_at=_parse_dt(merged.get("posted_at")),
        expires_at=_parse_dt(merged.get("expires_at")),
        raw=_mask_value(extra) or None,
    )


# ── 수집 ────────────────────────────────────────────────────────────────────

def _parse_json_list(text: Optional[str]) -> list[Any]:
    """Crawl4AI extracted_content(JSON 문자열) → list. 비었거나 깨졌으면 빈 리스트."""
    if not text:
        return []
    try:
        data = json.loads(text)
    except ValueError:
        return []
    return data if isinstance(data, list) else []


async def _arun_with_retry(crawler: Any, url: str, run: Any, label: str) -> Optional[Any]:
    """arun 이 success=False 면 최대 2회 재시도(2s, 4s 백오프). robots 차단은 재시도 없이 포기. 성공 시 result, 실패 시 None."""
    attempts = len(RETRY_BACKOFF_SEC) + 1
    for attempt in range(attempts):
        try:
            result = await crawler.arun(url=url, config=run)
            ok, err = bool(result.success), getattr(result, "error_message", None)
        except Exception as e:  # 브라우저 크래시·타임아웃 등
            result, ok, err = None, False, safe_error(e)
        if ok:
            return result
        if is_robots_block(err):
            _log(f"[crawl4ai] robots 차단 {label} {url} — 재시도 없이 포기: {redact(err)}")
            return None
        if attempt < attempts - 1:
            wait = RETRY_BACKOFF_SEC[attempt]
            _log(f"[crawl4ai] {label} 실패(시도 {attempt + 1}/{attempts}), {wait:.0f}s 후 재시도: {redact(err)}")
            await asyncio.sleep(wait)
        else:
            _log(f"[crawl4ai] {label} 최종 실패 {url}: {redact(err)}")
    return None


async def fetch(
    schema_path: Path,
    delay_sec: Optional[float] = None,
    max_items: int = 500,
    headless: bool = True,
) -> list[JobPosting]:
    """delay_sec 가 주어지면 고정 지연(하위호환), None 이면 _pick_delay 범위에서 매 요청 사이 random.uniform.

    첫 목록 페이지가 실패/빈 결과면 RuntimeError("list_failed_or_empty ...") — 호출부가 failed 로 처리한다."""
    cfg = json.loads(Path(schema_path).read_text(encoding="utf-8"))
    validate_site_config(cfg)
    user_agent = build_user_agent(os.environ)
    if delay_sec is None:
        delay_lo, delay_hi = _pick_delay(cfg, os.environ)
    else:
        delay_lo = delay_hi = _to_float(delay_sec, "delay_sec")
    max_runtime = _to_float(cfg.get("max_runtime_sec", DEFAULT_MAX_RUNTIME_SEC), "max_runtime_sec")

    AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig, JsonCssExtractionStrategy = _load_crawl4ai()

    source: str = cfg["source"]
    base_url: str = cfg.get("base_url", "")
    allowed_hosts: list[str] = [h for h in (cfg.get("allowed_hosts") or []) if isinstance(h, str)]
    list_cfg: dict[str, Any] = cfg["list"]
    detail_cfg: Optional[dict[str, Any]] = cfg.get("detail")
    defaults: dict[str, Any] = cfg.get("defaults", {})

    pages = int(list_cfg.get("pages", 1)) if "{page}" in list_cfg["url"] else 1
    if pages > MAX_LIST_PAGES:
        _log(f"[crawl4ai] 경고: list pages={pages} 는 상한 {MAX_LIST_PAGES} 로 줄입니다")
        pages = MAX_LIST_PAGES
    list_strategy = JsonCssExtractionStrategy(list_cfg["schema"])

    started = time.monotonic()
    requests_made = 0

    def over_budget() -> bool:
        return time.monotonic() - started > max_runtime

    async def pause_before_request() -> None:
        """첫 요청을 제외한 모든 요청(목록·상세) 앞에서 쉰다 — 재시도 백오프와는 별개."""
        nonlocal requests_made
        if requests_made:
            await asyncio.sleep(random.uniform(delay_lo, delay_hi))
        requests_made += 1

    records: list[dict[str, Any]] = []
    browser_cfg = BrowserConfig(headless=headless, user_agent=user_agent, ignore_https_errors=False)
    async with AsyncWebCrawler(config=browser_cfg) as crawler:
        for page in range(1, pages + 1):
            if page > 1 and over_budget():  # 첫 페이지는 예산과 무관하게 시도(빈 결과를 성공으로 오인하지 않게)
                _log(f"[crawl4ai] 경고: max_runtime_sec={max_runtime:.0f}s 초과 — list 수집 중단 (page={page})")
                break
            url = safe_url(base_url, list_cfg["url"].replace("{page}", str(page)), allowed_hosts)
            if url is None:
                _log(f"[crawl4ai] list URL 이 base_url/allowed_hosts 밖이라 중단 page={page}")
                if page == 1:
                    raise RuntimeError("list_failed_or_empty: list.url 이 base_url/allowed_hosts 밖이거나 http(s) 가 아님")
                break
            run = CrawlerRunConfig(
                cache_mode=CacheMode.BYPASS,
                extraction_strategy=list_strategy,
                wait_for=list_cfg.get("wait_for"),
                js_code=list_cfg.get("js_code"),
                check_robots_txt=True,
                page_timeout=45_000,
            )
            await pause_before_request()
            result = await _arun_with_retry(crawler, url, run, f"list page={page}")
            batch = _parse_json_list(result.extracted_content) if result is not None else []
            if not batch:
                if page == 1:
                    # 조용한 실패 방지: 첫 페이지가 실패/빈 결과면 빈 리스트를 '성공'으로 돌려주지 않는다
                    reason = "arun 실패(robots 차단 포함)" if result is None else "추출 결과 0건(셀렉터 불일치 의심)"
                    raise RuntimeError(f"list_failed_or_empty {redact(url, 200)}: {reason}")
                break
            records.extend(batch)
            if len(records) >= max_items:
                break

        records = records[:max_items]

        if detail_cfg:
            detail_strategy = (
                JsonCssExtractionStrategy(detail_cfg["fields"]["schema"]) if detail_cfg.get("fields") else None
            )
            requested = 0
            detail_failed = 0
            for rec in records:
                href = rec.get("url")
                if not href:
                    continue
                if over_budget():
                    _log(f"[crawl4ai] 경고: max_runtime_sec={max_runtime:.0f}s 초과 — 남은 상세 수집을 중단하고 지금까지 {requested}건만 반환")
                    break
                detail_url = safe_url(base_url, str(href), allowed_hosts)
                if detail_url is None:
                    _log(f"[crawl4ai] detail 건너뜀(허용되지 않은 URL): {redact(href, 120)}")
                    continue
                await pause_before_request()
                requested += 1
                run = CrawlerRunConfig(
                    cache_mode=CacheMode.BYPASS,
                    css_selector=detail_cfg.get("css_selector"),
                    wait_for=detail_cfg.get("wait_for"),
                    extraction_strategy=detail_strategy,
                    check_robots_txt=True,
                    page_timeout=45_000,
                    excluded_tags=["nav", "footer", "header", "script", "style"],
                )
                result = await _arun_with_retry(crawler, detail_url, run, "detail")
                if result is None:
                    detail_failed += 1
                    continue
                rec.setdefault("description", _markdown_of(result))
                if detail_strategy and result.extracted_content:
                    extra = _parse_json_list(result.extracted_content)
                    if extra and isinstance(extra[0], dict):
                        for k, v in extra[0].items():
                            if v not in (None, "", []):
                                rec.setdefault(k, v)
            if detail_failed:
                _log(f"[crawl4ai] detail 실패 {detail_failed}/{requested}건 (건너뜀, 목록 정보만 저장)")

    postings: list[JobPosting] = []
    for rec in records:
        try:
            p = _record_to_posting(source, base_url, rec, defaults, allowed_hosts)
        except Exception as e:  # pydantic ValidationError 등 — 한 건 때문에 배치를 죽이지 않는다
            _log(f"[crawl4ai] 레코드 스킵: {safe_error(e)}")
            continue
        if p:
            postings.append(p)
    return postings
