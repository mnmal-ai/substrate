export type MemoryKind = 'person' | 'project' | 'decision' | 'task' | 'incident';

export type FieldValue = string | number | boolean | null;

export interface Memory {
  id: string;
  kind: MemoryKind;
  title: string;
  body: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  fields: Record<string, FieldValue>;
  /** Ids of related memories. */
  links: string[];
}

export interface IngestReport {
  system: string;
  count: number;
  /** Time to write every memory, in milliseconds. */
  writeMs: number;
  /** Time after the writes until the last memory is found by search, in milliseconds. */
  searchableMs: number;
  /** Optional breakdown in milliseconds, e.g. { write, index, embed, firstHit }. */
  phases?: Record<string, number>;
  notes?: string;
}

export interface AgentSetup {
  /** Working directory for the Claude session. */
  cwd: string;
  /** Path to an MCP config JSON file. */
  mcpConfig: string;
  /** Tool names the agent may use, e.g. "mcp__substrate__query", "Read". */
  allowedTools: string[];
  /** Tools this system's agent must not have, on top of the runner's own deny list. */
  disallowedTools?: string[];
  /** Tool-name prefixes or names that count as a memory lookup. */
  memoryTools: string[];
  /** Extra system-prompt text a real user of this system would have. */
  systemPrompt?: string;
}

export interface MemoryAdapter {
  name: 'substrate' | 'obsidian' | 'hindsight';
  reset(): Promise<void>;
  ingest(memories: Memory[]): Promise<IngestReport>;
  agentSetup(): Promise<AgentSetup>;
}

export type QuestionCategory = 'lookup' | 'changed' | 'filter' | 'count' | 'join';

export interface Question {
  id: string;
  category: QuestionCategory;
  question: string;
  /**
   * Passes when the answer contains every mustInclude string, none of the
   * mustNotInclude strings (case-insensitive), and, when exactNumber is set,
   * its last whole number equals exactNumber (or one of altNumbers, for a
   * question with two fair readings).
   */
  gold: {
    mustInclude: string[];
    mustNotInclude?: string[];
    exactNumber?: number;
    altNumbers?: number[];
  };
  /** Why this question is in the set; shown in the UI. */
  why: string;
}

export interface ToolCall {
  name: string;
  input: unknown;
  durationMs: number;
  isMemory: boolean;
}

export interface AskResult {
  system: string;
  questionId?: string;
  answer: string;
  toolCalls: ToolCall[];
  memoryCalls: number;
  /** Tokens the memory system's own LLM spent during this answer (Hindsight's reflect, for instance); not in tokens. */
  memoryLlmTokens?: { input: number; output: number };
  memoryMs: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  wallMs: number;
  passed?: boolean;
  /** Whether the answer names the right items in other words (see gradeIgnoringWording); reported, not the grade. */
  passedIgnoringWording?: boolean;
  error?: string;
}
