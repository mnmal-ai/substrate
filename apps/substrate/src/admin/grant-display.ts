/**
 * Rendering a stored grant as the AUTHORITY it confers, rather than as the two
 * columns it happens to be stored in.
 *
 * The two columns only mean anything jointly: `capabilities` is the default
 * for BARE `--ns` entries only, so `--ns 'notes:read'` with default
 * capabilities `read,mutate` is a read-only grant, not a write grant.
 */

import { describeGrant } from '@mnmal-ai/substrate-policy';

export { describeGrant } from '@mnmal-ai/substrate-policy';

/**
 * `describeGrant` laid out under a label, continuation lines aligned.
 *
 * The label is passed in rather than fixed so `register` and `update` can align
 * the grant block with their own existing columns.
 */
export function grantLines(label: string, namespaces: string, capabilities: string): string[] {
  const entries = describeGrant(namespaces, capabilities);
  const pad = ' '.repeat(label.length);
  return entries.map((e, i) => `${i === 0 ? label : pad}${e}`);
}
