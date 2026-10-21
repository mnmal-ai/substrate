import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLUSTERER_BACKEND_VERSION } from '../src/clusterer-version.js';

describe('CLUSTERER_BACKEND_VERSION', () => {
  it('matches the installed @mnmal-ai/holomap-clusterer', () => {
    const manifestPath = new URL(
      '../node_modules/@mnmal-ai/holomap-clusterer/package.json',
      import.meta.url
    );
    const installed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string };
    expect(CLUSTERER_BACKEND_VERSION).toBe(installed.version);
  });
});
