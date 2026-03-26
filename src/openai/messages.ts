import { createHash } from "node:crypto";
import { OPENCODE_TITLE_REQUEST_MARKER } from "../constants";
import type {
  ChatCompletionRequest,
  ContentPart,
  OpenAIMessage,
  OpenAIToolCall,
} from "./types";

export interface ToolResultInfo {
  toolCallId: string;
  content: string;
}

interface ParsedMessages {
  systemPrompt: string;
  userText: string;
  turns: Array<{ userText: string; assistantText: string }>;
  toolResults: ToolResultInfo[];
  pendingAssistantSummary: string;
  completedTurnsFingerprint: string;
  assistantContinuation: boolean;
}

/** Normalize OpenAI message content to a plain string. */
export function textContent(content: OpenAIMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p: ContentPart) => p.type === "text" && p.text)
    .map((p: ContentPart) => p.text!)
    .join("\n");
}

interface TurnSegmentText {
  kind: "assistantText";
  text: string;
}

interface TurnSegmentToolCalls {
  kind: "assistantToolCalls";
  toolCalls: OpenAIToolCall[];
}

interface TurnSegmentToolResult {
  kind: "toolResult";
  result: ToolResultInfo;
}

type TurnSegment =
  | TurnSegmentText
  | TurnSegmentToolCalls
  | TurnSegmentToolResult;

interface ParsedTurnState {
  userText: string;
  segments: TurnSegment[];
}

export function parseMessages(messages: OpenAIMessage[]): ParsedMessages {
  let systemPrompt = "You are a helpful assistant.";

  // Collect system messages
  const systemParts = messages
    .filter((m) => m.role === "system")
    .map((m) => textContent(m.content));
  if (systemParts.length > 0) {
    systemPrompt = systemParts.join("\n");
  }

  const nonSystem = messages.filter((m) => m.role !== "system");
  const parsedTurns: ParsedTurnState[] = [];
  let currentTurn: ParsedTurnState | undefined;

  for (const msg of nonSystem) {
    if (msg.role === "user") {
      if (currentTurn) parsedTurns.push(currentTurn);
      currentTurn = {
        userText: textContent(msg.content),
        segments: [],
      };
      continue;
    }

    if (!currentTurn) {
      currentTurn = { userText: "", segments: [] };
    }

    if (msg.role === "assistant") {
      const text = textContent(msg.content);
      if (text) {
        currentTurn.segments.push({ kind: "assistantText", text });
      }
      if (msg.tool_calls?.length) {
        currentTurn.segments.push({
          kind: "assistantToolCalls",
          toolCalls: msg.tool_calls,
        });
      }
      continue;
    }

    if (msg.role === "tool") {
      currentTurn.segments.push({
        kind: "toolResult",
        result: {
          toolCallId: msg.tool_call_id ?? "",
          content: textContent(msg.content),
        },
      });
    }
  }

  if (currentTurn) parsedTurns.push(currentTurn);

  let userText = "";
  let toolResults: ToolResultInfo[] = [];
  let pendingAssistantSummary = "";
  let assistantContinuation = false;
  let completedTurnStates = parsedTurns;

  const lastTurn = parsedTurns.at(-1);
  if (lastTurn) {
    const trailingSegments = splitTrailingToolResults(lastTurn.segments);
    const hasAssistantSummary = trailingSegments.base.length > 0;

    if (trailingSegments.trailing.length > 0 && hasAssistantSummary) {
      completedTurnStates = parsedTurns.slice(0, -1);
      userText = lastTurn.userText;
      toolResults = trailingSegments.trailing.map((segment) => segment.result);
      pendingAssistantSummary = summarizeTurnSegments(trailingSegments.base);
    } else if (lastTurn.userText && lastTurn.segments.length === 0) {
      completedTurnStates = parsedTurns.slice(0, -1);
      userText = lastTurn.userText;
    } else if (lastTurn.userText && hasAssistantSummary) {
      completedTurnStates = parsedTurns.slice(0, -1);
      userText = lastTurn.userText;
      pendingAssistantSummary = summarizeTurnSegments(lastTurn.segments);
      assistantContinuation = true;
    }
  }

  const turns = completedTurnStates
    .map((turn) => ({
      userText: turn.userText,
      assistantText: summarizeTurnSegments(turn.segments),
    }))
    .filter((turn) => turn.userText || turn.assistantText);

  return {
    systemPrompt,
    userText,
    turns,
    toolResults,
    pendingAssistantSummary,
    completedTurnsFingerprint: buildCompletedTurnsFingerprint(
      systemPrompt,
      turns,
    ),
    assistantContinuation,
  };
}

