import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MissingReferentError, type ResolverArgs } from '@mnmal-ai/substrate-types';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertCrossRefTargetsExist,
  collectCrossRefFields
} from '../../src/autocrud/crossref-existence.js';
import { field } from '../../src/field.js';

const traceRef = field.crossRef('main', 'Trace', { onMissing: 'reject' });
const softRef = field.crossRef('main', 'Trace'); // onMissing absent => enforce where enforceable
const crossNsRef = field.crossRef('other', 'Thing', { onMissing: 'reject' });

describe('assertCrossRefTargetsExist', () => {
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
