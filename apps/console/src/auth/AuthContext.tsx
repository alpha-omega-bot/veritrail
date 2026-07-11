import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Lightweight auth context for the console.
 *
 * Session model: the server issues a short-lived JWT (or opaque token) that
 * the browser stores in localStorage under `veritrail.session`. The console
 * sends it as `Authorization: Bearer <token>` on every API call.
 *
 * The console works without a session — in that case it shows sample data
 * (preserving the existing offline / demo mode). When a session exists, real
 * API calls are made.
 */

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
}

export interface SessionOrg {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly tier: 'free' | 'starter' | 'pro' | 'enterprise';
}

export interface Session {
  readonly token: string;
  readonly user: SessionUser;
  readonly orgs: ReadonlyArray<SessionOrg>;
  readonly currentOrgId: string | null;
  readonly currentProjectId: string | null;
}

interface AuthContextValue {
  readonly session: Session | null;
  readonly loading: boolean;
  /** Persist a new session (login). */
  setSession(session: Session | null): void;
  /** Drop the session (logout) — clears localStorage and reloads to the login screen. */
  logout(): void;
  /** Switch active org/project for the rest of the session. */
  setCurrentOrgProject(orgId: string, projectId: string | null): void;
}

const STORAGE_KEY = 'veritrail.session';

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Session;
        if (parsed.token && parsed.user) {
          setSessionState(parsed);
        }
      }
    } catch {
      // Corrupt session JSON — ignore and start anonymous.
    } finally {
      setLoading(false);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      loading,
      setSession(next) {
        setSessionState(next);
        try {
          if (next === null) {
            window.localStorage.removeItem(STORAGE_KEY);
          } else {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
          }
        } catch {
          // localStorage may be unavailable (Safari private mode etc).
        }
      },
      logout() {
        setSessionState(null);
        try {
          window.localStorage.removeItem(STORAGE_KEY);
        } catch {
          // Best-effort cleanup.
        }
        // Push to home so the login view renders on next paint.
        window.location.hash = '#/login';
      },
      setCurrentOrgProject(orgId, projectId) {
        setSessionState((prev) => {
          if (!prev) return prev;
          const next: Session = { ...prev, currentOrgId: orgId, currentProjectId: projectId };
          try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
          } catch {
            // ignore
          }
          return next;
        });
      },
    }),
    [session, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Read the current session token without subscribing — useful in api.ts. */
export function readSessionToken(): string | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    return parsed.token ?? null;
  } catch {
    return null;
  }
}

/** Read the current org+project label scope for sending to scoped routes. */
export function readLabelScope(): Readonly<Record<string, string>> | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    const scope: Record<string, string> = {};
    if (parsed.currentOrgId) scope['org'] = parsed.currentOrgId;
    if (parsed.currentProjectId) scope['project'] = parsed.currentProjectId;
    return Object.keys(scope).length > 0 ? scope : null;
  } catch {
    return null;
  }
}
