import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { CandidatePortfolio } from "../../shared/types.js";
import { cleanText, coreKey, cosine, decideBeforeLlm, hashes, mapSkills, MATCH_NORM_VERSION, NARRATIVE_SAME_THRESHOLD, parseVector } from "../src/lib/candidateNorm.js";
import { SkillDictionary } from "../src/lib/skillDictionary.js";
import { SKILL_SEED } from "../src/lib/skillSeed.js";

const base: CandidatePortfolio = {
  id: "c1",
  name: "홍길동",
  role: "developer",
  title: "백엔드 개발자",
  short_bio: "결제 서버를 만듭니다.",
  long_bio: "Node.js 로 결제 시스템을 3년간 운영했고 장애 대응을 맡았습니다.",
  skills: ["Node.js", "PostgreSQL"],
  github_url: null,
  portfolio_url: null,
};

describe("후보 변경 감지 (22 문서 E2)", () => {
  test("T3 공백·대소문자·줄바꿈만 바뀌면 해시가 같다", () => {
    const edited = { ...base, long_bio: "  node.js 로   결제 시스템을\n3년간 운영했고 장애 대응을 맡았습니다. ", skills: ["PostgreSQL", "Node.js"] };
    assert.deepEqual(hashes(edited), hashes(base));
  });

  test("링크·이름처럼 매칭과 무관한 필드는 해시에 영향 없음", () => {
    assert.deepEqual(hashes({ ...base, name: "김철수", github_url: "https://github.com/x" }), hashes(base));
  });

  test("자유 서술만 바뀌면 fields_hash 는 같고 source_hash 는 다르다 → 의미 비교로", () => {
    const rewritten = { ...base, long_bio: "3년 동안 Node.js 기반 결제 플랫폼을 운영하며 장애 대응을 담당했습니다." };
    const a = hashes(base);
    const b = hashes(rewritten);
    assert.equal(b.fieldsHash, a.fieldsHash);
    assert.notEqual(b.sourceHash, a.sourceHash);
    const prev = { source_hash: a.sourceHash, fields_hash: a.fieldsHash, norm_version: MATCH_NORM_VERSION, narrative_embedding: "[1,0,0]" };
    assert.deepEqual(decideBeforeLlm(prev, b), { stop: "check_meaning" });
    assert.deepEqual(decideBeforeLlm(prev, a), { stop: "same_hash" });
  });

  test("기술 칸이 바뀌면 LLM 정규화로 직행", () => {
    const a = hashes(base);
    const prev = { source_hash: a.sourceHash, fields_hash: a.fieldsHash, norm_version: MATCH_NORM_VERSION, narrative_embedding: "[1,0,0]" };
    assert.deepEqual(decideBeforeLlm(prev, hashes({ ...base, skills: [...base.skills, "Redis"] })), { stop: "normalize" });
  });

  test("처음 보는 후보·버전 변경·지문 없음은 정규화", () => {
    const a = hashes(base);
    assert.deepEqual(decideBeforeLlm(null, a), { stop: "normalize" });
    assert.deepEqual(decideBeforeLlm({ source_hash: "x", fields_hash: a.fieldsHash, norm_version: MATCH_NORM_VERSION + 1, narrative_embedding: "[1]" }, a), { stop: "normalize" });
    assert.deepEqual(decideBeforeLlm({ source_hash: "x", fields_hash: a.fieldsHash, norm_version: MATCH_NORM_VERSION, narrative_embedding: null }, a), { stop: "normalize" });
  });

  test("T4 의미 지문: 거의 같은 벡터는 문턱 이상, 다른 벡터는 미만", () => {
    const v = [0.2, 0.5, 0.1, 0.7];
    const paraphrase = [0.21, 0.49, 0.11, 0.69];
    const different = [0.7, -0.1, 0.6, 0.0];
    assert.ok(cosine(v, paraphrase) >= NARRATIVE_SAME_THRESHOLD);
    assert.ok(cosine(v, different) < NARRATIVE_SAME_THRESHOLD);
    assert.deepEqual(parseVector("[0.2,0.5]"), [0.2, 0.5]);
    assert.equal(parseVector("bad"), null);
  });

  test("정규화 결과 비교: 순서·0.5년 미만 흔들림·태그 대소문자는 같은 결과", () => {
    const a = { roles: ["backend", "fullstack"], skills: [{ name: "Node.js", years: 3, professional: true }], total_years: 3.1, tags: ["장애 대응", "Payments"] };
    const b = { roles: ["fullstack", "backend"], skills: [{ name: "Node.js", years: 3.2, professional: true }], total_years: 3, tags: ["payments", "장애 대응"] };
    assert.equal(coreKey(a), coreKey(b));
    assert.notEqual(coreKey(a), coreKey({ ...b, skills: [...b.skills, { name: "Redis", years: 1, professional: false }] }));
  });

  test("기술명 사전 매핑: 동의어 병합, 미매핑 분리", () => {
    const dict = new SkillDictionary(SKILL_SEED);
    const r = mapSkills(dict, [
      { name: "node", years: 2, professional: false },
      { name: "Node.js", years: 3, professional: true },
      { name: "Zustand", years: 1, professional: false },
    ]);
    assert.deepEqual(r.skills, [{ name: "Node.js", years: 3, professional: true }]);
    assert.deepEqual(r.unmapped, ["Zustand"]);
    assert.equal(cleanText("  A  B "), "a b");
  });
});

// T10 디바운스: 실제 Redis 필요 (NORMALIZE_QUEUE_TEST=1). 테스트 후보 id 로만 잡을 만들고 지운다.
describe("정규화 큐 디바운스 (Redis)", { skip: process.env.NORMALIZE_QUEUE_TEST !== "1" }, () => {
  const id = `test-debounce-${Date.now()}`;
  after(async () => {
    const { getNormalizeQueue, closeNormalizeQueue } = await import("../src/queue/normalizeQueue.js");
    const q = getNormalizeQueue();
    for (const job of await q.getDelayed()) if (job.data.kind === "normalize" && job.data.candidateId === id) await job.remove();
    await q.removeDeduplicationKey(`norm_${id}`);
    await closeNormalizeQueue();
    const { redis } = await import("../src/lib/redis.js");
    redis.disconnect();
  });

  test("T10 같은 후보 5회 수정 → 지연 잡 1개", async () => {
    const { enqueueNormalize, getNormalizeQueue } = await import("../src/queue/normalizeQueue.js");
    for (let i = 0; i < 5; i++) await enqueueNormalize(id, { delayMs: 60_000 });
    const mine = (await getNormalizeQueue().getDelayed()).filter((j) => j.data.kind === "normalize" && j.data.candidateId === id);
    assert.equal(mine.length, 1);
  });
});
