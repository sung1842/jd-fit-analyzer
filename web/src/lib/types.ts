// orchestrator(/shared/types.ts)와 동일한 형태를 유지하는 web용 타입 정의

export interface AgentResult {
  agent: "tech_stack" | "experience" | "culture_fit";
  score: number;
  summary: string;
  matched_items: string[];
  missing_items: string[];
  evidence: string[];
  flags?: string[];
}

export interface FitReport {
  candidateId: string;
  candidateName: string;
  overallScore: number;
  verdict: "strong_fit" | "possible_fit" | "weak_fit";
  techStack: AgentResult;
  experience: AgentResult;
  cultureFit?: AgentResult;
  ceoSummary: string;
  generatedAt: string;
}

export type FitReportStatus =
  | "queued"
  | "processing"
  | "completed"
  | "pending_review"
  | "approved"
  | "rejected"
  | "expired";

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

export interface CandidateSummary {
  id: string;
  name: string;
  role: "developer" | "designer";
  title: string | null;
}

/** GET /api/job-postings — 크롤러가 적재한 채용공고 (fit.job_postings) */
export interface JobPostingSummary {
  id: string;
  source: string;
  externalId: string;
  url: string | null;
  company: string | null;
  title: string;
  description: string | null;
  skills: string[];
  location: string | null;
  employmentType: string | null;
  experienceLevel: string | null;
  postedAt: string | null;
  expiresAt: string | null;
}

/** GET /api/job-postings — 크롤러가 적재한 채용공고 (fit.job_postings) */
export interface JobPostingSummary {
  id: string;
  source: string;
  externalId: string;
  url: string | null;
  company: string | null;
  title: string;
  description: string | null;
  skills: string[];
  location: string | null;
  employmentType: string | null;
  experienceLevel: string | null;
  postedAt: string | null;
  expiresAt: string | null;
}

export interface PortfolioChunk {
  id: string;
  candidateId: string;
  sourceField: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  similarity?: number;
}

export interface PortfolioChatResult {
  answer: string;
  cited_chunk_ids: string[];
  citedChunks: PortfolioChunk[];
}

// Phase 5: B2B 사내 소싱
export interface CandidateSourcingSummary {
  id: string;
  name: string;
  role: "developer" | "designer";
  title: string | null;
  skills: string[];
}

export type SourcingActionStatus = "pending" | "approved" | "rejected" | "executed" | "failed";

export interface SlackNotifyPayload {
  channel: string;
  text: string;
  candidateIds?: string[];
  candidateNames?: string[];
}

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
