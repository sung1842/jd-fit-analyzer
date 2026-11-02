"""gate.py 단위 테스트 (stdlib unittest, 임시 디렉토리 사용)."""
from __future__ import annotations

import csv
import json
import tempfile
import unittest
from pathlib import Path

from jdcrawler.csv_writer import COLUMNS
from jdcrawler.gate import (
    DESC_MIN_LEN,
    HISTORY_KEEP,
    evaluate_csv,
    record_history,
)

LONG_DESC = "d" * (DESC_MIN_LEN + 10)
SHORT_DESC = "d" * (DESC_MIN_LEN - 1)


def make_row(i: int, *, title: str = "Backend Engineer", url: str | None = None, desc: str = LONG_DESC) -> dict:
    row = {c: "" for c in COLUMNS}
    row.update(
        load_batch_id="b1",
        source="x",
        external_id=f"id{i}",
        url=url if url is not None else f"https://example.com/job/{i}",
        company="ACME",
        title=title,
        description=desc,
        skills="{}",
        content_hash=f"h{i}",
    )
    return row


def write_rows(path: Path, rows: list[dict], header: list[str] | None = None) -> Path:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header if header is not None else COLUMNS)
        for r in rows:
            w.writerow([r[c] for c in COLUMNS])
    return path


class GateBase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.history = self.dir / "sub" / "history.json"  # 부모 디렉토리 없음

    def csv_of(self, rows: list[dict], name: str = "b.csv") -> Path:
        return write_rows(self.dir / name, rows)

    def seed_history(self, source: str, counts: list[int]) -> None:
        self.history.parent.mkdir(parents=True, exist_ok=True)
        data = {source: [{"ts": "2026-10-01T00:00:00+00:00", "fetched": c} for c in counts]}
        self.history.write_text(json.dumps(data), encoding="utf-8")

    def read_history(self) -> dict:
        return json.loads(self.history.read_text(encoding="utf-8"))


