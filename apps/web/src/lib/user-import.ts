import { ROLES, ROLE_LABELS } from '@dw/shared';
import type { Role, UserImportRow } from '@dw/shared';

/**
 * 用户批量导入的 Excel 读写。
 * 与资源导入保持一致的口径：先在前端逐行校验并逐列提示，
 * 全部通过后才把行数据交给后端；后端会再校验一次，任一行失败则整批不落库。
 */

export const USER_IMPORT_SHEET = '用户数据';
/** 模板第 2 个工作表，只放填写说明；导入时按名字排除，不会被当成数据读取 */
export const USER_IMPORT_GUIDE_SHEET = '填写说明';
export const USER_IMPORT_HEADERS = ['用户名', '姓名', '角色', '初始密码'] as const;
export const USER_IMPORT_MAX_ROWS = 500;

/** 某一列的问题；headers 是该列在表头里的位置，前端据此高亮到对应单元格 */
export type UserImportFieldIssue = {
  field: string;
  label: string;
  message: string;
  /** 表头列："用户名" / "姓名" / "角色" / "初始密码" */
  column?: string;
  /** 单元格地址，如 C3 */
  cell?: string;
};

export type UserImportIssue = {
  /** 原始 Excel 行号 */
  row: number;
  username: string;
  fields: UserImportFieldIssue[];
};

export type ParsedUserImport = {
  fileName: string;
  rows: UserImportRow[];
  /** 校验通过的条数 = rows.length - 有问题的行数 */
  issues: UserImportIssue[];
};

const ROLE_ALIASES: { role: Role; texts: string[] }[] = ROLES.map((role) => ({
  role,
  texts: role === 'READONLY' ? [role, ROLE_LABELS[role], '只读'] : [role, ROLE_LABELS[role]],
}));

/**
 * 模板里「角色」列的下拉选项。取系统当前可设置的角色（共享枚举 ROLES + 中文名），
 * 以后新增角色时模板、校验、提示会一起跟着变，不需要另改一份文案。
 */
export const USER_IMPORT_ROLES: { value: Role; text: string }[] = ROLES.map((role) => ({
  value: role,
  text: ROLE_LABELS[role],
}));

const ROLE_OPTION_TEXT = USER_IMPORT_ROLES.map((item) => item.text).join(' / ');

/** 把「管理员 / ADMIN」之类的写法统一成角色编码；无法识别返回 null */
export function parseRoleText(text: string): Role | null {
  const normalized = text.trim().toUpperCase();
  const hit = ROLE_ALIASES.find((item) =>
    item.texts.some((alias) => alias.toUpperCase() === normalized),
  );
  return hit?.role ?? null;
}

