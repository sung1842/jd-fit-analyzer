"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { getSupabase, supabaseConfigured } from "@/lib/supabase";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabaseConfigured) {
      setLoading(false);
      return;
    }
    const supabase = getSupabase();
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await getSupabase().auth.signInWithPassword({ email, password });
    return error ? error.message : null;
  }, []);

  const signOut = useCallback(async () => {
    await getSupabase().auth.signOut();
  }, []);

  return (
    <AuthContext.Provider value={{ user: session?.user ?? null, session, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth 는 AuthProvider 안에서만 사용할 수 있습니다.");
  return ctx;
}

/**
 * 로그인 전에는 자식 대신 로그인 폼을 보여준다. 모든 페이지가 orchestrator(JWT 필수)를 호출하므로 전역 게이트로 둔다.
 * 회원가입은 talentfolio 에서만 한다 — public.profiles 행 생성이 talentfolio 의 signUp 에 묶여 있어 여기서 가입하면 프로필 없는 계정이 생긴다.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading, signIn, signOut } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!supabaseConfigured) {
    return (
      <div style={{ maxWidth: 480, margin: "48px auto", padding: 24 }}>
        <h1>설정 필요</h1>
        <p>
          <code>web/.env.local</code> 에 <code>NEXT_PUBLIC_SUPABASE_URL</code>, <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> 를 설정하세요
          (talentfolio 와 동일 프로젝트).
        </p>
      </div>
    );
  }

  if (loading) return <p style={{ padding: 24 }}>세션 확인 중...</p>;

  if (!user) {
    const submit = async (e: React.FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      const err = await signIn(email, password);
      if (err) setError(err);
      setBusy(false);
    };
    return (
      <div style={{ maxWidth: 400, margin: "48px auto", padding: 24, display: "flex", flexDirection: "column", gap: 12 }}>
        <h1>JD-Portfolio Fit Analyzer</h1>
        <p style={{ opacity: 0.7, margin: 0 }}>talentfolio 계정으로 로그인하세요. 계정이 없으면 talentfolio 에서 가입합니다.</p>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input type="email" required placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input
            type="password"
            required
            minLength={6}
            placeholder="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" disabled={busy}>
            {busy ? "로그인 중..." : "로그인"}
          </button>
        </form>
        {error && <p style={{ color: "crimson", margin: 0 }}>{error}</p>}
      </div>
    );
  }

  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, padding: "8px 24px", fontSize: 13, opacity: 0.8 }}>
        <span>{user.email}</span>
        <button type="button" onClick={() => void signOut()}>
          로그아웃
        </button>
      </div>
      {children}
    </>
  );
}
