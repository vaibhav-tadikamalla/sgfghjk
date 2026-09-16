import React, { useState } from 'react';
import { useDashboardSummary, useDashboardRooms, useDashboardUsers, useDashboardHealth, useDashboardAnalytics, useDashboardActivityHistory, useDashboardTopology, useSimulationStatus, useClusterSimulationStatus, useChaosStatus, useReplayStatus } from './hooks';
import { SystemOverview } from './SystemOverview';
import { ActiveRoomsTable } from './ActiveRoomsTable';
import { UserActivityTable } from './UserActivityTable';
import { RealtimeCharts } from './RealtimeCharts';
import { CollaborationHealth } from './CollaborationHealth';
import { DocumentActivityHeatmap } from './DocumentActivityHeatmap';
import { EditorHeatmap } from './EditorHeatmap';
import { ClusterTopologyPanel } from './ClusterTopologyPanel';
import { RealtimeActivityGraph } from './RealtimeActivityGraph';
import { SimulationControls } from './SimulationControls';
import { SimulationDashboard } from './SimulationDashboard';
import { ClusterSimulationPanel } from './ClusterSimulationPanel';
import { ChaosEngineeringPanel } from './ChaosEngineeringPanel';
import { ReplayPanel } from './ReplayPanel';

type Tab = 'overview' | 'rooms' | 'users' | 'charts' | 'health' | 'heatmap' | 'topology' | 'activity' | 'simulator';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'rooms', label: 'Rooms' },
  { id: 'users', label: 'Users' },
  { id: 'heatmap', label: 'Heatmaps' },
  { id: 'topology', label: 'Topology' },
  { id: 'activity', label: 'Activity' },
  { id: 'charts', label: 'Metrics' },
  { id: 'health', label: 'Health' },
  { id: 'simulator', label: 'Simulator' },
];

export default function AdminDashboardPage() {
  const [tab, setTab] = useState<Tab>('overview');

  const summary = useDashboardSummary();
  const rooms = useDashboardRooms();
  const users = useDashboardUsers();
  const health = useDashboardHealth();
  const analytics = useDashboardAnalytics();
  const activityHistory = useDashboardActivityHistory();
  const topology = useDashboardTopology();
  const simulation = useSimulationStatus();
  const clusterSimulation = useClusterSimulationStatus();
  const chaosStatus = useChaosStatus();
  const replayStatus = useReplayStatus();

  const isLoading = summary.isLoading && rooms.isLoading;
  const hasError = summary.isError || rooms.isError || users.isError || health.isError || analytics.isError;

  return (
    <div className="min-h-screen bg-zinc-900 text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-700 bg-zinc-900/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-white tracking-tight">PeerGrid Admin</h1>
            <span className="text-xs px-2 py-0.5 bg-green-900/50 text-green-400 rounded-full border border-green-800">
              Live
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            {summary.data && (
              <span>
                Last updated: {new Date(summary.data.retrievedAt).toLocaleTimeString()}
              </span>
            )}
            {summary.isFetching && (
              <span className="inline-block w-2 h-2 bg-blue-400 rounded-full animate-pulse" title="Fetching…" />
            )}
          </div>
        </div>
      </header>

      {/* Tab Bar */}
      <nav className="border-b border-zinc-700 bg-zinc-900/60">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex gap-1">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
                tab === t.id
                  ? 'text-white'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {t.label}
              {tab === t.id && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500 rounded-t" />
              )}
            </button>
          ))}
        </div>
      </nav>

      {/* Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {isLoading && (
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 border-2 border-zinc-600 border-t-blue-500 rounded-full animate-spin" />
          </div>
        )}

        {hasError && (
          <div className="bg-red-900/30 border border-red-800 rounded-lg p-4 text-sm text-red-300">
            <strong>Error loading dashboard data.</strong> The server may be unreachable.
            {summary.error && <p className="mt-1 text-xs">{String(summary.error)}</p>}
          </div>
        )}

        {!isLoading && (
          <>
            {/* Overview tab shows system overview + quick rooms + quick users */}
            {tab === 'overview' && (
              <div className="space-y-6">
                {summary.data && <SystemOverview system={summary.data.system} cluster={summary.data.cluster} />}
                {rooms.data && (
                  <ActiveRoomsTable rooms={rooms.data.rooms.slice(0, 10)} />
                )}
                {users.data && (
                  <UserActivityTable users={users.data.users.slice(0, 10)} analytics={analytics.data} />
                )}
              </div>
            )}

            {/* Full rooms view */}
            {tab === 'rooms' && (
              <div className="space-y-4">
                {rooms.data && (
                  <>
                    <div className="flex items-center justify-between">
                      <h2 className="text-sm font-semibold text-zinc-300">
                        All Rooms ({rooms.data.totalRooms})
                      </h2>
                    </div>
                    <ActiveRoomsTable rooms={rooms.data.rooms} />

                    {rooms.data.mostEdited.length > 0 && (
                      <div>
                        <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">
                          Most Edited
                        </h3>
                        <ActiveRoomsTable rooms={rooms.data.mostEdited} />
                      </div>
                    )}

                    {rooms.data.idleRooms.length > 0 && (
                      <div>
                        <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">
                          Idle Rooms ({rooms.data.idleRooms.length})
                        </h3>
                        <ActiveRoomsTable rooms={rooms.data.idleRooms} />
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Full users view */}
            {tab === 'users' && (
              <div className="space-y-4">
                {users.data && (
                  <>
                    <h2 className="text-sm font-semibold text-zinc-300">
                      All Users ({users.data.totalUsers})
                    </h2>
                    <UserActivityTable users={users.data.users} analytics={analytics.data} />
                  </>
                )}
              </div>
            )}

            {/* Metrics tab */}
            {tab === 'charts' && analytics.data && (
              <RealtimeCharts analytics={analytics.data} />
            )}

            {/* Health tab */}
            {tab === 'health' && health.data && (
              <CollaborationHealth health={health.data} />
            )}

            {/* Document & Editor Heatmaps tab */}
            {tab === 'heatmap' && rooms.data && (
              <div className="space-y-6">
                <DocumentActivityHeatmap rooms={rooms.data.rooms} />
                <EditorHeatmap rooms={rooms.data.rooms} />
              </div>
            )}

            {/* Cluster Topology tab */}
            {tab === 'topology' && topology.data && (
              <ClusterTopologyPanel topology={topology.data} />
            )}

            {/* Realtime Activity Graph tab */}
            {tab === 'activity' && activityHistory.data && (
              <RealtimeActivityGraph history={activityHistory.data} />
            )}

            {/* Simulator tab */}
            {tab === 'simulator' && simulation.data && clusterSimulation.data && chaosStatus.data && replayStatus.data && (
              <div className="space-y-6">
                <div className="space-y-3">
                  <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wide">Single-node Simulator</h2>
                  <SimulationControls snapshot={simulation.data} />
                  <SimulationDashboard snapshot={simulation.data} />
                </div>

                <div className="space-y-3">
                  <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wide">Cluster Simulator</h2>
                  <ClusterSimulationPanel snapshot={clusterSimulation.data} />
                </div>

                <div className="space-y-3">
                  <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wide">Chaos Engineering</h2>
                  <ChaosEngineeringPanel snapshot={chaosStatus.data} clusterRunning={clusterSimulation.data.state === 'running'} />
                </div>

                <div className="space-y-3">
                  <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wide">Deterministic Replay</h2>
                  <ReplayPanel snapshot={replayStatus.data} clusterRunning={clusterSimulation.data.state === 'running'} />
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