/** 下载导入模板：第 1 个工作表用于填写数据，第 2 个工作表只放填写说明（导入时不读取） */
export async function downloadUserImportTemplate(): Promise<void> {
  const { Workbook } = await import('exceljs');
  const workbook = new Workbook();
  workbook.creator = '数据仓库资源管理平台';
  const sheet = workbook.addWorksheet(USER_IMPORT_SHEET);

  sheet.columns = [
    { header: '用户名', key: 'username', width: 22 },
    { header: '姓名', key: 'displayName', width: 18 },
    { header: '角色', key: 'role', width: 14 },
    { header: '初始密码', key: 'password', width: 20 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  /*
   * 「角色」列做成下拉，避免手写错别字导致整批导入失败。
   * 范围覆盖到单次导入上限再多留一些空行；不再整列铺到 1048576 行，
   * 那会把模板从几 KB 撑到 2MB 以上。
   * 选项里不要出现英文逗号，Excel 会把 list 公式的逗号当分隔符。
   */
  const roleColumn = columnLetter(USER_IMPORT_HEADERS.indexOf('角色') + 1);
  for (let row = 2; row <= USER_IMPORT_MAX_ROWS + 8; row += 1) {
    sheet.getCell(`${roleColumn}${row}`).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: [`"${USER_IMPORT_ROLES.map((item) => item.text).join(',')}"`],
      showInputMessage: true,
      promptTitle: '角色',
      prompt: `请从下拉中选择：${ROLE_OPTION_TEXT}`,
      showErrorMessage: true,
      errorStyle: 'stop',
      errorTitle: '角色不正确',
      error: `请从下拉中选择：${ROLE_OPTION_TEXT}`,
    };
  }

  const notes = [
    [
      '填写说明',
      `本说明页只供参考，导入时不会读取；请把账号填写在「${USER_IMPORT_SHEET}」工作表。`,
    ],
    [
      '1',
      `每行一个账号，单次最多 ${USER_IMPORT_MAX_ROWS} 行；第 1 行是表头，请保留原样、不要改动列名。`,
    ],
    ['2', '用户名 3～32 个字符，不能与系统已有账号或本表内其他行重复。'],
    ['3', `角色请从下拉中选择：${ROLE_OPTION_TEXT}（也接受 ADMIN / USER / READONLY）。`],
    ['4', '姓名必填，1～32 个字符。'],
    ['5', '初始密码留空则自动生成随机密码；填了则需 8～128 位。'],
    ['6', '导入前系统会先校验，逐行提示有问题的字段；全部通过才写入，任一行失败则整批不生效。'],
    ['7', '用户名与系统里已有账号重复时会提示具体行号与已存在的账号，不会写入任何数据。'],
    ['8', '导入成功后请及时把初始密码转告用户，关闭结果弹窗后无法再次查看。'],
  ];
  const guide = workbook.addWorksheet(USER_IMPORT_GUIDE_SHEET);
  guide.columns = [
    { header: '序号', key: 'seq', width: 8 },
    { header: '说明', key: 'note', width: 96 },
  ];
  guide.getRow(1).font = { bold: true };
  for (const [seq, note] of notes) {
    guide.addRow([seq, note]).font = { color: { argb: 'FF334155' } };
  }
  guide.getRow(1).alignment = { vertical: 'middle' };
  guide.getColumn(2).alignment = { wrapText: true, vertical: 'top' };

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `用户导入模板-${new Date().toISOString().slice(0, 10)}.xlsx`;
  link.click();
  URL.revokeObjectURL(url);
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const rich = value as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (typeof rich.text === 'string') return rich.text;
    if (Array.isArray(rich.richText)) return rich.richText.map((part) => part.text).join('');
    if (rich.result !== undefined) return String(rich.result);
    return '';
  }
  return String(value);
}

