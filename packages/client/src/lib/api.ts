import ky from 'ky';
import { API_BASE_URL } from '@/lib/runtimeConfig';
import type {
  VersionMeta,
  VersionDetail,
  VersionListResponse,
  RestoreResponse,
} from '@/features/workspace/history/types';

export type { VersionMeta, VersionDetail, VersionListResponse, RestoreResponse };

// Lazy import to avoid circular dependency
function getTokenManager() {
  return import('./auth/tokenManager').then(m => m.tokenManager);
}

export const api = ky.create({
  prefixUrl: `${API_BASE_URL}/`,
  timeout: 30_000,
  retry: {
    limit: 1,
    methods: ['get'],
    statusCodes: [408, 429, 500, 502, 503, 504],
  },
  hooks: {
    beforeRequest: [
      async (request) => {
        const tm = await getTokenManager();
        const token = await tm.getValidToken();
        if (token) {
          request.headers.set('Authorization', `Bearer ${token}`);
        }
      },
    ],
    afterResponse: [
      async (request, _options, response) => {
        if (response.status === 401) {
          const url = request.url;
          const isAuthEndpoint =
            url.includes('/api/auth/login') ||
            url.includes('/api/auth/register') ||
            url.includes('/api/auth/refresh');

          if (isAuthEndpoint) {
            return response;
          }

          // Token might be expired — try refresh
          try {
            const tm = await getTokenManager();
            await tm.refresh();
            const token = await tm.getValidToken();
            if (token) {
              request.headers.set('Authorization', `Bearer ${token}`);
              return ky(request);
            }
          } catch {
            const tm = await getTokenManager();
            tm.clearToken();
            window.location.href = '/login';
          }
        }
      },
    ],
  },
});

// ── Document Version History API ─────────────────────────────────────────────
export const versionsApi = {
  list: (fileId: string, limit = 50, offset = 0): Promise<VersionListResponse> =>
    api
      .get(`api/files/${fileId}/versions`, { searchParams: { limit, offset } })
      .json<VersionListResponse>(),

  get: (fileId: string, versionId: string): Promise<VersionDetail> =>
    api.get(`api/files/${fileId}/versions/${versionId}`).json<VersionDetail>(),

  createCheckpoint: (fileId: string, label: string): Promise<VersionMeta> =>
    api
      .post(`api/files/${fileId}/versions`, { json: { label } })
      .json<VersionMeta>(),

  restore: (fileId: string, versionId: string): Promise<RestoreResponse> =>
    api
      .post(`api/files/${fileId}/versions/${versionId}/restore`)
      .json<RestoreResponse>(),
};
