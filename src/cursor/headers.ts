import { CURSOR_CLIENT_VERSION } from "./config";

export interface CursorBaseRequestOptions {
  accessToken: string;
  url?: string;
}

export function buildCursorHeaders(
  options: CursorBaseRequestOptions,
  contentType: string,
  extra: Record<string, string> = {},
): Headers {
  const headers = new Headers(
    buildCursorHeaderValues(options, contentType, extra),
  );

  return headers;
}

export function buildCursorHeaderValues(
  options: CursorBaseRequestOptions,
  contentType: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    authorization: `Bearer ${options.accessToken}`,
    "content-type": contentType,
    "x-ghost-mode": "true",
    "x-cursor-client-version": CURSOR_CLIENT_VERSION,
    "x-cursor-client-type": "cli",
    "x-request-id": crypto.randomUUID(),
    ...extra,
  };
}
