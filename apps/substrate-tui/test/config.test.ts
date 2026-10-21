import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';

describe('readConfig', () => {
  it('requires SUBSTRATE_URL', () => {
    expect(readConfig({}, '/x/substrate')).toEqual({
      error: 'SUBSTRATE_URL is required (e.g. https://substrate.example.com:3100)'
    });
  });
  it('takes the namespace from env and the project from the cwd basename; trims a trailing slash', () => {
    const c = readConfig(
      { SUBSTRATE_URL: 'https://h:3100/', SUBSTRATE_NAMESPACE: 'notes' },
      '/x/substrate'
    );
    expect(c).toMatchObject({
      endpoint: 'https://h:3100',
      namespace: 'notes',
      project: 'substrate',
      token: null
    });
  });
  it('needs a namespace: there is no default', () => {
    for (const env of [
      { SUBSTRATE_URL: 'http://h' },
      { SUBSTRATE_URL: 'http://h', SUBSTRATE_NAMESPACE: '' }
    ]) {
      expect(readConfig(env, '/r')).toMatchObject({
        error: expect.stringMatching(/SUBSTRATE_NAMESPACE/)
      });
    }
  });
  it('a set-but-broken signing key is a config error, not a throw', () => {
    const c = readConfig(
      {
        SUBSTRATE_URL: 'http://h',
        SUBSTRATE_NAMESPACE: 'notes',
        SUBSTRATE_AGENT_KEY_ID: 'k',
        SUBSTRATE_AGENT_KEY_PATH: '/nonexistent/key'
      },
      '/r'
    );
    expect(c).toMatchObject({ error: expect.stringMatching(/^agent identity: /) });
  });
});
