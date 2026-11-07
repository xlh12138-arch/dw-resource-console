import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowUpRight,
  Boxes,
  Clock3,
  FolderTree,
  RefreshCcw,
  Server,
  Tags,
} from 'lucide-react';
import { RESOURCE_STATUS_LABELS } from '@dw/shared';
import { useNavigate } from 'react-router';
import { useDict } from '../lib/dict';
import { statsApi } from '../lib/endpoints';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBanner, PageHeader, Spinner, Table, Td, Th, cn } from '../components/ui';
import { EnvBadge } from '../components/env-badge';
import { friendlyMessage } from '../lib/api';

function MetricTile({
  label,
  value,
  detail,
  icon,
  dark = false,
  onClick,
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: React.ReactNode;
  dark?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      <div className="flex items-start justify-between gap-4">
        <p className={cn('text-[13px] font-medium', dark ? 'text-white/60' : 'text-slate-500')}>{label}</p>
        <span
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-[8px] border',
            dark ? 'border-white/15 bg-white/[0.06] text-signal-400' : 'border-slate-200 bg-slate-50 text-brand-600',
          )}
        >
          {icon}
        </span>
      </div>
      <div className="mt-6">
        <p className={cn('metric-figure text-[46px] font-medium leading-none', dark ? 'text-white' : 'text-slate-900')}>
          {value}
        </p>
        <p className={cn('mt-3 text-xs leading-relaxed', dark ? 'text-white/50' : 'text-slate-500')}>{detail}</p>
      </div>
      {onClick ? (
        <span className={cn('mt-5 inline-flex items-center gap-1 text-xs font-medium', dark ? 'text-signal-400' : 'text-brand-600')}>
          查看明细
          <ArrowUpRight size={13} />
        </span>
      ) : null}
    </>
  );

  const className = cn(
    'flex min-h-[196px] flex-col rounded-[12px] border p-5 text-left',
    dark ? 'console-grid border-brand-600 bg-brand-600' : 'border-slate-200 bg-white',
    onClick && 'group transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-brand-500',
  );

  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(className, 'focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-400 focus-visible:ring-offset-2')}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