function splitTrailingToolResults(segments: TurnSegment[]): {
  base: TurnSegment[];
  trailing: TurnSegmentToolResult[];
} {
  let index = segments.length;
  while (index > 0 && segments[index - 1]?.kind === "toolResult") {
    index -= 1;
  }

  return {
    base: segments.slice(0, index),
    trailing: segments
      .slice(index)
      .filter(
        (segment): segment is TurnSegmentToolResult =>
          segment.kind === "toolResult",
      ),
  };
}

function summarizeTurnSegments(segments: TurnSegment[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "assistantText") {
      const trimmed = segment.text.trim();
      if (trimmed) parts.push(trimmed);
      continue;
    }

    if (segment.kind === "assistantToolCalls") {
      const summary = segment.toolCalls.map(formatToolCallSummary).join("\n\n");
      if (summary) parts.push(summary);
      continue;
    }

    parts.push(formatToolResultSummary(segment.result));
  }

  return parts.join("\n\n").trim();
}

export function formatToolCallSummary(call: OpenAIToolCall): string {
  const args = call.function.arguments?.trim();
  return args
    ? `[assistant requested tool ${call.function.name} id=${call.id}]\n${args}`
    : `[assistant requested tool ${call.function.name} id=${call.id}]`;
}

export function formatToolResultSummary(result: ToolResultInfo): string {
  const label = result.toolCallId
    ? `[tool result id=${result.toolCallId}]`
    : "[tool result]";
  const content = result.content.trim();
  return content ? `${label}\n${content}` : label;
}

export function buildCompletedTurnsFingerprint(
  systemPrompt: string,
  turns: Array<{ userText: string; assistantText: string }>,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ systemPrompt, turns }))
    .digest("hex");
}

export function buildToolResumePrompt(
  userText: string,
  pendingAssistantSummary: string,
  toolResults: ToolResultInfo[],
): string {
  const parts = [userText.trim()];
  if (pendingAssistantSummary.trim()) {
    parts.push(
      `[previous assistant tool activity]\n${pendingAssistantSummary.trim()}`,
    );
  }
  if (toolResults.length > 0) {
    parts.push(toolResults.map(formatToolResultSummary).join("\n\n"));
  }
  return parts.filter(Boolean).join("\n\n");
}

export function buildInitialHandoffPrompt(
  userText: string,
  turns: Array<{ userText: string; assistantText: string }>,
  pendingAssistantSummary: string,
  toolResults: ToolResultInfo[],
): string {
  const transcript = turns.map((turn, index) => {
    const sections = [`Turn ${index + 1}`];
    if (turn.userText.trim()) sections.push(`User: ${turn.userText.trim()}`);
    if (turn.assistantText.trim())
      sections.push(`Assistant: ${turn.assistantText.trim()}`);
    return sections.join("\n");
  });

  const inProgress = buildToolResumePrompt(
    "",
    pendingAssistantSummary,
    toolResults,
  ).trim();
  const history = [
    ...transcript,
    ...(inProgress ? [`In-progress turn\n${inProgress}`] : []),
  ]
    .join("\n\n")
    .trim();

  if (!history) return userText;

  return [
    "[OpenCode session handoff]",
    "You are continuing an existing session that previously ran on another provider/model.",
    "Treat the transcript below as prior conversation history before answering the latest user message.",
    "",
    "<previous-session-transcript>",
    history,
    "</previous-session-transcript>",
    "",
    "Latest user message:",
    userText.trim(),
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildTitleSourceText(
  userText: string,
  turns: Array<{ userText: string; assistantText: string }>,
  pendingAssistantSummary: string,
  toolResults: ToolResultInfo[],
): string {
  const history = turns
    .map((turn) =>
      [
        isTitleRequestMarker(turn.userText) ? "" : turn.userText.trim(),
        turn.assistantText.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .filter(Boolean);
  if (pendingAssistantSummary.trim()) {
    history.push(pendingAssistantSummary.trim());
  }
  if (toolResults.length > 0) {
    history.push(toolResults.map(formatToolResultSummary).join("\n\n"));
  }
  if (userText.trim() && !isTitleRequestMarker(userText)) {
    history.push(userText.trim());
  }
  return history.join("\n\n").trim();
}

export function detectTitleRequest(body: ChatCompletionRequest): {
  matched: boolean;
  reason: string;
} {
  if ((body.tools?.length ?? 0) > 0) {
    return { matched: false, reason: "tools-present" };
  }

  const firstNonSystem = body.messages.find(
    (message: OpenAIMessage) => message.role !== "system",
  );
  if (
    firstNonSystem?.role === "user" &&
    isTitleRequestMarker(textContent(firstNonSystem.content))
  ) {
    return { matched: true, reason: "opencode-title-marker" };
  }

  return { matched: false, reason: "no-title-marker" };
}

function isTitleRequestMarker(text: string): boolean {
  return text.trim() === OPENCODE_TITLE_REQUEST_MARKER;
}
