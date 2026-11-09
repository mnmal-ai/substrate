/** Patterns the portable subset accepts, shared by the validator and matcher tests. */
export const ACCEPTED = [
  '(?:ab)+',
  '(a|b)',
  '(a+)b',
  'a'.repeat(256),
  '^https?://(?:www\\.)?([^/]+)/.*$',
  'a|b',
  '[a-z]+',
  'x{2,3}',
  '',
  'a||b',
  '[^a-c.]',
  '\\/\\.\\{',
  '[\\-a]',
  '[a-]',
  'x{255}',
  '[\u{1F600}-\u{1F602}]'
];
