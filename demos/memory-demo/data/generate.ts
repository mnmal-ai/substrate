// Generates the Lumen Labs memory set and a question set whose answers are
// derived from the same data, so every gold answer is right by construction.
// Deterministic: the same seed always produces the same files.
//
//   node data/generate.ts            -> data/memories.json, data/questions.json
//   node data/generate.ts --scale 5  -> data/memories-x5.json (larger set for the growth chart)

import { writeFileSync } from "node:fs";
import type { Memory, Question } from "../src/types.ts";

const args = process.argv.slice(2);
const scale = Number(args[args.indexOf("--scale") + 1] ?? 1) || 1;
const outDir = new URL(".", import.meta.url).pathname;

// mulberry32: small, fast, deterministic.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261020);
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const day = (base: string, add: number) => {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + add);
  return d.toISOString().slice(0, 10);
};

const TEAMS = ["Platform", "Data", "Mobile", "Payments", "Security"] as const;
const PEOPLE: [string, (typeof TEAMS)[number], string, string][] = [
  ["Ana Reyes", "Platform", "Engineering Manager", "Lisbon"],
  ["Ben Okafor", "Data", "Staff Engineer", "Toronto"],
  ["Chloe Martin", "Mobile", "Senior Engineer", "Lyon"],
  ["Dev Patel", "Payments", "Engineering Manager", "Pune"],
  ["Elif Kaya", "Security", "Security Engineer", "Istanbul"],
  ["Farah Haddad", "Data", "Data Engineer", "Amman"],
  ["Gus Lindqvist", "Platform", "Site Reliability Engineer", "Stockholm"],
  ["Hana Sato", "Mobile", "Engineering Manager", "Osaka"],
  ["Ivan Petrov", "Payments", "Senior Engineer", "Sofia"],
  ["Jade Wong", "Security", "Engineering Manager", "Singapore"],
  ["Kofi Mensah", "Platform", "Senior Engineer", "Accra"],
  ["Lena Novak", "Data", "Engineering Manager", "Ljubljana"],
  ["Marco Rossi", "Payments", "Staff Engineer", "Turin"],
  ["Nia Brooks", "Mobile", "Senior Engineer", "Atlanta"],
  ["Omar Saleh", "Security", "Senior Engineer", "Doha"],
  ["Priya Iyer", "Data", "Senior Engineer", "Chennai"],
  ["Quinn Harper", "Platform", "Staff Engineer", "Denver"],
  ["Sam Rivera", "Mobile", "Engineer", "Austin"],
  ["Tara Quinn", "Payments", "Engineer", "Dublin"],
  ["Uma Desai", "Security", "Engineer", "Ahmedabad"],
  ["Victor Hale", "Platform", "Engineer", "Leeds"],
  ["Wen Li", "Data", "Engineer", "Chengdu"],
  ["Yara Costa", "Mobile", "Engineer", "Porto"],
  ["Zane Ortiz", "Payments", "Senior Engineer", "Bogotá"],
];

// [name, team, status, deadline, what it is]
const PROJECTS: [string, (typeof TEAMS)[number], string, string, string][] = [
  ["Atlas queue migration", "Platform", "active", "2025-09-30", "moves every background job off the legacy RabbitMQ cluster onto a new queue"],
  ["Ledger billing pipeline", "Data", "paused", "2025-11-15", "rebuilds the nightly billing export as a streaming pipeline"],
  ["Beacon mobile push", "Mobile", "active", "2025-08-31", "rebuilds push notifications for the iOS and Android apps"],
  ["Cobalt payment retries", "Payments", "active", "2025-10-15", "retries failed card payments without double-charging"],
  ["Sentinel access reviews", "Security", "paused", "2025-12-01", "automates periodic reviews of who can access production"],
  ["Harbor container platform", "Platform", "active", "2026-01-31", "moves services from virtual machines to containers"],
  ["Prism analytics warehouse", "Data", "active", "2025-10-31", "consolidates analytics into one warehouse with self-serve dashboards"],
  ["Quill offline notes", "Mobile", "done", "2025-06-30", "lets field staff take notes offline and sync later"],
  ["Vault key rotation", "Security", "active", "2025-09-15", "rotates every encryption key on a fixed schedule"],
  ["Relay webhook service", "Payments", "paused", "2026-02-28", "delivers payment events to customers' webhooks"],
];

