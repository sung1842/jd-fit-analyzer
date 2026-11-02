import "./env.js";
import { Redis } from "ioredis";

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  throw new Error("REDIS_URL이 .env.local에 설정되어 있지 않습니다.");
}

// BullMQ Queue/Worker는 각자 독립된 connection을 가져야 하므로 인스턴스 생성 함수로 제공
export function createRedisConnection(): Redis {
  return new Redis(REDIS_URL!, { maxRetriesPerRequest: null });
}

// 캐시 등 범용 용도의 공유 connection
export const redis = createRedisConnection();
