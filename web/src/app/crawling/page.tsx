"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ORCHESTRATOR_URL } from "@/lib/api";

// 크롤 검수 (SQL 013). 비밀번호는 서버(.env.local CRAWL_ADMIN_PASSWORD)와 비교하고, 이 탭에만 보관한다(sessionStorage).
const PW_KEY = "crawl-admin-password";

type Tab = "exceptions" | "sample" | "all";
type RejectReason = "ad" | "irrelevant" | "broken" | "duplicate" | "other";

interface Batch {
  batchId: string;
  total: number;
  counts: Record<string, number>;
  sampleTotal: number;
  samplePending: number;
  prepared: boolean;
}

interface Posting {
  title: string;
  company: string | null;
  role_summary: string | null;
  key_duties: string[];
  must_have: string[];
  nice_to_have: string[];
  skills: string[];
}

interface Row extends Posting {
  id: string;
  url: string;
  job_posting_id: string | null;
  career_text: string | null;
  employment_type_text: string | null;
  salary_text: string | null;
  location_text: string | null;
  deadline_text: string | null;
  body_text: string | null;
  review_status: string;
  review_note: string | null;
  load_batch_id: string | null;
  is_sample: boolean;
  review_flags: string[];
  reject_reason: RejectReason | null;
  edits: Record<string, unknown>;
  effective: Posting;
}

const FLAG_LABEL: Record<string, string> = {
  image_body: "이미지형 본문",
  body_short: "본문 짧음",
  no_company: "회사명 없음",
  no_skills: "기술 0개",
  no_duties: "업무·자격 없음",
  ad_keyword: "광고 키워드",
  deadline_passed: "마감 지남",
  duplicate: "중복",
  crawler_flag: "크롤러 격리",
};

const STAGE_LABEL: Record<string, string> = { crawling: "크롤링", compressing: "구조화", loading: "적재", preparing: "배치 준비", done: "완료" };

const STATUS_LABEL: Record<string, string> = {
  ok: "규칙 통과",
  needs_review: "격리",
  retry_later: "재수집",
  approved: "승인",
  rejected: "제외",
  resolved: "처리됨",
};

const REASON_LABEL: Record<RejectReason, string> = {
  ad: "광고",
  irrelevant: "무관",
  broken: "깨짐",
  duplicate: "중복",
  other: "기타",
};

function readPassword(): string {
  try {
    return sessionStorage.getItem(PW_KEY) ?? "";
  } catch {
    return "";
  }
}

