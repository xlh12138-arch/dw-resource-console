import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

export function cn(...inputs: (string | false | null | undefined)[]): string {
  return twMerge(clsx(inputs));
}

/* ------------------------------- Button ------------------------------- */

type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-400',
    outline:
      'border border-slate-300 bg-transparent text-slate-700 hover:border-brand-600 hover:bg-white',
    ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
    danger: 'bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-300',
  };
  const sizes: Record<ButtonSize, string> = {
    sm: 'h-8 px-3 text-xs',
    md: 'h-10 px-4 text-sm',
  };
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-[8px] font-medium transition-[background-color,border-color,color,transform] duration-150',
        'hover:-translate-y-px active:translate-y-0',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}

/* ------------------------------- 表单控件 ------------------------------- */

export function Field({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[13px] font-medium text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-rose-500">*</span>}
      </span>
      {children}
      {error ? (
        <span className="block text-xs text-rose-600">{error}</span>
      ) : hint ? (
        <span className="block text-xs leading-relaxed text-slate-500">{hint}</span>
      ) : null}
    </label>
  );
}

const controlBase =
  'w-full rounded-[8px] border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 ' +
  'transition-colors focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-signal-100 disabled:bg-slate-50 disabled:text-slate-500';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(controlBase, className)} {...props} />;
}

export function Textarea({ className, ...props }: InputHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(controlBase, 'min-h-24 resize-y', className)} {...props} />;
}

/** 下拉项：value 允许数字，组件内部统一转字符串后再与 DOM 对齐 */
export interface SelectOption {
  value: string | number;
  label: string;
  disabled?: boolean;
}

/**
 * 下拉框（全站唯一实现，直接用 options 渲染，不再手写 option 子元素）。
 *
 * 之所以不把 <option> 交给调用方拼，是因为「下拉框显示空白」有三个典型成因，都只能在组件内部统一兜住：
 * 1. 类型不一致：state 里是 number、option value 是字符串（或反过来），匹配不上 → 空白。这里统一 String() 归一。
 * 2. 值不在候选项里：字典停用了某个环境/类型、项目被归档、父资源不在候选分页里、动态属性选项被改过 → 空白。
 *    这里会补一个「当前值」兜底项，保证 DOM 里一定存在对应 option。
 * 3. 选项异步到达：React 只在受控 select 自身 props 变化时同步 value，选项是后来补齐的话不会重新应用，
 *    于是 selectedIndex 永远是 -1 → 空白。这里每次渲染后回写一次 node.value。
 */
export function Select({
  options = [],
  placeholder,
  fallbackLabel,
  className,
  value,
  ...rest
}: {
  options?: readonly SelectOption[];
  /** 空值选项文案（如「全部」「请选择」）；不传则没有空选项 */
  placeholder?: string;
  /** 当前值不在候选项中时的兜底文案，默认「<值>（当前值）」 */
  fallbackLabel?: string;
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'>) {
  const current = value === undefined || value === null ? '' : String(value);

  const items = useMemo(
    () => options.map((o) => ({ value: String(o.value), label: o.label, disabled: o.disabled })),
    [options],
  );
  const missing = current !== '' && !items.some((o) => o.value === current);
  // 窄列里长文案会被截断，默认把当前项的完整文案挂到 title 上，悬停即可看全
  const currentLabel =
    items.find((o) => o.value === current)?.label ??
    (missing ? (fallbackLabel ?? current) : undefined);

  const ref = useRef<HTMLSelectElement | null>(null);
  // 选项晚于 value 到达时（字典 / 项目 / 候选资源都是异步的），这里补一次回写
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (node.value !== current) node.value = current;
  });

  return (
    <select
      ref={ref}
      className={cn(controlBase, 'h-9 py-0 pr-8', className)}
      value={current}
      title={rest.title ?? currentLabel}
      {...rest}
    >
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {items.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
      {missing ? <option value={current}>{fallbackLabel ?? `${current}（当前值）`}</option> : null}
    </select>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** 开关功能名称，会直接显示在开关右侧（同时作为 aria-label 供读屏使用） */
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        'group inline-flex items-center gap-2 rounded-[8px] text-xs transition-opacity',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-400 focus-visible:ring-offset-2',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
      )}
    >
      <span
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
          checked ? 'bg-brand-600' : 'bg-slate-300',
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
            checked ? 'translate-x-4.5' : 'translate-x-0.5',
          )}
        />
      </span>
      <span className={cn('select-none text-slate-700', !disabled && 'group-hover:text-slate-900')}>
        {label}
      </span>
      {hint ? <span className="select-none text-[11px] text-slate-400">{hint}</span> : null}
    </button>
  );
}

