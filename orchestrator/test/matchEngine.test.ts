import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_RANK_WEIGHTS, type EffectiveWeights } from "../../shared/matchTypes.js";
import { activityItem, DEFAULT_EFFECTIVE_WEIGHTS, loadEffectiveWeights, rankCandidates, scoreCandidate, yearsItem, type RankInput } from "../src/lib/matchEngine.js";
import { SkillDictionary } from "../src/lib/skillDictionary.js";
import { SKILL_SEED } from "../src/lib/skillSeed.js";

const dict = new SkillDictionary(SKILL_SEED);
const NOW = Date.parse("2026-10-30T00:00:00Z");
const req = { role: "backend", must_skills: ["Java", "Spring Boot"], nice_skills: ["Kafka"], years_min: 3, years_max: 7 };
const c = (o: Partial<RankInput>): RankInput => ({ id: "x", skills: [], roleAffinity: 1, hasRoles: true, totalYears: 5, vectorSim: 0.8, activityAt: "2026-10-20T00:00:00Z", ...o });
const cands: RankInput[] = [
  c({ id: "a", skills: ["Java", "Spring Boot", "Kafka"] }),
  c({ id: "b", skills: ["Java", "Spring Boot"], totalYears: 10, vectorSim: 0.6 }),
  c({ id: "c", skills: ["JavaScript", "Node.js"], vectorSim: 0.9 }),
  c({ id: "d", skills: ["Java", "Spring Boot"], roleAffinity: 0.8, activityAt: null }),
];
const opts = { vectorAvailable: true, now: NOW };

describe("C 단계 계산식 (22 문서 E5)", () => {
  test("T5 같은 입력 2회 → 같은 순위·점수", () => {
    const r1 = rankCandidates(dict, req, cands, DEFAULT_EFFECTIVE_WEIGHTS, opts);
    const r2 = rankCandidates(dict, req, [...cands].reverse(), DEFAULT_EFFECTIVE_WEIGHTS, opts);
    assert.deepEqual(r1, r2);
    assert.equal(r1[0].id, "a");
  });

  test("T6 필수 미충족 → rank ≤ 50, 상한 전 점수는 raw 에 기록", () => {
    const r = scoreCandidate(dict, req, c({ id: "c", skills: ["JavaScript"], vectorSim: 1 }), DEFAULT_EFFECTIVE_WEIGHTS, opts);
    assert.ok(r.rankScore <= 50);
    assert.equal(r.breakdown.mustUnmet, true);
    assert.deepEqual(r.missingMust, ["Java", "Spring Boot"]);
    const all = scoreCandidate(dict, req, c({ skills: ["Java"], vectorSim: 1 }), DEFAULT_EFFECTIVE_WEIGHTS, opts);
    assert.ok(all.breakdown.raw > 50 && all.rankScore === 50);
  });

  test("상한 50 동점은 상한 전 점수로 순서 (회귀: 실데이터에서 전원 50 동점)", () => {
    const r = rankCandidates(dict, req, [c({ id: "a1", skills: ["Java"], vectorSim: 0.5 }), c({ id: "z9", skills: ["Java", "Kafka"], vectorSim: 1 })], DEFAULT_EFFECTIVE_WEIGHTS, opts);
    assert.equal(r[0].rankScore, 50);
    assert.equal(r[1].rankScore, 50);
    assert.equal(r[0].id, "z9");
  });

  test("계산식 값: 전부 만점이면 100, 항목값 확인", () => {
    const r = scoreCandidate(dict, req, c({ skills: ["Java", "Spring Boot", "Kafka"], vectorSim: 1 }), DEFAULT_EFFECTIVE_WEIGHTS, opts);
    assert.equal(r.rankScore, 100);
    assert.equal(r.analyzable, true);
    assert.equal(yearsItem(req, 10), 0.25); // 7 초과 3년 → 1-0.75
    assert.equal(yearsItem(req, 1), 0.5);
    assert.equal(yearsItem(req, null), 0.5);
    assert.equal(yearsItem({ years_min: null, years_max: null }, null), 1);
    assert.equal(activityItem("2026-09-01T00:00:00Z", NOW), 0.5);
    assert.equal(activityItem(null, NOW), 0.2);
  });

  test("벡터 단계 없을 때: vector 항목 제외 후 100점 환산, 순위는 계속 나온다", () => {
    const r = rankCandidates(dict, req, cands.map((x) => ({ ...x, vectorSim: null })), DEFAULT_EFFECTIVE_WEIGHTS, { vectorAvailable: false, now: NOW });
    assert.equal(r.length, 4);
    assert.deepEqual(r[0].breakdown.excluded, ["vector"]);
    const full = scoreCandidate(dict, req, c({ skills: ["Java", "Spring Boot", "Kafka"], vectorSim: null }), DEFAULT_EFFECTIVE_WEIGHTS, { vectorAvailable: false, now: NOW });
    assert.equal(full.rankScore, 100);
  });

  test("가중치 주입 반영: vector 가중치를 키우면 벡터 높은 후보가 올라간다, boost·version 기록", () => {
    const pair = [c({ id: "hiVec", skills: ["Java", "Spring Boot"], vectorSim: 1 }), c({ id: "hiNice", skills: ["Java", "Spring Boot", "Kafka"], vectorSim: 0 })];
    const base = rankCandidates(dict, req, pair, DEFAULT_EFFECTIVE_WEIGHTS, opts);
    assert.equal(base[0].id, "hiNice");
    const ew: EffectiveWeights = { weights: { ...DEFAULT_RANK_WEIGHTS, nice: 5, vector: 40 }, boost: { company: { vector: 0.2 } }, version: "7" };
    const tuned = rankCandidates(dict, req, pair, ew, opts);
    assert.equal(tuned[0].id, "hiVec");
    assert.deepEqual(tuned[0].breakdown.boost, { company: { vector: 0.2 } });
    assert.equal(tuned[0].breakdown.weightsVersion, "7");
  });

  test("rankingWeights 모듈이 없거나 실패하면 기본 가중치", async () => {
    assert.deepEqual(await loadEffectiveWeights({}, () => Promise.reject(new Error("ERR_MODULE_NOT_FOUND"))), DEFAULT_EFFECTIVE_WEIGHTS);
    assert.deepEqual(await loadEffectiveWeights({}, async () => ({})), DEFAULT_EFFECTIVE_WEIGHTS);
    const thrower = async () => ({ getEffectiveWeights: async () => { throw new Error("db down"); } });
    assert.deepEqual(await loadEffectiveWeights({}, thrower), DEFAULT_EFFECTIVE_WEIGHTS);
    const ew: EffectiveWeights = { weights: { ...DEFAULT_RANK_WEIGHTS, must: 50, activity: 0 }, boost: {}, version: "3" };
    let got: unknown;
    const ok = async () => ({ getEffectiveWeights: async (s: unknown) => ((got = s), ew) });
    assert.deepEqual(await loadEffectiveWeights({ companyId: "acme" }, ok), ew);
    assert.deepEqual(got, { companyId: "acme" });
  });
});

