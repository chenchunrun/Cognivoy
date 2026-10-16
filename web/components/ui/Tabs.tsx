"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const context = React.useContext(TabsContext);
  if (!context) {
    throw new Error(`${component} must be used inside <Tabs>`);
  }
  return context;
}

export interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  onValueChange: (value: string) => void;
}

export function Tabs({
  value,
  onValueChange,
  className,
  children,
  ...props
}: TabsProps) {
  return (
    <TabsContext.Provider value={{ value, onValueChange }}>
      <div className={cn(className)} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export function TabsList({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex items-center gap-1 rounded-lg bg-muted p-1",
        className,
      )}
      {...props}
    />
  );
}

export interface TabsTriggerProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export function TabsTrigger({
  value,
  className,
  children,
  ...props
}: TabsTriggerProps) {
  const { value: selected, onValueChange } = useTabsContext("TabsTrigger");
  const active = selected === value;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-state={active ? "active" : "inactive"}
      onClick={() => onValueChange(value)}
      className={cn(
        "inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        active
          ? "bg-card text-foreground shadow-hairline"
          : "text-muted-foreground hover:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export interface TabsContentProps
  extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

export function TabsContent({
  value,
  className,
  children,
  ...props
}: TabsContentProps) {
  const { value: selected } = useTabsContext("TabsContent");
  if (selected !== value) return null;

  return (
    <div role="tabpanel" className={cn(className)} {...props}>
      {children}
    </div>
  );
}
