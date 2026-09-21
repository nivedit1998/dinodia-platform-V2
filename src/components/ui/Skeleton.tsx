// Architecture: Reusable web UI component src/components/ui/Skeleton.tsx; renders part of the platform surface and receives state/actions from its parent flow.
type SkeletonProps = {
  className?: string;
};

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={[
        'animate-pulse rounded-xl bg-[linear-gradient(90deg,rgba(255,255,255,0.05),rgba(255,255,255,0.14),rgba(255,255,255,0.05))]',
        'bg-[length:220%_100%] border border-border/60',
        className ?? '',
      ].join(' ')}
      aria-hidden
    />
  );
}
