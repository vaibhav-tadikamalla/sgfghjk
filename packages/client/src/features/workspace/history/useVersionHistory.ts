import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { versionsApi } from '@/lib/api';
import type { VersionDetail, VersionListResponse, RestoreResponse, VersionMeta } from './types';

export function useVersions(fileId: string | null, enabled = true) {
  return useQuery<VersionListResponse>({
    queryKey: ['versions', fileId],
    queryFn: () => versionsApi.list(fileId!),
    enabled: !!fileId && enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useVersionDetail(fileId: string | null, versionId: string | null) {
  return useQuery<VersionDetail>({
    queryKey: ['version-detail', fileId, versionId],
    queryFn: () => versionsApi.get(fileId!, versionId!),
    enabled: !!fileId && !!versionId,
    // Version snapshots are immutable — never re-fetch the same version
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  });
}

export function useRestoreVersion(fileId: string) {
  const qc = useQueryClient();
  return useMutation<RestoreResponse, Error, string>({
    mutationFn: (versionId: string) => versionsApi.restore(fileId, versionId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['versions', fileId] });
    },
  });
}

export function useCreateCheckpoint(fileId: string) {
  const qc = useQueryClient();
  return useMutation<VersionMeta, Error, string>({
    mutationFn: (label: string) => versionsApi.createCheckpoint(fileId, label),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['versions', fileId] });
    },
  });
}
