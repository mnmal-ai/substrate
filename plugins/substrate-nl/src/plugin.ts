/**
 * `@mnmal-ai/substrate-nl` as a substrate plugin: NL owns no namespace, only two
 * kernel routes. Both are read-gated: row policy keeps the data safe, and the
 * gate keeps an anonymous caller from spending the operator's judge GPU.
 */
import type { KernelPlugin } from '@mnmal-ai/substrate/sdk';
import type { NlEngineAccess } from './access.js';
import type { Judge } from './judge/judge.js';
import type { NamespaceRulings } from './pack/rulings.js';
import { PackService } from './pack/service.js';
import { askHandler, packHandler } from './routes.js';

export interface NlPluginConfig {
  engine: NlEngineAccess;
  judge?: Judge;
  judgeTimeoutMs?: number;
  rulings?: Record<string, NamespaceRulings>;
  packTtlMs?: number;
}

/** The routes rely on `KernelRouteClaim.capability`, which every 1.x host honours. */
export const CONTRACT_VERSION = '>=1.0.0-alpha.0 <2.0.0';

export function createNlPlugin(cfg: NlPluginConfig): KernelPlugin {
  const packs = new PackService({
    engine: cfg.engine,
    ...(cfg.rulings !== undefined ? { rulings: cfg.rulings } : {}),
    ...(cfg.packTtlMs !== undefined ? { ttlMs: cfg.packTtlMs } : {})
  });
  const deps = {
    engine: cfg.engine,
    packs,
    ...(cfg.judge !== undefined ? { judge: cfg.judge } : {}),
    ...(cfg.judgeTimeoutMs !== undefined ? { judgeTimeoutMs: cfg.judgeTimeoutMs } : {})
  };
  return {
    name: 'substrate-nl',
    contractVersion: CONTRACT_VERSION,
    kernelRoutes: [
      { path: 'nl', method: 'POST', handler: askHandler(deps), capability: 'read' },
      { path: 'nl/pack/:ns', method: 'GET', handler: packHandler(deps), capability: 'read' }
    ]
  };
}
