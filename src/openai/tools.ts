import {
  create,
  fromBinary,
  fromJson,
  toBinary,
  toJson,
  type JsonValue,
} from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { McpToolDefinition } from "../proto/agent_pb";
import { McpToolDefinitionSchema } from "../proto/agent_pb";

import type { OpenAIToolDef } from "./types";

export function selectToolsForChoice(
  tools: OpenAIToolDef[],
  toolChoice: unknown,
): OpenAIToolDef[] {
  if (!tools.length) return [];
  if (
    toolChoice === undefined ||
    toolChoice === null ||
    toolChoice === "auto" ||
    toolChoice === "required"
  ) {
    return tools;
  }
  if (toolChoice === "none") {
    return [];
  }

  if (typeof toolChoice === "object") {
    const choice = toolChoice as {
      type?: unknown;
      function?: { name?: unknown };
    };
    if (
      choice.type === "function" &&
      typeof choice.function?.name === "string"
    ) {
      return tools.filter(
        (tool) => tool.function.name === choice.function!.name,
      );
    }
  }

  return tools;
}

/** Convert OpenAI tool definitions to Cursor's MCP tool protobuf format. */
export function buildMcpToolDefinitions(
  tools: OpenAIToolDef[],
): McpToolDefinition[] {
  return tools.map((t) => {
    const fn = t.function;
    const jsonSchema: JsonValue =
      fn.parameters && typeof fn.parameters === "object"
        ? (fn.parameters as JsonValue)
        : { type: "object", properties: {}, required: [] };
    const inputSchema = toBinary(
      ValueSchema,
      fromJson(ValueSchema, jsonSchema),
    );
    return create(McpToolDefinitionSchema, {
      name: fn.name,
      description: fn.description || "",
      providerIdentifier: "opencode",
      toolName: fn.name,
      inputSchema,
    });
  });
}

/** Decode a Cursor MCP arg value (protobuf Value bytes) to a JS value. */
function decodeMcpArgValue(value: Uint8Array): unknown {
  try {
    const parsed = fromBinary(ValueSchema, value);
    return toJson(ValueSchema, parsed);
  } catch {}
  return new TextDecoder().decode(value);
}

/** Decode a map of MCP arg values. */
export function decodeMcpArgsMap(
  args: Record<string, Uint8Array>,
): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    decoded[key] = decodeMcpArgValue(value);
  }
  return decoded;
}
