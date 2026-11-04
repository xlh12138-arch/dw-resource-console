/**
 * 资源台账 Excel 模板导入。
 *
 * 模板列由「公共列 + 所选资源类型的字典属性」拼装，必填/选填直接来自字段定义。
 * 上传后先在本模块完成解析与字段级预校验（能给出 Excel 行号、列标、字段名），
 * 校验通过才把行数据转成 CSV 交给后端 /resources/import 落库。
 */
import { RESOURCE_STATUS_LABELS, RESOURCE_STATUSES, type AttrFieldDef } from '@dw/shared';
import type { DictValue } from './dict';

export type ImportColumnKind = AttrFieldDef['kind'] | 'enum';

export interface ImportColumn {
  key: string;
  label: string;
  required: boolean;
  kind: ImportColumnKind;
  group: 'common' | 'attr';
  options?: { value: string; label: string }[];
  placeholder?: string;
  unit?: string;
  hint?: string;
}

/** 一条可定位到单元格的校验问题 */
export interface ImportIssue {
  /** Excel 中的实际行号 */
  row: number;
  /** Excel 列标，如 C */
  column: string;
  /** 字段 key */
  field: string;
  /** 字段中文名 */
  label: string;
  message: string;
}

export interface ParsedImport {
  fileName: string;
  rows: Record<string, string>[];
  headers: string[];
  /** rows[i] 在 Excel 里的原始行号，用于把后端返回的 CSV 行号换算回去 */
  rowNumbers: number[];
  /** 模板里未定义的列，导入时会被忽略 */
  unknownColumns: string[];
  issues: ImportIssue[];
}

const KIND_LABELS: Record<ImportColumnKind, string> = {
  text: '文本',
  textarea: '多行文本',
  number: '数字',
  select: '下拉选择',
  enum: '下拉选择',
  switch: '是/否',
};

/** 公共列。name 必填；environment/status 留空时后端会补默认值 */
function commonColumns(dict: DictValue): ImportColumn[] {
  const envs = (dict.activeEnvironments.length > 0 ? dict.activeEnvironments : dict.environments).map((e) => ({
    value: e.code,
    label: e.label,
  }));
  return [
    {
      key: 'name',
      label: '资源名称',
      required: true,
      kind: 'text',
      group: 'common',
      placeholder: '调度主节点-01',
      hint: '重复数据按「名称 + 环境」判定',
    },
    {
      key: 'environment',
      label: '环境编码',
      required: false,
      kind: 'enum',
      group: 'common',
      options: envs,
      hint: '留空则使用默认环境；请填写编码（如 PROD）',
    },
    {
      key: 'status',
      label: '状态',
      required: false,
      kind: 'enum',
      group: 'common',
      options: RESOURCE_STATUSES.map((s) => ({ value: s, label: RESOURCE_STATUS_LABELS[s] })),
      hint: '留空默认「在用」；请填写编码（如 IN_USE）',
    },
    { key: 'datacenter', label: '机房/可用区', required: false, kind: 'text', group: 'common' },
    { key: 'owner', label: '负责人', required: false, kind: 'text', group: 'common' },
    {
      key: 'tags',
      label: '标签',
      required: false,
      kind: 'text',
      group: 'common',
      hint: '多个标签用 ; 或 | 分隔',
    },
    { key: 'remark', label: '备注', required: false, kind: 'textarea', group: 'common' },
  ];
}

/** 按资源类型拼装模板列；必填项完全取自字典字段定义 */
export function buildImportColumns(type: string, dict: DictValue): ImportColumn[] {
  const attrs: ImportColumn[] = dict.attrFields(type).map((field) => ({
    key: field.key,
    label: field.label,
    required: Boolean(field.required),
    kind: field.kind,
    group: 'attr',
    options:
      field.kind === 'switch'
        ? [
            { value: 'true', label: '是' },
            { value: 'false', label: '否' },
          ]
        : field.options,
    placeholder: field.placeholder,
    unit: field.unit,
    hint: field.defaultValue ? `默认值：${field.defaultValue}` : undefined,
  }));
  return [...commonColumns(dict), ...attrs];
}

