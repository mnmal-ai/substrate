/**
 * MCP serverInfo.version tracks the package version rather than a hardcoded
 * string.
 */

import { describe, expect, it } from 'vitest';
import appPkg from '../package.json' with { type: 'json' };
import { MCP_SERVER_VERSION } from '../src/mcp/server.js';

describe('MCP serverInfo version', () => {
  it('reports the real package version, not a hardcoded constant', () => {
    expect(MCP_SERVER_VERSION).toBe(appPkg.version);
    expect(MCP_SERVER_VERSION).not.toBe('2.0.0');
    expect(MCP_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
