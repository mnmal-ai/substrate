import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import {
  type Identity,
  isBatchElementError,
  MissingReferentError,
  type ResolverArgs
} from '@mnmal-ai/substrate-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertCrossRefTargetsExistMany,
  type CrossRefFieldInfo,
  collectCrossRefFields
} from '../../src/autocrud/crossref-existence.js';
import { field } from '../../src/field.js';

const traceRef = field.crossRef('main', 'Trace', { onMissing: 'reject' });
const softRef = field.crossRef('main', 'Trace'); // onMissing absent => enforce where enforceable
const crossNsRef = field.crossRef('other', 'Thing', { onMissing: 'reject' });

/** The batch check on one element, its refusal unwrapped as a single frame sees it. */
async function assertCrossRefTargetsExist(
  args: ResolverArgs,
  crossRefs: CrossRefFieldInfo[],
  values: Record<string, unknown>,
  fromNs: string,
  identity: Identity | null = null
): Promise<void> {
  try {
    await assertCrossRefTargetsExistMany(args, crossRefs, [values], fromNs, identity);
  } catch (err) {
    throw isBatchElementError(err) ? err.cause : err;
  }
}

describe('assertCrossRefTargetsExistMany, one element', () => {
  let ds: MemoryDataset;
  beforeEach(async () => {
    ds = new MemoryDataset({ namespace: 'main' });
    await ds.write('Trace', [{ id: 't1' }]);
  });

  it('resolves when a reject target exists', async () => {
    const args: ResolverArgs = { dataset: ds };
    await expect(
      assertCrossRefTargetsExist(
        args,
        [{ fieldName: 'trace', def: traceRef }],
        { trace: 't1' },
        'main'
      )
    ).resolves.toBeUndefined();
  });

  it('throws MissingReferentError when a reject target is absent', async () => {
    const args: ResolverArgs = { dataset: ds };
    await expect(
      assertCrossRefTargetsExist(
        args,
        [{ fieldName: 'trace', def: traceRef }],
        { trace: 'nope' },
        'main'
      )
    ).rejects.toBeInstanceOf(MissingReferentError);
  });

  it('treats a tombstoned target as missing', async () => {
    await ds.tombstone('Trace', ['t1']);
    const args: ResolverArgs = { dataset: ds };
    await expect(
      assertCrossRefTargetsExist(
        args,
        [{ fieldName: 'trace', def: traceRef }],
        { trace: 't1' },
        'main'
      )
    ).rejects.toBeInstanceOf(MissingReferentError);
  });

  it('does NOT skip a field whose onMissing is absent — absence means enforce', async () => {
    // A crossRef is a PK<->FK relationship; an enforcement nobody opts into is
    // indistinguishable from no enforcement.
    const args: ResolverArgs = { dataset: ds };
    await expect(
      assertCrossRefTargetsExist(
        args,
        [{ fieldName: 'trace', def: softRef }],
        { trace: 'nope' },
        'main'
      )
    ).rejects.toBeInstanceOf(MissingReferentError);
  });

  it('skips null / absent values', async () => {
    const args: ResolverArgs = { dataset: ds };
    await expect(
      assertCrossRefTargetsExist(
        args,
        [{ fieldName: 'trace', def: traceRef }],
        { trace: null },
        'main'
      )
    ).resolves.toBeUndefined();
    await expect(
      assertCrossRefTargetsExist(args, [{ fieldName: 'trace', def: traceRef }], {}, 'main')
    ).resolves.toBeUndefined();
  });

  it('reads a cross-namespace target via resolveDataset', async () => {
    const other = new MemoryDataset({ namespace: 'other' });
    await other.write('Thing', [{ id: 'x1' }]);
    const args: ResolverArgs = {
      dataset: ds,
      resolveDataset: (ns) => (ns === 'other' ? other : undefined)
    };
    await expect(
      assertCrossRefTargetsExist(
        args,
        [{ fieldName: 'thing', def: crossNsRef }],
        { thing: 'x1' },
        'main'
      )
    ).resolves.toBeUndefined();
    await expect(
      assertCrossRefTargetsExist(
        args,
        [{ fieldName: 'thing', def: crossNsRef }],
        { thing: 'gone' },
        'main'
      )
    ).rejects.toBeInstanceOf(MissingReferentError);
  });

  it('throws when a reject target dataset cannot be resolved at runtime', async () => {
    const args: ResolverArgs = { dataset: ds }; // no resolveDataset for 'other'
    await expect(
      assertCrossRefTargetsExist(
        args,
        [{ fieldName: 'thing', def: crossNsRef }],
        { thing: 'x1' },
        'main'
      )
    ).rejects.toBeInstanceOf(MissingReferentError);
  });

  it('skips a non-scalar value (boolean) instead of treating it as a referent', async () => {
    const args: ResolverArgs = { dataset: ds };
    await expect(
      assertCrossRefTargetsExist(
        args,
        [{ fieldName: 'trace', def: traceRef }],
        { trace: true },
        'main'
      )
    ).resolves.toBeUndefined();
  });

  it('skips a non-scalar value (object) instead of treating it as a referent', async () => {
    const args: ResolverArgs = { dataset: ds };
    await expect(
      assertCrossRefTargetsExist(
        args,
        [{ fieldName: 'trace', def: traceRef }],
        { trace: { id: 't1' } },
        'main'
      )
    ).resolves.toBeUndefined();
  });

  it('collectCrossRefFields returns only crossRef entries', () => {
    const infos = collectCrossRefFields({
      trace: traceRef,
      title: field.string(),
      thing: crossNsRef
    });
    expect(infos.map((i) => i.fieldName).sort()).toEqual(['thing', 'trace']);
  });
});

