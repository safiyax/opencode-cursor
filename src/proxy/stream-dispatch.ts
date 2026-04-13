import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  AskQuestionInteractionResponseSchema,
  AskQuestionRejectedSchema,
  AskQuestionResultSchema,
  ClientHeartbeatSchema,
  ConversationStateStructureSchema,
  BackgroundShellSpawnResultSchema,
  CreatePlanRequestResponseSchema,
  DiagnosticsResultSchema,
  ExecClientControlMessageSchema,
  ExecClientMessageSchema,
  ExecClientStreamCloseSchema,
  ExaFetchRequestResponse_ApprovedSchema,
  ExaFetchRequestResponseSchema,
  ExaSearchRequestResponse_ApprovedSchema,
  ExaSearchRequestResponseSchema,
  GetBlobResultSchema,
  type InteractionQuery,
  InteractionResponseSchema,
  KvClientMessageSchema,
  McpInstructionsSchema,
  McpResultSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  SetBlobResultSchema,
  ShellRejectedSchema,
  SwitchModeRequestResponseSchema,
  WebSearchRequestResponse_ApprovedSchema,
  WebSearchRequestResponseSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
  type AgentServerMessage,
  type ConversationStateStructure,
  type ExecServerMessage,
  type KvServerMessage,
  type McpToolDefinition,
} from "../proto/agent_pb";
import { CONNECT_END_STREAM_FLAG } from "../cursor/config";
import { logPluginDebug, logPluginError, logPluginWarn } from "../logger";
import { decodeMcpArgsMap } from "../openai/tools";
import type { CursorSession } from "../cursor/bidi-session";
import { redirectNativeExecToTool } from "./native-tools";
import type { StreamState } from "./stream-state";
import type { PendingExec } from "./types";

export interface UnhandledExecInfo {
  execCase: string;
  execId: string;
  execMsgId: number;
}

export interface UnsupportedServerMessageInfo {
  category:
  | "agentMessage"
  | "interactionUpdate"
  | "interactionQuery"
  | "execServerControl"
  | "toolCall";
  caseName: string;
  detail?: string;
}

export interface McpToolCallUpdateInfo {
  updateCase: "partialToolCall" | "toolCallStarted" | "toolCallCompleted";
  toolCallId: string;
  modelCallId?: string;
  toolName?: string;
}

export interface StepUpdateInfo {
  updateCase: "stepStarted" | "stepCompleted";
  stepId: string;
  stepDurationMs?: string;
}

export function parseConnectEndStream(data: Uint8Array): Error | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(data));
    const error = payload?.error;
    if (error) {
      const code = error.code ?? "unknown";
      const message = error.message ?? "Unknown error";
      return new Error(`Connect error ${code}: ${message}`);
    }
    return null;
  } catch {
    return new Error("Failed to parse Connect end stream");
  }
}

export function makeHeartbeatBytes(): Uint8Array {
  const heartbeat = create(AgentClientMessageSchema, {
    message: {
      case: "clientHeartbeat",
      value: create(ClientHeartbeatSchema, {}),
    },
  });
  return toBinary(AgentClientMessageSchema, heartbeat);
}

export function scheduleBridgeEnd(bridge: CursorSession): void {
  queueMicrotask(() => {
    if (bridge.alive) bridge.end();
  });
}

/**
 * Create a stateful parser for Connect protocol frames.
 * Handles buffering partial data across chunks.
 */
export function createConnectFrameParser(
  onMessage: (bytes: Uint8Array) => void,
  onEndStream: (bytes: Uint8Array) => void,
): (incoming: Buffer) => void {
  let pending = Buffer.alloc(0);
  return (incoming: Buffer) => {
    pending = Buffer.concat([pending, incoming]);
    while (pending.length >= 5) {
      const flags = pending[0]!;
      const msgLen = pending.readUInt32BE(1);
      if (pending.length < 5 + msgLen) break;
      const messageBytes = pending.subarray(5, 5 + msgLen);
      pending = pending.subarray(5 + msgLen);
      if (flags & CONNECT_END_STREAM_FLAG) {
        onEndStream(messageBytes);
      } else {
        onMessage(messageBytes);
      }
    }
  };
}