class TestEvaluate(GateBase):
    def test_header_only_is_empty(self):
        r = evaluate_csv(self.csv_of([]), "board_a", self.history)
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "empty")
        self.assertEqual(r["stats"]["fetched"], 0)

    def test_zero_byte_file_is_bad_csv(self):
        p = self.dir / "z.csv"
        p.write_bytes(b"")
        r = evaluate_csv(p, "board_a", self.history)
        self.assertEqual(r["reason"], "bad_csv")

    def test_missing_file_is_bad_csv(self):
        r = evaluate_csv(self.dir / "nope.csv", "board_a", self.history)
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "bad_csv")

    def test_header_mismatch_is_bad_csv(self):
        bad = COLUMNS[:-1] + ["other"]
        p = write_rows(self.dir / "h.csv", [make_row(0)], header=bad)
        self.assertEqual(evaluate_csv(p, "board_a", self.history)["reason"], "bad_csv")

    def test_healthy_batch_ok(self):
        r = evaluate_csv(self.csv_of([make_row(i) for i in range(10)]), "board_a", self.history)
        self.assertTrue(r["ok"], r)
        self.assertIsNone(r["reason"])
        self.assertEqual(r["warnings"], [])
        self.assertEqual(r["stats"]["fetched"], 10)
        self.assertEqual(r["stats"]["valid"], 10)
        self.assertEqual(r["stats"]["valid_ratio"], 1.0)
        self.assertIsNone(r["stats"]["desc_short_ratio"])
        self.assertIsNone(r["stats"]["history_median"])

    def test_evaluate_does_not_write_history(self):
        evaluate_csv(self.csv_of([make_row(i) for i in range(10)]), "board_a", self.history)
        self.assertFalse(self.history.exists())
        self.assertFalse(self.history.parent.exists())

    def test_valid_ratio_boundary(self):
        # 100행 중 89 valid(0.89) → 실패, 90 valid(0.90) → 통과
        def batch(valid: int):
            rows = [make_row(i) for i in range(valid)]
            rows += [make_row(i, title="") for i in range(valid, 100)]
            return rows

        r89 = evaluate_csv(self.csv_of(batch(89), "a.csv"), "board_a", self.history)
        self.assertFalse(r89["ok"])
        self.assertEqual(r89["reason"], "low_valid_ratio")
        self.assertEqual(r89["stats"]["valid_ratio"], 0.89)

        r90 = evaluate_csv(self.csv_of(batch(90), "b.csv"), "board_a", self.history)
        self.assertTrue(r90["ok"], r90)
        self.assertEqual(r90["stats"]["valid_ratio"], 0.9)

    def test_javascript_url_is_invalid(self):
        rows = [make_row(i) for i in range(8)]
        rows += [make_row(i, url="javascript:alert(1)") for i in range(8, 10)]
        r = evaluate_csv(self.csv_of(rows), "board_a", self.history)
        self.assertEqual(r["stats"]["valid"], 8)
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "low_valid_ratio")

    def test_blank_title_or_url_invalid(self):
        rows = [make_row(i) for i in range(8)]
        rows.append(make_row(8, title="   "))
        rows.append(make_row(9, url=""))
        r = evaluate_csv(self.csv_of(rows), "board_a", self.history)
        self.assertEqual(r["stats"]["valid"], 8)

    def test_crawl4ai_short_desc_boundary(self):
        # 100행 중 짧은 desc 41개(0.41) → 실패, 40개(0.40) → 통과(초과일 때만 실패)
        def batch(short: int):
            return [make_row(i, desc=SHORT_DESC) for i in range(short)] + [
                make_row(i) for i in range(short, 100)
            ]

        r41 = evaluate_csv(self.csv_of(batch(41), "a.csv"), "crawl4ai:site", self.history)
        self.assertFalse(r41["ok"])
        self.assertEqual(r41["reason"], "low_desc_ratio")
        self.assertEqual(r41["stats"]["desc_short_ratio"], 0.41)

        r40 = evaluate_csv(self.csv_of(batch(40), "b.csv"), "crawl4ai:site", self.history)
        self.assertTrue(r40["ok"], r40)
        self.assertEqual(r40["stats"]["desc_short_ratio"], 0.4)

    def test_same_data_passes(self):
        rows = [make_row(i, desc=SHORT_DESC) for i in range(41)] + [make_row(i) for i in range(41, 100)]
        p = self.csv_of(rows)
        self.assertTrue(evaluate_csv(p, "board_a", self.history)["ok"])
        self.assertFalse(evaluate_csv(p, "crawl4ai", self.history)["ok"])  # 접두 'crawl4ai' 도 적용

    def test_desc_length_exactly_min_is_not_short(self):
        rows = [make_row(i, desc="d" * DESC_MIN_LEN) for i in range(10)]
        r = evaluate_csv(self.csv_of(rows), "crawl4ai:x", self.history)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["stats"]["desc_short_ratio"], 0.0)

    def test_bom_accepted(self):
        p = self.csv_of([make_row(i) for i in range(10)])
        p.write_bytes(b"\xef\xbb\xbf" + p.read_bytes())
        self.assertTrue(evaluate_csv(p, "board_a", self.history)["ok"])

    def test_large_raw_field_ok(self):
        # csv 기본 필드 한도(131072자)를 넘는 값이 있어도 bad_csv 가 아니어야 한다
        rows = [make_row(i, desc="x" * 200_000) for i in range(10)]
        r = evaluate_csv(self.csv_of(rows), "board_a", self.history)
        self.assertTrue(r["ok"], r)


