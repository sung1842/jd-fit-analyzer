"""크롤 자식 프로세스 실행 / 환경 격리 / 게이트 어댑터 / 웹훅 payload 공용 모듈.

- 크롤은 항상 별도 프로세스(`python -m jdcrawler ...`)에서 돌린다 → 타임아웃 시 프로세스 트리 강제 종료 가능.
- 자식에게는 **허용목록** 환경변수만 넘긴다 (DB 접속 문자열·내부 키는 절대 넘기지 않음).
- stdout/stderr 는 여기서 redact 하지 않는다. 호출부가 `redact.redact()` 를 거쳐야 한다.
"""
from __future__ import annotations

import csv
import inspect
import json
import os
import signal
import subprocess
import sys
from pathlib import Path

from .redact import redact

ROOT = Path(__file__).resolve().parent.parent
_IS_WINDOWS = os.name == "nt"

TIMEOUT_RC = -1  # run_child 가 타임아웃 시 돌려주는 센티널 반환코드

# ---------------------------------------------------------------- 자식 환경 (허용목록)

_ENV_ALLOW = (
    "PATH", "SYSTEMROOT", "SystemRoot", "SYSTEMDRIVE", "TEMP", "TMP", "USERPROFILE", "HOME",
    "LOCALAPPDATA", "APPDATA", "COMSPEC", "PATHEXT", "WINDIR",
    # 컨테이너: chromium 이 /ms-playwright 에 설치됨 → 없으면 자식이 브라우저를 못 찾는다
    "PLAYWRIGHT_BROWSERS_PATH",
)
_FORBIDDEN_EXACT = {"SUPABASE_DB_URL", "CRAWLER_API_KEY", "MCP_INTERNAL_KEY"}
_FORBIDDEN_PREFIX = ("SUPABASE_", "ANTHROPIC_", "GEMINI_", "SLACK_", "NOTION_")


def _is_forbidden(name: str) -> bool:
    up = name.upper()
    return up in _FORBIDDEN_EXACT or up.startswith(_FORBIDDEN_PREFIX)


def build_child_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """허용목록 방식 자식 환경. extra 에 금지 키가 있으면 ValueError."""
    env: dict[str, str] = {}
    seen: set[str] = set()
    for name in _ENV_ALLOW:
        value = os.environ.get(name)
        # Windows 는 환경변수명이 대소문자 무시 → SYSTEMROOT/SystemRoot 중복 방지
        if value is not None and name.upper() not in seen:
            env[name] = value
            seen.add(name.upper())
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["JDCRAWLER_SKIP_DOTENV"] = "1"
    for name, value in (extra or {}).items():
        if _is_forbidden(name):
            raise ValueError(f"자식 프로세스에 전달할 수 없는 환경변수: {name}")
        if not isinstance(value, str):
            raise ValueError(f"환경변수 값은 문자열이어야 합니다: {name}")
        env[name] = value
    return env


# ---------------------------------------------------------------- 프로세스 실행

def _kill_tree(proc: subprocess.Popen) -> None:
    """프로세스 트리 전체 종료. 실패해도 직계 프로세스는 반드시 kill 시도."""
    try:
        if _IS_WINDOWS:
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                capture_output=True, timeout=15, check=False,
            )
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:
        pass
    try:
        proc.kill()
    except Exception:
        pass


def run_child(args: list[str], env: dict[str, str], timeout_sec: int, cwd: Path) -> tuple[int, str, str]:
    """(returncode, stdout, stderr). shell=False. 타임아웃이면 트리 kill 후 (TIMEOUT_RC, ..., stderr+'TIMEOUT')."""
    kwargs: dict = {}
    if _IS_WINDOWS:
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    proc = subprocess.Popen(
        args,
        shell=False,
        cwd=str(cwd),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        **kwargs,
    )
    try:
        out, err = proc.communicate(timeout=timeout_sec)
        return proc.returncode, out or "", err or ""
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
        try:
            out, err = proc.communicate(timeout=10)
        except Exception:  # 손자 프로세스가 파이프를 쥐고 있는 경우 등
            out, err = "", ""
            for pipe in (proc.stdout, proc.stderr):
                try:
                    if pipe:
                        pipe.close()
                except Exception:
                    pass
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
        return TIMEOUT_RC, out or "", (err or "")[-4000:] + "\nTIMEOUT"


