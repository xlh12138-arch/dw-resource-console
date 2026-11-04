import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  RESOURCE_STATUSES,
  RESOURCE_STATUS_LABELS,
  type AttrFieldDef,
  type ResourceDto,
  type ResourceStatus,
} from '@dw/shared';
import { useDict } from '../lib/dict';
import { projectsApi, resourcesApi } from '../lib/endpoints';
import { fieldIssues, friendlyMessage, type FieldIssue } from '../lib/api';
import { useToast } from './toast';
import { Badge, Button, ErrorBanner, Field, Input, Modal, ModalCancelButton, Select, Switch, Textarea } from './ui';

interface Props {
  open: boolean;
  initial: ResourceDto | null;
  defaultType: string;
  onClose: () => void;
  onSaved: () => void;
}

type Errors = Record<string, string>;

const IP_KEYS = ['ip', 'mgmtIp'];

function attrsWithDefaults(
  fields: AttrFieldDef[],
  attrs: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...attrs };
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(next, field.key)) continue;
    const raw = field.defaultValue;
    if (raw === undefined || raw === null || raw === '') continue;
    next[field.key] =
      field.kind === 'switch'
        ? ['true', '1', 'yes'].includes(raw.toLowerCase())
        : field.kind === 'number'
          ? Number(raw)
          : raw;
  }
  return next;
}

