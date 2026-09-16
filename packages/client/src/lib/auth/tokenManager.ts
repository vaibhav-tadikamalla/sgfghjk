import { apiUrl } from '@/lib/runtimeConfig';

interface TokenState {
  accessToken: string | null;
  expiresAt: number | null;
  isRefreshing: boolean;
}

type Listener = () => void;

class TokenManager {
  private state: TokenState = {
    accessToken: null,
    expiresAt: null,
    isRefreshing: false,
  };

  private listeners = new Set<Listener>();
  private refreshPromise: Promise<void> | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): TokenState {
    return this.state;
  }

  setToken(accessToken: string, expiresAt: number): void {
    this.state = { accessToken, expiresAt, isRefreshing: false };
    this.notifyListeners();
  }

  clearToken(): void {
    this.state = { accessToken: null, expiresAt: null, isRefreshing: false };
    this.notifyListeners();
  }

  isExpired(): boolean {
    if (!this.state.expiresAt) return true;
    // 30 second buffer before actual expiry
    return Date.now() / 1000 > this.state.expiresAt - 30;
  }

  async getValidToken(): Promise<string | null> {
    if (!this.state.accessToken) return null;
    if (!this.isExpired()) return this.state.accessToken;

    // Token is expired, refresh it
    await this.refresh();
    return this.state.accessToken;
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.state = { ...this.state, isRefreshing: true };
    this.notifyListeners();

    this.refreshPromise = this._doRefresh().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  private async _doRefresh(): Promise<void> {
    try {
      const response = await fetch(apiUrl('/api/auth/refresh'), {
        method: 'POST',
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Refresh failed');
      }

      const data = await response.json() as { accessToken: string; expiresAt: number };
      this.setToken(data.accessToken, data.expiresAt);
    } catch {
      this.clearToken();
    }
  }

  async login(email: string, password: string): Promise<{
    user: { id: string; email: string; displayName: string; avatarUrl?: string };
  }> {
    const response = await fetch(apiUrl('/api/auth/login'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      const err = await response.json() as { message?: string };
      throw new Error(err.message || 'Login failed');
    }

    const data = await response.json() as {
      accessToken: string;
      expiresAt: number;
      user: { id: string; email: string; displayName: string; avatarUrl?: string };
    };

    this.setToken(data.accessToken, data.expiresAt);
    return { user: data.user };
  }

  async register(email: string, password: string, name: string): Promise<{
    user: { id: string; email: string; displayName: string };
  }> {
    const response = await fetch(apiUrl('/api/auth/register'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
    });

    if (!response.ok) {
      const err = await response.json() as { message?: string };
      throw new Error(err.message || 'Registration failed');
    }

    const data = await response.json() as {
      accessToken: string;
      expiresAt: number;
      user: { id: string; email: string; displayName: string };
    };

    this.setToken(data.accessToken, data.expiresAt);
    return { user: data.user };
  }

  async logout(): Promise<void> {
    try {
      await fetch(apiUrl('/api/auth/logout'), {
        method: 'POST',
        credentials: 'include',
        headers: this.state.accessToken
          ? { Authorization: `Bearer ${this.state.accessToken}` }
          : {},
      });
    } finally {
      this.clearToken();
    }
  }

  async deleteAccount(password: string): Promise<void> {
    const response = await fetch(apiUrl('/api/auth/account'), {
      method: 'DELETE',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(this.state.accessToken
          ? { Authorization: `Bearer ${this.state.accessToken}` }
          : {}),
      },
      body: JSON.stringify({ password }),
    });

    if (!response.ok) {
      const err = await response.json() as { message?: string };
      throw new Error(err.message || 'Failed to delete account');
    }

    this.clearToken();
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const tokenManager = new TokenManager();
