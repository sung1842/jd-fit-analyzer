/**
 * 프로세스 내 슬라이딩 윈도우 리미터 — LLM API 호출 "직전"에 건다.
 *
 * BullMQ Worker 의 limiter 는 "분당 job 수"만 제한한다. job 하나가 Gemini 를 3~6회 호출하고,
 * portfolio-chat / parse_jd / 임베딩도 같은 API 키를 쓰므로, 실제 429 를 막는 유일한 지점은 호출부다.
 * mcp-server 는 단일 프로세스라 Redis 없이 메모리 카운터로 충분하다 (멀티 인스턴스로 가면 Redis 로 교체).
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SlidingWindowLimiter {
  private readonly timestamps = new Map<string, number[]>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number
  ) {
    if (!Number.isFinite(max) || max < 1) throw new Error(`limiter max 는 1 이상이어야 합니다: ${max}`);
  }

  /** 슬롯이 날 때까지 대기한 뒤 반환. key 별(모델별)로 직렬화되어 경합 없이 카운트한다. */
  async acquire(key: string): Promise<{ waitedMs: number }> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.tails.set(key, prev.then(() => mine));
    await prev;

    const started = Date.now();
    try {
      for (;;) {
        const now = Date.now();
        const recent = (this.timestamps.get(key) ?? []).filter((t) => now - t < this.windowMs);
        if (recent.length < this.max) {
          recent.push(now);
          this.timestamps.set(key, recent);
          return { waitedMs: now - started };
        }
        await sleep(this.windowMs - (now - recent[0]) + 5);
      }
    } finally {
      release();
      if (this.tails.get(key) === mine) this.tails.delete(key);
    }
  }

  /** 현재 윈도우 내 사용량 (관측용) */
  usage(key: string): number {
    const now = Date.now();
    return (this.timestamps.get(key) ?? []).filter((t) => now - t < this.windowMs).length;
  }
}

// GEMINI_RPM: 모델별 분당 허용 호출 수. 무료 티어는 모델별로 별도 카운트되므로 key=model.
// 무료 티어 실측 한도가 5/min 수준이라 기본값을 보수적으로 둔다. 유료 전환 시 .env.local 에서 상향.
const GEMINI_RPM = Number(process.env.GEMINI_RPM) || 5;
export const geminiLimiter = new SlidingWindowLimiter(GEMINI_RPM, 60_000);
