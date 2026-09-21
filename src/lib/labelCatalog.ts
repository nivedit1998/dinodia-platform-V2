// Architecture: Shared platform helper src/lib/labelCatalog.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import registry from '@/config/labelRegistry.json';

export type LabelCategory = (typeof registry.labelCategories)[number];

const LABEL_MAP: Record<string, LabelCategory> = Object.fromEntries(
  Object.entries(registry.synonyms).map(([key, value]) => [key.toLowerCase(), value as LabelCategory])
);

export function classifyDeviceByLabel(
  labels: string[]
): LabelCategory | null {
  const lower = labels.map((l) => l.toLowerCase());
  for (const [key, cat] of Object.entries(LABEL_MAP)) {
    if (lower.includes(key)) return cat;
  }
  return null;
}