describe('enforcement is ON by default', () => {
  // Absence of `onMissing` means "enforce where enforceable", not "allow".
  // The three states, and why there are three:
  //
  //   undefined  enforce when the target namespace is locally resolvable;
  //              skip when it is not, because a cross-substrate reference
  //              cannot have a real FK (that is what EdgesStore exists for)
  //   'reject'   enforce, and compose REFUSES TO BOOT if the target namespace
  //              is not resolvable — an explicit demand for something
  //              impossible should fail loudly at registration
  //   'allow'    never enforce; the deliberate opt-out
  let ds: MemoryDataset;
  beforeEach(async () => {
    ds = new MemoryDataset({ namespace: 'main' });
    await ds.write('Trace', [{ id: 't1' }]);
  });

  it('rejects a dangling target on a field that declares NOTHING', async () => {
    // A well-formed id naming no row, on a field with no onMissing annotation.
    const args: ResolverArgs = { dataset: ds };
    await expect(
      assertCrossRefTargetsExist(
        args,
        [{ fieldName: 'trace', def: softRef }],
        { trace: 'nope' },
        'main'
      )
    ).rejects.toBeInstanceOf(MissingReferentError);
  });

  it('still resolves when the undeclared target EXISTS — the discriminating case', async () => {
    // Without this, the assertion above passes against a check that rejects
    // unconditionally, which would refuse every write.
    const args: ResolverArgs = { dataset: ds };
    await expect(
      assertCrossRefTargetsExist(
        args,
        [{ fieldName: 'trace', def: softRef }],
        { trace: 't1' },
        'main'
      )
    ).resolves.toBeUndefined();
  });

  it("'allow' remains a real opt-out", async () => {
    const optedOut = field.crossRef('main', 'Trace', { onMissing: 'allow' });
    const args: ResolverArgs = { dataset: ds };
    await expect(
      assertCrossRefTargetsExist(
        args,
        [{ fieldName: 'trace', def: optedOut }],
        { trace: 'nope' },
        'main'
      )
    ).resolves.toBeUndefined();
  });

  it('DEGRADES to permissive when the target namespace is not hosted here', async () => {
    // The boot-safety property. compose refuses to start when an EXPLICIT
    // reject names an unresolvable namespace; the default must not inherit
    // that, or flipping it would stop deployments booting.
    const undeclaredCrossNs = field.crossRef('elsewhere', 'Thing');
    const args: ResolverArgs = { dataset: ds }; // no resolveDataset => 'elsewhere' unresolvable
    await expect(
      assertCrossRefTargetsExist(
        args,
        [{ fieldName: 'thing', def: undeclaredCrossNs }],
        { thing: 'x' },
        'main'
      )
    ).resolves.toBeUndefined();
  });

  it('an EXPLICIT reject against an unresolvable namespace still throws', async () => {
    // The explicit demand keeps its teeth — compose should have caught this at
    // registration, and reaching a write means it did not.
    const args: ResolverArgs = { dataset: ds };
    await expect(
      assertCrossRefTargetsExist(
        args,
        [{ fieldName: 'thing', def: crossNsRef }],
        { thing: 'x' },
        'main'
      )
    ).rejects.toBeInstanceOf(MissingReferentError);
  });
});

