import { AppShell } from "@/components/shell/AppShell";

export default function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell>{children}</AppShell>;
}
