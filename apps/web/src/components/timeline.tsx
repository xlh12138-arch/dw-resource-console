import type { SlotOccupancyState } from '@dw/shared';

/**
 * 极简甘特图：只依赖绝对定位与百分比，不引入额外图表库。
 * 用于展示资源 / 环境的占用区间、超期情况与并发共用。
 */

export interface TimelineBar {
  id: number;
  label: string;
  sublabel?: string;
  startAt: string;
  endAt: string | null;
  tone: 'green' | 'red' | 'gray' | 'violet' | 'amber';
  /** 与该区间重叠的其他占用（共用） */
  shared?: boolean;
  tip?: string;
}

const TONES: Record<TimelineBar['tone'], string> = {
  green: 'bg-emerald-400/80 ring-emerald-500',
  red: 'bg-rose-400/80 ring-rose-500',
  gray: 'bg-slate-300 ring-slate-400',
  violet: 'bg-signal-400/80 ring-signal-600',
  amber: 'bg-amber-400/80 ring-amber-500',
};

export function toneOfState(state: SlotOccupancyState | null | undefined): TimelineBar['tone'] {
  if (state === 'EXPIRED') return 'red';
  return 'green';
}

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function TimelineChart({
  range,
  bars,
  capacityUnit,
}: {
  range: { from: string; to: string; today: string };
  bars: TimelineBar[];
  capacityUnit?: string | null;
}) {
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  const span = Math.max(1, to - from);
  const today = new Date(range.today).getTime();
  const todayPct = Math.min(100, Math.max(0, ((today - from) / span) * 100));

  // 月份刻度：跨度大时每 2~3 个月标一次，避免拥挤
  const months: { label: string; pct: number }[] = [];
  const cursor = new Date(range.from);
  cursor.setDate(1);
  cursor.setHours(0, 0, 0);
  while (cursor.getTime() <= to) {
    const pct = ((cursor.getTime() - from) / span) * 100;
    if (pct >= 0 && pct <= 100) {
      months.push({ label: `${cursor.getFullYear()}.${String(cursor.getMonth() + 1).padStart(2, '0')}`, pct });
    }
    cursor.setMonth(cursor.getMonth() + (span > 500 * 86400000 ? 3 : 2));
  }

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="mb-2 flex items-center justify-between text-[11px] text-slate-500">
        <span>
          {fmt(new Date(range.from))} → {fmt(new Date(range.to))}
        </span>
        <span className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-emerald-400" />
            占用中
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-rose-400" />
            已超期
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-slate-300" />
            未生效
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm ring-1 ring-signal-600" />
            共用
          </span>
        </span>
      </div>

      <div className="relative">
        {/* 月刻度 */}
        <div className="relative mb-1 h-4">
          {months.map((m) => (
            <span
              key={`${m.label}-${m.pct}`}
              className="absolute -translate-x-1/2 text-[10px] text-slate-400"
              style={{ left: `${m.pct}%` }}
            >
              {m.label}
            </span>
          ))}
        </div>

        <div className="relative space-y-1.5 border-l border-slate-200 pl-0">
          {/* 今天参考线 */}
          <div
            className="pointer-events-none absolute bottom-0 top-0 z-10 w-px border-l border-dashed border-brand-500"
            style={{ left: `${todayPct}%` }}
          >
            <span className="absolute -top-0.5 -translate-x-1/2 rounded bg-brand-600 px-1 text-[9px] text-white">
              今天
            </span>
          </div>

          {bars.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-400">暂无占用记录</p>
          ) : (
            bars.map((bar) => {
              const s = new Date(bar.startAt).getTime();
              const e = bar.endAt ? new Date(bar.endAt).getTime() : Math.min(to, today + 180 * 86400000);
              const left = Math.min(100, Math.max(0, ((s - from) / span) * 100));
              const width = Math.max(0.8, Math.min(100 - left, ((e - s) / span) * 100));
              return (
                <div key={bar.id} className="group relative h-7">
                  <div className="absolute inset-y-0 left-0 right-0 rounded bg-slate-50/60" />
                  <div
                    className={`absolute top-1 h-5 rounded ring-1 ${TONES[bar.tone]} ${
                      bar.shared ? 'ring-signal-600 ring-2' : ''
                    }`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    title={bar.tip}
                  >
                    <span className="block truncate px-1.5 text-[10px] leading-5 text-white/95">
                      {bar.label}
                      {bar.endAt === null ? ' · 长期' : ''}
                      {bar.shared ? ' · 共用' : ''}
                    </span>
                  </div>
                  {bar.sublabel ? (
                    <span className="pointer-events-none absolute -top-3.5 left-0 truncate text-[10px] text-slate-400">
                      {bar.sublabel}
                    </span>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>
      {capacityUnit ? <p className="mt-2 text-[11px] text-slate-400">容量单位：{capacityUnit}</p> : null}
    </div>
  );
}
