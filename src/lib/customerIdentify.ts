import { prisma } from './prisma';

/**
 * What the sign-in screen should show next for an email address. It answers only this one question: it never
 * returns a Home, a role, a name or who invited the person. The account-exists signal is the deliberate trade-off
 * of an email-first flow, so callers must rate limit it.
 */
export type CustomerIdentifyState = 'CREATE_ACCOUNT' | 'SIGN_IN' | 'VERIFY_EMAIL' | 'ONE_TIME_PASSWORD';

type IdentifyStore = {
  customerAccount: { findUnique(args: { where: { emailNormalized: string }; select: { emailVerifiedAt: true; mustChangePassword: true } }): Promise<{ emailVerifiedAt: Date | null; mustChangePassword: boolean } | null> };
  membershipInvitation: { findFirst(args: { where: object; select: { id: true } }): Promise<{ id: string } | null> };
};

export async function identifyCustomerEmail(email: string, now = new Date(), db: IdentifyStore = prisma): Promise<CustomerIdentifyState> {
  const account = await db.customerAccount.findUnique({
    where: { emailNormalized: email },
    select: { emailVerifiedAt: true, mustChangePassword: true },
  });
  if (account) {
    if (!account.emailVerifiedAt) return 'VERIFY_EMAIL';
    return account.mustChangePassword ? 'ONE_TIME_PASSWORD' : 'SIGN_IN';
  }
  // A tenant invited without an account holds a one-time password; a property manager registers normally.
  const invited = await db.membershipInvitation.findFirst({
    where: { targetEmailNormalized: email, role: 'TENANT', state: 'PENDING', expiresAt: { gt: now }, temporaryCredentialHash: { not: null } },
    select: { id: true },
  });
  return invited ? 'ONE_TIME_PASSWORD' : 'CREATE_ACCOUNT';
}
