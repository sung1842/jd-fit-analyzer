"""적재 전 배치 sanity gate — 새벽 무인 실행에서 '조용한 실패'(셀렉터 붕괴인데 status=ok)를 막는다.

CSV(csv_writer.COLUMNS 헤더)를 검사해 ok/reason/warnings/stats 를 돌려준다. 표준 라이브러리만 사용.
- evaluate_csv: 읽기 전용(히스토리를 기록하지 않는다). 하드 실패는 ok=False, 소프트 신호(건수 급감)는 warnings.
- record_history: 적재가 끝난 뒤 호출해 이번 건수를 히스토리에 원자적으로 기록한다.

임계값은 사전 조사 기반 추정치이며 실데이터로 검증되지 않았다. 운영하며 조정할 것.
warnings/reason 에는 고정 코드 + 숫자만 담는다(행 내용·경로·비밀값 없음).
"""
from __future__ import annotations

import csv
import json
import os
import statistics
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .csv_writer import COLUMNS

# ---- 임계값 (조사 기반 추정치, 실데이터 미검증) ----
MIN_VALID_RATIO = 0.9  # valid/fetched 가 이 값 미만이면 실패
MAX_SHORT_DESC_RATIO = 0.4  # crawl4ai 소스: 짧은 description 비율이 이 값 초과면 실패
DESC_MIN_LEN = 50  # 이 길이 미만 description 은 '짧음'
DROP_WARN_RATIO = 0.3  # fetched 가 최근 중앙값의 이 비율 미만이면 경고

HISTORY_KEEP = 30  # 소스별 보관 개수
HISTORY_WINDOW = 7  # 중앙값 계산 윈도우(최근 N개)
HISTORY_MIN_ENTRIES = 3  # 중앙값을 쓰기 위한 최소 항목 수

_WARN_HISTORY_CORRUPT = "history 파일 손상, 무시"


# ---------- 내부 유틸 ----------

def _raise_field_size_limit() -> None:
    """raw 컬럼이 csv 기본 한도(131072자)를 넘어도 bad_csv 로 오판하지 않도록 한도를 올린다."""
    limit = sys.maxsize
    while True:
        try:
            csv.field_size_limit(limit)
            return
        except OverflowError:
            limit //= 2
            if limit < 131072:
                return


def _is_valid_url(url: str) -> bool:
    u = url.strip().lower()
    return u.startswith("http://") or u.startswith("https://")


def _fetched_of(entry: Any) -> int | None:
    """히스토리 항목에서 fetched(0 이상의 int)만 인정. 그 외는 None."""
    if not isinstance(entry, dict):
        return None
    v = entry.get("fetched")
    if isinstance(v, bool) or not isinstance(v, int) or v < 0:
        return None
    return v


def _load_history(history_path: Path) -> tuple[dict[str, list[Any]], bool]:
    """(히스토리, 손상 여부). 파일이 없으면 ({}, False), JSON 오류/형식 오류면 ({}, True)."""
    try:
        with history_path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}, False
    except (OSError, ValueError):  # JSONDecodeError/UnicodeDecodeError 는 ValueError 하위
        return {}, True
    if not isinstance(data, dict):
        return {}, True
    out: dict[str, list[Any]] = {}
    for src, entries in data.items():
        if isinstance(src, str) and isinstance(entries, list):
            out[src] = entries
    return out, False


def _bad(reason: str, stats: dict[str, Any] | None = None, warnings: list[str] | None = None) -> dict:
    return {
        "ok": False,
        "reason": reason,
        "reasons": [reason],  # 하위 호환(리스트 형태를 기대하는 호출자용)
        "warnings": list(warnings or []),
        "stats": stats if stats is not None else _stats(0, 0, None, None),
    }


def _stats(fetched: int, valid: int, desc_short_ratio: float | None, history_median: float | None) -> dict[str, Any]:
    return {
        "fetched": fetched,
        "valid": valid,
        "valid_ratio": round(valid / fetched, 3) if fetched else 0.0,
        "desc_short_ratio": None if desc_short_ratio is None else round(desc_short_ratio, 3),
        "history_median": history_median,
    }


