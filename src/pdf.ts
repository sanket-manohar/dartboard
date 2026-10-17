/**
 * A tiny PDF writer: A4 pages, Helvetica text, filled and stroked shapes. Just enough
 * for the audit report, with no dependencies. Coordinates are in points from the top-left.
 */

export type RGB = [number, number, number];

const HELVETICA: number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
  556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD: number[] = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
  611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Characters outside ASCII that WinAnsi can show, with their byte and width. */
const WIN_ANSI: Record<string, [number, number]> = {
  '•': [0x95, 350], '–': [0x96, 556], '—': [0x97, 1000], '‘': [0x91, 222], '’': [0x92, 222], '“': [0x93, 333],
  '”': [0x94, 333], '…': [0x85, 1000], '×': [0xd7, 584], '·': [0xb7, 278], '°': [0xb0, 400], '±': [0xb1, 584],
  '©': [0xa9, 737], '€': [0x80, 556], '→': [0x3e, 584], '←': [0x3c, 584], '▲': [0x2b, 584], '▼': [0x2d, 333],
  '≥': [0x3e, 584], '≤': [0x3c, 584], '✓': [0x2b, 584], '✗': [0x78, 500], '⚠': [0x21, 278], '█': [0x23, 556],
};

export const PAGE_W = 595;
export const PAGE_H = 842;

export interface TextOptions {
  size?: number;
  bold?: boolean;
  color?: RGB;
  align?: 'left' | 'right' | 'center';
}

export class Pdf {
  private pages: string[][] = [];
  private current: string[] = [];

  constructor() {
    this.addPage();
  }

  get pageCount(): number {
    return this.pages.length;
  }

  addPage(): void {
    this.current = [];
    this.pages.push(this.current);
  }

  /** Runs `draw` on page `index` (0-based), e.g. to add footers once the page count is known. */
  onPage(index: number, draw: () => void): void {
    const saved = this.current;
    this.current = this.pages[index];
    draw();
    this.current = saved;
  }

