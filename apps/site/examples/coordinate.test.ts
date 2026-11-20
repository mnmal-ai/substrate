import { describe, expect, it } from 'vitest';
import { normalise, runExample } from './_harness.ts';
import { app } from './coordinate/namespace.ts';
import { steps } from './coordinate/steps.ts';

type Kid = { _metadata: { createdBy?: { id: string }; updatedBy?: { id: string } } };
type Task = { id: string; title: string; status: string };

describe('coordinate example', () => {
  it('runs, and one agent receives the work another signed, live', async () => {
    const agents = ['billing-agent', 'collections-agent'];
    const n = normalise(await runExample({ name: 'coordinate', namespaces: [app], agents }, steps));
    await expect(`${JSON.stringify(n, null, 2)}\n`).toMatchFileSnapshot('./coordinate/output.json');
    for (const s of n.steps) {
      expect(s.status, s.label).toBe(200);
      expect(s.response, s.label).not.toHaveProperty('errors');
    }

    const snapshot = n.steps[0]?.response as { kind: string; data: { 'app/Task': Task[] } };
    const [created, received, read, updated] = n.steps.slice(-4).map((s) => s.response) as [
      { data: { 'app/createTask': Task } },
      { kind: string; data: { 'app/Task': Task } },
      { data: { 'app/Task': (Task & Kid)[] } },
      { data: { 'app/updateTask': Task & Kid } }
    ];
    expect(snapshot.kind).toBe('snapshot');
    expect(snapshot.data['app/Task']).toEqual([]);

    const task = created.data['app/createTask'];
    expect(task.status).toBe('open');
    expect(received.kind).toBe('add');
    expect(received.data['app/Task']).toMatchObject({ id: task.id, title: task.title });

    expect(read.data['app/Task']).toHaveLength(1);
    expect(read.data['app/Task'][0]?._metadata.createdBy?.id).toBe('billing-agent');

    const claimed = updated.data['app/updateTask'];
    expect(claimed).toMatchObject({ id: task.id, status: 'in_progress' });
    expect(claimed._metadata.updatedBy?.id).toBe('collections-agent');
  });
});
