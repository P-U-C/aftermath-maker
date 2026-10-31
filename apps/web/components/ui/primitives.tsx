"use client";

import { X } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "quiet" | "stop";
  size?: "small" | "medium" | "large" | "icon";
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      className,
      variant = "primary",
      size = "medium",
      type = "button",
      ...props
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={classes(
          "ui-button",
          `ui-button-${variant}`,
          `ui-button-${size}`,
          className,
        )}
        {...props}
      />
    );
  },
);

type PillProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: "live" | "paper" | "neutral";
  dot?: boolean;
};

export function Pill({
  className,
  tone = "neutral",
  dot = false,
  children,
  ...props
}: PillProps) {
  return (
    <span
      className={classes("ui-pill", `ui-pill-${tone}`, className)}
      {...props}
    >
      {dot && <span className="ui-pill-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

type TabOption<T extends string> = {
  value: T;
  label: string;
};

type SegmentedTabsProps<T extends string> = {
  label: string;
  value: T;
  options: Array<TabOption<T>>;
  onChange: (value: T) => void;
};

export function SegmentedTabs<T extends string>({
  label,
  value,
  options,
  onChange,
}: SegmentedTabsProps<T>) {
  return (
    <div className="ui-tabs" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          className={value === option.value ? "ui-tab is-active" : "ui-tab"}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  label: string;
  unit?: string;
  error?: string;
  hint?: string;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { id, label, unit, error, hint, className, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const detailId = error || hint ? `${inputId}-detail` : undefined;

  return (
    <label className={classes("ui-field", className)} htmlFor={inputId}>
      <span className="ui-field-label">{label}</span>
      <span
        className={classes("ui-input-shell", error && "ui-input-has-error")}
      >
        <input
          ref={ref}
          id={inputId}
          aria-invalid={Boolean(error)}
          aria-describedby={detailId}
          {...props}
        />
        {unit && <span className="ui-input-unit">{unit}</span>}
      </span>
      {(error || hint) && (
        <span
          id={detailId}
          className={error ? "ui-field-error" : "ui-field-hint"}
        >
          {error ?? hint}
        </span>
      )}
    </label>
  );
});

type ToggleProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "children"
> & {
  label: string;
  description?: string;
};

export function Toggle({
  id,
  label,
  description,
  className,
  ...props
}: ToggleProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <label className={classes("ui-toggle", className)} htmlFor={inputId}>
      <span className="ui-toggle-copy">
        <strong>{label}</strong>
        {description && <span>{description}</span>}
      </span>
      <input id={inputId} type="checkbox" {...props} />
      <span className="ui-toggle-track" aria-hidden="true">
        <span />
      </span>
    </label>
  );
}

type CardProps = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  title?: ReactNode;
  subtitle?: string;
  action?: ReactNode;
};

export function Card({
  className,
  title,
  subtitle,
  action,
  children,
  ...props
}: CardProps) {
  return (
    <section className={classes("ui-card", className)} {...props}>
      {(title || subtitle || action) && (
        <header className="ui-card-header">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

type ListRowProps = HTMLAttributes<HTMLDivElement> & {
  leading?: ReactNode;
  trailing?: ReactNode;
};

export function ListRow({
  className,
  leading,
  trailing,
  children,
  ...props
}: ListRowProps) {
  return (
    <div className={classes("ui-list-row", className)} {...props}>
      {leading && <span className="ui-list-leading">{leading}</span>}
      <span className="ui-list-content">{children}</span>
      {trailing && <span className="ui-list-trailing">{trailing}</span>}
    </div>
  );
}

type MeterProps = {
  label: string;
  value: number;
  max: number;
  valueText: string;
};

export function Meter({ label, value, max, valueText }: MeterProps) {
  const safeMax = max > 0 ? max : 1;
  const safeValue = Math.max(0, Math.min(value, safeMax));
  const ratio = safeValue / safeMax;
  const tone = ratio >= 1 ? "limit" : ratio >= 0.7 ? "warning" : "normal";

  return (
    <div
      className={classes("ui-meter", `ui-meter-${tone}`)}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={safeValue}
      aria-valuetext={valueText}
    >
      <div className="ui-meter-labels">
        <span>{label}</span>
        <span>{valueText}</span>
      </div>
      <span className="ui-meter-track" aria-hidden="true">
        <span style={{ width: `${ratio * 100}%` }} />
      </span>
    </div>
  );
}

type SheetProps = {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  initialFocusSelector?: string;
};

export function Sheet({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  initialFocusSelector,
}: SheetProps) {
  const titleId = useId();
  const descriptionId = useId();
  const sheetRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const sheet = sheetRef.current;
    if (!sheet) return;

    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const focusableSelector =
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
    const focusableElements = () =>
      Array.from(sheet.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (element) =>
          element.getAttribute("aria-hidden") !== "true" &&
          element.getClientRects().length > 0,
      );

    const focusFrame = window.requestAnimationFrame(() => {
      (
        (initialFocusSelector
          ? sheet.querySelector<HTMLElement>(initialFocusSelector)
          : null) ??
        focusableElements()[0] ??
        sheet
      ).focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableElements();
      if (!focusable.length) {
        event.preventDefault();
        sheet.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !sheet.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      if (returnFocusRef.current?.isConnected) {
        returnFocusRef.current.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="ui-sheet-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={sheetRef}
        className="ui-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="ui-sheet-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <Button
            variant="quiet"
            size="icon"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} aria-hidden="true" />
          </Button>
        </header>
        <div className="ui-sheet-body">{children}</div>
        {footer && <footer className="ui-sheet-footer">{footer}</footer>}
      </section>
    </div>
  );
}

type ToastProps = {
  message: string;
  tone?: "success" | "error";
};

export function Toast({ message, tone = "success" }: ToastProps) {
  return (
    <div
      className={classes("ui-toast", `ui-toast-${tone}`)}
      role={tone === "error" ? "alert" : undefined}
      aria-live={tone === "error" ? undefined : "polite"}
    >
      {message}
    </div>
  );
}
