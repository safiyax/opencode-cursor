import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  DeleteResultSchema,
  DeleteSuccessSchema,
  ExecClientControlMessageSchema,
  ExecClientMessageSchema,
  ExecClientStreamCloseSchema,
  FetchResultSchema,
  FetchSuccessSchema,
  GrepContentMatchSchema,
  GrepContentResultSchema,
  GrepFileCountSchema,
  GrepFileMatchSchema,
  GrepFilesResultSchema,
  GrepCountResultSchema,
  GrepResultSchema,
  GrepSuccessSchema,
  GrepUnionResultSchema,
  LsDirectoryTreeNodeSchema,
  LsDirectoryTreeNode_FileSchema,
  LsResultSchema,
  LsSuccessSchema,
  McpErrorSchema,
  McpResultSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolResultContentItemSchema,
  ReadResultSchema,
  ReadSuccessSchema,
  ShellResultSchema,
  ShellStreamExitSchema,
  ShellStreamSchema,
  ShellStreamStartSchema,
  ShellStreamStdoutSchema,
  ShellSuccessSchema,
  WriteResultSchema,
  WriteSuccessSchema,
  type ExecServerMessage,
  type McpToolDefinition,
} from "../proto/agent_pb";
import type { PendingExec } from "./types";

type NativeResultType =
  | "deleteResult"
  | "fetchResult"
  | "grepResult"
  | "lsResult"
  | "readResult"
  | "shellResult"
  | "shellStreamResult"
  | "writeResult";

interface NativeRewrite {
  toolCallId: string;
  toolName: string;
  decodedArgs: string;
  nativeResultType?: NativeResultType;
  nativeArgs?: Record<string, string>;
}

interface BridgeWriter {
  write: (data: Uint8Array) => void;
}

export function redirectNativeExecToTool(
  execMsg: ExecServerMessage,
  mcpTools: McpToolDefinition[],
): PendingExec | null {
  const execCase = execMsg.message.case;
  const args = execMsg.message.value as any;
  const toolCallId = args?.toolCallId || crypto.randomUUID();
  const availableToolNames = new Set(
    mcpTools
      .map((tool) => tool.name || tool.toolName)
      .filter((name): name is string => Boolean(name)),
  );

  const rewrite = buildNativeRewrite(execCase, args, toolCallId, availableToolNames);
  if (!rewrite) return null;

  return {
    execId: execMsg.execId,
    execMsgId: execMsg.id,
    toolCallId: rewrite.toolCallId,
    toolName: rewrite.toolName,
    decodedArgs: rewrite.decodedArgs,
    source: "nativeExec",
    nativeResultType: rewrite.nativeResultType,
    nativeArgs: rewrite.nativeArgs,
  };
}

