// Architecture: Shared platform helper src/lib/deviceLabels.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
import registry from '@/config/labelRegistry.json';
import { UIDevice } from '@/types/device';

export const LABEL_ORDER = registry.groups as readonly string[];
export const OTHER_LABEL = registry.otherLabel;
export const REMOTE_LABEL = 'Remote';
const LABEL_ORDER_LOWER = LABEL_ORDER.map((label) => label.toLowerCase());

export function normalizeLabel(label?: string | null) {
  return label?.toString().trim() ?? '';
}

export function getPrimaryLabel(
  device: Pick<UIDevice, 'label' | 'labels' | 'labelCategory' | 'canonicalLabel'>
) {
  const canonical = normalizeLabel(device.canonicalLabel);
  if (canonical) return canonical;

  const overrideLabel = normalizeLabel(device.label);
  if (overrideLabel) return overrideLabel;

  const labelsArray = Array.isArray(device.labels) ? device.labels.map((l) => normalizeLabel(l)) : [];
  // Prefer the first label that maps to a known group
  const known = labelsArray.find((lbl) => lbl && LABEL_ORDER_LOWER.includes(lbl.toLowerCase()));
  if (known) return known;

  // Fallback to first non-empty label
  const first = labelsArray.find((lbl) => lbl);
  if (first) return first;

  return normalizeLabel(device.labelCategory) || OTHER_LABEL;
}

export function getCapabilityLabel(
  device: Pick<UIDevice, 'label' | 'labels' | 'labelCategory' | 'canonicalLabel'>
) {
  const canonical = normalizeLabel(device.canonicalLabel);
  if (canonical) return canonical;
  const category = normalizeLabel(device.labelCategory);
  if (category) return category;
  return getPrimaryLabel(device);
}

export function getAdditionalLabels(
  device: Pick<UIDevice, 'labels'>,
  primaryLabel: string
) {
  if (!Array.isArray(device.labels)) return [];
  const primaryLower = primaryLabel.toLowerCase();
  return device.labels
    .map((lbl) => normalizeLabel(lbl))
    .filter((lbl) => lbl && lbl.toLowerCase() !== primaryLower);
}

export function getGroupLabel(
  device: Pick<
    UIDevice,
    'label' | 'labels' | 'labelCategory' | 'displayLabel' | 'canonicalLabel' | 'sourceTechnicalLabel'
  >
) {
  const displayLabel = normalizeLabel(device.displayLabel);
  if (displayLabel) return displayLabel;
  const label = normalizeLabel(device.label);
  if (label) return label;
  const labelsArray = Array.isArray(device.labels) ? device.labels.map((l) => normalizeLabel(l)) : [];
  const known = labelsArray.find((lbl) => lbl && LABEL_ORDER_LOWER.includes(lbl.toLowerCase()));
  if (known) return LABEL_ORDER[LABEL_ORDER_LOWER.indexOf(known.toLowerCase())];
  const first = labelsArray.find((lbl) => lbl);
  if (first) return first;
  const source = normalizeLabel(device.sourceTechnicalLabel);
  if (source) return source;
  const fallback = normalizeLabel(device.labelCategory || device.canonicalLabel);
  if (!fallback) return OTHER_LABEL;
  const idx = LABEL_ORDER_LOWER.indexOf(fallback.toLowerCase());
  return idx >= 0 ? LABEL_ORDER[idx] : OTHER_LABEL;
}

export function isRemoteLabel(
  device: Pick<UIDevice, 'label' | 'labels' | 'labelCategory' | 'displayLabel' | 'canonicalLabel'>
) {
  return getGroupLabel(device) === REMOTE_LABEL;
}

export function sortLabels(labels: string[]) {
  return labels.sort((a, b) => {
    const idxA = LABEL_ORDER_LOWER.indexOf(a.toLowerCase());
    const idxB = LABEL_ORDER_LOWER.indexOf(b.toLowerCase());
    const normA = idxA === -1 ? LABEL_ORDER.length : idxA;
    const normB = idxB === -1 ? LABEL_ORDER.length : idxB;
    if (normA !== normB) return normA - normB;
    return a.localeCompare(b);
  });
}
