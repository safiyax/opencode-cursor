import type { CursorSession } from "../cursor/bidi-session";
import { createCursorSession } from "../cursor/bidi-session";
import { makeHeartbeatBytes } from "./stream-dispatch";

const HEARTBEAT_INTERVAL_MS = 5_000;

export async function startBridge(
  accessToken: string,
  requestBytes: Uint8Array,
): Promise<{ bridge: CursorSession; heartbeatTimer: NodeJS.Timeout }> {
  const bridge = await createCursorSession({
    accessToken,
    initialRequestBytes: requestBytes,
  });

  const heartbeatTimer = setInterval(
    () => bridge.write(makeHeartbeatBytes()),
    HEARTBEAT_INTERVAL_MS,
  );

  return { bridge, heartbeatTimer };
}
