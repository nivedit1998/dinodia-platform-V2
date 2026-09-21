// Architecture: Shared platform helper src/lib/authVerificationRecovery.ts; centralizes reusable domain, integration, validation or data-access behavior for route and UI callers. Keep exports and error semantics aligned with their consumers.
'use client';

import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { platformFetchJson } from './platformFetchClient';

export type AuthSessionRole = 'ADMIN' | 'TENANT' | 'INSTALLER';

export type AuthSessionState = {
  authenticated: boolean;
  role?: AuthSessionRole;
  requiresHomeownerPolicyAcceptance?: boolean;
};

type AuthMeResponse = {
  user?: {
    role?: AuthSessionRole;
  } | null;
  requiresHomeownerPolicyAcceptance?: boolean;
};

export async function fetchAuthSessionState(): Promise<AuthSessionState> {
  const data = await platformFetchJson<AuthMeResponse>(
    '/api/auth/me',
    { cache: 'no-store' },
    'Unable to restore your session right now.'
  );

  const role = data.user?.role;
  if (!role) {
    return { authenticated: false };
  }

  return {
    authenticated: true,
    role,
    requiresHomeownerPolicyAcceptance: Boolean(data.requiresHomeownerPolicyAcceptance),
  };
}

export async function resumeAuthenticatedSession(router: AppRouterInstance): Promise<boolean> {
  const session = await fetchAuthSessionState();
  if (!session.authenticated || !session.role) {
    return false;
  }

  if (session.role === 'ADMIN') {
    router.push(
      session.requiresHomeownerPolicyAcceptance ? '/homeowner/policy' : '/admin/dashboard'
    );
    return true;
  }
  if (session.role === 'TENANT') {
    router.push('/tenant/dashboard');
    return true;
  }
  if (session.role === 'INSTALLER') {
    router.push('/installer/provision');
    return true;
  }

  return false;
}
