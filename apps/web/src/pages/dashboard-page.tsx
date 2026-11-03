import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Boxes, Clock, FolderTree, HardDrive, RefreshCcw, TrendingUp } from 'lucide-react';
import { RESOURCE_STATUS_LABELS, type ResourceStatus } from '@dw/shared';
import { useNavigate } from 'react-router';
import { useDict } from '../lib/dict';
import { statsApi } from '../lib/endpoints';
import { Card, Badge, CardHeader, ClickableBadge, EmptyState, ErrorBanner, Spinner, Td, Th, Table } from '../components/ui';
import { EnvBadge } from '../components/env-badge';
import { friendlyMessage } from '../lib/api';

function StatCard({
  title,
  value,
  unit,
  desc,
  icon,
  tone,
  onClick,
  hint,
}: {
  title: string;
  value: string | number;
  unit?: string;
  desc?: string;
  icon: React.ReactNode;
  tone: string;
  onClick?: () => void;
  hint?: string;
}) {
  const body = (
    <Card className={`p-5 ${onClick ? 'transition-colors hover:border-brand-300' : ''}`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-slate-500">{title}</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">
            {value}
            {unit && <span className="ml-1 text-sm font-normal text-slate-500">{unit}</span>}
          </p>
          {desc && <p className="mt-1 text-xs text-slate-500">{desc}</p>}
          {hint && <p className="mt-0.5 text-[11px] text-brand-600">{hint}</p>}
        </div>
        <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${tone}`}>{icon}</div>
      </div>
    </Card>
  );
  if (!onClick) return body;
  return (
    <button type="button" onClick={onClick} className="text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400">
      {body}
    </button>
  );
}

function BarList({
  items,
  onPick,
}: {
  items: { label: string; count: number; total: number; tone: string; key?: string | number; hint?: string }[];
  onPick?: (item: { label: string; key?: string | number }) => void;
}) {
  return (
    <ul className="space-y-3 px-5 py-4">
      {items.map((item) => (
        <li key={item.key ?? item.label}>
          <button
            type="button"
            disabled={!onPick}
            onClick={() => onPick?.(item)}
            className={`group w-full text-left ${onPick ? 'cursor-pointer' : 'cursor-default'}`}
            title={onPick ? item.hint ?? '点击在资源台账中查看' : undefined}
          >
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className={`text-slate-600 ${onPick ? 'group-hover:text-brand-700' : ''}`}>{item.label}</span>
              <span className="font-medium text-slate-800">{item.count}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full rounded-full ${item.tone} transition-opacity ${onPick ? 'group-hover:opacity-80' : ''}`}
                style={{ width: `${item.total ? Math.round((item.count / item.total) * 100) : 0}%` }}
              />
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function DashboardPage() {
  const dict = useDict();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['stats', 'overview'],
    queryFn: statsApi.overview,
  });

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }
  if (error || !data) {
    return <ErrorBanner message={friendlyMessage(error)} />;
  }

  // 优先展示资源数最多的环境，字典里没有生产环境时自动退化
  const primaryEnv = [...data.byEnvironment].sort((a, b) => b.count - a.count)[0] ?? data.byEnvironment[0];
  const prodCount = primaryEnv?.count ?? 0;
  const inUse = data.byStatus.find((s) => s.status === 'IN_USE')?.count ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">资源概览</h1>
          <p className="text-xs text-slate-500">数据仓库基础设施台账总览 · 最近 7 天新增 {data.createdLast7Days} 条</p>
          {data.ipConflict.count > 0 ? (
            <p className="mt-1 inline-flex items-center gap-1 rounded bg-rose-50 px-2 py-0.5 text-[11px] text-rose-600">
              <AlertTriangle size={11} />
              {data.ipConflict.count} 个 IP 冲突：{data.ipConflict.samples.join('、')}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
        >
          <RefreshCcw size={13} className={isFetching ? 'animate-spin' : ''} />
          刷新
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="资源总数"
          value={data.total}
          desc={`在用 ${inUse} 条 · 父 ${data.hierarchy.parentCount} / 子 ${data.hierarchy.childCount}`}
          icon={<Boxes size={17} className="text-brand-600" />}
          tone="bg-brand-50"
          onClick={() => navigate('/resources')}
          hint="查看全部资源 →"
        />
        <StatCard
          title={`${primaryEnv?.label ?? '主环境'}资源`}
          value={prodCount}
          desc="环境可在字典配置中自定义"
          icon={<TrendingUp size={17} className="text-emerald-600" />}
          tone="bg-emerald-50"
          onClick={primaryEnv ? () => navigate(`/resources?environment=${primaryEnv.environment}`) : undefined}
          hint={primaryEnv ? '按该环境筛选 →' : undefined}
        />
        <StatCard
          title="占用超期"
          value={data.slotPeriod.expiredCount}
          desc={`已占用 ${data.slotPeriod.occupiedCount} · 7 天内到期 ${data.slotPeriod.expiringSoonCount} · 长期 ${data.slotPeriod.longTermCount}`}
          icon={<Clock size={17} className={data.slotPeriod.expiredCount ? 'text-rose-600' : 'text-slate-400'} />}
          tone={data.slotPeriod.expiredCount ? 'bg-rose-50' : 'bg-slate-100'}
          onClick={() => {
            const first = (data.overdueByProject ?? [])[0];
            navigate(first?.projectId ? `/projects/${first.projectId}` : '/projects');
          }}
          hint={data.slotPeriod.expiredCount ? '查看超期明细 →' : undefined}
        />
        <StatCard
          title="NAS 容量使用率"
          value={data.nasCapacity.usageRate}
          unit="%"
          desc={`${Math.round(data.nasCapacity.usedGb)} / ${Math.round(data.nasCapacity.capacityGb)} GB（${data.nasCapacity.count} 套）`}
          icon={<HardDrive size={17} className="text-violet-600" />}
          tone="bg-violet-50"
          onClick={() => navigate('/resources?type=NAS')}
          hint="查看 NAS 资源 →"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="按资源类型分布" desc="点击任意类型在台账中筛选" />
          <BarList
            items={data.byType.map((t) => ({
              key: t.type,
              label: dict.typeLabel(t.type),
              count: t.count,
              total: data.total,
              tone: 'bg-brand-500',
            }))}
            onPick={(item) => navigate(`/resources?type=${item.key}`)}
          />
        </Card>
        <Card>
          <CardHeader title="按环境分布" desc="环境可在字典配置中维护" />
          <BarList
            items={data.byEnvironment.map((e) => ({
              key: e.environment,
              label: dict.envLabel(e.environment),
              count: e.count,
              total: data.total,
              tone: e.environment === primaryEnv?.environment ? 'bg-emerald-500' : 'bg-slate-400',
            }))}
            onPick={(item) => navigate(`/resources?environment=${item.key}`)}
          />
        </Card>
        <Card>
          <CardHeader title="按状态分布" desc="资源生命周期状态" />
          <BarList
            items={data.byStatus.map((s) => ({
              key: s.status,
              label: RESOURCE_STATUS_LABELS[s.status as ResourceStatus],
              count: s.count,
              total: data.total,
              tone:
                s.status === 'IN_USE'
                  ? 'bg-emerald-500'
                  : s.status === 'MAINTAINING'
                    ? 'bg-amber-500'
                    : 'bg-slate-400',
            }))}
            onPick={(item) => navigate(`/resources?status=${item.key}`)}
          />
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="按项目分布"
            desc={`共 ${data.projectSummary?.projectCount ?? 0} 个项目 · ${data.projectSummary?.envCount ?? 0} 套环境 · ${data.projectSummary?.templateCount ?? 0} 个模板`}
          />
          {(data.byProject ?? []).length === 0 ? (
            <EmptyState title="还没有项目" desc="在「需求项目」中创建项目并为其建立环境" />
          ) : (
            <BarList
              items={(data.byProject ?? []).map((p) => ({
                key: p.projectId ?? 'none',
                label: p.name,
                count: p.count,
                total: data.total,
                tone: p.projectId === null ? 'bg-slate-400' : 'bg-violet-500',
              }))}
              onPick={(item) =>
                navigate(item.key === 'none' ? '/resources?unassigned=true' : `/resources?projectId=${item.key}`)
              }
            />
          )}
        </Card>
        <Card>
          <CardHeader title="资源标签" desc="点击标签在台账中按标签筛选" />
          {(data.byTag ?? []).length === 0 ? (
            <EmptyState title="还没有标签" desc="在资源表单里为资源添加标签" />
          ) : (
            <div className="flex flex-wrap gap-1.5 px-5 py-4">
              {(data.byTag ?? []).map((t) => (
                <ClickableBadge
                  key={t.tag}
                  tone="violet"
                  title={`按标签 #${t.tag} 筛选`}
                  onClick={() => navigate(`/resources?tag=${encodeURIComponent(t.tag)}`)}
                >
                  #{t.tag}
                  <span className="ml-1 text-[10px] text-violet-500">{t.count}</span>
                </ClickableBadge>
              ))}
            </div>
          )}
          <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
            <p className="flex items-center gap-1.5">
              <FolderTree size={12} />
              顶层资源 {data.hierarchy.rootCount} 个 · 子资源 {data.hierarchy.childCount} 个
            </p>
            <button
              type="button"
              onClick={() => navigate('/resources?rootOnly=true')}
              className="mt-1 text-brand-600 hover:underline"
            >
              只看顶层资源 →
            </button>
          </div>
        </Card>
      </div>

      {/* 超期占用统一视图：按项目归集「哪些项目的哪些资源超期」，可直接跳去处理 */}
      <Card>
        <CardHeader
          title="超期占用资源"
          desc={
            (data.overdueSlots?.length ?? 0) === 0
              ? '当前没有超过占用结束时间仍未释放的资源'
              : `共 ${data.overdueSlots.length} 个槽位已超过占用结束时间仍未释放，容量持续被占用`
          }
          action={
            (data.overdueSlots?.length ?? 0) > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700 ring-1 ring-inset ring-rose-200">
                <AlertTriangle size={11} />
                超期不会自动释放
              </span>
            ) : undefined
          }
        />
        {(data.overdueByProject ?? []).length === 0 ? (
          <EmptyState title="没有超期占用" desc="资源占用到期后仍保留，如需长期占用请在环境槽位里续期或转为长期" />
        ) : (
          <div className="divide-y divide-slate-100">
            {data.overdueByProject.map((group) => (
              <div key={group.projectId ?? 'none'} className="px-5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    className="text-sm font-medium text-slate-800 hover:text-brand-700"
                    title="打开该项目处理超期占用"
                    onClick={() => navigate(group.projectId ? `/projects/${group.projectId}` : '/projects')}
                  >
                    {group.projectName ?? '未归属项目'}
                  </button>
                  <span className="text-xs font-medium text-rose-600">
                    {group.count} 个槽位超期 · 最长 {group.maxOverdueDays} 天
                  </span>
                </div>
                <ul className="mt-2 space-y-1.5">
                  {group.items.map((item) => (
                    <li key={item.slotId} className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                      <button
                        type="button"
                        className="font-mono text-slate-500 hover:text-brand-700"
                        title="在资源台账中查看该资源"
                        onClick={() => navigate(`/resources?id=${item.resourceId}`)}
                      >
                        {item.resourceCode}
                      </button>
                      <span className="text-slate-700">{item.resourceName}</span>
                      <Badge tone="gray">{item.resourceTypeLabel}</Badge>
                      <EnvBadge code={item.environment} label={item.environmentLabel} />
                      <span>
                        {item.envName} · 槽位「{item.slotRole}」
                      </span>
                      <span className="text-slate-400">
                        {new Date(item.endAt).toLocaleDateString('zh-CN')} 到期
                      </span>
                      <span className="font-medium text-rose-600">超期 {item.overdueDays} 天</span>
                      {group.projectId ? (
                        <button
                          type="button"
                          className="ml-auto text-brand-600 hover:underline"
                          onClick={() => navigate(`/projects/${group.projectId}`)}
                        >
                          去处理 →
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="最近更新" desc="按更新时间倒序展示最近 5 条变更" />
        {data.recentUpdated.length === 0 ? (
          <EmptyState title="暂无资源" desc="前往资源台账新增第一条资源记录" />
        ) : (
          <Table
            head={
              <tr>
                <Th>编码</Th>
                <Th>名称</Th>
                <Th>类型</Th>
                <Th>环境</Th>
                <Th>状态</Th>
                <Th>负责人</Th>
                <Th>更新时间</Th>
              </tr>
            }
          >
            {data.recentUpdated.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <Td className="font-mono text-xs">{r.code}</Td>
                <Td className="font-medium">
                  <button
                    type="button"
                    className="text-left text-slate-900 hover:text-brand-700"
                    onClick={() => navigate(`/resources?q=${encodeURIComponent(r.code)}`)}
                    title="在资源台账中按编码筛选"
                  >
                    {r.name}
                  </button>
                </Td>
                <Td>{dict.typeLabel(r.type)}</Td>
                <Td>
                  <EnvBadge code={r.environment} label={dict.envLabel(r.environment)} />
                </Td>
                <Td>{RESOURCE_STATUS_LABELS[r.status]}</Td>
                <Td>{r.owner ?? '—'}</Td>
                <Td className="text-xs text-slate-500">{new Date(r.updatedAt).toLocaleString('zh-CN')}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
