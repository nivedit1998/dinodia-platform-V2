import type { Prisma } from '@prisma/client';

/** Erases permitted tenant-private device history before scoped device rows are removed. */
export async function deleteTenantPrivateDeviceCloudData(tx: Prisma.TransactionClient, input: {
  homeId: string;
  deviceIds: string[];
}) {
  const deviceIds = [...new Set(input.deviceIds)];
  if (deviceIds.length === 0) return;

  // Usage buckets and temperature samples are deliberately restricted by the
  // database to permanent property devices, so private tenant devices cannot
  // validly own those records. Their scoped outage history is removable.
  const incidents = await tx.nativeDeviceOutageIncident.findMany({
    where: { homeId: input.homeId, deviceId: { in: deviceIds } }, select: { id: true },
  });
  const incidentIds = incidents.map((incident) => incident.id);
  if (incidentIds.length) {
    await tx.nativeDeviceOutageIncident.deleteMany({ where: { homeId: input.homeId, id: { in: incidentIds } } });
  }
}
