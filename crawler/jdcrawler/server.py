"""크롤러 HTTP 트리거.

CLI(`python -m jdcrawler`)와 같은 적재 함수를 호출한다. BullMQ 오케스트레이터와
talentfolio(Next.js) 프로세스는 바꾸지 않는다. 기본 바인드는 127.0.0.1:8010.

  crawler\\.venv\\Scripts\\python -m jdcrawler.server

인증: CRAWLER_API_KEY 필수 (fail-closed). /health 만 인증 없음.
POST /v1/trigger: 크롤은 자식 프로세스(env 허용목록·타임아웃 트리 kill) → 게이트 → 부모가 적재. 결과는 GET /v1/jobs/{job_id}.
"""
from __future__ import annotations

import hmac
import os
import sys
import threading
import uuid
from pathlib import Path
from queue import Queue
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .__main__ import HISTORY_PATH, OUT_DIR, ROOT, _batch_id, _finish
from .redact import redact
from .runner import (
    build_child_env,
    gate_evaluate,
    gate_record,
    is_timeout,
    last_json_object,
    run_child,
)

app = FastAPI(title="jd-fit crawler", version="0.2.0")

_jobs: dict[str, dict] = {}
_job_keys: dict[str, tuple[str, str]] = {}  # job_id → (source, schema_name) 중복 실행 방지용
_jobs_lock = threading.Lock()
_queue: Queue[tuple[str, object]] = Queue(maxsize=2)
_worker_started = False
_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _worker() -> None:
    while True:
        job_id, fn = _queue.get()
        with _jobs_lock:
            _jobs[job_id]["status"] = "running"
        try:
            result = fn()  # type: ignore[operator]
            status = "failed" if isinstance(result, dict) and result.get("error") else "done"
        except Exception as exc:  # 작업 실패를 HTTP 연결이 끊긴 뒤에 조회할 수 있게 저장 (원문 노출 금지)
            result = {"error": "job failed", "error_type": type(exc).__name__, "detail": redact(exc)}
            status = "failed"
        with _jobs_lock:
            _jobs[job_id]["status"] = status
            _jobs[job_id]["result"] = result
            _job_keys.pop(job_id, None)  # 끝난 작업은 중복 검사에서 제외
        _queue.task_done()


def _ensure_worker() -> None:
    global _worker_started
    if _worker_started:
        return
    threading.Thread(target=_worker, name="crawler-job", daemon=True).start()
    _worker_started = True


def require_key(x_internal_key: str | None = Header(default=None)) -> None:
    """fail-closed: 서버 키가 없으면 503, 틀리면 401. MCP_INTERNAL_KEY 폴백 없음."""
    expected = (os.environ.get("CRAWLER_API_KEY") or "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="crawler key not configured")
    try:
        ok = bool(x_internal_key) and hmac.compare_digest(x_internal_key.encode("utf-8"), expected.encode("utf-8"))
    except Exception:
        ok = False
    if not ok:
        raise HTTPException(status_code=401, detail="invalid internal key")


def _enqueue(fn: object, dedupe_key: tuple[str, str] | None = None, job_id: str | None = None) -> dict:
    _ensure_worker()
    job_id = job_id or str(uuid.uuid4())
    with _jobs_lock:
        if dedupe_key is not None:
            for jid, key in _job_keys.items():
                if key == dedupe_key and _jobs.get(jid, {}).get("status") in ("queued", "running"):
                    raise HTTPException(status_code=409, detail="same source is already queued or running")
        _jobs[job_id] = {"status": "queued", "result": None}
        if dedupe_key is not None:
            _job_keys[job_id] = dedupe_key
    try:
        _queue.put_nowait((job_id, fn))
    except Exception:
        with _jobs_lock:
            _jobs.pop(job_id, None)
            _job_keys.pop(job_id, None)
        raise HTTPException(status_code=429, detail="crawler queue is full")
    return {"job_id": job_id, "status": "queued"}


class SiteRequest(BaseModel):
    schema_name: str = Field(description="crawler/schemas 안의 파일명")
    max: int = Field(default=50, ge=1, le=300)
    headful: bool = False
    load: bool = False


class LoadRequest(BaseModel):
    csv_name: str
    batch_id: str


class TriggerRequest(BaseModel):
    source: Literal["site"]
    max: int = Field(default=200, ge=1, le=500)
    schema_name: str | None = Field(default=None, description="site 일 때 필수. crawler/schemas 안의 파일명")
    load: bool = True
    timeout_sec: int | None = Field(default=None, ge=60, le=7200, description="기본 3600")


def _schema_path(name: str) -> Path:
    root = (ROOT / "schemas").resolve()
    path = (root / name).resolve()
    if not path.is_relative_to(root) or path.suffix.lower() != ".json" or not path.is_file():
        raise HTTPException(status_code=400, detail="schema must be an existing json file under crawler/schemas")
    return path


def _csv_path(name: str) -> Path:
    root = OUT_DIR.resolve()
    path = (root / name).resolve()
    if not path.is_relative_to(root) or path.suffix.lower() != ".csv" or not path.is_file():
        raise HTTPException(status_code=400, detail="csv must be an existing file under crawler/out")
    return path


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "crawler"}


