/**
 * `_diagnostics` surfacing (spec §7.0). The thing under test is that a
 * SUCCESSFUL read carrying an unknown
 * projection key cannot pass through this client silently — so most of these
 * assert on the sink firing, not on the envelope retaining a field.
 */

import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubstrateClient } from '../src/client.js';
import {
  collectDiagnostics,
  createDefaultDiagnosticsSink,
  type Diagnostic
} from '../src/diagnostics.js';
import { mockHandlers } from './_setup.js';

const ENDPOINT = 'http://substrate.test';
const SCHEMA = { claude: { schemaVersion: 'v1', types: {}, mutations: {} } };

let client: SubstrateClient;

afterEach(async () => {
  await client?.close();
  vi.restoreAllMocks();
});

function serve(envelope: Record<string, unknown>): void {
  mockHandlers(
    http.get(`${ENDPOINT}/substrate/v1/federated-schema`, () => HttpResponse.json(SCHEMA)),
    http.post(`${ENDPOINT}/substrate/v1/query`, () => HttpResponse.json(envelope)),
    http.post(`${ENDPOINT}/substrate/v1/mutate`, () => HttpResponse.json(envelope))
  );
}

const WITH_UNKNOWN = {
  schemaVersion: 'v1',
  data: { 'claude/Todo': [{ id: 1, titel: null }] },
  shapes: { 'claude/Todo': 'list' },
  _diagnostics: { 'claude/Todo': { unknownProjectionFields: ['titel'] } }
};

describe('collectDiagnostics', () => {
  it('absent _diagnostics reports nothing and never calls the sink', () => {
    const sink = vi.fn();
    expect(collectDiagnostics(undefined, sink)).toEqual([]);
    expect(sink).not.toHaveBeenCalled();
  });

  it('flattens each frame key into an attributed diagnostic', () => {
    const sink = vi.fn();
    const out = collectDiagnostics(
      {
        'claude/Todo': { unknownProjectionFields: ['titel'] },
        'claude/Decision': { unknownProjectionFields: ['boddy', 'raitonale'] }
      },
      sink
    );
    expect(out).toEqual<Diagnostic[]>([
      { opKey: 'claude/Todo', unknownProjectionFields: ['titel'] },
      { opKey: 'claude/Decision', unknownProjectionFields: ['boddy', 'raitonale'] }
    ]);
    expect(sink).toHaveBeenCalledTimes(2);
  });

  // An entry present but empty is not something to report. Without this the
  // default sink would emit a warning naming no fields at all.
  it('skips a key whose unknown-field list is empty or missing', () => {
    const sink = vi.fn();
    expect(
      collectDiagnostics({ 'claude/Todo': { unknownProjectionFields: [] }, 'claude/X': {} }, sink)
    ).toEqual([]);
    expect(sink).not.toHaveBeenCalled();
  });

  it('copies the field array so a caller cannot mutate the envelope', () => {
    const env = { 'claude/Todo': { unknownProjectionFields: ['titel'] } };
    const out = collectDiagnostics(env, undefined);
    expect(out).toHaveLength(1);
    out[0]!.unknownProjectionFields.push('injected');
    expect(env['claude/Todo'].unknownProjectionFields).toEqual(['titel']);
  });
});

