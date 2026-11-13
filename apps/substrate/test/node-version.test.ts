import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIN_NODE_VERSION, nodeVersionRefusal, runtimeRefusal } from '../src/node-version.js';

describe('nodeVersionRefusal', () => {
  it('matches engines.node in package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.engines.node).toBe(`>=${MIN_NODE_VERSION}`);
  });

  it('refuses versions below the minimum, naming both', () => {
    for (const v of ['26.13.0', '26.12.1', '26.2.0', '24.11.1']) {
      const refusal = nodeVersionRefusal(v);
      expect(refusal).toContain(MIN_NODE_VERSION);
      expect(refusal).toContain(v);
    }
  });

  it('accepts the minimum and newer', () => {
    for (const v of ['26.13.1', '26.13.10', '26.14.0', '27.0.0']) {
      expect(nodeVersionRefusal(v)).toBeNull();
    }
  });
});

describe('runtimeRefusal', () => {
  it('exempts Bun, whose reported Node version is a compatibility number', () => {
    expect(runtimeRefusal({ node: '24.3.0', bun: '1.3.13' })).toBeNull();
  });

  it('still refuses an old Node', () => {
    expect(runtimeRefusal({ node: '24.3.0' })).toContain(MIN_NODE_VERSION);
  });
});
