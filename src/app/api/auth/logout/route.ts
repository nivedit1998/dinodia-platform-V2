// Architecture: API boundary /auth/logout; validates a request and delegates to the platform domain/integration layers. Treat authentication, identifiers and response shapes as contracts shared with applicable web, iOS, Alexa, Hub Agent and support consumers.
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { clearAuthCookie, setAuthCookie } from '@/lib/auth';

const BACKUP_COOKIE_NAME = 'dinodia_installer_backup_token';

export async function POST() {
  const cookieStore = await cookies();
  const backup = cookieStore.get(BACKUP_COOKIE_NAME)?.value ?? null;
  if (backup) {
    await setAuthCookie(backup);
    cookieStore.set(BACKUP_COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 0,
    });
    return NextResponse.json({ success: true, restoredInstaller: true });
  }

  await clearAuthCookie();
  return NextResponse.json({ success: true });
}