const THINKING_TAG_NAMES = [
  "think",
  "thinking",
  "reasoning",
  "thought",
  "think_intent",
];
const MAX_THINKING_TAG_LEN = 16; // </think_intent> is 15 chars

/**
 * Strip thinking tags from streamed text, routing tagged content to reasoning.
 * Buffers partial tags across chunk boundaries.
 */
export function createThinkingTagFilter(): {
  process(text: string): { content: string; reasoning: string };
  flush(): { content: string; reasoning: string };
} {
  let buffer = "";
  let inThinking = false;

  return {
    process(text: string) {
      const input = buffer + text;
      buffer = "";
      let content = "";
      let reasoning = "";
      let lastIdx = 0;

      const re = new RegExp(
        `<(/?)(?:${THINKING_TAG_NAMES.join("|")})\\s*>`,
        "gi",
      );
      let match: RegExpExecArray | null;
      while ((match = re.exec(input)) !== null) {
        const before = input.slice(lastIdx, match.index);
        if (inThinking) reasoning += before;
        else content += before;
        inThinking = match[1] !== "/";
        lastIdx = re.lastIndex;
      }

      const rest = input.slice(lastIdx);
      // Buffer a trailing '<' that could be the start of a thinking tag.
      const ltPos = rest.lastIndexOf("<");
      if (
        ltPos >= 0 &&
        rest.length - ltPos < MAX_THINKING_TAG_LEN &&
        /^<\/?[a-z_]*$/i.test(rest.slice(ltPos))
      ) {
        buffer = rest.slice(ltPos);
        const before = rest.slice(0, ltPos);
        if (inThinking) reasoning += before;
        else content += before;
      } else {
        if (inThinking) reasoning += rest;
        else content += rest;
      }

      return { content, reasoning };
    },
    flush() {
      const b = buffer;
      buffer = "";
      if (!b) return { content: "", reasoning: "" };
      return inThinking
        ? { content: "", reasoning: b }
        : { content: b, reasoning: "" };
    },
  };
}

export function computeUsage(state: StreamState) {
  if (!state.checkpointSeen) {
    throw new Error(
      "Cannot report Cursor usage without checkpoint token details.",
    );
  }

  const completion_tokens = state.outputTokens;
  const total_tokens = state.totalTokens;
  const prompt_tokens = Math.max(0, total_tokens - completion_tokens);
  return { prompt_tokens, completion_tokens, total_tokens };
}

export function processServerMessage(
  msg: AgentServerMessage,
  blobStore: Map<string, Uint8Array>,
  cloudRule: string | undefined,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  state: StreamState,
  onText: (text: string, isThinking?: boolean) => void,
  onMcpExec: (exec: PendingExec) => void,
  onMcpToolCallUpdate?: (info: McpToolCallUpdateInfo) => void,
  onStepUpdate?: (info: StepUpdateInfo) => void,
  onCheckpoint?: (checkpointBytes: Uint8Array) => void,
  onTurnEnded?: () => void,
  onUnsupportedMessage?: (info: UnsupportedServerMessageInfo) => void,
  onUnhandledExec?: (info: UnhandledExecInfo) => void,
): void {
  const msgCase = msg.message.case;

  logPluginDebug("Received Cursor server signal", {
    messageCase: msgCase ?? "undefined",
    interactionCase:
      msgCase === "interactionUpdate"
        ? msg.message.value.message?.case ?? "undefined"
        : undefined,
    execCase:
      msgCase === "execServerMessage"
        ? msg.message.value.message?.case ?? "undefined"
        : undefined,
    interactionQueryCase:
      msgCase === "interactionQuery"
        ? msg.message.value.query?.case ?? "undefined"
        : undefined,
    kvCase:
      msgCase === "kvServerMessage"
        ? msg.message.value.message?.case ?? "undefined"
        : undefined,
  });

  if (msgCase === "interactionUpdate") {
    handleInteractionUpdate(
      msg.message.value,
      state,
      onText,
      onMcpToolCallUpdate,
      onStepUpdate,
      onTurnEnded,
      onUnsupportedMessage,
    );
  } else if (msgCase === "kvServerMessage") {
    handleKvMessage(msg.message.value as KvServerMessage, blobStore, sendFrame);
  } else if (msgCase === "execServerMessage") {
    handleExecMessage(
      msg.message.value as ExecServerMessage,
      cloudRule,
      mcpTools,
      sendFrame,
      state,
      onMcpExec,
      onUnhandledExec,
    );
  } else if (msgCase === "execServerControlMessage") {
    onUnsupportedMessage?.({
      category: "execServerControl",
      caseName: msg.message.value.message.case ?? "undefined",
    });
  } else if (msgCase === "interactionQuery") {
    handleInteractionQuery(
      msg.message.value as InteractionQuery,
      sendFrame,
      onUnsupportedMessage,
    );
  } else if (msgCase === "conversationCheckpointUpdate") {
    const stateStructure = msg.message.value as ConversationStateStructure;
    if (stateStructure.tokenDetails) {
      state.checkpointSeen = true;
      state.totalTokens = stateStructure.tokenDetails.usedTokens;
    }
    if (onCheckpoint) {
      onCheckpoint(toBinary(ConversationStateStructureSchema, stateStructure));
    }
  } else {
    onUnsupportedMessage?.({
      category: "agentMessage",
      caseName: msgCase ?? "undefined",
    });
  }
}

