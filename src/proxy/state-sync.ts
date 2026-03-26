import { conversationStates } from "./conversation-state";

export function updateConversationCheckpoint(
  convKey: string,
  checkpointBytes: Uint8Array,
): void {
  const stored = conversationStates.get(convKey);
  if (!stored) return;

  stored.checkpoint = checkpointBytes;
  stored.lastAccessMs = Date.now();
}

export function syncStoredBlobStore(
  convKey: string,
  blobStore: Map<string, Uint8Array>,
): void {
  const stored = conversationStates.get(convKey);
  if (!stored) return;

  for (const [key, value] of blobStore) {
    stored.blobStore.set(key, value);
  }
  stored.lastAccessMs = Date.now();
}
