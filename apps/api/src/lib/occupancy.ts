import type { SlotOccupancyState } from '@dw/shared';

/**
 * 占用期限计算：所有时间统一由服务端按「当前时间」推导，
 * 前端只负责展示，避免客户端时钟差异导致超期天数不一致。
 */

const DAY_MS = 24 * 3600 * 1000;

/** 解析 ISO 字符串 / 日期字符串为 Date；非法值返回 null */
export function parseTime(
  value: string | null | undefined,
  /** 只给日期（YYYY-MM-DD）时：true = 当天 23:59:59（结束时间），false = 当天 00:00:00（开始时间） */
  endOfDay = true,
): Date | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 起止时间 → 占用状态；未绑定资源时为 null。
 * 开始时间在未来同样算「占用中」（容量已经预留），用 notStartedOf 单独标注。
 */
export function occupancyStateOf(
  _startAt: Date | null | undefined,
  endAt: Date | null | undefined,
  now: Date = new Date(),
): SlotOccupancyState | null {
  if (endAt && endAt.getTime() < now.getTime()) return 'EXPIRED';
  return 'ACTIVE';
}

/** 占用尚未开始（开始时间在未来）：页面上标注「未开始」，但容量已计入占用 */
export function notStartedOf(startAt: Date | null | undefined, now: Date = new Date()): boolean {
  return Boolean(startAt && startAt.getTime() > now.getTime());
}

/** 超期天数：结束时间已过则返回天数（向上取整），否则 0 */
export function overdueDaysOf(endAt: Date | null | undefined, now: Date = new Date()): number {
  if (!endAt) return 0;
  const diff = now.getTime() - endAt.getTime();
  if (diff <= 0) return 0;
  return Math.ceil(diff / DAY_MS);
}

/** 距结束时间不足 N 天（含已超期）的占用，用于「即将到期」提醒 */
export function isExpiringSoon(
  endAt: Date | null | undefined,
  now: Date = new Date(),
  withinDays = 7,
): boolean {
  if (!endAt) return false;
  const diff = endAt.getTime() - now.getTime();
  return diff <= withinDays * DAY_MS;
}

/** 两个占用区间是否重叠（endAt 为空视为长期，永远重叠） */
export function periodsOverlap(
  aStart: Date | null | undefined,
  aEnd: Date | null | undefined,
  bStart: Date | null | undefined,
  bEnd: Date | null | undefined,
): boolean {
  const aS = aStart?.getTime() ?? Number.NEGATIVE_INFINITY;
  const aE = aEnd?.getTime() ?? Number.POSITIVE_INFINITY;
  const bS = bStart?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bE = bEnd?.getTime() ?? Number.POSITIVE_INFINITY;
  return aS <= bE && bS <= aE;
}

/** 重叠区间 */
export function overlapRange(
  aStart: Date | null | undefined,
  aEnd: Date | null | undefined,
  bStart: Date | null | undefined,
  bEnd: Date | null | undefined,
): { from: Date | null; to: Date | null } | null {
  if (!periodsOverlap(aStart, aEnd, bStart, bEnd)) return null;
  const starts = [aStart, bStart].filter((d): d is Date => d instanceof Date);
  const ends = [aEnd, bEnd].filter((d): d is Date => d instanceof Date);
  return {
    from: starts.length > 0 ? new Date(Math.max(...starts.map((d) => d.getTime()))) : null,
    to: ends.length > 0 ? new Date(Math.min(...ends.map((d) => d.getTime()))) : null,
  };
}

export { DAY_MS };
