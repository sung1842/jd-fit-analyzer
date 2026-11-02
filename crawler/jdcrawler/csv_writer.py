from __future__ import annotations

import csv
import json
from datetime import datetime
from pathlib import Path
from typing import Iterable, Optional

from .models import JobPosting

# fit.job_postings_staging 컬럼 순서 — COPY 문의 컬럼 목록과 1:1
COLUMNS = [
    "load_batch_id",
    "source",
    "external_id",
    "url",
    "company",
    "title",
    "description",
    "skills",
    "location",
    "employment_type",
    "experience_level",
    "salary",
    "posted_at",
    "expires_at",
    "raw",
    "content_hash",
]


def pg_text_array(items: list[str]) -> str:
    """Postgres text[] 리터럴. 각 원소를 큰따옴표로 감싸고 \\ 와 " 를 이스케이프한다."""
    if not items:
        return "{}"
    escaped = []
    for s in items:
        s = s.replace("\\", "\\\\").replace('"', '\\"')
        escaped.append(f'"{s}"')
    return "{" + ",".join(escaped) + "}"


def _ts(value: Optional[datetime]) -> str:
    return value.isoformat() if value else ""


def write_csv(postings: Iterable[JobPosting], path: Path, batch_id: str) -> int:
    """COPY ... WITH (FORMAT csv, HEADER true) 가 그대로 읽을 수 있는 CSV. 빈 문자열은 NULL 로 적재되도록 COPY 에서 NULL '' 지정."""
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
        w.writerow(COLUMNS)
        for p in postings:
            w.writerow(
                [
                    batch_id,
                    p.source,
                    p.external_id,
                    p.url or "",
                    p.company or "",
                    p.title,
                    p.description or "",
                    pg_text_array(p.skills),
                    p.location or "",
                    p.employment_type or "",
                    p.experience_level or "",
                    p.salary or "",
                    _ts(p.posted_at),
                    _ts(p.expires_at),
                    json.dumps(p.raw, ensure_ascii=False) if p.raw is not None else "",
                    p.content_hash,
                ]
            )
            n += 1
    return n
