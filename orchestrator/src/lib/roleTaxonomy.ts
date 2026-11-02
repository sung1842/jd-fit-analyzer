import { db } from "./db.js";

/**
 * 직무 분류·인접도 (22 문서 E3, SQL 021 fit.role_taxonomy). 백엔드 공고 ↔ 풀스택 후보처럼 글자가 달라도 맞는 직무를 코드로 잇는다.
 * 관계는 대칭으로 취급한다. DB 행이 같은 쌍의 코드 시드를 덮어쓴다. 테이블이 없으면 시드만 쓴다.
 * 역할 이름은 mcp-server tools/normalizeCandidate.ts CANDIDATE_ROLES 와 같다.
 */
export const ROLE_MATCH_MIN = 0.5; // 이 인접도 이상이면 A 단계 통과

export interface RoleEdge {
  role: string;
  related: string;
  affinity: number;
}

export const ROLE_SEED: RoleEdge[] = [
  { role: "backend", related: "fullstack", affinity: 0.8 },
  { role: "frontend", related: "fullstack", affinity: 0.8 },
  { role: "mobile", related: "frontend", affinity: 0.5 },
  { role: "mobile", related: "fullstack", affinity: 0.5 },
  { role: "devops", related: "backend", affinity: 0.5 },
  { role: "data", related: "backend", affinity: 0.5 },
  { role: "data", related: "ai_ml", affinity: 0.7 },
  { role: "ai_ml", related: "backend", affinity: 0.5 },
  { role: "embedded", related: "backend", affinity: 0.3 },
  { role: "game", related: "frontend", affinity: 0.3 },
  { role: "ui_design", related: "ux_design", affinity: 0.7 },
  { role: "ui_design", related: "product_design", affinity: 0.8 },
  { role: "ux_design", related: "product_design", affinity: 0.8 },
  { role: "graphic_design", related: "ui_design", affinity: 0.5 },
];

export class RoleTaxonomy {
  private readonly edges = new Map<string, number>();

  constructor(list: RoleEdge[]) {
    for (const e of list) {
      this.edges.set(`${e.role}|${e.related}`, e.affinity);
      this.edges.set(`${e.related}|${e.role}`, e.affinity);
    }
  }

  affinity(a: string, b: string): number {
    return a === b ? 1 : (this.edges.get(`${a}|${b}`) ?? 0);
  }

  /** 후보가 가진 역할 중 공고 역할과 가장 가까운 값 */
  best(jobRole: string, candidateRoles: string[]): number {
    return candidateRoles.reduce((m, r) => Math.max(m, this.affinity(jobRole, r)), 0);
  }
}

const CACHE_TTL_MS = 10 * 60 * 1000;
let cached: { tax: RoleTaxonomy; at: number } | null = null;

export async function getRoleTaxonomy(): Promise<RoleTaxonomy> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.tax;
  let rows: RoleEdge[] = [];
  try {
    const { data, error } = await db.from("role_taxonomy").select("role, related, affinity");
    if (!error && data) rows = (data as RoleEdge[]).map((r) => ({ ...r, affinity: Number(r.affinity) }));
  } catch {
    // 시드로 계속
  }
  // 생성자가 뒤 항목으로 덮어쓰므로 DB 행을 뒤에 둔다
  const tax = new RoleTaxonomy([...ROLE_SEED, ...rows]);
  cached = { tax, at: Date.now() };
  return tax;
}
