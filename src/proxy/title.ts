import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  NameAgentRequestSchema,
  NameAgentResponseSchema,
} from "../proto/agent_pb";
import { callCursorUnaryRpc, decodeConnectUnaryBody } from "../cursor";
import { SSE_HEADERS } from "./sse";

function deriveFallbackTitle(text: string): string {
  const cleaned = text
    .replace(/<[^>]+>/g, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/[^\p{L}\p{N}'’\-\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";

  const words = cleaned.split(" ").filter(Boolean).slice(0, 6);
  return finalizeTitle(words.map(titleCaseWord).join(" "));
}

function titleCaseWord(word: string): string {
  if (!word) return word;
  return word[0]!.toUpperCase() + word.slice(1);
}

function finalizeTitle(value: string): string {
  return value
    .replace(/^#{1,6}\s*/, "")
    .replace(/[.!?,:;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
}

function createBufferedSSETextResponse(
  modelId: string,
  text: string,
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  },
): Response {
  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);
  const payload =
    [
      {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      },
      {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
      {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: modelId,
        choices: [],
        usage,
      },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join("") + "data: [DONE]\n\n";

  return new Response(payload, { headers: SSE_HEADERS });
}

export async function handleTitleGenerationRequest(
  sourceText: string,
  accessToken: string,
  modelId: string,
  stream: boolean,
): Promise<Response> {
  const requestBody = toBinary(
    NameAgentRequestSchema,
    create(NameAgentRequestSchema, {
      userMessage: sourceText,
    }),
  );

  const response = await callCursorUnaryRpc({
    accessToken,
    rpcPath: "/agent.v1.AgentService/NameAgent",
    requestBody,
    timeoutMs: 5_000,
  });

  if (response.timedOut) {
    throw new Error("Cursor title generation timed out");
  }
  if (response.exitCode !== 0) {
    throw new Error(
      `Cursor title generation failed with HTTP ${response.exitCode}`,
    );
  }

  const payload = decodeConnectUnaryBody(response.body) ?? response.body;
  const decoded = fromBinary(NameAgentResponseSchema, payload);
  const title =
    finalizeTitle(decoded.name) ||
    deriveFallbackTitle(sourceText) ||
    "Untitled Session";
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  if (stream) {
    return createBufferedSSETextResponse(modelId, title, usage);
  }

  const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 28)}`;
  const created = Math.floor(Date.now() / 1000);
  return new Response(
    JSON.stringify({
      id: completionId,
      object: "chat.completion",
      created,
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: title },
          finish_reason: "stop",
        },
      ],
      usage,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}