// Decision chains: each later entry replaces the one before it. [project, topic, choices with reasons]
const CHAINS: [string, string, [string, string][]][] = [
  ["Atlas queue migration", "target queue", [["Amazon SQS", "the team already runs on AWS"], ["NATS JetStream", "SQS could not meet our message-ordering needs in load tests"]]],
  ["Ledger billing pipeline", "storage engine", [["Amazon Redshift", "it was the default warehouse"], ["Google BigQuery", "Redshift costs grew faster than usage"], ["ClickHouse", "BigQuery query costs were unpredictable for nightly backfills"]]],
  ["Beacon mobile push", "push provider", [["OneSignal", "it was fastest to integrate"], ["Firebase Cloud Messaging", "OneSignal pricing changed and we need delivery receipts"]]],
  ["Cobalt payment retries", "retry policy", [["three fixed retries one hour apart", "it matched the old behaviour"], ["exponential backoff with jitter", "fixed retries caused bursts against the card network"]]],
  ["Sentinel access reviews", "review cadence", [["quarterly reviews", "auditors asked for quarterly evidence"], ["monthly reviews", "quarterly reviews missed leavers for too long"]]],
  ["Harbor container platform", "orchestrator", [["HashiCorp Nomad", "it is simpler to operate"], ["Kubernetes on EKS", "every vendor tool we need assumes Kubernetes"]]],
  ["Prism analytics warehouse", "dashboard tool", [["Looker", "the data team knew it already"], ["Metabase", "Looker seat costs blocked self-serve access"]]],
  ["Vault key rotation", "rotation interval", [["every 180 days", "it matched the compliance minimum"], ["every 90 days", "a customer contract required 90 days"], ["every 30 days", "the security review asked for shorter key lifetimes"]]],
  ["Relay webhook service", "delivery guarantee", [["at-most-once delivery", "it kept the first version simple"], ["at-least-once delivery with idempotency keys", "customers lost events during deploys"]]],
];

const STANDALONE = [
  "Adopt OpenTelemetry for tracing", "Require code review from a second team for schema changes", "Use feature flags for every risky rollout",
  "Keep service runbooks in the repository", "Move CI to ephemeral runners", "Pin all base images by digest", "Run a game day every quarter",
  "Write an architecture decision record for every new service", "Store secrets only in the secrets manager", "Track error budgets per service",
];

const TASK_VERBS = ["Write", "Review", "Migrate", "Load test", "Document", "Automate", "Audit", "Benchmark", "Refactor", "Monitor"];
const TASK_OBJECTS = [
  "the cutover runbook", "the alerting rules", "the staging environment", "the dashboards", "the on-call handbook", "the access policy",
  "the retry worker", "the schema migration", "the client SDK", "the backfill job", "the canary release", "the rollback plan",
  "the capacity plan", "the cost report", "the integration tests",
];
const CAUSES = [
  ["a cron job ran in the wrong timezone", "timezone"], ["an expired TLS certificate", "certificate"], ["a full disk on the primary database", "disk"],
  ["a bad feature flag default", "feature flag"], ["a dependency upgrade changed a default timeout", "timeout"], ["a misconfigured load balancer health check", "health check"],
  ["a runaway retry loop", "retry loop"], ["a missing database index", "index"],
];

const memories: Memory[] = [];
const people: Memory[] = [];
for (const [name, team, role, location] of PEOPLE) {
  const m: Memory = {
    id: `person-${slug(name)}`, kind: "person", title: name,
    body: `${name} is a ${role} on the ${team} team at Lumen Labs, based in ${location}.`,
    date: "2025-01-06", fields: { role, team, location }, links: [],
  };
  people.push(m);
}
const teamOf = (personId: string) => people.find((p) => p.id === personId)!.fields.team as string;
const membersOf = (team: string) => people.filter((p) => p.fields.team === team);