@app.post("/v1/site", status_code=202, dependencies=[Depends(require_key)])
def site(body: SiteRequest) -> dict:
    schema_path = _schema_path(body.schema_name)

    def run() -> dict:
        import asyncio
        import json
        import time

        from .sources import crawl4ai_site

        started = time.time()
        source = json.loads(schema_path.read_text(encoding="utf-8"))["source"]
        # delay_sec 미지정: crawl4ai_site 가 3~7초 랜덤 지연을 스스로 적용
        postings = asyncio.run(
            crawl4ai_site.fetch(
                schema_path,
                max_items=body.max,
                headless=not body.headful,
            )
        )
        prefix = source.replace(":", "-").replace("/", "-")
        return _finish(_batch_id(prefix), source, postings, body.load, started)

    return _enqueue(run)


@app.post("/v1/load", status_code=202, dependencies=[Depends(require_key)])
def load_existing(body: LoadRequest) -> dict:
    csv_path = _csv_path(body.csv_name)

    def run() -> dict:
        import time

        from .loader import load_csv

        dsn = os.environ.get("SUPABASE_DB_URL") or ""
        if not dsn.startswith("postgres"):
            return {"error": "SUPABASE_DB_URL 이 postgres:// 접속 문자열이 아닙니다", "batch_id": body.batch_id}
        started = time.time()
        copied, stats = load_csv(csv_path, body.batch_id, dsn)
        return {
            "batch_id": body.batch_id,
            "copied": copied,
            "inserted": stats.inserted,
            "updated": stats.updated,
            "skipped": stats.skipped,
            "elapsed_sec": round(time.time() - started, 1),
        }

    return _enqueue(run)


def _trigger_job(job_id: str, body: TriggerRequest, schema_path: Path | None, schema_source: str | None):
    """워커 스레드에서 실행될 작업 함수를 만든다. 어떤 경로든 finally 에서 웹훅 정확히 1회."""

    def run() -> dict:
        import json
        import time

        started = time.time()
        source = schema_source or "site"
        prefix = source.replace(":", "-").replace("/", "-")
        batch_id = _batch_id(prefix)
        csv_path = OUT_DIR / f"{batch_id}.csv"
        timeout_sec = body.timeout_sec or 3600

        status = "failed"
        reason: str | None = "exception"
        detail: str | None = None
        error_type: str | None = None
        warnings: list[str] = []
        fetched: int | None = None
        inserted = updated = skipped = None
        gate_stats: dict = {}
        try:
            # (1) 자식 프로세스 크롤 (--load 없음, 웹훅 없음, env 허용목록)
            args = [sys.executable, "-m", "jdcrawler"]
            extra: dict[str, str] = {}
            args += ["site", str(schema_path)]
            for name in ("CRAWLER_USER_AGENT", "CRAWLER_CONTACT", "CRAWL_DELAY_MIN", "CRAWL_DELAY_MAX"):
                if os.environ.get(name):
                    extra[name] = os.environ[name]
            args += [f"--max={body.max}", f"--batch-id={batch_id}"]
            env = build_child_env(extra)

            rc, out, err = run_child(args, env, timeout_sec, ROOT)
            summary = last_json_object(out)
            if is_timeout(rc, err):
                reason, detail = "timeout", redact(err[-300:])
            elif rc != 0 or summary is None or summary.get("error"):
                reason, detail = "crawl_failed", redact(err[-300:])
            else:
                fetched = summary.get("fetched") if isinstance(summary.get("fetched"), int) else None
                # (3) 품질 게이트: 실패하면 적재하지 않고 CSV 보존
                gate = gate_evaluate(csv_path, source, HISTORY_PATH)
                warnings = list(gate.get("warnings") or [])
                gate_stats = gate.get("stats") or {}
                if not gate["ok"]:
                    reason = gate.get("reason") or "gate_failed"
                else:
                    ok_flow = True
                    # (4) 부모 프로세스에서만 DB 적재
                    if body.load:
                        dsn = os.environ.get("SUPABASE_DB_URL") or ""
                        if not dsn.startswith("postgres"):
                            reason, ok_flow = "no_db_url", False
                        else:
                            from .loader import load_csv

                            _, stats = load_csv(csv_path, batch_id, dsn)
                            inserted, updated, skipped = stats.inserted, stats.updated, stats.skipped
                    if ok_flow:
                        # (5) 성공 시에만 history 기록
                        gate_record(source, fetched if fetched is not None else 0, HISTORY_PATH, csv_path)
                        status, reason = "ok", None
        except Exception as exc:
            status, reason = "failed", "exception"
            error_type, detail = type(exc).__name__, redact(exc)

        result: dict = {
            "batch_id": batch_id, "source": source, "fetched": fetched,
            "inserted": inserted, "updated": updated, "skipped": skipped,
            "elapsed_sec": round(time.time() - started, 1), "warnings": warnings, "gate": gate_stats,
        }
        if status != "ok":
            result["error"] = reason or "failed"
            result["reason"] = reason
            if detail:
                result["detail"] = detail
            if error_type:
                result["error_type"] = error_type
        return result

    return run


