"""board_a 수집기 (HTML). 결과 레코드의 키는 fit.crawled_postings 컬럼명과 같다.

수집처 주소는 코드에 두지 않는다: crawler/.env 의 BOARD_A_BASE_URL (예: https://www.<host>). 없으면 수집 거부.

지킨 것(전부 코드로 강제): 식별 가능한 고정 UA(CRAWLER_USER_AGENT 또는 CRAWLER_CONTACT), 단일 IP, 프록시/UA 회전 없음,
모든 요청 check_robots_txt=True, 요청 사이 3~7초 랜덤 지연, 로그인·우회 없음, 이메일·전화 마스킹(mask_pii),
이미지는 받지도 저장하지도 않는다(이미지 CDN robots.txt 가 `Disallow: /` 이고 공고 본문 이미지 경로는 Allow 목록에 없음 → text_mode).
허용 근거·한계는 docs/architecture/09_crawler_pipeline.md 참고.

빈 값 처리(원인 4분류, 상세는 evaluate_quality):
  by_design      사이트가 '없음'을 명시(상시채용 등)            → 종료. 사람·LLM 안 부름
  fetch_failed   우리 쪽 요청 실패                              → 보충 시도 안 함, retry_later (다음 수집에서 재요청)
  extract_failed 페이지는 받았는데 구조를 못 읽음(여러 필드 동시 소실) → 행 단위 보충 안 함, retry_later + 배치 경보(셀렉터 점검)
  not_in_source  페이지는 정상, 그 필드만 없음                   → 본문 정규식 보충 → 그래도 없으면 (이미지형이면 needs_review, 아니면 종료)
LLM 재추출 단계와 검토 UI 는 아직 없다(설계만).
"""
from __future__ import annotations

import asyncio
import os
import random
import re
import sys
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Optional
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from ..pii import mask_pii
from ..redact import safe_error
from ..sources.crawl4ai_site import _arun_with_retry, build_user_agent

PLATFORM = "board_a"
# 수집처 주소 (crawler/.env). 테스트·미설정 시 .invalid 도메인 → 실제 요청은 나가지 않는다
BASE_URL = (os.environ.get("BOARD_A_BASE_URL") or "https://board-a.invalid").rstrip("/")
DEFAULT_LIST_URL = (
    BASE_URL + "/zf_user/search?searchType=search&searchword=%EA%B0%9C%EB%B0%9C%EC%9E%90"
    "&company_cd=0%2C1%2C2%2C3%2C4%2C5%2C6%2C7%2C9%2C10&exp_cd=1&panel_type=&search_optional_item=y"
    "&search_done=y&panel_count=y&preview=y&recruitPage=1&recruitSort=relation&recruitPageCount=100"
    "&inner_com_type=&show_applied=&quick_apply=&except_read=&ai_head_hunting=&mainSearch=y"
)
DETAIL_URL = BASE_URL + "/zf_user/jobs/relay/view?rec_idx={id}"
BODY_URL = BASE_URL + "/zf_user/jobs/relay/view-detail?rec_idx={id}&rec_seq=0"
DELAY = (3.0, 7.0)
HARD_CAP = 100           # 한 번에 수집할 수 있는 최대 공고 수. 목록 1페이지(recruitPageCount=100)로 끝나 페이지 넘김이 없다
BROWSER_CHUNK = 25       # 이 건수마다 브라우저를 새로 띄운다 (장시간 단일 브라우저의 메모리 누적·크래시 방지)
MAX_BROWSER_RESTARTS = 3 # 브라우저가 죽으면 남은 공고부터 새 브라우저로 이어간다. 이 횟수를 넘으면 중단(→ --resume)
BLOCK_STREAK = 3         # 연속으로 이 건수만큼 상세를 못 받거나 구조를 못 읽으면 차단 의심으로 중단
# 페이지 로딩: 네트워크가 잠잠해질 때(networkidle)가 아니라 필요한 요소가 보이면 바로 읽는다.
# 광고·트래커가 계속 요청을 보내면 networkidle 은 끝나지 않아 page_timeout 까지 기다리게 된다.
DETAIL_WAIT_FOR = "css:h1.tit_job, section.jview"
BODY_WAIT_FOR = "css:.user_content"
PAGE_TIMEOUT_MS = 30_000
# 차단·제한 페이지 문구 (휴리스틱). 보이면 우회하지 않고 멈춘다 — IP 변경·UA 위장·캡차 풀이는 하지 않는다.
BLOCK_MARKERS = re.compile(
    r"captcha|비정상적인\s*접근|접근이\s*(?:차단|제한)|자동화된\s*요청|too many requests|access denied", re.I
)
BODY_MAX_CHARS = 4000    # LLM 입력용 본문 상한 (헌법 3조). 1500 은 실측 10건 중 6건이 잘려 자격요건/우대가 유실 → 4000

