import type { NlEvent, NlOutcome } from './events.js';

/** Same headers as substrate-compose's SSE routes (not exported from its entry). */
export const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-store',
  'x-accel-buffering': 'no'
};

/** One named SSE event. JSON.stringify emits no raw newline, so one data line is safe. */
export function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function wireName(ev: NlEvent): [string, unknown] {
  if (ev.event === 'outcome') return [ev.outcome.kind, ev.outcome];
  const { event, ...rest } = ev;
  return [event, rest];
}

export function toSseStream(
  events: AsyncGenerator<NlEvent>,
  onCancel?: () => void,
  onError?: (err: unknown) => void
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await events.next();
        if (next.done === true) return controller.close();
        const [name, data] = wireName(next.value);
        controller.enqueue(enc.encode(sseEvent(name, data)));
      } catch (err) {
        // In-band, like the subscription SSE surface: the status is already 200.
        // The text is fixed: the real error goes to the server log, never the client.
        onError?.(err);
        controller.enqueue(
          enc.encode(
            sseEvent('error', {
              code: 'nl_engine_error',
              message: 'NL query failed'
            })
          )
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
