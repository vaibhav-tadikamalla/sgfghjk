/**
 * admin/benchmarkHooks.ts
 *
 * React Query hooks for the benchmark system.
 * Uses same polling interval as the existing admin hooks.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { benchmarkApi, type BenchmarkConfig } from './benchmarkApi';

const POLL_INTERVAL = 2_000; // 2s — faster during active runs

export function useBenchmarkStatus() {
  return useQuery({
    queryKey: ['admin', 'benchmark', 'status'],
    queryFn: benchmarkApi.getStatus,
    refetchInterval: POLL_INTERVAL,
    staleTime: 500,
  });
}

export function useBenchmarkRuns(params?: { limit?: number; offset?: number }) {
  return useQuery({
    queryKey: ['admin', 'benchmark', 'runs', params],
    queryFn: () => benchmarkApi.getRuns(params),
    refetchInterval: 5_000,
    staleTime: 2_000,
  });
}

export function useBenchmarkRun(id: string | null) {
  return useQuery({
    queryKey: ['admin', 'benchmark', 'run', id],
    queryFn: () => benchmarkApi.getRun(id!),
    enabled: !!id,
    staleTime: 5_000,
  });
}

export function useStartBenchmark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: BenchmarkConfig) => benchmarkApi.start(config),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'benchmark'] });
    },
  });
}

export function useCancelBenchmark() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => benchmarkApi.cancel(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'benchmark'] });
    },
  });
}

export function useDeleteBenchmarkRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => benchmarkApi.deleteRun(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'benchmark', 'runs'] });
    },
  });
}

export function useStartMatrix() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: benchmarkApi.startMatrix,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'benchmark'] });
    },
  });
}
