"""에러 문자열·로그에서 비밀값을 가린다. 웹훅·/v1/jobs 응답·콘솔 출력에 나가는 모든 오류 텍스트는 이걸 거친다.

3단 방어 (앞에서 못 잡아도 뒤에서 잡는다):
  1) 실제 값 치환 — 이 프로세스 환경변수에 들어 있는 비밀값(키·비밀번호·DSN)을 문자열 그대로 찾아 가린다.
     패턴으로 예측할 수 없는 형태(비밀번호 안의 '@', '+/=' 등)도 값을 알고 있으니 확실히 가려진다.
  2) 형식 패턴 — access-key=, postgres://user:pw@, Bearer, x-internal-key, password=/token= 류.
  3) 토큰 모양 — JWT(eyJ...), Supabase(sbp_/sb_secret_), Anthropic(sk-ant-), Google(AIza) 키 모양.
"""
from __future__ import annotations

import os
import re
from urllib.parse import quote, unquote

# 값 치환 대상 환경변수. 이름이 아래에 해당하면(대소문자 무시) 값 자체를 가린다.
_SECRET_ENV_HINT = re.compile(r"(KEY|SECRET|TOKEN|PASSWORD|PASSWD|_DB_URL|DSN)", re.IGNORECASE)
# 짧은 값(예: "1", "true")을 가리면 일반 텍스트가 망가진다. 이 길이 미만은 건너뛴다.
_MIN_SECRET_LEN = 8
# 공개돼도 되는 값 (anon/publishable key 는 어차피 브라우저에 노출됨)
_PUBLIC_ENV = {"NEXT_PUBLIC_SUPABASE_ANON_KEY"}

_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(access-key=)[^&\s\"']+", re.IGNORECASE), r"\1***"),
    # 비밀번호에 인코딩 안 된 '@' 가 있어도 같은 토큰(공백 없는 덩어리)의 마지막 '@' 까지 가린다 (과마스킹 쪽으로 기운다)
    (re.compile(r"(postgres(?:ql)?://[^:/\s@]+:)\S+(@)", re.IGNORECASE), r"\1***\2"),
    # Bearer: 문자 종류를 제한하지 않는다 (+ / = 포함)
    (re.compile(r"(Bearer\s+)[^\s\"',}]+", re.IGNORECASE), r"\1***"),
    (re.compile(r"(x-internal-key[\"']?\s*[:=]\s*[\"']?)[^\s\"',}]+", re.IGNORECASE), r"\1***"),
    (re.compile(r"(x-webhook-secret[\"']?\s*[:=]\s*[\"']?)[^\s\"',}]+", re.IGNORECASE), r"\1***"),
    (
        re.compile(
            r"((?:password|passwd|pwd|secret|token|api[_-]?key|apikey)[\"']?\s*[:=]\s*[\"']?)[^\s\"',&}]+",
            re.IGNORECASE,
        ),
        r"\1***",
    ),
    # 토큰 모양
    (re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]+\.?[A-Za-z0-9_\-]*"), "***jwt***"),
    (re.compile(r"\b(?:sbp_|sb_secret_|sk-ant-|AIza)[A-Za-z0-9_\-]{10,}"), "***key***"),
]


def _env_secret_values() -> list[str]:
    """환경변수에서 가려야 할 실제 값 목록(긴 것 우선). DSN 이면 비밀번호 부분도 따로 넣는다."""
    values: set[str] = set()
    for name, value in os.environ.items():
        if name in _PUBLIC_ENV or not value or not _SECRET_ENV_HINT.search(name):
            continue
        value = value.strip()
        if len(value) >= _MIN_SECRET_LEN:
            values.add(value)
        if value.lower().startswith(("postgres://", "postgresql://")):
            values.update(_dsn_password_forms(value))
    return sorted(values, key=len, reverse=True)


def _dsn_password_forms(dsn: str) -> set[str]:
    """DSN 의 비밀번호를 원문·디코딩·재인코딩 3가지 모양으로 돌려준다 (에러 메시지엔 어느 쪽이든 나올 수 있다)."""
    out: set[str] = set()
    try:
        raw = dsn.split("://", 1)[1]
        creds = raw.rsplit("@", 1)[0]  # 비밀번호 안의 '@' 를 허용하려고 마지막 '@' 기준
        if ":" not in creds:
            return out
        pw = creds.split(":", 1)[1]
        for form in (pw, unquote(pw), quote(unquote(pw), safe="")):
            if len(form) >= _MIN_SECRET_LEN:
                out.add(form)
    except Exception:
        pass
    return out


def redact(text: object, limit: int = 300) -> str:
    """비밀값을 가리고 limit 자로 자른다. 마스킹은 자르기 전에 적용되므로 경계에 걸린 비밀도 새지 않는다."""
    s = str(text)
    for secret in _env_secret_values():
        s = s.replace(secret, "***")
    for pattern, repl in _PATTERNS:
        s = pattern.sub(repl, s)
    return s[:limit]


def safe_error(exc: BaseException, limit: int = 300) -> str:
    """'ExceptionType: 가려진 메시지' 형태."""
    return f"{type(exc).__name__}: {redact(exc, limit)}"