# 상세 페이지 dt/dd 한글 라벨 → 영어 컬럼. 정규화(공백·*·· 제거) 후 매칭.
# 자격요건/우대사항 사이드바는 UI 문구가 섞여 버려서 넣지 않는다. 본문 불릿이 원본이다.
FACT_MAP = {
    "경력": "career_text",
    "학력": "education_text",
    "근무형태": "employment_type_text",
    "급여": "salary_text",
    "근무지역": "location_text",
    "직급직책": "position_text",
    "출퇴근시간": "work_hours_text",
    "근무일시": "work_hours_text",
    "지원금보험": "welfare_insurance_text",
    "급여제도": "pay_system_text",
    "선물": "gifts_text",
    "교육생활": "education_life_text",
    "근무환경": "work_environment_text",
    "조직문화": "org_culture_text",
    "리프레시": "refresh_text",
    "시작일": "apply_start_text",
    "지원방법": "apply_method_text",
    "대표자명": "ceo_name",
    "기업형태": "company_type_text",
    "업종": "industry_text",
    "사원수": "employee_count_text",
    "설립일": "founded_on_text",
    "매출액": "revenue_text",
    "홈페이지": "homepage",
    "기업주소": "company_address",
}
FACT_TEXT_MAX = 500
SKIP_FACT_LABELS = frozenset({"자격요건", "우대사항", "자격조건", "우대조건"})
DETAIL_LABELS = {  # 하위 호환: 테스트·주석이 쓰던 이름
    "career_text": "경력",
    "education_text": "학력",
    "employment_type_text": "근무형태",
    "salary_text": "급여",
    "location_text": "근무지역",
    "position_text": "직급/직책",
    "work_hours_text": "근무일시",
}
REQUIRED_DETAIL = ("career_text", "education_text", "employment_type_text", "salary_text", "location_text")
REQUIRED_ALL = ("company", "title") + REQUIRED_DETAIL
BY_DESIGN_DEADLINE = re.compile(r"상시|채용\s*시|수시")
CORE_BODY_KEYWORDS = re.compile(r"주요\s*업무|담당\s*업무|자격\s*요건|지원\s*자격|우대")

