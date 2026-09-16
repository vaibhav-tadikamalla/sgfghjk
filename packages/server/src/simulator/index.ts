/**
 * simulator/index.ts
 *
 * Barrel export for the simulator module.
 */

export { SwarmSimulator, getSwarmSimulator } from './SwarmSimulator';
export type { SimulationConfig, SimulationSnapshot, SimulationState } from './SwarmSimulator';
export { SimulatedEditor } from './SimulatedEditor';
export type { SimulatedEditorConfig, SimulatedEditorMetrics, EditorState } from './SimulatedEditor';
export {
  simEditorsGauge,
  simEditsCounter,
  simConnectionFailuresCounter,
  simAvgLatencyGauge,
} from './simulatorMetrics';
export { ClusterSimulator, getClusterSimulator } from './ClusterSimulator';
export type {
  ClusterSimulationConfig,
  ClusterSimulationSnapshot,
  ClusterSimulationState,
} from './ClusterSimulator';
export type { ScenarioId } from './ScenarioEngine';
export type { FailureType, FailureEvent } from './FailureInjector';
export type {
  ChaosConfig,
  ChaosSnapshot,
  ChaosState,
  ChaosEvent,
  ChaosFailureType,
} from './ChaosEngine';
export type {
  ReplaySnapshot,
  ReplayTrace,
  ReplayTraceEvent,
  ReplayState,
  ReplayMode,
  ReplayLogEntry,
  ReplayEventSource,
  ReplayEventKind,
} from './ReplayEngine';