function handleInteractionUpdate(
  update: any,
  state: StreamState,
  onText: (text: string, isThinking?: boolean) => void,
  onMcpToolCallUpdate?: (info: McpToolCallUpdateInfo) => void,
  onStepUpdate?: (info: StepUpdateInfo) => void,
  onTurnEnded?: () => void,
  onUnsupportedMessage?: (info: UnsupportedServerMessageInfo) => void,
): void {
  const updateCase = update.message?.case;

  if (
    (updateCase === "partialToolCall" ||
      updateCase === "toolCallStarted" ||
      updateCase === "toolCallCompleted") &&
    update.message?.value?.toolCall?.tool?.case === "mcpToolCall"
  ) {
    const toolValue = update.message.value;
    const toolArgs = toolValue?.toolCall?.tool?.value?.args;
    const toolCallId = toolArgs?.toolCallId || toolValue.callId;
    if (toolCallId) {
      onMcpToolCallUpdate?.({
        updateCase,
        toolCallId,
        modelCallId: toolValue.modelCallId,
        toolName: toolArgs?.toolName || toolArgs?.name,
      });
    }
  }

  if (updateCase === "stepStarted" || updateCase === "stepCompleted") {
    const stepValue = update.message?.value;
    const stepId = stepValue?.stepId;
    if (stepId !== undefined && stepId !== null) {
      onStepUpdate?.({
        updateCase,
        stepId: String(stepId),
        stepDurationMs:
          updateCase === "stepCompleted" && stepValue?.stepDurationMs !== undefined
            ? String(stepValue.stepDurationMs)
            : undefined,
      });
    }
  }

  if (updateCase === "textDelta") {
    const delta = update.message.value.text || "";
    if (delta) onText(delta, false);
  } else if (updateCase === "thinkingDelta") {
    const delta = update.message.value.text || "";
    if (delta) onText(delta, true);
  } else if (updateCase === "tokenDelta") {
    state.outputTokens += update.message.value.tokens ?? 0;
  } else if (updateCase === "partialToolCall") {
    return;
  } else if (updateCase === "toolCallCompleted") {
    const toolValue = update.message.value;
    if (toolValue?.toolCall?.tool?.case === "mcpToolCall") {
      logPluginDebug("Ignoring Cursor interaction MCP tool completion", {
        callId: toolValue.callId,
        modelCallId: toolValue.modelCallId,
        toolCallId:
          toolValue.toolCall.tool.value?.args?.toolCallId || toolValue.callId,
        toolName:
          toolValue.toolCall.tool.value?.args?.toolName ||
          toolValue.toolCall.tool.value?.args?.name,
      });
    }
  } else if (updateCase === "turnEnded") {
    onTurnEnded?.();
  } else if (
    updateCase === "toolCallStarted" ||
    updateCase === "toolCallDelta" ||
    updateCase === "thinkingCompleted" ||
    updateCase === "userMessageAppended" ||
    updateCase === "summary" ||
    updateCase === "summaryStarted" ||
    updateCase === "summaryCompleted" ||
    updateCase === "heartbeat" ||
    updateCase === "stepStarted" ||
    updateCase === "stepCompleted"
  ) {
    return;
  } else {
    onUnsupportedMessage?.({
      category: "interactionUpdate",
      caseName: updateCase ?? "undefined",
    });
  }
  // Interaction tool-call updates are informational only. Resumable MCP tool
  // execution comes from execServerMessage.mcpArgs.
}