class TestHistory(GateBase):
    def test_drop_warns_but_stays_ok(self):
        self.seed_history("board_a", [100, 100, 100])
        r = evaluate_csv(self.csv_of([make_row(i) for i in range(10)]), "board_a", self.history)
        self.assertTrue(r["ok"], r)
        self.assertIsNone(r["reason"])
        self.assertEqual(len(r["warnings"]), 1)
        self.assertIn("중앙값", r["warnings"][0])
        self.assertEqual(r["stats"]["history_median"], 100.0)

    def test_no_warning_at_or_above_threshold(self):
        self.seed_history("board_a", [100, 100, 100])
        r = evaluate_csv(self.csv_of([make_row(i) for i in range(30)]), "board_a", self.history)
        self.assertEqual(r["warnings"], [])

    def test_needs_three_entries(self):
        self.seed_history("board_a", [100, 100])
        r = evaluate_csv(self.csv_of([make_row(i) for i in range(5)]), "board_a", self.history)
        self.assertEqual(r["warnings"], [])
        self.assertIsNone(r["stats"]["history_median"])

    def test_median_uses_last_seven_only(self):
        # 앞의 오래된 값(1000)은 무시, 최근 7개는 모두 10 → 중앙값 10
        self.seed_history("board_a", [1000] * 5 + [10] * 7)
        r = evaluate_csv(self.csv_of([make_row(i) for i in range(10)]), "board_a", self.history)
        self.assertEqual(r["stats"]["history_median"], 10.0)
        self.assertEqual(r["warnings"], [])

    def test_history_is_per_source(self):
        self.seed_history("other", [100, 100, 100])
        r = evaluate_csv(self.csv_of([make_row(i) for i in range(5)]), "board_a", self.history)
        self.assertEqual(r["warnings"], [])

    def test_hard_failure_wins_over_drop_warning(self):
        self.seed_history("board_a", [100, 100, 100])
        rows = [make_row(i, title="") for i in range(10)]
        r = evaluate_csv(self.csv_of(rows), "board_a", self.history)
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "low_valid_ratio")

    def test_record_history_creates_parent_and_appends(self):
        record_history("board_a", 12, self.history)
        record_history("board_a", 15, self.history)
        entries = self.read_history()["board_a"]
        self.assertEqual([e["fetched"] for e in entries], [12, 15])
        self.assertIn("ts", entries[0])
        self.assertTrue(entries[0]["ts"].endswith("+00:00"))  # UTC ISO8601
        self.assertEqual([p.name for p in self.history.parent.iterdir()], ["history.json"])  # tmp 잔재 없음

    def test_record_history_keeps_last_30(self):
        for i in range(HISTORY_KEEP + 5):
            record_history("board_a", i, self.history)
        entries = self.read_history()["board_a"]
        self.assertEqual(len(entries), HISTORY_KEEP)
        self.assertEqual(entries[0]["fetched"], 5)
        self.assertEqual(entries[-1]["fetched"], HISTORY_KEEP + 4)

    def test_record_history_trim_does_not_affect_other_sources(self):
        record_history("a", 1, self.history)
        for i in range(HISTORY_KEEP + 2):
            record_history("b", i, self.history)
        h = self.read_history()
        self.assertEqual(len(h["a"]), 1)
        self.assertEqual(len(h["b"]), HISTORY_KEEP)

    def test_corrupt_history_warned_on_evaluate(self):
        self.history.parent.mkdir(parents=True)
        self.history.write_text("{ not json", encoding="utf-8")
        r = evaluate_csv(self.csv_of([make_row(i) for i in range(10)]), "board_a", self.history)
        self.assertTrue(r["ok"], r)
        self.assertIn("history 파일 손상, 무시", r["warnings"])
        self.assertEqual(self.history.read_text(encoding="utf-8"), "{ not json")  # evaluate 는 쓰지 않음

    def test_non_dict_history_treated_as_corrupt(self):
        self.history.parent.mkdir(parents=True)
        self.history.write_text("[1, 2, 3]", encoding="utf-8")
        r = evaluate_csv(self.csv_of([make_row(i) for i in range(10)]), "board_a", self.history)
        self.assertIn("history 파일 손상, 무시", r["warnings"])

    def test_record_history_recovers_from_corrupt(self):
        self.history.parent.mkdir(parents=True)
        self.history.write_text("{ not json", encoding="utf-8")
        record_history("board_a", 7, self.history)
        self.assertEqual([e["fetched"] for e in self.read_history()["board_a"]], [7])

    def test_garbage_entries_ignored_in_median(self):
        self.history.parent.mkdir(parents=True)
        data = {"board_a": [{"fetched": "x"}, {"fetched": 100}, None, {"fetched": 100}, {"fetched": 100}]}
        self.history.write_text(json.dumps(data), encoding="utf-8")
        r = evaluate_csv(self.csv_of([make_row(i) for i in range(10)]), "board_a", self.history)
        self.assertEqual(r["stats"]["history_median"], 100.0)

    def test_record_flag_compat(self):
        # 기존 호출자 호환: record=True 는 ok 일 때만 기록, 기본값은 기록 안 함
        p = self.csv_of([make_row(i) for i in range(10)])
        evaluate_csv(p, "board_a", self.history, record=True)
        self.assertEqual([e["fetched"] for e in self.read_history()["board_a"]], [10])
        bad = self.csv_of([make_row(i, title="") for i in range(10)], "bad.csv")
        evaluate_csv(bad, "board_a", self.history, record=True)
        self.assertEqual(len(self.read_history()["board_a"]), 1)


if __name__ == "__main__":
    unittest.main()
