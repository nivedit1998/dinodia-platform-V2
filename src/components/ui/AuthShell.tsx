// Architecture: Reusable web UI component src/components/ui/AuthShell.tsx; renders part of the platform surface and receives state/actions from its parent flow.
import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card } from './Card';

type AuthShellProps = {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
};

export function AuthShell({ title, subtitle, children, footer }: AuthShellProps) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card
        surface="glass"
        className="w-full max-w-md border-white/30 p-7 shadow-lg sm:p-8"
      >
        <div className="mb-6 flex items-center justify-center">
          <Image
            src="/brand/logo-lockup.png"
            alt="Dinodia Smart Living"
            width={220}
            height={64}
            className="h-auto w-52 sm:w-56"
            priority
          />
        </div>

        <h1 className="text-center text-2xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        <p className="mt-2 text-center text-sm text-muted">{subtitle}</p>

        <div className="mt-6">{children}</div>

        <p className="mt-5 rounded-xl border border-border bg-surface-2/80 px-3 py-2 text-xs text-muted">
          Private and secure. Dinodia keeps your home control personal.
        </p>

        <p className="mt-3 text-center text-[11px] text-muted">
          <span>Read our </span>
          <Link href="/privacy" className="font-semibold text-foreground underline underline-offset-2 hover:text-slate-700">
            Privacy Notice
          </Link>
          <span> and </span>
          <Link href="/terms" className="font-semibold text-foreground underline underline-offset-2 hover:text-slate-700">
            Terms
          </Link>
          <span>.</span>
        </p>

        {footer ? <div className="mt-4 text-center text-xs text-muted">{footer}</div> : null}
      </Card>
    </div>
  );
}
