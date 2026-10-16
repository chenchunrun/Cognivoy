import { AppShell } from "@/components/shell/AppShell";

export default function UtilityLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell>{children}</AppShell>;
}
