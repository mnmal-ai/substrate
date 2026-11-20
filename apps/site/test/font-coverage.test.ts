import { readdirSync, readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const fontsDir = new URL('../public/fonts/', import.meta.url);

// Tags with a one-byte index in the WOFF2 table directory, in spec order (only cmap's slot matters,
// but every slot before an entry must resolve to the right tag to read the directory).
const KNOWN_TAGS = [
  'cmap',
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'name',
  'OS/2',
  'post',
  'cvt ',
  'fpgm',
  'glyf',
  'loca',
  'prep',
  'CFF ',
  'VORG',
  'EBDT',
  'EBLC',
  'gasp',
  'hdmx',
  'kern',
  'LTSH',
  'PCLT',
  'VDMX',
  'vhea',
  'vmtx',
  'BASE',
  'GDEF',
  'GPOS',
  'GSUB',
  'EBSC',
  'JSTF',
  'MATH',
  'CBDT',
  'CBLC',
  'COLR',
  'CPAL',
  'SVG ',
  'sbix',
  'acnt',
  'avar',
  'bdat',
  'bloc',
  'bsln',
  'cvar',
  'fdsc',
  'feat',
  'fmtx',
  'fvar',
  'gvar',
  'hsty',
  'just',
  'lcar',
  'mort',
  'morx',
  'opbd',
  'prop',
  'trak',
  'Zapf',
  'Silf',
  'Glat',
  'Gloc',
  'Feat',
  'Sill'
];

/** The code points a WOFF2 file's cmap maps, read from its format 4 and 12 subtables. */
function codePoints(file: Buffer): Set<number> {
  let p = 48;
  const readBase128 = (): number => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const c = file[p++] as number;
      v = (v << 7) | (c & 0x7f);
      if ((c & 0x80) === 0) break;
    }
    return v;
  };
  const tables: { tag: string; length: number }[] = [];
  for (let i = file.readUInt16BE(12); i > 0; i--) {
    const flags = file[p++] as number;
    const index = flags & 63;
    let tag = KNOWN_TAGS[index] as string;
    if (index === 63) {
      tag = file.subarray(p, p + 4).toString('latin1');
      p += 4;
    }
    const transform = flags >> 6;
    let length = readBase128();
    // glyf and loca are transformed unless version 3; every other table unless version 0.
    const transformed = tag === 'glyf' || tag === 'loca' ? transform !== 3 : transform !== 0;
    if (transformed) length = readBase128();
    tables.push({ tag, length });
  }
  const data = brotliDecompressSync(file.subarray(p, p + file.readUInt32BE(20)));
  let offset = 0;
  let cmap: Buffer | undefined;
  for (const t of tables) {
    if (t.tag === 'cmap') cmap = data.subarray(offset, offset + t.length);
    offset += t.length;
  }
  if (cmap === undefined) throw new Error('no cmap table');

  const covered = new Set<number>();
  for (let i = 0; i < cmap.readUInt16BE(2); i++) {
    const at = cmap.readUInt32BE(8 + i * 8);
    const format = cmap.readUInt16BE(at);
    if (format === 4) {
      const segs = cmap.readUInt16BE(at + 6) / 2;
      for (let s = 0; s < segs; s++) {
        const end = cmap.readUInt16BE(at + 14 + s * 2);
        const start = cmap.readUInt16BE(at + 16 + segs * 2 + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) covered.add(c);
      }
    } else if (format === 12) {
      for (let g = 0; g < cmap.readUInt32BE(at + 12); g++) {
        const start = cmap.readUInt32BE(at + 16 + g * 12);
        const end = cmap.readUInt32BE(at + 20 + g * 12);
        for (let c = start; c <= end; c++) covered.add(c);
      }
    }
  }
  return covered;
}

const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
// Punctuation the page text uses; the arrow (U+2192) is in no DM font and falls back by design.
const punctuation = '.,\'":;!?()/-–—…· ';

describe('committed fonts cover the page text', () => {
  const files = readdirSync(fontsDir).filter((f) => f.endsWith('.woff2'));

  it('finds the sans and both monos', () => {
    expect(files).toEqual(['dm-mono-400.woff2', 'dm-mono-500.woff2', 'dm-sans-variable.woff2']);
  });

  it.each(files)('%s maps letters, digits and punctuation', (name) => {
    const covered = codePoints(readFileSync(new URL(name, fontsDir)));
    const missing = [...letters, ...punctuation].filter(
      (ch) => !covered.has(ch.codePointAt(0) as number)
    );
    expect(missing).toEqual([]);
  });
});
