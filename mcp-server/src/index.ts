import "./lib/env.js";
import "./lib/langfuse.js"; // Gemini 호출 트레이싱 — 다른 모듈보다 먼저 초기화되어야 함
import { randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PortfolioChunkSchema, CandidatePortfolioSchema, ReworkContextSchema } from "./lib/schemas.js";
import { analyzeCultureFit } from "./tools/analyzeCultureFit.js";
import { analyzeExperience } from "./tools/analyzeExperience.js";
import { analyzeTechStack } from "./tools/analyzeTechStack.js";
import { answerPortfolioQuestion } from "./tools/answerPortfolioQuestion.js";
import { embedAndIndexPortfolio, embedEvidenceCard } from "./tools/embedAndIndexPortfolio.js";
import { getCandidatePortfolio } from "./tools/getCandidatePortfolio.js";
import { notifySlack, notifySlackApproval, updateSlackDecision } from "./tools/notifySlack.js";
import { parseJd } from "./tools/parseJd.js";
import { normalizeCandidate } from "./tools/normalizeCandidate.js";
import { normalizeJob } from "./tools/normalizeJob.js";
import { embedTexts } from "./lib/gemini.js";
import { searchCandidates } from "./tools/searchCandidates.js";
import { searchPortfolioChunks } from "./tools/searchPortfolioChunks.js";
import { syncCandidatesToNotion } from "./tools/syncNotion.js";
import { compressJd } from "./lib/jdCompress.js";

const CandidateBriefCardSchema = z.object({
  candidateId: z.string(),
  name: z.string(),
  overallScore: z.number(),
  verdict: z.enum(["strong_fit", "possible_fit", "weak_fit"]),
  techScore: z.number(),
  experienceScore: z.number(),
  matchedSkills: z.array(z.string()),
  ceoSummary: z.string(),
  role: z.enum(["developer", "designer"]).optional(),
  title: z.string().nullable().optional(),
});

