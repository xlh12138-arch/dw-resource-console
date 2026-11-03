/**
 * 容量按时间段的占用计算。
 *
 * 同一个资源可以被多个项目在不同时间段占用：
 * - 时间段**不重叠** → 各自都能用到资源的最大容量（不累加）；
 * - 时间段**重叠** → 同一时刻的占用为各方之和。
 *
 * 因此「已占用」不能简单把所有占用记录相加，而要取**时间轴上的峰值**。
 */

export interface CapacitySegment {
  /** 占用记录标识（槽位 id 或子资源 id） */
  id: number;
  amount: number;
  startAt: Date | null;
  endAt: Date | null;
}

export interface CapacityPeak {
  /** 峰值占用量（含恒定基线 constant） */
  amount: number;
  /** 峰值时刻来自时间段占用的部分 */
  segmentAmount: number;
  /** 峰值时段起止（null 表示无界 / 长期） */
  startAt: Date | null;
  endAt: Date | null;
  /** 峰值时刻同时生效的占用记录 */
  ids: number[];
  /** 时间轴上的占用曲线：相邻等值的区间已合并，便于前端画占用走势 */
  curve: { startAt: Date | null; endAt: Date | null; amount: number }[];
}

const NEG_INF = Number.NEGATIVE_INFINITY;
const POS_INF = Number.POSITIVE_INFINITY;

/**
 * 计算时间轴上的峰值占用。
 *
 * @param segments 带时间段的占用记录（startAt / endAt 为 null 表示无界）
 * @param constant 恒定基线（如子资源申请量，任何时刻都占用）
 */
export function peakOf(segments: CapacitySegment[], constant = 0): CapacityPeak {
  const usable = segments.filter((s) => Number.isFinite(s.amount) && s.amount > 0);
  if (usable.length === 0) {
    return {
      amount: round(constant),
      segmentAmount: 0,
      startAt: null,
      endAt: null,
      ids: [],
      curve: constant > 0 ? [{ startAt: null, endAt: null, amount: round(constant) }] : [],
    };
  }

  // 断点：所有起止时刻；占用量只可能在这些点之间发生变化
  const points = new Set<number>();
  for (const s of usable) {
    const start = s.startAt?.getTime();
    const end = s.endAt?.getTime();
    if (start !== undefined && Number.isFinite(start)) points.add(start);
    if (end !== undefined && Number.isFinite(end)) points.add(end);
  }
  const sorted = [...points].sort((a, b) => a - b);
  const bounds: number[] = [NEG_INF, ...sorted, POS_INF];

  let best = -Infinity;
  let bestIndex = 0;
  let bestIds: number[] = [];
  let bestSegmentAmount = 0;
  const rawCurve: { startAt: Date | null; endAt: Date | null; amount: number }[] = [];

  for (let i = 0; i < bounds.length - 1; i += 1) {
    const lo = bounds[i]!;
    const hi = bounds[i + 1]!;
    const mid = midpoint(lo, hi);
    let sum = 0;
    const ids: number[] = [];
    for (const s of usable) {
      const start = s.startAt?.getTime() ?? NEG_INF;
      const end = s.endAt?.getTime() ?? POS_INF;
      // 区间按闭区间处理：mid 取自断点之间，不会与端点重合
      if (start <= mid && mid <= end) {
        sum += s.amount;
        ids.push(s.id);
      }
    }
    const amount = round(sum + constant);
    rawCurve.push({
      startAt: lo === NEG_INF ? null : new Date(lo),
      endAt: hi === POS_INF ? null : new Date(hi),
      amount,
    });
    if (amount > best) {
      best = amount;
      bestIndex = i;
      bestIds = ids;
      bestSegmentAmount = round(sum);
    }
  }

  const startAt = bounds[bestIndex] === NEG_INF ? null : new Date(bounds[bestIndex]!);
  const endAt = bounds[bestIndex + 1] === POS_INF ? null : new Date(bounds[bestIndex + 1]!);

  return {
    amount: round(best),
    segmentAmount: bestSegmentAmount,
    startAt,
    endAt,
    ids: bestIds,
    curve: mergeCurve(rawCurve),
  };
}

/** 取区间内的代表时刻：避开端点，保证「刚结束」与「刚开始」不会同时计入 */
function midpoint(lo: number, hi: number): number {
  if (lo === NEG_INF && hi === POS_INF) return 0;
  if (lo === NEG_INF) return hi - 1;
  if (hi === POS_INF) return lo + 1;
  return (lo + hi) / 2;
}

/** 合并相邻且占用量相同的区间，让曲线更紧凑 */
function mergeCurve(
  curve: { startAt: Date | null; endAt: Date | null; amount: number }[],
): { startAt: Date | null; endAt: Date | null; amount: number }[] {
  const out: { startAt: Date | null; endAt: Date | null; amount: number }[] = [];
  for (const seg of curve) {
    const last = out[out.length - 1];
    if (last && last.amount === seg.amount) last.endAt = seg.endAt;
    else out.push({ ...seg });
  }
  return out;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 在给定时间段内的峰值占用：用于判断「新占用 + 已有占用」是否超容量。
 * 已有记录会先裁剪到 [from, to] 区间，与该区间无交集的记录不计入。
 */
export function peakWithin(
  segments: CapacitySegment[],
  from: Date | null,
  to: Date | null,
  constant = 0,
): CapacityPeak {
  const fromMs = from?.getTime();
  const toMs = to?.getTime();
  const clipped = segments
    .map((s) => {
      const start = s.startAt?.getTime();
      const end = s.endAt?.getTime();
      const clippedStart = Math.max(start ?? NEG_INF, fromMs ?? NEG_INF);
      const clippedEnd = Math.min(end ?? POS_INF, toMs ?? POS_INF);
      return { ...s, clippedStart, clippedEnd };
    })
    .filter((s) => s.clippedStart <= s.clippedEnd)
    .map((s) => ({
      id: s.id,
      amount: s.amount,
      startAt: s.clippedStart === NEG_INF ? null : new Date(s.clippedStart),
      endAt: s.clippedEnd === POS_INF ? null : new Date(s.clippedEnd),
    }));
  return peakOf(clipped, constant);
}
