from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator

_WS = re.compile(r"[ \t\u00a0]+")
_NL = re.compile(r"\n{3,}")


def clean_text(value: Optional[str]) -> Optional[str]:
    """LLM 입력용 정제: 연속 공백/개행 축소, 양끝 공백 제거. HTML 은 호출부에서 이미 마크다운/텍스트로 변환돼 있어야 한다."""
    if value is None:
        return None
    text = _WS.sub(" ", value.replace("\r", ""))
    text = _NL.sub("\n\n", text)
    text = "\n".join(line.strip() for line in text.split("\n")).strip()
    return text or None


class JobPosting(BaseModel):
    """fit.job_postings_staging 한 행. 컬럼 순서는 csv_writer.COLUMNS 를 따른다."""

    source: str
    external_id: str
    url: Optional[str] = None
    company: Optional[str] = None
    title: str
    description: Optional[str] = None
    skills: list[str] = Field(default_factory=list)
    location: Optional[str] = None
    employment_type: Optional[str] = None
    experience_level: Optional[str] = None
    salary: Optional[str] = None
    posted_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    raw: Optional[dict[str, Any]] = None

    @field_validator("title", mode="before")
    @classmethod
    def _title(cls, v: Any) -> str:
        t = clean_text(str(v) if v is not None else "")
        if not t:
            raise ValueError("title 이 비어 있습니다")
        return t

    @field_validator("company", "description", "location", "employment_type", "experience_level", "salary", mode="before")
    @classmethod
    def _opt_text(cls, v: Any) -> Optional[str]:
        return clean_text(str(v)) if v is not None else None

    @field_validator("skills", mode="before")
    @classmethod
    def _skills(cls, v: Any) -> list[str]:
        if v is None:
            return []
        if isinstance(v, str):
            v = re.split(r"[,/|;\n]", v)
        # 대소문자 무시 중복 제거, 원 표기는 첫 등장 기준 유지
        out: list[str] = []
        lower_seen: set[str] = set()
        for item in v:
            s = clean_text(str(item))
            if s and s.lower() not in lower_seen:
                lower_seen.add(s.lower())
                out.append(s)
        return out[:50]

    @property
    def content_hash(self) -> str:
        """변경 감지용. 제목+회사+본문+스킬만 본다 (last_seen 등 메타는 제외)."""
        payload = json.dumps(
            {"t": self.title, "c": self.company, "d": self.description, "s": sorted(s.lower() for s in self.skills)},
            ensure_ascii=False,
            sort_keys=True,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


def ts_from_epoch(value: Any) -> Optional[datetime]:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None
    return datetime.fromtimestamp(n, tz=timezone.utc)
