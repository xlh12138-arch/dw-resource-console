import type { Role, UserImportRow } from '@dw/shared';

/**
 * 用户批量导入的 Excel 读写。
 * 与资源导入保持一致的口径：先在前端逐行校验并逐列提示，
 * 全部通过后才把行数据交给后端；后端会再校验一次，任一行失败则整批不落库。
 */

export const USER_IMPORT_SHEET = '用户数据';
export const USER_IMPORT_HEADERS = ['用户名', '姓名', '角色', '初始密码'] as const;
export const USER_IMPORT_MAX_ROWS = 500;

export type UserImportIssue = {
  /** 原始 Excel 行号 */
  row: number;
  username: string;
  fields: { field: string; label: string; message: string }[];
};

export type ParsedUserImport = {
  fileName: string;
  rows: UserImportRow[];
  /** 校验通过的条数 = rows.length - 有问题的行数 */
  issues: UserImportIssue[];
};

const ROLE_ALIASES: { role: Role; texts: string[] }[] = [
  { role: 'ADMIN', texts: ['ADMIN', '管理员'] },
  { role: 'USER', texts: ['USER', '普通用户'] },
  { role: 'READONLY', texts: ['READONLY', '只读用户', '只读'] },
];

/** 把「管理员 / ADMIN」之类的写法统一成角色编码；无法识别返回 null */
export function parseRoleText(text: string): Role | null {
  const normalized = text.trim().toUpperCase();
  const hit = ROLE_ALIASES.find((item) =>
    item.texts.some((alias) => alias.toUpperCase() === normalized),
  );
  return hit?.role ?? null;
}

/** 下载导入模板：带表头、说明行与一行示例，示例行不会被导入 */
export async function downloadUserImportTemplate(): Promise<void> {
  const { Workbook } = await import('exceljs');
  const workbook = new Workbook();
  workbook.creator = '数据仓库资源控制台';
  const sheet = workbook.addWorksheet(USER_IMPORT_SHEET);

  sheet.columns = [
    { header: '用户名', key: 'username', width: 22 },
    { header: '姓名', key: 'displayName', width: 18 },
    { header: '角色', key: 'role', width: 14 },
    { header: '初始密码', key: 'password', width: 20 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.addRow(['zhangsan', '张三', '普通用户', '']).font = { italic: true };

  const notes = [
    '',
    '填写说明：',
    `1. 每行一个账号，单次最多 ${USER_IMPORT_MAX_ROWS} 行；请删除第 2 行示例后再填写。`,
    '2. 用户名 3～32 个字符，不能与系统已有账号或本表内其他行重复。',
    '3. 角色可填：管理员 / 普通用户 / 只读用户（也可以填 ADMIN / USER / READONLY）。',
    '4. 初始密码留空则自动生成随机密码；填了则需 8～128 位。',
    '5. 导入前系统会先校验，逐行提示有问题的字段；全部通过才写入，任一行失败则整批不生效。',
    '6. 导入成功后请及时把初始密码转告用户，关闭结果弹窗后无法再次查看。',
  ];
  for (const line of notes) sheet.addRow([line]).font = { color: { argb: 'FF64748B' } };

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
  const sheet = workbook.getWorksheet(USER_IMPORT_SHEET) ?? workbook.worksheets[0];
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
    throw new Error('未识别到表头，请使用下载的模板填写，或检查列名是否被改动');
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
    // 说明行以数字序号开头，这里只跳过 Excel 示例/说明区（首行填写说明之后的纯文本行）
    if (/^[0-9]+[.、]/.test(displayName) || /^[0-9]+[.、]/.test(username)) continue;
    if (rows.length >= USER_IMPORT_MAX_ROWS) {
      throw new Error(`单次最多导入 ${USER_IMPORT_MAX_ROWS} 行，请拆分成多个文件`);
    }

    const fields: UserImportIssue['fields'] = [];
    if (username.length < 3 || username.length > 32) {
      fields.push({ field: 'username', label: '用户名', message: '需为 3～32 个字符' });
    }
    if (displayName.length < 1 || displayName.length > 32) {
      fields.push({ field: 'displayName', label: '姓名', message: '必填，1～32 个字符' });
    }
    const role = parseRoleText(roleText);
    if (!role) {
      fields.push({
        field: 'role',
        label: '角色',
        message: roleText ? `无法识别「${roleText}」` : '必填：管理员 / 普通用户 / 只读用户',
      });
    }
    if (password && (password.length < 8 || password.length > 128)) {
      fields.push({
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

  return { fileName: file.name, rows, issues };
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