function handleInteractionQuery(
  query: InteractionQuery,
  sendFrame: (data: Uint8Array) => void,
  onUnsupportedMessage?: (info: UnsupportedServerMessageInfo) => void,
): void {
  const queryCase = query.query.case;

  if (queryCase === "webSearchRequestQuery") {
    const response = create(WebSearchRequestResponseSchema, {
      result: {
        case: "approved",
        value: create(WebSearchRequestResponse_ApprovedSchema, {}),
      },
    });
    sendInteractionResponse(
      query.id,
      "webSearchRequestResponse",
      response,
      sendFrame,
    );
    return;
  }

  if (queryCase === "askQuestionInteractionQuery") {
    const response = create(AskQuestionInteractionResponseSchema, {
      result: create(AskQuestionResultSchema, {
        result: {
          case: "rejected",
          value: create(AskQuestionRejectedSchema, {
            reason: "Non-interactive session",
          }),
        },
      }),
    });
    sendInteractionResponse(
      query.id,
      "askQuestionInteractionResponse",
      response,
      sendFrame,
    );
    return;
  }

  if (queryCase === "switchModeRequestQuery") {
    const response = create(SwitchModeRequestResponseSchema, {});
    sendInteractionResponse(
      query.id,
      "switchModeRequestResponse",
      response,
      sendFrame,
    );
    return;
  }

  if (queryCase === "exaSearchRequestQuery") {
    const response = create(ExaSearchRequestResponseSchema, {
      result: {
        case: "approved",
        value: create(ExaSearchRequestResponse_ApprovedSchema, {}),
      },
    });
    sendInteractionResponse(
      query.id,
      "exaSearchRequestResponse",
      response,
      sendFrame,
    );
    return;
  }

  if (queryCase === "exaFetchRequestQuery") {
    const response = create(ExaFetchRequestResponseSchema, {
      result: {
        case: "approved",
        value: create(ExaFetchRequestResponse_ApprovedSchema, {}),
      },
    });
    sendInteractionResponse(
      query.id,
      "exaFetchRequestResponse",
      response,
      sendFrame,
    );
    return;
  }

  if (queryCase === "createPlanRequestQuery") {
    const response = create(CreatePlanRequestResponseSchema, {});
    sendInteractionResponse(
      query.id,
      "createPlanRequestResponse",
      response,
      sendFrame,
    );
    return;
  }

  const response = create(InteractionResponseSchema, { id: query.id });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "interactionResponse", value: response },
  });
  sendFrame(toBinary(AgentClientMessageSchema, clientMessage));
}

/** Send a KV client response back to Cursor. */
function sendKvResponse(
  kvMsg: KvServerMessage,
  messageCase: string,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  const response = create(KvClientMessageSchema, {
    id: kvMsg.id,
    message: { case: messageCase as any, value: value as any },
  });
  const clientMsg = create(AgentClientMessageSchema, {
    message: { case: "kvClientMessage", value: response },
  });
  sendFrame(toBinary(AgentClientMessageSchema, clientMsg));
}

function sendInteractionResponse(
  queryId: number,
  messageCase: string,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  const response = create(InteractionResponseSchema, {
    id: queryId,
    result: { case: messageCase as any, value: value as any },
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "interactionResponse", value: response },
  });
  sendFrame(toBinary(AgentClientMessageSchema, clientMessage));
}

