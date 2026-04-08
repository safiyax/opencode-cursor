import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { errorDetails, logPluginError, logPluginWarn } from "../logger";
import type { ChatCompletionRequest } from "../openai/types";
import { handleChatCompletion } from "./chat-completion";
import { activeBridges, conversationStates } from "./conversation-state";

let proxyServer: ReturnType<typeof createServer> | undefined;
let proxyPort: number | undefined;
let proxyAccessTokenProvider: (() => Promise<string>) | undefined;
let proxyModels: Array<{ id: string; name: string }> = [];

function buildOpenAIModelList(
  models: ReadonlyArray<{ id: string; name: string }>,
): Array<{
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}> {
  return models.map((model) => ({
    id: model.id,
    object: "model",
    created: 0,
    owned_by: "cursor",
  }));
}

export function getProxyPort(): number | undefined {
  return proxyPort;
}

export async function startProxy(
  getAccessToken: () => Promise<string>,
  models: ReadonlyArray<{ id: string; name: string }> = [],
): Promise<number> {
  proxyAccessTokenProvider = getAccessToken;
  proxyModels = models.map((model) => ({
    id: model.id,
    name: model.name,
  }));
  if (proxyServer && proxyPort) return proxyPort;

  proxyServer = createServer(async (req, res) => {
    try {
      await handleNodeRequest(req, res);
    } catch (err) {
      const path = req.url ?? "";
      const method = req.method ?? "";
      const message = err instanceof Error ? err.message : String(err);
      logPluginError("Cursor proxy request failed", {
        path,
        method,
        ...errorDetails(err),
      });
      await writeNodeResponse(
        res,
        new Response(
          JSON.stringify({
            error: { message, type: "server_error", code: "internal_error" },
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
  });
  proxyServer.requestTimeout = 0;
  proxyServer.headersTimeout = 0;

  await new Promise<void>((resolve, reject) => {
    proxyServer!.once("error", reject);
    proxyServer!.listen(0, "127.0.0.1", () => {
      proxyServer!.off("error", reject);
      resolve();
    });
  });

  const address = proxyServer.address();
  proxyPort = typeof address === "object" && address ? address.port : undefined;
  if (!proxyPort) throw new Error("Failed to bind proxy to a port");
  return proxyPort;
}

export function stopProxy(): void {
  if (proxyServer) {
    proxyServer.close();
    proxyServer = undefined;
    proxyPort = undefined;
    proxyAccessTokenProvider = undefined;
    proxyModels = [];
  }
  // Clean up any lingering bridges
  for (const active of activeBridges.values()) {
    clearInterval(active.heartbeatTimer);
    active.bridge.end();
  }
  activeBridges.clear();
  conversationStates.clear();
}

async function handleNodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/v1/models") {
    await writeNodeResponse(
      res,
      new Response(
        JSON.stringify({
          object: "list",
          data: buildOpenAIModelList(proxyModels),
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    const body = (await readJsonBody(req)) as ChatCompletionRequest;
    if (!proxyAccessTokenProvider) {
      throw new Error("Cursor proxy access token provider not configured");
    }
    const accessToken = await proxyAccessTokenProvider();
    const sessionId = requestHeader(req, "x-session-id");
    const agentKey = requestHeader(req, "x-opencode-agent");
    const response = await handleChatCompletion(body, accessToken, {
      sessionId,
      agentKey,
    });
    if (response.status >= 400) {
      let responseBody = "";
      try {
        responseBody = await response.clone().text();
      } catch (error) {
        responseBody = `Failed to read rejected response body: ${error instanceof Error ? error.message : String(error)}`;
      }
      logPluginWarn("Rejected Cursor chat completion", {
        path: url.pathname,
        method: req.method,
        sessionId,
        agentKey,
        status: response.status,
        requestBody: body,
        requestBodyText: JSON.stringify(body),
        responseBody,
      });
    }
    await writeNodeResponse(res, response);
    return;
  }

  await writeNodeResponse(res, new Response("Not Found", { status: 404 }));
}

function requestHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function writeNodeResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  if (res.headersSent || res.destroyed) return;

  const headers = Object.fromEntries(response.headers.entries());
  res.writeHead(response.status, response.statusText || undefined, headers);

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) {
        await reader.cancel();
        return;
      }
      res.write(Buffer.from(value));
    }
    res.end();
  } finally {
    reader.releaseLock();
  }
}