# 사이트 검색 필터의 직군 대분류. SQL 011 시드와 같은 이름. 페이지 태그에서 이 이름이 보이면 직군으로 인정한다.
TOP_CATEGORIES = frozenset(
    "기획·전략 마케팅·홍보·조사 회계·세무·재무 인사·노무·HRD 총무·법무·사무 IT개발·데이터 디자인 영업·판매·무역 "
    "고객상담·TM 구매·자재·물류 상품기획·MD 운전·운송·배송 서비스 생산 건설·건축 의료 연구·R&D 교육 "
    "미디어·문화·스포츠 금융·보험 공공·복지".split()
)


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def clean(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    t = " ".join(text.split())
    return mask_pii(t) or None


# 섹션 머리(본문 이모지). 납작해진 본문을 다시 목록으로 펼칠 때 쓴다.
_BODY_SECTION = re.compile(r"(?=📋|🏠|🎁|🚀|🛎️)")


def format_body(text: Optional[str], max_chars: int = BODY_MAX_CHARS) -> Optional[str]:
    """본문 줄바꿈을 유지한다. 이미 한 줄로 납작해진 텍스트는 섹션·불릿 앞에서 다시 나눈다.

    clean() 처럼 공백을 전부 붙이면 JSON/엑셀에서 한 줄이 되고, LLM 도 목록을 합쳐 버린다.
    가운뎃점(·)은 직군명(IT개발·데이터)에 쓰이므로 불릿으로 보지 않는다.
    """
    if not text:
        return None
    t = text.replace("\xa0", " ").replace("\r\n", "\n").replace("\r", "\n")
    t = "\n".join(" ".join(ln.split()) for ln in t.split("\n") if ln.strip())
    if t.count("\n") < 4:
        t = _BODY_SECTION.sub(lambda m: "\n" + m.group(0), t)
        t = re.sub(r"[ \t]*[•ㆍ][ \t]*", "\n• ", t)
        t = re.sub(r"[ \t]+\*[ \t]+", "\n• ", t)
        t = re.sub(r"\n{3,}", "\n\n", t).strip()
    t = mask_pii(t) or ""
    return t[:max_chars] or None


def strip_ui_noise(value: str) -> str:
    """dd 안에 섞인 UI 문구 제거: '지도보기', 'N건 … 상세보기 … 닫기 - … 상세'."""
    v = value.replace("지도보기", " ")
    v = re.sub(r"\d+건\s*", " ", v)
    v = re.sub(r"(근무형태|우대사항|자격요건)\s*상세보기.*?(?:상세 설명|상세)", " ", v)
    v = re.sub(r"(근무형태|우대사항|자격요건)\s*상세보기|\s닫기(?=\s|$)|닫기\s*-\s*\S+\s*상세", " ", v)
    return " ".join(v.split())


def norm_label(label: str) -> str:
    """'조직 문화', '대표자명*', '직급/직책' → 매칭용 키."""
    return re.sub(r"[*\s·ㆍ./]", "", (label or "").strip())


# ── 파싱 (순수 함수: 네트워크 없이 테스트 가능) ──────────────────────────────

def parse_list(html: str, limit: int) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    out: list[dict] = []
    seen: set[str] = set()
    for el in soup.select(".item_recruit[value]"):
        rec_id = (el.get("value") or "").strip()
        if not rec_id.isdigit() or rec_id in seen:
            continue
        seen.add(rec_id)
        a = el.select_one("h2.job_tit a")
        corp = el.select_one(".corp_name a, .corp_name")
        dl = el.select_one(".job_date .date")
        out.append(
            {
                "external_id": rec_id,
                "list_title": a.get("title") if a else None,
                "list_company": clean(corp.get_text(" ", strip=True)) if corp else None,
                "deadline_text": clean(dl.get_text(" ", strip=True)) if dl else None,
            }
        )
        if len(out) >= limit:
            break
    return out


def _dt_dd_pairs(root: Any) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for dl in root.select("dl"):
        dt, dd = dl.find("dt"), dl.find("dd")
        if not dt or not dd:
            continue
        k = dt.get_text(" ", strip=True)
        v = strip_ui_noise(clean(dd.get_text(" ", strip=True)) or "")
        if k and v:
            out.append((k, v))
    return out


def _apply_fact(res: dict[str, Any], label: str, value: str) -> None:
    """한글 라벨 하나를 영어 컬럼/Q&A/extra_facts 에 넣는다. 이미 있는 컬럼은 덮어쓰지 않는다."""
    raw = (value or "")[:FACT_TEXT_MAX]
    if not raw:
        return
    if re.match(r"^Q\d", label, re.I):
        qna = res.setdefault("work_style_qna", [])
        if isinstance(qna, list) and len(qna) < 20:
            q = re.sub(r"^Q\s*\d+\s*[.:)]?\s*", "", label).strip() or label
            q = q[:200]
            if any(x.get("question") == q for x in qna):
                return
            qna.append({"question": q, "answer": raw})
        return
    key = norm_label(label)
    if key in SKIP_FACT_LABELS:
        return
    col = FACT_MAP.get(key)
    if col and not res.get(col):
        res[col] = raw
        return
    extra = res.setdefault("extra_facts", {})
    if isinstance(extra, dict) and col is None and key and key not in extra and len(extra) < 30:
        extra[key] = raw  # 미등록 라벨. 키는 정규화 한글(새 라벨 발견용). 매칭에는 안 씀


def parse_detail(html: str, rec_id: str) -> dict:
    """상세 페이지 → 회사/제목 + 영어 키 팩트 + deadline_date.

    근무조건·복지·기업정보는 같은 페이지의 dt/dd 에 있다. 공고 섹션을 먼저 읽고,
    없는 키만 페이지 전체에서 보충한다(기업정보 박스가 섹션 밖에 있음).
    """
    soup = BeautifulSoup(html, "lxml")
    sec = soup.select_one(f"section.jview-0-{rec_id}") or soup.select_one("section.jview")
    res: dict[str, Any] = {"section_found": sec is not None, "work_style_qna": [], "extra_facts": {}}
    root = sec or soup
    comp = root.select_one("a.company")
    title = root.select_one("h1.tit_job")
    res["company"] = clean(comp.get("title") if comp else None)
    res["title"] = clean(title.get_text(" ", strip=True) if title else None)
    for k, v in _dt_dd_pairs(root):
        _apply_fact(res, k, v)
    if sec is not None:
        for k, v in _dt_dd_pairs(soup):
            _apply_fact(res, k, v)
    og = soup.select_one('meta[property="og:description"]')
    m = re.search(r"마감일:(\d{4}-\d{2}-\d{2})", og.get("content", "")) if og else None
    res["deadline_date"] = m.group(1) if m else None
    if not res["work_style_qna"]:
        res.pop("work_style_qna")
    if not res["extra_facts"]:
        res.pop("extra_facts")
    return res


_SECTION_HEAD = (
    (re.compile(r"주요\s*업무|담당\s*업무"), "key_duties"),
    (re.compile(r"자격\s*요건|지원\s*자격|필수\s*요건|필수\s*조건"), "must_have"),
    (re.compile(r"우대\s*사항|우대\s*조건"), "nice_to_have"),
    (re.compile(r"기술\s*스택|보유\s*기술"), "skills_block"),
    (re.compile(r"근무\s*조건"), "work_conditions"),
    (re.compile(r"복지"), "welfare"),
    (re.compile(r"채용\s*절차"), "process"),
    (re.compile(r"유의\s*사항"), "notes"),
)
_ITEM_LINE = re.compile(r"^(?:[•*ㆍ·\-–]\s*|\d+[.)]\s+)")
_PERSON_ITEM = re.compile(r"사람|분입니다|마음을 갖|자세로|의지가 있는")
_NOISE_LINE = re.compile(r"선택\s*:|기술스택\s*>|근무지 주소|^\s*업종\s|^\s*직종\s")
_DROP_SECTIONS = frozenset({"process", "notes", "welfare", "work_conditions", "skills_block"})


def _header_and_rest(line: str) -> tuple[Optional[str], str]:
    s = re.sub(r"^[📋🏠🎁🚀🛎️]\s*", "", line).strip()
    for pat, key in _SECTION_HEAD:
        m = pat.match(s)
        if m:
            return key, s[m.end():].strip(" \t:-")
    return None, line


def split_body_sections(body_text: str) -> dict[str, list[str]]:
    """본문 불릿을 코드가 섹션별로 쪼갠다. LLM 은 텍스트를 다시 쓰지 않는다.

    주요업무 아래 회사소개 문단·'~사람' 성격 항목은 unclassified 로 빼서 LLM 이 분류만 한다.
    """
    sections: dict[str, list[str]] = {k: [] for k in ("key_duties", "must_have", "nice_to_have")}
    unclassified: list[str] = []
    current: Optional[str] = None

    def add(bucket: Optional[str], text: str) -> None:
        t = " ".join(text.split())
        t = t.lstrip("•*ㆍ·-– ").strip()
        if not t or _NOISE_LINE.search(t):
            return
        if bucket in _DROP_SECTIONS:
            return
        if bucket in sections:
            if bucket == "key_duties" and _PERSON_ITEM.search(t):
                unclassified.append(t)
            elif len(sections[bucket]) < 50:
                sections[bucket].append(t[:200])
        elif bucket is None:
            unclassified.append(t[:200])

    for raw in (body_text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        head, rest = _header_and_rest(line)
        if head:
            current = head
            if rest:
                intro = current == "key_duties" and (len(rest) > 40 or rest.endswith(("다.", "다", "요.", "요")))
                if intro:
                    unclassified.append(rest[:200])
                else:
                    add(current, rest)
            continue
        item = _ITEM_LINE.sub("", line).strip() if _ITEM_LINE.match(line) else None
        dest = sections[current] if current in sections and sections[current] else unclassified if unclassified else None
        cut = dest is not None and len(dest[-1]) < 80 and not dest[-1].endswith(("다.", "요.", "다", "요", ".", "사람"))
        if item:
            add(current, item)
        elif dest is not None and cut and not (current in _DROP_SECTIONS or _NOISE_LINE.search(line)):
            dest[-1] = (dest[-1] + line)[:200]
            if dest is sections.get("key_duties") and _PERSON_ITEM.search(dest[-1]):
                unclassified.append(dest.pop())
        elif current in _DROP_SECTIONS or _NOISE_LINE.search(line):
            continue
        elif current == "key_duties" and (len(line) > 40 or line.endswith(("다.", "다", "요.", "요"))):
            unclassified.append(line[:200])
        elif current in sections:
            add(current, line)
        else:
            unclassified.append(line[:200])
    sections["unclassified"] = unclassified[:50]
    return sections


def facts_from_body(body_text: Optional[str]) -> dict[str, str]:
    """본문 '• 교육/생활 : …' 줄을 팩트로 읽는다. 상세 페이지 값이 없을 때만 쓴다."""
    out: dict[str, str] = {}
    if not body_text:
        return out
    for m in re.finditer(r"[•*]\s*([^:：\n]{2,20})\s*[:：]\s*(.+)", body_text):
        col = FACT_MAP.get(norm_label(m.group(1)))
        if col and col not in out:
            v = clean(m.group(2))
            if v:
                out[col] = v[:FACT_TEXT_MAX]
    return out


def attach_body_lists(rec: dict) -> None:
    chunks = split_body_sections(rec.get("body_text") or "")
    rec["key_duties"] = chunks["key_duties"]
    rec["must_have"] = chunks["must_have"]
    rec["nice_to_have"] = chunks["nice_to_have"]
    rec["unclassified_items"] = chunks["unclassified"]
    for k, v in facts_from_body(rec.get("body_text")).items():
        rec.setdefault(k, v)


def site_facts_view(rec: dict) -> dict[str, Any]:
    """사람이 보던 예전 summary 와 같은 내용. 키만 영어."""
    keys = (
        "career_text", "education_text", "employment_type_text", "salary_text", "location_text",
        "position_text", "work_hours_text", "workplace_address",
        "welfare_insurance_text", "pay_system_text", "gifts_text", "education_life_text",
        "work_environment_text", "org_culture_text", "refresh_text",
        "apply_start_text", "apply_method_text",
        "ceo_name", "company_type_text", "industry_text", "employee_count_text",
        "founded_on_text", "revenue_text", "homepage", "company_address",
    )
    out = {k: rec[k] for k in keys if rec.get(k)}
    if rec.get("work_style_qna"):
        out["work_style_qna"] = rec["work_style_qna"]
    return out


def parse_body(html: str) -> dict:
    """본문 iframe → 텍스트/태그/플래그. 이미지 URL 은 저장하지 않는다(개수만)."""
    soup = BeautifulSoup(html, "lxml")
    uc = soup.select_one(".user_content") or soup
    base = BODY_URL.format(id="0")
    image_count = len({urljoin(base, i["src"]) for i in uc.select("img[src]")})
    text = uc.get_text("\n", strip=True)
    skills = sorted(set(re.findall(r"기술스택\s*>\s*([^\n]+)", text)))
    top_names = {n.strip() for n in re.findall(r"선택\s*:\s*([^>\n]+?)\s*>", text)}
    addr = re.search(r"근무지 주소\s*\n?\s*([^\n]+)", text)
    return {
        "body_text": format_body(text),
        "body_image_count": image_count,
        # 이미지형 공고도 SEO 숨은 텍스트(업종/직종/주소)가 있어 글자 수로는 못 가린다 → 핵심 키워드 유무로 판정(휴리스틱)
        "body_text_missing": not CORE_BODY_KEYWORDS.search(text),
        "skills": [s.strip() for s in skills if s.strip()][:50],
        "category_names": sorted(n for n in top_names if n in TOP_CATEGORIES),
        "workplace_address": clean(addr.group(1)) if addr else None,
    }


# ── 빈 값 처리 ──────────────────────────────────────────────────────────────

_STOP = r"(?=\s[•·▶■※\-\*]\s|\s(?:급여|근무지|근무요일|근무일수|근무일시|고용형태|근무형태)\s*[:：]|\s[🎁🚀🛎🏠📋]|$)"
_BODY_FALLBACK = {
    "employment_type_text": re.compile(r"(?:고용형태|근무형태)\s*[:：]\s*(.+?)" + _STOP),
    "salary_text": re.compile(r"(?:급여|연봉)\s*[:：]\s*(.+?)" + _STOP),
    "location_text": re.compile(r"근무지(?:역)?\s*[:：]\s*(.+?)" + _STOP),
}


def body_regex_fallback(field: str, body_text: Optional[str]) -> Optional[str]:
    """본문 '• 급여 : …' 같은 근무조건 줄에서 값을 뽑는다. 못 찾으면 None. 값은 80자까지만."""
    pat = _BODY_FALLBACK.get(field)
    if not pat or not body_text:
        return None
    m = pat.search(body_text)
    if not m:
        return None
    v = " ".join(m.group(1).split())
    return v[:80] if v else None


def parse_deadline_text(text: Optional[str], today: Optional[date] = None) -> Optional[date]:
    """'~ 11/12(목)' → 날짜. 연도는 오늘 기준 가장 가까운 미래(지난 지 30일 넘으면 다음 해)."""
    if not text:
        return None
    m = re.search(r"(\d{1,2})/(\d{1,2})", text)
    if not m:
        return None
    today = today or datetime.now(timezone.utc).date()
    try:
        d = date(today.year, int(m.group(1)), int(m.group(2)))
    except ValueError:
        return None
    if d < today - timedelta(days=30):
        d = date(today.year + 1, d.month, d.day)
    return d


_RANK = {"ok": 0, "retry_later": 1, "needs_review": 2}


def evaluate_quality(rec: dict, *, detail_ok: bool, body_ok: bool) -> dict:
    """rec(키 = DB 컬럼명)를 제자리에서 보정하고 missing_fields / field_sources / review_status / review_note 를 채운다.

    원인에 따라 '보충 시도 여부'와 '최종 행선지'가 달라진다 (모듈 docstring 표 참고).
    반환: {"extract_failed_fields": [...]}  — 배치 경보 집계용.
    """
    missing: dict[str, str] = {}
    sources: dict[str, str] = dict(rec.get("field_sources") or {})
    notes: list[str] = []
    status = "ok"
    extract_failed: list[str] = []

    def bump(s: str) -> None:
        nonlocal status
        if _RANK[s] > _RANK[status]:
            status = s

    section_found = bool(rec.pop("_section_found", detail_ok))
    absent = [f for f in REQUIRED_DETAIL if not rec.get(f)]

    # 상세 필드: 원인 판정
    for f in absent:
        if not detail_ok:
            reason = "fetch_failed"
        elif not section_found or len(absent) >= 3:   # 구조를 못 읽었거나, 한꺼번에 여럿이 사라짐 → 구조 변경 의심
            reason = "extract_failed"
        else:
            reason = "not_in_source"

        if reason == "not_in_source":
            filled = body_regex_fallback(f, rec.get("body_text")) if body_ok else None
            if filled:
                rec[f] = filled
                sources[f] = "body_regex"
                continue
            missing[f] = reason
            if rec.get("body_text_missing"):
                bump("needs_review")          # 본문이 이미지형일 가능성 → 사람이 공고를 열어 확인
                notes.append(f"{f}: 이미지형 본문 의심, 직접 확인")
            # 본문이 텍스트인데도 없으면 원본에 정말 없는 것 → 종료(missing_fields 에 기록만)
        else:
            missing[f] = reason
            bump("retry_later")
            if reason == "extract_failed":
                extract_failed.append(f)

    # 제목·회사: 상세 실패 시 목록 값으로 이미 채워졌는지만 본다
    for f in ("company", "title"):
        if not rec.get(f):
            missing[f] = "fetch_failed" if not detail_ok else "extract_failed"
            bump("retry_later")
            if missing[f] == "extract_failed":
                extract_failed.append(f)

    # 마감일: 상시채용은 '없음이 정상'
    if not rec.get("deadline_date"):
        txt = rec.get("deadline_text")
        if txt and BY_DESIGN_DEADLINE.search(txt):
            missing["deadline_date"] = "by_design"
        elif parse_deadline_text(txt):
            rec["deadline_date"] = parse_deadline_text(txt).isoformat()
            sources["deadline_date"] = "list_text"
        elif detail_ok:
            missing["deadline_date"] = "not_in_source"

    # 본문
    if not body_ok:
        missing["body_text"] = "fetch_failed"
        bump("retry_later")
    elif rec.get("body_text_missing"):
        missing["body_text"] = "not_in_source"
        bump("needs_review")
        notes.append("본문 텍스트 없음(이미지형 의심): 공고 링크에서 직접 확인")

    rec["missing_fields"] = missing
    rec["field_sources"] = sources
    rec["review_status"] = status
    rec["review_note"] = ("; ".join(notes))[:500] if notes else None
    return {"extract_failed_fields": extract_failed}


def fill_rates(records: list[dict]) -> dict[str, float]:
    n = len(records) or 1
    return {f: round(sum(1 for r in records if r.get(f)) / n, 2) for f in REQUIRED_ALL}


# ── 수집 ────────────────────────────────────────────────────────────────────

class CrawlBlocked(RuntimeError):
    """사이트가 막은 것으로 보여 중단했다. 받은 건은 on_record 로 이미 저장됐다 → 나중에 --resume."""


def sort_newest_first(items: list[dict]) -> list[dict]:
    """목록(관련도순)을 최신순으로 다시 정렬. external_id 는 등록 순서로 커지는 번호라 등록일 대용으로 쓴다(추정)."""
    return sorted(items, key=lambda it: int(it["external_id"]), reverse=True)


def looks_blocked(html: Optional[str]) -> bool:
    return bool(html) and bool(BLOCK_MARKERS.search(html[:20000]))


async def fetch(
    max_items: int = 10,
    list_url: str = DEFAULT_LIST_URL,
    headless: bool = True,
    rec_ids: Optional[list[str]] = None,
    items: Optional[list[dict]] = None,
    on_list: Optional[Callable[[list[dict]], None]] = None,
    on_record: Optional[Callable[[dict], None]] = None,
) -> tuple[list[dict], dict]:
    """상위 max_items(≤HARD_CAP)건 수집 (관련도순 목록 → 최신순 정렬).

    rec_ids 가 있으면 목록 검색 없이 그 ID 만, items 가 있으면(이어하기) 그 목록 그대로 받는다.
    on_list 는 목록이 정해졌을 때 1회, on_record 는 공고 1건이 끝날 때마다 호출된다 (중간 저장용).
    브라우저가 죽으면 남은 공고부터 새 브라우저로 이어가고, 차단이 의심되면 CrawlBlocked 로 멈춘다.
    """
    import os

    from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig

    ua = build_user_agent(os.environ)
    max_items = max(1, min(int(max_items), HARD_CAP))
    made = 0

    async def pause() -> None:
        nonlocal made
        if made:
            await asyncio.sleep(random.uniform(*DELAY))
        made += 1

    # avoid_ads: 광고·트래커 요청 차단 (빨라지고 사이트 부하도 준다). text_mode 는 이미지 미수신.
    browser_cfg = BrowserConfig(
        headless=headless, user_agent=ua, ignore_https_errors=False, text_mode=True, avoid_ads=True
    )

    def run_cfg(wait_for: Optional[str] = None) -> Any:
        return CrawlerRunConfig(
            cache_mode=CacheMode.BYPASS,
            check_robots_txt=True,
            page_timeout=PAGE_TIMEOUT_MS,
            wait_until="domcontentloaded",
            wait_for=wait_for,
            wait_for_timeout=PAGE_TIMEOUT_MS if wait_for else None,
        )

    if items is not None:
        items = list(items)[:HARD_CAP]
        _log(f"[{PLATFORM}] 이어하기 {len(items)}건")
    elif rec_ids:
        items = [{"external_id": i, "list_title": None, "list_company": None, "deadline_text": None} for i in rec_ids[:HARD_CAP]]
        _log(f"[{PLATFORM}] rec_ids {len(items)}건")
    else:
        async with AsyncWebCrawler(config=browser_cfg) as crawler:
            await pause()
            res = await _arun_with_retry(crawler, list_url, run_cfg(), "list")
        if res is None:
            raise RuntimeError("list_failed: 목록 수집 실패(robots 차단 포함)")
        if looks_blocked(res.html):
            raise CrawlBlocked("blocked_list: 목록 페이지에 차단 문구")
        items = sort_newest_first(parse_list(res.html or "", max_items))
        if not items:
            raise RuntimeError("list_empty: 목록에서 공고를 못 찾음(셀렉터 불일치 의심)")
        _log(f"[{PLATFORM}] 목록에서 {len(items)}건 선택 (최신순 정렬)")
    if on_list:
        on_list(items)

    keyword_m = re.search(r"searchword=([^&]+)", list_url)
    records: list[dict] = []
    extract_failed_all: set[str] = set()
    pending = list(items)
    total = len(items)
    restarts = 0
    bad_streak = 0
    streak_restarted = False

    async def crawl_one(crawler: Any, it: dict) -> dict:
        nonlocal bad_streak, streak_restarted
        rid = it["external_id"]
        n = total - len(pending) + 1
        rec: dict[str, Any] = {
            "external_id": rid,
            "url": DETAIL_URL.format(id=rid),
            "company": it.get("list_company"),
            "title": it.get("list_title"),
            "deadline_text": it.get("deadline_text"),
            "search_keyword": keyword_m.group(1) if keyword_m else None,
            "category_names": [],
            "skills": [],
            "body_image_count": 0,
            "body_text_missing": False,
        }
        await pause()
        d = await _arun_with_retry(crawler, rec["url"], run_cfg(DETAIL_WAIT_FOR), f"detail {n}/{total}")
        if d is not None and looks_blocked(d.html):
            raise CrawlBlocked(f"blocked_detail: {rid} 상세 페이지에 차단 문구")
        detail_ok = d is not None
        if detail_ok:
            det = parse_detail(d.html or "", rid)
            rec["_section_found"] = det.pop("section_found", False)
            for k, v in det.items():
                if v:
                    rec[k] = v          # 상세 값이 목록 값보다 정확하므로 덮어쓴다
        if detail_ok and rec.get("_section_found"):
            bad_streak, streak_restarted = 0, False
        else:
            bad_streak += 1
        if bad_streak >= BLOCK_STREAK:
            # 이 건은 저장하지 않는다(pending 에 남음). 브라우저가 죽어도 같은 증상이라 한 번은 재기동해 본다.
            if not streak_restarted:
                streak_restarted, bad_streak = True, BLOCK_STREAK - 1
                raise RuntimeError("fail_streak: 브라우저 이상 의심 → 재기동")
            raise CrawlBlocked(f"blocked_suspected: 상세 {BLOCK_STREAK}건 연속 실패/구조 없음")
        await pause()
        b = await _arun_with_retry(crawler, BODY_URL.format(id=rid), run_cfg(BODY_WAIT_FOR), f"body {n}/{total}")
        if b is not None and looks_blocked(b.html):
            raise CrawlBlocked(f"blocked_body: {rid} 본문 페이지에 차단 문구")
        body_ok = b is not None
        if body_ok:
            body = parse_body(b.html or "")
            rec.update({k: v for k, v in body.items() if v is not None})
            rec["body_text_missing"] = body["body_text_missing"]
        attach_body_lists(rec)
        rec["site_facts"] = site_facts_view(rec)
        q = evaluate_quality(rec, detail_ok=detail_ok, body_ok=body_ok)
        extract_failed_all.update(q["extract_failed_fields"])
        _log(f"  [{n}/{total}] {rid} {rec.get('company')} / {rec.get('title')} → {rec['review_status']}")
        return rec

    while pending:
        try:
            async with AsyncWebCrawler(config=browser_cfg) as crawler:
                for _ in range(min(BROWSER_CHUNK, len(pending))):
                    rec = await crawl_one(crawler, pending[0])
                    pending.pop(0)
                    records.append(rec)
                    if on_record:
                        on_record(rec)
        except CrawlBlocked:
            raise
        except Exception as e:  # 브라우저 크래시 등: 남은 공고부터 새 브라우저로
            restarts += 1
            _log(f"[{PLATFORM}] 브라우저 오류 → 재기동 {restarts}/{MAX_BROWSER_RESTARTS} (남은 {len(pending)}건): {safe_error(e)}")
            if restarts > MAX_BROWSER_RESTARTS:
                raise RuntimeError(f"browser_crashed: 재기동 {MAX_BROWSER_RESTARTS}회 초과, 남은 {len(pending)}건") from e

    rates = fill_rates(records)
    alert = sorted(f for f, r in rates.items() if len(records) >= 5 and r < 0.7)
    summary = {
        "platform": PLATFORM,
        "fetched": len(records),
        "user_agent": ua,
        "images_downloaded": False,
        "browser_restarts": restarts,
        "review_counts": {s: sum(1 for r in records if r["review_status"] == s) for s in ("ok", "retry_later", "needs_review")},
        "fill_rates": rates,
        "selector_alert": alert,                       # 채움률 70% 미만 필드 = 셀렉터 깨짐 의심(건별 검토가 아니라 코드 점검)
        "extract_failed_fields": sorted(extract_failed_all),
    }
    return records, summary