function DistributionList({
  items,
  onPick,
}: {
  items: { label: string; count: number; total: number; key?: string | number; hint?: string }[];
  onPick?: (item: { label: string; key?: string | number }) => void;
}) {
  return (
    <ul className="divide-y divide-slate-200 px-5">
      {items.map((item, index) => (
        <li key={item.key ?? item.label}>
          <button
            type="button"
            disabled={!onPick}
            onClick={() => onPick?.(item)}
            className={cn(
              'group w-full py-3.5 text-left',
              onPick ? 'cursor-pointer' : 'cursor-default',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-signal-400',
            )}
            title={onPick ? item.hint ?? '在资源台账中查看' : undefined}
          >
            <div className="mb-2 flex items-center justify-between gap-3 text-[13px]">
              <span className={cn('truncate text-slate-600', onPick && 'group-hover:text-brand-600')}>{item.label}</span>
              <span className="font-mono text-xs tabular-nums text-slate-800">{item.count}</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-slate-100">
              <div
                className={cn('h-full transition-[width,background-color]', index === 0 ? 'bg-signal-500' : 'bg-brand-500')}
                style={{ width: `${item.total ? Math.max(3, Math.round((item.count / item.total) * 100)) : 0}%` }}
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

  const primaryEnv = [...data.byEnvironment].sort((a, b) => b.count - a.count)[0] ?? data.byEnvironment[0];
  const prodCount = primaryEnv?.count ?? 0;
  const inUse = data.byStatus.find((s) => s.status === 'IN_USE')?.count ?? 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="资源概览"
        actions={
          <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCcw size={14} className={isFetching ? 'animate-spin' : ''} />
            刷新数据
          </Button>
        }
      />

      {data.ipConflict.count > 0 ? (
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-[6px] border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700 hover:bg-rose-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
          title="查看冲突的 IP 地址"
        >
          <AlertTriangle size={12} />
          {data.ipConflict.count} 个 IP 冲突：{data.ipConflict.samples.join('、')}
        </button>
      ) : null}

      <section className="grid gap-3 lg:grid-cols-2 xl:grid-cols-[1.35fr_1fr_1fr]" aria-label="核心指标">
        <MetricTile
          dark
          label="资源总数"
          value={data.total}
          detail={`在用 ${inUse} 条 · 顶层 ${data.hierarchy.rootCount} / 子资源 ${data.hierarchy.childCount}`}
          icon={<Boxes size={17} />}
          onClick={() => navigate('/resources')}
        />
        <MetricTile
          label={`${primaryEnv?.label ?? '主环境'}资源`}
          value={prodCount}
          detail="当前资源量最高的环境"
          icon={<Server size={17} />}
          onClick={primaryEnv ? () => navigate(`/resources?environment=${primaryEnv.environment}`) : undefined}
        />
        <MetricTile
          label="占用超期"
          value={data.slotPeriod.expiredCount}
          detail={`已占用 ${data.slotPeriod.occupiedCount} · 7 天内到期 ${data.slotPeriod.expiringSoonCount} · 长期 ${data.slotPeriod.longTermCount}`}
          icon={<Clock3 size={17} />}
          onClick={() => {
            const first = (data.overdueByProject ?? [])[0];
            navigate(first?.projectId ? `/projects/${first.projectId}` : '/projects');
          }}
        />
      </section>

      <section className="grid gap-3 lg:grid-cols-3" aria-label="资源分布">
        <Card>
          <CardHeader title="资源类型" desc="按类型查看当前资源构成" />
          <DistributionList
            items={data.byType.map((t) => ({
              key: t.type,
              label: t.label,
              count: t.count,
              total: data.total,
            }))}
            onPick={(item) => navigate(`/resources?type=${item.key}`)}
          />
        </Card>
        <Card>
          <CardHeader title="运行环境" desc="按环境查看资源分布" />
          <DistributionList
            items={data.byEnvironment.map((e) => ({
              key: e.environment,
              label: e.label,
              count: e.count,
              total: data.total,
            }))}
            onPick={(item) => navigate(`/resources?environment=${item.key}`)}
          />
        </Card>
        <Card>
          <CardHeader title="生命周期" desc="按资源状态查看当前规模" />
          <DistributionList
            items={data.byStatus.map((s) => ({
              key: s.status,
              label: s.label,
              count: s.count,
              total: data.total,
            }))}
            onPick={(item) => navigate(`/resources?status=${item.key}`)}
          />
        </Card>
      </section>

      <section className="grid gap-3 lg:grid-cols-[1.65fr_1fr]" aria-label="项目与标签">
        <Card>
          <CardHeader
            title="项目资源"
            desc={`${data.projectSummary?.projectCount ?? 0} 个项目 · ${data.projectSummary?.envCount ?? 0} 套环境 · ${data.projectSummary?.templateCount ?? 0} 个模板`}
          />
          {(data.byProject ?? []).length === 0 ? (
            <EmptyState title="还没有项目" desc="在需求项目中创建项目并建立环境" />
          ) : (
            <DistributionList
              items={(data.byProject ?? []).map((p) => ({
                key: p.projectId ?? 'none',
                label: p.name,
                count: p.count,
                total: data.total,
              }))}
              onPick={(item) =>
                navigate(item.key === 'none' ? '/resources?unassigned=true' : `/resources?projectId=${item.key}`)
              }
            />
          )}
        </Card>

        <Card className="flex flex-col">
          <CardHeader title="资源标签" desc="按标签继续查看台账" />
          {(data.byTag ?? []).length === 0 ? (
            <EmptyState title="还没有标签" desc="在资源表单中为资源添加标签" />
          ) : (
            <div className="flex flex-wrap content-start gap-2 px-5 py-4">
              {(data.byTag ?? []).map((t) => (
                <button
                  key={t.tag}
                  type="button"
                  title={`按标签 #${t.tag} 筛选`}
                  onClick={() => navigate(`/resources?tag=${encodeURIComponent(t.tag)}`)}
                  className="inline-flex h-8 items-center gap-2 rounded-[6px] border border-slate-200 bg-slate-50 px-2.5 text-xs text-slate-700 transition-colors hover:border-brand-400 hover:bg-signal-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-400"
                >
                  <Tags size={12} />
                  <span>#{t.tag}</span>
                  <span className="font-mono text-[10px] text-slate-400">{t.count}</span>
                </button>
              ))}
            </div>
          )}
          <div className="mt-auto border-t border-slate-200 px-5 py-4 text-xs text-slate-500">
            <p className="flex items-center gap-2">
              <FolderTree size={13} />
              顶层资源 {data.hierarchy.rootCount} 个 · 子资源 {data.hierarchy.childCount} 个
            </p>
            <button
              type="button"
              onClick={() => navigate('/resources?rootOnly=true')}
              className="mt-2 inline-flex items-center gap-1 font-medium text-brand-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-400"
            >
              只看顶层资源
              <ArrowUpRight size={12} />
            </button>
          </div>
        </Card>
      </section>

      <Card>
        <CardHeader
          title="超期占用"
          desc={
            (data.overdueSlots?.length ?? 0) === 0
              ? '当前没有超期占用'
              : `${data.overdueSlots.length} 个槽位已超过占用结束时间`
          }
          action={
            (data.overdueSlots?.length ?? 0) > 0 ? (
              <Badge tone="red">需要处理</Badge>
            ) : undefined
          }
        />
        {(data.overdueByProject ?? []).length === 0 ? (
          <EmptyState title="没有超期占用" desc="到期资源不会自动释放，可在项目中续期或转为长期" />
        ) : (
          <div className="divide-y divide-slate-200">
            {data.overdueByProject.map((group) => (
              <div key={group.projectId ?? 'none'} className="px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    className="text-sm font-medium text-slate-900 hover:text-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-400"
                    title="打开项目处理超期占用"
                    onClick={() => navigate(group.projectId ? `/projects/${group.projectId}` : '/projects')}
                  >
                    {group.projectName ?? '未归属项目'}
                  </button>
                  <span className="font-mono text-[11px] text-rose-600">
                    {group.count} 个槽位超期 · 最长 {group.maxOverdueDays} 天
                  </span>
                </div>
                <ul className="mt-3 space-y-2">
                  {group.items.map((item) => (
                    <li key={item.slotId} className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                      <button
                        type="button"
                        className="font-mono text-brand-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-400"
                        title="在资源台账中查看该资源"
                        onClick={() => navigate(`/resources?id=${item.resourceId}`)}
                      >
                        {item.resourceCode}
                      </button>
                      <span className="text-slate-800">{item.resourceName}</span>
                      <Badge tone="gray">{item.resourceTypeLabel}</Badge>
                      <EnvBadge code={item.environment} label={item.environmentLabel} />
                      <span>{item.envName} · {item.slotRole}</span>
                      <span className="text-slate-400">{new Date(item.endAt).toLocaleDateString('zh-CN')} 到期</span>
                      <span className="font-medium text-rose-600">超期 {item.overdueDays} 天</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="最近更新" desc="按更新时间展示最近 5 条资源" />
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
              <tr key={r.id} className="transition-colors hover:bg-slate-50">
                <Td className="font-mono text-xs text-slate-500">{r.code}</Td>
                <Td className="font-medium">
                  <button
                    type="button"
                    className="text-left text-slate-900 hover:text-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-400"
                    onClick={() => navigate(`/resources?q=${encodeURIComponent(r.code)}`)}
                    title="在资源台账中按编码筛选"
                  >
                    {r.name}
                  </button>
                </Td>
                <Td>{dict.typeLabel(r.type)}</Td>
                <Td><EnvBadge code={r.environment} label={dict.envLabel(r.environment)} /></Td>
                <Td>{RESOURCE_STATUS_LABELS[r.status]}</Td>
                <Td>{r.owner ?? '—'}</Td>
                <Td className="whitespace-nowrap text-xs text-slate-500">{new Date(r.updatedAt).toLocaleString('zh-CN')}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