describe('default sink', () => {
  it('names the op-key and every unknown field', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createDefaultDiagnosticsSink()({
      opKey: 'claude/Todo',
      unknownProjectionFields: ['titel', 'donne']
    });
    const msg = warn.mock.calls[0]?.[0] as string;
    expect(msg).toContain('claude/Todo');
    expect(msg).toContain('titel');
    // Naming every field is the point — "one or more fields were unknown"
    // sends the reader back to diff a long projection by hand.
    expect(msg).toContain('donne');
  });

  it('warns once per distinct op-key/field-set, not once per occurrence', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = createDefaultDiagnosticsSink();
    const d: Diagnostic = { opKey: 'claude/Todo', unknownProjectionFields: ['titel'] };
    sink(d);
    sink(d);
    sink(d);
    expect(warn).toHaveBeenCalledTimes(1);

    // ...but a DIFFERENT defect is still audible. A dedupe keyed too broadly
    // (e.g. on op-key alone) would swallow this, which is the failure mode that
    // makes deduping worse than not deduping.
    sink({ opKey: 'claude/Todo', unknownProjectionFields: ['donne'] });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('dedupes regardless of field order', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = createDefaultDiagnosticsSink();
    sink({ opKey: 'claude/Todo', unknownProjectionFields: ['a', 'b'] });
    sink({ opKey: 'claude/Todo', unknownProjectionFields: ['b', 'a'] });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('dedupe state is per client, so a fresh client warns again', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d: Diagnostic = { opKey: 'claude/Todo', unknownProjectionFields: ['titel'] };
    createDefaultDiagnosticsSink()(d);
    createDefaultDiagnosticsSink()(d);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('SubstrateClient wiring', () => {
  beforeEach(() => serve(WITH_UNKNOWN));

  it('routes query diagnostics to a caller-supplied sink', async () => {
    const onDiagnostics = vi.fn();
    client = new SubstrateClient({ endpoint: ENDPOINT, onDiagnostics });
    await client.query({ 'claude/Todo': { params: {}, fields: { id: true, titel: true } } });
    expect(onDiagnostics).toHaveBeenCalledWith({
      opKey: 'claude/Todo',
      unknownProjectionFields: ['titel']
    });
  });

  it('routes mutate diagnostics too — the returned row is mapped the same way', async () => {
    const onDiagnostics = vi.fn();
    client = new SubstrateClient({ endpoint: ENDPOINT, onDiagnostics });
    await client.mutate({ 'claude/createTodo': { params: {}, fields: { titel: true } } });
    expect(onDiagnostics).toHaveBeenCalledTimes(1);
  });

  it('warns by default — an unconfigured client must not be silent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    client = new SubstrateClient({ endpoint: ENDPOINT });
    await client.query({ 'claude/Todo': { params: {}, fields: { titel: true } } });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('retains the slot on the envelope as well as reporting it', async () => {
    client = new SubstrateClient({ endpoint: ENDPOINT, onDiagnostics: () => {} });
    const env = await client.query({ 'claude/Todo': { params: {}, fields: { titel: true } } });
    expect(env._diagnostics).toEqual({ 'claude/Todo': { unknownProjectionFields: ['titel'] } });
  });

  // The whole posture rests on this: a diagnostic is NOT an error, and a
  // consumer doing `if (env.errors) throw` must not start failing on reads that
  // succeeded.
  it('does not populate errors and does not reject', async () => {
    client = new SubstrateClient({ endpoint: ENDPOINT, onDiagnostics: () => {} });
    const env = await client.query({ 'claude/Todo': { params: {}, fields: { titel: true } } });
    expect(env.errors).toBeUndefined();
    expect(env.data).toEqual({ 'claude/Todo': [{ id: 1, titel: null }] });
  });
});

describe('a clean envelope stays quiet', () => {
  it('no _diagnostics means no sink call and no warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onDiagnostics = vi.fn();
    serve({
      schemaVersion: 'v1',
      data: { 'claude/Todo': [{ id: 1 }] },
      shapes: { 'claude/Todo': 'list' }
    });
    client = new SubstrateClient({ endpoint: ENDPOINT, onDiagnostics });
    await client.query({ 'claude/Todo': { params: {}, fields: { id: true } } });
    expect(onDiagnostics).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * `filterValidationSkipped` and diagnostic kinds this client does not know.
 * The question is not "does the new field work" but "can a diagnostic this
 * client does not handle pass through unheard" — `check-types` cannot catch
 * that, because a narrower parameter type accepts the wider envelope
 * structurally. The last group covers the general case.
 */
describe('diagnostics beyond unknown projection fields', () => {
  it('reports filterValidationSkipped arriving on its own', () => {
    const sink = vi.fn();
    const out = collectDiagnostics(
      { 'claude/Todo': { filterValidationSkipped: 'type absent from published schema' } },
      sink
    );
    expect(out).toEqual<Diagnostic[]>([
      {
        opKey: 'claude/Todo',
        unknownProjectionFields: [],
        filterValidationSkipped: 'type absent from published schema'
      }
    ]);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  // One entry is one op-key's worth of observations, so it stays one
  // diagnostic. Splitting it would make the same read look like two defects.
  it('carries both observations on a single attributed diagnostic', () => {
    const out = collectDiagnostics(
      {
        'claude/Todo': {
          unknownProjectionFields: ['titel'],
          filterValidationSkipped: 'runtime-created type'
        }
      },
      undefined
    );
    expect(out).toEqual<Diagnostic[]>([
      {
        opKey: 'claude/Todo',
        unknownProjectionFields: ['titel'],
        filterValidationSkipped: 'runtime-created type'
      }
    ]);
  });

  it('says nothing when every known key is absent or empty', () => {
    const sink = vi.fn();
    expect(
      collectDiagnostics({ 'claude/Todo': { unknownProjectionFields: [] }, 'claude/X': {} }, sink)
    ).toEqual([]);
    expect(sink).not.toHaveBeenCalled();
  });

  it("a walk read's plan is information, never a warning", () => {
    const sink = vi.fn();
    const plan = [{ path: ['where', '_walk'], kind: 'hop' as const, served: true }];
    expect(collectDiagnostics({ 'cards/Cert': { plan } }, sink)).toEqual([]);
    expect(sink).not.toHaveBeenCalled();
  });

  // The general fix. A published client cannot be recompiled against the
  // substrate it meets at runtime, so the compile-time guard below cannot help
  // there — an older client talking to a newer substrate has to say so itself.
  it('reports a diagnostic key this client version does not understand', () => {
    const sink = vi.fn();
    const fromNewerSubstrate = {
      'claude/Todo': { someFutureDiagnostic: 'value' }
    } as unknown as Parameters<typeof collectDiagnostics>[0];
    const out = collectDiagnostics(fromNewerSubstrate, sink);
    expect(out).toEqual<Diagnostic[]>([
      {
        opKey: 'claude/Todo',
        unknownProjectionFields: [],
        unrecognizedKeys: ['someFutureDiagnostic']
      }
    ]);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('ignores an unrecognised key whose value is undefined', () => {
    const sink = vi.fn();
    const entry = {
      'claude/Todo': { unknownProjectionFields: ['titel'], someFutureDiagnostic: undefined }
    } as unknown as Parameters<typeof collectDiagnostics>[0];
    expect(collectDiagnostics(entry, sink)).toEqual<Diagnostic[]>([
      { opKey: 'claude/Todo', unknownProjectionFields: ['titel'] }
    ]);
  });
});

describe('default sink beyond projection fields', () => {
  it('explains that the filter skipped schema validation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createDefaultDiagnosticsSink()({
      opKey: 'claude/Todo',
      unknownProjectionFields: [],
      filterValidationSkipped: 'type absent from published schema'
    });
    const msg = warn.mock.calls[0]?.[0] as string;
    expect(msg).toContain('claude/Todo');
    expect(msg).toContain('not schema-validated');
    // The projection wording must not leak into a diagnostic about filters —
    // an operator reading "projected field(s) the type does not declare" here
    // goes and diffs a projection that was never the problem.
    expect(msg).not.toContain('projected field');
  });

  it('names the unrecognised key and says the client is behind', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createDefaultDiagnosticsSink()({
      opKey: 'claude/Todo',
      unknownProjectionFields: [],
      unrecognizedKeys: ['someFutureDiagnostic']
    });
    const msg = warn.mock.calls[0]?.[0] as string;
    expect(msg).toContain('someFutureDiagnostic');
    expect(msg).toContain('substrate-client');
  });

  // Dedupe keyed on the projection field-set alone would swallow this: same
  // op-key, same (empty) field set, genuinely different defect.
  it('does not collapse a filter diagnostic into a projection one on the same op-key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = createDefaultDiagnosticsSink();
    sink({ opKey: 'claude/Todo', unknownProjectionFields: ['titel'] });
    sink({ opKey: 'claude/Todo', unknownProjectionFields: [], filterValidationSkipped: 'why' });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('still dedupes an identical filter diagnostic', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = createDefaultDiagnosticsSink();
    const d: Diagnostic = {
      opKey: 'claude/Todo',
      unknownProjectionFields: [],
      filterValidationSkipped: 'why'
    };
    sink(d);
    sink(d);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('SubstrateClient wiring for filter diagnostics', () => {
  it('routes a filterValidationSkipped envelope to the sink', async () => {
    const onDiagnostics = vi.fn();
    serve({
      schemaVersion: 'v1',
      data: { 'claude/Todo': [{ id: 1 }] },
      shapes: { 'claude/Todo': 'list' },
      _diagnostics: { 'claude/Todo': { filterValidationSkipped: 'runtime-created type' } }
    });
    client = new SubstrateClient({ endpoint: ENDPOINT, onDiagnostics });
    await client.query({ 'claude/Todo': { params: {}, fields: { id: true } } });
    expect(onDiagnostics).toHaveBeenCalledWith({
      opKey: 'claude/Todo',
      unknownProjectionFields: [],
      filterValidationSkipped: 'runtime-created type'
    });
  });
});

describe('dedupe key separator', () => {
  // The sink's dedupe key joins on NUL, which no op-key, field name or substrate
  // message can contain. It must be written as an escape: a raw NUL byte makes
  // the source file binary to git. A printable separator would not do:
  // `filterValidationSkipped` carries free-form prose from the substrate.
  it('does not collide when a diagnostic value contains a printable separator', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink = createDefaultDiagnosticsSink();
    sink({
      opKey: 'claude/Todo',
      unknownProjectionFields: ['a|b'],
      filterValidationSkipped: 'c',
      unrecognizedKeys: ['d']
    });
    sink({
      opKey: 'claude/Todo',
      unknownProjectionFields: ['a'],
      filterValidationSkipped: 'b|c',
      unrecognizedKeys: ['d']
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
