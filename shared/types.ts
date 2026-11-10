export interface AgentResult {
  agent: "tech_stack" | "experience" | "culture_fit";
  score: number; // 0-100
  summary: string; // 1-2문장 평가 요약
  matched_items: string[]; // JD 요구사항 중 충족 항목
  missing_items: string[]; // JD 요구사항 중 미충족 항목
  evidence: string[]; // 포트폴리오에서 근거가 된 항목
  flags?: string[]; // 예: "low_confidence" — 재작업 루프를 통과 못한 경우
  citedCardIds?: string[]; // 근거로 인용한 공개 카드 id (validation 이 제공 카드 id 부분집합으로 강제)
  citedCards?: { id: string; trust: string }[]; // FitReport 까지 전달되는 근거 카드 id·trust
}

// public_evidence_cards 뷰에서 prune 된 에이전트 투입용 카드 (19 문서 6절)
export interface EvidenceCardInput {
  id: string;
  claim: string;
  trust: string;
  recorded_at: string | null;
  source: string | null;
}

// CEO가 재작업을 지시할 때 tool에 함께 전달하는 컨텍스트
export interface ReworkContext {
  previousResult: AgentResult;
  feedback: string; // 무엇이 잘못됐는지, 무엇을 재검토해야 하는지
}

export interface FitReport {
  candidateId: string;
  candidateName: string;
  overallScore: number; // 0-100, CEO 에이전트가 가중 평균/판단으로 산정
  verdict: "strong_fit" | "possible_fit" | "weak_fit";
  techStack: AgentResult;
  experience: AgentResult;
  cultureFit?: AgentResult; // Phase 4: 컬처핏 분석 (optional, 기존 리포트와 호환 유지)
  ceoSummary: string; // CEO 에이전트의 종합 코멘트
  generatedAt: string; // ISO timestamp
  review?: FitReview; // HIL 승인/거절 기록 (20 문서 C1 — 설명 책임)
  calibration?: FitCalibration; // 코드 점수 보정 결과 (orchestrator lib/calibrate.ts)
  hold?: FitHold; // 보류 — 판단을 미룬 후보. 상태는 검토 대기 그대로 두고 "미처리" 목록에서만 뺀다
}

/** 코드 점수 보정 기록 — 근거 등급 상한·근거 없는 충족 항목 이동 */
export interface FitCalibration {
  tier: "thin" | "basic" | "solid" | "rich";
  cap: number;
  rawScore: number; // 보정 전 CEO 점수
  movedItems: string[]; // 근거로 확인되지 않아 부족(면접 확인)으로 옮긴 충족 항목
  reasons: string[];
}

export interface FitHold {
  at: string;
  by: string | null;
}

export interface FitReview {
  decision: "approved" | "rejected";
  reason: string | null; // 거절 사유 칩 / 메모 (≤200자)
  decidedBy: string | null;
  decidedAt: string;
}

export interface CandidatePortfolio {
  id: string;
  name: string;
  role: "developer" | "designer";
  title: string | null;
  short_bio: string | null;
  long_bio: string | null;
  skills: string[];
  github_url: string | null;
  portfolio_url: string | null;
  evidence_cards?: EvidenceCardInput[]; // 공개 카드 뷰만, 후보당 상위 8장
  resume?: PublicResumeInput; // 공개 이력서 항목 + 공개 기본 자기소개서 (SQL 016 public_* 뷰, prune 후)
}

/** get_candidate_portfolio 가 LLM 에 넣는 공개 이력서 요약 (mcp-server lib/publicResume.ts 가 상한 적용) */
export interface PublicResumeInput {
  headline: string | null;
  region: string | null;
  desired_categories: string[];
  experiences: { company: string; position: string | null; period: string; duties: string | null; achievements: string | null }[];
  educations: { school: string; major: string | null; degree: string | null; status: string | null }[];
  certifications: string[];
  misc: { kind: string; title: string; description: string | null }[];
  cover_letter: { question: string; answer: string }[];
}

// 1차 검증(코드, 명백한 포맷/모순/환각만) 결과 — CEO 프롬프트에 함께 전달
export interface PreCheckResult {
  techValid: boolean;
  expValid: boolean;
  cultureValid: boolean;
  issues: string[];
  forced?: boolean; // maxAttempts 초과 후 강제 진행
}

// CEO(Claude Sonnet)의 submit_ceo_decision tool-use 결과
export interface CeoDecision {
  is_valid: boolean;
  target_departments: ("TECH" | "EXP" | "CULTURE")[]; // 재작업이 필요한 부서 목록. is_valid=true면 빈 배열.
  rejection_reason: string;
  final_report: {
    overallScore: number;
    verdict: "strong_fit" | "possible_fit" | "weak_fit";
    ceoSummary: string;
  };
}

export interface FitAnalysisJobData {
  jd: string;
  /** 건(jd_runs)의 jd_hash. 없으면 워커가 jd 로 계산한다 */
  jdHash?: string;
  candidateId: string;
  userId: string;
  tier: "paid" | "free";
}

// Phase 5: B2B 사내 소싱 — 인재 DB 조회용 가벼운 후보자 요약 (LLM 호출 없음)
export interface CandidateSourcingSummary {
  id: string;
  name: string;
  role: "developer" | "designer";
  title: string | null;
  skills: string[];
}

