import "./env.js";
import { createFitDbClient } from "../../../shared/lib/fitDb.js";

// jd-fit-analyzer 운영 데이터 (talentfolio 프로젝트의 fit 스키마, service_role).
// 스키마/키 해석 규칙은 shared/lib/fitDb.ts 참고.
export const db = createFitDbClient("orchestrator");
