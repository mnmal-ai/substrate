import { delay, HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OllamaEmbedder } from '../src/ollama.js';
import { EmbedError } from '../src/types.js';

/** Default `/api/show` answer: a bert-family model with an 8192-token context. */
const showHandler = http.post('http://localhost:11434/api/show', () =>
  HttpResponse.json({ model_info: { 'general.architecture': 'bert', 'bert.context_length': 8192 } })
);
const server = setupServer(showHandler);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// The embedder targets the modern /api/embed endpoint
// ({ model, input, truncate } → { embeddings: [[...]] }), not the legacy
// /api/embeddings, which returns 200 with an empty embedding for inputs past
// the model's context instead of truncating.

describe('OllamaEmbedder', () => {
  it('modelId format matches <family>:<version>:<dim>', () => {
    const e = new OllamaEmbedder({ model: 'bge-small-en:v1.5', dimension: 384 });
    expect(e.modelId).toBe('bge-small-en:v1.5:384');
    expect(e.dimension).toBe(384);
  });

  it('embed: POSTs /api/embed with { model, input, truncate: true } and returns the vector', async () => {
    const mockVec = Array.from({ length: 8 }, (_, i) => i / 10);
    let seenBody: unknown;
    server.use(
      http.post('http://localhost:11434/api/embed', async ({ request }) => {
        seenBody = await request.json();
        return HttpResponse.json({ embeddings: [mockVec] });
      })
    );
    const e = new OllamaEmbedder({
      baseUrl: 'http://localhost:11434',
      model: 'bge-small-en:v1.5',
      dimension: 8
    });
    const v = await e.embed('some text');
    expect(Array.from(v)).toEqual(Array.from(new Float32Array(mockVec)));
    expect(seenBody).toEqual({
      model: 'bge-small-en:v1.5',
      input: 'some text',
      truncate: true,
      options: { num_ctx: 8192, num_batch: 8192 }
    });
  });

  it('embed: throws EmbedError(unavailable) on network error', async () => {
    server.use(http.post('http://localhost:11434/api/embed', () => HttpResponse.error()));
    const e = new OllamaEmbedder({
      baseUrl: 'http://localhost:11434',
      model: 'bge-small-en:v1.5',
      dimension: 384
    });
    await expect(e.embed('x')).rejects.toSatisfy((err: unknown) => {
      return err instanceof EmbedError && err.code === 'unavailable';
    });
  });

  it('embed: throws EmbedError(unavailable) on non-2xx response', async () => {
    server.use(
      http.post('http://localhost:11434/api/embed', () =>
        HttpResponse.json({ error: 'model not found' }, { status: 404 })
      )
    );
    const e = new OllamaEmbedder({
      baseUrl: 'http://localhost:11434',
      model: 'bge-small-en:v1.5',
      dimension: 384
    });
    await expect(e.embed('x')).rejects.toSatisfy((err: unknown) => {
      return err instanceof EmbedError && err.code === 'unavailable';
    });
  });

  it('embed: throws EmbedError(invalid_response) on missing embeddings field', async () => {
    server.use(
      http.post('http://localhost:11434/api/embed', () => HttpResponse.json({ wrong: 'shape' }))
    );
    const e = new OllamaEmbedder({
      baseUrl: 'http://localhost:11434',
      model: 'bge-small-en:v1.5',
      dimension: 384
    });
    await expect(e.embed('x')).rejects.toSatisfy((err: unknown) => {
      return err instanceof EmbedError && err.code === 'invalid_response';
    });
  });

  it('embed: an EMPTY embeddings list maps to an actionable invalid_response', async () => {
    server.use(
      http.post('http://localhost:11434/api/embed', () => HttpResponse.json({ embeddings: [] }))
    );
    const e = new OllamaEmbedder({
      baseUrl: 'http://localhost:11434',
      model: 'bge-m3',
      dimension: 1024
    });
    await expect(e.embed('a very long document')).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof EmbedError &&
        err.code === 'invalid_response' &&
        /empty embeddings/i.test(err.message)
      );
    });
  });

  it('embed: an empty inner vector maps to an actionable invalid_response (legacy long-input symptom)', async () => {
    server.use(
      http.post('http://localhost:11434/api/embed', () => HttpResponse.json({ embeddings: [[]] }))
    );
    const e = new OllamaEmbedder({
      baseUrl: 'http://localhost:11434',
      model: 'bge-m3',
      dimension: 1024
    });
    await expect(e.embed('a very long document')).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof EmbedError &&
        err.code === 'invalid_response' &&
        /expected dimension 1024, got 0/.test(err.message)
      );
    });
  });

  it('embed: throws EmbedError(invalid_response) on dimension mismatch', async () => {
    server.use(
      http.post('http://localhost:11434/api/embed', () =>
        HttpResponse.json({ embeddings: [[0.1, 0.2, 0.3]] })
      )
    );
    const e = new OllamaEmbedder({
      baseUrl: 'http://localhost:11434',
      model: 'bge-small-en:v1.5',
      dimension: 384
    });
    await expect(e.embed('x')).rejects.toSatisfy((err: unknown) => {
      return err instanceof EmbedError && err.code === 'invalid_response';
    });
  });

  it('embed: respects timeoutMs (aborts slow requests)', async () => {
    server.use(
      http.post('http://localhost:11434/api/embed', async () => {
        await new Promise((r) => setTimeout(r, 100));
        return HttpResponse.json({ embeddings: [[0.1]] });
      })
    );
    const e = new OllamaEmbedder({
      baseUrl: 'http://localhost:11434',
      model: 'bge-small-en:v1.5',
      dimension: 1,
      timeoutMs: 10
    });
    await expect(e.embed('x')).rejects.toSatisfy((err: unknown) => {
      return err instanceof EmbedError && err.code === 'unavailable';
    });
  });

  describe('context length', () => {
    const vec = Array.from({ length: 8 }, () => 0.1);

    it('sends an explicit contextLength without asking /api/show', async () => {
      let showCalls = 0;
      let seenOptions: unknown;
      server.use(
        http.post('http://localhost:11434/api/show', () => {
          showCalls++;
          return HttpResponse.json({});
        }),
        http.post('http://localhost:11434/api/embed', async ({ request }) => {
          seenOptions = ((await request.json()) as { options?: unknown }).options;
          return HttpResponse.json({ embeddings: [vec] });
        })
      );
      const e = new OllamaEmbedder({ model: 'm', dimension: 8, contextLength: 4096 });
      await e.embed('x');
      expect(seenOptions).toEqual({ num_ctx: 4096, num_batch: 4096 });
      expect(showCalls).toBe(0);
    });

    it('discovers the context length once across embeds', async () => {
      let showCalls = 0;
      server.use(
        http.post('http://localhost:11434/api/show', () => {
          showCalls++;
          return HttpResponse.json({ model_info: { 'nomic-bert.context_length': 2048 } });
        }),
        http.post('http://localhost:11434/api/embed', () =>
          HttpResponse.json({ embeddings: [vec] })
        )
      );
      const e = new OllamaEmbedder({ model: 'm', dimension: 8 });
      await e.embed('a');
      await e.embed('b');
      expect(showCalls).toBe(1);
    });

    it('throws EmbedError(unavailable) when /api/show fails', async () => {
      server.use(
        http.post(
          'http://localhost:11434/api/show',
          () => new HttpResponse('nope', { status: 500 })
        )
      );
      const e = new OllamaEmbedder({ model: 'm', dimension: 8 });
      await expect(e.embed('x')).rejects.toSatisfy(
        (err: unknown) => err instanceof EmbedError && err.code === 'unavailable'
      );
    });

    it('throws EmbedError(invalid_response) when /api/show reports no context length', async () => {
      server.use(
        http.post('http://localhost:11434/api/show', () => HttpResponse.json({ model_info: {} }))
      );
      const e = new OllamaEmbedder({ model: 'm', dimension: 8 });
      await expect(e.embed('x')).rejects.toSatisfy(
        (err: unknown) => err instanceof EmbedError && err.code === 'invalid_response'
      );
    });
  });

  describe('per-call timeout', () => {
    it('aborts a stalled embed at the per-call timeoutMs, overriding the instance default', async () => {
      server.use(
        http.post('http://localhost:11434/api/embed', async () => {
          await delay('infinite');
          return HttpResponse.json({});
        })
      );
      const e = new OllamaEmbedder({
        model: 'm',
        dimension: 8,
        contextLength: 2048,
        timeoutMs: 60_000
      });
      const t0 = Date.now();
      await expect(e.embed('x', { timeoutMs: 50 })).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof EmbedError &&
          err.code === 'unavailable' &&
          /timed out after 50ms/.test(err.message)
      );
      expect(Date.now() - t0).toBeLessThan(2_000);
    });

    it('bounds the /api/show lookup by the same per-call timeout', async () => {
      server.use(
        http.post('http://localhost:11434/api/show', async () => {
          await delay('infinite');
          return HttpResponse.json({});
        })
      );
      const e = new OllamaEmbedder({ model: 'm', dimension: 8, timeoutMs: 60_000 });
      await expect(e.embed('x', { timeoutMs: 50 })).rejects.toSatisfy(
        (err: unknown) => err instanceof EmbedError && err.code === 'unavailable'
      );
    });
  });
});
