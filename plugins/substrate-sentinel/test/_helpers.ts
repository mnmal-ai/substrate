/**
 * Test helper: builds the sentinel plugin with sane defaults plus
 * caller-supplied overrides.
 */

import type { CoordinatorPlugin } from '@mnmal-ai/substrate/sdk';
import { createSentinelPlugin, type SentinelPluginConfig } from '../src/index.js';

export function buildSentinelForTest(
  overrides: Partial<SentinelPluginConfig> = {}
): CoordinatorPlugin {
  return createSentinelPlugin({
    namespace: 'sentinel',
    pingIntervalMs: 30_000,
    staleThresholdMs: 90_000,
    ...overrides
  });
}