describe("리뷰 1라운드 공백 테스트", () => {
  test("yearsItem 경계", () => {
    const r = { years_min: 3, years_max: 7 };
    assert.equal(yearsItem(r, 3), 1);
    assert.equal(yearsItem(r, 7), 1);
    assert.equal(yearsItem(r, 2), 0.75);
    assert.equal(yearsItem(r, 11), 0);
    assert.equal(yearsItem(r, null), 0.5);
    assert.equal(yearsItem({ years_min: null, years_max: null }, 0), 1);
  });

  test("activityItem 30/90일 경계", () => {
    const ago = (d: number) => new Date(NOW - d * 86400000).toISOString();
    assert.equal(activityItem(ago(30), NOW), 1);
    assert.equal(activityItem(ago(31), NOW), 0.5);
    assert.equal(activityItem(ago(90), NOW), 0.5);
    assert.equal(activityItem(ago(91), NOW), 0.2);
    assert.equal(activityItem(null, NOW), 0.2);
    assert.equal(activityItem("garbage", NOW), 0.2);
  });

  test("계층 부분 일치 0.7 → 필수 충족(상한 없음), must=0.7", () => {
    const r = scoreCandidate(dict, { role: null, must_skills: ["React"], nice_skills: [], years_min: null, years_max: null }, c({ skills: ["Next.js"] }), DEFAULT_EFFECTIVE_WEIGHTS, opts);
    assert.equal(r.breakdown.items.must, 0.7);
    assert.equal(r.breakdown.mustUnmet, false);
    assert.deepEqual(r.missingMust, []);
  });

  test("빈 벡터 결과(vectorAvailable=false) → vector 제외", () => {
    const r = scoreCandidate(dict, req, c({ skills: ["Java", "Spring Boot"], vectorSim: null }), DEFAULT_EFFECTIVE_WEIGHTS, { vectorAvailable: false, now: NOW });
    assert.deepEqual(r.breakdown.excluded, ["vector"]);
    assert.ok(r.rankScore > 0);
  });
});
