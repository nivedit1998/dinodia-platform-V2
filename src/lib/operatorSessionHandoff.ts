// Stage 1 operator handoff contract. The browser receives an opaque one-use
// value; the platform stores only its hash and binds redemption to employee,
// home, hub and workflow.
import crypto from 'node:crypto';

const HANDOFF_TTL_MS = 60_000;
const digest = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

type Handoff = { employeeId: number; homeId: number; hubInstallId: string; workflow: string; workflowId: string; expiresAt: number; consumedAt: number | null };

export class OperatorSessionHandoffRegistry {
  private readonly values = new Map<string, Handoff>();
  public constructor(private readonly now: () => number = () => Date.now()) {}

  public issue(input: Omit<Handoff, 'expiresAt' | 'consumedAt'>) {
    const value = `dno_handoff_${crypto.randomBytes(32).toString('base64url')}`;
    const expiresAt = this.now() + HANDOFF_TTL_MS;
    this.values.set(digest(value), { ...input, expiresAt, consumedAt: null });
    return { value, expiresAt };
  }

  public consume(value: string, expected: Pick<Handoff, 'employeeId' | 'homeId' | 'hubInstallId' | 'workflow' | 'workflowId'>) {
    const key = digest(String(value || ''));
    const handoff = this.values.get(key);
    if (!handoff || handoff.consumedAt || handoff.expiresAt <= this.now()) return null;
    if (handoff.employeeId !== expected.employeeId || handoff.homeId !== expected.homeId || handoff.hubInstallId !== expected.hubInstallId || handoff.workflow !== expected.workflow || handoff.workflowId !== expected.workflowId) return null;
    handoff.consumedAt = this.now();
    this.values.delete(key);
    return { ...expected, expiresAt: handoff.expiresAt, consumedAt: handoff.consumedAt };
  }

  public prune() {
    let removed = 0;
    for (const [key, handoff] of this.values) if (handoff.consumedAt || handoff.expiresAt <= this.now()) { this.values.delete(key); removed += 1; }
    return removed;
  }
}
