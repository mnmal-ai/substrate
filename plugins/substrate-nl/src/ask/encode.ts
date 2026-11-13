import { encodeStreamFrame, FRAMES_JSON_MIME } from '@mnmal-ai/substrate/pack';
import type { NlEvent, NlOutcome } from './events.js';

function wireName(ev: NlEvent): [string, unknown] {
  if (ev.event === 'outcome') return [ev.outcome.kind, ev.outcome];
  const { event, ...rest } = ev;
  return [event, rest];
}

/** One NL event as wire bytes. */
export type EncodeEvent = (name: string, data: unknown) => Uint8Array;

/** A length-prefixed JSON frame carrying `{ event, data }`, the client's `NlWireEvent`. */
export const frameBytes: EncodeEvent = (event, data) => encodeStreamFrame({ event, data }, 'json');

export const FRAMES_HEADERS: Record<string, string> = {
  'content-type': FRAMES_JSON_MIME,
  'cache-control': 'no-store',
  'x-accel-buffering': 'no'
};

export function toEventStream(
  events: AsyncGenerator<NlEvent>,
  encode: EncodeEvent,
  onCancel?: () => void,
  onError?: (err: unknown) => void
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await events.next();
        if (next.done === true) return controller.close();
        const [name, data] = wireName(next.value);
        controller.enqueue(encode(name, data));
      } catch (err) {
        // In-band: the status is already 200.
        // The text is fixed: the real error goes to the server log, never the client.
        onError?.(err);
        controller.enqueue(
          encode('error', { code: 'nl_engine_error', message: 'NL query failed' })
        );
        controller.close();
      }
    },
    async cancel() {
      onCancel?.();
      await events.return(undefined);
    }
  });
}

export async function toJson(
  events: AsyncGenerator<NlEvent>
): Promise<{ outcome: NlOutcome | null; trail: NlEvent[] }> {
  const trail: NlEvent[] = [];
  let outcome: NlOutcome | null = null;
  for await (const ev of events) {
    trail.push(ev);
    if (ev.event === 'outcome') outcome = ev.outcome;
  }
  return { outcome, trail };
}