const projects: Memory[] = [];
for (let s = 0; s < scale; s++) {
  for (const [baseName, team, status, deadline, what] of PROJECTS) {
    const name = s === 0 ? baseName : `${baseName} ${s + 1}`;
    const owner = membersOf(team).find((p) => /Manager/.test(p.fields.role as string)) ?? membersOf(team)[0]!;
    projects.push({
      id: `project-${slug(name)}`, kind: "project", title: name,
      body: `${name} ${what}. It is owned by ${owner.title} on the ${team} team.`,
      date: "2025-02-03", fields: { status, owner: owner.id, team, deadline }, links: [owner.id],
    });
  }
}
const projectByTitle = (t: string) => projects.find((p) => p.title === t)!;

const decisions: Memory[] = [];
for (let s = 0; s < scale; s++) {
  for (const [baseProject, topic, choices] of CHAINS) {
    const project = projectByTitle(s === 0 ? baseProject : `${baseProject} ${s + 1}`);
    const owner = project.fields.owner as string;
    let prev: Memory | null = null;
    choices.forEach(([choice, why], i) => {
      const d: Memory = {
        id: `decision-${slug(project.title)}-${slug(topic)}-${i + 1}`, kind: "decision",
        title: `${project.title}: ${topic} is ${choice}`,
        body: prev
          ? `We replaced the earlier decision (${(prev.fields.choice as string)}). For ${project.title}, the ${topic} is now ${choice}, because ${why}.`
          : `For ${project.title}, we decided the ${topic} is ${choice}, because ${why}.`,
        date: day("2025-03-01", i * 60 + s), fields: {
          status: i === choices.length - 1 ? "active" : "superseded", owner, project: project.id, topic, choice,
          supersedes: prev?.id ?? null, supersededBy: null,
        },
        links: [project.id, owner, ...(prev ? [prev.id] : [])],
      };
      if (prev) { prev.fields.supersededBy = d.id; prev.links.push(d.id); }
      decisions.push(d);
      prev = d;
    });
  }
  for (const project of projects.filter((p) => s === 0 ? !/ \d+$/.test(p.title) : p.title.endsWith(` ${s + 1}`))) {
    for (let k = 0; k < 3; k++) {
      const title = `${project.title}: ${STANDALONE[(projects.indexOf(project) * 3 + k) % STANDALONE.length]}`;
      const owner = pick(membersOf(project.fields.team as string)).id;
      decisions.push({
        id: `decision-${slug(title)}`, kind: "decision", title,
        body: `${title.split(": ")[1]} for ${project.title}. Agreed in the ${project.fields.team} team's design review.`,
        date: day("2025-02-15", Math.floor(rand() * 200)), fields: { status: "active", owner, project: project.id, topic: "practice", choice: null, supersedes: null, supersededBy: null },
        links: [project.id, owner],
      });
    }
  }
}

const tasks: Memory[] = [];
const STATUSES = ["open", "open", "open", "in_progress", "blocked", "done", "done"];
const PRIORITIES = ["high", "medium", "medium", "low"];
for (const project of projects) {
  const team = project.fields.team as string;
  for (let k = 0; k < 15; k++) {
    const title = `${TASK_VERBS[k % TASK_VERBS.length]} ${TASK_OBJECTS[(k * 7 + projects.indexOf(project)) % TASK_OBJECTS.length]} for ${project.title}`;
    if (tasks.some((t) => t.title === title)) continue;
    // Mostly the project's own team; sometimes a helper from another team.
    const ownerTeam = rand() < 0.85 ? team : pick(TEAMS.filter((t) => t !== team));
    const owner = pick(membersOf(ownerTeam)).id;
    tasks.push({
      id: `task-${slug(title)}`, kind: "task", title,
      body: `${title}. Owned by ${people.find((p) => p.id === owner)!.title}.`,
      date: day("2025-04-01", Math.floor(rand() * 150)),
      fields: { status: pick(STATUSES), owner, project: project.id, priority: pick(PRIORITIES), due: day("2025-07-01", Math.floor(rand() * 180)) },
      links: [project.id, owner],
    });
  }
}

