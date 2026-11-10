/**
 * 점수 보정(calibrate.ts) 테스트 — 2026-11-10 한도윤 건(태그·소개 두 문장으로 72점) 재현.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentResult, CandidatePortfolio, FitReport } from "../../shared/types.js";
import { calibrateReport, evidenceHaystack, evidenceTier, isSupported } from "../src/lib/calibrate.js";

const thin: CandidatePortfolio = {
  id: "c1", name: "한도윤", role: "developer", title: "백엔드 개발자",
  short_bio: "신입 백엔드 개발자, Java, Spring Boot, JPA 중심",
  long_bio: "Java·Spring Boot를 주력으로 부트캠프와 개인 프로젝트로 준비했습니다. 팀 프로젝트에서 기획부터 배포까지 맡았습니다.",
  skills: ["Java", "Spring Boot", "JPA", "MySQL", "PostgreSQL", "Jenkins"],
  github_url: null, portfolio_url: null, evidence_cards: [],
};
const agent = (a: AgentResult["agent"], score: number, matched: string[], missing: string[]): AgentResult => ({ agent: a, score, summary: "", matched_items: matched, missing_items: missing, evidence: [] });

const report: FitReport = {
  candidateId: "c1", candidateName: "한도윤", overallScore: 72, verdict: "possible_fit", ceoSummary: "", generatedAt: "",
  techStack: agent("tech_stack", 70, ["Java", "Spring Boot", "JPA", "RESTful API", "관계형 데이터베이스", "Linux", "Git"], ["Spring Cloud", "Docker", "AI 코딩 도구", "컨테이너 기반 배포 및 CI/CD 파이프라인 운영·개선"]),
  experience: agent("experience", 75,
    ["Java·Spring Boot·JPA를 활용한 웹 애플리케이션 개발 경험", "RESTful API 설계 및 개발 경험", "관계형 데이터베이스(Oracle, MariaDB, PostgreSQL 등) 사용 경험", "Linux 환경에서의 서버 운영 및 배포 경험", "Git 기반 형상 관리 및 코드 리뷰 협업 경험"],
    ["대용량 데이터 수집 및 처리 성능 최적화", "Spring Cloud 기반 MSA 설계·개발 경험", "Docker 등 컨테이너 환경 활용 및 배포 경험", "CI/CD 환경 구축 및 운영 경험", "쿼리 최적화·인덱스 튜닝", "AI 코딩 도구 활용", "프론트엔드 협업", "컨테이너 기반 배포"]),
  cultureFit: agent("culture_fit", 70, ["Git 기반 형상 관리 및 코드 리뷰 협업 경험"], ["대용량 데이터", "CI/CD", "프론트엔드 협업", "AI 코딩 도구"]),
};

describe("calibrate", () => {
  test("태그·짧은 소개뿐이면 thin 등급", () => {
    assert.equal(evidenceTier(thin), "thin");
    assert.equal(evidenceTier({ ...thin, evidence_cards: [{ id: "a", claim: "x", trust: "self", recorded_at: null, source: null }] }), "basic");
  });

  test("근거 없는 충족 항목 판별", () => {
    const hay = evidenceHaystack(thin);
    assert.ok(isSupported("Java", hay));
    assert.ok(isSupported("관계형 데이터베이스", hay)); // MySQL·PostgreSQL 이 받친다
    assert.ok(!isSupported("RESTful API", hay));
    assert.ok(!isSupported("Linux", hay));
    assert.ok(!isSupported("Git", hay));
    assert.ok(!isSupported("Linux 환경에서의 서버 운영 및 배포 경험", hay));
  });

  test("한도윤 건: 72 → 50 이하, 근거 없는 항목은 면접 확인으로", () => {
    const out = calibrateReport(report, thin);
    assert.ok(out.overallScore <= 50, `got ${out.overallScore}`);
    assert.ok(!out.techStack.matched_items.includes("RESTful API"));
    assert.ok(out.techStack.missing_items.includes("Linux"));
    assert.ok(out.experience.score <= 60);
    assert.equal(out.calibration?.tier, "thin");
    assert.equal(out.calibration?.rawScore, 72);
    assert.ok(out.calibration!.movedItems.length >= 3);
  });

  test("점수는 올리지 않는다", () => {
    const low = { ...report, overallScore: 20 };
    assert.ok(calibrateReport(low, thin).overallScore <= 20);
  });
});
