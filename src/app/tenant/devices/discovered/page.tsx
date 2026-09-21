// Architecture: App Router surface src/app/tenant/devices/discovered/page.tsx; composes the user journey for this route and delegates reusable data, validation and state work to shared modules.
import { redirect } from 'next/navigation';
import { Role } from '@prisma/client';
import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { CAPABILITIES } from '@/lib/deviceCapabilities';
import DiscoveredDevices from '../../ui/DiscoveredDevices';
import { getUserPolicyStatus } from '@/lib/policyAcceptance';
import { getUserWithHaConnection } from '@/lib/haConnection';

export default async function DiscoveredDevicesPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.role !== Role.TENANT) redirect('/admin/settings');

  const status = await getUserPolicyStatus(user.id);
  if (!status.privacyAccepted || !status.termsAccepted) {
    redirect('/tenant/policy');
  }

  const { user: userWithRelations, haConnection } = await getUserWithHaConnection(user.id);
  const areas = Array.from(new Set(userWithRelations.accessRules.map((rule) => rule.area))).sort((a, b) =>
    a.localeCompare(b)
  );
  const areaOverrides = await prisma.areaDisplayOverride.findMany({
    where: { haConnectionId: haConnection.id, haAreaName: { in: areas } },
  });
  const areaOverrideMap = new Map(areaOverrides.map((override) => [override.haAreaName, override]));
  const areaOptions = areas.map((haAreaName) => ({
    haAreaName,
    displayName: areaOverrideMap.get(haAreaName)?.displayName ?? haAreaName,
  }));
  const capabilityOptions = Object.keys(CAPABILITIES);

  return <DiscoveredDevices areas={areas} areaOptions={areaOptions} capabilityOptions={capabilityOptions} />;
}
