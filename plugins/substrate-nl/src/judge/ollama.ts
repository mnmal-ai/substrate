import type { Judge, JudgePrompt } from './judge.js';

export interface OllamaJudgeConfig {
  baseUrl: string;
  model: string;
  /** Abort a call after this long. Default 60s. */
  timeoutMs?: number;
}

/**
 * Ollama's native chat endpoint with `format` set to the question's schema,
 * so decoding cannot leave the offered options. Thinking off, temperature 0
 * and a fixed seed. Sends no `num_ctx` / `keep_alive`: Ollama shares one
 * runner per model, and differing options force a reload for every client
 * (see substrate-embedder's README).
 */
export class OllamaJudge implements Judge {
  readonly #config: OllamaJudgeConfig;

  constructor(config: OllamaJudgeConfig) {
    this.#config = { ...config, baseUrl: config.baseUrl.replace(/\/+$/, '') };
  }

  async decide(prompt: JudgePrompt, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.#config.timeoutMs ?? 60_000);
    const res = await fetch(`${this.#config.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
      body: JSON.stringify({
        model: this.#config.model,
        stream: false,
        think: false,
        format: prompt.schema,
        options: { temperature: 0, seed: 0 },
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user }
        ]
      })
    });
    if (!res.ok) throw new Error(`ollama ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { message?: { content?: string } };
    return JSON.parse(body.message?.content ?? '');
  }
}