function buildNativeRewrite(
  execCase: string | undefined,
  args: any,
  toolCallId: string,
  availableToolNames: Set<string>,
): NativeRewrite | null {
  if (execCase === "readArgs") {
    const toolName = pickTool(availableToolNames, ["read"]);
    if (!toolName) return null;
    const decodedArgs: Record<string, unknown> = { filePath: args.path ?? "" };
    if (args.offset != null && args.offset !== 0) decodedArgs.offset = args.offset;
    if (args.limit != null && args.limit !== 0) decodedArgs.limit = args.limit;
    return {
      toolCallId,
      toolName,
      decodedArgs: JSON.stringify(decodedArgs),
      nativeResultType: "readResult",
      nativeArgs: { path: String(args.path ?? "") },
    };
  }

  if (execCase === "writeArgs") {
    const path = String(args.path ?? "");
    const content = decodeWriteContent(args);
    const writeTool = pickTool(availableToolNames, ["write"]);
    if (!writeTool) return null;
    return {
      toolCallId,
      toolName: writeTool,
      decodedArgs: JSON.stringify({ filePath: path, content }),
      nativeResultType: "writeResult",
      nativeArgs: {
        path,
        fileSize: String(new TextEncoder().encode(content).byteLength),
        linesCreated: String(content.split("\n").length),
      },
    };
  }

  if (execCase === "deleteArgs") {
    const directDeleteTool = pickTool(availableToolNames, ["delete"]);
    const path = String(args.path ?? "");
    if (directDeleteTool) {
      return {
        toolCallId,
        toolName: directDeleteTool,
        decodedArgs: JSON.stringify({ filePath: path }),
        nativeResultType: "deleteResult",
        nativeArgs: { path },
      };
    }

    const bashTool = pickTool(availableToolNames, ["bash"]);
    if (!bashTool) return null;
    return {
      toolCallId,
      toolName: bashTool,
      decodedArgs: JSON.stringify({
        command: path ? `rm -rf -- ${shellQuote(path)}` : "true",
        description: path ? "Deletes target path" : "No-op delete",
      }),
      nativeResultType: "deleteResult",
      nativeArgs: { path },
    };
  }

  if (execCase === "fetchArgs") {
    const toolName = pickTool(availableToolNames, ["webfetch", "fetch", "web_fetch"]);
    if (!toolName) return null;
    return {
      toolCallId,
      toolName,
      decodedArgs: JSON.stringify({ url: String(args.url ?? "") }),
      nativeResultType: "fetchResult",
      nativeArgs: { url: String(args.url ?? "") },
    };
  }

  if (execCase === "shellArgs" || execCase === "shellStreamArgs") {
    const toolName = pickTool(availableToolNames, ["bash"]);
    if (!toolName) return null;
    const decodedArgs: Record<string, unknown> = {
      command: String(args.command ?? ""),
      description: String(args.description || "Executes shell command"),
    };
    if (args.workingDirectory) decodedArgs.workdir = String(args.workingDirectory);
    if (args.timeout != null && args.timeout > 0) decodedArgs.timeout = args.timeout;
    return {
      toolCallId,
      toolName,
      decodedArgs: JSON.stringify(decodedArgs),
      nativeResultType:
        execCase === "shellStreamArgs" ? "shellStreamResult" : "shellResult",
      nativeArgs: {
        command: String(args.command ?? ""),
        workingDirectory: String(args.workingDirectory ?? ""),
      },
    };
  }

  if (execCase === "lsArgs") {
    const toolName = pickTool(availableToolNames, ["glob"]);
    if (!toolName) return null;
    return {
      toolCallId,
      toolName,
      decodedArgs: JSON.stringify({
        pattern: "*",
        path: String(args.path ?? ""),
      }),
      nativeResultType: "lsResult",
      nativeArgs: { path: String(args.path ?? "") },
    };
  }

  if (execCase === "grepArgs") {
    const nativeArgs = {
      pattern: String(args.pattern || "."),
      path: String(args.path ?? ""),
      outputMode: String(args.outputMode || "content"),
      ...(args.multiline ? { multiline: "true" } : undefined),
      ...(args.headLimit != null ? { headLimit: String(args.headLimit) } : undefined),
    };
    if (!args.pattern && args.glob) {
      const globTool = pickTool(availableToolNames, ["glob"]);
      if (!globTool) return null;
      return {
        toolCallId,
        toolName: globTool,
        decodedArgs: JSON.stringify({
          pattern: String(args.glob),
          path: String(args.path ?? ""),
        }),
        nativeResultType: "grepResult",
        nativeArgs: {
          pattern: String(args.glob),
          path: String(args.path ?? ""),
          outputMode: "files_with_matches",
        },
      };
    }

    const grepTool = pickTool(availableToolNames, ["grep"]);
    if (!grepTool) return null;
    const decodedArgs: Record<string, unknown> = {
      pattern: String(args.pattern || "."),
    };
    if (args.path) decodedArgs.path = String(args.path);
    if (args.glob) decodedArgs.include = String(args.glob);
    return {
      toolCallId,
      toolName: grepTool,
      decodedArgs: JSON.stringify(decodedArgs),
      nativeResultType: "grepResult",
      nativeArgs,
    };
  }

  return null;
}

function pickTool(
  availableToolNames: Set<string>,
  candidates: string[],
): string | undefined {
  return candidates.find((candidate) => availableToolNames.has(candidate));
}

