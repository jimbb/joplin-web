import { useCallback, useEffect, useState } from "react";
import { TitleDetail } from "@/lib/types";
import { TITLE_DETAIL_STORAGE_KEY } from "@/lib/ui-constants";
import { cn } from "@/lib/utils";

export const DEFAULT_TITLE_DETAIL: TitleDetail = "standard";

const TITLE_DETAIL_CHANGE_EVENT = "joplin-title-detail-change";

export const TITLE_DETAIL_LABELS: Record<TitleDetail, string> = {
  short: "Short",
  standard: "Standard",
  detailed: "Detailed",
};

export interface TitleDetailOption {
  value: TitleDetail;
  label: string;
  example: string;
}

export const TITLE_DETAIL_OPTIONS: readonly TitleDetailOption[] = [
  {
    value: "short",
    label: "Short",
    example: "2024-11-30 BOCHK – Statement",
  },
  {
    value: "standard",
    label: "Standard",
    example: "2026-05-12 PrimeCredit – Credit Card Statement – …3207",
  },
  {
    value: "detailed",
    label: "Detailed",
    example: "2023-10-26 HMRC – Self Assessment Tax Return – Ting, 2021-22, SA100",
  },
] as const;

export function isTitleDetail(value: unknown): value is TitleDetail {
  return value === "short" || value === "standard" || value === "detailed";
}

/** Reads the remembered title detail level from localStorage, defaulting to Standard. */
export function loadTitleDetail(): TitleDetail {
  try {
    const stored = localStorage.getItem(TITLE_DETAIL_STORAGE_KEY);
    if (isTitleDetail(stored)) return stored;
  } catch {
    // storage unavailable
  }
  return DEFAULT_TITLE_DETAIL;
}

/** Saves the chosen title detail level to localStorage and notifies other mounted controls. */
export function saveTitleDetail(value: TitleDetail): void {
  try {
    localStorage.setItem(TITLE_DETAIL_STORAGE_KEY, value);
  } catch {
    // storage unavailable
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<TitleDetail>(TITLE_DETAIL_CHANGE_EVENT, { detail: value }));
  }
}

/** React state hook for the remembered title length setting, synced across dialogs, bulk bar, and editor. */
export function useTitleDetail(): [TitleDetail, (next: TitleDetail) => void] {
  const [value, setValue] = useState<TitleDetail>(loadTitleDetail);

  useEffect(() => {
    const onCustom = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (isTitleDetail(detail)) setValue(detail);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === TITLE_DETAIL_STORAGE_KEY) {
        setValue(isTitleDetail(event.newValue) ? event.newValue : DEFAULT_TITLE_DETAIL);
      }
    };
    window.addEventListener(TITLE_DETAIL_CHANGE_EVENT, onCustom);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(TITLE_DETAIL_CHANGE_EVENT, onCustom);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const update = useCallback((next: TitleDetail) => {
    setValue(next);
    saveTitleDetail(next);
  }, []);

  return [value, update];
}

interface TitleDetailControlProps {
  value: TitleDetail;
  onChange: (value: TitleDetail) => void;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
}

/**
 * Segmented control for choosing Short / Standard / Detailed AI title length,
 * with a one-line example directly underneath.
 */
export function TitleDetailControl({
  value,
  onChange,
  disabled = false,
  compact = false,
  className,
}: TitleDetailControlProps) {
  const activeOption =
    TITLE_DETAIL_OPTIONS.find((opt) => opt.value === value) ?? TITLE_DETAIL_OPTIONS[1];

  return (
    <div className={cn(compact ? "space-y-1" : "space-y-1.5", className)}>
      <div className={cn("flex items-center justify-between gap-2", !compact && "flex-wrap")}>
        <span className="text-xs font-medium text-foreground">Title length</span>
        <div
          role="group"
          aria-label="Title length"
          className="inline-flex items-center rounded-md border border-border/60 bg-muted p-0.5"
        >
          {TITLE_DETAIL_OPTIONS.map((opt) => {
            const active = value === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                onClick={() => onChange(opt.value)}
                className={cn(
                  "rounded-sm px-2 py-1 text-xs font-medium transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                  compact && "px-2 py-0.5 text-[11px]",
                  active
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>
      <p
        className="truncate text-[11px] text-muted-foreground"
        title={`Example: ${activeOption.example}`}
      >
        e.g. {activeOption.example}
      </p>
    </div>
  );
}
