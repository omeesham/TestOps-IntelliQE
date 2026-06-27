/**
 * <AuthProvider> — owns auth state and exposes it via AuthContext.
 * The context/types/useAuth hook live in AuthContext.tsx.
 */
import { useState, type ReactNode } from 'react';
import { loginUser, ssoCallback } from '@/services/api';
import { AuthContext, type User, type UserRole, type AuthResult } from './AuthContext';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    const saved = sessionStorage.getItem('intelliqe_user');
    return saved ? JSON.parse(saved) : null;
  });

  const applyAuthResult = (result: AuthResult): boolean => {
    if (!result?.success || !result.user) return false;
    const u: User = {
      username: result.user.username,
      role: result.user.role as UserRole,
      displayName: result.user.displayName,
      tenantId: result.user.tenantId,
      tenantName: result.user.tenantName,
      isPlatform: result.user.isPlatform,
    };
    setUser(u);
    sessionStorage.setItem('intelliqe_user', JSON.stringify(u));
    if (result.token) {
      sessionStorage.setItem('intelliqe_token', result.token);
    }
    return true;
  };

  const login = async (username: string, password: string): Promise<boolean> => {
    try {
      return applyAuthResult(await loginUser(username, password));
    } catch {
      return false;
    }
  };

  const ssoLogin = async (code: string, redirectUri: string): Promise<boolean> => {
    try {
      return applyAuthResult(await ssoCallback(code, redirectUri));
    } catch {
      return false;
    }
  };

  const logout = () => {
    setUser(null);
    sessionStorage.removeItem('intelliqe_user');
    sessionStorage.removeItem('intelliqe_token');
  };

  return (
    <AuthContext.Provider value={{ user, isAuthenticated: !!user, login, ssoLogin, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