function decodeWriteContent(args: any): string {
  if (args.fileBytes instanceof Uint8Array && args.fileBytes.length > 0) {
    return new TextDecoder().decode(args.fileBytes);
  }
  return String(args.fileText ?? "");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sendPendingExecResult(
  bridge: BridgeWriter,
  exec: PendingExec,
  content: string | undefined,
): void {
  if (!exec.nativeResultType) {
    sendMcpResult(bridge, exec, content);
    return;
  }

  const args = exec.nativeArgs ?? {};
  const text = content ?? "";

  if (exec.nativeResultType === "readResult") {
    sendExecMessage(
      bridge,
      exec,
      "readResult",
      create(ReadResultSchema, {
        result: {
          case: "success",
          value: create(ReadSuccessSchema, {
            path: args.path ?? "",
            totalLines: text.split("\n").length,
            fileSize: BigInt(new TextEncoder().encode(text).byteLength),
            truncated: false,
            output: { case: "content", value: text },
          }),
        },
      }),
    );
    return;
  }

  if (exec.nativeResultType === "writeResult") {
    sendExecMessage(
      bridge,
      exec,
      "writeResult",
      create(WriteResultSchema, {
        result: {
          case: "success",
          value: create(WriteSuccessSchema, {
            path: args.path ?? "",
            fileSize: Number(args.fileSize ?? 0),
            linesCreated: Number(args.linesCreated ?? 0),
          }),
        },
      }),
    );
    return;
  }

  if (exec.nativeResultType === "deleteResult") {
    const path = args.path ?? "";
    sendExecMessage(
      bridge,
      exec,
      "deleteResult",
      create(DeleteResultSchema, {
        result: {
          case: "success",
          value: create(DeleteSuccessSchema, {
            path,
            deletedFile: path.split("/").filter(Boolean).at(-1) ?? "",
            fileSize: 0n,
            prevContent: "",
          }),
        },
      }),
    );
    return;
  }

  if (exec.nativeResultType === "fetchResult") {
    sendExecMessage(
      bridge,
      exec,
      "fetchResult",
      create(FetchResultSchema, {
        result: {
          case: "success",
          value: create(FetchSuccessSchema, {
            url: args.url ?? "",
            content: text,
            statusCode: 200,
          }),
        },
      }),
    );
    return;
  }

  if (exec.nativeResultType === "shellResult") {
    sendExecMessage(
      bridge,
      exec,
      "shellResult",
      create(ShellResultSchema, {
        result: {
          case: "success",
          value: create(ShellSuccessSchema, {
            command: args.command ?? "",
            workingDirectory: args.workingDirectory ?? "",
            exitCode: 0,
            signal: "",
            stdout: text,
            stderr: "",
          }),
        },
      }),
    );
    return;
  }

  if (exec.nativeResultType === "shellStreamResult") {
    sendExecMessage(
      bridge,
      exec,
      "shellStream",
      create(ShellStreamSchema, {
        event: { case: "start", value: create(ShellStreamStartSchema, {}) },
      }),
    );
    if (text) {
      sendExecMessage(
        bridge,
        exec,
        "shellStream",
        create(ShellStreamSchema, {
          event: {
            case: "stdout",
            value: create(ShellStreamStdoutSchema, { data: text }),
          },
        }),
      );
    }
    sendExecMessage(
      bridge,
      exec,
      "shellStream",
      create(ShellStreamSchema, {
        event: { case: "exit", value: create(ShellStreamExitSchema, { code: 0 }) },
      }),
    );
    sendExecStreamClose(bridge, exec);
    return;
  }

  if (exec.nativeResultType === "lsResult") {
    const built = buildLsResult(text, args.path ?? "");
    if (built) {
      sendExecMessage(bridge, exec, "lsResult", built);
      return;
    }
    sendMcpResult(bridge, exec, content);
    return;
  }

  if (exec.nativeResultType === "grepResult") {
    const built = buildGrepResult(text, args);
    if (built) {
      sendExecMessage(bridge, exec, "grepResult", built);
      return;
    }
    sendMcpResult(bridge, exec, content);
    return;
  }

  sendMcpResult(bridge, exec, content);
}

function buildLsResult(content: string, rootPath: string) {
  const normalizedRoot = rootPath || ".";
  const rawLines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const root = create(LsDirectoryTreeNodeSchema, {
    absPath: normalizedRoot,
    childrenDirs: [],
    childrenFiles: [],
    childrenWereProcessed: true,
    fullSubtreeExtensionCounts: {},
    numFiles: 0,
  });

  const dirMap = new Map<string, ReturnType<typeof create<typeof LsDirectoryTreeNodeSchema>>>([
    [normalizedRoot, root],
  ]);

  for (const rawLine of rawLines) {
    const normalized = normalizeListedPath(rawLine, normalizedRoot);
    if (!normalized || normalized === normalizedRoot) continue;
    const relative =
      normalizedRoot !== "." && normalized.startsWith(`${normalizedRoot}/`)
        ? normalized.slice(normalizedRoot.length + 1)
        : normalized;
    const parts = relative.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    let currentPath = normalizedRoot;
    let currentNode = dirMap.get(normalizedRoot)!;
    for (const segment of parts.slice(0, -1)) {
      const nextPath = joinPath(currentPath, segment);
      let nextNode = dirMap.get(nextPath);
      if (!nextNode) {
        nextNode = create(LsDirectoryTreeNodeSchema, {
          absPath: nextPath,
          childrenDirs: [],
          childrenFiles: [],
          childrenWereProcessed: true,
          fullSubtreeExtensionCounts: {},
          numFiles: 0,
        });
        currentNode.childrenDirs.push(nextNode);
        dirMap.set(nextPath, nextNode);
      }
      currentPath = nextPath;
      currentNode = nextNode;
    }

    const leaf = parts.at(-1)!;
    currentNode.childrenFiles.push(
      create(LsDirectoryTreeNode_FileSchema, {
        name: leaf,
      }),
    );
  }

  computeLsStats(root);

  return create(LsResultSchema, {
    result: {
      case: "success",
      value: create(LsSuccessSchema, {
        directoryTreeRoot: root,
      }),
    },
  });
}

function normalizeListedPath(path: string, rootPath: string): string {
  const cleaned = path.replace(/\/$/, "");
  if (!cleaned) return "";
  if (cleaned === ".") return rootPath || ".";
  if (cleaned.startsWith("/")) return cleaned;
  if (rootPath && rootPath !== ".") return joinPath(rootPath, cleaned);
  return cleaned;
}

function joinPath(base: string, segment: string): string {
  if (!base || base === ".") return segment;
  return `${base}/${segment}`;
}

function computeLsStats(node: ReturnType<typeof create<typeof LsDirectoryTreeNodeSchema>>) {
  const extensionCounts: Record<string, number> = {};
  let numFiles = node.childrenFiles.length;

  for (const file of node.childrenFiles) {
    const dot = file.name.lastIndexOf(".");
    if (dot > 0 && dot < file.name.length - 1) {
      const ext = file.name.slice(dot + 1);
      extensionCounts[ext] = (extensionCounts[ext] ?? 0) + 1;
    }
  }

  for (const child of node.childrenDirs) {
    computeLsStats(child);
    numFiles += child.numFiles;
    for (const [ext, count] of Object.entries(child.fullSubtreeExtensionCounts)) {
      extensionCounts[ext] = (extensionCounts[ext] ?? 0) + count;
    }
  }

  node.numFiles = numFiles;
  node.fullSubtreeExtensionCounts = extensionCounts;
}

function buildGrepResult(content: string, args: Record<string, string>) {
  const pattern = args.pattern ?? "";
  const path = args.path ?? "";
  const outputMode = args.outputMode || "content";

  if (args.multiline === "true") return null;
  if (!["content", "files_with_matches", "count"].includes(outputMode)) {
    return null;
  }

  let unionResult:
    | ReturnType<typeof buildGrepCountResult>
    | ReturnType<typeof buildGrepFilesResult>
    | ReturnType<typeof buildGrepContentResult>;

  if (outputMode === "count") {
    unionResult = buildGrepCountResult(content, Boolean(args.headLimit));
  } else if (outputMode === "files_with_matches") {
    unionResult = buildGrepFilesResult(content, Boolean(args.headLimit));
  } else {
    unionResult = buildGrepContentResult(content, Boolean(args.headLimit));
  }

  if (content.trim() && isEmptyGrepUnion(unionResult)) return null;

  return create(GrepResultSchema, {
    result: {
      case: "success",
      value: create(GrepSuccessSchema, {
        pattern,
        path,
        outputMode,
        workspaceResults: {
          [path || "."]: create(GrepUnionResultSchema, {
            result: unionResult,
          }),
        },
      }),
    },
  });
}

function buildGrepCountResult(content: string, clientTruncated: boolean) {
  const counts = [] as Array<ReturnType<typeof create<typeof GrepFileCountSchema>>>;
  let totalMatches = 0;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line) continue;
    const separator = line.lastIndexOf(":");
    if (separator === -1) continue;
    const tail = line.slice(separator + 1);
    if (!/^\d+$/.test(tail)) continue;
    const file = line.slice(0, separator);
    const count = Number.parseInt(tail, 10);
    counts.push(create(GrepFileCountSchema, { file, count }));
    totalMatches += count;
  }

  return {
    case: "count" as const,
    value: create(GrepCountResultSchema, {
      counts,
      totalFiles: counts.length,
      totalMatches,
      clientTruncated,
      ripgrepTruncated: false,
    }),
  };
}

