/**
 * AWS EventStream binary frame parser.
 *
 * Frame layout (all integers big-endian):
 *   [0..4)      uint32   totalLength      (includes prelude+headers+payload+CRCs)
 *   [4..8)      uint32   headersLength
 *   [8..12)     uint32   preludeCRC       (CRC-32/IEEE over bytes [0..8))
 *   [12..12+H)  bytes    headers          (length=headersLength)
 *   [12+H..N-4) bytes    payload          (length=totalLength-headersLength-16)
 *   [N-4..N)    uint32   messageCRC       (CRC-32/IEEE over bytes [0..N-4))
 *
 * Headers:
 *   nameLen:uint8  name:bytes  type:uint8  value:...
 *
 * For Kiro we only care about string headers (type=7):
 *   valueLen:uint16  value:bytes
 *
 * Other header types exist (bool, byte, short, int, long, byte-array, ts,
 * uuid) but Kiro's CodeWhisperer streaming uses string headers exclusively
 * for the names we read (`:event-type`, `:content-type`, `:message-type`).
 *
 * We keep an incremental ByteQueue so callers can feed arbitrary-size chunks.
 */

const CRC32_TABLE = new Uint32Array(256);
const MIN_FRAME_LENGTH = 16;
const MAX_FRAME_LENGTH = 24 * 1024 * 1024;
for (let i = 0; i < 256; i++) {
  let c = i >>> 0;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
  }
  CRC32_TABLE[i] = c;
}