  static width(text: string, size: number, bold = false): number {
    const table = bold ? HELVETICA_BOLD : HELVETICA;
    let w = 0;
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (code >= 32 && code <= 126) {
        w += table[code - 32];
      } else if (WIN_ANSI[ch]) {
        w += WIN_ANSI[ch][1];
      } else if (code >= 0xa0 && code <= 0xff) {
        w += 556;
      } else {
        w += 556;
      }
    }
    return (w * size) / 1000;
  }

  /** Splits text into lines that fit `maxWidth`. */
  static wrap(text: string, size: number, maxWidth: number, bold = false): string[] {
    const out: string[] = [];
    for (const paragraph of text.split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/)) {
        if (!word) {
          continue;
        }
        const candidate = line ? `${line} ${word}` : word;
        if (Pdf.width(candidate, size, bold) <= maxWidth || !line) {
          line = candidate;
          // A single word longer than the line: hard-break it.
          while (Pdf.width(line, size, bold) > maxWidth && line.length > 1) {
            let cut = line.length - 1;
            while (cut > 1 && Pdf.width(line.slice(0, cut), size, bold) > maxWidth) {
              cut--;
            }
            out.push(line.slice(0, cut));
            line = line.slice(cut);
          }
        } else {
          out.push(line);
          line = word;
        }
      }
      out.push(line);
    }
    return out;
  }

  text(x: number, y: number, text: string, o: TextOptions = {}): void {
    const size = o.size ?? 10;
    const w = Pdf.width(text, size, o.bold);
    const left = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
    const [r, g, b] = o.color ?? [0.1, 0.12, 0.16];
    // y is the top of the text box; PDF wants the baseline.
    const baseline = PAGE_H - y - size * 0.8;
    this.current.push(`BT /${o.bold ? 'F2' : 'F1'} ${n(size)} Tf ${n(r)} ${n(g)} ${n(b)} rg ${n(left)} ${n(baseline)} Td (${encode(text)}) Tj ET`);
  }

  rect(x: number, y: number, w: number, h: number, fill?: RGB, stroke?: RGB, lineWidth = 0.75, radius = 0): void {
    const ops: string[] = [];
    if (fill) {
      ops.push(`${n(fill[0])} ${n(fill[1])} ${n(fill[2])} rg`);
    }
    if (stroke) {
      ops.push(`${n(stroke[0])} ${n(stroke[1])} ${n(stroke[2])} RG ${n(lineWidth)} w`);
    }
    const py = PAGE_H - y - h;
    if (radius > 0) {
      const r = Math.min(radius, w / 2, h / 2);
      const k = 0.5523 * r;
      const x0 = x;
      const y0 = py;
      const x1 = x + w;
      const y1 = py + h;
      ops.push(
        `${n(x0 + r)} ${n(y0)} m ${n(x1 - r)} ${n(y0)} l ${n(x1 - r + k)} ${n(y0)} ${n(x1)} ${n(y0 + r - k)} ${n(x1)} ${n(y0 + r)} c ` +
          `${n(x1)} ${n(y1 - r)} l ${n(x1)} ${n(y1 - r + k)} ${n(x1 - r + k)} ${n(y1)} ${n(x1 - r)} ${n(y1)} c ` +
          `${n(x0 + r)} ${n(y1)} l ${n(x0 + r - k)} ${n(y1)} ${n(x0)} ${n(y1 - r + k)} ${n(x0)} ${n(y1 - r)} c ` +
          `${n(x0)} ${n(y0 + r)} l ${n(x0)} ${n(y0 + r - k)} ${n(x0 + r - k)} ${n(y0)} ${n(x0 + r)} ${n(y0)} c h`,
      );
    } else {
      ops.push(`${n(x)} ${n(py)} ${n(w)} ${n(h)} re`);
    }
    ops.push(fill && stroke ? 'B' : fill ? 'f' : 'S');
    this.current.push(`q ${ops.join(' ')} Q`);
  }

  line(x1: number, y1: number, x2: number, y2: number, color: RGB, width = 0.75): void {
    this.current.push(`q ${n(color[0])} ${n(color[1])} ${n(color[2])} RG ${n(width)} w ${n(x1)} ${n(PAGE_H - y1)} m ${n(x2)} ${n(PAGE_H - y2)} l S Q`);
  }

  circle(cx: number, cy: number, r: number, fill?: RGB, stroke?: RGB, width = 1): void {
    const k = 0.5523 * r;
    const y = PAGE_H - cy;
    const path =
      `${n(cx + r)} ${n(y)} m ${n(cx + r)} ${n(y + k)} ${n(cx + k)} ${n(y + r)} ${n(cx)} ${n(y + r)} c ` +
      `${n(cx - k)} ${n(y + r)} ${n(cx - r)} ${n(y + k)} ${n(cx - r)} ${n(y)} c ` +
      `${n(cx - r)} ${n(y - k)} ${n(cx - k)} ${n(y - r)} ${n(cx)} ${n(y - r)} c ` +
      `${n(cx + k)} ${n(y - r)} ${n(cx + r)} ${n(y - k)} ${n(cx + r)} ${n(y)} c h`;
    const ops = [];
    if (fill) {
      ops.push(`${n(fill[0])} ${n(fill[1])} ${n(fill[2])} rg`);
    }
    if (stroke) {
      ops.push(`${n(stroke[0])} ${n(stroke[1])} ${n(stroke[2])} RG ${n(width)} w`);
    }
    this.current.push(`q ${ops.join(' ')} ${path} ${fill && stroke ? 'B' : fill ? 'f' : 'S'} Q`);
  }

  /** An arc from angle a0 to a1 (degrees, 0 = top, clockwise), drawn as a thick stroke. */
  arc(cx: number, cy: number, r: number, a0: number, a1: number, color: RGB, width: number): void {
    const segs = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 90));
    const step = (a1 - a0) / segs;
    const pt = (deg: number) => {
      const rad = ((deg - 90) * Math.PI) / 180;
      return [cx + r * Math.cos(rad), PAGE_H - (cy + r * Math.sin(rad))];
    };
    let path = '';
    const [sx, sy] = pt(a0);
    path += `${n(sx)} ${n(sy)} m `;
    for (let i = 0; i < segs; i++) {
      const s = a0 + i * step;
      const e = s + step;
      const k = (4 / 3) * Math.tan(((e - s) * Math.PI) / 720);
      const [x0, y0] = pt(s);
      const [x3, y3] = pt(e);
      // Tangent directions in PDF space (y up), clockwise on screen.
      const t0 = ((s - 90) * Math.PI) / 180;
      const t3 = ((e - 90) * Math.PI) / 180;
      const x1 = x0 - k * r * Math.sin(t0);
      const y1 = y0 - k * r * Math.cos(t0);
      const x2 = x3 + k * r * Math.sin(t3);
      const y2 = y3 + k * r * Math.cos(t3);
      path += `${n(x1)} ${n(y1)} ${n(x2)} ${n(y2)} ${n(x3)} ${n(y3)} c `;
    }
    this.current.push(`q ${n(color[0])} ${n(color[1])} ${n(color[2])} RG ${n(width)} w 1 J ${path}S Q`);
  }

  /** Serializes the document. */
  build(title: string, author: string): Buffer {
    const objects: string[] = [];
    const add = (body: string) => {
      objects.push(body);
      return objects.length;
    };
    const catalog = add('');
    const pagesObj = add('');
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids: number[] = [];
    for (const ops of this.pages) {
      const content = ops.join('\n');
      const stream = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
      kids.push(
        add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${stream} 0 R /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> >>`),
      );
    }
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const info = add(`<< /Title (${encode(title)}) /Author (${encode(author)}) /Producer (Dartboard) /CreationDate (D:${pdfDate(new Date())}) >>`);

    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) {
      out += `${String(off).padStart(10, '0')} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}

function n(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function encode(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    let byte: number;
    if (code >= 32 && code <= 126) {
      byte = code;
    } else if (WIN_ANSI[ch]) {
      byte = WIN_ANSI[ch][0];
    } else if (code >= 0xa0 && code <= 0xff) {
      byte = code;
    } else {
      byte = 0x3f;
    }
    const c = String.fromCharCode(byte);
    out += c === '(' || c === ')' || c === '\\' ? `\\${c}` : c;
  }
  return out;
}

function pdfDate(d: Date): string {
  const p = (v: number) => String(v).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