/** 0 → A，25 → Z，26 → AA */
export function columnLetter(index: number): string {
  let n = Math.max(0, index);
  let result = '';
  do {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return result;
}

function triggerDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 生成 Excel 模板：
 * - 「资源数据」表：表头带 * 且标红 = 必填，灰色 = 选填；单元格批注写明字段名/类型/允许值/示例
 * - 下拉列写入 Excel 数据有效性，避免手填错值
 * - 「填写说明」表：逐列列出字段名、必填/选填、类型、允许值和说明
 */
export async function downloadImportTemplate(
  type: string,
  typeLabel: string,
  columns: ImportColumn[],
): Promise<void> {
  const { Workbook } = await import('exceljs');
  const workbook = new Workbook();
  workbook.creator = 'DW Resource Console';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('资源数据', { views: [{ state: 'frozen', ySplit: 1 }] });
  const header = sheet.addRow(columns.map((c) => `${c.required ? '*' : ''}${c.label}`));
  header.height = 28;
  header.eachCell((cell, colNumber) => {
    const col = columns[colNumber - 1]!;
    cell.font = {
      bold: true,
      size: 11,
      color: { argb: col.required ? 'FFB91C1C' : 'FF334155' },
    };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: col.required ? 'FFFEF2F2' : 'FFF1F5F9' },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };

    const lines = [
      `字段名：${col.key}`,
      `填写要求：${col.required ? '必填（表头带 * 且标红）' : '选填'}`,
      `字段类型：${KIND_LABELS[col.kind]}`,
    ];
    if (col.options?.length) lines.push(`允许值：${col.options.map((o) => o.value).join(' / ')}`);
    if (col.unit) lines.push(`单位：${col.unit}`);
    if (col.placeholder) lines.push(`示例：${col.placeholder}`);
    if (col.hint) lines.push(`说明：${col.hint}`);
    lines.push(col.group === 'attr' ? `来源：资源类型「${typeLabel}」的属性定义` : '来源：资源公共列');
    cell.note = lines.join('\n');
  });
  columns.forEach((col, idx) => {
    sheet.getColumn(idx + 1).width = Math.min(30, Math.max(14, col.label.length * 2 + 8));
  });

  // 下拉列：覆盖前 200 行，值为编码；填写说明表里同时给出中文名
  for (let idx = 0; idx < columns.length; idx += 1) {
    const col = columns[idx]!;
    const values = (col.options ?? []).map((o) => o.value).filter(Boolean);
    const list = values.join(',');
    if (!list || list.length > 230) continue;
    for (let row = 2; row <= 201; row += 1) {
      sheet.getCell(row, idx + 1).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`"${list}"`],
      };
    }
  }

  const info = workbook.addWorksheet('填写说明');
  const notes = [
    `资源类型：${typeLabel}（${type}）`,
    '1. 请在「资源数据」工作表按行填写，一行一条资源，数据从第 2 行开始。',
    '2. 表头带 * 且为红色底色的列是必填项，其余为选填项；请勿修改表头文字与列顺序。',
    '3. 鼠标悬停在表头上可以查看字段名、类型、允许值和示例。带下拉的列请从下拉选项中选择。',
    '4. 环境、状态等下拉列请填写编码；本表下方列出了每个字段的允许值及其中文含义。',
    '5. 重复数据按「名称 + 环境」判定，导入时可选择跳过或覆盖。',
    '6. 填好后保存为 .xlsx，回到导入弹窗上传；系统会先校验，逐条提示有问题的字段，全部通过后才写入。',
  ];
  for (const note of notes) {
    const row = info.addRow([note]);
    row.getCell(1).alignment = { vertical: 'middle', wrapText: true };
    if (note.startsWith('资源类型')) row.getCell(1).font = { bold: true, size: 12 };
  }
  info.addRow([]);
  const tableHeader = info.addRow(['列名', '字段名', '必填/选填', '类型', '允许值', '示例 / 说明']);
  tableHeader.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF475569' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  for (const col of columns) {
    const allowed = (col.options ?? [])
      .map((o) => (o.label === o.value ? o.value : `${o.value}（${o.label}）`))
      .join(' / ');
    info.addRow([
      `${col.required ? '*' : ''}${col.label}`,
      col.key,
      col.required ? '必填' : '选填',
      KIND_LABELS[col.kind],
      allowed,
      [col.placeholder && `示例：${col.placeholder}`, col.unit && `单位：${col.unit}`, col.hint]
        .filter(Boolean)
        .join('；'),
    ]);
  }
  [36, 22, 14, 14, 46, 40].forEach((width, idx) => {
    info.getColumn(idx + 1).width = width;
  });

  const buffer = await workbook.xlsx.writeBuffer();
  triggerDownload(
    `资源导入模板-${type}-${new Date().toISOString().slice(0, 10)}.xlsx`,
    new Blob([buffer as unknown as BlobPart], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
  );
}

/** ExcelJS 单元格的值可能是字符串 / 数字 / 日期 / 富文本 / 公式结果 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.richText)) {
      return v.richText.map((t) => String((t as { text?: string }).text ?? '')).join('');
    }
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return cellText(v.text);
    if ('error' in v) return String(v.error ?? '');
  }
  return '';
}

/**
 * 表头兼容三种写法：字段名（name）、中文列名（资源名称）、中文列名（字段名）。
 * 模板生成的是「*中文列名」，所以这里会去掉首尾的 * 再匹配。
 */
function resolveHeader(text: string, columns: ImportColumn[]): string | null {
  const base = text.trim().replace(/^\*+/, '').replace(/\*+$/, '').trim();
  if (!base) return null;
  const candidates = [base];
  const paren = base.match(/[（(]([^）)]+)[）)]/);
  if (paren?.[1]) candidates.push(paren[1].trim());
  candidates.push(base.replace(/[（(][^）)]*[）)]/g, '').trim());

  for (const candidate of candidates) {
    if (!candidate) continue;
    const byKey = columns.find((c) => c.key.toLowerCase() === candidate.toLowerCase());
    if (byKey) return byKey.key;
    const byLabel = columns.find((c) => c.label === candidate);
    if (byLabel) return byLabel.key;
  }
  return null;
}

