import type { ChatPart } from '@threadterm/protocol';

/* What main sends the task island window (desktop/src/taskIsland.ts builds it). */

export type IslandLiveState = 'running' | 'approval' | 'input';
export type IslandState = IslandLiveState | 'done' | 'error';
export interface IslandItem {
  /** `machineId \u0000 sessionId`. */
  key: string; machineId: string; sessionId: string;
  /** Another computer's name; absent for this PC. */
  machineName?: string;
  title: string; project?: string;
  /** The AgentTile id (terminalAgent ?? provider) and the agent's display name. */
  provider: string; providerName: string;
  state: IslandState;
  /** Running: the turn's start. Waiting: when it began waiting. Finished: when it finished. Epoch ms. */
  since: number;
  /** When the island first saw the turn running; finished items use it for the duration. */
  started?: number;
  /** Needs you: the pending approval part, when it could be read (the island page words it). */
  approval?: ChatPart;
  /** Finished: the agent's last answer or the error, one line. */
  result?: string;
}
export interface IslandProviderIcon { id: string; name: string; icon?: string }
export interface IslandModel { visible: boolean; zh: boolean; alert: boolean; items: IslandItem[]; providers: IslandProviderIcon[] }

export interface IslandBridge {
  onModel(listener: (model: IslandModel) => void): () => void;
  /** The pointer is over the island (clicks land) or over the transparent rest (clicks pass through). */
  setInteractive(on: boolean): void;
  /** Main saw the pointer leave the window while the island caught clicks; clicks pass through again. */
  onPointerLeft(listener: () => void): () => void;
  /**
   * Where the pointer is over the window (CSS px) while clicks pass through. The page gets no mouse events then: main
   * watches the pointer instead of a system-wide mouse hook.
   */
  onPointer(listener: (point: { x: number; y: number }) => void): () => void;
  open(key: string): void;
  openApp(): void;
  /** `dx`: CSS px since the drag started. */
  drag(phase: 'start' | 'move' | 'end', dx: number): void;
}
declare global { interface Window { threadtermIsland?: IslandBridge } }
