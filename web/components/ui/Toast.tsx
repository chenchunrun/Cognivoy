"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { subscribeNotifications } from "@/lib/notifications";

export type ToastVariant = "default" | "success" | "destructive";

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  durationMs?: number;
}

interface ToastItem extends Required<Pick<ToastOptions, "title">> {
  id: number;
  description?: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => void;
  dismiss: (id: number) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return context;
}

const variantStyles: Record<ToastVariant, string> = {
  default: "border-border",
  success: "border-success",
  destructive: "border-destructive",
};

const variantIcons: Record<ToastVariant, React.ReactNode> = {
  default: <Info size={16} className="text-muted-foreground" />,
  success: <CheckCircle2 size={16} className="text-success" />,
  destructive: <AlertCircle size={16} className="text-destructive" />,
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const counterRef = React.useRef(0);
  const timersRef = React.useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = React.useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) clearTimeout(timer);
    timersRef.current.delete(id);
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const push = React.useCallback(
    (options: ToastOptions) => {
      counterRef.current += 1;
      const id = counterRef.current;
      const item: ToastItem = {
        id,
        title: options.title,
        description: options.description,
        variant: options.variant ?? "default",
      };
      setToasts((current) => [...current, item]);
      const timer = setTimeout(
        () => dismiss(id),
        options.durationMs ?? 4000,
      );
      timersRef.current.set(id, timer);
    },
    [dismiss],
  );

  // Surface legacy lib/notifications `notify()` calls as toasts.
  React.useEffect(
    () =>
      subscribeNotifications((notification) => {
        push({
          title: notification.message,
          variant:
            notification.tone === "success"
              ? "success"
              : notification.tone === "error"
                ? "destructive"
                : "default",
          durationMs: notification.durationMs,
        });
      }),
    [push],
  );

  React.useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
    },
    [],
  );

  const value = React.useMemo(
    () => ({ toast: push, dismiss }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
        aria-live="polite"
      >
        <AnimatePresence>
          {toasts.map((item) => (
            <motion.div
              key={item.id}
              layout
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: 0.15 }}
              className={cn(
                "pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-card p-3 shadow-lift",
                variantStyles[item.variant],
              )}
            >
              <span className="mt-0.5 shrink-0" aria-hidden="true">
                {variantIcons[item.variant]}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  {item.title}
                </p>
                {item.description && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {item.description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                aria-label={t("Dismiss notification")}
                className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={14} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
