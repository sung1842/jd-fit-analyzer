import { z } from "zod";

export const CandidatePortfolioSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(["developer", "designer"]),
  title: z.string().nullable(),
  short_bio: z.string().nullable(),
  long_bio: z.string().nullable(),
  skills: z.array(z.string()),
  github_url: z.string().nullable(),
  portfolio_url: z.string().nullable(),
  evidence_cards: z
    .array(
      z.object({
        id: z.string(),
        claim: z.string(),
        trust: z.string(),
        recorded_at: z.string().nullable(),
        source: z.string().nullable(),
      })
    )
    .optional(),
  // 공개 이력서 요약 (lib/publicResume.ts). 없으면 생략
  resume: z
    .object({
      headline: z.string().nullable(),
      region: z.string().nullable(),
      desired_categories: z.array(z.string()),
      experiences: z.array(z.object({ company: z.string(), position: z.string().nullable(), period: z.string(), duties: z.string().nullable(), achievements: z.string().nullable() })),
      educations: z.array(z.object({ school: z.string(), major: z.string().nullable(), degree: z.string().nullable(), status: z.string().nullable() })),
      certifications: z.array(z.string()),
      misc: z.array(z.object({ kind: z.string(), title: z.string(), description: z.string().nullable() })),
      cover_letter: z.array(z.object({ question: z.string(), answer: z.string() })),
    })
    .optional(),
});

export const AgentResultSchema = z.object({
  agent: z.enum(["tech_stack", "experience", "culture_fit"]),
  score: z.number(),
  summary: z.string(),
  matched_items: z.array(z.string()),
  missing_items: z.array(z.string()),
  evidence: z.array(z.string()),
  flags: z.array(z.string()).optional(),
  citedCardIds: z.array(z.string()).optional(),
  citedCards: z.array(z.object({ id: z.string(), trust: z.string() })).optional(),
});

export const ReworkContextSchema = z.object({
  previousResult: AgentResultSchema,
  feedback: z.string(),
});

export const PortfolioChunkSchema = z.object({
  id: z.string(),
  candidateId: z.string(),
  sourceField: z.string(),
  chunkIndex: z.number(),
  content: z.string(),
  contentHash: z.string(),
  similarity: z.number().optional(),
});
