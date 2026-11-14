import type { QualifiedFrame, SubstrateClient } from '@mnmal-ai/substrate/client';
import type { PackEnvelope } from '@mnmal-ai/substrate/sdk';
import { createApp } from '@mnmal-ai/surface-core';
import { marathon } from '@mnmal-ai/surface-theme';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { adminModule } from '../src/admin/module.js';
import { describeMutate, parseMutateFrame } from '../src/admin/mutate.js';
import { createAdminSession } from '../src/admin/session.js';
import type { TuiDeps } from '../src/deps.js';
import { noAdmin, noDash } from './_fakes.js';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const until = (assert: () => void) => vi.waitFor(assert, { timeout: 2000, interval: 20 });
const ENTER = '\r';

const FRAME = {
  'ops/updateThing': { params: { id: 'r-1', retired: true }, fields: { id: true } }
};
const env = (over: Partial<PackEnvelope>): PackEnvelope => ({
  schemaVersion: '1',
  data: {},
  shapes: {},
  ...over
});

function start(reply: (frame: QualifiedFrame) => Promise<PackEnvelope>, unlocked = true) {
  const sent: QualifiedFrame[] = [];
  const admin = createAdminSession({
    endpoint: 'http://h',
    idleMs: 60_000,
    makeClient: () =>
      ({
        mutate: async (frame: QualifiedFrame) => {
          sent.push(frame);
          return reply(frame);
        },
        close: async () => {}
      }) as unknown as SubstrateClient
  });
  if (unlocked) admin.unlock('ops-admin@Box', () => 't');
  const deps: TuiDeps = {
    endpoint: 'http://h',
    project: 'substrate',
    namespace: 'journal',
    nl: {} as TuiDeps['nl'],
    federatedSchema: async () => ({}),
    getJson: async () => ({}),
    ...noDash,
    ...noAdmin(),
    admin
  };
  const { App } = createApp({
    theme: marathon,
    modules: [adminModule(deps, { diagnose: async () => ({}) as never })],
    band: true
  });
  const r = render(<App columns={160} rows={50} />);
  return { ...r, deps, sent, frame: () => r.lastFrame() ?? '' };
}

async function type(app: { stdin: { write(s: string): void } }, line: string) {
  app.stdin.write(line);
  await tick();
  app.stdin.write(ENTER);
  await tick();
}

async function toPreview(app: ReturnType<typeof start>) {
  await type(app, '/admin mutate');
  await until(() => expect(app.frame()).toContain('paste the mutate frame'));
  await type(app, JSON.stringify(FRAME));
  await until(() => expect(app.frame()).toContain('type ops/updateThing then enter to send'));
}

describe('/admin mutate (#1915)', () => {
  it('previews the frame and what it touches, and sends nothing yet', async () => {
    const app = start(async () => env({}));
    await toPreview(app);
    const f = app.frame();
    expect(f).toContain('ops/updateThing · 1 entry');
    expect(f).toContain('row r-1 · params retired');
    expect(f).toContain('signed as admin ops-admin@Box; nothing has been sent');
    expect(f).toContain('"retired": true');
    expect(app.sent).toEqual([]);
    app.unmount();
  });

  it('a confirmation that does not match exactly is refused and sends nothing', async () => {
    const app = start(async () => env({}));
    await toPreview(app);
    await type(app, 'ops/updatething');
    await until(() => expect(app.frame()).toContain("doesn't match"));
    await type(app, 'ops/updateThing ');
    expect(app.frame()).toContain("doesn't match");
    expect(app.sent).toEqual([]);
    app.unmount();
  });

  it('sends the frame as typed, signed as admin, and shows the result verbatim', async () => {
    const app = start(async () => env({ data: { 'ops/updateThing': { id: 'r-1' } } }));
    await toPreview(app);
    await type(app, 'ops/updateThing');
    await until(() => expect(app.frame()).toContain('· done'));
    expect(app.sent).toEqual([FRAME]);
    expect(app.frame()).toContain('"ops/updateThing": {');
    expect(app.frame()).toContain('✓ admin mutate ops/updateThing applied (admin: ops-admin@Box)');
    app.unmount();
  });

  it('a refused frame shows the errors first and names the key absent from data', async () => {
    const app = start(async () =>
      env({
        data: {},
        errors: [{ code: 'policy_denied', message: 'no', path: ['ops/updateThing'] }]
      } as Partial<PackEnvelope>)
    );
    await toPreview(app);
    await type(app, 'ops/updateThing');
    await until(() => expect(app.frame()).toContain('· refused'));
    const f = app.frame();
    expect(f).toContain('"code": "policy_denied"');
    expect(f).toContain('ops/updateThing: absent from data — not applied');
    expect(f.indexOf('errors:')).toBeLessThan(f.indexOf('data:'));
    app.unmount();
  });

  it('locked, the command is refused and opens nothing', async () => {
    const app = start(async () => env({}), false);
    await type(app, '/admin mutate');
    await until(() =>
      expect(app.frame()).toContain('admin mutate refused: admin is locked — /admin unlock')
    );
    expect(app.frame()).not.toContain('paste the mutate frame');
    app.unmount();
  });

  it('locking with the preview open closes it, and a confirm after that cannot send', async () => {
    const app = start(async () => env({}));
    await toPreview(app);
    app.deps.admin.lock('test');
    await until(() => expect(app.frame()).toContain('admin mutate closed — admin locked'));
    await type(app, 'ops/updateThing');
    expect(app.sent).toEqual([]);
    app.unmount();
  });
});

describe('parseMutateFrame / describeMutate', () => {
  it('refuses non-JSON, an empty frame, unqualified keys and empty batches', () => {
    expect(parseMutateFrame('{')).toHaveProperty('error');
    expect(parseMutateFrame('{}')).toHaveProperty('error');
    expect(parseMutateFrame('[]')).toHaveProperty('error');
    expect(parseMutateFrame('{"updateThing":{}}')).toHaveProperty('error');
    expect(parseMutateFrame('{"ops/updateThing":[]}')).toHaveProperty('error');
    expect(parseMutateFrame('{"ops/updateThing":[1]}')).toHaveProperty('error');
  });

  it('describes a batch as one transaction, entry by entry', () => {
    const f = parseMutateFrame(
      '{"ops/createThing":[{"params":{"title":"a"}},{"params":{"title":"b"}}]}'
    ) as { frame: QualifiedFrame };
    const text = describeMutate(f.frame, 'k').map((l) => l.text);
    expect(text[0]).toBe('ops/createThing · 2 entries, one transaction');
    expect(text[1]).toBe('  no id · params title');
  });
});
