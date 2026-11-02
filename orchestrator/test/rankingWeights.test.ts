/** 층별 가중치 보정(rankingWeights.ts) 테스트: T7, 폭 제한, 합 100, 테이블 없음 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_RANK_WEIGHTS } from "../../shared/matchTypes.js";
import { __setWeightFetcher, alpha, buildTrainingSamples, combineWeights, getEffectiveWeights, learnBoosts, normalize100, planWeightUpserts, recomputeRankingWeights, type TrainingSample, type WeightRow } from "../src/lib/rankingWeights.js";

const sum = (w: object) => Math.round(Object.values(w as Record<string, number>).reduce((a, b) => a + b, 0) * 100) / 100;
const row = (scope: WeightRow["scope"], id: string, weights: unknown, n: number, version = 1): WeightRow => ({ scope, scope_id: id, weights, sample_n: n, version });

describe("rankingWeights", () => {
  test("alpha: 30 이하 0, 100 이상 1", () => {
    assert.equal(alpha(0), 0);
    assert.equal(alpha(29), 0);
    assert.equal(alpha(30), 0);
    assert.equal(alpha(65), 0.5);
    assert.equal(alpha(100), 1);
    assert.equal(alpha(500), 1);
  });

  test("T7: 결정 30건 미만 기업은 보정 0", () => {
    const e = combineWeights({ company: row("company", "acme", { must: 0.2 }, 29) });
    assert.deepEqual(e.weights, DEFAULT_RANK_WEIGHTS);
    assert.deepEqual(e.boost, {});
  });

  test("폭 제한, 허용 외 항목 무시, 합 100", () => {
    const e = combineWeights({ company: row("company", "acme", { must: 5, vector: -9, age: 1 }, 100), recruiter: row("recruiter", "r1", { nice: 0.1 }, 65) });
    assert.equal(e.boost.company!.must, 0.2);
    assert.equal(e.boost.company!.vector, -0.2);
    assert.equal((e.boost.company as Record<string, number>).age, undefined);
    assert.equal(e.boost.recruiter!.nice, 0.05);
    assert.equal(sum(e.weights), 100);
    assert.ok(e.weights.must > DEFAULT_RANK_WEIGHTS.must && e.weights.vector < DEFAULT_RANK_WEIGHTS.vector);
    assert.equal(e.version, "c1-r1");
  });

  test("normalize100 합은 항상 100", () => {
    assert.equal(sum(normalize100({ must: 1, nice: 1, years: 1, role: 0, vector: 0, activity: 0 })), 100);
    assert.equal(sum(normalize100({ must: 0, nice: 0, years: 0, role: 0, vector: 0, activity: 0 })), 100);
  });

  test("테이블 없음/행 없음/예외 -> 기본값 version default", async () => {
    __setWeightFetcher(async () => null);
    assert.deepEqual(await getEffectiveWeights({ companyId: "acme" }), { weights: DEFAULT_RANK_WEIGHTS, boost: {}, version: "default" });
    __setWeightFetcher(async () => []);
    assert.equal((await getEffectiveWeights({ companyId: "x" })).version, "default");
    __setWeightFetcher(async () => {
      throw new Error("boom");
    });
    assert.equal((await getEffectiveWeights({ recruiterId: "y" })).version, "default");
  });

  test("캐시: 같은 scope 는 한 번만 조회", async () => {
    let calls = 0;
    __setWeightFetcher(async () => {
      calls++;
      return [row("global", "-", { must: 50, nice: 10, years: 10, role: 10, vector: 15, activity: 5 }, 0, 3)];
    });
    const a = await getEffectiveWeights({});
    await getEffectiveWeights({});
    assert.equal(calls, 1);
    assert.equal(a.weights.must, 50);
    assert.equal(a.version, "g3");
  });

  test("학습: 평균 차이, 층-전체 차이 클램프, 한쪽 그룹만 있으면 보정 없음", () => {
    const s = (d: "approved" | "rejected", must: number, c: string): TrainingSample => ({ decision: d, breakdown: { must, nice: 0.5 }, companyId: c, recruiterId: null });
    const samples = [s("approved", 1, "acme"), s("rejected", 0, "acme"), s("approved", 0.5, "beta"), s("rejected", 0.5, "beta"), s("approved", 0.9, "solo")];
    const { company, recruiter } = learnBoosts(samples);
    assert.equal(recruiter.size, 0);
    // 전체 gap must = mean(1,.5,.9) - mean(0,.5) = .8 - .25 = .55
    assert.equal(company.get("acme")!.boost.must, 0.2); // 1 - .55 -> 클램프
    assert.equal(company.get("beta")!.boost.must, -0.2); // 0 - .55 -> 클램프
    assert.deepEqual(company.get("solo")!.boost, {});
    assert.equal(company.get("acme")!.boost.nice, undefined);
    assert.equal(company.get("acme")!.n, 2);
  });

});

describe("rankingWeights 리뷰 1라운드", () => {
  const dec = (jdHash: string, candidateId: string, decision: "approved" | "rejected", companyId: string | null = "acme", recruiterId = "r1") => ({ jdHash, candidateId, decision, companyId, recruiterId });

  test("024 형태 score_breakdown.items 를 읽고 excluded(vector) 는 뺀다, (jd_hash, candidate_id) 조인", () => {
    const rows = [
      { jd_hash: "h1", candidate_id: "c1", score_breakdown: { items: { must: 0.8, nice: 0.5, years: 1, role: 1, vector: 0, activity: 0.2, age: 1 }, weights: {}, boost: {}, excluded: ["vector"] } },
      { jd_hash: "h1", candidate_id: "c2", score_breakdown: { items: { must: 1.5, vector: 0.7 }, excluded: [] } },
      { jd_hash: "h1", candidate_id: "c3", score_breakdown: { must: 0.9 } as never },
    ];
    const s = buildTrainingSamples(rows, [dec("h1", "c1", "approved"), dec("h1", "c2", "rejected", null, "r2"), dec("h1", "c3", "approved"), dec("h9", "c1", "approved")]);
    assert.equal(s.length, 2);
    assert.equal(s[0].breakdown.must, 0.8);
    assert.equal(s[0].breakdown.vector, undefined);
    assert.equal((s[0].breakdown as Record<string, number>).age, undefined);
    assert.equal(s[1].breakdown.must, 1);
    assert.equal(s[1].breakdown.vector, 0.7);
    assert.equal(s[1].recruiterId, "r2");
  });

  test("version 증가, 이번 학습에 없는 기존 행은 boost {} 로 리셋", () => {
    const learned = { company: new Map([["acme", { boost: { must: 0.1 }, n: 40 }]]), recruiter: new Map() };
    const up = planWeightUpserts(learned, [{ scope: "company", scope_id: "acme", version: 2 }, { scope: "recruiter", scope_id: "old", version: 5 }, { scope: "global", scope_id: "-", version: 1 }], "t");
    assert.deepEqual(up.find((u) => u.scope_id === "acme"), { scope: "company", scope_id: "acme", weights: { must: 0.1 }, sample_n: 40, version: 3, updated_at: "t" });
    assert.deepEqual(up.find((u) => u.scope_id === "old"), { scope: "recruiter", scope_id: "old", weights: {}, sample_n: 0, version: 6, updated_at: "t" });
    assert.equal(up.some((u) => (u.scope as string) === "global"), false);
  });

  test("recompute: table_missing 이면 저장 안 함, 샘플 0 이면 기존 행만 리셋", async () => {
    let saved: unknown[] | null = null;
    const r1 = await recomputeRankingWeights({ loadExisting: async () => null, loadSamples: async () => [], save: async (x) => void (saved = x) });
    assert.equal(r1.skipped, "table_missing");
    assert.equal(saved, null);
    const r2 = await recomputeRankingWeights({ loadExisting: async () => [{ scope: "company", scope_id: "acme", version: 1 }], loadSamples: async () => [], save: async (x) => void (saved = x) });
    assert.equal(r2.skipped, "no_samples");
    assert.equal(r2.reset, 1);
    assert.equal((saved as unknown as { version: number }[])[0].version, 2);
  });

  test("global 절대 가중치 + company + recruiter 동시 결합", () => {
    const e = combineWeights({
      global: row("global", "-", { must: 50, nice: 10, years: 10, role: 10, vector: 15, activity: 5 }, 0, 4),
      company: row("company", "acme", { must: 0.2 }, 100, 2),
      recruiter: row("recruiter", "r1", { must: 0.1, role: -0.2 }, 100, 7),
    });
    // must: 50*1.2*1.1=66, role: 10*0.8=8, 나머지 40 → 합 114
    assert.equal(e.weights.must, Math.round((66 / 114) * 10000) / 100);
    assert.equal(sum(e.weights), 100);
    assert.deepEqual(e.boost, { company: { must: 0.2 }, recruiter: { must: 0.1, role: -0.2 } });
    assert.equal(e.version, "g4-c2-r7");
  });
});
