"""CLI.

  python -m jdcrawler site schemas/example_board.json --load
  python -m jdcrawler load out/<batch>.csv --batch <batch_id>      # 이미 만든 CSV 만 적재
  python -m jdcrawler platform board_a --max 10                    # 플랫폼 전용 수집 → out/board_a_postings_*.json (DB 없음)
  python -m jdcrawler platform-load board_a out/board_a_postings_X.json --compressed out/..._compressed.json

공통: 결과 CSV 는 crawler/out/<batch_id>.csv. --load 가 있으면 품질 게이트 → COPY → merge 까지 수행한다.
--load 없이 실행하면 DB 에 접근하지 않고(SUPABASE_DB_URL 불필요) stdout 에 요약 JSON 한 개만 출력한다.
  (HTTP 트리거가 자식 프로세스의 stdout 마지막 JSON 객체를 파싱한다. 다른 출력은 stderr 로만 보낸다.)
JDCRAWLER_SKIP_DOTENV=1 이면 .env 를 읽지 않는다 (자식이 DB 자격증명을 다시 읽는 것을 차단).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

from .csv_writer import write_csv
from .loader import load_csv
from .models import JobPosting
from .redact import redact
from .runner import csv_source, gate_evaluate, gate_record

ROOT = Path(__file__).resolve().parent.parent
if os.environ.get("JDCRAWLER_SKIP_DOTENV") != "1":
    load_dotenv(ROOT / ".env")
OUT_DIR = ROOT / "out"
HISTORY_PATH = OUT_DIR / "_history.json"

_BATCH_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")


def _batch_id(prefix: str) -> str:
    return f"{prefix}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"


def _fail(summary: dict, reason: str, message: str, started: float) -> dict:
    summary["reason"] = reason
    summary["error"] = message  # 고정 문자열만 (예외 원문 금지)
    summary["elapsed_sec"] = round(time.time() - started, 1)
    return summary


def _load_gated(csv_path: Path, batch_id: str, source: str, summary: dict, started: float) -> dict | None:
    """gate → COPY+merge → history. 실패하면 summary 를 반환, 성공하면 None (summary 에 통계 반영)."""
    gate = gate_evaluate(csv_path, source, HISTORY_PATH)
    summary["gate"] = gate
    summary["warnings"] = list(gate["warnings"])
    if not gate["ok"]:
        return _fail(summary, gate["reason"] or "gate_failed", "quality gate failed. CSV 는 보존됨", started)

    dsn = os.environ.get("SUPABASE_DB_URL")
    if not dsn or not dsn.startswith("postgres"):
        return _fail(summary, "no_db_url", "적재 설정 없음. CSV 는 보존됨", started)
    try:
        copied, stats = load_csv(csv_path, batch_id, dsn)
    except Exception as exc:
        print(f"[load] {type(exc).__name__}: {redact(exc)}", file=sys.stderr)
        return _fail(summary, "load_failed", "load failed", started)
    summary.update({"copied": copied, "inserted": stats.inserted, "updated": stats.updated, "skipped": stats.skipped})
    gate_record(source, int(summary.get("fetched") or copied or 0), HISTORY_PATH, csv_path)
    return None


def _finish(batch_id: str, source: str, postings: list[JobPosting], do_load: bool, started: float) -> dict:
    csv_path = OUT_DIR / f"{batch_id}.csv"
    written = write_csv(postings, csv_path, batch_id)
    summary: dict = {
        "batch_id": batch_id, "source": source, "fetched": len(postings),
        "csv": str(csv_path), "csv_rows": written, "warnings": [],
    }

    if do_load:
        failed = _load_gated(csv_path, batch_id, source, summary, started)
        if failed is not None:
            return failed

    summary["elapsed_sec"] = round(time.time() - started, 1)
    return summary


def _emit(summary: dict) -> int:
    """stdout 에는 요약 JSON 한 개만."""
    print(json.dumps(summary, ensure_ascii=False))
    return 2 if summary.get("error") else 0


def _resolve_batch_id(args: argparse.Namespace, prefix: str) -> str:
    given = getattr(args, "batch_id", None)
    if given:
        if not _BATCH_ID_RE.match(given):
            raise ValueError("batch-id 형식 오류")
        return given
    return _batch_id(prefix)


def cmd_site(args: argparse.Namespace) -> int:
    from .sources import crawl4ai_site

    started = time.time()
    schema_path = Path(args.schema)
    source = json.loads(schema_path.read_text(encoding="utf-8"))["source"]
    # delay_sec 는 넘기지 않는다: None 이면 crawl4ai_site 가 3~7초 랜덤 지연을 스스로 적용
    postings = asyncio.run(
        crawl4ai_site.fetch(
            schema_path,
            max_items=args.max,
            headless=not args.headful,
        )
    )
    prefix = source.replace(":", "-").replace("/", "-")
    batch_id = _resolve_batch_id(args, prefix)
    return _emit(_finish(batch_id, source, postings, args.load, started))


def _platform_modules(name: str):
    import importlib

    from .platforms import PLATFORMS

    crawl_mod, store_mod = PLATFORMS[name]
    return importlib.import_module(crawl_mod), store_mod


def cmd_platform(args: argparse.Namespace) -> int:
    """플랫폼 전용 수집 → out/<platform>_postings_<ts>.json (키 = fit.crawled_postings 컬럼). DB 접근 없음.

    도중에 멈추면(차단 의심·브라우저 반복 크래시·Ctrl+C) plan/partial 파일이 남는다 → --resume 으로 이어서 받는다.
    """
    from . import checkpoint as cp

    crawl, _ = _platform_modules(args.name)
    started = time.time()
    OUT_DIR.mkdir(exist_ok=True)
    kwargs: dict = {"max_items": args.max, "headless": not args.headful}
    if args.resume:
        paths = cp.CheckpointPaths.from_any(args.resume)
        if not paths.plan.exists():
            print(f"이어할 plan 파일이 없습니다: {paths.plan}", file=sys.stderr)
            return 2
        plan_items, plan_meta = cp.read_plan(paths)
        done = cp.read_partial(paths)
        todo = cp.remaining_items(plan_items, done)
        kwargs["items"] = todo
        if plan_meta.get("list_url"):
            kwargs["list_url"] = plan_meta["list_url"]
        print(f"[resume] 전체 {len(plan_items)} · 완료 {len(plan_items) - len(todo)} · 남음 {len(todo)}", file=sys.stderr)
    else:
        paths = cp.CheckpointPaths(OUT_DIR / f"{args.name}_postings_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}")
        plan_items, plan_meta = [], {"platform": args.name, "list_url": args.list_url, "max": args.max}
        if args.list_url:
            kwargs["list_url"] = args.list_url
        if args.ids:
            kwargs["rec_ids"] = [x.strip() for x in args.ids.split(",") if x.strip()]

    def on_list(items: list[dict]) -> None:
        if not args.resume:                 # 이어하기는 기존 plan 을 그대로 둔다
            plan_items.extend(items)
            cp.write_plan(paths, items, plan_meta)

    kwargs["on_list"] = on_list
    kwargs["on_record"] = lambda rec: cp.append_record(paths, rec)
    blocked = getattr(crawl, "CrawlBlocked", ())
    try:
        if kwargs.get("items") == []:
            summary = {"platform": args.name, "fetched": 0}
        else:
            _, summary = asyncio.run(crawl.fetch(**kwargs))
    except (KeyboardInterrupt, Exception) as e:
        # 차단 의심(CrawlBlocked)·브라우저 반복 크래시·수동 중단: 받은 건 partial 에 있다. 우회하지 않고 멈춘다.
        done = cp.read_partial(paths)
        left = len(cp.remaining_items(plan_items, done)) if plan_items else None
        return _emit({
            "platform": args.name,
            "status": "stopped",
            "reason": "blocked" if blocked and isinstance(e, blocked) else type(e).__name__,
            "detail": redact(str(e), 300),
            "saved": len(done),
            "remaining": left,
            "resume": f"python -m jdcrawler platform {args.name} --resume {paths.stem}" if paths.plan.exists() else None,
            "elapsed_sec": round(time.time() - started, 1),
        }) or 3
    done = cp.read_partial(paths)
    records = cp.ordered_records(plan_items, done) if plan_items else list(done.values())
    summary.update({"fetched_total": len(records), "review_counts_total": {
        s: sum(1 for r in records if r.get("review_status") == s) for s in ("ok", "retry_later", "needs_review")}})
    cp.finish(paths, records, summary)
    summary.update({"status": "ok", "json": str(paths.final), "elapsed_sec": round(time.time() - started, 1)})
    return _emit(summary)


def cmd_platform_load(args: argparse.Namespace) -> int:
    """platform 수집 JSON(+압축 JSON) → fit.<platform>_postings upsert. SUPABASE_DB_URL 필요."""
    import importlib

    _, store_mod = _platform_modules(args.name)
    dsn = os.environ.get("SUPABASE_DB_URL")
    if not dsn or not dsn.startswith("postgres"):
        print("SUPABASE_DB_URL 이 없습니다.", file=sys.stderr)
        return 2
    records = json.loads(Path(args.json).read_text(encoding="utf-8"))["records"]
    compressed = None
    if args.compressed:
        compressed = json.loads(Path(args.compressed).read_text(encoding="utf-8")).get("results")
    # 검수 배치 = 수집 JSON 파일 이름 (예: board_a_postings_20261025T1200)
    batch_id = args.batch_id or Path(args.json).stem
    stats = importlib.import_module(store_mod).load_records(dsn, records, compressed, batch_id, args.name)
    return _emit({"platform": args.name, "records": len(records), "batch_id": batch_id, **stats})


def cmd_load(args: argparse.Namespace) -> int:
    if not os.environ.get("SUPABASE_DB_URL"):
        print("SUPABASE_DB_URL 이 없습니다.", file=sys.stderr)
        return 2
    started = time.time()
    csv_path = Path(args.csv)
    source = csv_source(csv_path) or "unknown"
    summary: dict = {"batch_id": args.batch, "source": source, "warnings": []}
    failed = _load_gated(csv_path, args.batch, source, summary, started)
    if failed is None:
        summary["elapsed_sec"] = round(time.time() - started, 1)
    return _emit(summary)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="jdcrawler", description="채용공고 수집 → CSV → COPY staging → upsert")
    common = argparse.ArgumentParser(add_help=False)
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("site", parents=[common], help="Crawl4AI + CSS 스키마로 임의 보드 수집")
    c.add_argument("schema", help="crawler/schemas/*.json")
    c.add_argument("--max", type=int, default=300)
    c.add_argument("--headful", action="store_true", help="브라우저 창 표시 (셀렉터 디버깅용)")
    c.add_argument("--batch-id", dest="batch_id", default=None, help="CSV/배치 ID 고정 (부모 프로세스가 지정)")
    c.add_argument("--load", action="store_true")
    c.set_defaults(fn=cmd_site)

    from .platforms import PLATFORMS

    pf = sub.add_parser("platform", parents=[common], help="플랫폼 전용 수집기 (플랫폼별 코드·테이블). DB 접근 없음")
    pf.add_argument("name", choices=sorted(PLATFORMS))
    pf.add_argument("--max", type=int, default=10, help="수집 건수 (상한 100)")
    pf.add_argument("--list-url", dest="list_url", default=None, help="검색 결과 URL (기본: 플랫폼 모듈의 기본 URL)")
    pf.add_argument("--headful", action="store_true")
    pf.add_argument("--ids", dest="ids", default=None, help="쉼표로 구분한 공고 ID. 목록 대신 이 ID 만 수집")
    pf.add_argument("--resume", dest="resume", default=None,
                    help="멈춘 수집 이어하기: out/<name>_postings_<ts> (.plan.json/.partial.jsonl 중 아무거나)")
    pf.set_defaults(fn=cmd_platform)

    pl = sub.add_parser("platform-load", parents=[common], help="플랫폼 수집 JSON → fit.<platform>_postings upsert")
    pl.add_argument("name", choices=sorted(PLATFORMS))
    pl.add_argument("json", help="out/<platform>_postings_*.json")
    pl.add_argument("--compressed", default=None, help="압축 결과 JSON (compress_jd_sample.ts 출력)")
    pl.add_argument("--batch-id", default=None, help="검수 배치 이름 (기본: JSON 파일 이름)")
    pl.set_defaults(fn=cmd_platform_load)

    l = sub.add_parser("load", parents=[common], help="기존 CSV 적재만")
    l.add_argument("csv")
    l.add_argument("--batch", required=True, help="CSV 의 load_batch_id 와 동일해야 merge 됨")
    l.set_defaults(fn=cmd_load)

    args = p.parse_args(argv)
    try:
        return args.fn(args)
    except Exception as exc:  # RuntimeError(설정 누락·API 오류) 포함. 원문은 redact 해서 stderr 에만
        detail = redact(exc)
        print(f"오류: {type(exc).__name__}: {detail}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
