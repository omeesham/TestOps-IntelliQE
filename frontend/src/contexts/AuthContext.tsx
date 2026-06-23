import { createContext, useContext, useState, type ReactNode } from 'react';
import { loginUser } from '@/services/api';

export type UserRole = 'admin' | 'qa_engineer' | 'data_analyst';

interface User {
  username: string;
  role: UserRole;
  displayName?: string;
  tenantId?: string;
  tenantName?: string;
  isPlatform?: boolean;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    const saved = sessionStorage.getItem('intelliqe_user');
    return saved ? JSON.parse(saved) : null;
  });

  const login = async (username: string, password: string): Promise<boolean> => {
    try {
      const result = await loginUser(username, password);
      if (result.success) {
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
      }
      return false;
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
    <AuthContext.Provider value={{ user, isAuthenticated: !!user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