function buildGrepFilesResult(content: string, clientTruncated: boolean) {
  const files = content
    .split("\n")
    .map((line) => line.replace(/\r$/, "").trim())
    .filter(Boolean);

  return {
    case: "files" as const,
    value: create(GrepFilesResultSchema, {
      files,
      totalFiles: files.length,
      clientTruncated,
      ripgrepTruncated: false,
    }),
  };
}

function buildGrepContentResult(content: string, clientTruncated: boolean) {
  const fileMatches = [] as Array<ReturnType<typeof create<typeof GrepFileMatchSchema>>>;
  let currentFile = "";
  let currentMatches = [] as Array<ReturnType<typeof create<typeof GrepContentMatchSchema>>>;
  let totalLines = 0;
  let totalMatchedLines = 0;

  const flushFile = () => {
    if (currentFile && currentMatches.length > 0) {
      fileMatches.push(
        create(GrepFileMatchSchema, {
          file: currentFile,
          matches: currentMatches,
        }),
      );
    }
    currentMatches = [];
  };

  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "--" || line === "") continue;

    const matchLine = line.match(/^(.+?):(\d+):(.*)/);
    if (matchLine) {
      const file = matchLine[1]!;
      const lineNumber = Number.parseInt(matchLine[2]!, 10);
      const matchedContent = matchLine[3]!;
      if (file !== currentFile) {
        flushFile();
        currentFile = file;
      }
      totalLines += 1;
      totalMatchedLines += 1;
      currentMatches.push(
        create(GrepContentMatchSchema, {
          lineNumber,
          content: matchedContent,
          contentTruncated: false,
          isContextLine: false,
        }),
      );
      continue;
    }

    const contextLine = parseGrepContextLine(line, currentFile);
    if (!contextLine) continue;
    if (contextLine.file !== currentFile) {
      flushFile();
      currentFile = contextLine.file;
    }
    totalLines += 1;
    currentMatches.push(
      create(GrepContentMatchSchema, {
        lineNumber: contextLine.lineNumber,
        content: contextLine.content,
        contentTruncated: false,
        isContextLine: true,
      }),
    );
  }

  flushFile();

  return {
    case: "content" as const,
    value: create(GrepContentResultSchema, {
      matches: fileMatches,
      totalLines,
      totalMatchedLines,
      clientTruncated,
      ripgrepTruncated: false,
    }),
  };
}

