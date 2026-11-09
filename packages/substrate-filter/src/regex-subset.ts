/**
 * The portable regex subset: the syntax on which Postgres (POSIX ARE) and
 * JavaScript agree.
 *
 *   regex  := alt
 *   alt    := seq ('|' seq)*
 *   seq    := (atom quant?)*
 *   atom   := '(' '?:'? alt ')' | '[' '^'? item+ ']' | '.' | '^' | '$'
 *           | '\' esc | char
 *   item   := cchar ('-' cchar)?          (a range may not chain, as in a-c-e)
 *   cchar  := '\' (esc | '-') | any char but ] [ \ newline
 *   quant  := '*' | '+' | '?' | '{' n '}' | '{' n ',' '}' | '{' n ',' m '}'   (n, m <= 255)
 *   esc    := one of ^ $ \ . * + ? ( ) [ ] { } | /
 *   char   := any character but ( ) [ ] { } | * + ? \ newline
 *
 * The pattern is read by code point. `.` matches a newline on both engines
 * (Postgres by default, JavaScript under the `s` flag), so JavaScript compiles
 * it with flags `us`; every accepted pattern constructs under `new RegExp(p, 'us')`.
 *
 * Refused: classes such as `\d`, backreferences, lookaround, inline flags,
 * lazy quantifiers, POSIX bracket classes, quantified anchors, newlines.
 */
const MAX_REPEAT = 255;

export function checkRegexSubset(pattern: string): string | null {
  if (/[\r\n]/.test(pattern)) return 'a newline is not allowed in a pattern';
  const cps = Array.from(pattern);
  let i = 0;
  const fail = (why: string): never => {
    throw new RegexRefusal(`${why} at position ${i}`);
  };
  const ESCAPABLE = '^$\\.*+?()[]{}|/';
  const escapable = (c: string | undefined, inClass = false): c is string =>
    c !== undefined && (ESCAPABLE.includes(c) || (inClass && c === '-'));

  const alt = (depth: number): void => {
    seq(depth);
    while (cps[i] === '|') {
      i++;
      seq(depth);
    }
  };
  const seq = (depth: number): void => {
    for (;;) {
      const c = cps[i];
      if (c === undefined || c === '|' || (c === ')' && depth > 0)) return;
      let quantifiable = true;
      if (c === '(') {
        i++;
        if (cps[i] === '?') {
          if (cps.slice(i, i + 2).join('') !== '?:')
            fail('only the non-capturing group (?: is allowed after (?');
          i += 2;
        }
        alt(depth + 1);
        if (cps[i] !== ')') fail('unclosed group');
        i++;
      } else if (c === '[') {
        cls();
      } else if (c === '^' || c === '$') {
        quantifiable = false;
        i++;
      } else if (c === '\\') {
        const n = cps[i + 1];
        if (!escapable(n)) fail('only an escaped syntax character is allowed (no \\d, \\w, \\1)');
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
    const c = cps[i];
    if (c === '*' || c === '+' || c === '?') i++;
    else if (c === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(cps.slice(i).join(''));
      if (!m) fail('malformed {n,m} quantifier');
      else {
        if (Number(m[1]) > MAX_REPEAT || Number(m[3] || 0) > MAX_REPEAT)
          fail(`a repetition count above ${MAX_REPEAT}`);
        if (m[3] && Number(m[3]) < Number(m[1])) fail('{n,m} with m below n');
        i += m[0].length;
      }
    } else return;
    if (!quantifiable) fail('an anchor cannot be quantified');
    const n = cps[i];
    if (n === '?') fail('lazy quantifiers are not allowed');
    if (n === '*' || n === '+' || n === '{') fail('a quantifier cannot follow a quantifier');
  };
  const cls = (): void => {
    i++;
    if (cps[i] === '^') i++;
    let items = 0;
    const cchar = (): string => {
      const c = cps[i];
      if (c === undefined) return fail('unclosed class');
      if (c === '[') return fail("'[' is not allowed in a class (no POSIX classes)");
      if (c === '\\') {
        const n = cps[i + 1];
        if (!escapable(n, true))
          return fail('only an escaped syntax character is allowed in a class');
        i += 2;
        return n;
      }
      i++;
      return c;
    };
    while (cps[i] !== ']') {
      const lo = cchar();
      items++;
      if (cps[i] === '-' && cps[i + 1] !== ']' && cps[i + 1] !== undefined) {
        i++;
        const hi = cchar();
        if ((lo.codePointAt(0) as number) > (hi.codePointAt(0) as number))
          fail('class range out of order');
        if (cps[i] === '-' && cps[i + 1] !== ']')
          fail('chained class ranges such as a-c-e are not allowed');
      }
    }
    if (items === 0) fail('empty class');
    i++;
  };

  try {
    alt(0);
    if (i < cps.length) fail('unbalanced )');
    return null;
  } catch (e) {
    if (e instanceof RegexRefusal) return e.message;
    throw e;
  }
}

class RegexRefusal extends Error {}