@app.post("/v1/trigger", status_code=202, dependencies=[Depends(require_key)])
def trigger(body: TriggerRequest) -> dict:
    schema_path: Path | None = None
    schema_source: str | None = None
    if body.source == "site":
        if not body.schema_name:
            raise HTTPException(status_code=400, detail="schema_name required for site")
        schema_path = _schema_path(body.schema_name)
        try:
            import json

            schema_source = str(json.loads(schema_path.read_text(encoding="utf-8"))["source"])
        except Exception:
            raise HTTPException(status_code=400, detail="schema file is invalid (source missing)")
    job_id = str(uuid.uuid4())  # 워커 시작 전에 확정 (웹훅 payload 에 포함)
    run = _trigger_job(job_id, body, schema_path, schema_source)
    return _enqueue(run, dedupe_key=(body.source, body.schema_name or ""), job_id=job_id)


class PlatformRequest(BaseModel):
    platform: Literal["board_a"] = "board_a"
    max: int = Field(default=20, ge=1, le=100, description="한 번에 최대 100")
    list_url: str | None = Field(default=None, max_length=2000, description="수집처 검색 결과 URL (BOARD_A_BASE_URL 호스트만)")
    keyword: str | None = Field(default=None, max_length=50, description="list_url 이 없을 때 검색어로 목록 URL 생성")
    ids: list[str] | None = Field(default=None, max_length=100, description="공고 ID(external_id) 목록. 있으면 목록 검색 없이 이 ID 만")
    timeout_sec: int | None = Field(default=None, ge=60, le=7200)


class PlatformLoadRequest(BaseModel):
    platform: Literal["board_a"] = "board_a"
    json_name: str
    batch_id: str = Field(min_length=1, max_length=100)
    compressed: list[dict] = Field(default_factory=list, max_length=300)


def _platform_json(name: str) -> Path:
    root = OUT_DIR.resolve()
    path = (root / name).resolve()
    if not path.is_relative_to(root) or path.parent != root or path.suffix.lower() != ".json" or not path.is_file():
        raise HTTPException(status_code=400, detail="json must be an existing file under crawler/out")
    return path


def _platform_list_url(body: PlatformRequest) -> str | None:
    """수집처 검색 URL 만 허용 (임의 URL 로 브라우저를 보내지 않는다). 호스트는 BOARD_A_BASE_URL 에서."""
    from urllib.parse import quote, urlparse

    from .platforms.board_a import BASE_URL, DEFAULT_LIST_URL

    base = urlparse(BASE_URL).hostname or ""
    hosts = {base, base.removeprefix("www.")}

    if body.list_url:
        u = urlparse(body.list_url.strip())
        if u.scheme != "https" or u.hostname not in hosts or not u.path.startswith("/zf_user/search"):
            raise HTTPException(status_code=400, detail="list_url 은 수집처 검색 결과 주소(https)만 허용")
        return body.list_url.strip()
    if body.keyword and body.keyword.strip():
        import re

        return re.sub(r"searchword=[^&]*", "searchword=" + quote(body.keyword.strip()), DEFAULT_LIST_URL, count=1)
    return None


