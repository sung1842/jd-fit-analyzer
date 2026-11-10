/**
 * LLM API 호출 "직전"에 거는 분당 호출 수 리미터.
 *
 * BullMQ Worker 의 limiter 는 "분당 job 수"만 제한한다. job 하나가 LLM 을 여러 번 호출하고
 * portfolio-chat / parse_jd / 임베딩도 같은 API 키를 쓰므로, 실제 429 를 막는 지점은 호출부다.
 *
 * REDIS_URL 이 있으면 Redis 슬라이딩 윈도우를 쓴다 → mcp-server 를 여러 대 띄워도 한도를 함께 센다 (수평 확장).
 * 없으면 프로세스 메모리 리미터로 동작한다 (단일 인스턴스 개발 환경).
 *
 * 슬롯을 오래 기다리지 않는다: maxWaitMs 를 넘기면 ok=false 로 돌려주고, 호출자는 "지금은 바쁨"으로 실패시킨다.
 * (오래 붙잡으면 호출한 쪽이 먼저 타임아웃으로 포기하고, 받을 사람 없는 호출이 한도만 쓴다.)
 */
import { Redis } from "ioredis";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AcquireResult { ok: boolean; waitedMs: number }
export interface Limiter { acquire(key: string, maxWaitMs?: number): Promise<AcquireResult> }

const DEFAULT_MAX_WAIT_MS = Number(process.env.LLM_SLOT_MAX_WAIT_MS) || 15_000;

export class SlidingWindowLimiter implements Limiter {
  private readonly timestamps = new Map<string, number[]>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number
  ) {
    if (!Number.isFinite(max) || max < 1) throw new Error(`limiter max 는 1 이상이어야 합니다: ${max}`);
  }

  /** 슬롯이 나면 ok=true. key 별(모델별)로 직렬화되어 경합 없이 카운트한다. */
  async acquire(key: string, maxWaitMs = DEFAULT_MAX_WAIT_MS): Promise<AcquireResult> {
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
          return { ok: true, waitedMs: now - started };
        }
        const wait = this.windowMs - (now - recent[0]) + 5;
        if (now - started + wait > maxWaitMs) return { ok: false, waitedMs: now - started };
        await sleep(wait);
      }
    } finally {
      release();
      if (this.tails.get(key) === mine) this.tails.delete(key);
    }
  }
}

// 원자적 슬라이딩 윈도우: 슬롯이 있으면 0, 없으면 가장 오래된 호출이 창을 벗어날 때까지 남은 ms
const ACQUIRE_LUA = `
local now = tonumber(ARGV[1])
local win = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - win)
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  redis.call('PEXPIRE', KEYS[1], win)
  return 0
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return tonumber(oldest[2]) + win - now
`;

export class RedisSlidingWindowLimiter implements Limiter {
  private seq = 0;
  constructor(
    private readonly redis: Redis,
    private readonly max: number,
    private readonly windowMs: number
  ) {}

  async acquire(key: string, maxWaitMs = DEFAULT_MAX_WAIT_MS): Promise<AcquireResult> {
    const started = Date.now();
    for (;;) {
      const now = Date.now();
      const id = `${process.pid}:${now}:${this.seq++}`;
      const wait = Number(await this.redis.eval(ACQUIRE_LUA, 1, `llm:rpm:${key}`, now, this.windowMs, this.max, id));
      if (wait <= 0) return { ok: true, waitedMs: now - started };
      if (now - started + wait > maxWaitMs) return { ok: false, waitedMs: now - started };
      // 여러 인스턴스가 같은 순간에 깨어나 몰리지 않게 약간 흩뜨린다
      await sleep(wait + Math.floor(Math.random() * 250));
    }
  }
}

// 공유 상태(리미터·차단 표시)용 Redis. 명령이 오래 매달리지 않게 재시도를 짧게 끊는다.
export const sharedRedis: Redis | null = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: true })
  : null;
sharedRedis?.on("error", (err) => console.warn(`[redis] ${err.message}`));

// GEMINI_RPM: 모델별 분당 허용 호출 수 (key=model). 계약한 한도에 맞춰 환경변수로 올린다.
const GEMINI_RPM = Number(process.env.GEMINI_RPM) || 5;
const memoryLimiter = new SlidingWindowLimiter(GEMINI_RPM, 60_000);
const redisLimiter = sharedRedis ? new RedisSlidingWindowLimiter(sharedRedis, GEMINI_RPM, 60_000) : null;

export const geminiLimiter: Limiter = {
  async acquire(key, maxWaitMs) {
    if (!redisLimiter) return memoryLimiter.acquire(key, maxWaitMs);
    try {
      return await redisLimiter.acquire(key, maxWaitMs);
    } catch (err) {
      // Redis 장애 시에도 호출 수 제한은 유지한다 (인스턴스 단위로 후퇴)
      console.warn(`[limiter] Redis 리미터 실패 → 메모리 리미터로 대체: ${err instanceof Error ? err.message : err}`);
      return memoryLimiter.acquire(key, maxWaitMs);
    }
  },
};