describe('a crossRef into another namespace needs read there', () => {
  const thing = [{ fieldName: 'thing', def: crossNsRef }];
  const writer = (grants: Record<string, string[]>): Identity => ({ id: 'w', grants });
  const MAIN_ONLY = writer({ main: ['read', 'mutate'] });
  let ds: MemoryDataset;
  let other: MemoryDataset;
  beforeEach(async () => {
    ds = new MemoryDataset({ namespace: 'main' });
    await ds.write('Trace', [{ id: 't1' }]);
    other = new MemoryDataset({ namespace: 'other' });
    await other.write('Thing', [{ id: 'x1' }]);
  });
  const argsWith = (resolveDataset: (ns: string) => MemoryDataset | undefined): ResolverArgs => ({
    dataset: ds,
    resolveDataset
  });

  /** The refusal `values` meets, and how often the target namespace was resolved: its only way in. */
  async function attempt(identity: Identity, values: Record<string, unknown>) {
    const resolveDataset = vi.fn((ns: string) => (ns === 'other' ? other : undefined));
    const err = await assertCrossRefTargetsExist(
      argsWith(resolveDataset),
      thing,
      values,
      'main',
      identity
    ).then(
      () => undefined,
      (e: unknown) => e
    );
    return { err, looks: resolveDataset.mock.calls.length };
  }

  it('refuses a writer without read there identically for an existing and a missing id, reading nothing', async () => {
    const existing = await attempt(MAIN_ONLY, { thing: 'x1' });
    const missing = await attempt(MAIN_ONLY, { thing: 'nope' });
    const shortForm = await attempt(MAIN_ONLY, { thing: '#1' });
    for (const outcome of [existing, missing, shortForm]) {
      expect(outcome.err).toMatchObject({
        code: 'unauthorized_namespace',
        message: "crossRef 'thing': namespace 'other' not in identity's allowed namespaces",
        details: { field: 'thing' }
      });
      expect(outcome.err).not.toBeInstanceOf(MissingReferentError);
      expect(outcome.looks).toBe(0);
    }
  });

  it("answers the read gate's code for a namespace granted without read", async () => {
    for (const grants of [
      { main: ['mutate'], other: ['mutate'] },
      { '*': ['read'], other: [] }
    ]) {
      const { err, looks } = await attempt(writer(grants), { thing: 'x1' });
      expect(err).toMatchObject({
        code: 'unauthorized_capability',
        message: "crossRef 'thing': identity's grant for namespace 'other' does not include 'read'"
      });
      expect(looks).toBe(0);
    }
  });

  it('checks existence for a reader there', async () => {
    for (const grants of [{ main: ['mutate'], other: ['read'] }, { '*': ['read', 'mutate'] }]) {
      expect((await attempt(writer(grants), { thing: 'x1' })).err).toBeUndefined();
      expect((await attempt(writer(grants), { thing: 'nope' })).err).toBeInstanceOf(
        MissingReferentError
      );
    }
  });

  it('refuses a namespace this deployment does not host the same way', async () => {
    const undeclared = [{ fieldName: 'thing', def: field.crossRef('elsewhere', 'Thing') }];
    await expect(
      assertCrossRefTargetsExist(
        argsWith(() => undefined),
        undeclared,
        { thing: 'x' },
        'main',
        MAIN_ONLY
      )
    ).rejects.toMatchObject({ code: 'unauthorized_namespace' });
  });

  it('lets a writer without read there clear the reference', async () => {
    expect((await attempt(MAIN_ONLY, { thing: null })).err).toBeUndefined();
  });

  it('needs read in the namespace being written too, reading nothing', async () => {
    const mutateOnly = writer({ main: ['mutate'] });
    const refs = [{ fieldName: 'trace', def: traceRef }];
    const attemptSame = async (trace: string) => {
      const resolveDataset = vi.fn(() => undefined);
      const read = vi.spyOn(ds, 'read');
      const resolveShortIds = vi.spyOn(ds, 'resolveShortIds');
      const err = await assertCrossRefTargetsExist(
        { dataset: ds, resolveDataset },
        refs,
        { trace },
        'main',
        mutateOnly
      ).then(
        () => undefined,
        (e: unknown) => e
      );
      const looks =
        resolveDataset.mock.calls.length +
        read.mock.calls.length +
        resolveShortIds.mock.calls.length;
      vi.restoreAllMocks();
      return { err, looks };
    };
    const existing = await attemptSame('t1');
    const missing = await attemptSame('nope');
    expect(existing.err).toMatchObject({
      code: 'unauthorized_capability',
      message: "crossRef 'trace': identity's grant for namespace 'main' does not include 'read'"
    });
    expect(missing.err).toEqual(existing.err);
    expect(String(missing.err)).toBe(String(existing.err));
    expect([existing.looks, missing.looks]).toEqual([0, 0]);

    const reader = writer({ main: ['read', 'mutate'] });
    await expect(
      assertCrossRefTargetsExist({ dataset: ds }, refs, { trace: 't1' }, 'main', reader)
    ).resolves.toBeUndefined();
    await expect(
      assertCrossRefTargetsExist({ dataset: ds }, refs, { trace: 'nope' }, 'main', reader)
    ).rejects.toBeInstanceOf(MissingReferentError);
  });

  it('reports the refusal sequential dispatch meets first, across elements and fields', async () => {
    const both = [
      { fieldName: 'trace', def: traceRef },
      { fieldName: 'thing', def: crossNsRef }
    ];
    const args = argsWith((ns) => (ns === 'other' ? other : undefined));
    const refusalOf = (values: Array<Record<string, unknown>>) =>
      assertCrossRefTargetsExistMany(args, both, values, 'main', MAIN_ONLY).then(
        () => undefined,
        (e: unknown) => e
      );

    const unreadableFirst = await refusalOf([{ thing: 'x1' }, { trace: 'nope' }]);
    expect(isBatchElementError(unreadableFirst) && unreadableFirst.index).toBe(0);
    expect(unreadableFirst).toMatchObject({ cause: { code: 'unauthorized_namespace' } });

    const missingFirst = await refusalOf([{ trace: 'nope' }, { thing: 'x1' }]);
    expect(isBatchElementError(missingFirst) && missingFirst.index).toBe(0);
    expect(missingFirst).toMatchObject({ cause: { code: 'missing_referent' } });

    const sameElement = await refusalOf([{ trace: 't1' }, { trace: 'nope', thing: 'x1' }]);
    expect(isBatchElementError(sameElement) && sameElement.index).toBe(1);
    expect(sameElement).toMatchObject({ cause: { code: 'missing_referent' } });
  });
});
