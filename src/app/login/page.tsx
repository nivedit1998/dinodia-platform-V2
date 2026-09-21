// Architecture: App Router surface src/app/login/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { AuthShell } from '@/components/ui/AuthShell';
import { Card } from '@/components/ui/Card';

export default async function LoginChooserPage() {
  return (
    <AuthShell title="Login" subtitle="Choose how you’d like to sign in." footer={null}>
      <Card surface="muted" className="rounded-[14px] p-3 text-sm text-foreground">
        <div className="space-y-3">
          <a
            href="/login/tenant"
            className="block rounded-[14px] border border-border bg-surface px-4 py-3 text-sm font-semibold hover:bg-surface-2"
          >
            Tenant login
          </a>
          <a
            href="/login/homeowner"
            className="block rounded-[14px] border border-border bg-surface px-4 py-3 text-sm font-semibold hover:bg-surface-2"
          >
            Homeowner login
          </a>
        </div>
      </Card>
    </AuthShell>
  );
}
