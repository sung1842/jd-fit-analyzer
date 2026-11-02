import "./env.js";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY가 .env.local에 설정되어 있지 않습니다.");
}

// talentfolio profiles 테이블 읽기 전용 연결 (RLS: 모든 유저 SELECT 허용)
export const supabase = createClient(url, anonKey);
