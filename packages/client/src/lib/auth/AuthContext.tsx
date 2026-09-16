import React, { createContext, useContext, useEffect, useSyncExternalStore, useState } from 'react';
import { tokenManager } from './tokenManager';
import { apiUrl } from '@/lib/runtimeConfig';

interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  deleteAccount: (password: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

async function fetchCurrentUser(token: string): Promise<User | null> {
  try {
    const response = await fetch(apiUrl('/api/auth/me'), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const data = await response.json() as User;
    return data;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const tokenState = useSyncExternalStore(
    (cb) => tokenManager.subscribe(cb),
    () => tokenManager.getSnapshot(),
  );

  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // On mount, try to restore session via refresh cookie
  useEffect(() => {
    let cancelled = false;

    async function init() {
      setIsLoading(true);
      try {
        // Try to get a valid token (will attempt refresh if cookie exists)
        await tokenManager.refresh();
        const token = await tokenManager.getValidToken();
        if (!cancelled && token) {
          const fetchedUser = await fetchCurrentUser(token);
          if (!cancelled) setUser(fetchedUser);
        }
      } catch {
        // No session — user needs to log in
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void init();
    return () => { cancelled = true; };
  }, []);

  // Sync user state when token is cleared (logout)
  useEffect(() => {
    if (!tokenState.accessToken && !tokenState.isRefreshing) {
      setUser(null);
    }
  }, [tokenState.accessToken, tokenState.isRefreshing]);

  const login = async (email: string, password: string) => {
    const { user: loggedInUser } = await tokenManager.login(email, password);
    setUser(loggedInUser);
  };

  const register = async (email: string, password: string, name: string) => {
    const { user: newUser } = await tokenManager.register(email, password, name);
    setUser(newUser as User);
  };

  const logout = async () => {
    await tokenManager.logout();
    setUser(null);
  };

  const deleteAccount = async (password: string) => {
    await tokenManager.deleteAccount(password);
    setUser(null);
  };

  const value: AuthState = {
    user,
    isLoading: isLoading || tokenState.isRefreshing,
    isAuthenticated: !!tokenState.accessToken && !!user,
    login,
    register,
    logout,
    deleteAccount,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
