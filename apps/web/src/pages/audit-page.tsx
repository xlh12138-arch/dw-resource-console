import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_LABELS,
  AUDIT_TARGET_TYPES,
  AUDIT_TARGET_TYPE_LABELS,
  type AuditAction,
  type AuditTargetType,
} from '@dw/shared';
import { auditApi } from '../lib/endpoints';
import { friendlyMessage } from '../lib/api';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Pagination,
  Select,
  Spinner,
  Td,
  Th,
  Table,
} from '../components/ui';

export function AuditPage() {
  const [filters, setFilters] = useState<{
    action: string;
    actor: string;
    targetType: string;
    page: number;
    pageSize: number;
  }>({ action: '', actor: '', targetType: '', page: 1, pageSize: 20 });

  const query = useQuery({
    queryKey: ['audit-logs', filters],
    queryFn: () =>
      auditApi.list({
        action: filters.action || undefined,
        actor: filters.actor || undefined,
        targetType: filters.targetType || undefined,
        page: filters.page,
        pageSize: filters.pageSize,
      }),
  });

  const patch = (next: Partial<typeof filters>) => setFilters((prev) => ({ ...prev, ...next, page: 1 }));
  const rows = query.data?.items ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">变更审计</h1>
        <p className="text-xs text-slate-500">所有资源与用户的增删改都会留痕，支持按对象与操作人追溯</p>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3 px-5 py-4">
          <div className="w-40">
            <Field label="动作">
              <Select
                value={filters.action ?? ''}
                placeholder="全部"
                options={AUDIT_ACTIONS.map((a) => ({ value: a, label: AUDIT_ACTION_LABELS[a as AuditAction] }))}
                onChange={(e) => patch({ action: e.target.value })}
              />
            </Field>
          </div>
          <div className="w-40">
            <Field label="对象类型">
              <Select
                value={filters.targetType ?? ''}
                placeholder="全部"
                options={AUDIT_TARGET_TYPES.map((t) => ({
                  value: t,
                  label: AUDIT_TARGET_TYPE_LABELS[t as AuditTargetType],
                }))}
                onChange={(e) => patch({ targetType: e.target.value })}
              />
            </Field>
          </div>
          <div className="w-48">
            <Field label="操作人">
              <Input
                value={filters.actor}
                onChange={(e) => patch({ actor: e.target.value })}
                placeholder="按姓名模糊查询"
              />
            </Field>
          </div>
          <Button variant="ghost" onClick={() => setFilters({ action: '', actor: '', targetType: '', page: 1, pageSize: 20 })}>
            重置
          </Button>
        </div>

        {query.isError && (
          <div className="px-5 pb-4">
            <ErrorBanner message={friendlyMessage(query.error)} />
          </div>
        )}

        {query.isLoading ? (
          <div className="flex h-56 items-center justify-center">
            <Spinner className="h-6 w-6" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title="暂无审计记录" />
        ) : (
          <Table
            head={
              <tr>
                <Th>时间</Th>
                <Th>操作人</Th>
                <Th>动作</Th>
                <Th>对象</Th>
                <Th>变更内容</Th>
              </tr>
            }
          >
            {rows.map((log) => (
              <tr key={log.id} className="hover:bg-slate-50">
                <Td className="whitespace-nowrap text-xs text-slate-500">
                  {new Date(log.createdAt).toLocaleString('zh-CN')}
                </Td>
                <Td>{log.actorName}</Td>
                <Td>
                  <Badge
                    tone={
                      log.action === 'CREATE'
                        ? 'green'
                        : log.action === 'DELETE'
                          ? 'red'
                          : log.action === 'UPDATE'
                            ? 'amber'
                            : 'gray'
                    }
                  >
                    {AUDIT_ACTION_LABELS[log.action]}
                  </Badge>
                </Td>
                <Td className="text-xs">
                  <span className="text-slate-400">{AUDIT_TARGET_TYPE_LABELS[log.targetType]} · </span>
                  {log.targetName ?? '—'}
                </Td>
                <Td className="max-w-md text-xs text-slate-600">
                  {log.changes && log.changes.length > 0
                    ? log.changes
                        .slice(0, 3)
                        .map((c) => `${c.label ?? c.field}: ${String(c.from ?? '空')} → ${String(c.to ?? '空')}`)
                        .join('；')
                    : '—'}
                </Td>
              </tr>
            ))}
          </Table>
        )}

        {query.data && (
          <Pagination
            page={query.data.meta.page}
            totalPages={query.data.meta.totalPages}
            total={query.data.meta.total}
            pageSize={query.data.meta.pageSize}
            onChange={(page) => setFilters((prev) => ({ ...prev, page }))}
          />
        )}
      </Card>
    </div>
  );
}