/** 解析上传的 xlsx：自动定位表头行、跳过空行、记录原始 Excel 行号 */
export async function parseUserImportFile(file: File): Promise<ParsedUserImport> {
  const { Workbook } = await import('exceljs');
  const workbook = new Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = pickDataSheet(workbook);
  if (!sheet) throw new Error('Excel 中没有可读取的工作表');

  // 允许用户在表头上方加标题行：在前 6 行里找匹配列数最多的一行
  const wanted = USER_IMPORT_HEADERS as readonly string[];
  let headerRow = 1;
  let best = 0;
  for (let r = 1; r <= Math.min(6, sheet.rowCount); r += 1) {
    let matches = 0;
    sheet.getRow(r).eachCell((cell) => {
      if (wanted.includes(cellText(cell.value).trim())) matches += 1;
    });
    if (matches > best) {
      best = matches;
      headerRow = r;
    }
  }
  if (best === 0) {
    throw new Error(
      `未在「${sheet.name}」工作表识别到表头，请使用下载的模板填写，或检查列名是否被改动`,
    );
  }

  const columnOf = new Map<string, number>();
  sheet.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = cellText(cell.value).trim();
    if (wanted.includes(text) && !columnOf.has(text)) columnOf.set(text, colNumber);
  });

  const rows: UserImportRow[] = [];
  const issues: UserImportIssue[] = [];
  const trim = (r: number, header: string) => {
    const col = columnOf.get(header);
    return col ? cellText(sheet.getRow(r).getCell(col).value).trim() : '';
  };

  for (let r = headerRow + 1; r <= sheet.rowCount; r += 1) {
    const username = trim(r, '用户名');
    const displayName = trim(r, '姓名');
    const roleText = trim(r, '角色');
    const password = trim(r, '初始密码');
    if (!username && !displayName && !roleText && !password) continue;
    if (rows.length >= USER_IMPORT_MAX_ROWS) {
      throw new Error(`单次最多导入 ${USER_IMPORT_MAX_ROWS} 行，请拆分成多个文件`);
    }

    const fields: UserImportIssue['fields'] = [];
    const at = (header: string) => {
      const col = columnOf.get(header);
      return { column: header, cell: col ? `${columnLetter(col)}${r}` : undefined };
    };
    if (username.length < 3 || username.length > 32) {
      fields.push({
        ...at('用户名'),
        field: 'username',
        label: '用户名',
        message: '需为 3～32 个字符',
      });
    }
    if (displayName.length < 1 || displayName.length > 32) {
      fields.push({
        ...at('姓名'),
        field: 'displayName',
        label: '姓名',
        message: '必填，1～32 个字符',
      });
    }
    const role = parseRoleText(roleText);
    if (!role) {
      fields.push({
        ...at('角色'),
        field: 'role',
        label: '角色',
        message: roleText
          ? `无法识别「${roleText}」，请从下拉中选择${ROLE_OPTION_TEXT}`
          : `必填，请从下拉中选择${ROLE_OPTION_TEXT}`,
      });
    }
    if (password && (password.length < 8 || password.length > 128)) {
      fields.push({
        ...at('初始密码'),
        field: 'password',
        label: '初始密码',
        message: '留空自动生成，或填 8～128 位',
      });
    }

    if (fields.length > 0) issues.push({ row: r, username, fields });
    else rows.push({ row: r, username, displayName, role: role!, password: password || undefined });
  }

  if (rows.length === 0 && issues.length === 0) throw new Error('表格里没有可导入的用户行');

  // 文件内自检：用户名重复直接拦下，避免提交后才被服务端整体回滚
  const seen = new Map<string, number>();
  for (const row of rows) {
    const prev = seen.get(row.username);
    if (prev !== undefined) {
      issues.push({
        row: row.row,
        username: row.username,
        fields: [
          {
            column: '用户名',
            cell: columnOf.get('用户名')
              ? `${columnLetter(columnOf.get('用户名')!)}${row.row}`
              : undefined,
            field: 'username',
            label: '用户名',
            message: `与第 ${prev} 行重复，同一份导入里用户名不能重复`,
          },
        ],
      });
    } else {
      seen.set(row.username, row.row);
    }
  }

  // 在问题单元格上加批注并标红，用户回去改表时一眼能看到是哪一格
  for (const issue of issues) {
    for (const field of issue.fields) {
      if (!field.cell) continue;
      const cell = sheet.getCell(field.cell);
      cell.note = { texts: [{ text: `${field.label}：${field.message}` }] };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFEE2E2' },
      };
    }
  }

  return { fileName: file.name, rows, issues };
}

/** 1 → A、3 → C；模板只在 26 列以内使用，够用即可 */
function columnLetter(index: number): string {
  return String.fromCharCode(64 + index);
}

/**
 * 选出要读取的工作表：优先按名字找「用户数据」；找不到时取第一个不是说明页的表。
 * 说明页（填写说明）永远不会被当成数据读取。
 */
function pickDataSheet(workbook: import('exceljs').Workbook) {
  const named = workbook.getWorksheet(USER_IMPORT_SHEET);
  if (named) return named;
  const candidates = workbook.worksheets.filter((sheet) => sheet.name !== USER_IMPORT_GUIDE_SHEET);
  return candidates[0] ?? workbook.worksheets[0];
}

/** 校验通过的行转成 CSV，用于「导出本次校验通过的数据」或手工核对 */
export function userImportRowsToCsv(rows: UserImportRow[]): string {
  const escape = (value: string) =>
    /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return [
    '用户名,姓名,角色,初始密码',
    ...rows.map((row) =>
      [row.username, row.displayName, row.role, row.password ?? ''].map(escape).join(','),
    ),
  ].join('\n');
}
