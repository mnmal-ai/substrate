// Local demo server: one page, live side-by-side questions, ingestion and the scoreboard.
//   node web/server.ts   ->  http://localhost:4600

import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { ask } from '../agent/ask.ts';
import { applyChange, changeState, undoChange, withChange } from '../eval/change.ts';
import { ingestBoth, SYSTEMS, saveIngest } from '../eval/ingest.ts';
import type { MemoryAdapter, Question } from '../src/types.ts';

const PORT = Number(process.env.PORT ?? 4600);
const root = new URL('../', import.meta.url).pathname;
const readJson = (p: string) =>
  existsSync(root + p) ? JSON.parse(readFileSync(root + p, 'utf8')) : null;
const adapters: Record<string, MemoryAdapter> = {};
const adapter = async (name: string) =>
  (adapters[name] ??= (await import(`../adapters/${name}.ts`)).default);
const DATASETS: Record<string, string> = {
  sample: 'data/sample.json',
  full: 'data/memories.json',
  x5: 'data/memories-x5.json'
};
let busyIngest = false;
let busyChange = false;
// The answer key that matches the memory set both systems hold right now.
const QUESTION_FILES: Record<string, string | null> = {
  full: 'data/questions.json',
  x5: 'data/questions-x5.json',
  sample: null
};
const loaded = () =>
  readJson('.state/loaded.json') ?? {
    set: 'full',
    count: readJson('data/memories.json')?.length ?? 0
  };
// While the live change is made, the Atlas question is graded against its new answer.
const currentQuestions = (): Question[] => {
  const f = QUESTION_FILES[loaded().set];
  return f ? withChange(readJson(f) ?? []) : [];
};
// Recorded runs the scoreboard can switch between, in the order the talk uses them.
const RUNS: Record<string, string> = {
  defaults: 'results/defaults-3x.json',
  three: 'results/three-3x.json'
};

const sse = (res: import('node:http').ServerResponse) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  return (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(`${root}web/index.html`));
    }
    // The sequence diagram: its page, and its source and image under docs/.
    if (url.pathname === '/how') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(`${root}web/how.html`));
    }
    if (/^\/docs\/[a-z-]+\.(mmd|png)$/.test(url.pathname)) {
      const f = root + url.pathname.slice(1);
      if (!existsSync(f)) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, {
        'content-type': f.endsWith('.png') ? 'image/png' : 'text/plain; charset=utf-8'
      });
      return res.end(readFileSync(f));
    }
    // Axon's built CSS, vendored from mnmal-ai/axon (tokens with embedded fonts, and the component layer).
    if (url.pathname.startsWith('/axon/') && /^\/axon\/[a-z-]+\.css$/.test(url.pathname)) {
      const f = `${root}web${url.pathname}`;
      if (!existsSync(f)) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, {
        'content-type': 'text/css; charset=utf-8',
        'cache-control': 'max-age=3600'
      });
      return res.end(readFileSync(f));
    }
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          questions: currentQuestions(),
          loaded: loaded(),
          results: readJson('results/latest.json'),
          runs: Object.fromEntries(
            Object.entries(RUNS)
              .map(([k, f]) => [k, readJson(f)])
              .filter(([, v]) => v)
          ),
          shared: readJson('results/shared.json'),
          change: changeState(),
          ingest: {
            sample: readJson('results/ingest-sample.json'),
            full: readJson('results/ingest.json'),
            x5: readJson('results/ingest-x5.json')
          },
          setup: {
            substrate: existsSync(`${root}adapters/SUBSTRATE.md`)
              ? readFileSync(`${root}adapters/SUBSTRATE.md`, 'utf8')
              : '',
            obsidian: existsSync(`${root}adapters/OBSIDIAN.md`)
              ? readFileSync(`${root}adapters/OBSIDIAN.md`, 'utf8')
              : '',
            hindsight: existsSync(`${root}adapters/HINDSIGHT.md`)
              ? readFileSync(`${root}adapters/HINDSIGHT.md`, 'utf8')
              : ''
          },
          datasets: Object.fromEntries(
            Object.entries(DATASETS).map(([k, p]) => [k, readJson(p)?.length ?? 0])
          )
        })
      );
    }
    if (url.pathname === '/api/ask') {
      const system = url.searchParams.get('system') ?? '';
      if (!SYSTEMS.includes(system)) {
        res.writeHead(400);
        return res.end('unknown system');
      }
      const id = url.searchParams.get('id');
      const q: string | Question = id
        ? currentQuestions().find((x) => x.id === id)!
        : (url.searchParams.get('q') ?? '');
      const send = sse(res);
      await ask(await adapter(system), q, send);
      return res.end();
    }
    if (url.pathname === '/api/ingest') {
      const set = url.searchParams.get('set') ?? 'sample';
      const send = sse(res);
      if (busyIngest) {
        send({ type: 'log', text: 'An ingest is already running.' });
        return res.end();
      }
      if (busyChange || changeState().applied) {
        send({ type: 'log', text: 'Put the live change back first (Shared page).' });
        return res.end();
      }
      busyIngest = true;
      try {
        const mems = readJson(DATASETS[set] ?? DATASETS.sample!);
        const reports = await ingestBoth(mems, SYSTEMS, (text) => send({ type: 'log', text }));
        saveIngest(root + (DATASETS[set] ?? DATASETS.sample!), mems.length, reports);
        send({ type: 'done', reports });
      } catch (e) {
        send({ type: 'log', text: `Ingest failed: ${e}` });
      } finally {
        busyIngest = false;
        res.end();
      }
      return;
    }
    // The live change: the Atlas decision, made or put back in both systems.
    if (url.pathname === '/api/change') {
      const action = url.searchParams.get('action');
      const send = sse(res);
      if (busyChange || busyIngest) {
        send({ type: 'log', text: 'Another change or ingest is running.' });
        send({ type: 'done', change: changeState() });
        return res.end();
      }
      busyChange = true;
      try {
        const log = (text: string) => send({ type: 'log', text });
        if (action === 'apply')
          await applyChange(log, (system, ms) => send({ type: 'timing', system, ms }));
        else if (action === 'undo') await undoChange(log);
        else log('Unknown action.');
      } catch (e) {
        send({ type: 'log', text: `Failed: ${e instanceof Error ? e.message : e}` });
      } finally {
        busyChange = false;
        send({ type: 'done', change: changeState() });
        res.end();
      }
      return;
    }
    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end('internal error; see the server log');
  }
}).listen(PORT, () => console.log(`memory demo on http://localhost:${PORT}`));