export function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff >>> 0;
  for (let i = 0; i < buf.length; i++) {
    crc = (CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface EventFrame {
  headers: Record<string, string>;
  /** Parsed payload JSON, or null when the payload is empty or not JSON. */
  payload: Record<string, unknown> | null;
  /** Raw payload bytes (kept for debugging non-JSON payloads). */
  rawPayload: Uint8Array;
}

/** Incremental byte queue that lets us peek/consume across chunks. */
export class ByteQueue {
  private chunks: Uint8Array[] = [];
  private headOffset = 0;
  length = 0;

  push(chunk: Uint8Array): void {
    if (!(chunk instanceof Uint8Array) || chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /** Peek a big-endian uint32 at the given byte offset. Null if not enough data. */
  peekUint32BE(offset = 0): number | null {
    if (this.length < offset + 4) return null;
    let value = 0;
    for (let i = 0; i < 4; i++) {
      value = ((value << 8) | this.byteAt(offset + i)) >>> 0;
    }
    return value;
  }

  /** Consume `length` bytes into a fresh Uint8Array, or null if not enough data. */
  read(length: number): Uint8Array | null {
    if (length < 0 || this.length < length) return null;
    const out = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const head = this.chunks[0];
      const available = head.length - this.headOffset;
      const take = Math.min(available, length - written);
      out.set(head.subarray(this.headOffset, this.headOffset + take), written);
      written += take;
      this.headOffset += take;
      this.length -= take;
      if (this.headOffset >= head.length) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    }
    return out;
  }

  private byteAt(offset: number): number {
    let remaining = offset;
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      const start = i === 0 ? this.headOffset : 0;
      const available = chunk.length - start;
      if (remaining < available) return chunk[start + remaining];
      remaining -= available;
    }
    return 0;
  }
}

/**
 * Parse a single EventStream frame from a Uint8Array starting at byte 0.
 * Returns null on CRC mismatch (caller may log and skip).
 */
export function parseEventFrame(data: Uint8Array): EventFrame | null {
  if (data.length < MIN_FRAME_LENGTH || data.length > MAX_FRAME_LENGTH) return null;

  const view = new DataView(data.buffer, data.byteOffset, data.length);
  const totalLength = view.getUint32(0, false);
  const headersLength = view.getUint32(4, false);
  if (totalLength !== data.length) return null;
  if (totalLength < MIN_FRAME_LENGTH || totalLength > MAX_FRAME_LENGTH) return null;
  if (headersLength > totalLength - MIN_FRAME_LENGTH) return null;

  // Prelude CRC covers bytes [0..8).
  const preludeCRC = view.getUint32(8, false);
  if (preludeCRC !== crc32(data.subarray(0, 8))) return null;

  // Message CRC covers bytes [0..N-4).
  const messageCRC = view.getUint32(data.length - 4, false);
  if (messageCRC !== crc32(data.subarray(0, data.length - 4))) return null;

  // Headers.
  const headers: Record<string, string> = {};
  let off = 12;
  const headerEnd = 12 + headersLength;

  while (off < headerEnd) {
    if (off + 1 > data.length) break;
    const nameLen = data[off];
    off += 1;
    if (off + nameLen > data.length) break;
    const name = utf8(data.subarray(off, off + nameLen));
    off += nameLen;

    if (off + 1 > data.length) break;
    const type = data[off];
    off += 1;

    if (type === 7) {
      // String header: uint16 length, then UTF-8 bytes.
      if (off + 2 > data.length) break;
      const valueLen = (data[off] << 8) | data[off + 1];
      off += 2;
      if (off + valueLen > data.length) break;
      headers[name] = utf8(data.subarray(off, off + valueLen));
      off += valueLen;
    } else {
      // Skip other header types defensively. We can't safely advance without
      // knowing the type size, so we just stop parsing headers here.
      break;
    }
  }

  const payloadStart = 12 + headersLength;
  const payloadEnd = data.length - 4;
  const rawPayload = data.subarray(payloadStart, payloadEnd);

  let payload: Record<string, unknown> | null = null;
  if (rawPayload.length > 0) {
    const text = utf8(rawPayload).trim();
    if (text.length > 0) {
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch {
        payload = null;
      }
    }
  }

  return { headers, payload, rawPayload };
}

const decoder = new TextDecoder();
function utf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/**
 * Drain an arbitrary number of complete frames from a queue. Returns parsed
 * frames in order. Frames with bad CRC are dropped (caller may log).
 */
export function drainFrames(queue: ByteQueue, onBadFrame?: () => void): EventFrame[] {
  const frames: EventFrame[] = [];
  let safety = 0;
  while (queue.length >= MIN_FRAME_LENGTH) {
    if (++safety > 100_000) break;
    const totalLength = queue.peekUint32BE(0);
    if (!totalLength || totalLength < MIN_FRAME_LENGTH || totalLength > MAX_FRAME_LENGTH) {
      queue.read(1);
      onBadFrame?.();
      continue;
    }
    if (totalLength > queue.length) break;
    const data = queue.read(totalLength);
    if (!data) break;
    const frame = parseEventFrame(data);
    if (!frame) {
      onBadFrame?.();
      continue;
    }
    frames.push(frame);
  }
  return frames;
}

/**
 * Build an EventStream frame (mostly used for tests).
 * Headers must be string-typed.
 */
export function buildFrame(
  headers: Record<string, string>,
  payload: Uint8Array
): Uint8Array {
  const headerBuffers: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = enc.encode(name);
    const valueBytes = enc.encode(value);
    const buf = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    let o = 0;
    buf[o++] = nameBytes.length;
    buf.set(nameBytes, o);
    o += nameBytes.length;
    buf[o++] = 7;
    buf[o++] = (valueBytes.length >> 8) & 0xff;
    buf[o++] = valueBytes.length & 0xff;
    buf.set(valueBytes, o);
    headerBuffers.push(buf);
  }
  const headersBuf = concat(headerBuffers);
  const totalLength = 4 + 4 + 4 + headersBuf.length + payload.length + 4;
  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headersBuf.length, false);
  const prelude = out.subarray(0, 8);
  view.setUint32(8, crc32(prelude), false);
  out.set(headersBuf, 12);
  out.set(payload, 12 + headersBuf.length);
  const msgCrc = crc32(out.subarray(0, totalLength - 4));
  view.setUint32(totalLength - 4, msgCrc, false);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