export default function CrawlingPage() {
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [pwInput, setPwInput] = useState("");
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchId, setBatchId] = useState("");
  const [tab, setTab] = useState<Tab>("exceptions");
  const [rows, setRows] = useState<Row[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [crawlForm, setCrawlForm] = useState({ max: "20", keyword: "", listUrl: "", ids: "", batchId: "" });

  const call = useCallback(
    async (path: string, init: RequestInit = {}, pw = password) => {
      const headers = new Headers(init.headers);
      headers.set("X-Admin-Password", pw);
      if (init.body) headers.set("Content-Type", "application/json");
      const res = await fetch(`${ORCHESTRATOR_URL}/api/admin/crawl${path}`, { ...init, headers });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setUnlocked(false);
        try {
          sessionStorage.removeItem(PW_KEY);
        } catch {}
      }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      return data;
    },
    [password]
  );

  const unlock = useCallback(
    async (pw: string) => {
      setError(null);
      try {
        await call("/login", { method: "POST" }, pw);
        setPassword(pw);
        setUnlocked(true);
        try {
          sessionStorage.setItem(PW_KEY, pw);
        } catch {}
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [call]
  );

  useEffect(() => {
    const saved = readPassword();
    if (saved) void unlock(saved);
  }, [unlock]);

  const loadBatches = useCallback(async () => {
    const data = await call("/batches");
    setBatches(data.batches ?? []);
    // 지워진 배치(삭제·승인 완료)를 고르고 있었으면 첫 배치로 옮긴다
    setBatchId((cur) => (data.batches ?? []).some((b: Batch) => b.batchId === cur) ? cur : data.batches?.[0]?.batchId || "");
  }, [call]);

  const loadRows = useCallback(async () => {
    const qs = new URLSearchParams({ tab });
    if (batchId) qs.set("batch", batchId);
    const data = await call(`/rows?${qs}`);
    setRows(data.rows ?? []);
  }, [call, tab, batchId]);

  const refresh = useCallback(async () => {
    try {
      await Promise.all([loadBatches(), loadRows()]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [loadBatches, loadRows]);

  useEffect(() => {
    if (unlocked) void refresh();
  }, [unlocked, refresh]);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await fn();
      setMessage(`${label} 완료 ${result && typeof result === "object" ? JSON.stringify(result) : ""}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // 배치 승인·수집 실행은 202 + jobId → 잡이 끝날 때까지 상태를 폴링한다 (실제 처리는 orchestrator 워커)
  async function waitJob(jobId: string, label: string, limitMin: number) {
    const started = Date.now();
    let misses = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      let job;
      try {
        job = await call(`/jobs/${encodeURIComponent(jobId)}`);
        misses = 0;
      } catch (err) {
        // 일시 오류(재시작 등)로 한 번 못 읽었다고 실패로 보이지 않게 몇 번 더 본다
        if (++misses >= 5) throw new Error(`${label} 상태를 확인할 수 없습니다. 새로고침해 결과를 확인하세요. (${err instanceof Error ? err.message : err})`);
        continue;
      }
      if (job.state === "completed") return job.result;
      if (job.state === "failed") throw new Error(`${label} 실패: ${job.error ?? "알 수 없는 오류"}`);
      const p = job.progress && typeof job.progress === "object" ? job.progress : null;
      const stage = p?.stage ? ` · ${STAGE_LABEL[p.stage] ?? p.stage}${p.total ? ` ${p.done}/${p.total}` : ""}` : "";
      setMessage(`${label} 진행 중 (${job.state}${stage}, ${Math.round((Date.now() - started) / 1000)}초)`);
      if (Date.now() - started > limitMin * 60_000) throw new Error(`${label}이 ${limitMin}분 넘게 끝나지 않았습니다. 잡 ${jobId} 를 orchestrator 로그에서 확인하세요.`);
    }
  }

  async function approveAndWait(id: string) {
    const { jobId } = await call(`/batches/${encodeURIComponent(id)}/approve`, { method: "POST" });
    return waitJob(jobId, "배치 승인", 30);
  }

  async function crawlAndWait() {
    const body = {
      max: Number(crawlForm.max),
      keyword: crawlForm.keyword,
      listUrl: crawlForm.listUrl,
      ids: crawlForm.ids,
      batchId: crawlForm.batchId,
    };
    const { jobId, batchId: newBatch } = await call("/runs", { method: "POST", body: JSON.stringify(body) });
    const result = await waitJob(jobId, "수집", 180);
    setBatchId(newBatch);
    return result;
  }

  const act = (id: string, body: Record<string, unknown>) =>
    call(`/rows/${id}/action`, { method: "POST", body: JSON.stringify(body) }).then(() => undefined);

  if (!unlocked) {
    return (
      <div style={{ maxWidth: 400, margin: "48px auto", padding: 24, display: "flex", flexDirection: "column", gap: 12 }}>
        <h1>크롤 검수</h1>
        <p style={{ opacity: 0.7, margin: 0 }}>관리자 비밀번호를 입력하세요. 서버 .env.local 의 CRAWL_ADMIN_PASSWORD 와 비교합니다.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void unlock(pwInput);
          }}
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
        >
          <input type="password" required autoFocus placeholder="관리자 비밀번호" value={pwInput} onChange={(e) => setPwInput(e.target.value)} />
          <button type="submit">열기</button>
        </form>
        {error && <p style={{ color: "crimson", margin: 0 }}>{error}</p>}
      </div>
    );
  }

  const batch = batches.find((b) => b.batchId === batchId);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h1 style={{ margin: 0 }}>크롤 검수</h1>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Link href="/">← 홈</Link>
          <button
            onClick={() => {
              try {
                sessionStorage.removeItem(PW_KEY);
              } catch {}
              setPassword("");
              setUnlocked(false);
            }}
          >
            잠그기
          </button>
        </div>
      </div>

      <details style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12 }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>새 수집</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run("수집", crawlAndWait);
          }}
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, marginTop: 12 }}
        >
          <label>
            수집 건수 (1~100)
            <input type="number" min={1} max={100} required value={crawlForm.max} onChange={(e) => setCrawlForm({ ...crawlForm, max: e.target.value })} style={{ width: "100%" }} />
          </label>
          <label>
            검색어 (비우면 기본 &quot;개발자&quot;)
            <input placeholder="예: 백엔드, React" maxLength={50} value={crawlForm.keyword} onChange={(e) => setCrawlForm({ ...crawlForm, keyword: e.target.value })} style={{ width: "100%" }} />
          </label>
          <label style={{ gridColumn: "1 / -1" }}>
            검색 결과 URL (선택 — 수집처에서 지역·경력 등 필터를 건 검색 페이지 주소. 있으면 검색어보다 우선)
            <input type="url" placeholder="https://…/zf_user/search?..." value={crawlForm.listUrl} onChange={(e) => setCrawlForm({ ...crawlForm, listUrl: e.target.value })} style={{ width: "100%" }} />
          </label>
          <label style={{ gridColumn: "1 / -1" }}>
            공고 ID (선택 — 숫자 공고 ID 를 쉼표·줄바꿈으로. 있으면 목록 검색 없이 이 공고만)
            <textarea rows={2} placeholder="54928451, 55129596" value={crawlForm.ids} onChange={(e) => setCrawlForm({ ...crawlForm, ids: e.target.value })} style={{ width: "100%" }} />
          </label>
          <label>
            배치 이름 (선택 — 비우면 board_a-날짜-시각)
            <input placeholder="board_a-20261026-1530" maxLength={60} pattern="[\w.\-]+" value={crawlForm.batchId} onChange={(e) => setCrawlForm({ ...crawlForm, batchId: e.target.value })} style={{ width: "100%" }} />
          </label>
          <div style={{ display: "flex", alignItems: "end" }}>
            <button type="submit" disabled={busy}>
              수집 실행 (크롤 → 구조화 → 배치 준비)
            </button>
          </div>
          <p style={{ gridColumn: "1 / -1", margin: 0, fontSize: 12, opacity: 0.7 }}>
            공고당 3~7초 간격으로 받고 Gemini 로 1~2회 구조화합니다. 20건 기준 수 분 걸립니다. 끝나면 새 배치가 선택됩니다.
          </p>
        </form>
      </details>

      <section style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label>
          배치{" "}
          <select value={batchId} onChange={(e) => setBatchId(e.target.value)}>
            {batches.map((b) => (
              <option key={b.batchId} value={b.batchId}>
                {b.batchId} ({b.total}건)
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy || !batchId} onClick={() => run("배치 준비", () => call(`/batches/${encodeURIComponent(batchId)}/prepare`, { method: "POST" }))}>
          배치 준비 (규칙 판정 + 샘플)
        </button>
        <button
          disabled={busy || !batch?.prepared}
          onClick={() => {
            if (confirm("샘플을 확인했나요? 규칙 통과분 전체(샘플 포함)와 예외에서 개별 승인한 행만 job_postings 로 병합하고, 끝나면 배치를 목록에서 지웁니다. 미처리 예외·제외 행은 병합되지 않고 함께 지워집니다."))
              void run("배치 승인", () => approveAndWait(batchId));
          }}
        >
          배치 승인 + 병합
        </button>
        <button
          disabled={busy || !batchId}
          style={{ color: "crimson" }}
          onClick={() => {
            if (confirm(`배치 ${batchId} 의 크롤 원본을 모두 지웁니다. 이미 병합된 job_postings 는 남습니다. 진행할까요?`))
              void run("배치 삭제", () => call(`/batches/${encodeURIComponent(batchId)}`, { method: "DELETE" }));
          }}
        >
          배치 삭제
        </button>
      </section>

      {batch && (
        <div style={{ fontSize: 14, display: "flex", gap: 16, flexWrap: "wrap" }}>
          {Object.entries(batch.counts).map(([s, n]) => (
            <span key={s}>
              {STATUS_LABEL[s] ?? s} {n}
            </span>
          ))}
          <span>
            · 샘플 {batch.sampleTotal}건 중 미판정 {batch.samplePending}
          </span>
          {!batch.prepared && <span style={{ color: "#b45309" }}>· 아직 준비 전</span>}
        </div>
      )}

      <nav style={{ display: "flex", gap: 8 }}>
        {(["exceptions", "sample", "all"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{ fontWeight: tab === t ? 700 : 400, textDecoration: tab === t ? "underline" : "none" }}>
            {t === "exceptions" ? "예외 (격리·제외)" : t === "sample" ? "샘플" : "전체"}
          </button>
        ))}
      </nav>

      {message && <p style={{ color: "green", margin: 0 }}>{message}</p>}
      {error && <p style={{ color: "crimson", margin: 0 }}>{error}</p>}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid #e5e7eb" }}>
              <th style={{ padding: 6 }}>상태</th>
              <th style={{ padding: 6 }}>사유</th>
              <th style={{ padding: 6 }}>회사</th>
              <th style={{ padding: 6 }}>제목</th>
              <th style={{ padding: 6 }}>본문</th>
              <th style={{ padding: 6 }}>기술</th>
              <th style={{ padding: 6 }}>정본</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: 12, opacity: 0.7 }}>
                  {tab === "sample" && !batch?.prepared ? "배치 준비를 먼저 실행하세요." : "해당하는 행이 없습니다."}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <RowView
                key={r.id}
                row={r}
                open={openId === r.id}
                busy={busy}
                onToggle={() => setOpenId(openId === r.id ? null : r.id)}
                onAction={(label, body) => run(label, () => act(r.id, body))}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RowView({
  row,
  open,
  busy,
  onToggle,
  onAction,
}: {
  row: Row;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onAction: (label: string, body: Record<string, unknown>) => void;
}) {
  const e = row.effective;
  const edited = Object.keys(row.edits ?? {}).length > 0;
  return (
    <>
      <tr onClick={onToggle} style={{ borderBottom: "1px solid #e5e7eb", cursor: "pointer", background: open ? "rgba(127,127,127,0.08)" : undefined }}>
        <td style={{ padding: 6, whiteSpace: "nowrap" }}>
          {STATUS_LABEL[row.review_status] ?? row.review_status}
          {row.is_sample && " · 샘플"}
          {row.reject_reason && ` (${REASON_LABEL[row.reject_reason]})`}
        </td>
        <td style={{ padding: 6 }}>{row.review_flags.map((f) => FLAG_LABEL[f] ?? f).join(", ") || "-"}</td>
        <td style={{ padding: 6 }}>{e.company ?? "-"}</td>
        <td style={{ padding: 6 }}>
          {e.title}{" "}
          <a href={row.url} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()} style={{ fontSize: 12 }}>
            원문↗
          </a>
          {edited && <span style={{ fontSize: 12, color: "#2563eb" }}> (수정됨)</span>}
        </td>
        <td style={{ padding: 6 }}>{row.body_text?.length ?? 0}자</td>
        <td style={{ padding: 6 }}>{e.skills.length}</td>
        <td style={{ padding: 6 }}>{row.job_posting_id ? "병합됨" : "-"}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} style={{ padding: 12, borderBottom: "1px solid #e5e7eb" }}>
            <RowDetail row={row} busy={busy} onAction={onAction} />
          </td>
        </tr>
      )}
    </>
  );
}

function RowDetail({ row, busy, onAction }: { row: Row; busy: boolean; onAction: (label: string, body: Record<string, unknown>) => void }) {
  const e = row.effective;
  const [reason, setReason] = useState<RejectReason>("ad");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => ({
    title: e.title,
    company: e.company ?? "",
    role_summary: e.role_summary ?? "",
    key_duties: e.key_duties.join("\n"),
    must_have: e.must_have.join("\n"),
    nice_to_have: e.nice_to_have.join("\n"),
    skills: e.skills.join(", "),
  }));
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

  const list = (name: string, items: string[]) => (
    <div>
      <strong>{name}</strong>
      {items.length ? (
        <ul style={{ margin: "4px 0" }}>
          {items.map((i, n) => (
            <li key={n}>{i}</li>
          ))}
        </ul>
      ) : (
        <p style={{ margin: "4px 0", opacity: 0.6 }}>없음</p>
      )}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 13, display: "flex", gap: 16, flexWrap: "wrap" }}>
        <a href={row.url} target="_blank" rel="noreferrer">
          원문 열기 ↗
        </a>
        <span>경력: {row.career_text ?? "-"}</span>
        <span>근무형태: {row.employment_type_text ?? "-"}</span>
        <span>급여: {row.salary_text ?? "-"}</span>
        <span>지역: {row.location_text ?? "-"}</span>
        <span>마감: {row.deadline_text ?? "-"}</span>
      </div>
      {row.review_note && <p style={{ margin: 0, fontSize: 13 }}>메모: {row.review_note}</p>}

      {!editing ? (
        <>
          {e.role_summary && <p style={{ margin: 0 }}>{e.role_summary}</p>}
          {list("주요업무", e.key_duties)}
          {list("자격요건", e.must_have)}
          {list("우대사항", e.nice_to_have)}
          <div>
            <strong>기술</strong> {e.skills.join(", ") || "없음"}
          </div>
          <details>
            <summary>본문 원문 ({row.body_text?.length ?? 0}자)</summary>
            <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", maxHeight: 320, overflow: "auto" }}>{row.body_text ?? "(없음)"}</pre>
          </details>
        </>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {(["title", "company", "role_summary"] as const).map((k) => (
            <label key={k} style={{ display: "grid", gap: 2 }}>
              {k}
              <input value={draft[k]} onChange={(ev) => setDraft({ ...draft, [k]: ev.target.value })} />
            </label>
          ))}
          {(["key_duties", "must_have", "nice_to_have"] as const).map((k) => (
            <label key={k} style={{ display: "grid", gap: 2 }}>
              {k} (한 줄에 하나)
              <textarea rows={5} value={draft[k]} onChange={(ev) => setDraft({ ...draft, [k]: ev.target.value })} />
            </label>
          ))}
          <label style={{ display: "grid", gap: 2 }}>
            skills (쉼표 구분)
            <input value={draft.skills} onChange={(ev) => setDraft({ ...draft, skills: ev.target.value })} />
          </label>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {editing ? (
          <>
            <button
              disabled={busy}
              onClick={() => {
                onAction("수정 저장", {
                  action: "edit",
                  edits: {
                    title: draft.title,
                    company: draft.company,
                    role_summary: draft.role_summary,
                    key_duties: lines(draft.key_duties),
                    must_have: lines(draft.must_have),
                    nice_to_have: lines(draft.nice_to_have),
                    skills: draft.skills.split(",").map((s) => s.trim()).filter(Boolean),
                  },
                });
                setEditing(false);
              }}
            >
              수정 저장
            </button>
            <button onClick={() => setEditing(false)}>취소</button>
          </>
        ) : (
          <>
            <button disabled={busy} onClick={() => onAction("승인", { action: "approve" })}>
              승인 (정본 병합)
            </button>
            <button disabled={busy} onClick={() => setEditing(true)}>
              수정
            </button>
            <select value={reason} onChange={(ev) => setReason(ev.target.value as RejectReason)}>
              {(Object.keys(REASON_LABEL) as RejectReason[]).map((k) => (
                <option key={k} value={k}>
                  {REASON_LABEL[k]}
                </option>
              ))}
            </select>
            <button disabled={busy} onClick={() => onAction("제외", { action: "reject", reason })}>
              제외
            </button>
            <button disabled={busy} onClick={() => onAction("재수집 표시", { action: "recrawl" })}>
              재수집
            </button>
            {row.review_status !== "ok" && row.review_status !== "needs_review" && (
              <button disabled={busy} onClick={() => onAction("되돌리기", { action: "reopen" })}>
                판정 취소
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
