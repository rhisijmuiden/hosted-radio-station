/**
 * The RDS character set (IEC 62106 annex E, table E.1). ASCII letters, digits and most punctuation keep their code;
 * accented letters live above 0x80. Characters that RDS cannot show lose their accent, or become a space.
 */
const HIGH =
  'áàéèíìóòúùÑÇŞβ¡Ĳ' + // 0x80
  'âäêëîïôöûüñçşğıĳ' + // 0x90
  'ªα©‰Ǧěňőπ€£$←↑→↓' + // 0xA0
  'º¹²³±İńűµ¿÷°¼½¾§' + // 0xB0
  'ÁÀÉÈÍÌÓÒÚÙŘČŠŽÐĿ' + // 0xC0
  'ÂÄÊËÎÏÔÖÛÜřčšžđŀ' + // 0xD0
  'ÃÅÆŒŷÝÕØÞŊŔĆŚŹŦð' + // 0xE0
  'ãåæœŵýõøþŋŕćśźŧ'; // 0xF0

const map = new Map<string, number>();
for (let i = 0; i < HIGH.length; i++) map.set(HIGH[i]!, 0x80 + i);

/** Letters without a decomposition that have a close match. */
const EXTRA: Record<string, number> = { Ł: 0x4c, ł: 0x6c, ß: 0x8d, Đ: 0xce, Ħ: 0x48, ħ: 0x68, '¤': 0x24 };

/** One character to its RDS code. */
function code(ch: string): number {
  const c = ch.codePointAt(0)!;
  // 0x24 is the general currency sign in RDS, 0x5E/0x60/0x7E are lines; everything else in 0x20–0x7D is ASCII.
  if (c >= 0x20 && c <= 0x7d && c !== 0x24 && c !== 0x5e && c !== 0x60) return c;
  const hit = map.get(ch);
  if (hit !== undefined) return hit;
  if (ch === '’' || ch === '‘' || ch === '`' || ch === '´') return 0x27;
  if (ch === '“' || ch === '”') return 0x22;
  if (ch === '–' || ch === '—') return 0x2d;
  const extra = EXTRA[ch];
  if (extra !== undefined) return extra;
  const plain = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (plain && plain !== ch) return code(plain[0]!);
  return 0x20;
}

/** A text as RDS bytes, one byte per character. */
export function rdsBytes(text: string): number[] {
  return [...text.replace(/[\r\n\t]+/g, ' ')].map(code);
}

/** The length of a text as RDS sees it (one character per code point). */
export const rdsLength = (text: string) => [...text].length;
