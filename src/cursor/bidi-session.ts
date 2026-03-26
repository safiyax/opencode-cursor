import { create, toBinary } from "@bufbuild/protobuf";
import { BidiRequestIdSchema } from "../proto/agent_pb";
import { CURSOR_API_URL } from "./config";
import {
  concatBytes,
  encodeProtoMessageField,
  encodeProtoStringField,
  encodeProtoVarintField,
  frameConnectMessage,
  toFetchBody,
} from "./connect-framing";
import { buildCursorHeaders, type CursorBaseRequestOptions } from "./headers";
import { errorDetails, logPluginError, logPluginWarn } from "../logger";

export function encodeBidiAppendRequest(
  dataHex: string,
  requestId: string,
  appendSeqno: number,
): Uint8Array {
  const requestIdBytes = toBinary(
    BidiRequestIdSchema,
    create(BidiRequestIdSchema, { requestId }),
  );
  return concatBytes([
    encodeProtoStringField(1, dataHex),
    encodeProtoMessageField(2, requestIdBytes),
    encodeProtoVarintField(3, appendSeqno),
  ]);
}

export interface CursorSession {
  write: (data: Uint8Array) => void;
  end: () => void;
  onData: (cb: (chunk: Buffer) => void) => void;
  onClose: (cb: (code: number) => void) => void;
  readonly alive: boolean;
}

export interface CreateCursorSessionOptions extends CursorBaseRequestOptions {
  requestId: string;
}

export async function createCursorSession(
  options: CreateCursorSessionOptions,
): Promise<CursorSession> {
  const response = await fetch(
    new URL("/agent.v1.AgentService/RunSSE", options.url ?? CURSOR_API_URL),
    {
      method: "POST",
      headers: buildCursorHeaders(options, "application/connect+proto", {
        accept: "text/event-stream",
        "connect-protocol-version": "1",
      }),
      body: toFetchBody(
        frameConnectMessage(
          toBinary(
            BidiRequestIdSchema,
            create(BidiRequestIdSchema, { requestId: options.requestId }),
          ),
        ),
      ),
    },
  );

  if (!response.ok || !response.body) {
    const errorBody = await response.text().catch(() => "");
    logPluginError("Cursor RunSSE request failed", {
      requestId: options.requestId,
      status: response.status,
      responseBody: errorBody,
    });
    throw new Error(
      `RunSSE failed: ${response.status}${errorBody ? ` ${errorBody}` : ""}`,
    );
  }

  const cbs = {
    data: null as ((chunk: Buffer) => void) | null,
    close: null as ((code: number) => void) | null,
  };
  const abortController = new AbortController();
  const reader = response.body.getReader();
  let appendSeqno = 0;
  let alive = true;
  let closeCode = 0;
  let writeChain = Promise.resolve();
  const pendingChunks: Buffer[] = [];

  const finish = (code: number) => {
    if (!alive) return;
    alive = false;
    closeCode = code;
    cbs.close?.(code);
  };

  const append = async (data: Uint8Array) => {
    const requestBody = encodeBidiAppendRequest(
      Buffer.from(data).toString("hex"),
      options.requestId,
      appendSeqno++,
    );
    const appendResponse = await fetch(
      new URL(
        "/aiserver.v1.BidiService/BidiAppend",
        options.url ?? CURSOR_API_URL,
      ),
      {
        method: "POST",
        headers: buildCursorHeaders(options, "application/proto"),
        body: toFetchBody(requestBody),
        signal: abortController.signal,
      },
    );

    if (!appendResponse.ok) {
      const errorBody = await appendResponse.text().catch(() => "");
      logPluginError("Cursor BidiAppend request failed", {
        requestId: options.requestId,
        appendSeqno: appendSeqno - 1,
        status: appendResponse.status,
        responseBody: errorBody,
      });
      throw new Error(
        `BidiAppend failed: ${appendResponse.status}${errorBody ? ` ${errorBody}` : ""}`,
      );
    }

    await appendResponse.arrayBuffer().catch(() => undefined);
  };

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          finish(0);
          break;
        }
        if (value && value.length > 0) {
          const chunk = Buffer.from(value);
          if (cbs.data) {
            cbs.data(chunk);
          } else {
            pendingChunks.push(chunk);
          }
        }
      }
    } catch (error) {
      logPluginWarn("Cursor stream reader closed with error", {
        requestId: options.requestId,
        ...errorDetails(error),
      });
      finish(alive ? 1 : closeCode);
    }
  })();

  return {
    get alive() {
      return alive;
    },
    write(data) {
      if (!alive) return;
      writeChain = writeChain
        .then(() => append(data))
        .catch((error) => {
          logPluginError("Cursor stream append failed", {
            requestId: options.requestId,
            ...errorDetails(error),
          });
          try {
            abortController.abort();
          } catch {}
          try {
            reader.cancel();
          } catch {}
          finish(1);
        });
    },
    end() {
      try {
        abortController.abort();
      } catch {}
      try {
        reader.cancel();
      } catch {}
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
}