@app.post("/v1/platform", status_code=202, dependencies=[Depends(require_key)])
def platform(body: PlatformRequest) -> dict:
    """플랫폼 전용 수집만 (DB 없음). 결과 JSON 이름은 GET /v1/jobs/{id} 의 result.json_name.
    압축(LLM)·적재는 orchestrator 가 이어서 한다 (/v1/platform-records → MCP compress_jd → /v1/platform-load)."""
    import re

    ids = [i.strip() for i in (body.ids or []) if i.strip()]
    if any(not re.fullmatch(r"\d{5,12}", i) for i in ids):
        raise HTTPException(status_code=400, detail="ids 는 숫자 공고 ID 만")
    list_url = _platform_list_url(body)

    def run() -> dict:
        args = [sys.executable, "-m", "jdcrawler", "platform", body.platform, f"--max={body.max}"]
        if ids:
            args.append("--ids=" + ",".join(ids))
        elif list_url:
            args.append("--list-url=" + list_url)
        extra = {n: os.environ[n] for n in ("CRAWLER_USER_AGENT", "CRAWLER_CONTACT", "CRAWL_DELAY_MIN", "CRAWL_DELAY_MAX", "BOARD_A_BASE_URL") if os.environ.get(n)}
        rc, out, err = run_child(args, build_child_env(extra), body.timeout_sec or 3600, ROOT)
        summary = last_json_object(out) or {}
        if is_timeout(rc, err):
            return {"error": "timeout", "detail": redact(err[-300:])}
        if rc != 0 or summary.get("status") != "ok":
            return {"error": "crawl_failed", "reason": summary.get("reason"), "saved": summary.get("saved"),
                    "detail": redact(str(summary.get("detail") or err[-300:]))}
        return {
            "json_name": Path(str(summary["json"])).name,
            "fetched": summary.get("fetched_total"),
            "review_counts": summary.get("review_counts_total"),
            "elapsed_sec": summary.get("elapsed_sec"),
        }

    return _enqueue(run, dedupe_key=("platform", body.platform))


@app.get("/v1/platform-records/{json_name}", dependencies=[Depends(require_key)])
def platform_records(json_name: str) -> dict:
    """압축 입력용으로 prune 한 레코드 (헌법 3조: 본문 원문 대신 목록·제목·회사만)."""
    import json

    data = json.loads(_platform_json(json_name).read_text(encoding="utf-8"))
    out = []
    for r in data.get("records") or []:
        out.append({
            "external_id": str(r.get("external_id") or r.get("rec_idx")),
            "title": r.get("title") or "",
            "company": r.get("company") or "",
            "has_body": bool((r.get("body_text") or "").strip()) and not r.get("body_text_missing"),
            "key_duties": r.get("key_duties") or [],
            "must_have": r.get("must_have") or [],
            "nice_to_have": r.get("nice_to_have") or [],
            "unclassified_items": r.get("unclassified_items") or [],
        })
    return {"records": out}


@app.post("/v1/platform-load", status_code=202, dependencies=[Depends(require_key)])
def platform_load(body: PlatformLoadRequest) -> dict:
    import json

    path = _platform_json(body.json_name)

    def run() -> dict:
        dsn = os.environ.get("SUPABASE_DB_URL") or ""
        if not dsn.startswith("postgres"):
            return {"error": "no_db_url"}
        from .platforms import store

        records = json.loads(path.read_text(encoding="utf-8")).get("records") or []
        stats = store.load_records(dsn, records, body.compressed, body.batch_id, body.platform)
        return {"batch_id": body.batch_id, "records": len(records), **stats}

    return _enqueue(run, dedupe_key=("platform-load", body.batch_id))


@app.get("/v1/jobs/{job_id}", dependencies=[Depends(require_key)])
def job_status(job_id: str) -> dict:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return {"job_id": job_id, **job}


def main() -> None:
    import uvicorn

    host = os.environ.get("CRAWLER_API_HOST", "127.0.0.1")
    port = int(os.environ.get("CRAWLER_API_PORT", "8010"))
    if not (os.environ.get("CRAWLER_API_KEY") or "").strip():
        raise SystemExit("CRAWLER_API_KEY required")
    if host.strip().lower() not in _LOOPBACK_HOSTS and os.environ.get("CRAWLER_ALLOW_NON_LOOPBACK") != "1":
        raise SystemExit("non-loopback host requires CRAWLER_ALLOW_NON_LOOPBACK=1")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
