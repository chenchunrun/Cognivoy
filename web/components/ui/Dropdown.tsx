"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface DropdownContextValue {
  close: () => void;
}

const DropdownContext = React.createContext<DropdownContextValue | null>(null);

export interface DropdownProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: "start" | "end";
  /** Escape a scrolling/clipped parent without changing other dropdowns. */
  portal?: boolean;
  className?: string;
}

export function Dropdown({
  trigger,
  children,
  align = "start",
  portal = false,
  className,
}: DropdownProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);

  const close = React.useCallback(() => setOpen(false), []);
  const closeAndFocusTrigger = React.useCallback(() => {
    setOpen(false);
    if (portal) triggerRef.current?.focus({ preventScroll: true });
  }, [portal]);

  React.useLayoutEffect(() => {
    if (!open || !portal) return;
    const triggerElement = triggerRef.current;
    const menu = menuRef.current;
    if (!triggerElement || !menu) return;

    const anchor = triggerElement.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    const below = Math.max(0, viewportHeight - anchor.bottom - gap - margin);
    const above = Math.max(0, anchor.top - gap - margin);
    const openAbove = menu.offsetHeight > below && above > below;
    const maxHeight = Math.max(1, openAbove ? above : below);
    const height = Math.min(menu.offsetHeight, maxHeight);
    const width = menu.offsetWidth;
    const left = align === "end" ? anchor.right - width : anchor.left;
    const top = openAbove ? anchor.top - gap - height : anchor.bottom + gap;

    // Measure after mounting, then reveal before paint to avoid a corner flash.
    Object.assign(menu.style, {
      left: `${Math.max(margin, Math.min(left, viewportWidth - width - margin))}px`,
      top: `${Math.max(margin, Math.min(top, viewportHeight - height - margin))}px`,
      maxHeight: `${maxHeight}px`,
      visibility: "visible",
    });
    menu.querySelector<HTMLElement>(
      '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])',
    )?.focus({ preventScroll: true });
  }, [open, portal, align]);

  React.useEffect(() => {
    if (!open) return;

    const onOutsideInteraction = (event: MouseEvent | FocusEvent) => {
      if (
        !containerRef.current?.contains(event.target as Node) &&
        !menuRef.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeAndFocusTrigger();
      }
    };
    const onScroll = (event: Event) => {
      // Scrolling inside an oversized menu is allowed; moving its anchor closes it.
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", onOutsideInteraction);
    document.addEventListener("keydown", onKeyDown);
    if (portal) {
      document.addEventListener("focusin", onOutsideInteraction);
      document.addEventListener("scroll", onScroll, { capture: true, passive: true });
      window.addEventListener("resize", close);
    }
    return () => {
      document.removeEventListener("mousedown", onOutsideInteraction);
      document.removeEventListener("keydown", onKeyDown);
      if (portal) {
        document.removeEventListener("focusin", onOutsideInteraction);
        document.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", close);
      }
    };
  }, [open, portal, close, closeAndFocusTrigger]);

  const renderedTrigger = React.isValidElement(trigger) ? (
    React.cloneElement(
      trigger as React.ReactElement<{
        onClick?: (e: React.MouseEvent) => void;
        "aria-haspopup"?: string;
        "aria-expanded"?: boolean;
      }>,
      {
        onClick: (event: React.MouseEvent) => {
          (
            trigger as React.ReactElement<{
              onClick?: (e: React.MouseEvent) => void;
            }>
          ).props.onClick?.(event);
          if (event.defaultPrevented) return;
          triggerRef.current = event.currentTarget as HTMLElement;
          setOpen((value) => !value);
        },
        "aria-haspopup": "menu",
        "aria-expanded": open,
      },
    )
  ) : (
    <button
      type="button"
      onClick={(event) => {
        triggerRef.current = event.currentTarget;
        setOpen((value) => !value);
      }}
      aria-haspopup="menu"
      aria-expanded={open}
    >
      {trigger}
    </button>
  );

  const menu = (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={menuRef}
          role="menu"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              closeAndFocusTrigger();
            } else if (portal && event.key === "Tab") {
              const items = event.currentTarget.querySelectorAll<HTMLElement>(
                '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])',
              );
              const boundary = event.shiftKey ? items[0] : items[items.length - 1];
              // Tabbing from the body's last element may enter browser chrome,
              // which emits no document focusin. Keep native Tab navigation.
              if (document.activeElement === boundary) close();
            } else if (event.key === "Enter" || event.key === " ") {
              event.stopPropagation();
            }
          }}
          className={cn(
            "z-50 min-w-[10rem] rounded-lg border border-border bg-popover p-1 shadow-lift",
            portal
              ? "fixed overflow-y-auto overscroll-contain"
              : cn("absolute mt-1", align === "start" ? "left-0" : "right-0"),
            className,
          )}
          style={portal
            ? {
                visibility: "hidden",
                maxWidth: "calc(100vw - 1rem)",
                minWidth: "min(10rem, calc(100vw - 1rem))",
              }
            : undefined}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15 }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <DropdownContext.Provider value={{ close }}>
      <div ref={containerRef} className="relative inline-block">
        {renderedTrigger}
        {portal
          ? (typeof document !== "undefined" && createPortal(menu, document.body))
          : menu}
      </div>
    </DropdownContext.Provider>
  );
}

export interface DropdownItemProps {
  icon?: LucideIcon;
  label: string;
  shortcut?: string;
  destructive?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

export function DropdownItem({
  icon: Icon,
  label,
  shortcut,
  destructive = false,
  disabled = false,
  onClick,
}: DropdownItemProps) {
  const context = React.useContext(DropdownContext);

  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        onClick?.();
        context?.close();
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-50",
        destructive ? "text-destructive" : "text-foreground",
      )}
    >
      {Icon && (
        <Icon
          size={14}
          className={destructive ? "text-destructive" : "text-muted-foreground"}
          aria-hidden="true"
        />
      )}
      <span className="flex-1">{label}</span>
      {shortcut && (
        <span className="ml-auto text-xs text-muted-foreground">
          {shortcut}
        </span>
      )}
    </button>
  );
}

export function DropdownSeparator() {
  return <div className="my-1 h-px bg-border" role="separator" />;
}

export function DropdownLabel({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "px-2 py-1.5 text-xs font-medium text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
