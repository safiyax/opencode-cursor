export interface ConversationRequestMetadata {
  systemPrompt: string;
  systemPromptHash: string;
  completedTurnsFingerprint: string;
  turns: Array<{ userText: string; assistantText: string }>;
  userText: string;
  assistantSeedText?: string;
  agentKey?: string;
}
