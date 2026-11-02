"""수집 레코드 → fit.crawled_postings (+ fit.crawled_posting_categories) upsert. 플랫폼 공통 (SQL 014).

SUPABASE_DB_URL(직접 Postgres 접속)이 필요하다. 수집 단계(platforms/<name>.py)는 이 모듈을 import 하지 않는다.
압축 결과(mcp-server/src/scripts/compress_jd_sample.ts 의 *_compressed.json)가 있으면 external_id 로 합쳐서 넣는다.
- 수집처 이름은 텍스트 값에 남기지 않는다: CRAWL_MASK_TERMS(쉼표 구분, crawler/.env)에 적힌 말을 "채용 사이트"로 바꾼다.

- 길이 제약은 DB CHECK 가 최종 방어선이다. 여기서도 같은 상한으로 한 번 더 걸러 CHECK 위반으로 배치가 통째로 실패하는 것을 막는다.
  (상한은 SQL 011 / mcp-server JD_LIMITS 와 같아야 한다.)
- 사람이 검토한 행(review_status 가 resolved/approved/rejected)은 재수집이 덮어쓰지 않는다 (SQL 013, /crawling 검수).
- load_batch_id: 검수 화면의 배치 단위(샘플 5%·배치 승인). 수집 JSON 파일 이름에서 정한다.
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import date
from typing import Any, Optional

import psycopg
from psycopg.types.json import Jsonb

ARRAY_MAX = 50
ITEM_MAX = 200
SKILL_MAX = 60
COMPRESSED_MAX = 350
ROLE_SUMMARY_MAX = 200
BODY_MAX = 20000

_FACT_SCALARS = (
    "welfare_insurance_text", "pay_system_text", "gifts_text", "education_life_text",
    "work_environment_text", "org_culture_text", "refresh_text",
    "apply_start_text", "apply_method_text",
    "ceo_name", "company_type_text", "industry_text", "employee_count_text",
    "founded_on_text", "revenue_text", "homepage", "company_address",
)
_SCALARS = (
    "url", "company", "title", "career_text", "education_text", "employment_type_text", "salary_text",
    "location_text", "position_text", "work_hours_text", "workplace_address", "deadline_text",
    "body_text", "body_image_count", "body_text_missing", "review_status", "review_note", "search_keyword",
) + _FACT_SCALARS
_COLUMNS = (
    ("platform", "external_id") + _SCALARS
    + ("deadline_date", "role_summary", "key_duties", "must_have", "nice_to_have", "skills",
       "compressed_text", "compress_status", "missing_fields", "field_sources",
       "work_style_qna", "extra_facts", "content_hash", "load_batch_id")
)
# 재수집이 건드리지 않는 검수 완료 상태
_REVIEWED = ("resolved", "approved", "rejected")
# 재수집된 미판정 행은 새 배치에서 처음부터 다시 검수한다: 샘플·규칙 사유 초기화.
# 사람이 고친 값(edits)은 내용이 그대로면 유지하고, 공고 내용이 바뀌었으면 옛 수정이 새 본문을 덮지 않게 비운다.
# (SET 절의 오른쪽 컬럼 참조는 갱신 전 값이다)
_REVIEW_RESET = (
    "is_sample = false, review_flags = '{}', "
    "edits = case when crawled_postings.content_hash is distinct from excluded.content_hash "
    "then '{}'::jsonb else crawled_postings.edits end"
)
FACT_TEXT_MAX = 500
# 내용 지문에 넣는 필드: 공고 내용이 바뀌었는지 판단하는 값만 (수집 시각·검토 상태 같은 메타는 제외)
HASH_FIELDS = (
    "company", "title", "career_text", "education_text", "employment_type_text", "salary_text", "location_text",
    "deadline_text", "body_text", "key_duties", "must_have", "nice_to_have", "skills",
)


def content_hash(row: dict) -> str:
    """같은 (platform, external_id) 를 다시 받았을 때 내용이 그대로인지(같은 지문) 바뀌었는지 판단용. models.JobPosting 과 같은 32자."""
    payload = json.dumps({k: row.get(k) for k in HASH_FIELDS}, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


def _schema() -> str:
    s = os.environ.get("FIT_DB_SCHEMA", "fit")
    if not s.replace("_", "").isalnum():
        raise ValueError(f"FIT_DB_SCHEMA 값이 이상합니다: {s!r}")
    return s


def _arr(values: Any, item_max: int, *, drop_long: bool) -> list[str]:
    """문자열 배열 정리: 공백 제거, 대소문자 무시 중복 제거, 항목 수 ≤ ARRAY_MAX, 항목 길이 ≤ item_max.
    drop_long=True(skills)면 긴 항목은 기술 이름이 아니라고 보고 버리고, False 면 잘라낸다."""
    out: list[str] = []
    seen: set[str] = set()
    for v in values or []:
        s = " ".join(str(v).split())
        if not s or s.lower() in seen:
            continue
        if len(s) > item_max:
            if drop_long:
                continue
            s = s[:item_max]
        seen.add(s.lower())
        out.append(s)
        if len(out) >= ARRAY_MAX:
            break
    return out


MASK_REPLACEMENT = "채용 사이트"


def _mask_terms() -> list[str]:
    return [t.strip() for t in (os.environ.get("CRAWL_MASK_TERMS") or "").split(",") if t.strip()]


def mask_source_names(value: Any, terms: list[str]) -> Any:
    """텍스트(또는 텍스트 배열) 안의 수집처 이름을 일반 표현으로 바꾼다."""
    if isinstance(value, str):
        for t in terms:
            value = value.replace(t, MASK_REPLACEMENT)
        return value
    if isinstance(value, list):
        return [mask_source_names(v, terms) for v in value]
    return value


def build_row(rec: dict, comp: Optional[dict], batch_id: Optional[str] = None, platform: str = "board_a") -> dict:
    terms = _mask_terms()
    rec = {k: mask_source_names(v, terms) for k, v in rec.items()}
    comp = {k: mask_source_names(v, terms) for k, v in comp.items()} if comp else comp
    row: dict[str, Any] = {c: rec.get(c) for c in _COLUMNS}
    row["platform"] = platform
    # 옛 수집 JSON(2026-10-27 이전)은 공고 ID 키가 rec_idx
    row["external_id"] = str(rec.get("external_id") or rec.get("rec_idx") or "") or None
    row["body_text"] = (row["body_text"] or None) and row["body_text"][:BODY_MAX]
    d = rec.get("deadline_date")
    row["deadline_date"] = date.fromisoformat(d) if isinstance(d, str) and d else None
    skills = list(rec.get("skills") or [])
    if comp and not comp.get("skipped") and not comp.get("error"):
        row["role_summary"] = (comp.get("role_summary") or "")[:ROLE_SUMMARY_MAX] or None
        row["key_duties"] = _arr(comp.get("key_duties"), ITEM_MAX, drop_long=False)
        row["must_have"] = _arr(comp.get("must_have"), ITEM_MAX, drop_long=False)
        row["nice_to_have"] = _arr(comp.get("nice_to_have"), ITEM_MAX, drop_long=False)
        skills += list(comp.get("skills") or [])
        ct = comp.get("compressed_text") or ""
        row["compressed_text"] = ct[:COMPRESSED_MAX] if ct else None
        row["compress_status"] = comp.get("compress_status") or "ok"
    else:
        for k in ("key_duties", "must_have", "nice_to_have"):
            row[k] = []
        row["role_summary"] = row["compressed_text"] = None
        row["compress_status"] = "skipped" if comp else None
    row["skills"] = _arr(skills, SKILL_MAX, drop_long=True)
    for k in _FACT_SCALARS:
        v = row.get(k)
        row[k] = (str(v)[:FACT_TEXT_MAX] if v else None)
    row["missing_fields"] = Jsonb(rec.get("missing_fields") or {})
    row["field_sources"] = Jsonb(rec.get("field_sources") or {})
    row["work_style_qna"] = Jsonb(rec.get("work_style_qna") or [])
    row["extra_facts"] = Jsonb(rec.get("extra_facts") or {})
    row["review_status"] = rec.get("review_status") or "ok"
    row["body_image_count"] = int(rec.get("body_image_count") or 0)
    row["body_text_missing"] = bool(rec.get("body_text_missing"))
    row["content_hash"] = content_hash(row)
    row["load_batch_id"] = batch_id
    return row


def load_records(
    dsn: str,
    records: list[dict],
    compressed: Optional[list[dict]] = None,
    batch_id: Optional[str] = None,
    platform: str = "board_a",
) -> dict:
    schema = _schema()
    by_id = {str(c.get("external_id") or c.get("rec_idx")): c for c in (compressed or [])}
    cols = ", ".join(_COLUMNS)
    ph = ", ".join(f"%({c})s" for c in _COLUMNS)
    updates = ", ".join(f"{c} = excluded.{c}" for c in _COLUMNS if c not in ("platform", "external_id"))
    upsert = (
        f"insert into {schema}.crawled_postings ({cols}) values ({ph}) "
        f"on conflict (platform, external_id) do update set {updates}, last_seen_at = now(), {_REVIEW_RESET} "
        f"where {schema}.crawled_postings.review_status not in ({', '.join(repr(v) for v in _REVIEWED)}) "
        f"returning id, (xmax = 0) as inserted"
    )
    cat_sql = (
        f"insert into {schema}.crawled_posting_categories (posting_id, platform, category_id, assigned_by) "
        f"select %s, %s, id, 'site_filter' from {schema}.job_categories "
        f"where platform = %s and parent_id is null and name = any(%s) "
        f"on conflict (posting_id, category_id) do nothing"
    )
    stats = {"inserted": 0, "updated": 0, "skipped_resolved": 0, "categories_linked": 0, "unknown_categories": [],
             "failed": []}
    known: Optional[set[str]] = None
    with psycopg.connect(dsn, connect_timeout=15) as conn:
        with conn.cursor() as cur:
            cur.execute(f"select name from {schema}.job_categories where platform = %s and parent_id is null", (platform,))
            known = {r[0] for r in cur.fetchall()}
            for rec in records:
                # 행마다 savepoint: 한 행이 CHECK 등에 걸려도 그 행만 되돌리고 나머지는 계속 넣는다.
                try:
                    with conn.transaction():
                        row = build_row(rec, by_id.get(str(rec.get("external_id") or rec.get("rec_idx"))), batch_id, platform)
                        cur.execute(upsert, row)
                        r = cur.fetchone()
                        if r is None:                      # 검수 완료 행: 갱신하지 않음
                            stats["skipped_resolved"] += 1
                            continue
                        names = [n for n in (rec.get("category_names") or []) if n in known]
                        if names:
                            cur.execute(cat_sql, (r[0], platform, platform, names))
                            linked = cur.rowcount
                        else:
                            linked = 0
                except (psycopg.Error, ValueError, TypeError) as e:
                    # 오류 원문에는 값이 섞일 수 있어 종류·제약 이름만 남긴다
                    diag = getattr(e, "diag", None)
                    stats["failed"].append({
                        "external_id": str(rec.get("external_id") or rec.get("rec_idx")),
                        "error": type(e).__name__,
                        "constraint": getattr(diag, "constraint_name", None),
                    })
                    continue
                stats["inserted" if r[1] else "updated"] += 1
                stats["categories_linked"] += linked
                stats["unknown_categories"] += [n for n in (rec.get("category_names") or []) if n not in known]
        conn.commit()
    stats["unknown_categories"] = sorted(set(stats["unknown_categories"]))
    return stats
