import { CONNECT_END_STREAM_FLAG } from "./config";

/** Connect protocol frame: [1-byte flags][4-byte BE length][payload] */
export function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
  const frame = Buffer.alloc(5 + data.length);
  frame[0] = flags;
  frame.writeUInt32BE(data.length, 1);
  frame.set(data, 5);
  return frame;
}

export function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 5) return null;

  let offset = 0;
  while (offset + 5 <= payload.length) {
    const flags = payload[offset]!;
    const view = new DataView(
      payload.buffer,
      payload.byteOffset + offset,
      payload.byteLength - offset,
    );
    const messageLength = view.getUint32(1, false);
    const frameEnd = offset + 5 + messageLength;
    if (frameEnd > payload.length) return null;
    if ((flags & 0b0000_0001) !== 0) return null;
    if ((flags & CONNECT_END_STREAM_FLAG) === 0) {
      return payload.subarray(offset + 5, frameEnd);
    }
    offset = frameEnd;
  }

  return null;
}

export function encodeVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Unsupported varint value: ${value}`);
  }

  const bytes: number[] = [];
  let current = value;
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current = Math.floor(current / 128);
  }
  bytes.push(current);
  return Uint8Array.from(bytes);
}

export function encodeProtoField(
  tag: number,
  wireType: number,
  value: Uint8Array,
): Uint8Array {
  const key = encodeVarint((tag << 3) | wireType);
  const out = new Uint8Array(key.length + value.length);
  out.set(key, 0);
  out.set(value, key.length);
  return out;
}

export function encodeProtoStringField(tag: number, value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  const len = encodeVarint(bytes.length);
  const payload = new Uint8Array(len.length + bytes.length);
  payload.set(len, 0);
  payload.set(bytes, len.length);
  return encodeProtoField(tag, 2, payload);
}

export function encodeProtoMessageField(
  tag: number,
  value: Uint8Array,
): Uint8Array {
  const len = encodeVarint(value.length);
  const payload = new Uint8Array(len.length + value.length);
  payload.set(len, 0);
  payload.set(value, len.length);
  return encodeProtoField(tag, 2, payload);
}

export function encodeProtoVarintField(tag: number, value: number): Uint8Array {
  return encodeProtoField(tag, 0, encodeVarint(value));
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function toFetchBody(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
}
