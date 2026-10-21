/**
 * Worker entry for a clustering pass. One message in, one message out.
 *
 * Nothing here runs at import time except the wasm module's own lazy load
 * (`WasmClusterer` loads on first `cluster()` call, never at import), so the
 * module is safe to load inside a Worker.
 */

import { parentPort } from 'node:worker_threads';
import { WasmClusterer } from '@mnmal-ai/holomap-clusterer';
import type { ClusterWorkerRequest } from './run-clusterer.js';

const port = parentPort;
if (port === null) {
  throw new Error('cluster-worker: no parentPort — this module must be loaded as a Worker');
}

port.on('message', (req: ClusterWorkerRequest) => {
  void (async (): Promise<void> => {
    try {
      const vectors: Float32Array[] = [];
      for (let i = 0; i < req.rows; i++) {
        vectors.push(req.flat.subarray(i * req.dims, (i + 1) * req.dims));
      }
      const result = await new WasmClusterer().cluster(vectors, req.params);
      port.postMessage({ ok: true, assignments: Int32Array.from(result.assignments) });
    } catch (err) {
      port.postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  })();
});
