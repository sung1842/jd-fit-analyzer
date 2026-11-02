"""플랫폼 수집 이어하기(체크포인트). 네트워크·DB 없음 — 파일만 다룬다.

한 번의 수집은 같은 이름(stem)의 파일 3개를 쓴다.
  <stem>.plan.json      시작할 때 정한 공고 목록(순서 포함). 이어하기는 목록을 다시 검색하지 않고 이것을 쓴다
                        (관련도순 목록은 시간이 지나면 바뀌므로, 다시 검색하면 중복·누락이 생긴다).
  <stem>.partial.jsonl  공고 1건이 끝날 때마다 한 줄. 도중에 죽거나 멈춰도 여기까지는 남는다.
  <stem>.json           전부 끝났을 때만 만든다. 이때 plan/partial 은 지운다.

이어하기 규칙: partial 에 있는 공고 ID(external_id) 는 다시 받지 않는다. 단 review_status 가 retry_later(요청 실패)인 건은
다시 받는다. 같은 ID 가 partial 에 여러 줄이면 마지막 줄이 이긴다.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

RETRY_STATUSES = frozenset({"retry_later"})


@dataclass(frozen=True)
class CheckpointPaths:
    stem: Path

    @classmethod
    def from_any(cls, path: str | Path) -> "CheckpointPaths":
        """out/x.json · out/x.plan.json · out/x.partial.jsonl · out/x 어느 것을 줘도 같은 stem 으로."""
        p = Path(path)
        name = p.name
        for suffix in (".plan.json", ".partial.jsonl", ".json"):
            if name.endswith(suffix):
                name = name[: -len(suffix)]
                break
        return cls(p.with_name(name))

    @property
    def plan(self) -> Path:
        return self.stem.with_name(self.stem.name + ".plan.json")

    @property
    def partial(self) -> Path:
        return self.stem.with_name(self.stem.name + ".partial.jsonl")

    @property
    def final(self) -> Path:
        return self.stem.with_name(self.stem.name + ".json")


def _id(rec: dict) -> str:
    """공고 ID. 2026-10-27 이전 partial 파일은 키가 rec_idx."""
    return str(rec.get("external_id") or rec.get("rec_idx"))


def write_plan(paths: CheckpointPaths, items: list[dict], meta: dict[str, Any]) -> None:
    paths.plan.write_text(json.dumps({"meta": meta, "items": items}, ensure_ascii=False, indent=2), encoding="utf-8")


def read_plan(paths: CheckpointPaths) -> tuple[list[dict], dict]:
    data = json.loads(paths.plan.read_text(encoding="utf-8"))
    return data["items"], data.get("meta") or {}


def append_record(paths: CheckpointPaths, rec: dict) -> None:
    with paths.partial.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")


def read_partial(paths: CheckpointPaths) -> dict[str, dict]:
    """공고 ID → 마지막 레코드. 죽는 순간 반쯤 쓰인 마지막 줄은 버린다."""
    out: dict[str, dict] = {}
    if not paths.partial.exists():
        return out
    for line in paths.partial.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        out[_id(rec)] = rec
    return out


def remaining_items(items: list[dict], done: dict[str, dict]) -> list[dict]:
    """plan 순서를 유지한 채, 아직 안 받았거나 retry_later 인 공고만."""
    return [
        it for it in items
        if _id(it) not in done or done[_id(it)].get("review_status") in RETRY_STATUSES
    ]


def ordered_records(items: list[dict], done: dict[str, dict]) -> list[dict]:
    """plan 순서대로 받은 레코드만."""
    return [done[_id(it)] for it in items if _id(it) in done]


def finish(paths: CheckpointPaths, records: list[dict], meta: dict[str, Any]) -> None:
    paths.final.write_text(
        json.dumps({"meta": meta, "records": records}, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )
    paths.plan.unlink(missing_ok=True)
    paths.partial.unlink(missing_ok=True)
