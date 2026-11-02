from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import psycopg

from .csv_writer import COLUMNS

CHUNK = 1 << 20  # 1MiB
CONNECT_TIMEOUT_SEC = 15  # 네트워크가 막혔을 때 무한 대기하지 않도록 (platforms/store.py 와 같은 값)


@dataclass
class MergeStats:
    inserted: int
    updated: int
    skipped: int


def _schema() -> str:
    schema = os.environ.get("FIT_DB_SCHEMA", "fit")
    if not schema.replace("_", "").isalnum():
        raise ValueError(f"FIT_DB_SCHEMA 값이 이상합니다: {schema!r}")
    return schema


def copy_csv_to_staging(csv_path: Path, dsn: str) -> int:
    """로컬 CSV → COPY FROM STDIN → fit.job_postings_staging. 반환: 적재 행 수.

    PostgREST 로는 COPY 가 불가능하므로 SUPABASE_DB_URL(직접 Postgres 접속)이 필요하다.
    """
    schema = _schema()
    cols = ", ".join(COLUMNS)
    sql = f"COPY {schema}.job_postings_staging ({cols}) FROM STDIN WITH (FORMAT csv, HEADER true, NULL '')"
    with psycopg.connect(dsn, autocommit=False, connect_timeout=CONNECT_TIMEOUT_SEC) as conn:
        with conn.cursor() as cur:
            with cur.copy(sql) as copy, csv_path.open("rb") as f:
                while chunk := f.read(CHUNK):
                    copy.write(chunk)
            rows = cur.rowcount
        conn.commit()
    return rows


def merge_batch(batch_id: str, dsn: str) -> MergeStats:
    """staging → production upsert (010 SQL 의 fit.merge_job_postings). staging 의 해당 batch 는 함수 안에서 삭제된다."""
    schema = _schema()
    with psycopg.connect(dsn, connect_timeout=CONNECT_TIMEOUT_SEC) as conn:
        with conn.cursor() as cur:
            cur.execute(f"select inserted, updated, skipped from {schema}.merge_job_postings(%s)", (batch_id,))
            row = cur.fetchone()
        conn.commit()
    if not row:
        return MergeStats(0, 0, 0)
    return MergeStats(int(row[0]), int(row[1]), int(row[2]))


def load_csv(csv_path: Path, batch_id: str, dsn: str) -> tuple[int, MergeStats]:
    copied = copy_csv_to_staging(csv_path, dsn)
    stats = merge_batch(batch_id, dsn)
    return copied, stats
