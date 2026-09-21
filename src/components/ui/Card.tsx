// Architecture: Reusable web UI component src/components/ui/Card.tsx; renders part of the platform surface and receives state/actions from its parent flow.
import type { HTMLAttributes } from 'react';

type CardProps = HTMLAttributes<HTMLDivElement> & {
  surface?: 'default' | 'muted' | 'glass';
  padded?: boolean;
};

const surfaceClass = {
  default: 'bg-surface border border-border',
  muted: 'bg-surface-2 border border-border',
  glass: 'bg-surface/85 border border-border backdrop-blur',
};

export function Card({
  className,
  surface = 'default',
  padded = true,
  children,
  ...props
}: CardProps) {
  return (
    <div
      className={[
        'rounded-[20px] shadow-sm',
        surfaceClass[surface],
        padded ? 'p-5' : '',
        className ?? '',
      ].join(' ')}
      {...props}
    >
      {children}
    </div>
  );
}
