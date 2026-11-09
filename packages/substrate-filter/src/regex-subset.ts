/**
 * The portable regex subset: the syntax on which Postgres (POSIX ARE) and
 * JavaScript agree.
 *
 *   regex  := alt
 *   alt    := seq ('|' seq)*
 *   seq    := (atom quant?)*
 *   atom   := '(' '?:'? alt ')' | '[' '^'? item+ ']' | '.' | '^' | '$'
 *           | '\' punct | char
 *   item   := cchar ('-' cchar)?          cchar := '\' punct | any char but ] [ \ newline
 *   quant  := '*' | '+' | '?' | '{' n '}' | '{' n ',' '}' | '{' n ',' m '}'
 *   punct  := any non-alphanumeric character
 *   char   := any character but ( ) [ ] { } | * + ? \ newline
 *
 * Refused: classes such as `\d`, backreferences, lookaround, inline flags,
 * lazy quantifiers, POSIX bracket classes, quantified anchors, newlines.
 */
export function checkRegexSubset(pattern: string): string | null {
  if (/[\r\n]/.test(pattern)) return 'a newline is not allowed in a pattern';
  let i = 0;
  const fail = (why: string): never => {
    throw new RegexRefusal(`${why} at position ${i}`);
  };
  const punct = (c: string | undefined): c is string => c !== undefined && /[^A-Za-z0-9]/.test(c);

  const alt = (depth: number): void => {
    seq(depth);
    while (pattern[i] === '|') {
      i++;
      seq(depth);
    }
  };
  const seq = (depth: number): void => {
    for (;;) {
      const c = pattern[i];
      if (c === undefined || c === '|' || (c === ')' && depth > 0)) return;
      let quantifiable = true;
      if (c === '(') {
        i++;
        if (pattern[i] === '?') {
          if (pattern.slice(i, i + 2) !== '?:')
            fail('only the non-capturing group (?: is allowed after (?');
          i += 2;
        }
        alt(depth + 1);
        if (pattern[i] !== ')') fail('unclosed group');
        i++;
      } else if (c === '[') {
        cls();
      } else if (c === '^' || c === '$') {
        quantifiable = false;
        i++;
      } else if (c === '\\') {
        const n = pattern[i + 1];
        if (!punct(n)) fail('only an escaped punctuation character is allowed (no \\d, \\w, \\1)');
        i += 2;
      } else if (c === '.') {
        i++;
      } else if (')]}{*+?'.includes(c)) {
        fail(`unexpected '${c}'`);
      } else {
        i++;
      }
      quant(quantifiable);
    }
  };
  const quant = (quantifiable: boolean): void => {
    const c = pattern[i];
    if (c === '*' || c === '+' || c === '?') i++;
    else if (c === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(pattern.slice(i));
      if (!m) fail('malformed {n,m} quantifier');
      else {
        if (m[3] && Number(m[3]) < Number(m[1])) fail('{n,m} with m below n');
        i += m[0].length;
      }
    } else return;
    if (!quantifiable) fail('an anchor cannot be quantified');
    const n = pattern[i];
    if (n === '?') fail('lazy quantifiers are not allowed');
    if (n === '*' || n === '+' || n === '{') fail('a quantifier cannot follow a quantifier');
  };
  const cls = (): void => {
    i++;
    if (pattern[i] === '^') i++;
    let items = 0;
    const cchar = (): string => {
      const c = pattern[i];
      if (c === undefined) return fail('unclosed class');
      if (c === '[') return fail("'[' is not allowed in a class (no POSIX classes)");
      if (c === '\\') {
        const n = pattern[i + 1];
        if (!punct(n)) return fail('only an escaped punctuation character is allowed in a class');
        i += 2;
        return n;
      }
      i++;
      return c;
    };
    while (pattern[i] !== ']') {
      const lo = cchar();
      items++;
      if (pattern[i] === '-' && pattern[i + 1] !== ']' && pattern[i + 1] !== undefined) {
        i++;
        const hi = cchar();
        if (lo > hi) fail('class range out of order');
      }
    }
    if (items === 0) fail('empty class');
    i++;
  };

  try {
    alt(0);
    if (i < pattern.length) fail('unbalanced )');
    return null;
  } catch (e) {
    if (e instanceof RegexRefusal) return e.message;
    throw e;
  }
}

class RegexRefusal extends Error {}
