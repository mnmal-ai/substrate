import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVERY_SURFACE } from '../examples/onboard/steps.ts';

const root = new URL('../../../', import.meta.url).pathname;
const onboard = join(root, 'apps/site/examples/onboard');
const readme = readFileSync(join(root, 'README.md'), 'utf8');

// The README's example section, from its `## Example` heading to the next h2.
const example = readme.split(/^## /m).find((s) => s.startsWith('Example')) ?? '';
const block = (lang: string) =>
  example.match(new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``))?.[1] ?? '';

describe('README', () => {
  it('README example matches the tested example', () => {
    expect(block('ts').trim()).toBe(readFileSync(join(onboard, 'namespace.ts'), 'utf8').trim());
  });

  it('shows a frame the onboard run sent', () => {
    const output = JSON.parse(readFileSync(join(onboard, 'output.json'), 'utf8')) as {
      steps: { label: string; body?: unknown }[];
    };
    const sent = output.steps.find((s) => s.label === EVERY_SURFACE)?.body;
    expect(sent).toBeDefined();
    expect(JSON.parse(block('json'))).toEqual(sent);
  });

  it('links only to files that exist', () => {
    const links = [...readme.matchAll(/\]\(([^)]+)\)/g)]
      .map((m) => (m[1] ?? '').split('#')[0] ?? '')
      .filter((href) => href !== '' && !/^[a-z]+:/.test(href));
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) expect(existsSync(join(root, href)), href).toBe(true);
  });
});
