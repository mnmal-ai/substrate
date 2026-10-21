import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpJsonError, type HttpJsonFn, type HttpJsonResult } from '../src/cli/federate/http.js';
import { formatJoinOutput, runJoin } from '../src/cli/federate/join.js';
import { parseJoinArgs, runFederate } from '../src/cli/federate/main.js';
import { encodeJoinToken } from '../src/cli/federate/token.js';

const ORIGIN = 'https://b.internal:3100';
const TOKEN = encodeJoinToken({ origin: ORIGIN, code: 'invite-code-1' });

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(pathJoin(tmpdir(), 'federate-join-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Stub peer returning a fixed response, recording the calls it received. */
function stubPeer(response: HttpJsonResult | Error): {
  fn: HttpJsonFn;
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fn: HttpJsonFn = async (url, opts) => {
    calls.push({ url, body: opts?.body });
    if (response instanceof Error) throw response;
    return response;
  };
  return { fn, calls };
}

const ok201: HttpJsonResult = {
  status: 201,
  body: { kid: '7Kq2mXnP4vR8sT1w', namespaces: ['demo'], capabilities: ['read'] },
  raw: ''
};

describe('runJoin', () => {
  it('redeems and writes the private key at 0600', async () => {
    const keyOut = pathJoin(dir, 'peer-b.key');
    const peer = stubPeer(ok201);
    const result = await runJoin(
      { token: TOKEN, name: 'peer-b', keyOut },
      { httpJson: peer.fn, hostname: () => 'a-host' }
    );

    expect(result.kid).toBe('7Kq2mXnP4vR8sT1w');
    expect(result.namespaces).toEqual(['demo']);
    expect(existsSync(keyOut)).toBe(true);
    expect(statSync(keyOut).mode & 0o777).toBe(0o600);
    expect(readFileSync(keyOut, 'utf8')).toContain('BEGIN PRIVATE KEY');

    expect(peer.calls).toHaveLength(1);
    expect(peer.calls[0]?.url).toBe(`${ORIGIN}/substrate/v1/_system/register`);
    const sent = peer.calls[0]?.body as Record<string, unknown>;
    expect(sent.code).toBe('invite-code-1');
    expect(sent.algorithm).toBe('EdDSA');
    expect(sent.keyName).toBe('bridge from a-host');
    expect(String(sent.publicKey)).toContain('BEGIN PUBLIC KEY');
  });

  it('refuses an existing key-out path WITHOUT contacting the peer', async () => {
    // Burning a single-use invite and then discovering there is nowhere to
    // put the key would leave the operator with a consumed token and no
    // credential. The guard must come first.
    const keyOut = pathJoin(dir, 'taken.key');
    writeFileSync(keyOut, 'pre-existing');
    const peer = stubPeer(ok201);

    await expect(
      runJoin({ token: TOKEN, name: 'peer-b', keyOut }, { httpJson: peer.fn })
    ).rejects.toThrow(/already exists/);

    expect(peer.calls).toHaveLength(0);
    expect(readFileSync(keyOut, 'utf8')).toBe('pre-existing');
  });

  const failures: Array<{ label: string; response: HttpJsonResult | Error; match: RegExp }> = [
    {
      label: 'unrecognised invite',
      response: { status: 400, body: { code: 'invite_not_found' }, raw: '' },
      match: /not recognised/
    },
    {
      label: 'already consumed',
      response: { status: 409, body: { code: 'invite_already_consumed' }, raw: '' },
      match: /single use/
    },
    {
      label: 'expired',
      response: { status: 410, body: { code: 'invite_expired' }, raw: '' },
      match: /expired/
    },
    {
      label: 'rate limited',
      response: { status: 429, body: { code: 'rate_limited', retryAfterMs: 30_000 }, raw: '' },
      match: /rate-limiting/
    },
    {
      label: 'network failure',
      response: new HttpJsonError('connect ECONNREFUSED'),
      match: /cannot reach/
    }
  ];

  for (const { label, response, match } of failures) {
    it(`leaves no key file behind on ${label}`, async () => {
      const keyOut = pathJoin(dir, 'never.key');
      const peer = stubPeer(response);
      await expect(
        runJoin({ token: TOKEN, name: 'peer-b', keyOut }, { httpJson: peer.fn })
      ).rejects.toThrow(match);
      expect(existsSync(keyOut)).toBe(false);
    });
  }

  it('names the token origin in a network failure, not just the host', async () => {
    // The origin came from the token, so a wrong-URL mint and a dead peer are
    // different faults — the message must let the operator tell them apart.
    const peer = stubPeer(new HttpJsonError('connect ECONNREFUSED'));
    await expect(
      runJoin(
        { token: TOKEN, name: 'peer-b', keyOut: pathJoin(dir, 'x.key') },
        { httpJson: peer.fn }
      )
    ).rejects.toThrow(new RegExp(ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('defaults the peer name to the origin hostname', async () => {
    const peer = stubPeer(ok201);
    const result = await runJoin(
      { token: TOKEN, name: undefined, keyOut: pathJoin(dir, 'k.key') },
      { httpJson: peer.fn }
    );
    expect(result.name).toBe('b.internal');
  });

  it('names the consumed invite when the key write fails after redemption', async () => {
    // `existsSync(keyPath)` only proves the leaf is free — not that the
    // parent is creatable. Force a real fs failure (ENOTDIR: the parent
    // segment is a plain file) to prove the post-redemption error names the
    // spent invite rather than escaping as a raw fs error.
    const blocker = pathJoin(dir, 'not-a-directory');
    writeFileSync(blocker, 'im a file, not a directory');
    const keyOut = pathJoin(blocker, 'peer-b.key');
    const peer = stubPeer(ok201);

    await expect(
      runJoin({ token: TOKEN, name: 'peer-b', keyOut }, { httpJson: peer.fn })
    ).rejects.toThrow(/invite token IS consumed/);

    // The register call DID go out — this is the whole point: redemption
    // already happened at the peer, only the local write failed.
    expect(peer.calls).toHaveLength(1);
    expect(existsSync(keyOut)).toBe(false);
  });

  it('defaults the key path under the home substrate-keys directory', async () => {
    const peer = stubPeer(ok201);
    const result = await runJoin(
      { token: TOKEN, name: 'peer-b', keyOut: undefined },
      { httpJson: peer.fn, homeDir: () => dir }
    );
    expect(result.keyPath).toBe(pathJoin(dir, '.config/substrate/keys', 'peer-b.key'));
    expect(existsSync(result.keyPath)).toBe(true);
  });
});

describe('formatJoinOutput', () => {
  it('emits paste-ready bridge and credential lines', () => {
    const printed = formatJoinOutput({
      origin: ORIGIN,
      name: 'peer-b',
      kid: '7Kq2mXnP4vR8sT1w',
      namespaces: ['demo'],
      capabilities: ['read'],
      keyPath: '/home/operator/.config/substrate/keys/peer-b.key'
    });
    expect(printed).toContain(
      `SUBSTRATE_BRIDGES='[{"ns":"demo","name":"peer-b","url":"${ORIGIN}"}]'`
    );
    expect(printed).toContain(
      `SUBSTRATE_BRIDGE_CREDENTIALS='{"peer-b":{"keyPath":"/home/operator/.config/substrate/keys/peer-b.key","kid":"7Kq2mXnP4vR8sT1w","origin":"${ORIGIN}"}}'`
    );
  });

  it('emits one bridge entry per granted namespace, sharing one credential', () => {
    const printed = formatJoinOutput({
      origin: ORIGIN,
      name: 'peer-b',
      kid: 'k1',
      namespaces: ['demo', 'logs'],
      capabilities: ['read'],
      keyPath: '/tmp/peer-b.key'
    });
    expect(printed).toContain(`{"ns":"demo","name":"peer-b","url":"${ORIGIN}"}`);
    expect(printed).toContain(`{"ns":"logs","name":"peer-b","url":"${ORIGIN}"}`);
    // One coordinator, one credential — the store is keyed by coordinator name.
    expect(printed.match(/"peer-b":\{/g)).toHaveLength(1);
  });
});

describe('parseJoinArgs', () => {
  it('takes the token as a positional', () => {
    expect(parseJoinArgs(['join', TOKEN]).token).toBe(TOKEN);
  });

  it('requires a token', () => {
    expect(() => parseJoinArgs(['join'])).toThrow(/SUBSTRATE_JOIN_TOKEN/);
  });

  it('takes the token from SUBSTRATE_JOIN_TOKEN, and refuses it twice', () => {
    expect(parseJoinArgs(['join'], { SUBSTRATE_JOIN_TOKEN: TOKEN }).token).toBe(TOKEN);
    expect(() => parseJoinArgs(['join', TOKEN], { SUBSTRATE_JOIN_TOKEN: TOKEN })).toThrow(/both/);
  });

  it('warns when the token is on argv', async () => {
    const err: string[] = [];
    await runFederate(
      ['join', 'not-a-token'],
      {},
      () => {},
      (s) => err.push(s)
    );
    expect(err[0]).toMatch(/^warning: .*visible in ps/);
  });

  it('rejects a second positional', () => {
    expect(() => parseJoinArgs(['join', TOKEN, 'extra'])).toThrow(/unexpected positional/);
  });

  it('reads --name and --key-out', () => {
    const args = parseJoinArgs(['join', TOKEN, '--name', 'p', '--key-out', '/k']);
    expect(args).toMatchObject({ name: 'p', keyOut: '/k' });
  });

  it('rejects an unknown flag', () => {
    expect(() => parseJoinArgs(['join', TOKEN, '--wat'])).toThrow(/unknown flag/);
  });
});
