import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FIELD_TYPES,
  FIELD_TYPE_LABELS,
  type DictReferences,
  type EnvironmentDto,
  type ResourceTypeDetail,
  type ResourceTypeDto,
} from '@dw/shared';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorBanner, Field, Input, Modal, ModalCancelButton, PageHeader, Select, Spinner, Switch, Table, Td, Th } from '../components/ui';
import { ColorPicker } from '../components/color-picker';
import { EnvBadge } from '../components/env-badge';
import { useToast } from '../components/toast';
import { ApiError, fieldIssues, friendlyMessage, type FieldIssue } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDict } from '../lib/dict';
import { dictApi, type ResourceTypeFieldInput } from '../lib/endpoints';

/* ------------------------------------------------------------------ *
 * 引用明细弹窗：修改 / 删除前明确告知影响了哪些对象
 * ------------------------------------------------------------------ */

function ReferenceList({ references }: { references: DictReferences | null }) {
  if (!references) return null;
  if (references.total === 0) {
    return <p className="text-sm text-slate-500">该字典项当前没有被任何对象引用，可以安全修改或删除。</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-700">
        <span className="font-semibold text-amber-600">{references.label}</span> 已被{' '}
        <span className="font-semibold">{references.total}</span> 个对象引用：
      </p>
      <ul className="space-y-2">
        {references.groups.map((g) => (
          <li key={g.entity} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-slate-700">{g.label}</span>
              <Badge tone="amber">{g.count}</Badge>
            </div>
            {g.samples.length > 0 && (
              <p className="mt-1 truncate text-xs text-slate-500">{g.samples.map((s) => s.name).join('、')}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface ConflictState {
  message: string;
  references: DictReferences | null;
  retry: () => void;
}

/** 409 冲突提示：展示引用明细并提供「一键同步修改」 */
function ConflictModal({ state, onClose }: { state: ConflictState | null; onClose: () => void }) {
  if (!state) return null;
  return (
    <Modal
      open
      width="max-w-lg"
      title="该字典项已被引用"
      desc={state.message}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => { state.retry(); onClose(); }}>
            一键同步修改
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          同步修改会把所有引用对象的类型 / 环境编码一并更新，操作会记入变更审计。
        </div>
        <ReferenceList references={state.references} />
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * 资源类型：字段编辑器
 * ------------------------------------------------------------------ */

interface FieldRow extends ResourceTypeFieldInput {
  uid: string;
}

let uidSeq = 0;
const newField = (): FieldRow => ({
  uid: `f${(uidSeq += 1)}`,
  key: '',
  label: '',
  fieldType: 'TEXT',
  required: false,
  options: [],
  defaultValue: '',
  placeholder: '',
  unit: '',
  isIp: false,
  sortOrder: 0,
});

function fromDetail(detail: ResourceTypeDetail): FieldRow[] {
  return detail.fields.map((f) => ({
    uid: `f${(uidSeq += 1)}`,
    id: f.id,
    key: f.key,
    label: f.label,
    fieldType: f.fieldType,
    required: f.required,
    options: f.options ?? [],
    defaultValue: f.defaultValue ?? '',
    placeholder: f.placeholder ?? '',
    unit: f.unit ?? '',
    isIp: f.isIp,
    sortOrder: f.sortOrder,
  }));
}

function FieldEditor({
  fields,
  onChange,
  listColumns,
  onListColumnsChange,
}: {
  fields: FieldRow[];
  onChange: (next: FieldRow[]) => void;
  listColumns: string[];
  onListColumnsChange: (next: string[]) => void;
}) {
  const patch = (uid: string, key: keyof FieldRow, value: unknown) =>
    onChange(fields.map((f) => (f.uid === uid ? { ...f, [key]: value } : f)));

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-slate-700">属性字段（资源表单按此动态渲染）</p>
        <Button size="sm" variant="outline" onClick={() => onChange([...fields, newField()])}>
          <Plus size={13} /> 新增字段
        </Button>
      </div>

      {fields.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-500">
          尚未配置字段，保存后该类型的资源无需填写专属属性
        </p>
      )}

      <div className="space-y-2">
        {fields.map((f, i) => (
          <div key={f.uid} className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
            <div className="grid gap-2 sm:grid-cols-4">
              <Field label="字段标识" required>
                <Input
                  value={f.key}
                  placeholder="如 mgmtIp"
                  onChange={(e) => patch(f.uid, 'key', e.target.value)}
                />
              </Field>
              <Field label="字段名称" required>
                <Input
                  value={f.label}
                  placeholder="如 管理 IP"
                  onChange={(e) => patch(f.uid, 'label', e.target.value)}
                />
              </Field>
              <Field label="控件类型">
                <Select
                  value={f.fieldType ?? FIELD_TYPES[0]}
                  options={FIELD_TYPES.map((t) => ({ value: t, label: FIELD_TYPE_LABELS[t] }))}
                  onChange={(e) => patch(f.uid, 'fieldType', e.target.value)}
                />
              </Field>
              <Field label="默认值 / 占位 / 单位">
                <div className="flex gap-1">
                  <Input
                    className="w-16"
                    value={f.defaultValue ?? ''}
                    placeholder="默认"
                    onChange={(e) => patch(f.uid, 'defaultValue', e.target.value)}
                  />
                  <Input
                    value={f.placeholder ?? ''}
                    placeholder="占位提示"
                    onChange={(e) => patch(f.uid, 'placeholder', e.target.value)}
                  />
                  <Input
                    className="w-14"
                    value={f.unit ?? ''}
                    placeholder="单位"
                    onChange={(e) => patch(f.uid, 'unit', e.target.value)}
                  />
                </div>
              </Field>
            </div>

            {f.fieldType === 'SELECT' && (
              <div className="mt-2">
                <Field label="下拉选项" hint="格式：值:显示名，多个用英文逗号分隔，如 MASTER:主调度">
                  <Input
                    value={(f.options ?? []).map((o) => `${o.value}:${o.label}`).join(',')}
                    placeholder="MASTER:主调度,AGENT:执行代理"
                    onChange={(e) =>
                      patch(
                        f.uid,
                        'options',
                        e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean)
                          .map((s) => {
                            const [value, label] = s.split(':');
                            return { value: value ?? s, label: label ?? value ?? s };
                          }),
                      )
                    }
                  />
                </Field>
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-4">
              <Switch checked={f.required} label="必填" onChange={(v) => patch(f.uid, 'required', v)} />
              <Switch
                checked={f.isIp}
                label="IP 字段（参与占用检测）"
                onChange={(v) => patch(f.uid, 'isIp', v)}
              />
              <Switch
                checked={listColumns.includes(f.key)}
                disabled={!f.key}
                label="列表关键列"
                hint="在资源台账中展示该属性"
                onChange={(on) =>
                  onListColumnsChange(on ? [...listColumns, f.key] : listColumns.filter((k) => k !== f.key))
                }
              />
              <div className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="上移字段"
                  title="上移字段"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                >
                  <ArrowUp size={13} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="下移字段"
                  title="下移字段"
                  onClick={() => move(i, 1)}
                  disabled={i === fields.length - 1}
                >
                  <ArrowDown size={13} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="删除字段"
                  title="删除字段"
                  onClick={() => onChange(fields.filter((x) => x.uid !== f.uid))}
                >
                  <Trash2 size={13} className="text-rose-500" />
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 资源类型面板
 * ------------------------------------------------------------------ */

export function ResourceTypePanel() {
  const { push } = useToast();
  const queryClient = useQueryClient();
  const dict = useDict();
  const { can: canDo } = useAuth();
  const canWrite = canDo('resource:write');
  const canDelete = canDo('resource:delete');

  const list = useQuery({ queryKey: ['dict', 'resource-types'], queryFn: () => dictApi.types(true) });

  const [editing, setEditing] = useState<ResourceTypeDetail | null>(null);
  const [open, setOpen] = useState(false);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [refTarget, setRefTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ResourceTypeDetail | null>(null);
  const [syncingCodes, setSyncingCodes] = useState<ResourceTypeDto | null>(null);
  const [migrateTo, setMigrateTo] = useState('');
  const [pendingSync, setPendingSync] = useState<{ code: string; count: number } | null>(null);

  const [form, setForm] = useState<{
    code: string;
    label: string;
    prefix: string;
    description: string;
    ipUniqueByPort: boolean;
    enabled: boolean;
    sortOrder: number;
    listColumns: string[];
    fields: FieldRow[];
  }>({
    code: '',
    label: '',
    prefix: '',
    description: '',
    ipUniqueByPort: false,
    enabled: true,
    sortOrder: 0,
    listColumns: [],
    fields: [newField()],
  });
  const [formError, setFormError] = useState('');
  const [formIssues, setFormIssues] = useState<FieldIssue[]>([]);

  const openCreate = () => {
    setEditing(null);
    setForm({
      code: '',
      label: '',
      prefix: '',
      description: '',
      ipUniqueByPort: false,
      enabled: true,
      sortOrder: (list.data?.length ?? 0) + 1,
      listColumns: [],
      fields: [newField()],
    });
    setFormError('');
    setFormIssues([]);
    setOpen(true);
  };

  const openEdit = async (code: string) => {
    const detail = await dictApi.type(code);
    setEditing(detail);
    setForm({
      code: detail.code,
      label: detail.label,
      prefix: detail.prefix,
      description: detail.description ?? '',
      ipUniqueByPort: detail.ipUniqueByPort,
      enabled: detail.enabled,
      sortOrder: detail.sortOrder,
      listColumns: detail.listColumns,
      fields: fromDetail(detail),
    });
    setFormError('');
    setFormIssues([]);
    setOpen(true);
  };

  /** 字段标识改名时记录下来，服务端据此同步存量资源的 attrs */
  const buildKeyRenames = () => {
    const original = new Map((editing?.fields ?? []).map((f) => [f.id, f.key]));
    return form.fields
      .filter((f) => f.id !== undefined && original.has(f.id) && original.get(f.id) !== f.key)
      .map((f) => ({ from: original.get(f.id!)!, to: f.key }));
  };

  const save = useMutation({
    mutationFn: async (sync: boolean) => {
      const payload = {
        ...(editing ? { code: form.code !== editing.code ? form.code : undefined } : { code: form.code }),
        label: form.label,
        prefix: form.prefix,
        description: form.description || undefined,
        ipUniqueByPort: form.ipUniqueByPort,
        enabled: form.enabled,
        sortOrder: form.sortOrder,
        listColumns: form.listColumns,
        fields: form.fields
          .filter((f) => f.key && f.label)
          .map((f, i) => ({
            ...(f.id ? { id: f.id } : {}),
            key: f.key,
            label: f.label,
            fieldType: f.fieldType,
            required: f.required,
            options: f.options ?? [],
            defaultValue: f.defaultValue || undefined,
            placeholder: f.placeholder || undefined,
            unit: f.unit || undefined,
            isIp: f.isIp,
            sortOrder: i,
          })),
        sync,
        keyRenames: buildKeyRenames(),
        dropUnknownFields: false,
      };
      return editing
        ? dictApi.updateType(editing.code, payload)
        : dictApi.createType(payload as Parameters<typeof dictApi.createType>[0]);
    },
    onSuccess: (res) => {
      push(
        'success',
        editing
          ? res.resourceCodeSynced > 0
            ? `资源类型已更新，并同步修改 ${res.resourceCodeSynced} 个资源编码`
            : '资源类型已更新'
          : '资源类型已创建',
      );
      setOpen(false);
      if (res.pendingAttrSync > 0) {
        setPendingSync({ code: res.detail.code, count: res.pendingAttrSync });
      }
      void queryClient.invalidateQueries({ queryKey: ['dict'] });
      dict.refresh();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        const refs = (err.details as { references?: DictReferences } | undefined)?.references ?? null;
        setConflict({
          message: err.message,
          references: refs,
          retry: () => save.mutate(true),
        });
        return;
      }
      setFormError(friendlyMessage(err));
      setFormIssues(fieldIssues(err));
    },
  });

  const remove = useMutation({
    mutationFn: (vars: { code: string; migrateTo?: string }) =>
      dictApi.removeType(vars.code, vars.migrateTo || undefined),
    onSuccess: (res) => {
      push('success', res.total > 0 ? `已删除并迁移 ${res.total} 处引用` : '资源类型已删除');
      setDeleting(null);
      setMigrateTo('');
      void queryClient.invalidateQueries({ queryKey: ['dict'] });
      dict.refresh();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        const refs = (err.details as { references?: DictReferences } | undefined)?.references ?? null;
        if (deleting) {
          setRefTarget(deleting.code);
          void refs;
        }
        push('error', err.message);
        return;
      }
      push('error', friendlyMessage(err));
    },
  });

  const syncResourceCodes = useMutation({
    mutationFn: (type: ResourceTypeDto) => dictApi.syncTypeResourceCodes(type.code),
    onSuccess: (result) => {
      push(
        result.updated > 0 ? 'success' : 'info',
        result.updated > 0
          ? `已将 ${result.updated} 个历史资源编码同步为 ${result.prefix} 前缀`
          : '没有需要同步的自动编码',
      );
      setSyncingCodes(null);
      void queryClient.invalidateQueries({ queryKey: ['resources'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
      void queryClient.invalidateQueries({ queryKey: ['dict'] });
      dict.refresh();
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  const syncAttrs = useMutation({
    mutationFn: (code: string) => dictApi.syncTypeAttrs(code, { dropUnknown: true, keyRenames: [] }),
    onSuccess: (res) => {
      push('success', `已同步 ${res.updated} 条资源的属性字段`);
      setPendingSync(null);
      void queryClient.invalidateQueries({ queryKey: ['dict'] });
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  const references = useQuery({
    queryKey: ['dict', 'type-references', refTarget],
    queryFn: () => dictApi.typeReferences(refTarget!),
    enabled: Boolean(refTarget),
  });

  const moveType = useMutation({
    mutationFn: async ({ code, offset }: { code: string; offset: -1 | 1 }) => {
      const rows = list.data ?? [];
      const from = rows.findIndex((item) => item.code === code);
      const to = from + offset;
      if (from < 0 || to < 0 || to >= rows.length) return;
      const current = rows[from]!;
      const target = rows[to]!;
      await Promise.all([
        dictApi.updateType(current.code, { sortOrder: target.sortOrder }),
        dictApi.updateType(target.code, { sortOrder: current.sortOrder }),
      ]);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dict'] });
      dict.refresh();
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  const otherTypes = useMemo(
    () => (list.data ?? []).filter((t) => t.code !== deleting?.code),
    [list.data, deleting],
  );

  if (list.isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {pendingSync && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <span>
            有 <b>{pendingSync.count}</b> 条资源的属性字段与最新字段定义不一致
          </span>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => syncAttrs.mutate(pendingSync.code)}>
              <RefreshCw size={13} /> 一键同步字段
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPendingSync(null)}>
              稍后处理
            </Button>
          </div>
        </div>
      )}

      <Card>
        <CardHeader
          title="资源类型"
          desc="新增的类型会自动出现在资源表单、模板组合器与统计中"
          action={
            canWrite ? (
              <Button size="sm" onClick={openCreate}>
                <Plus size={14} /> 新增资源类型
              </Button>
            ) : null
          }
        />
        {list.data && list.data.length > 0 ? (
          <Table
            head={
              <tr>
                <Th>类型名称</Th>
                <Th>编码</Th>
                <Th>编码前缀</Th>
                <Th>字段</Th>
                <Th>引用</Th>
                <Th>状态</Th>
                <Th className="text-right">操作</Th>
              </tr>
            }
          >
            {list.data.map((t, index) => (
              <tr key={t.code} className="hover:bg-slate-50">
                <Td className="font-medium">{t.label}</Td>
                <Td className="font-mono text-xs text-slate-500">{t.code}</Td>
                <Td className="font-mono text-xs">{t.prefix}</Td>
                <Td>{t.fieldCount}</Td>
                <Td>
                  {t.referenceCount > 0 ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline"
                      onClick={() => setRefTarget(t.code)}
                    >
                      <Link2 size={12} /> {t.referenceCount}
                    </button>
                  ) : (
                    <span className="text-xs text-slate-400">0</span>
                  )}
                </Td>
                <Td>
                  <Badge tone={t.enabled ? 'green' : 'gray'}>{t.enabled ? '启用' : '停用'}</Badge>
                </Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-1">
                    {canWrite && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="上移"
                          aria-label={`上移资源类型 ${t.label}`}
                          disabled={index === 0 || moveType.isPending}
                          onClick={() => moveType.mutate({ code: t.code, offset: -1 })}
                        >
                          <ArrowUp size={13} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="下移"
                          aria-label={`下移资源类型 ${t.label}`}
                          disabled={index === list.data!.length - 1 || moveType.isPending}
                          onClick={() => moveType.mutate({ code: t.code, offset: 1 })}
                        >
                          <ArrowDown size={13} />
                        </Button>
                      </>
                    )}
                    {canWrite && (
                      <Button
                        variant="ghost"
                        size="sm"
                        title={`同步历史资源编码到 ${t.prefix} 前缀`}
                        aria-label={`同步 ${t.label} 的历史资源编码`}
                        onClick={() => setSyncingCodes(t)}
                      >
                        <RefreshCw size={13} className="text-brand-600" />
                      </Button>
                    )}
                    {canWrite && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`编辑资源类型 ${t.label}`}
                        title={`编辑资源类型 ${t.label}`}
                        onClick={() => void openEdit(t.code)}
                      >
                        <Pencil size={13} />
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`删除资源类型 ${t.label}`}
                        title={`删除资源类型 ${t.label}`}
                        onClick={() => {
                          setDeleting(null);
                          // 换删除对象时清空迁移目标，避免上一次的选择残留成无效值
                          setMigrateTo('');
                          void dictApi.type(t.code).then((d) => setDeleting(d));
                        }}
                      >
                        <Trash2 size={13} className="text-rose-500" />
                      </Button>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title="暂无资源类型" desc="点击右上角新增第一个资源类型" />
        )}
      </Card>

      <Modal
        open={open}
        width="max-w-4xl"
        title={editing ? `编辑资源类型 · ${editing.label}` : '新增资源类型'}
        desc="字段定义保存后，资源表单与 CSV 导入会立即按新定义校验"
        onClose={() => setOpen(false)}
        onSave={() => { setFormError(''); save.mutate(false); }}
        footer={
          <>
            <ModalCancelButton onClick={() => setOpen(false)}>取消</ModalCancelButton>
            <Button onClick={() => { setFormError(''); save.mutate(false); }} disabled={save.isPending}>
              {save.isPending ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {formError && <ErrorBanner message={formError} issues={formIssues} />}
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="类型编码" required hint="改编码会影响已引用对象，保存时会提示同步">
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="GDS_SERVER" />
            </Field>
            <Field label="类型名称" required>
              <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="GDS 服务器" />
            </Field>
            <Field
              label="资源编码前缀"
              required
              hint="用于自动生成 GDS-0001；修改后会同步更新该类型已有资源编码"
            >
              <Input value={form.prefix} onChange={(e) => setForm({ ...form, prefix: e.target.value })} placeholder="GDS" />
            </Field>
            <Field label="排序">
              <Input
                type="number"
                value={form.sortOrder}
                onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="说明">
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="用途说明" />
            </Field>
            <div className="flex items-center gap-6 pt-6">
              <Switch checked={form.enabled} label="启用" onChange={(v) => setForm({ ...form, enabled: v })} />
              <Switch
                checked={form.ipUniqueByPort}
                label="按 IP+端口判重"
                onChange={(v) => setForm({ ...form, ipUniqueByPort: v })}
              />
            </div>
          </div>

          <FieldEditor
            fields={form.fields}
            onChange={(fields) => setForm({ ...form, fields })}
            listColumns={form.listColumns}
            onListColumnsChange={(listColumns) => setForm({ ...form, listColumns })}
          />
        </div>
      </Modal>

      <Modal
        open={Boolean(syncingCodes)}
        width="max-w-lg"
        title="同步历史资源编码"
        desc="用于修复修改前缀前已生成的历史自动编码"
        onClose={() => setSyncingCodes(null)}
        footer={
          <>
            <ModalCancelButton onClick={() => setSyncingCodes(null)}>取消</ModalCancelButton>
            <Button
              disabled={!syncingCodes || syncResourceCodes.isPending}
              onClick={() => syncingCodes && syncResourceCodes.mutate(syncingCodes)}
            >
              <RefreshCw size={14} />
              {syncResourceCodes.isPending ? '同步中…' : '开始同步'}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-slate-700">
          <p>
            资源类型 <span className="font-medium">{syncingCodes?.label}</span> 的当前编码前缀为{' '}
            <span className="font-mono font-medium">{syncingCodes?.prefix}</span>。
          </p>
          <p className="rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2 text-xs text-brand-800">
            系统会把该类型下所有形如 <span className="font-mono">XXX-0001</span> 或{' '}
            <span className="font-mono">XXX_0001</span> 的自动编码统一改为当前前缀，保留分隔符和序号。
            不匹配该格式的自定义编码不会被修改。
          </p>
          <p className="text-xs text-slate-500">同步操作会更新资源更新时间并写入审计日志。</p>
        </div>
      </Modal>

      <ConflictModal state={conflict} onClose={() => setConflict(null)} />

      <Modal
        open={Boolean(refTarget)}
        width="max-w-lg"
        title="引用明细"
        onClose={() => setRefTarget(null)}
        footer={
          <Button variant="outline" onClick={() => setRefTarget(null)}>
            关闭
          </Button>
        }
      >
        {references.isLoading ? (
          <Spinner className="h-5 w-5" />
        ) : (
          <ReferenceList references={references.data ?? null} />
        )}
      </Modal>

      <Modal
        open={Boolean(deleting)}
        width="max-w-lg"
        title={`删除资源类型 · ${deleting?.label ?? ''}`}
        desc="删除前需要把已引用的对象迁移到另一个类型"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button
              onClick={() => remove.mutate({ code: deleting!.code, migrateTo })}
              disabled={remove.isPending || ((deleting?.referenceCount ?? 0) > 0 && !migrateTo)}
            >
              {remove.isPending ? '处理中…' : '确认删除'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {deleting && deleting.referenceCount > 0 ? (
            <>
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                该类型已被 {deleting.referenceCount} 个对象引用，请选择要迁移到的类型，引用会一并更新。
              </div>
              <Field label="迁移到">
                <Select
                  value={migrateTo}
                  placeholder="请选择目标类型"
                  options={otherTypes.map((t) => ({ value: t.code, label: `${t.label}（${t.code}）` }))}
                  onChange={(e) => setMigrateTo(e.target.value)}
                />
              </Field>
            </>
          ) : (
            <p className="text-sm text-slate-600">该类型未被引用，可直接删除。</p>
          )}
        </div>
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 环境面板
 * ------------------------------------------------------------------ */

/** 旧数据没有 color 时，用预设色调对应的十六进制兜底，避免调色板显示与保存值不一致 */
const TONE_HEX_FALLBACK: Record<string, string> = {
  gray: '#475569',
  blue: '#2563eb',
  green: '#16a34a',
  amber: '#d97706',
  red: '#dc2626',
  purple: '#7c3aed',
};

export function EnvironmentPanel() {
  const { push } = useToast();
  const queryClient = useQueryClient();
  const dict = useDict();
  const { can: canDo } = useAuth();
  const canWrite = canDo('resource:write');
  const canDelete = canDo('resource:delete');

  const list = useQuery({ queryKey: ['dict', 'environments'], queryFn: () => dictApi.environments(true) });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<EnvironmentDto | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [refTarget, setRefTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<EnvironmentDto | null>(null);
  const [migrateTo, setMigrateTo] = useState('');
  const [formError, setFormError] = useState('');
  const [formIssues, setFormIssues] = useState<FieldIssue[]>([]);
  const [form, setForm] = useState({ code: '', label: '', tone: 'gray', color: '', description: '', enabled: true, sortOrder: 0 });
  /** 环境改名后，名称仍是旧值的项目环境数量 + 一键同步（带上改名后的环境名称） */
  const [pendingNameSync, setPendingNameSync] = useState<{ code: string; count: number; label: string } | null>(null);

  const openCreate = () => {
    setEditing(null);
    setForm({
      code: '',
      label: '',
      tone: 'gray',
      color: '#64748b',
      description: '',
      enabled: true,
      sortOrder: (list.data?.length ?? 0) + 1,
    });
    setFormError('');
    setFormIssues([]);
    setOpen(true);
  };

  const openEdit = (e: EnvironmentDto) => {
    setEditing(e);
    setForm({
      code: e.code,
      label: e.label,
      tone: e.tone,
      color: e.color ?? TONE_HEX_FALLBACK[e.tone] ?? '#64748b',
      description: e.description ?? '',
      enabled: e.enabled,
      sortOrder: e.sortOrder,
    });
    setFormError('');
    setFormIssues([]);
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: (sync: boolean) => {
      const payload = {
        code: form.code,
        label: form.label,
        tone: form.tone,
        color: form.color || null,
        description: form.description || undefined,
        enabled: form.enabled,
        sortOrder: form.sortOrder,
        sync,
      };
      return editing
        ? dictApi.updateEnvironment(editing.code, payload)
        : dictApi.createEnvironment(payload as Parameters<typeof dictApi.createEnvironment>[0]);
    },
    onSuccess: (res) => {
      push(
        'success',
        res && res.nameSynced > 0
          ? `环境已更新，并同步了 ${res.nameSynced} 个项目环境的名称`
          : editing
            ? '环境已更新'
            : '环境已创建',
      );
      setOpen(false);
      if (res && res.pendingNameSync > 0) {
        setPendingNameSync({ code: res.detail.code, count: res.pendingNameSync, label: res.detail.label });
      }
      void queryClient.invalidateQueries({ queryKey: ['dict'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      dict.refresh();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        const refs = (err.details as { references?: DictReferences } | undefined)?.references ?? null;
        setConflict({ message: err.message, references: refs, retry: () => save.mutate(true) });
        return;
      }
      setFormError(friendlyMessage(err));
      setFormIssues(fieldIssues(err));
    },
  });

  /** 把名称仍是旧值的项目环境一键改名，保证项目里的标签与字典一致 */
  const syncNames = useMutation({
    mutationFn: ({ code, label }: { code: string; label: string }) =>
      dictApi.updateEnvironment(code, { label, syncNames: true }),
    onSuccess: (res) => {
      push('success', res.nameSynced > 0 ? `已同步 ${res.nameSynced} 个项目环境的名称` : '没有需要同步的项目环境');
      setPendingNameSync(null);
      void queryClient.invalidateQueries({ queryKey: ['dict'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      dict.refresh();
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  const remove = useMutation({
    mutationFn: (vars: { code: string; migrateTo?: string }) =>
      dictApi.removeEnvironment(vars.code, vars.migrateTo || undefined),
    onSuccess: (res) => {
      push('success', res.total > 0 ? `已删除并迁移 ${res.total} 处引用` : '环境已删除');
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: ['dict'] });
      dict.refresh();
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  const references = useQuery({
    queryKey: ['dict', 'env-references', refTarget],
    queryFn: () => dictApi.environmentReferences(refTarget!),
    enabled: Boolean(refTarget),
  });

  const moveEnvironment = useMutation({
    mutationFn: async ({ code, offset }: { code: string; offset: -1 | 1 }) => {
      const rows = list.data ?? [];
      const from = rows.findIndex((item) => item.code === code);
      const to = from + offset;
      if (from < 0 || to < 0 || to >= rows.length) return;
      const current = rows[from]!;
      const target = rows[to]!;
      await Promise.all([
        dictApi.updateEnvironment(current.code, { sortOrder: target.sortOrder }),
        dictApi.updateEnvironment(target.code, { sortOrder: current.sortOrder }),
      ]);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dict'] });
      dict.refresh();
    },
    onError: (err) => push('error', friendlyMessage(err)),
  });

  if (list.isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {pendingNameSync ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <span>
            有 <span className="font-medium">{pendingNameSync.count}</span> 个项目环境的名称仍是旧环境名称，项目里的标签与字典不一致。
          </span>
          <Button
            size="sm"
            disabled={syncNames.isPending}
            onClick={() => syncNames.mutate({ code: pendingNameSync.code, label: pendingNameSync.label })}
          >
            <RefreshCw size={13} />
            {syncNames.isPending ? '同步中…' : '一键同步名称'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setPendingNameSync(null)}>
            忽略
          </Button>
        </div>
      ) : null}
      <Card>
        <CardHeader
          title="环境"
          desc="自定义环境后，资源表单、项目环境与统计会立即使用新环境"
          action={
            canWrite ? (
              <Button size="sm" onClick={openCreate}>
                <Plus size={14} /> 新增环境
              </Button>
            ) : null
          }
        />
        {list.data && list.data.length > 0 ? (
          <Table
            head={
              <tr>
                <Th>环境名称</Th>
                <Th>编码</Th>
                <Th>引用</Th>
                <Th>状态</Th>
                <Th className="text-right">操作</Th>
              </tr>
            }
          >
            {list.data.map((e, index) => (
              <tr key={e.code} className="hover:bg-slate-50">
                <Td className="font-medium">{e.label}</Td>
                {/* 标识色直接作为编码的底色，不再单独占一列 */}
                <Td>
                  <EnvBadge code={e.code} label={e.code} className="font-mono" />
                </Td>
                <Td>
                  {e.referenceCount > 0 ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline"
                      onClick={() => setRefTarget(e.code)}
                    >
                      <Link2 size={12} /> {e.referenceCount}
                    </button>
                  ) : (
                    <span className="text-xs text-slate-400">0</span>
                  )}
                </Td>
                <Td>
                  <Badge tone={e.enabled ? 'green' : 'gray'}>{e.enabled ? '启用' : '停用'}</Badge>
                </Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-1">
                    {canWrite && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="上移"
                          aria-label={`上移环境 ${e.label}`}
                          disabled={index === 0 || moveEnvironment.isPending}
                          onClick={() => moveEnvironment.mutate({ code: e.code, offset: -1 })}
                        >
                          <ArrowUp size={13} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="下移"
                          aria-label={`下移环境 ${e.label}`}
                          disabled={index === list.data!.length - 1 || moveEnvironment.isPending}
                          onClick={() => moveEnvironment.mutate({ code: e.code, offset: 1 })}
                        >
                          <ArrowDown size={13} />
                        </Button>
                      </>
                    )}
                    {canWrite && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`编辑环境 ${e.label}`}
                        title={`编辑环境 ${e.label}`}
                        onClick={() => openEdit(e)}
                      >
                        <Pencil size={13} />
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`删除环境 ${e.label}`}
                        title={`删除环境 ${e.label}`}
                        onClick={() => {
                          setMigrateTo('');
                          setDeleting(e);
                        }}
                      >
                        <Trash2 size={13} className="text-rose-500" />
                      </Button>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title="暂无环境" desc="点击右上角新增第一个环境" />
        )}
      </Card>

      <Modal
        open={open}
        width="max-w-xl"
        title={editing ? `编辑环境 · ${editing.label}` : '新增环境'}
        onClose={() => setOpen(false)}
        onSave={() => { setFormError(''); save.mutate(false); }}
        footer={
          <>
            <ModalCancelButton onClick={() => setOpen(false)}>取消</ModalCancelButton>
            <Button onClick={() => { setFormError(''); save.mutate(false); }} disabled={save.isPending}>
              {save.isPending ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {formError && <ErrorBanner message={formError} issues={formIssues} />}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="环境编码" required hint="改编码会影响已引用对象，保存时会提示同步">
              <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="UAT" />
            </Field>
            <Field label="环境名称" required>
              <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="生产环境" />
            </Field>
            <Field label="排序">
              <Input
                type="number"
                value={form.sortOrder}
                onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
              />
            </Field>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
            <ColorPicker
              value={form.color}
              onChange={(hex) => setForm({ ...form, color: hex })}
              hint="用于全站的环境徽标，可点色板或直接输入 RGB"
            />
          </div>
          <Field label="说明">
            <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="如：生产环境，变更需走审批" />
          </Field>
          <Switch checked={form.enabled} label="启用" onChange={(v) => setForm({ ...form, enabled: v })} />
        </div>
      </Modal>

      <ConflictModal state={conflict} onClose={() => setConflict(null)} />

      <Modal
        open={Boolean(refTarget)}
        width="max-w-lg"
        title="引用明细"
        onClose={() => setRefTarget(null)}
        footer={
          <Button variant="outline" onClick={() => setRefTarget(null)}>
            关闭
          </Button>
        }
      >
        {references.isLoading ? <Spinner className="h-5 w-5" /> : <ReferenceList references={references.data ?? null} />}
      </Modal>

      <Modal
        open={Boolean(deleting)}
        width="max-w-lg"
        title={`删除环境 · ${deleting?.label ?? ''}`}
        desc="删除前需要把已引用的对象迁移到另一个环境"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button
              onClick={() => remove.mutate({ code: deleting!.code, migrateTo })}
              disabled={remove.isPending || ((deleting?.referenceCount ?? 0) > 0 && !migrateTo)}
            >
              {remove.isPending ? '处理中…' : '确认删除'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {deleting && deleting.referenceCount > 0 ? (
            <>
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                该环境已被 {deleting.referenceCount} 个对象引用，请选择要迁移到的环境。
              </div>
              <Field label="迁移到">
                <Select
                  value={migrateTo}
                  placeholder="请选择目标环境"
                  options={(list.data ?? [])
                    .filter((e) => e.code !== deleting?.code)
                    .map((e) => ({ value: e.code, label: `${e.label}（${e.code}）` }))}
                  onChange={(e) => setMigrateTo(e.target.value)}
                />
              </Field>
            </>
          ) : (
            <p className="text-sm text-slate-600">该环境未被引用，可直接删除。</p>
          )}
        </div>
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 页面：两个 Tab
 * ------------------------------------------------------------------ */

export function DictPage() {
  const [tab, setTab] = useState<'type' | 'env'>('type');
  const { can: canDo } = useAuth();
  const canWrite = canDo('resource:write');

  return (
    <div className="space-y-5">
      <PageHeader
        title="字典配置"
        actions={
          <div className="flex rounded-[8px] border border-slate-200 bg-white p-1">
            <button
              type="button"
              onClick={() => setTab('type')}
              className={`h-8 rounded-[6px] px-3 text-xs font-medium transition-colors ${
                tab === 'type' ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              资源类型
            </button>
            <button
              type="button"
              onClick={() => setTab('env')}
              className={`h-8 rounded-[6px] px-3 text-xs font-medium transition-colors ${
                tab === 'env' ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              环境
            </button>
          </div>
        }
      />

      {!canWrite && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
          当前角色为只读，可查看字典但不能增删改。
        </div>
      )}

      {tab === 'type' ? <ResourceTypePanel /> : <EnvironmentPanel />}
    </div>
  );
}
