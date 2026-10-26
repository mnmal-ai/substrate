import { describe, expect, it } from 'vitest';
import { createRecallPlugin } from '../src/plugin.js';

describe('recall store tables', () => {
  it('recall declares the tables it stores data in', () => {
    expect(createRecallPlugin({} as never).storeTables).toEqual([
      'embeddings',
      'lexical',
      'recall_clusters',
      'recall_cluster_members'
    ]);
  });
});
