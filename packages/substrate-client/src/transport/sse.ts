import type { NlWireEvent } from '@mnmal-ai/substrate-types';
import { NetworkError } from '../errors.js';

/** Parse one SSE block; null when it carries no data (comment-only or empty). Throws on an in-band `error` event. */
function parseBlock(block: string): NlWireEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:'))
      data.push(line.slice(5).startsWith(' ') ? line.slice(6) : line.slice(5));
  }
  if (data.length === 0) return null;
  const raw = data.join('\n');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new NetworkError(`malformed SSE data for event '${event}': ${raw.slice(0, 100)}`, err);
  }
  if (event === 'error') {
    const e = parsed as { code?: string; message?: string };
    throw new NetworkError(`${e.code ?? 'error'}: ${e.message ?? ''}`, parsed);
  }
  // The server names its events; an unknown name is a server newer than this client, passed through.
  return { event, data: parsed } as NlWireEvent;
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<NlWireEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      // A trailing lone CR may be the first half of a CRLF split across chunks; it stays until the next chunk.
      buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let sep = buf.indexOf('\n\n');
      while (sep >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        sep = buf.indexOf('\n\n');
        const evt = parseBlock(block);
        if (evt !== null) yield evt;
      }
    }
    buf += decoder.decode();
    const tail = buf.replace(/\r\n?/g, '\n').trim();
    if (tail !== '') {
      const evt = parseBlock(tail);
      if (evt !== null) yield evt;
    }
  } finally {
    // Cancel so an early break (or an in-band error) closes the HTTP connection; harmless on a finished stream.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
