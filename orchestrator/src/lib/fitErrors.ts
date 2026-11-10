/** 핏 분석 오류 분류 (순수 함수 — 외부 연결 없음) */
// ── 오류 분류 ────────────────────────────────────────────────────────────────
// 재시도는 BullMQ 한 곳에서만 한다. 그 판단 근거가 이 분류다.
//   permanent : 다시 해도 같은 결과 (후보 없음·입력 오류·모델 거부) → 즉시 실패, 재시도 없음
//   capacity  : LLM 한도·슬롯 부족 → 시도 횟수를 쓰지 않고 뒤로 미룬다 (호출하지 않고 기다림)
//   transient : 네트워크·일시 장애 → 백오프 후 재시도
export type FitErrorClass = "permanent" | "capacity" | "transient";
export interface FitErrorInfo { cls: FitErrorClass; code: string }

const PERMANENT = /\[E_NOT_FOUND\]|\[E_INVALID\]|\[E_BLOCKED\]|-32602|Invalid arguments/;
const CAPACITY = /\[E_QUOTA\]|\[E_BUSY\]/;

export function classifyFitError(err: unknown): FitErrorInfo {
  const msg = err instanceof Error ? err.message : String(err);
  const code = msg.match(/\[(E_[A-Z_]+)\]/)?.[1];
  if (PERMANENT.test(msg)) return { cls: "permanent", code: code ?? "E_INVALID" };
  if (CAPACITY.test(msg)) return { cls: "capacity", code: code ?? "E_BUSY" };
  // CEO(Anthropic) 한도·과부하도 용량 문제로 본다
  const status = (err as { status?: number } | null)?.status;
  if (status === 429 || status === 529) return { cls: "capacity", code: "E_QUOTA" };
  return { cls: "transient", code: code ?? "E_TRANSIENT" };
}
