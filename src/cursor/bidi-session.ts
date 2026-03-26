import {
  connect as connectHttp2,
  type ClientHttp2Session,
  type ClientHttp2Stream,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from "node:http2";
import { CURSOR_API_URL, CURSOR_CONNECT_PROTOCOL_VERSION } from "./config";
import { frameConnectMessage } from "./connect-framing";
import {
  buildCursorHeaderValues,
  type CursorBaseRequestOptions,
} from "./headers";
import { errorDetails, logPluginError } from "../logger";

const CURSOR_BIDI_RUN_PATH = "/agent.v1.AgentService/Run";

export interface CursorSession {
  write: (data: Uint8Array) => void;
  end: () => void;
  onData: (cb: (chunk: Buffer) => void) => void;
  onClose: (cb: (code: number) => void) => void;
  readonly alive: boolean;
}

export interface CreateCursorSessionOptions extends CursorBaseRequestOptions {
  initialRequestBytes: Uint8Array;
}

export async function createCursorSession(
  options: CreateCursorSessionOptions,
): Promise<CursorSession> {
  if (options.initialRequestBytes.length === 0) {
    throw new Error("Cursor sessions require an initial request message");
  }

  const target = new URL(CURSOR_BIDI_RUN_PATH, options.url ?? CURSOR_API_URL);
  const authority = `${target.protocol}//${target.host}`;
  const requestId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const cbs = {
      data: null as ((chunk: Buffer) => void) | null,
      close: null as ((code: number) => void) | null,
    };
    let session: ClientHttp2Session | undefined;
    let stream: ClientHttp2Stream | undefined;
    let alive = true;
    let closeCode = 0;
    let opened = false;
    let settled = false;
    let statusCode = 0;
    const pendingChunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];

    const closeTransport = () => {
      try {
        stream?.close();
      } catch {}
      try {
        session?.close();
      } catch {}
    };

    const finish = (code: number) => {
      if (!alive) return;
      alive = false;
      closeCode = code;
      cbs.close?.(code);
      closeTransport();
    };

    const rejectOpen = (error: Error) => {
      if (settled) return;
      settled = true;
      alive = false;
      closeTransport();
      reject(error);
    };

    const resolveOpen = (sessionHandle: CursorSession) => {
      if (settled) return;
      settled = true;
      opened = true;
      resolve(sessionHandle);
    };

    const handleTransportError = (message: string, error: unknown) => {
      logPluginError(message, {
        requestId,
        url: target.toString(),
        ...errorDetails(error),
      });

      if (!opened) {
        rejectOpen(
          new Error(
            error instanceof Error ? error.message : String(error ?? message),
          ),
        );
        return;
      }

      finish(1);
    };

    const sessionHandle: CursorSession = {
      get alive() {
        return alive;
      },
      write(data) {
        if (!alive || !stream) return;
        try {
          stream.write(frameConnectMessage(data));
        } catch (error) {
          handleTransportError("Cursor HTTP/2 write failed", error);
        }
      },
      end() {
        finish(0);
      },
      onData(cb) {
        cbs.data = cb;
        while (pendingChunks.length > 0) {
          cb(pendingChunks.shift()!);
        }
      },
      onClose(cb) {
        if (!alive) {
          queueMicrotask(() => cb(closeCode));
        } else {
          cbs.close = cb;
        }
      },
    };

    try {
      session = connectHttp2(authority);
      session.once("error", (error) => {
        handleTransportError("Cursor HTTP/2 session failed", error);
      });

      const headers: OutgoingHttpHeaders = {
        ":method": "POST",
        ":path": `${target.pathname}${target.search}`,
        ...buildCursorHeaderValues(options, "application/connect+proto", {
          accept: "application/connect+proto",
          "connect-protocol-version": CURSOR_CONNECT_PROTOCOL_VERSION,
        }),
      };

      stream = session.request(headers);

      stream.once("response", (responseHeaders: IncomingHttpHeaders) => {
        const statusHeader = responseHeaders[":status"];
        statusCode =
          typeof statusHeader === "number"
            ? statusHeader
            : Number(statusHeader ?? 0);

        if (statusCode >= 200 && statusCode < 300) {
          resolveOpen(sessionHandle);
        }
      });
      stream.on("data", (chunk: Buffer | Uint8Array) => {
        const buffer = Buffer.from(chunk);
        if (!opened && statusCode >= 400) {
          errorChunks.push(buffer);
          return;
        }
        if (cbs.data) {
          cbs.data(buffer);
        } else {
          pendingChunks.push(buffer);
        }
      });
      stream.once("end", () => {
        if (!opened) {
          const errorBody = Buffer.concat(errorChunks).toString("utf8").trim();
          logPluginError("Cursor HTTP/2 Run request failed", {
            requestId,
            status: statusCode,
            responseBody: errorBody,
          });
          rejectOpen(
            new Error(
              `Run failed: ${statusCode || 1}${errorBody ? ` ${errorBody}` : ""}`,
            ),
          );
          return;
        }

        finish(statusCode >= 200 && statusCode < 300 ? 0 : statusCode || 1);
      });
      stream.once("error", (error) => {
        handleTransportError("Cursor HTTP/2 stream failed", error);
      });

      stream.write(frameConnectMessage(options.initialRequestBytes));
    } catch (error) {
      handleTransportError("Cursor HTTP/2 transport setup failed", error);
    }
  });
}
