import { marathon } from '@mnmal-ai/surface-theme';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { linesView, partsLine, truncateParts } from '../src/lines.js';

describe('partsLine', () => {
  it('sanitises every part, twice over safely', () => {
    const line = partsLine([{ text: 'a\x1b[2Jb' }]);
    expect(line.text).not.toContain('\x1b');
    expect(line.parts?.some((p) => p.text.includes('\x1b'))).toBe(false);
    expect(partsLine(line.parts ?? []).text).toBe(line.text);
  });

  it('keeps every part on one line: a line break of any kind becomes a space', () => {
    const line = partsLine([{ text: 'a\nb' }, { text: 'c\r\nd\u2028e' }]);
    expect(line.text).toBe('a bc d e');
    expect(line.parts?.some((p) => /[\n\r]/.test(p.text))).toBe(false);
  });
});

describe('truncateParts', () => {
  it('keeps parts that fit unchanged', () => {
    const parts = [{ text: 'ab', tone: 'accent' as const }, { text: 'cd' }];
    expect(truncateParts(parts, 10)).toEqual(parts);
  });

  it("cuts inside a part with an ellipsis and keeps the kept parts' styling", () => {
    expect(
      truncateParts(
        [
          { text: 'abc', tone: 'warn', bold: true },
          { text: 'defgh', tone: 'dim' }
        ],
        5
      )
    ).toEqual([
      { text: 'abc', tone: 'warn', bold: true },
      { text: 'd…', tone: 'dim' }
    ]);
  });

  it('drops parts past the cut', () => {
    const out = truncateParts([{ text: 'ab' }, { text: 'cd' }, { text: 'ef' }], 3);
    expect(out.map((p) => p.text)).toEqual(['ab', '…']);
  });
});

describe('linesView', () => {
  it('renders a parts line in order, and a plain line as before', () => {
    const view = linesView(
      [partsLine([{ text: 'ab' }, { text: 'cd', bold: true }]), { text: 'plain', tone: 'dim' }],
      marathon
    );
    const { lastFrame } = render(<>{view}</>);
    expect(lastFrame()).toContain('abcd');
    expect(lastFrame()).toContain('plain');
  });

  it("colours a plain line by its tone, and leaves a parts line's colour to its parts", () => {
    type Node = { props: { children: Node[]; color?: string } };
    const view = linesView(
      [
        { text: 'plain', tone: 'dim' },
        { text: 'x', tone: 'dim', parts: [{ text: 'x' }] }
      ],
      marathon
    ) as Node;
    const [plain, parts] = view.props.children as [Node, Node];
    expect(plain.props.color).toBe(marathon.color.dim);
    expect(parts.props.color).toBeUndefined();
  });
});