// sourcing_actions.status (jd-fit-analyzer 자체 Supabase)
export type SourcingActionStatus = "pending" | "approved" | "rejected" | "executed" | "failed";

/** Phase M2.6: Slack Card / Brief 페이지용 후보 요약 (FitReport에서 prune) */
export interface CandidateBriefCard {
  candidateId: string;
  name: string;
  overallScore: number;
  verdict: "strong_fit" | "possible_fit" | "weak_fit";
  techScore: number;
  experienceScore: number;
  matchedSkills: string[];
  ceoSummary: string;
  role?: "developer" | "designer";
  title?: string | null;
}

// Phase 5: Slack 알림 등 외부 액션의 입력 페이로드 — 실행 Pre HIL 승인 필요
export interface SlackNotifyPayload {
  channel: string;
  text: string;
  candidateIds?: string[];
  candidateNames?: string[];
  /** JD 자동 쇼트리스트 중복 방지용 (jd_analysis 시 설정) */
  jdHash?: string;
  jdHeadline?: string;
  /** Phase M2.6: Slack Block Kit Card/Carousel용 (있으면 mrkdwn 대신 리치 카드) */
  cards?: CandidateBriefCard[];
  /** Phase M4: Notion sync용 JD run 참조 */
  jdRunId?: string;
  autoSource?: "jd_analysis" | "jd_manual" | "manual" | "channel_invite" | "watch";
}

/** POST /api/sourcing/auto-from-jd 응답 */
export interface AutoSourcingResult {
  created: boolean;
  reason?: "no_strong_fit" | "no_selection" | "already_pending";
  action?: SourcingActionRecord;
  shortlist?: { candidateId: string; name: string; overallScore: number }[];
  approvalWarning?: string;
}

// sourcing_actions 테이블 row
export interface SourcingActionRecord {
  id: string;
  type: "slack_notify";
  payload: SlackNotifyPayload;
  status: SourcingActionStatus;
  result: Record<string, unknown> | null;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

// fit_reports.status (jd-fit-analyzer 자체 Supabase)
export type FitReportStatus =
  | "queued"
  | "processing"
  | "completed"
  | "pending_review"
  | "approved"
  | "rejected"
  | "expired"
  | "failed"; // 재시도 소진 후 영구 실패 (SQL 032)

// fit_reports 테이블 row
export interface FitReportRecord {
  id: string;
  jobId: string;
  jd: string;
  jdHash: string;
  candidateId: string;
  candidateName: string | null;
  userId: string;
  status: FitReportStatus;
  report: FitReport | null;
  createdAt: string;
  updatedAt: string;
}

// Phase 5 RAG: portfolio_chunks 테이블 row (jd-fit-analyzer 자체 Supabase)
export interface PortfolioChunk {
  id: string;
  candidateId: string;
  sourceField: string; // 'long_bio' | 'short_bio' | ...
  chunkIndex: number;
  content: string;
  contentHash: string;
  similarity?: number; // 검색 결과에서만 채워짐 (cosine similarity)
}

// 포트폴리오 채팅 — 검색 근거 + 답변
export interface PortfolioChatAnswer {
  answer: string;
  cited_chunk_ids: string[];
}

export interface PortfolioChatJobData {
  candidateId: string;
  question: string;
}

// ── Phase M4: Notion OAuth + JD run / assessment 레이어 ─────────────────────

export type JdRunStatus = "draft" | "analyzed" | "shortlisted" | "synced";

/** Notion DB 컬럼명 매핑 (사용자 DB 스키마에 맞게 PATCH 가능) */
export interface NotionPropertyMapping {
  name: string;
  overallScore: string;
  verdict: string;
  ceoSummary: string;
  matchedSkills: string;
  talentfolioLink: string;
  externalId: string;
}

export const DEFAULT_NOTION_PROPERTY_MAPPING: NotionPropertyMapping = {
  name: "Name",
  overallScore: "Score",
  verdict: "Verdict",
  ceoSummary: "CEO Summary",
  matchedSkills: "Matched Skills",
  talentfolioLink: "TalentFolio",
  externalId: "External ID",
};

export interface NotionIntegrationRecord {
  id: string;
  userId: string;
  workspaceId: string | null;
  workspaceName: string | null;
  botId: string | null;
  dataSourceId: string | null;
  propertyMapping: NotionPropertyMapping;
  createdAt: string;
  updatedAt: string;
}

/** API 응답용 — 토큰 제외 */
export interface NotionIntegrationPublic {
  connected: boolean;
  workspaceName: string | null;
  dataSourceId: string | null;
  propertyMapping: NotionPropertyMapping;
}

export interface JdRunRecord {
  id: string;
  userId: string;
  jdHash: string;
  jdText: string;
  planSnapshot: Record<string, unknown> | null;
  status: JdRunStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CandidateAssessmentRecord {
  id: string;
  jdRunId: string;
  candidateId: string;
  candidateName: string | null;
  overallScore: number;
  verdict: FitReport["verdict"];
  matchedSkills: string[];
  missingSkills: string[];
  ceoSummary: string | null;
  techSummary: string | null;
  experienceSummary: string | null;
  fitReportId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotionSyncRecord {
  id: string;
  userId: string;
  candidateId: string;
  jdRunId: string;
  notionPageId: string;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface NotionSyncResult {
  synced: number;
  failed: number;
  pages: { candidateId: string; notionPageId: string; created: boolean }[];
  errors?: string[];
}
