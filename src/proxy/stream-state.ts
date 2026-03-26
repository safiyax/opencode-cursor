import type { PendingExec } from "./types";

export interface StreamState {
  toolCallIndex: number;
  pendingExecs: PendingExec[];
  outputTokens: number;
  totalTokens: number;
  interactionToolArgsText: Map<string, string>;
  emittedToolCallIds: Set<string>;
  deferredInteractionExecs: Map<string, PendingExec>;
  deferredInteractionExecTimers: Map<string, NodeJS.Timeout>;
}