// Phase 4: stdio(child process spawn) -> HTTP/SSE(Streamable HTTP) 전환
// mcp-server는 독립 프로세스로 기동되고, orchestrator는 HTTP 클라이언트로 연결한다.
function createMcpServer(): McpServer {
  const server = new McpServer({ name: "jd-fit-mcp-server", version: "0.1.0" });

  server.registerTool(
    "get_candidate_portfolio",
    {
      description: "talentfolio Supabase profiles 테이블에서 후보자 포트폴리오를 조회한다 (LLM 호출 없음).",
      inputSchema: { candidateId: z.string() },
    },
    async ({ candidateId }) => {
      const portfolio = await getCandidatePortfolio(candidateId);
      return { content: [{ type: "text", text: JSON.stringify(portfolio) }] };
    }
  );

  server.registerTool(
    "analyze_tech_stack",
    {
      description:
        "JD가 요구하는 기술 스택을 추출해 후보자 포트폴리오(skills, long_bio)와 비교, 기술 스택 적합도(AgentResult)를 평가한다 (Gemini Flash).",
      inputSchema: {
        jd: z.string(),
        portfolio: CandidatePortfolioSchema,
        rework: ReworkContextSchema.optional(),
      },
    },
    async ({ jd, portfolio, rework }) => {
      const result = await analyzeTechStack(jd, portfolio, rework);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "analyze_experience",
    {
      description:
        "JD의 직무 경험/트러블슈팅 요구사항과 후보자 포트폴리오(long_bio)를 비교, 경험 적합도(AgentResult)를 평가한다 (Gemini Flash).",
      inputSchema: {
        jd: z.string(),
        portfolio: CandidatePortfolioSchema,
        rework: ReworkContextSchema.optional(),
      },
    },
    async ({ jd, portfolio, rework }) => {
      const result = await analyzeExperience(jd, portfolio, rework);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "analyze_culture_fit",
    {
      description:
        "JD에 드러난 조직문화/협업 방식 요구사항과 후보자 포트폴리오(short_bio, long_bio)를 비교, 컬처핏 적합도(AgentResult)를 평가한다 (Gemini Flash).",
      inputSchema: {
        jd: z.string(),
        portfolio: CandidatePortfolioSchema,
        rework: ReworkContextSchema.optional(),
      },
    },
    async ({ jd, portfolio, rework }) => {
      const result = await analyzeCultureFit(jd, portfolio, rework);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "embed_and_index_portfolio",
    {
      description:
        "Phase 5 RAG: 후보자 포트폴리오(short_bio/long_bio)를 청크로 분할해 임베딩 후 portfolio_chunks에 저장한다 (변경된 청크만 재임베딩).",
      inputSchema: { candidateId: z.string() },
    },
    async ({ candidateId }) => {
      const result = await embedAndIndexPortfolio(candidateId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "embed_evidence_card",
    {
      description:
        "라이프 로그: 공개 근거 카드(public_evidence_cards 뷰) 1장을 임베딩해 portfolio_chunks(source_field=evidence_card:<id>)에 저장한다. 뷰에 없으면 청크 삭제.",
      inputSchema: { candidateId: z.string(), cardId: z.string() },
    },
    async ({ candidateId, cardId }) => {
      const result = await embedEvidenceCard(candidateId, cardId);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "search_portfolio_chunks",
    {
      description: "Phase 5 RAG: 질문을 임베딩해 후보자의 portfolio_chunks 중 cosine similarity 상위 topK개를 검색한다.",
      inputSchema: { candidateId: z.string(), query: z.string(), topK: z.number().int().positive().default(5) },
    },
    async ({ candidateId, query, topK }) => {
      const chunks = await searchPortfolioChunks(candidateId, query, topK);
      return { content: [{ type: "text", text: JSON.stringify(chunks) }] };
    }
  );

  server.registerTool(
    "answer_portfolio_question",
    {
      description:
        "Phase 5 RAG: search_portfolio_chunks가 반환한 근거 청크만 사용해 질문에 답하고, 실제로 인용한 청크 id 목록을 반환한다 (Gemini Flash).",
      inputSchema: { question: z.string(), chunks: z.array(PortfolioChunkSchema) },
    },
    async ({ question, chunks }) => {
      const result = await answerPortfolioQuestion(question, chunks);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "search_candidates",
    {
      description:
        "Phase 5 B2B 소싱: talentfolio profiles에서 이름/직함/기술 스택 키워드와 역할(role)로 후보자를 검색한다 (LLM 호출 없음, 읽기 전용).",
      inputSchema: { query: z.string().optional(), role: z.enum(["developer", "designer"]).optional() },
    },
    async ({ query, role }) => {
      const candidates = await searchCandidates(query, role);
      return { content: [{ type: "text", text: JSON.stringify(candidates) }] };
    }
  );

  server.registerTool(
    "parse_jd",
    {
      description:
        "Phase M1: 채용공고(JD)에서 모집 직군(developer/designer)과 핵심 기술 키워드를 추출한다 (Gemini Flash 1회). 비싼 정밀 분석 전, 코드 기반 사전 필터링의 입력으로 사용한다.",
      inputSchema: { jd: z.string() },
    },
    async ({ jd }) => {
      const result = await parseJd(jd);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "normalize_candidate",
    {
      description:
        "22 문서 E2: 후보 포트폴리오(prune 결과)를 정해진 칸(roles·skills·total_years·tags·prefs)으로 정규화한다 (Gemini Flash 1회). 등록·수정 시 1회만, 결과는 orchestrator 가 저장해 재사용.",
      inputSchema: { portfolio: CandidatePortfolioSchema },
    },
    async ({ portfolio }) => {
      const result = await normalizeCandidate(portfolio);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "normalize_job",
    {
      description:
        "22 문서 E3: JD 를 직무(후보와 같은 enum)·필수/우대 기술·경력 범위·근무지로 정규화한다 (Gemini Flash 1회). orchestrator 가 jd 해시로 캐시.",
      inputSchema: { jd: z.string().min(1).max(30000) },
    },
    async ({ jd }) => {
      const result = await normalizeJob(jd);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "embed_texts",
    {
      description: "22 문서 E2: 텍스트를 768차원 임베딩으로 변환한다 (gemini-embedding-001). 변경 감지 의미 지문·후보 검색 벡터용.",
      inputSchema: { texts: z.array(z.string().min(1).max(8000)).min(1).max(8) },
    },
    async ({ texts }) => {
      const vectors = await embedTexts(texts);
      return { content: [{ type: "text", text: JSON.stringify(vectors) }] };
    }
  );

  server.registerTool(
    "notify_slack",
    {
      description:
        "Phase 5/M2.6 B2B 소싱: Slack 채널에 메시지를 전송한다 (LLM 호출 없음). cards가 있으면 Block Kit Card/Carousel로 전송한다. HIL 승인 후에만 호출.",
      inputSchema: {
        channel: z.string(),
        text: z.string(),
        cards: z.array(CandidateBriefCardSchema).optional(),
        jdHeadline: z.string().optional(),
        jdHash: z.string().optional(),
      },
    },
    async ({ channel, text, cards, jdHeadline, jdHash }) => {
      const result = await notifySlack(channel, text, cards, jdHeadline, jdHash);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "notify_slack_approval",
    {
      description:
        "Phase M2/M2.6 HIL: 승인 버튼(✅승인/❌거절) + (선택) 쇼트리스트 Carousel Block Kit 메시지를 Slack 채널에 전송한다.",
      inputSchema: {
        actionId: z.string(),
        channel: z.string(),
        text: z.string(),
        candidateNames: z.array(z.string()).optional(),
        cards: z.array(CandidateBriefCardSchema).optional(),
        jdHeadline: z.string().optional(),
        jdHash: z.string().optional(),
      },
    },
    async ({ actionId, channel, text, candidateNames, cards, jdHeadline, jdHash }) => {
      const result = await notifySlackApproval(
        actionId,
        channel,
        text,
        candidateNames,
        cards,
        jdHeadline,
        jdHash
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "update_slack_decision",
    {
      description:
        "Phase M2/M2.6 HIL: 이미 발송된 승인 요청 메시지(ts)를 결정 결과로 갱신한다 (chat.update, 버튼 제거).",
      inputSchema: {
        channel: z.string(),
        ts: z.string(),
        text: z.string(),
        status: z.enum(["executed", "rejected", "failed"]),
        decidedBy: z.string().optional(),
        cards: z.array(CandidateBriefCardSchema).optional(),
        jdHash: z.string().optional(),
      },
    },
    async ({ channel, ts, text, status, decidedBy, cards, jdHash }) => {
      const result = await updateSlackDecision(channel, ts, text, status, decidedBy, cards, jdHash);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "sync_candidates_to_notion",
    {
      description:
        "Phase M4: candidate_assessments를 리크루터 개인 Notion DB(data_source_id)에 upsert한다 (LLM 호출 없음). External ID로 중복 방지.",
      inputSchema: {
        userId: z.string(),
        jdRunId: z.string(),
        candidateIds: z.array(z.string()),
      },
    },
    async ({ userId, jdRunId, candidateIds }) => {
      const result = await syncCandidatesToNotion({ userId, jdRunId, candidateIds });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "compress_jd",
    {
      description:
        "크롤한 공고 1건의 본문 목록(주요업무·자격·우대·미분류)을 구조화 배열(key_duties/must_have/nice_to_have/skills/role_summary)로 정리한다 (Gemini Flash). 크롤 검수 수집 잡 전용.",
      inputSchema: {
        title: z.string().max(300),
        company: z.string().max(200),
        key_duties: z.array(z.string()).max(80),
        must_have: z.array(z.string()).max(80),
        nice_to_have: z.array(z.string()).max(80),
        unclassified: z.array(z.string()).max(120),
      },
    },
    async ({ title, company, key_duties, must_have, nice_to_have, unclassified }) => {
      const result = await compressJd({ title, company, lists: { key_duties, must_have, nice_to_have, unclassified } });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// 내부 서비스 간 인증 — orchestrator 만 호출한다. MCP_INTERNAL_KEY 가 설정되면 x-internal-key 불일치 요청을 거부한다.
// 프로덕션에서 미설정이면 기동 자체를 막는다 (무인증 LLM 호출 엔드포인트가 열리는 것을 방지).
const MCP_INTERNAL_KEY = process.env.MCP_INTERNAL_KEY;
if (!MCP_INTERNAL_KEY) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("MCP_INTERNAL_KEY 가 없습니다. 프로덕션에서는 내부 키 없이 mcp-server 를 띄울 수 없습니다.");
  }
  console.warn("[mcp-server] MCP_INTERNAL_KEY 미설정 — 내부 키 검증 없이 동작합니다 (개발 환경에서만 허용).");
}
app.use("/mcp", (req, res, next) => {
  if (!MCP_INTERNAL_KEY) return next();
  const provided = req.header("x-internal-key") ?? "";
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(MCP_INTERNAL_KEY, "utf8");
  if (a.length === b.length && timingSafeEqual(a, b)) return next();
  res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: invalid internal key" }, id: null });
});

// 세션 ID(mcp-session-id) -> transport. 세션은 orchestrator 워커 프로세스당 1개씩만 생성된다.
const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };

    const server = createMcpServer();
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// 서버 -> 클라이언트 알림용 SSE 스트림 (GET) / 세션 종료 (DELETE)
async function handleSessionRequest(req: express.Request, res: express.Response) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
}

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

const PORT = process.env.MCP_SERVER_PORT ? Number(process.env.MCP_SERVER_PORT) : 3002;
app.listen(PORT, () => {
  console.log(`mcp-server (Streamable HTTP) listening on http://localhost:${PORT}/mcp`);
});
