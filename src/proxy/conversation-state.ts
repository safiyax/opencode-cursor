import { createHash } from "node:crypto";
import type { OpenAIMessage } from "../openai/types";
import {
  buildCompletedTurnsFingerprint,
  textContent,
} from "../openai/messages";
import type { ActiveBridge } from "./types";

// Active bridges keyed by a session token (derived from conversation state).
// When tool_calls are returned, the bridge stays alive. The next request
// with tool results looks up the bridge and sends mcpResult messages.
export const activeBridges = new Map<string, ActiveBridge>();

export interface StoredConversation {
  conversationId: string;
  checkpoint: Uint8Array | null;
  blobStore: Map<string, Uint8Array>;
  lastAccessMs: number;
  systemPromptHash: string;
  completedTurnsFingerprint: string;
}

export const conversationStates = new Map<string, StoredConversation>();
const CONVERSATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function evictStaleConversations(): void {
  const now = Date.now();
  for (const [key, stored] of conversationStates) {
    if (now - stored.lastAccessMs > CONVERSATION_TTL_MS) {
      conversationStates.delete(key);
    }
  }
}

export function normalizeAgentKey(agentKey?: string): string {
  const trimmed = agentKey?.trim();
  return trimmed ? trimmed : "default";
}

export function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createStoredConversation(): StoredConversation {
  return {
    conversationId: crypto.randomUUID(),
    checkpoint: null,
    blobStore: new Map(),
    lastAccessMs: Date.now(),
    systemPromptHash: "",
    completedTurnsFingerprint: "",
  };
}

export function resetStoredConversation(stored: StoredConversation): void {
  stored.conversationId = crypto.randomUUID();
  stored.checkpoint = null;
  stored.blobStore = new Map();
  stored.lastAccessMs = Date.now();
  stored.systemPromptHash = "";
  stored.completedTurnsFingerprint = "";
}

export function deriveBridgeKey(
  modelId: string,
  messages: OpenAIMessage[],
  sessionId?: string,
  agentKey?: string,
): string {
  if (sessionId) {
    const normalizedAgent = normalizeAgentKey(agentKey);
    return createHash("sha256")
      .update(`bridge:${sessionId}:${normalizedAgent}`)
      .digest("hex")
      .slice(0, 16);
  }

  const firstUserMsg = messages.find((m) => m.role === "user");
  const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : "";
  const normalizedAgent = normalizeAgentKey(agentKey);
  return createHash("sha256")
    .update(
      `bridge:${normalizedAgent}:${modelId}:${firstUserText.slice(0, 200)}`,
    )
    .digest("hex")
    .slice(0, 16);
}

/** Derive a key for conversation state. Model-independent so context survives model switches. */
export function deriveConversationKey(
  messages: OpenAIMessage[],
  sessionId?: string,
  agentKey?: string,
): string {
  if (sessionId) {
    const normalizedAgent = normalizeAgentKey(agentKey);
    return createHash("sha256")
      .update(`session:${sessionId}:${normalizedAgent}`)
      .digest("hex")
      .slice(0, 16);
  }

  return createHash("sha256")
    .update(
      `${normalizeAgentKey(agentKey)}:${buildConversationFingerprint(messages)}`,
    )
    .digest("hex")
    .slice(0, 16);
}

export function buildConversationFingerprint(
  messages: OpenAIMessage[],
): string {
  return messages
    .map((message) => {
      const toolCallIDs = (message.tool_calls ?? [])
        .map((call: { id: string }) => call.id)
        .join(",");
      return `${message.role}:${textContent(message.content)}:${message.tool_call_id ?? ""}:${toolCallIDs}`;
    })
    .join("\n---\n");
}

interface ConversationRequestMetadata {
  systemPrompt: string;
  systemPromptHash: string;
  completedTurnsFingerprint: string;
  turns: Array<{ userText: string; assistantText: string }>;
  userText: string;
  assistantSeedText?: string;
  agentKey?: string;
}

export function updateStoredConversationAfterCompletion(
  convKey: string,
  metadata: ConversationRequestMetadata,
  assistantText: string,
): void {
  const stored = conversationStates.get(convKey);
  if (!stored) return;

  const nextTurns = metadata.userText
    ? [
        ...metadata.turns,
        { userText: metadata.userText, assistantText: assistantText.trim() },
      ]
    : metadata.turns;

  stored.systemPromptHash = metadata.systemPromptHash;
  stored.completedTurnsFingerprint = buildCompletedTurnsFingerprint(
    metadata.systemPrompt,
    nextTurns,
  );
  stored.lastAccessMs = Date.now();
}