function handleKvMessage(
  kvMsg: KvServerMessage,
  blobStore: Map<string, Uint8Array>,
  sendFrame: (data: Uint8Array) => void,
): void {
  const kvCase = kvMsg.message.case;

  if (kvCase === "getBlobArgs") {
    const blobId = kvMsg.message.value.blobId;
    const blobIdKey = Buffer.from(blobId).toString("hex");
    const blobData = blobStore.get(blobIdKey);
    if (!blobData) {
      logPluginWarn("Cursor requested missing blob", {
        blobId: blobIdKey,
        knownBlobCount: blobStore.size,
      });
    }
    sendKvResponse(
      kvMsg,
      "getBlobResult",
      create(GetBlobResultSchema, blobData ? { blobData } : {}),
      sendFrame,
    );
  } else if (kvCase === "setBlobArgs") {
    const { blobId, blobData } = kvMsg.message.value;
    blobStore.set(Buffer.from(blobId).toString("hex"), blobData);
    sendKvResponse(
      kvMsg,
      "setBlobResult",
      create(SetBlobResultSchema, {}),
      sendFrame,
    );
  }
}

function handleExecMessage(
  execMsg: ExecServerMessage,
  cloudRule: string | undefined,
  mcpTools: McpToolDefinition[],
  sendFrame: (data: Uint8Array) => void,
  state: StreamState,
  onMcpExec: (exec: PendingExec) => void,
  onUnhandledExec?: (info: UnhandledExecInfo) => void,
): void {
  const execCase = execMsg.message.case;

  if (execCase === "requestContextArgs") {
    logPluginDebug("Responding to Cursor requestContextArgs", {
      execId: execMsg.execId,
      execMsgId: execMsg.id,
      mcpToolCount: mcpTools.length,
    });
    const requestContext = create(RequestContextSchema, {
      rules: [],
      repositoryInfo: [],
      tools: mcpTools,
      gitRepos: [],
      projectLayouts: [],
      cloudRule,
      webSearchEnabled: false,
      repositoryInfoShouldQueryProd: false,
      fileContents: {},
      customSubagents: [],
    });
    const result = create(RequestContextResultSchema, {
      result: {
        case: "success",
        value: create(RequestContextSuccessSchema, { requestContext }),
      },
    });
    sendExecResult(execMsg, "requestContextResult", result, sendFrame);
    return;
  }

  if (execCase === "mcpArgs") {
    const mcpArgs = execMsg.message.value;
    const decoded = decodeMcpArgsMap(mcpArgs.args ?? {});
    const exec = {
      execId: execMsg.execId,
      execMsgId: execMsg.id,
      toolCallId: mcpArgs.toolCallId || crypto.randomUUID(),
      toolName: mcpArgs.toolName || mcpArgs.name,
      decodedArgs: JSON.stringify(decoded),
      source: "exec" as const,
    };
    logPluginDebug("Received Cursor exec MCP tool metadata", {
      toolCallId: exec.toolCallId,
      toolName: exec.toolName,
      source: exec.source,
      execId: exec.execId,
      execMsgId: exec.execMsgId,
      decodedArgs: exec.decodedArgs,
    });
    onMcpExec(exec);
    return;
  }

  const redirectedExec = redirectNativeExecToTool(execMsg, mcpTools);
  if (redirectedExec) {
    logPluginDebug("Redirecting native Cursor tool to provided tool", {
      execCase,
      execId: execMsg.execId,
      execMsgId: execMsg.id,
      toolCallId: redirectedExec.toolCallId,
      toolName: redirectedExec.toolName,
      nativeResultType: redirectedExec.nativeResultType,
    });
    onMcpExec(redirectedExec);
    return;
  }

  // --- Handle remaining unsupported native tools ---
  const REJECT_REASON =
    "Tool not available in this environment. Use the MCP tools provided instead.";

  if (execCase === "backgroundShellSpawnArgs") {
    logPluginDebug("Rejecting unsupported Cursor background shell tool", {
      execId: execMsg.execId,
      execMsgId: execMsg.id,
      command: execMsg.message.value.command ?? "",
      workingDirectory: execMsg.message.value.workingDirectory ?? "",
    });
    const args = execMsg.message.value;
    const result = create(BackgroundShellSpawnResultSchema, {
      result: {
        case: "rejected",
        value: create(ShellRejectedSchema, {
          command: args.command ?? "",
          workingDirectory: args.workingDirectory ?? "",
          reason: REJECT_REASON,
          isReadonly: false,
        }),
      },
    });
    sendExecResult(execMsg, "backgroundShellSpawnResult", result, sendFrame);
    return;
  }
  if (execCase === "writeShellStdinArgs") {
    logPluginDebug("Rejecting unsupported Cursor shell stdin tool", {
      execId: execMsg.execId,
      execMsgId: execMsg.id,
    });
    const result = create(WriteShellStdinResultSchema, {
      result: {
        case: "error",
        value: create(WriteShellStdinErrorSchema, { error: REJECT_REASON }),
      },
    });
    sendExecResult(execMsg, "writeShellStdinResult", result, sendFrame);
    return;
  }
  if (execCase === "diagnosticsArgs") {
    logPluginDebug("Responding to Cursor diagnostics exec", {
      execId: execMsg.execId,
      execMsgId: execMsg.id,
      path: execMsg.message.value.path,
    });
    const result = create(DiagnosticsResultSchema, {});
    sendExecResult(execMsg, "diagnosticsResult", result, sendFrame);
    return;
  }

  // MCP resource/screen/computer exec types
  const miscCaseMap: Record<string, string> = {
    listMcpResourcesExecArgs: "listMcpResourcesExecResult",
    readMcpResourceExecArgs: "readMcpResourceExecResult",
    recordScreenArgs: "recordScreenResult",
    computerUseArgs: "computerUseResult",
  };
  const resultCase = miscCaseMap[execCase as string];
  if (resultCase) {
    logPluginDebug("Responding to miscellaneous Cursor exec message", {
      execCase,
      execId: execMsg.execId,
      execMsgId: execMsg.id,
      resultCase,
    });
    sendExecResult(execMsg, resultCase, create(McpResultSchema, {}), sendFrame);
    return;
  }

  logPluginWarn("Unhandled Cursor exec type, sending empty result", {
    execCase: execCase ?? "undefined",
    execId: execMsg.execId,
    execMsgId: execMsg.id,
  });
  sendUnknownExecResult(execMsg, sendFrame);
  onUnhandledExec?.({
    execCase: execCase ?? "undefined",
    execId: execMsg.execId,
    execMsgId: execMsg.id,
  });
}