function parseGrepContextLine(line: string, currentFile: string) {
  if (currentFile) {
    const prefix = `${currentFile}-`;
    if (line.startsWith(prefix)) {
      const match = line.slice(prefix.length).match(/^(\d+)-(.*)$/s);
      if (match) {
        return {
          file: currentFile,
          lineNumber: Number.parseInt(match[1]!, 10),
          content: match[2]!,
        };
      }
    }
  }

  const fallback = line.match(/^(.+?)-(\d+)-(.*)$/);
  if (!fallback) return null;
  return {
    file: fallback[1]!,
    lineNumber: Number.parseInt(fallback[2]!, 10),
    content: fallback[3]!,
  };
}

function isEmptyGrepUnion(
  result:
    | ReturnType<typeof buildGrepCountResult>
    | ReturnType<typeof buildGrepFilesResult>
    | ReturnType<typeof buildGrepContentResult>,
) {
  if (result.case === "count") return result.value.counts.length === 0;
  if (result.case === "files") return result.value.files.length === 0;
  return result.value.matches.length === 0;
}

function sendMcpResult(
  bridge: BridgeWriter,
  exec: PendingExec,
  content: string | undefined,
): void {
  const result =
    content !== undefined
      ? create(McpResultSchema, {
        result: {
          case: "success",
          value: create(McpSuccessSchema, {
            content: [
              create(McpToolResultContentItemSchema, {
                content: {
                  case: "text",
                  value: create(McpTextContentSchema, { text: content }),
                },
              }),
            ],
            isError: false,
          }),
        },
      })
      : create(McpResultSchema, {
        result: {
          case: "error",
          value: create(McpErrorSchema, { error: "Tool result not provided" }),
        },
      });

  sendExecMessage(bridge, exec, "mcpResult", result);
}

function sendExecMessage(
  bridge: BridgeWriter,
  exec: PendingExec,
  messageCase: string,
  value: unknown,
): void {
  const execClientMessage = create(ExecClientMessageSchema, {
    id: exec.execMsgId,
    execId: exec.execId,
    message: {
      case: messageCase as never,
      value: value as never,
    },
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "execClientMessage", value: execClientMessage },
  });
  bridge.write(toBinary(AgentClientMessageSchema, clientMessage));
}

function sendExecStreamClose(bridge: BridgeWriter, exec: PendingExec): void {
  const controlMessage = create(ExecClientControlMessageSchema, {
    message: {
      case: "streamClose",
      value: create(ExecClientStreamCloseSchema, { id: exec.execMsgId }),
    },
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "execClientControlMessage", value: controlMessage },
  });
  bridge.write(toBinary(AgentClientMessageSchema, clientMessage));
}