export function ResourceFormModal({ open, initial, defaultType, onClose, onSaved }: Props) {
  const { push } = useToast();
  const dict = useDict();
  const isEdit = Boolean(initial);

  const [type, setType] = useState<string>(initial?.type ?? defaultType);
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<string>('DEV');
  const [status, setStatus] = useState<ResourceStatus>('IN_USE');
  const [datacenter, setDatacenter] = useState('');
  const [owner, setOwner] = useState('');
  const [tags, setTags] = useState('');
  const [projectId, setProjectId] = useState('');
  const [parentId, setParentId] = useState('');
  const [demandAmount, setDemandAmount] = useState('');
  const [capacityTotal, setCapacityTotal] = useState('');
  const [capacityUnit, setCapacityUnit] = useState('GB');
  const [capacityRemark, setCapacityRemark] = useState('');
  const [remark, setRemark] = useState('');
  const [attrs, setAttrs] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState('');
  const [formIssues, setFormIssues] = useState<FieldIssue[]>([]);

  // 打开弹窗时回填
  useEffect(() => {
    if (!open) return;
    setType(initial?.type ?? defaultType);
    setName(initial?.name ?? '');
    setEnvironment(initial?.environment ?? dict.activeEnvironments[0]?.code ?? 'DEV');
    setStatus(initial?.status ?? 'IN_USE');
    setDatacenter(initial?.datacenter ?? '');
    setOwner(initial?.owner ?? '');
    setTags((initial?.tags ?? []).join(', '));
    setProjectId(initial?.projectId ? String(initial.projectId) : '');
    setParentId(initial?.parentId ? String(initial.parentId) : '');
    setDemandAmount(initial?.demandAmount !== null && initial?.demandAmount !== undefined ? String(initial.demandAmount) : '');
    setCapacityTotal(initial?.capacityTotal !== null && initial?.capacityTotal !== undefined ? String(initial.capacityTotal) : '');
    setCapacityUnit(initial?.capacityUnit ?? 'GB');
    setCapacityRemark('');
    setRemark(initial?.remark ?? '');
    setAttrs((initial?.attrs ?? {}) as Record<string, unknown>);
    setErrors({});
    setFormError('');
    setFormIssues([]);
  }, [open, initial, defaultType]);

  // 字段定义来自资源类型字典，新增/改名后自动生效
  const fields = dict.attrFields(type) as AttrFieldDef[];

  // 字典异步加载完成后补齐字段默认值；已有值和用户主动清空的值不被覆盖。
  useEffect(() => {
    if (!open) return;
    setAttrs((prev) => attrsWithDefaults(fields, prev));
  }, [open, type, fields]);

  // 父资源候选：同类型、非自身，用于「子资源申请容量」
  const parentOptions = useQuery({
    queryKey: ['resource-parent-options', type],
    queryFn: () => resourcesApi.list({ type, pageSize: 200, sortBy: 'name', sortOrder: 'asc' }),
    enabled: open,
  });
  const parentCandidates = (parentOptions.data?.items ?? []).filter((r) => r.id !== initial?.id);
  // 候选列表按类型分页查询，若当前父资源不在其中（跨类型 / 超出分页 / 数据仍在加载），单独取一次详情兜底，
  // 保证「父资源」下拉一定有可回显的选项，且子资源态不会因为候选未到位而误判成顶层资源
  const parentMissing = Boolean(parentId) && !parentCandidates.some((r) => String(r.id) === parentId);
  const parentDetail = useQuery({
    queryKey: ['resource-detail', parentId],
    queryFn: () => resourcesApi.get(Number(parentId)),
    enabled: open && parentMissing,
  });
  const pickedParent =
    parentCandidates.find((r) => String(r.id) === parentId) ?? (parentDetail.data ?? undefined);
  // 只要填了父资源就算子资源：编辑时类型不可改，parentId 一定有效；新增时切换类型会自动清空 parentId
  const isChild = Boolean(parentId);
  /** 当前父资源的剩余容量已包含本资源的旧申请量，编辑场景要加回去再展示。 */
  const availableForParent = (parent: ResourceDto): number => {
    const base = parent.capacityAvailable ?? 0;
    return initial?.parentId === parent.id && initial?.demandAmount !== null && initial?.demandAmount !== undefined
      ? base + initial.demandAmount
      : base;
  };
  /** 子资源只能补充非必填属性：必填项一律由父资源继承（表单只读，提交时剔除） */
  const requiredKeys = new Set(fields.filter((f) => f.required).map((f) => f.key));
  const editableAttrs = isChild
    ? Object.fromEntries(Object.entries(attrs).filter(([key]) => !requiredKeys.has(key)))
    : attrs;

  // 字典加载完成后，若当前环境在字典里已彻底不存在才纠正到第一个启用项。
  // 注意：仅仅是「被停用」不能纠正 —— 存量资源可能仍属于停用环境，强行改写会让下拉显示值与真实数据不一致。
  useEffect(() => {
    if (!open || dict.loading) return;
    const known = dict.environments.some((e) => e.code === environment);
    if (!known && dict.activeEnvironments.length > 0) {
      setEnvironment(dict.activeEnvironments[0]!.code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dict.loading, dict.environments.length]);

  const projects = useQuery({ queryKey: ['projects-options'], queryFn: () => projectsApi.options() });

  const ipValue = useMemo(() => {
    for (const key of IP_KEYS) {
      const v = attrs[key];
      if (typeof v === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return v;
    }
    return '';
  }, [attrs]);

  // IP 占用预检：写入前提示冲突，避免提交后才报错
  const ipCheck = useQuery({
    queryKey: ['ip-check', ipValue],
    queryFn: () => resourcesApi.checkIp(ipValue),
    enabled: Boolean(ipValue),
    staleTime: 5_000,
  });
  const ipConflicts = (ipCheck.data?.conflicts ?? []).filter((c) => c.code !== initial?.code);

  const mutation = useMutation({
    mutationFn: async () => {
      const currentCapacity = initial?.capacityTotal ?? null;
      const nextCapacity = capacityTotal.trim() === '' ? null : Number(capacityTotal);
      const capacityTotalChanged = !isEdit || nextCapacity !== currentCapacity;
      const nextCapacityUnit = capacityTotal.trim() === '' ? null : capacityUnit || null;
      const capacityUnitChanged = !isEdit || nextCapacityUnit !== (initial?.capacityUnit ?? null);
      const payload = {
        type,
        name,
        environment,
        status,
        datacenter: datacenter || undefined,
        owner: owner || undefined,
        tags: tags
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean),
        remark: remark || undefined,
        attrs: editableAttrs,
        // 子资源：容量上限由「向父资源申请的额度」决定，不再单独设置总容量
        ...(isChild
          ? { parentId: Number(parentId), demandAmount: Number(demandAmount) }
          : { parentId: null, demandAmount: null }),
        ...(!isChild && capacityTotalChanged ? { capacityTotal: nextCapacity } : {}),
        ...(!isChild && (capacityTotalChanged || capacityUnitChanged)
          ? { capacityUnit: nextCapacityUnit }
          : {}),
        ...(isEdit && capacityRemark.trim() ? { capacityRemark: capacityRemark.trim() } : {}),
        ...(projectId ? { projectId: Number(projectId) } : { projectId: null }),
      };
      return initial
        ? resourcesApi.update(initial.id, payload)
        : resourcesApi.create(payload);
    },
    onSuccess: () => {
      push('success', isEdit ? '资源已更新' : isChild ? '子资源已创建，并已从父资源申请容量' : '资源已创建');
      onSaved();
      onClose();
    },
    onError: (err: unknown) => {
      const issues = fieldIssues(err);
      setFormError(friendlyMessage(err));
      setFormIssues(issues);
      // 后端返回的字段级错误回填到对应控件
      const next: Errors = {};
      for (const issue of issues) {
        const field = issue.field.replace(/^attrs\./, 'attrs.');
        if (field) next[field] = issue.message;
      }
      if (Object.keys(next).length > 0) setErrors(next);
    },
  });

  const submit = () => {
    const next: Errors = {};
    if (!type) next['type'] = '请选择资源类型';
    if (!name.trim()) next['name'] = '请填写资源名称';
    for (const f of fields) {
      // 子资源的必填属性全部继承父资源，无需（也不允许）在表单里修改
      if (isChild && f.required) continue;
      const filled = attrs[f.key] !== undefined && attrs[f.key] !== '' && attrs[f.key] !== null;
      if (f.required && !filled) {
        next[`attrs.${f.key}`] = `请填写${f.label}`;
      }
    }
    if (isChild) {
      if (!demandAmount.trim() || Number(demandAmount) <= 0) next['demandAmount'] = '请填写向父资源申请的容量';
      else if (pickedParent && Number(demandAmount) > availableForParent(pickedParent)) {
        next['demandAmount'] = `超出父资源剩余可用容量 ${availableForParent(pickedParent)}`;
      }
    }
    // 父资源容量不能被调到「已占用」以下，否则剩余容量为负
    if (!isChild && isEdit && capacityTotal.trim() !== '') {
      const allocated = initial?.capacityAllocated ?? 0;
      const total = Number(capacityTotal);
      if (Number.isFinite(total) && total < allocated) {
        next['capacityTotal'] = `不能小于已占用 ${allocated}，否则剩余容量为负`;
      }
    }
    setErrors(next);
    if (Object.keys(next).length > 0) {
      setFormError(`请先补全必填项：${Object.values(next).join('、')}`);
      setFormIssues(
        Object.entries(next).map(([field, message]) => ({ field, message })),
      );
      return;
    }
    setFormIssues([]);
    mutation.mutate();
  };

  return (
    <Modal
      open={open}
      title={isEdit ? `编辑资源 · ${initial?.code}` : '新增资源'}
      desc={isEdit ? '修改后将记录到变更审计' : '按资源类型填写专属属性，保存时自动校验 IP 占用'}
      onClose={onClose}
      onSave={submit}
      dirtyHint="保存后才会写入资源台账并生成审计记录"
      footer={
        <>
          <ModalCancelButton onClick={onClose}>取消</ModalCancelButton>
          <Button onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {formError && <ErrorBanner message={formError} issues={formIssues} />}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="资源类型" required error={errors['type']}>
            <Select
              value={type}
              disabled={isEdit}
              placeholder="请选择资源类型"
              // 编辑时保留停用类型，避免存量数据的类型显示为空白
              options={dict.typeOptions({ includeDisabled: isEdit })}
              onChange={(e) => {
                setType(e.target.value);
                setAttrs({});
                // 类型变了，原来的父资源不再同类型，清空避免挂错层级
                setParentId('');
                setDemandAmount('');
              }}
            />
          </Field>
          <Field label="资源名称" required error={errors['name']}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：调度主节点-01" />
          </Field>
          <Field label="所属环境" required>
            <Select
              value={environment}
              options={dict.envOptions()}
              onChange={(e) => setEnvironment(e.target.value)}
            />
          </Field>
          <Field label="资源状态">
            <Select
              value={status}
              options={RESOURCE_STATUSES.map((s) => ({ value: s, label: RESOURCE_STATUS_LABELS[s] }))}
              onChange={(e) => setStatus(e.target.value as ResourceStatus)}
            />
          </Field>
          <Field label="机房 / 可用区">
            <Input value={datacenter} onChange={(e) => setDatacenter(e.target.value)} placeholder="如：深圳A机房" />
          </Field>
          <Field label="负责人">
            <Input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="如：张伟" />
          </Field>
          <Field label="标签" hint="多个标签用英文逗号分隔">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="核心, 调度" />
          </Field>
          <Field label="所属项目" hint="用于按项目查看与统计">
            <Select
              value={projectId}
              placeholder="未标注"
              fallbackLabel="当前所属项目"
              options={(projects.data ?? []).map((p) => ({ value: String(p.id), label: p.name }))}
              onChange={(e) => setProjectId(e.target.value)}
            />
          </Field>
        </div>

        <div className="rounded-lg border border-slate-200 p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-700">层级关系</p>
            <span className="text-[11px] text-slate-400">子资源向父资源申请容量，父资源总量为其上限</span>
          </div>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Field label="父资源" hint="留空则为顶层资源">
              <Select
                value={parentId}
                placeholder="无（顶层资源）"
                fallbackLabel={initial?.parentCode ? `父资源 ${initial.parentCode}` : '当前父资源'}
                options={[
                  ...parentCandidates.map((r) => ({
                    value: String(r.id),
                    label:
                      `${r.code} · ${r.name}` +
                      (r.capacityTotal !== null
                        ? `（剩余 ${availableForParent(r)}${r.capacityUnit ?? ''}）`
                        : '（未设容量）'),
                  })),
                  // 当前父资源不在候选里（跨类型 / 超出分页）时补一项，保证下拉能回显
                  ...(pickedParent && !parentCandidates.some((r) => r.id === pickedParent.id)
                    ? [{ value: String(pickedParent.id), label: `${pickedParent.code} · ${pickedParent.name}` }]
                    : []),
                ]}
                onChange={(e) => {
                  setParentId(e.target.value);
                  if (!e.target.value) setDemandAmount('');
                }}
              />
            </Field>
            {isChild && (
              <Field
                label="申请容量"
                required
                error={errors['demandAmount']}
                hint={
                  pickedParent
                    ? pickedParent.capacityTotal === null
                      ? '父资源未启用容量管理，无法申请'
                      : `父资源剩余可用 ${availableForParent(pickedParent)}${pickedParent.capacityUnit ? ` ${pickedParent.capacityUnit}` : ''}`
                    : undefined
                }
              >
                <Input
                  type="number"
                  min={0}
                  value={demandAmount}
                  onChange={(e) => setDemandAmount(e.target.value)}
                  placeholder="如：256"
                />
              </Field>
            )}
          </div>
          {isChild ? (
            <p className="mt-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700">
              子资源将继承父资源的项目归属、机房与专属属性；自身总容量固定等于申请额度，无法单独调整。父资源下调总容量时会校验全部子资源申请量。
            </p>
          ) : (
            <p className="mt-2 text-[11px] text-slate-500">
              选择父资源后，本资源将成为其子资源，容量由申请额度决定。
            </p>
          )}
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-4">
          <p className="mb-3 text-xs font-semibold text-slate-700">
            {dict.typeLabel(type)} 专属属性
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {fields.map((f) => {
              /** 子资源的必填属性继承父资源，渲染为只读，避免误改导致父子信息不一致 */
              const lockedByParent = isChild && f.required;
              const inheritedRaw = lockedByParent ? pickedParent?.attrs?.[f.key] : undefined;
              const inheritedText =
                f.kind === 'select'
                  ? ((f.options ?? []).find((o) => o.value === inheritedRaw)?.label ??
                    (inheritedRaw as string | undefined) ??
                    '—')
                  : inheritedRaw === undefined || inheritedRaw === null || inheritedRaw === ''
                    ? '—'
                    : String(inheritedRaw);

              return (
                <Field
                  key={f.key}
                  label={f.label}
                  required={f.required && !lockedByParent}
                  error={errors[`attrs.${f.key}`]}
                  hint={lockedByParent ? '继承自父资源，不可修改' : undefined}
                >
                  {lockedByParent ? (
                    <div className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-slate-100/70 px-3 text-sm text-slate-600">
                      <span className="truncate">{inheritedText}</span>
                      <span className="ml-auto shrink-0 rounded bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-400 ring-1 ring-inset ring-slate-200">
                        继承
                      </span>
                    </div>
                  ) : f.kind === 'select' ? (
                    <Select
                      value={(attrs[f.key] as string) ?? ''}
                      placeholder="请选择"
                      fallbackLabel={`${String(attrs[f.key] ?? '')}（不在候选项中）`}
                      options={(f.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
                      onChange={(e) => setAttrs({ ...attrs, [f.key]: e.target.value })}
                    />
                  ) : f.kind === 'switch' ? (
                    <div className="flex h-9 items-center">
                      <Switch
                        checked={Boolean(attrs[f.key])}
                        label={f.label}
                        onChange={(next) => setAttrs({ ...attrs, [f.key]: next })}
                      />
                    </div>
                  ) : f.kind === 'number' ? (
                    <div className="relative">
                      <Input
                        type="number"
                        value={(attrs[f.key] as number | string) ?? ''}
                        placeholder={f.placeholder}
                        onChange={(e) =>
                          setAttrs({ ...attrs, [f.key]: e.target.value === '' ? undefined : Number(e.target.value) })
                        }
                      />
                      {f.unit && (
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">
                          {f.unit}
                        </span>
                      )}
                    </div>
                  ) : (
                    <Input
                      value={(attrs[f.key] as string) ?? ''}
                      placeholder={f.placeholder}
                      onChange={(e) => setAttrs({ ...attrs, [f.key]: e.target.value })}
                    />
                  )}
                </Field>
              );
            })}
          </div>

          {ipValue && (
            <div className="mt-3 flex items-center gap-2 text-xs">
              <span className="text-slate-500">IP 占用检测：</span>
              {ipCheck.isFetching ? (
                <span className="text-slate-400">检测中…</span>
              ) : ipConflicts.length > 0 ? (
                <Badge tone="red">
                  {ipValue} 已被 {ipConflicts.map((c) => c.code).join('、')} 占用
                </Badge>
              ) : (
                <Badge tone="green">{ipValue} 可用</Badge>
              )}
            </div>
          )}
        </div>

        {!isChild && (
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-700">容量设置</p>
            <Switch
              checked={capacityTotal.trim() !== ''}
              label="启用容量管理"
              hint={capacityTotal.trim() !== '' ? '已启用' : '未启用'}
              onChange={(next) => {
                if (!next) {
                  setCapacityTotal('');
                  return;
                }
                setCapacityTotal(capacityTotal.trim() === '' ? '1024' : capacityTotal);
              }}
            />
          </div>
          {capacityTotal.trim() !== '' ? (
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              <Field
                label="总容量"
                required
                error={errors['capacityTotal']}
                hint={
                  isEdit && (initial?.capacityAllocated ?? 0) > 0
                    ? `最小 ${initial?.capacityAllocated}（已占用），剩余容量不能为负${
                        capacityTotal.trim() !== '' && Number.isFinite(Number(capacityTotal))
                          ? `；当前剩余 ${Number(capacityTotal) - (initial?.capacityAllocated ?? 0)}`
                          : ''
                      }`
                    : '调小后必须 ≥ 已占用（槽位 + 子资源）'
                }
              >
                <Input
                  type="number"
                  min={isEdit ? (initial?.capacityAllocated ?? 0) : 0}
                  value={capacityTotal}
                  onChange={(e) => setCapacityTotal(e.target.value)}
                  placeholder="如：20480"
                />
              </Field>
              <Field label="容量单位">
                <Input
                  value={capacityUnit}
                  onChange={(e) => setCapacityUnit(e.target.value)}
                  placeholder="GB / TB / 核"
                />
              </Field>
              <Field label="容量说明">
                <Input
                  value={capacityRemark}
                  onChange={(e) => setCapacityRemark(e.target.value)}
                  placeholder="如：共享存储池配额"
                />
              </Field>
            </div>
          ) : (
            <p className="mt-2 text-xs text-slate-500">
              启用后，各项目环境槽位引用该资源时必须填写申请容量，且占用总量不得超过总容量；调小容量时会校验现有占用。
            </p>
          )}
          {isEdit && initial?.capacityTotal !== null && (
            <p className="mt-2 text-xs text-slate-500">
              当前已占用 {initial?.capacityAllocated ?? 0}
              {initial?.capacityUnit ? ` ${initial.capacityUnit}` : ''}
              {initial?.capacityTotal ? ` / ${initial.capacityTotal}${initial.capacityUnit ? ` ${initial.capacityUnit}` : ''}` : ''}
              （其中子资源 {initial?.childAllocated ?? 0}），调小后不能小于已占用量。
            </p>
          )}
        </div>
        )}

        {isChild && pickedParent && (
          <div className="rounded-lg border border-brand-200 bg-brand-50/50 p-3 text-xs text-brand-800">
            子资源 <span className="font-semibold">{name || '未命名'}</span> 的总容量固定为申请额度
            <span className="font-semibold"> {demandAmount || '—'} {pickedParent.capacityUnit ?? ''}</span>
            ，由父资源 <span className="font-semibold">{pickedParent.code}</span> 的容量池统一约束。
          </div>
        )}

        <Field label="备注">
          <Textarea value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="用途、变更窗口等说明" />
        </Field>
      </div>
    </Modal>
  );
}
