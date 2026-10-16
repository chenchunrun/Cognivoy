import { ToastProvider } from "@/components/ui";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Bare shell (no AppShell sidebar) for the standalone admin area; the
  // ToastProvider that AppShell would normally supply is mounted here.
  return (
    <ToastProvider>
      <div className="min-h-screen bg-background">{children}</div>
    </ToastProvider>
  );
}
