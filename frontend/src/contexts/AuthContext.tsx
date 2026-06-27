/**
 * Auth context, types, and the `useAuth` hook. Component-free so Fast Refresh
 * stays happy — the <AuthProvider> component lives in AuthProvider.tsx.
 */
import { createContext, useContext } from 'react';

export type UserRole = 'admin' | 'qa_engineer' | 'data_analyst';

export interface User {
  username: string;
  role: UserRole;
  displayName?: string;
  tenantId?: string;
  tenantName?: string;
  isPlatform?: boolean;
}

export interface AuthResult {
  success?: boolean;
  token?: string;
  user?: {
    username: string;
    role: string;
    displayName?: string;
    tenantId?: string;
    tenantName?: string;
    isPlatform?: boolean;
  };
}

export interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<boolean>;
  ssoLogin: (code: string, redirectUri: string) => Promise<boolean>;
  logout: () => void;
}

export const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
