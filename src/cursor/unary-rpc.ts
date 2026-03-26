import {
  connect as connectHttp2,
  type ClientHttp2Session,
  type ClientHttp2Stream,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from "node:http2";
import { CURSOR_API_URL, CURSOR_CONNECT_PROTOCOL_VERSION } from "./config";
import { buildCursorHeaderValues } from "./headers";
import { errorDetails, logPluginError } from "../logger";

export interface CursorUnaryRpcOptions {
  accessToken: string;
  rpcPath: string;
  requestBody: Uint8Array;
  url?: string;
  timeoutMs?: number;
}

export async function callCursorUnaryRpc(
  options: CursorUnaryRpcOptions,
): Promise<{ body: Uint8Array; exitCode: number; timedOut: boolean }> {
  const target = new URL(options.rpcPath, options.url ?? CURSOR_API_URL);
  return callCursorUnaryRpcOverHttp2(options, target);
}

async function callCursorUnaryRpcOverHttp2(
  options: CursorUnaryRpcOptions,
  target: URL,
): Promise<{ body: Uint8Array; exitCode: number; timedOut: boolean }> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const authority = `${target.protocol}//${target.host}`;

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let session: ClientHttp2Session | undefined;
    let stream: ClientHttp2Stream | undefined;

    const finish = (result: {
      body: Uint8Array;
      exitCode: number;
      timedOut: boolean;
    }) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try {
        stream?.close();
      } catch {}
      try {
        session?.close();
      } catch {}
      resolve(result);
    };

    const timeout =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            finish({
              body: new Uint8Array(),
              exitCode: 124,
              timedOut: true,
            });
          }, timeoutMs)
        : undefined;

    try {
      session = connectHttp2(authority);
      session.once("error", (error) => {
        logPluginError("Cursor unary HTTP/2 session failed", {
          rpcPath: options.rpcPath,
          url: target.toString(),
          timedOut,
          ...errorDetails(error),
        });
        finish({
          body: new Uint8Array(),
          exitCode: timedOut ? 124 : 1,
          timedOut,
        });
      });

      const headers: OutgoingHttpHeaders = {
        ":method": "POST",
        ":path": `${target.pathname}${target.search}`,
        ...buildCursorHeaderValues(options, "application/proto", {
          accept: "application/proto, application/json",
          "connect-protocol-version": CURSOR_CONNECT_PROTOCOL_VERSION,
          "connect-timeout-ms": String(timeoutMs),
        }),
      };

      stream = session.request(headers);

      let statusCode = 0;
      const chunks: Buffer[] = [];

      stream.once("response", (responseHeaders: IncomingHttpHeaders) => {
        const statusHeader = responseHeaders[":status"];
        statusCode =
          typeof statusHeader === "number"
            ? statusHeader
            : Number(statusHeader ?? 0);
      });
      stream.on("data", (chunk: Buffer | Uint8Array) => {
        chunks.push(Buffer.from(chunk));
      });
      stream.once("end", () => {
        const body = new Uint8Array(Buffer.concat(chunks));
        finish({
          body,
          exitCode: statusCode >= 200 && statusCode < 300 ? 0 : statusCode || 1,
          timedOut,
        });
      });
      stream.once("error", (error) => {
        logPluginError("Cursor unary HTTP/2 stream failed", {
          rpcPath: options.rpcPath,
          url: target.toString(),
          timedOut,
          ...errorDetails(error),
        });
        finish({
          body: new Uint8Array(),
          exitCode: timedOut ? 124 : 1,
          timedOut,
        });
      });
      // Bun's node:http2 client currently breaks on end(Buffer.alloc(0)) against
      // Cursor's HTTPS endpoint, but a header-only end() succeeds for empty unary bodies.
      if (options.requestBody.length > 0) {
        stream.end(Buffer.from(options.requestBody));
      } else {
        stream.end();
      }
    } catch (error) {
      logPluginError("Cursor unary HTTP/2 setup failed", {
        rpcPath: options.rpcPath,
        url: target.toString(),
        timedOut,
        ...errorDetails(error),
      });
      finish({
        body: new Uint8Array(),
        exitCode: timedOut ? 124 : 1,
        timedOut,
      });
    }
  });
}