def _read_rows(csv_path: Path) -> list[dict[str, str]] | None:
    """헤더가 COLUMNS 와 정확히 같을 때만 행 리스트, 파일 없음/읽기 실패/헤더 불일치면 None."""
    _raise_field_size_limit()
    try:
        with csv_path.open("r", newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            if reader.fieldnames is None or [h.strip() for h in reader.fieldnames] != COLUMNS:
                return None
            rows: list[dict[str, str]] = []
            for r in reader:
                rows.append({k: (v or "") for k, v in r.items() if isinstance(k, str)})
            return rows
    except (OSError, UnicodeDecodeError, csv.Error, ValueError):
        return None


# ---------- 공개 API ----------

def evaluate_csv(csv_path: Path, source: str, history_path: Path, record: bool = False) -> dict:
    """배치 CSV 를 검사한다. 기본은 읽기 전용(히스토리 미기록).

    반환: {"ok", "reason", "warnings", "stats"} (+ 하위 호환용 "reasons" 리스트).
    `record` 는 기존 호출자(`record=` 키워드) 호환용 선택 인자: True 이고 ok 일 때만 record_history 를 호출한다.
    """
    csv_path = Path(csv_path)
    history_path = Path(history_path)

    rows = _read_rows(csv_path)
    if rows is None:
        return _bad("bad_csv")

    fetched = len(rows)
    if fetched == 0:
        return _bad("empty", _stats(0, 0, None, None))

    valid = sum(1 for r in rows if r.get("title", "").strip() and _is_valid_url(r.get("url", "")))

    is_crawl4ai = source.startswith("crawl4ai")
    desc_short_ratio: float | None = None
    if is_crawl4ai:
        short = sum(1 for r in rows if len(r.get("description", "").strip()) < DESC_MIN_LEN)
        desc_short_ratio = short / fetched

    # 히스토리(읽기만): 최근 7개 중앙값, 항목 3개 이상일 때만
    warnings: list[str] = []
    history, corrupt = _load_history(history_path)
    if corrupt:
        warnings.append(_WARN_HISTORY_CORRUPT)
    recent = [_fetched_of(e) for e in history.get(source, [])[-HISTORY_WINDOW:]]
    recent_vals = [v for v in recent if v is not None]
    median: float | None = None
    if len(recent_vals) >= HISTORY_MIN_ENTRIES:
        median = float(statistics.median(recent_vals))

    stats = _stats(fetched, valid, desc_short_ratio, median)

    reason: str | None = None
    if valid / fetched < MIN_VALID_RATIO:
        reason = "low_valid_ratio"
    elif desc_short_ratio is not None and desc_short_ratio > MAX_SHORT_DESC_RATIO:
        reason = "low_desc_ratio"

    if reason is None and median is not None and fetched < DROP_WARN_RATIO * median:
        warnings.append(
            f"건수가 최근 중앙값의 {int(DROP_WARN_RATIO * 100)}% 미만 (fetched={fetched}, median={median:g})"
        )

    if reason is not None:
        return _bad(reason, stats, warnings)

    if record:
        try:
            record_history(source, fetched, history_path)
        except OSError:
            warnings.append("history 기록 실패")

    return {"ok": True, "reason": None, "reasons": [], "warnings": warnings, "stats": stats}


def record_history(source: str, fetched: int, history_path: Path) -> None:
    """이번 건수를 히스토리에 기록한다(소스별 최근 30개 유지). 임시 파일 → os.replace 로 원자적 교체.

    파일이 깨졌으면 빈 히스토리로 시작한다. 부모 디렉토리가 없으면 만든다.
    """
    history_path = Path(history_path)
    history_path.parent.mkdir(parents=True, exist_ok=True)

    history, _corrupt = _load_history(history_path)
    entries = history.get(source, [])
    entries.append({"ts": datetime.now(timezone.utc).isoformat(), "fetched": int(fetched)})
    history[source] = entries[-HISTORY_KEEP:]

    fd, tmp = tempfile.mkstemp(prefix=history_path.name + ".", suffix=".tmp", dir=str(history_path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(history, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, history_path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
