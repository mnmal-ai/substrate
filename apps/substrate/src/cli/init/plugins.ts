export interface KnownPlugin {
  readonly name: string;
  readonly npmName: string;
  readonly description: string;
  /**
   * Version range for a plugin published on its own version line. Absent means
   * the substrate line, ranged at the binary's own major.
   */
  readonly range?: string;
}

/**
 * The cortext line publishes on its own versions and declares substrate as a
 * peer range. Raise the floor when a cortext release drops support for the
 * substrate major this binary is on. The floor names a prerelease because a
 * caret range admits no prerelease of a version it does not itself name.
 */
const CORTEXT_RANGE = '^1.0.0-alpha.0';

export type Persona = 'agent-context' | 'minimal' | 'full';

export const KNOWN_PLUGINS: readonly KnownPlugin[] = [
  {
    name: 'cortext',
    npmName: '@mnmal-ai/cortext',
    range: CORTEXT_RANGE,
    description:
      'Agent coordination context store (Todos, Decisions, SessionLogs, AgentRules, Memory).'
  },
  {
    name: 'substrate-nl',
    npmName: '@mnmal-ai/substrate-nl',
    description: 'Natural-language questions answered as frames.'
  },
  {
    name: 'substrate-sentinel',
    npmName: '@mnmal-ai/substrate-sentinel',
    description: 'Coordinator registry for dynamic bridge discovery.'
  }
] as const;

export function defaultPluginsForPersona(persona: Persona): readonly string[] {
  switch (persona) {
    case 'agent-context':
      return ['cortext'];
    case 'minimal':
      return [];
    case 'full':
      return KNOWN_PLUGINS.map((p) => p.name);
  }
}

export function pluginNpmName(name: string): string {
  const known = KNOWN_PLUGINS.find((p) => p.name === name);
  if (known !== undefined) return known.npmName;
  return name.startsWith('@') ? name : `@mnmal-ai/${name}`;
}

export function pluginRange(name: string, substrateRange: string): string {
  return KNOWN_PLUGINS.find((p) => p.name === name)?.range ?? substrateRange;
}