def is_timeout(rc: int, stderr: str) -> bool:
    return rc == TIMEOUT_RC and stderr.rstrip().endswith("TIMEOUT")


def last_json_object(stdout: str) -> dict | None:
    """stdout 에서 마지막으로 완결된 최상위 JSON 객체. 줄 시작(앞은 공백만)의 `{` 만 후보. 없으면 None."""
    if not stdout:
        return None
    decoder = json.JSONDecoder()
    last: dict | None = None
    pos = 0
    n = len(stdout)
    while pos < n:
        i = stdout.find("{", pos)
        if i < 0:
            break
        line_start = stdout.rfind("\n", 0, i) + 1
        if stdout[line_start:i].strip():  # 같은 줄 앞에 다른 글자가 있으면 로그 잡음
            pos = i + 1
            continue
        try:
            obj, end = decoder.raw_decode(stdout, i)
        except ValueError:
            pos = i + 1
            continue
        if isinstance(obj, dict):
            last = obj
        pos = max(end, i + 1)
    return last


# ---------------------------------------------------------------- 입력 검증

def validate_arg(value: str | None, name: str, max_len: int = 100) -> str | None:
    """자식 argv 로 들어갈 사용자 입력 검증. 위반 시 ValueError."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{name}: 문자열이어야 합니다")
    if len(value) > max_len:
        raise ValueError(f"{name}: {max_len}자 이하")
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError(f"{name}: 제어문자 금지")
    if value.lstrip().startswith("-"):
        raise ValueError(f"{name}: '-' 로 시작할 수 없습니다")
    return value


# ---------------------------------------------------------------- 게이트 어댑터 (fail-closed)

def gate_evaluate(csv_path: Path, source: str, history_path: Path) -> dict:
    """gate.evaluate_csv 호출 + 결과 정규화 → {"ok","reason","warnings","stats"}.

    모듈 부재/예외/형식 오류는 모두 ok=False(reason="gate_error"). history 는 기록하지 않는다
    (적재 성공 후 gate_record 로만 기록).
    """
    try:
        from . import gate

        kwargs = {}
        if "record" in inspect.signature(gate.evaluate_csv).parameters:
            kwargs["record"] = False  # 구형 시그니처: 평가만, 기록은 나중에
        res = gate.evaluate_csv(csv_path, source, history_path, **kwargs)
        if not isinstance(res, dict):
            raise TypeError("gate result is not dict")
    except Exception as exc:
        print(f"[gate] 평가 실패: {type(exc).__name__}: {redact(exc)}", file=sys.stderr)
        return {"ok": False, "reason": "gate_error", "warnings": [], "stats": {}}
    reason = res.get("reason")
    reasons = res.get("reasons")
    if not reason and reasons:
        reason = str(reasons[0])
    ok = bool(res.get("ok")) and not reason
    if not ok and not reason:
        reason = "gate_failed"
    return {
        "ok": ok,
        "reason": None if ok else str(reason),
        "warnings": [redact(w) for w in (res.get("warnings") or [])][:20],
        "stats": res.get("stats") or {},
    }


def gate_record(source: str, fetched: int, history_path: Path, csv_path: Path | None = None) -> None:
    """적재/통과 성공 후 history 기록. 실패해도 본 결과에는 영향 없음."""
    try:
        from . import gate

        if hasattr(gate, "record_history"):
            gate.record_history(source, fetched, history_path)
        elif csv_path is not None:  # 구형: evaluate_csv(record=True)
            gate.evaluate_csv(csv_path, source, history_path, record=True)
    except Exception as exc:
        print(f"[gate] history 기록 실패: {type(exc).__name__}: {redact(exc)}", file=sys.stderr)


def csv_source(csv_path: Path) -> str | None:
    """CSV 첫 데이터 행의 source 컬럼 (기존 CSV 를 load 할 때 gate 용)."""
    try:
        with csv_path.open("r", encoding="utf-8", newline="") as f:
            row = next(csv.DictReader(f), None)
        return (row or {}).get("source") or None
    except Exception:
        return None