const incidents: Memory[] = [];
for (const project of projects) {
  const n = Math.floor(rand() * 5);
  for (let k = 0; k < n; k++) {
    const [cause] = pick(CAUSES);
    const sev = pick(["sev1", "sev2", "sev2", "sev3", "sev3"]);
    const date = day("2025-03-01", Math.floor(rand() * 240));
    const title = `${project.title} outage on ${date}`;
    if (incidents.some((i) => i.title === title)) continue;
    const owner = pick(membersOf(project.fields.team as string)).id;
    incidents.push({
      id: `incident-${slug(title)}`, kind: "incident", title,
      body: `${project.title} had a ${sev} outage on ${date}. Root cause: ${cause}.`,
      date, fields: { severity: sev, project: project.id, owner, resolved: rand() < 0.75, rootCause: cause }, links: [project.id, owner],
    });
  }
}

memories.push(...people, ...projects, ...decisions, ...tasks, ...incidents);
const suffix = scale === 1 ? "" : `-x${scale}`;
writeFileSync(`${outDir}memories${suffix}.json`, JSON.stringify(memories, null, 1) + "\n");
console.log(`memories${suffix}.json: ${memories.length} (people ${people.length}, projects ${projects.length}, decisions ${decisions.length}, tasks ${tasks.length}, incidents ${incidents.length})`);

// ---- Questions, with gold answers computed from the memories above ----
const name = (id: string) => people.find((p) => p.id === id)!.title;
const proj = (id: string) => projects.find((p) => p.id === id)!;
const qs: Question[] = [];
const only = "Answer with only";

// lookup: a single fact. Expect both systems to do well here.
const harbor = projectByTitle("Harbor container platform");
qs.push({ id: "lookup-1", category: "lookup", question: `Who owns the Harbor container platform project? ${only} the person's full name.`, gold: { mustInclude: [name(harbor.fields.owner as string)] }, why: "A single fact in one memory." });
const priya = people.find((p) => p.title === "Priya Iyer")!;
qs.push({ id: "lookup-2", category: "lookup", question: `Which team is Priya Iyer on? ${only} the team name.`, gold: { mustInclude: [priya.fields.team as string] }, why: "A single fact in one memory." });
const prism = projectByTitle("Prism analytics warehouse");
qs.push({ id: "lookup-3", category: "lookup", question: `What is the deadline for the Prism analytics warehouse project? ${only} the date as YYYY-MM-DD.`, gold: { mustInclude: [prism.fields.deadline as string] }, why: "A single fact in one memory." });
const someIncident = incidents.find((i) => (i.fields.rootCause as string).includes("timezone")) ?? incidents[0]!;
qs.push({ id: "lookup-4", category: "lookup", question: `What was the root cause of the "${someIncident.title}" incident? Answer in one short sentence.`, gold: { mustInclude: [CAUSES.find(([c]) => c === someIncident.fields.rootCause)![1]] }, why: "A single fact in one memory." });

// changed: a decision was replaced, maybe twice. The old note reads almost the same as the new one.
for (const [project, topic, choices] of [CHAINS[0], CHAINS[1], CHAINS[7], CHAINS[2], CHAINS[6]] as typeof CHAINS) {
  const current = choices[choices.length - 1]![0];
  const old = choices.slice(0, -1).map(([c]) => c);
  const key = (c: string) => c.replace(/^every /, "").replace(/ delivery.*$/, "");
  qs.push({
    id: `changed-${qs.filter((q) => q.category === "changed").length + 1}`, category: "changed",
    question: `What is the current ${topic} for ${project}? ${only} the ${topic}, nothing else.`,
    gold: { mustInclude: [key(current)], mustNotInclude: old.map(key) },
    why: `The ${topic} changed ${old.length} time${old.length > 1 ? "s" : ""}; the older decision still exists and reads almost the same.`,
  });
}