/** Send an exec client message back to Cursor. */
function sendExecResult(
  execMsg: ExecServerMessage,
  messageCase: string,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  const execClientMessage = create(ExecClientMessageSchema, {
    id: execMsg.id,
    execId: execMsg.execId,
    message: { case: messageCase as any, value: value as any },
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "execClientMessage", value: execClientMessage },
  });
  sendFrame(toBinary(AgentClientMessageSchema, clientMessage));
  sendExecStreamClose(execMsg.id, sendFrame);
}

function sendExecStreamClose(
  execMsgId: number,
  sendFrame: (data: Uint8Array) => void,
): void {
  const controlMsg = create(ExecClientControlMessageSchema, {
    message: {
      case: "streamClose",
      value: create(ExecClientStreamCloseSchema, { id: execMsgId }),
    },
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "execClientControlMessage", value: controlMsg },
  });
  sendFrame(toBinary(AgentClientMessageSchema, clientMessage));
}

function sendUnknownExecResult(
  execMsg: ExecServerMessage,
  sendFrame: (data: Uint8Array) => void,
): void {
  const unknownFields: Array<{ no: number; wireType: number; data: Uint8Array }> | undefined = (
    execMsg as any
  ).$unknown;
  const argsField = unknownFields?.find(
    (field) => field.wireType === 2 && field.no !== 1 && field.no !== 15 && field.no !== 19,
  );
  if (!argsField) return;

  const execClientMessage = create(ExecClientMessageSchema, {
    id: execMsg.id,
    execId: execMsg.execId,
  });
  (execClientMessage as any).$unknown = [
    { no: argsField.no, wireType: 2, data: new Uint8Array(0) },
  ];
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "execClientMessage", value: execClientMessage },
  });
  sendFrame(toBinary(AgentClientMessageSchema, clientMessage));
  sendExecStreamClose(execMsg.id, sendFrame);
}
