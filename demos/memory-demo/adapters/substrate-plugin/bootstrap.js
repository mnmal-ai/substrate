// Substrate coordinator plugin: the `lumen` namespace for the memory demo.
//
// This is Substrate's documented way to define types: `defineNamespace` + the
// field DSL in a coordinator plugin (docs/plugin-author-guide.md). Every type
// gets autoCRUD for free (createPerson, updatePerson, deletePerson, getPerson,
// and the `lumen/Person` list query).
//
// Types live in code, not in runtime proposals, because recall only embeds and
// keyword-indexes a type that declares `embed.source` / `lexical.source`, and
// those are functions, which a proposal (JSON) cannot carry.
//
// Fields keep the memory's own values, so `owner` reads "person-ana-reyes".
// Each reference also gets a crossRef sibling (`ownerRef`, `projectRef`,
// `supersedesRef`, `supersededByRef`) holding the target row's id: those are
// Substrate's first-class edges, with an onDelete policy. `links` mixes target
// types (people, projects, decisions) in one list; an edge points at one type,
// so `links` stays a list of memory keys.
//
// Plain ESM so it loads without a build step. Loaded through SUBSTRATE_PLUGIN_DIR
// (see scripts/substrate-up.sh).

import { defineNamespace, field } from '@mnmal-ai/substrate/sdk';

const NS = 'lumen';

const str = () => field.string({ nullable: true });
const ref = (type) => field.crossRef(NS, type, { nullable: true, onDelete: 'set_null' });

// Kind-specific fields, from data/sample.json and data/memories.json. Everything
// is nullable: a memory may leave a fact unknown. Adding a field is one line
// here and a restart (rows are JSONB, so there is no migration).
const KIND_FIELDS = {
  Person: { role: str(), team: str(), location: str() },
  Project: { status: str(), owner: str(), team: str(), deadline: str() },
  Decision: {
    status: str(),
    topic: str(),
    choice: str(),
    owner: str(),
    project: str(),
    supersedes: str(),
    supersededBy: str()
  },
  Task: { status: str(), owner: str(), project: str(), priority: str(), due: str() },
  Incident: {
    severity: str(),
    project: str(),
    owner: str(),
    resolved: field.boolean({ nullable: true }),
    rootCause: str()
  }
};

// Edges: `<field>Ref` points at the row the `<field>` key names.
const EDGES = {
  Person: {},
  Project: { ownerRef: 'Person' },
  Decision: {
    ownerRef: 'Person',
    projectRef: 'Project',
    supersedesRef: 'Decision',
    supersededByRef: 'Decision'
  },
  Task: { ownerRef: 'Person', projectRef: 'Project' },
  Incident: { ownerRef: 'Person', projectRef: 'Project' }
};

/**
 * The text a row is embedded and keyword-indexed by: title, body, date and
 * every fact. For a reference, the embedding also gets the linked row's title,
 * read through the embed-source context (the documented way to enrich an
 * embedding from a crossRef), so "Ana Reyes" matches rows she owns.
 */
async function rowText(type, row, ctx) {
  const facts = [`date: ${row.date ?? ''}`];
  for (const name of Object.keys(KIND_FIELDS[type])) {
    const value = row[name];
    if (value === null || value === undefined) continue;
    let fact = `${name}: ${value}`;
    const target = EDGES[type][`${name}Ref`];
    const refId = row[`${name}Ref`];
    if (target !== undefined && typeof refId === 'string' && ctx !== undefined) {
      const linked = await ctx.read(NS, target, { id: refId });
      if (linked !== null && typeof linked.title === 'string') fact += ` (${linked.title})`;
    }
    facts.push(fact);
  }
  const links =
    Array.isArray(row.links) && row.links.length > 0 ? `related: ${row.links.join(', ')}` : '';
  return [`${type}: ${row.title ?? ''}`, row.body ?? '', facts.join('\n'), links]
    .filter((part) => part !== '')
    .join('\n\n');
}

function memoryType(type) {
  return {
    fields: {
      key: field.string(),
      title: field.string(),
      body: field.string({ indexed: false }),
      date: field.string(),
      links: field.list(field.string()),
      ...KIND_FIELDS[type],
      ...Object.fromEntries(
        Object.entries(EDGES[type]).map(([name, target]) => [name, ref(target)])
      )
    },
    embed: { source: (row, ctx) => rowText(type, row, ctx) },
    lexical: { source: (row) => rowText(type, row, undefined) }
  };
}

export default function bootstrap() {
  return {
    name: 'lumen',
    contractVersion: '>=1.0.0-alpha.0 <2.0.0',
    namespaces: [
      defineNamespace(
        NS,
        Object.fromEntries(Object.keys(KIND_FIELDS).map((t) => [t, memoryType(t)]))
      )
    ]
  };
}