// filter: a list that only exact fields can produce.
const byOwner = (pid: string) => tasks.filter((t) => t.fields.owner === pid);
const openHighCount = (p: Memory) => byOwner(p.id).filter((t) => t.fields.status === "open" && t.fields.priority === "high").length;
// Keep the list short enough to read back: the person with the fewest matches, at least two.
const ownerWithOpenHigh = [...people].filter((p) => openHighCount(p) >= 2).sort((a, b) => openHighCount(a) - openHighCount(b))[0]!;
const openHigh = byOwner(ownerWithOpenHigh.id).filter((t) => t.fields.status === "open" && t.fields.priority === "high");
const notOpenHigh = byOwner(ownerWithOpenHigh.id).filter((t) => !openHigh.includes(t)).slice(0, 3);
qs.push({ id: "filter-1", category: "filter", question: `List the titles of the open, high-priority tasks owned by ${ownerWithOpenHigh.title}. ${only} the task titles, one per line.`, gold: { mustInclude: openHigh.map((t) => t.title), mustNotInclude: notOpenHigh.map((t) => t.title) }, why: `${openHigh.length} of ${byOwner(ownerWithOpenHigh.id).length} tasks by this person match two exact fields.` });
const blockedCount = (p: Memory) => tasks.filter((t) => t.fields.project === p.id && t.fields.status === "blocked").length;
const blockedProject = projects.find((p) => blockedCount(p) >= 2 && blockedCount(p) <= 5) ?? [...projects].sort((a, b) => blockedCount(b) - blockedCount(a))[0]!;
const blocked = tasks.filter((t) => t.fields.project === blockedProject.id && t.fields.status === "blocked");
qs.push({ id: "filter-2", category: "filter", question: `List the titles of the blocked tasks on the ${blockedProject.title} project. ${only} the task titles, one per line.`, gold: { mustInclude: blocked.map((t) => t.title) }, why: "Status lives in a field, not in the words of the task." });
const paused = projects.filter((p) => p.fields.status === "paused");
qs.push({ id: "filter-3", category: "filter", question: `Which projects are paused right now? ${only} the project names, one per line.`, gold: { mustInclude: paused.map((p) => p.title), mustNotInclude: projects.filter((p) => p.fields.status !== "paused").map((p) => p.title) }, why: "Every project memory has to be checked." });
const unresolvedSev1 = incidents.filter((i) => i.fields.severity === "sev1" && !i.fields.resolved);
qs.push({ id: "filter-4", category: "filter", question: `List the unresolved sev1 incidents. ${only} the incident titles, one per line, or "none" if there are none.`, gold: { mustInclude: unresolvedSev1.length ? unresolvedSev1.map((i) => i.title) : ["none"] }, why: "Two exact fields across every incident." });
const ana = people.find((p) => p.title === "Ana Reyes")!;
const anaActive = decisions.filter((d) => d.fields.owner === ana.id && d.fields.status === "active");
const anaSuperseded = decisions.filter((d) => d.fields.owner === ana.id && d.fields.status === "superseded");
qs.push({ id: "filter-5", category: "filter", question: `List the decisions owned by Ana Reyes that are still in force. ${only} the decision titles, one per line.`, gold: { mustInclude: anaActive.map((d) => d.title), mustNotInclude: anaSuperseded.map((d) => d.title) }, why: "Replaced decisions must be left out." });

// count: a number only a full scan or a real query gets right.
qs.push({ id: "count-1", category: "count", question: `How many tasks are blocked across all projects? ${only} the number.`, gold: { mustInclude: [], exactNumber: tasks.filter((t) => t.fields.status === "blocked").length }, why: "Counting means seeing every task." });
const teamIncidents = (team: string) => { const ids = new Set(projects.filter((p) => p.fields.team === team).map((p) => p.id)); return incidents.filter((i) => ids.has(i.fields.project as string)); };
// The base set keeps its original pick; larger sets fall back to the team with the fewest (at least two).
const incidentTeam = scale === 1
  ? [...TEAMS].sort((a, b) => teamIncidents(b).length - teamIncidents(a).length).find((t) => teamIncidents(t).length >= 2 && teamIncidents(t).length <= 8)!
  : [...TEAMS].filter((t) => teamIncidents(t).length >= 2).sort((a, b) => teamIncidents(a).length - teamIncidents(b).length)[0]!;
