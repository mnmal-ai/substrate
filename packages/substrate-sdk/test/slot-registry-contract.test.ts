/**
 * Which SLOTS exist on both declarations — the half the type system cannot check.
 *
 * `TypeInput` (substrate-sdk) and `NamespaceTypeDef` (substrate-types) declare the same
 * per-type metadata slots twice, structurally, to avoid an import cycle.
 * `embed-source-contract.test.ts` pins that each NAMED slot has the same
 * `source` signature on both sides — but it can only check slots someone
 * remembered to list.
 *
 * The missing-slot case cannot be expressed as a type. `NamespaceTypeDef`
 * carries `[key: string]: unknown` to absorb slots it does not name, so
 * `keyof NamespaceTypeDef` is `string | number` and any keys-based diff agrees
 * with everything. That index signature is deliberate and useful; it just
 * makes this particular question unaskable at the type level.
 *
 * So this test reads the source.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Body of one `export interface <name>` block, to its closing brace at column
 * zero. Scoping matters: both files declare several interfaces, and an
 * unscoped search would collect slots from neighbours.
 */
function interfaceBody(source: string, name: string): string {
  const start = source.indexOf(`export interface ${name} {`);
  if (start === -1) throw new Error(`interface ${name} not found`);
  const end = source.indexOf('\n}', start);
  if (end === -1) throw new Error(`unterminated interface ${name}`);
  return source.slice(start, end);
}

/**
 * Top-level optional slots whose object type declares a `source` member.
 *
 * Comments are stripped before the `source:` test, and the window runs to the
 * NEXT top-level slot rather than a fixed length: a slot's docblock can be
 * long enough to push `source` past any fixed window.
 */
function sourceSlots(body: string): string[] {
  const out: string[] = [];
  const re = /^ {2}(\w+)\?: \{/gm;
  const starts = [...body.matchAll(re)];
  for (const [i, m] of starts.entries()) {
    const from = (m.index ?? 0) + m[0].length;
    const to = starts[i + 1]?.index ?? body.length;
    const window = body.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, '');
    if (/^\s*source[?]?:/m.test(window)) out.push(m[1] as string);
  }
  return out.sort();
}

const sdkSlots = sourceSlots(
  interfaceBody(readFileSync(join(here, '../src/namespace.ts'), 'utf8'), 'TypeInput')
);
const typesSlots = sourceSlots(
  interfaceBody(
    readFileSync(join(here, '../../substrate-types/src/plugin.ts'), 'utf8'),
    'NamespaceTypeDef'
  )
);

describe('slot registry contract (TypeInput vs NamespaceTypeDef)', () => {
  /**
   * The load-bearing assertion. A slot added to either declaration and not the
   * other fails HERE, naming it — rather than in a downstream repo's build.
   */
  it('declares the same source-bearing slots on both sides', () => {
    expect(sdkSlots).toEqual(typesSlots);
  });

  /**
   * Guards the guard. If the extraction silently matched nothing, the equality
   * above would pass on two empty arrays.
   */
  it('actually found the slots it is comparing', () => {
    expect(sdkSlots).toContain('embed');
    expect(sdkSlots).toContain('lexical');
    expect(sdkSlots.length).toBeGreaterThanOrEqual(2);
  });
});
