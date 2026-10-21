/** `AgentMessage` -> ['agent', 'message']; `shortId` -> ['short', 'id']. */
export function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((w) => w.length > 0);
}

/** English plural for a lower-case noun, by suffix rule. */
export function pluralize(word: string): string {
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** Sorted, de-duplicated. */
export function uniqueSorted(xs: Iterable<string>): string[] {
  return [...new Set(xs)].sort();
}