qs.push({ id: "count-2", category: "count", question: `How many incidents have the ${incidentTeam} team's projects had? ${only} the number.`, gold: { mustInclude: [], exactNumber: teamIncidents(incidentTeam).length }, why: "Needs a join from incident to project to team." });
qs.push({ id: "count-3", category: "count", question: `How many decisions have been replaced by a later decision? ${only} the number.`, gold: { mustInclude: [], exactNumber: decisions.filter((d) => d.fields.status === "superseded").length }, why: "Counting replaced decisions across every project." });
// "Open" has two fair readings: status open, or not done yet (open or in progress). Both count as right.
qs.push({ id: "count-4", category: "count", question: `How many open tasks does ${ownerWithOpenHigh.title} own? ${only} the number.`, gold: { mustInclude: [], exactNumber: byOwner(ownerWithOpenHigh.id).filter((t) => t.fields.status === "open").length, altNumbers: [byOwner(ownerWithOpenHigh.id).filter((t) => t.fields.status === "open" || t.fields.status === "in_progress").length] }, why: "One person and a status. \"Open\" can mean status open or not done yet; both readings count." });
qs.push({ id: "count-5", category: "count", question: `How many people are on the Security team? ${only} the number.`, gold: { mustInclude: [], exactNumber: membersOf("Security").length }, why: "Counting people by team." });

// join: answers that cross several memories.
const atlasChain = decisions.filter((d) => (d.fields.project as string) === projectByTitle("Atlas queue migration").id && d.fields.topic === "target queue");
const atlasNow = atlasChain.find((d) => d.fields.status === "active")!;
qs.push({ id: "join-1", category: "join", question: `Who owns the decision that replaced the original Atlas queue choice, and which team are they on? Answer as: full name, team.`, gold: { mustInclude: [name(atlasNow.fields.owner as string), teamOf(atlasNow.fields.owner as string)] }, why: "Decision, then its replacement, then the owner, then the owner's team." });
const pausedIds = new Set(paused.map((p) => p.id));
const blockedOnPaused = [...new Set(tasks.filter((t) => t.fields.status === "blocked" && pausedIds.has(t.fields.project as string)).map((t) => name(t.fields.owner as string)))];
qs.push({ id: "join-2", category: "join", question: `Which people own blocked tasks on paused projects? ${only} full names, one per line.`, gold: { mustInclude: blockedOnPaused }, why: "Task status, task owner and project status together." });
const crossTeamFor = (team: string) => membersOf(team).filter((p) => tasks.some((t) => t.fields.owner === p.id && t.fields.status !== "done" && proj(t.fields.project as string).fields.team !== team)).map((p) => p.title);
const helperTeam = scale === 1
  ? TEAMS.find((t) => crossTeamFor(t).length >= 1 && crossTeamFor(t).length <= 3)!
  : [...TEAMS].filter((t) => crossTeamFor(t).length >= 1).sort((a, b) => crossTeamFor(a).length - crossTeamFor(b).length)[0]!;
const crossTeam = crossTeamFor(helperTeam);
qs.push({ id: "join-3", category: "join", question: `Which ${helperTeam} team members own an unfinished task on a project that belongs to a different team? ${only} full names, one per line.`, gold: { mustInclude: crossTeam, mustNotInclude: membersOf(helperTeam).map((p) => p.title).filter((n) => !crossTeam.includes(n)) }, why: "Person's team against the task's project's team." });
const withOpenIncidentAndHigh = projects.filter((p) => incidents.some((i) => i.fields.project === p.id && !i.fields.resolved) && tasks.some((t) => t.fields.project === p.id && t.fields.status === "open" && t.fields.priority === "high")).map((p) => p.title);
qs.push({ id: "join-4", category: "join", question: `Which projects have an unresolved incident and also an open high-priority task? ${only} the project names, one per line.`, gold: { mustInclude: withOpenIncidentAndHigh, mustNotInclude: projects.map((p) => p.title).filter((t) => !withOpenIncidentAndHigh.includes(t)) }, why: "Two kinds of memory, both filtered, joined on project." });

writeFileSync(`${outDir}questions${suffix}.json`, JSON.stringify(qs, null, 1) + "\n");
const byCat = qs.reduce<Record<string, number>>((a, q) => ({ ...a, [q.category]: (a[q.category] ?? 0) + 1 }), {});
console.log(`questions${suffix}.json: ${qs.length}`, byCat);