/* ------------------------------- 展示组件 ------------------------------- */

export function PageHeader({
  title,
  meta,
  actions,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex min-h-12 flex-wrap items-center justify-between gap-x-5 gap-y-3 pb-1">
      <div className="min-w-0">
        <h1 className="page-title">{title}</h1>
        {meta ? <div className="mt-2 text-xs leading-relaxed text-slate-500">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section className={cn('rounded-[12px] border border-slate-200 bg-white', className)}>
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  desc,
  action,
}: {
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
      <div>
        <h3 className="text-[13px] font-medium text-slate-900">{title}</h3>
        {desc && <p className="mt-1 text-xs leading-relaxed text-slate-500">{desc}</p>}
      </div>
      {action}
    </header>
  );
}

const tones = {
  gray: 'bg-slate-100 text-slate-600 ring-slate-200',
  blue: 'bg-brand-50 text-brand-700 ring-brand-100',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-100',
  amber: 'bg-amber-50 text-amber-700 ring-amber-100',
  red: 'bg-rose-50 text-rose-700 ring-rose-100',
  violet: 'bg-signal-50 text-brand-700 ring-signal-200',
} as const;

export function Badge({
  tone = 'gray',
  children,
  className,
}: {
  tone?: keyof typeof tones;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[4px] px-2 py-1 text-[11px] font-medium leading-none ring-1 ring-inset',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * 可点击标签：用于资源标签 / 项目标签等「点一下跳到台账并带上筛选」的场景。
 * 语义上仍是标签（span + role=button），不影响其他纯展示的 Badge。
 */
export function ClickableBadge({
  tone = 'gray',
  children,
  onClick,
  title,
  className,
}: {
  tone?: keyof typeof tones;
  children: ReactNode;
  onClick: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'inline-flex items-center rounded-[4px] px-2 py-1 text-[11px] font-medium leading-none ring-1 ring-inset transition-colors',
        'hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-400',
        tones[tone],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-brand-600',
        className,
      )}
      role="status"
      aria-label="加载中"
    />
  );
}

export function EmptyState({
  title,
  desc,
  action,
}: {
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {desc && <p className="max-w-sm text-xs text-slate-500">{desc}</p>}
      {action}
    </div>
  );
}

export function ErrorBanner({
  message,
  issues,
}: {
  message: string;
  issues?: { field: string; message: string }[];
}) {
  return (
    <div className="space-y-1 rounded-[8px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
      <p>{message}</p>
      {issues && issues.length > 0 ? (
        <ul className="ml-1 list-disc space-y-0.5 pl-4 text-xs text-rose-600">
          {issues.slice(0, 8).map((issue, i) => (
            <li key={`${issue.field}-${i}`}>
              {issue.field ? (
                <>
                  <span className="font-medium">{issue.field}</span>
                  {'：'}
                </>
              ) : null}
              {issue.message}
            </li>
          ))}
          {issues.length > 8 ? <li className="text-rose-500">…等共 {issues.length} 项</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * 弹窗内的「取消 / 关闭」按钮：走弹窗自己的关闭流程，
 * 因此表单有未保存改动时，点取消同样会先弹「保存 / 放弃」确认（与 ESC、✕ 行为一致）。
 */
const ModalGuardContext = createContext<{ requestClose: () => void } | null>(null);

export function useModalGuard(): { requestClose: () => void } | null {
  return useContext(ModalGuardContext);
}

export function ModalCancelButton({
  children = '取消',
  onClick,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { children?: ReactNode }) {
  const guard = useModalGuard();
  return (
    <Button
      variant="outline"
      {...rest}
      onClick={() => {
        if (guard) guard.requestClose();
        else onClick?.(null as unknown as React.MouseEvent<HTMLButtonElement>);
      }}
    >
      {children}
    </Button>
  );
}

/**
 * 弹窗。
 *
 * - ESC 等同于点击右上角关闭（再按一次 ESC 关闭二次确认框）；
 * - 表单里一旦发生过输入 / 选择 / 开关切换，关闭时会先弹出「保存 / 放弃 / 继续编辑」的确认，
 *   避免误关丢改动；传了 onSave 时确认框提供「保存修改」直接落库。
 * - 多层弹窗同时打开时**只有最上层响应 ESC**（按打开顺序维护全局栈），
 *   避免「槽位弹窗里再开分配弹窗，按 ESC 却关掉外层」。
 */

/** 全局弹窗栈：记录已打开弹窗的顺序，栈顶即「最上层」 */
const modalStack: number[] = [];
let modalSeq = 0;

export function Modal({
  open,
  title,
  desc,
  onClose,
  children,
  footer,
  width = 'max-w-2xl',
  closeOnEsc = true,
  onSave,
  dirtyHint,
  /** 该值变化时视为「已保存」，清除未保存标记：保存成功后不应再弹未保存提示 */
  dirtyResetKey,
}: {
  open: boolean;
  title: string;
  desc?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  /** 是否允许 ESC 关闭（默认允许） */
  closeOnEsc?: boolean;
  /** 未保存时的「保存修改」动作；不传则只提供「放弃修改」 */
  onSave?: () => void;
  /** 确认框里的补充说明 */
  dirtyHint?: string;
  /** 该值变化时视为「已保存」，清除未保存标记：保存成功后不应再弹未保存提示 */
  dirtyResetKey?: number;
}) {
  const [confirming, setConfirming] = useState(false);
  /** 表单是否发生过修改（输入 / 选择 / 开关），由容器上的捕获事件统一感知 */
  const [touched, setTouched] = useState(false);
  /** 本弹窗在全局栈里的唯一标识 */
  const [modalId] = useState(() => (modalSeq += 1));
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const descId = useId();
  const confirmTitleId = useId();
  const confirmDescId = useId();

  // 打开时入栈、关闭时出栈：栈内位置决定层叠顺序与 ESC 归属
  useEffect(() => {
    if (!open) return;
    modalStack.push(modalId);
    const index = modalStack.length - 1;
    if (layerRef.current) layerRef.current.style.zIndex = String(50 + index * 10);
    return () => {
      const at = modalStack.indexOf(modalId);
      if (at >= 0) modalStack.splice(at, 1);
    };
  }, [open, modalId]);

  // 打开时锁住背景滚动并把焦点移入弹窗；关闭后恢复原来的焦点位置。
  useEffect(() => {
    if (!open) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  // 保存成功后复位：内容已落库，不应再提示「有未保存的修改」
  useEffect(() => {
    setConfirming(false);
    setTouched(false);
  }, [dirtyResetKey]);

  // 关闭后重置状态，下次打开是干净的
  useEffect(() => {
    if (open) return;
    setConfirming(false);
    setTouched(false);
  }, [open]);

  const requestClose = useCallback(() => {
    if (touched) {
      setConfirming(true);
      return;
    }
    onClose();
  }, [touched, onClose]);

  useEffect(() => {
    if (!open || !closeOnEsc) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // 只有最上层的弹窗消费 ESC：栈里还有更晚打开的弹窗时直接放行
      if (modalStack[modalStack.length - 1] !== modalId) return;
      event.stopPropagation();
      if (confirming) {
        setConfirming(false);
        return;
      }
      requestClose();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, closeOnEsc, confirming, requestClose, modalId]);

  // Tab 只在最上层弹窗内循环；未保存确认框打开时只在其按钮之间循环。
  useEffect(() => {
    if (!open) return;
    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || modalStack[modalStack.length - 1] !== modalId) return;
      const scope = confirming ? confirmRef.current : dialogRef.current;
      if (!scope) return;
      const focusable = Array.from(
        scope.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        scope.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === scope)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handleTab, true);
    return () => window.removeEventListener('keydown', handleTab, true);
  }, [open, confirming, modalId]);

  useEffect(() => {
    if (!confirming) return;
    const dialog = dialogRef.current;
    const frame = window.requestAnimationFrame(() => confirmRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog?.isConnected) dialog.focus();
    };
  }, [confirming]);

  /** 注意：所有 Hook 必须在提前 return 之前调用，否则开合切换会「钩子数量不一致」而崩 */
  const guard = useMemo(() => ({ requestClose }), [requestClose]);

  if (!open) return null;

  const discard = () => {
    setConfirming(false);
    setTouched(false);
    onClose();
  };

  return (
    <div
      ref={layerRef}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto overscroll-contain bg-[#07160f]/70 p-4 backdrop-blur-[2px] sm:p-8"
    >
      <ModalGuardContext.Provider value={guard}>
        <div
          ref={dialogRef}
          className={cn(
            'w-full rounded-[12px] border border-white/20 bg-[#fbfbf8] shadow-2xl',
            width,
          )}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={desc ? descId : undefined}
          tabIndex={-1}
          // 捕获表单里的输入 / 选择 / 开关，用于关闭时的「未保存」提示
          onInputCapture={() => setTouched(true)}
          onChangeCapture={() => setTouched(true)}
          onClickCapture={(event) => {
            const el = event.target as HTMLElement | null;
            if (el?.closest?.('[role="switch"], [data-dirty="1"]')) setTouched(true);
          }}
        >
          <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
            <div>
              <h3 id={titleId} className="text-base font-medium text-slate-900">
                {title}
              </h3>
              {desc && (
                <p id={descId} className="mt-0.5 text-xs text-slate-500">
                  {desc}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={requestClose}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal-400"
              aria-label="关闭"
              title="关闭（ESC）"
            >
              ✕
            </button>
          </header>
          <div className="px-5 py-4">{children}</div>
          {footer && (
            <footer className="flex justify-end gap-2 border-t border-slate-200 bg-white/60 px-5 py-3">
              {footer}
            </footer>
          )}
        </div>
      </ModalGuardContext.Provider>

      {confirming && touched && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center overscroll-contain bg-slate-900/50 p-4">
          <div
            ref={confirmRef}
            className="w-full max-w-sm rounded-[12px] border border-slate-200 bg-white p-5 shadow-2xl focus:outline-none"
            role="dialog"
            aria-modal="true"
            aria-labelledby={confirmTitleId}
            aria-describedby={confirmDescId}
            tabIndex={-1}
          >
            <h4 id={confirmTitleId} className="text-sm font-semibold text-slate-900">
              有未保存的修改
            </h4>
            <p id={confirmDescId} className="mt-1.5 text-xs text-slate-600">
              「{title}」中的内容已修改，关闭前请选择是否保存。
              {dirtyHint ? <span className="mt-1 block text-slate-500">{dirtyHint}</span> : null}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                继续编辑
              </Button>
              <Button variant="outline" size="sm" onClick={discard}>
                放弃修改
              </Button>
              {onSave && (
                <Button
                  size="sm"
                  onClick={() => {
                    setConfirming(false);
                    onSave();
                  }}
                >
                  保存修改
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onChange,
  pageSizeOptions,
  onPageSizeChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
  pageSizeOptions?: number[];
  onPageSizeChange?: (pageSize: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-3 text-[13px] text-slate-500">
      <div className="flex items-center gap-2">
        <span>共 {total} 条</span>
        {onPageSizeChange && pageSizeOptions?.length ? (
          <label className="inline-flex items-center gap-1">
            <span>每页</span>
            <select
              className="h-8 rounded-[6px] border border-slate-300 bg-white px-2 text-xs text-slate-700 outline-none focus:border-brand-600 focus:ring-2 focus:ring-signal-100"
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              aria-label="每页显示条数"
            >
              {pageSizeOptions.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
            <span>条</span>
          </label>
        ) : (
          <span>· 每页 {pageSize} 条</span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          上一页
        </Button>
        <span className="px-2">
          {page} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
        >
          下一页
        </Button>
      </div>
    </div>
  );
}

export function Table({
  head,
  children,
  containerClassName,
  tableClassName,
}: {
  head: ReactNode;
  children: ReactNode;
  containerClassName?: string;
  tableClassName?: string;
}) {
  return (
    <div className={cn('overflow-x-auto overscroll-x-contain', containerClassName)}>
      <table className={cn('w-full min-w-[720px] text-left text-sm', tableClassName)}>
        <thead className="bg-slate-50 text-[12px] font-medium text-slate-600">{head}</thead>
        <tbody className="divide-y divide-slate-200">{children}</tbody>
      </table>
    </div>
  );
}

export function Th({
  children,
  className,
  ariaSort,
}: {
  children?: ReactNode;
  className?: string;
  ariaSort?: 'ascending' | 'descending' | 'none' | 'other';
}) {
  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={cn('whitespace-nowrap px-4 py-3 font-medium', className)}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cn('px-4 py-3 align-middle text-slate-700', className)}>{children}</td>;
}
