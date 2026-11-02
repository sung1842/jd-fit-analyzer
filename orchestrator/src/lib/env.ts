import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// .env.local은 레포 루트(jd-fit-analyzer/)에 위치 — orchestrator/src/lib -> 루트는 3단계 상위
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env.local") });
