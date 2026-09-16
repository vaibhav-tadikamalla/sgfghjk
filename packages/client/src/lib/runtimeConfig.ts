function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function readApiBase(): string {
  const fromEnv = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
  if (fromEnv) return trimTrailingSlash(fromEnv);
  return window.location.origin;
}

function readWsBase(): string {
  const fromWsEnv = (import.meta.env.VITE_WS_BASE_URL as string | undefined)?.trim();
  if (fromWsEnv) return trimTrailingSlash(fromWsEnv);

  const apiBase = readApiBase();
  if (apiBase.startsWith('https://')) {
    return `wss://${apiBase.slice('https://'.length)}`;
  }
  if (apiBase.startsWith('http://')) {
    return `ws://${apiBase.slice('http://'.length)}`;
  }
  return window.location.protocol === 'https:'
    ? `wss://${window.location.host}`
    : `ws://${window.location.host}`;
}

export const API_BASE_URL = readApiBase();
export const WS_BASE_URL = readWsBase();

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

export function wsUrl(path = '/ws'): string {
  return `${WS_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}
