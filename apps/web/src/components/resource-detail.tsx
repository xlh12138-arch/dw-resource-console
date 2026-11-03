import { useQuery } from '@tanstack/react-query';
import { CalendarClock, ChevronRight, FileClock, GitBranch, Link2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  RESOURCE_STATUS_LABELS,
  SLOT_OCCUPANCY_STATE_LABELS,
  SLOT_OCCUPANCY_STATE_TONES,
  type ResourceDetail,
  type ResourceDto,
} from '@dw/shared';
import { useDict } from '../lib/dict';
import { resourcesApi } from '../lib/endpoints';
import { Badge, ClickableBadge, EmptyState, Modal, Spinner, Td, Th, Table } from './ui';
import { TimelineChart, toneOfState } from './timeline';
import { EnvBadge } from './env-badge';

function fmtTime(value: string | null): string {
  if (!value) return '长期';
  return new Date(value).toLocaleDateString('zh-CN');
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function ResourceDetailModal({
  resource,
  onClose,
  onEdit,
}: {
  resource: ResourceDto | null;
  onClose: () => void;
  onEdit: (r: ResourceDto) => void;
}) {
  const dict = useDict();
  const navigate = useNavigate();
  // 支持从子资源回到父资源 / 下钻子资源：以 id 驱动，详情接口返回完整 DTO
  const [currentId, setCurrentId] = useState<number | null>(resource?.id ?? null);

  useEffect(() => {
    setCurrentId(resource?.id ?? null);
  }, [resource?.id]);

  const audit = useQuery({
    queryKey: ['resource-audit', currentId],
    queryFn: () => resourcesApi.audit(currentId!),
    enabled: currentId !== null,
  });
  // 详情接口补充容量明细、「被哪些项目 / 环境引用」、父子层级
  const detail = useQuery({
    queryKey: ['resource', currentId],
    queryFn: () => resourcesApi.get(currentId!),
    enabled: currentId !== null,
  });
  const timeline = useQuery({
    queryKey: ['resource-timeline', currentId],
    queryFn: () => resourcesApi.timeline(currentId!),
    enabled: currentId !== null,
  });

  if (!resource || currentId === null) return null;

  const d: ResourceDetail | undefined = detail.data;
  // 下钻后以详情返回的 DTO 为准，未加载完时先用列表里传进来的快照
  const r: ResourceDto = d ?? resource;
  const columns = dict.typeColumns(r.type).filter((k: string) => k in r.attrs);
  const otherAttrs = Object.entries(r.attrs).filter(([k]) => !columns.includes(k));
  const capacity = d?.capacity ?? null;
  /** 按时间段核算的峰值占用（不重叠不累加、重叠求和） */
  const peak = capacity?.peak ?? null;
  const references = d?.references ?? [];
  const children = d?.children ?? [];
  const ancestors = d?.ancestors ?? [];
  const tl = timeline.data;
  const expiredRefs = references.filter((ref) => ref.overdueDays > 0);

  const jumpToResources = (params: Record<string, string>) => {
    const search = new URLSearchParams(params).toString();
    onClose();
    navigate(`/resources?${search}`);
  };

  return (
    <Modal
      open
      width="max-w-4xl"
      title={`${r.code} · ${r.name}`}
      desc={`${dict.typeLabel(r.type)} · 创建人 ${r.createdBy ?? '—'}`}
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={() => onEdit(r)}
          className="inline-flex h-9 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
        >
          编辑资源
        </button>
      }
    >
      <div className="space-y-5">
        {/* 父资源面包屑：从子资源可逐级回到顶层 */}
        {ancestors.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <GitBranch size={13} className="text-slate-400" />
            {ancestors.map((a) => (
              <span key={a.id} className="flex items-center gap-1">
                <button
                  type="button"
                  className="font-medium text-brand-700 hover:underline"
                  onClick={() => setCurrentId(a.id)}
                >
                  {a.code} · {a.name}
                </button>
                <ChevronRight size={12} className="text-slate-400" />
              </span>
            ))}
            <span className="font-semibold text-slate-800">{r.code}</span>
            <span className="ml-1 rounded bg-white px-1.5 py-0.5 text-[10px] text-slate-500 ring-1 ring-slate-200">
              子资源 · 申请 {r.demandAmount ?? '—'}
              {r.capacityUnit ? ` ${r.capacityUnit}` : ''}
            </span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="blue">{dict.typeLabel(r.type)}</Badge>
          <EnvBadge code={r.environment} label={dict.envLabel(r.environment)} />
          <Badge
            tone={
              r.status === 'IN_USE'
                ? 'green'
                : r.status === 'MAINTAINING'
                  ? 'amber'
                  : r.status === 'RETIRED'
                    ? 'red'
                    : 'gray'
            }
          >
            {RESOURCE_STATUS_LABELS[r.status]}
          </Badge>
          {r.parentCode && (
            <ClickableBadge
              tone="amber"
              title="查看父资源"
              onClick={() => r.parentId !== null && setCurrentId(r.parentId)}
            >
              ↑ 父资源 {r.parentCode}
            </ClickableBadge>
          )}
          {r.tags.map((t) => (
            <ClickableBadge
              key={t}
              tone="violet"
              title={`在资源台账中按标签 #${t} 筛选`}
              onClick={() => jumpToResources({ tag: t })}
            >
              #{t}
            </ClickableBadge>
          ))}
        </div>

        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
          {[
            ['所属项目', r.projectName],
            ['项目环境', r.projectEnvName],
            ['机房 / 可用区', r.datacenter],
            ['负责人', r.owner],
            ['创建时间', new Date(r.createdAt).toLocaleString('zh-CN')],
            ['更新时间', new Date(r.updatedAt).toLocaleString('zh-CN')],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <dt className="text-xs text-slate-500">{label}</dt>
              <dd className="mt-0.5 text-sm text-slate-800">
                {label === '所属项目' && r.projectId !== null ? (
                  <button
                    type="button"
                    className="text-brand-700 hover:underline"
                    onClick={() => {
                      onClose();
                      navigate(`/projects/${r.projectId}`);
                    }}
                  >
                    {value}
                  </button>
                ) : (
                  (value ?? '—')
                )}
              </dd>
            </div>
          ))}
          <div className="sm:col-span-3">
            <dt className="text-xs text-slate-500">备注</dt>
            <dd className="mt-0.5 text-sm text-slate-800">{r.remark ?? '—'}</dd>
          </div>
        </dl>

        {/* 容量明细：总容量 / 已占用（槽位 + 子资源）/ 剩余 */}
        <div>
          <p className="mb-2 text-xs font-semibold text-slate-700">容量</p>
          {detail.isLoading ? (
            <div className="py-3 text-center">
              <Spinner />
            </div>
          ) : capacity ? (
            <div className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-baseline gap-2 text-sm">
                <span className="font-semibold text-slate-900">
                  {peak ? peak.amount : capacity.allocated} / {capacity.total}
                  {capacity.unit ? ` ${capacity.unit}` : ''}
                </span>
                <span className="text-xs text-slate-500">
                  {peak ? '峰值占用' : '已占用'} {peak ? peak.amount : capacity.allocated} · 剩余{' '}
                  {peak ? capacity.peakAvailable : capacity.available}
                  {capacity.unit ? ` ${capacity.unit}` : ''}
                  {capacity.usage !== null ? ` · 占用率 ${capacity.usage}%` : ''}
                </span>
              </div>

              {/* 按时间段核算：不重叠的占用不累加，重叠的求和，取时间轴峰值 */}
              {peak ? (
                <div className="mt-2 rounded-lg bg-slate-50 px-2.5 py-2">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-700">
                    <CalendarClock size={12} className="text-slate-400" />
                    <span className="font-medium">按时间段峰值</span>
                    <span className="text-slate-500">
                      {fmtTime(peak.startAt)} → {fmtTime(peak.endAt)}
                    </span>
                    <Badge tone="violet">{peak.slotCount} 处占用同时生效</Badge>
                    {capacity.peakAvailable !== null && (
                      <span className="text-slate-500">
                        峰值剩余 {capacity.peakAvailable}
                        {capacity.unit ? ` ${capacity.unit}` : ''}
                      </span>
                    )}
                  </div>
                  {capacity.allocated > peak.amount + 0.01 ? (
                    <p className="mt-1 text-[11px] text-slate-500">
                      不分时段合计 {capacity.allocated}
                      {capacity.unit ? ` ${capacity.unit}` : ''}（超出总容量{' '}
                      {round2(capacity.allocated - (capacity.total ?? 0))}
                      {capacity.unit ? ` ${capacity.unit}` : ''}
                      ）：这些占用分布在不同时间段，容量被错峰复用，因此按峰值核算并不冲突。
                    </p>
                  ) : null}
                  {peak.items.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {peak.items.map((it) => (
                        <li key={it.slotId} className="text-[11px] text-slate-600">
                          {it.projectName ?? '未归属项目'} · {it.envName} · {it.slotRole}：
                          {it.amount ?? '—'}
                          {capacity.unit ? ` ${capacity.unit}` : ''}
                          <span className="ml-1 text-slate-400">
                            （{fmtTime(it.startAt)} → {fmtTime(it.endAt)}）
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}

              {/* 双色进度条：直接占用（槽位）+ 子资源申请 */}
              <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full bg-brand-500"
                  style={{ width: `${Math.min(100, capacity.total ? (capacity.slotAllocated / capacity.total) * 100 : 0)}%` }}
                  title={`槽位占用 ${capacity.slotAllocated}`}
                />
                <div
                  className="h-full bg-violet-500"
                  style={{ width: `${Math.min(100, capacity.total ? (capacity.childAllocated / capacity.total) * 100 : 0)}%` }}
                  title={`子资源申请 ${capacity.childAllocated}`}
                />
              </div>
              <p className="mt-1.5 flex flex-wrap gap-3 text-[11px] text-slate-500">
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-sm bg-brand-500" />
                  槽位占用 {capacity.slotAllocated}
                  {capacity.unit ? ` ${capacity.unit}` : ''}
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-sm bg-violet-500" />
                  子资源申请 {capacity.childAllocated}
                  {capacity.unit ? ` ${capacity.unit}` : ''}
                </span>
                <span className="text-slate-400">（合计口径，未按时间段拆分）</span>
              </p>
              {capacity.remark && <p className="mt-2 text-xs text-slate-500">说明：{capacity.remark}</p>}
              {(d?.capacityByProject ?? []).length > 0 && (
                <ul className="mt-2 space-y-1">
                  {(d?.capacityByProject ?? []).map((p) => (
                    <li key={String(p.projectId ?? 'none')} className="text-xs text-slate-600">
                      {p.projectName ?? '未归属项目'}：{p.envCount} 套环境 / {p.slotCount} 个槽位，占用{' '}
                      {p.amount}
                      {capacity.unit ? ` ${capacity.unit}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-400">该资源未设置容量，不参与容量核算</p>
          )}
        </div>

        {/* 子资源：展示各自申请的容量与当前占用，可点击下钻 */}
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
            <GitBranch size={13} />
            子资源
            {children.length > 0 && <Badge tone="violet">{children.length} 个</Badge>}
          </p>
          {children.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-xs text-slate-400">
              暂无子资源。新增资源时选择「父资源」，即可创建子资源并向本资源申请容量。
            </p>
          ) : (
            <Table
              head={
                <tr>
                  <Th>子资源</Th>
                  <Th>环境</Th>
                  <Th>申请容量</Th>
                  <Th>自身已占用</Th>
                  <Th>下级</Th>
                  <Th>状态</Th>
                </tr>
              }
            >
              {children.map((c) => (
                <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setCurrentId(c.id)}>
                  <Td>
                    <span className="font-medium text-brand-700">{c.code}</span>
                    <span className="ml-1.5 text-slate-600">{c.name}</span>
                  </Td>
                  <Td>
                    <Badge tone="gray">{c.environmentLabel}</Badge>
                  </Td>
                  <Td>
                    {c.demandAmount ?? '—'}
                    {r.capacityUnit ? ` ${r.capacityUnit}` : ''}
                  </Td>
                  <Td>
                    {c.capacityAllocated} / {c.capacityTotal ?? '—'}
                  </Td>
                  <Td className="text-xs text-slate-500">
                    {c.childCount} 个子资源 · {c.slotRefCount} 处引用
                  </Td>
                  <Td>
                    <Badge tone={c.status === 'IN_USE' ? 'green' : c.status === 'RETIRED' ? 'red' : 'gray'}>
                      {RESOURCE_STATUS_LABELS[c.status]}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </div>

        {/* 占用时间轴：按时间段展示占用与共用情况 */}
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
            <CalendarClock size={13} />
            占用时间轴
            {tl && tl.expiredCount > 0 && <Badge tone="red">{tl.expiredCount} 处已超期</Badge>}
            {tl && tl.overlaps.length > 0 && <Badge tone="violet">{tl.overlaps.length} 组时间重叠</Badge>}
          </p>
          {timeline.isLoading ? (
            <div className="py-3 text-center">
              <Spinner />
            </div>
          ) : !tl || tl.entries.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-xs text-slate-400">
              暂无占用记录，被项目环境槽位引用后会在此按时间段展示。
            </p>
          ) : (
            <>
              <TimelineChart
                range={tl.range}
                capacityUnit={r.capacityUnit}
                bars={tl.entries.map((e) => ({
                  id: e.slotId,
                  label: `${e.projectName ?? '未归属项目'} · ${e.slotRole}`,
                  startAt: e.startAt,
                  endAt: e.endAt,
                  tone: e.shared ? 'violet' : toneOfState(e.occupancyState),
                  shared: e.shared,
                  // 悬浮要能一眼看出「哪个项目 / 哪套环境 / 哪个槽位 / 占用多少 / 什么时段」
                  tip: [
                    e.projectName ?? '未归属项目',
                    e.envName,
                    `槽位「${e.slotRole}」`,
                    e.amount !== null
                      ? `占用 ${e.amount}${r.capacityUnit ? ` ${r.capacityUnit}` : ''}`
                      : null,
                    `${fmtTime(e.startAt)} → ${fmtTime(e.endAt)}`,
                    e.notStarted ? '尚未开始（容量已占用）' : null,
                    e.overdueDays > 0 ? `已超期 ${e.overdueDays} 天` : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                }))}
              />
              {tl.overlaps.length > 0 && (
                <p className="mt-1.5 text-[11px] text-violet-600">
                  存在同一时间段被多处占用的记录（共用），已用紫框标注。
                </p>
              )}
            </>
          )}
        </div>

        {/* 引用明细：被哪些项目 / 项目环境 / 槽位引用，含占用期限与超期提醒 */}
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
            <Link2 size={13} />
            被引用情况
            {references.length > 0 && <Badge tone="violet">{references.length} 处</Badge>}
            {expiredRefs.length > 0 && <Badge tone="red">{expiredRefs.length} 处超期未释放</Badge>}
          </p>
          {detail.isLoading ? (
            <div className="py-3 text-center">
              <Spinner />
            </div>
          ) : references.length === 0 ? (
            <EmptyState title="暂无引用" desc="该资源尚未被任何项目环境的槽位引用" />
          ) : (
            <Table
              head={
                <tr>
                  <Th>项目</Th>
                  <Th>项目环境</Th>
                  <Th>槽位</Th>
                  <Th>占用容量</Th>
                  <Th>占用起止</Th>
                  <Th>状态</Th>
                </tr>
              }
            >
              {references.map((ref) => (
                <tr key={ref.slotId}>
                  <Td>
                    {ref.projectId !== null ? (
                      <button
                        type="button"
                        className="text-brand-700 hover:underline"
                        onClick={() => {
                          onClose();
                          navigate(`/projects/${ref.projectId}`);
                        }}
                      >
                        {ref.projectName ?? '未归属项目'}
                      </button>
                    ) : (
                      '未归属项目'
                    )}
                  </Td>
                  <Td>
                    {ref.envName}
                    <span className="ml-1.5">
                      <EnvBadge code={ref.environment} label={ref.environmentLabel} size="xs" />
                    </span>
                  </Td>
                  <Td>{ref.slotRole}</Td>
                  <Td>{ref.amount ?? '—'}</Td>
                  <Td className="whitespace-nowrap text-xs text-slate-600">
                    {fmtTime(ref.startAt)} → {fmtTime(ref.endAt)}
                    {ref.endAt === null && <span className="ml-1 text-slate-400">（不定期限）</span>}
                    {ref.notStarted && (
                      <span className="ml-1 rounded bg-brand-50 px-1 py-0.5 text-[10px] font-medium text-brand-700">
                        未开始
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={SLOT_OCCUPANCY_STATE_TONES[ref.occupancyState]}>
                      {SLOT_OCCUPANCY_STATE_LABELS[ref.occupancyState]}
                    </Badge>
                    {ref.notStarted && <span className="ml-1 text-[11px] text-brand-700">已预约</span>}
                    {ref.overdueDays > 0 && (
                      <span className="ml-1 text-[11px] font-medium text-rose-600">
                        超期 {ref.overdueDays} 天
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold text-slate-700">资源属性</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {[...columns, ...otherAttrs.map(([k]) => k)].map((key) => (
              <div key={key} className="rounded-lg border border-slate-200 px-3 py-2">
                <p className="text-[11px] text-slate-500">{key}</p>
                <p className="mt-0.5 break-all text-sm text-slate-800">{String(r.attrs[key] ?? '—')}</p>
              </div>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
            <FileClock size={13} />
            变更记录
          </p>
          {audit.isLoading ? (
            <div className="py-4 text-center">
              <Spinner />
            </div>
          ) : (audit.data ?? []).length === 0 ? (
            <EmptyState title="暂无变更记录" />
          ) : (
            <Table
              head={
                <tr>
                  <Th>时间</Th>
                  <Th>操作人</Th>
                  <Th>动作</Th>
                  <Th>变更内容</Th>
                </tr>
              }
            >
              {(audit.data ?? []).map((log, idx) => (
                <tr key={idx}>
                  <Td className="whitespace-nowrap text-xs text-slate-500">
                    {new Date(log.createdAt).toLocaleString('zh-CN')}
                  </Td>
                  <Td>{log.actorName}</Td>
                  <Td>{log.action}</Td>
                  <Td className="text-xs text-slate-600">
                    {Array.isArray(log.changes)
                      ? (log.changes as { field: string; from: unknown; to: unknown }[])
                          .slice(0, 4)
                          .map((c) => `${c.field}: ${String(c.from ?? '空')} → ${String(c.to ?? '空')}`)
                          .join('；')
                      : '—'}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      </div>
    </Modal>
  );
}
