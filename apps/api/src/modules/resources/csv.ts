/** 极简 CSV 解析/生成：支持引号包裹、逗号转义、CRLF、BOM，不引入额外依赖 */

export function parseCsv(text: string): { header: string[]; rows: Record<string, string>[] } {
  const clean = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const lines: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      lines.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    lines.push(row);
  }

  const nonEmpty = lines.filter((l) => l.some((c) => c.trim() !== ''));
  const [header = [], ...body] = nonEmpty;
  const cols = header.map((h) => h.trim());
  const rows = body.map((cells) => {
    const record: Record<string, string> = {};
    cols.forEach((col, idx) => {
      record[col] = (cells[idx] ?? '').trim();
    });
    return record;
  });
  return { header: cols, rows };
}

function escape(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const lines = [cols.join(',')];
  for (const row of rows) lines.push(cols.map((c) => escape(row[c])).join(','));
  // 带 BOM，保证 Excel 打开中文不乱码
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
