import type { KeyDictionary } from "../../../shared/lib/pruneJsonData.js";

export const PORTFOLIO_KEY_DICTIONARY: KeyDictionary = {
  portfolio_url: ["portfolioUrl", "portfolio_link", "website_url"],
  github_url: ["githubUrl", "github_link"],
  short_bio: ["shortBio", "bio_short", "tagline"],
  long_bio: ["longBio", "bio", "description"],
};

// Gemini wire schema(techAgentSchema/expAgentSchema/cultureAgentSchema) -> AgentResult 내부 표준 계약 매핑
export const AGENT_RESULT_KEY_DICTIONARY: KeyDictionary = {
  score: ["tech_score", "exp_score", "culture_score"],
  summary: ["analysis_reason"],
  matched_items: ["matched_stacks", "matched_experiences", "matched_values"],
  missing_items: ["missing_stacks", "missing_experiences", "missing_values"],
};
