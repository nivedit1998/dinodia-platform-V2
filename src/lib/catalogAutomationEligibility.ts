// A Hub may re-publish a device's control catalogue at the SAME revision and digest when the only
// change is that owner-approved controls became schedulable (automatable false → true). Every
// other difference must keep raising `hub_sync_catalog_conflict`. Self-contained on purpose.

const APPROVED_ROLES = new Set(['target_temperature', 'operating_mode', 'power', 'brightness']);
const VALUE_TYPES = new Set(['boolean', 'number', 'option']);
const LOCK_ROLES = new Set(['security_lock', 'lock_state']);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function withoutAutomatable(control: Record<string, unknown>): Record<string, unknown> {
  const { automatable: _automatable, ...rest } = control;
  return rest;
}

function safeToSchedule(control: Record<string, unknown>): boolean {
  return control.writable === true && control.readable === true && control.idempotency === 'set_value'
    && control.stepUpPolicy !== 'required' && !['sensitive', 'critical'].includes(String(control.riskLevel))
    && APPROVED_ROLES.has(String(control.semanticRole)) && !LOCK_ROLES.has(String(control.semanticRole))
    && VALUE_TYPES.has(String(control.valueType));
}

export function isAutomationEligibilityUpgrade(prior: unknown, next: unknown): boolean {
  if (!Array.isArray(prior) || !Array.isArray(next) || prior.length !== next.length || prior.length === 0) return false;
  let upgraded = 0;
  for (let index = 0; index < prior.length; index += 1) {
    const before = prior[index]; const after = next[index];
    if (!before || typeof before !== 'object' || Array.isArray(before) || !after || typeof after !== 'object' || Array.isArray(after)) return false;
    const left = before as Record<string, unknown>; const right = after as Record<string, unknown>;
    if (left.controlId !== right.controlId) return false;
    if (canonical(withoutAutomatable(left)) !== canonical(withoutAutomatable(right))) return false;
    if (left.automatable === right.automatable) continue;
    if (left.automatable !== false || right.automatable !== true || !safeToSchedule(right)) return false;
    upgraded += 1;
  }
  return upgraded > 0;
}
