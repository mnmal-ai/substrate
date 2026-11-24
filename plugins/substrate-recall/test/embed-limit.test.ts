import { expect, it } from 'vitest';
import { withEmbedLimit } from '../src/plugin.js';

it('runs a bounded number of embeds, queues a bounded number, and refuses the rest', async () => {
  const release: Array<() => void> = [];
  let peak = 0;
  let active = 0;
  const embedder = withEmbedLimit(
    {
      modelId: 'm',
      dimension: 1,
      embed: async () => {
        peak = Math.max(peak, ++active);
        await new Promise<void>((r) => release.push(r));
        active--;
        return new Float32Array([0]);
      }
    },
    2,
    1
  );
  const accepted = [embedder.embed('a'), embedder.embed('b'), embedder.embed('c')];
  await expect(embedder.embed('d')).rejects.toThrow('embedder busy');
  expect(release).toHaveLength(2);

  // Each finished embed hands its slot to the one waiting.
  release[0]?.();
  await accepted[0];
  expect(release).toHaveLength(3);
  for (const r of release) r();
  await Promise.all(accepted);
  expect(peak).toBe(2);

  // Idle again: the full allowance is back.
  const again = [embedder.embed('e'), embedder.embed('f')];
  expect(release).toHaveLength(5);
  for (const r of release) r();
  await Promise.all(again);
});

it('frees the slot when an embed fails', async () => {
  let fail = true;
  const embedder = withEmbedLimit(
    {
      modelId: 'm',
      dimension: 1,
      embed: async () => {
        if (fail) throw new Error('down');
        return new Float32Array([0]);
      }
    },
    1,
    0
  );
  await expect(embedder.embed('a')).rejects.toThrow('down');
  fail = false;
  expect(await embedder.embed('b')).toEqual(new Float32Array([0]));
});

it('gives up a wait at the call timeout and leaves the queue', async () => {
  const release: Array<() => void> = [];
  const embedder = withEmbedLimit(
    {
      modelId: 'm',
      dimension: 1,
      embed: async () => {
        await new Promise<void>((r) => release.push(r));
        return new Float32Array([0]);
      }
    },
    1,
    1
  );
  const first = embedder.embed('a');
  await expect(embedder.embed('b', { timeoutMs: 10 })).rejects.toThrow('no slot within 10ms');
  // The abandoned wait freed its place in the queue and takes no slot later.
  const third = embedder.embed('c');
  release[0]?.();
  await first;
  expect(release).toHaveLength(2);
  release[1]?.();
  expect(await third).toEqual(new Float32Array([0]));
});
