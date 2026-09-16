import { useQuery } from '@tanstack/react-query';
import { dashboardApi, simulationApi } from './api';

const POLL_INTERVAL = 3_000; // 3-second short polling for realtime feel

export function useDashboardSummary() {
  return useQuery({
    queryKey: ['admin', 'dashboard', 'summary'],
    queryFn: dashboardApi.getSummary,
    refetchInterval: POLL_INTERVAL,
    staleTime: 1_000,
  });
}

export function useDashboardRooms() {
  return useQuery({
    queryKey: ['admin', 'dashboard', 'rooms'],
    queryFn: dashboardApi.getRooms,
    refetchInterval: POLL_INTERVAL,
    staleTime: 1_000,
  });
}

export function useDashboardUsers() {
  return useQuery({
    queryKey: ['admin', 'dashboard', 'users'],
    queryFn: dashboardApi.getUsers,
    refetchInterval: POLL_INTERVAL,
    staleTime: 1_000,
  });
}

export function useDashboardHealth() {
  return useQuery({
    queryKey: ['admin', 'dashboard', 'health'],
    queryFn: dashboardApi.getHealth,
    refetchInterval: POLL_INTERVAL,
    staleTime: 1_000,
  });
}

export function useDashboardAnalytics() {
  return useQuery({
    queryKey: ['admin', 'dashboard', 'analytics'],
    queryFn: dashboardApi.getAnalytics,
    refetchInterval: POLL_INTERVAL,
    staleTime: 1_000,
  });
}

export function useDashboardActivityHistory() {
  return useQuery({
    queryKey: ['admin', 'dashboard', 'activity-history'],
    queryFn: dashboardApi.getActivityHistory,
    refetchInterval: POLL_INTERVAL,
    staleTime: 1_000,
  });
}

export function useDashboardTopology() {
  return useQuery({
    queryKey: ['admin', 'dashboard', 'topology'],
    queryFn: dashboardApi.getTopology,
    refetchInterval: POLL_INTERVAL,
    staleTime: 1_000,
  });
}

export function useSimulationStatus() {
  return useQuery({
    queryKey: ['admin', 'simulation', 'status'],
    queryFn: simulationApi.getStatus,
    refetchInterval: POLL_INTERVAL,
    staleTime: 1_000,
  });
}

export function useClusterSimulationStatus() {
  return useQuery({
    queryKey: ['admin', 'simulation', 'cluster', 'status'],
    queryFn: simulationApi.getClusterStatus,
    refetchInterval: POLL_INTERVAL,
    staleTime: 1_000,
  });
}

export function useChaosStatus() {
  return useQuery({
    queryKey: ['admin', 'simulation', 'chaos', 'status'],
    queryFn: simulationApi.getChaosStatus,
    refetchInterval: POLL_INTERVAL,
    staleTime: 1_000,
  });
}

export function useReplayStatus() {
  return useQuery({
    queryKey: ['admin', 'simulation', 'replay', 'status'],
    queryFn: simulationApi.getReplayStatus,
    refetchInterval: POLL_INTERVAL,
    staleTime: 1_000,
  });
}