const BOOL_TRUE = new Set(['1', 'true', 'yes', 'y', '是']);
const BOOL_FALSE = new Set(['0', 'false', 'no', 'n', '否']);

/** 本地预校验：给出 Excel 行号、列标、字段名和具体问题 */
function validateRows(
  rows: Record<string, string>[],
  rowNumbers: number[],
  columns: ImportColumn[],
  keyByIndex: Map<number, string>,
): ImportIssue[] {
  const indexOf = new Map<string, number>();
  for (const [index, key] of keyByIndex) indexOf.set(key, index);
  const issues: ImportIssue[] = [];

  rows.forEach((row, i) => {
    const rowNo = rowNumbers[i] ?? i + 2;
    for (const col of columns) {
      const raw = (row[col.key] ?? '').trim();
      const at = indexOf.get(col.key);
      // 列被用户删掉时只报字段名，不臆造列标
      const column = at === undefined ? '' : columnLetter(at - 1);
      const report = (message: string) =>
        issues.push({ row: rowNo, column, field: col.key, label: col.label, message });

      if (col.required && !raw) {
        report('必填项不能为空');
        continue;
      }
      if (!raw) continue;

      if (col.kind === 'number') {
        if (!Number.isFinite(Number(raw))) report(`需要填写数字，当前为「${raw}」`);
        continue;
      }
      if (col.kind === 'switch') {
        const lower = raw.toLowerCase();
        if (BOOL_TRUE.has(lower)) row[col.key] = 'true';
        else if (BOOL_FALSE.has(lower)) row[col.key] = 'false';
        else report(`只能填 是/否、true/false 或 1/0，当前为「${raw}」`);
        continue;
      }
      if ((col.kind === 'select' || col.kind === 'enum') && col.options?.length) {
        const match = col.options.find(
          (o) => o.value === raw || o.label === raw || o.value.toLowerCase() === raw.toLowerCase(),
        );
        if (!match) {
          report(`「${raw}」不在允许值范围内：${col.options.map((o) => o.value).join(' / ')}`);
        } else {
          // 用户填中文名时自动换成后端需要的编码
          row[col.key] = match.value;
        }
      }
    }
  });
  return issues;
}

/** 解析上传的 xlsx：自动定位表头行、跳过空行、记录原始 Excel 行号 */
export async function parseImportFile(file: File, columns: ImportColumn[]): Promise<ParsedImport> {
  const { Workbook } = await import('exceljs');
  const workbook = new Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.getWorksheet('资源数据') ?? workbook.worksheets[0];
  if (!sheet) throw new Error('Excel 中没有可读取的工作表');

  // 允许用户在表头上方加标题行：在前几行里找匹配列数最多的一行
  let headerRow = 1;
  let best = 0;
  for (let r = 1; r <= Math.min(6, sheet.rowCount); r += 1) {
    let matches = 0;
    sheet.getRow(r).eachCell((cell) => {
      if (resolveHeader(cellText(cell.value), columns)) matches += 1;
    });
    if (matches > best) {
      best = matches;
      headerRow = r;
    }
  }
  if (best === 0) throw new Error('未识别到表头，请使用下载的模板填写，或检查列名是否被改动');

  const keyByIndex = new Map<number, string>();
  const headers: string[] = [];
  const unknownColumns: string[] = [];
  sheet.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = cellText(cell.value).trim();
    if (!text) return;
    const key = resolveHeader(text, columns);
    if (key) {
      keyByIndex.set(colNumber, key);
      headers.push(key);
    } else {
      headers.push(text);
      unknownColumns.push(`${columnLetter(colNumber - 1)} 列「${text}」`);
    }
  });

  const rows: Record<string, string>[] = [];
  const rowNumbers: number[] = [];
  for (let r = headerRow + 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const record: Record<string, string> = {};
    let hasValue = false;
    for (const [colNumber, key] of keyByIndex) {
      const value = cellText(row.getCell(colNumber).value).trim();
      record[key] = value;
      if (value) hasValue = true;
    }
    if (!hasValue) continue;
    rows.push(record);
    rowNumbers.push(r);
  }

  return {
    fileName: file.name,
    rows,
    headers,
    rowNumbers,
    unknownColumns,
    issues: validateRows(rows, rowNumbers, columns, keyByIndex),
  };
}

/** 校验通过的行转成后端 /resources/import 接受的 CSV 文本 */
export function importRowsToCsv(rows: Record<string, string>[], columns: ImportColumn[]): string {
  const keys = Array.from(new Set([...columns.map((c) => c.key), ...rows.flatMap((r) => Object.keys(r))]));
  const escape = (value: string) =>
    /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return [
    keys.join(','),
    ...rows.map((row) => keys.map((key) => escape(row[key] ?? '')).join(',')),
  ].join('\n');
}
