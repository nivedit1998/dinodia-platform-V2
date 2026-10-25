import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { enforcePersistentRateLimit } from '@/lib/rateLimit';
import { nativeV1ErrorResponse } from '@/lib/contracts/nativeV1Error';
import { validateCustomerHomeClaimLanEndpointReceipt, validateCustomerHomeClaimLanEndpointRequest } from '@/lib/contracts/dinodiaV1';
import { Stage1AuthError, requireCustomerAccountSession } from '@/lib/stage1Auth';
import { hashClaimReference } from '@/lib/stage1ClaimContract';
import { customerClaimLanAddressValidUntil, verifiedCustomerClaimLanAddress, verifiedCustomerLanEndpoint } from '@/lib/lanEndpoint';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const customer = await requireCustomerAccountSession(request);
    if (!customer.emailVerifiedAt) throw new Stage1AuthError(403, 'claim_email_unverified', 'Verified email is required');
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!validateCustomerHomeClaimLanEndpointRequest(body)) throw new Stage1AuthError(404, 'claim_resolver_unavailable', 'The current claim resolver is unavailable');
    const referenceHash = hashClaimReference(body.reference);
    await enforcePersistentRateLimit(`customer-home-claim-lan:${customer.id}:${referenceHash}`, 10, 15 * 60 * 1000);

    const installation = await prisma.hubInstallation.findUnique({
      where: { permanentResolverHash: referenceHash },
      select: {
        id: true, homeId: true, lifecycleStatus: true, permanentResolverHash: true,
        permanentResolverGeneration: true, permanentResolverStatus: true,
        publicHubId: true, lanTlsReportedAt: true, lanTlsState: true, lanTlsIdentityGeneration: true,
        baseUrl: true, lanEndpointReportedAt: true, lanEndpointState: true, lanEndpointIdentityGeneration: true,
        lanTlsCertificateGeneration: true, lanTlsCurrentSpkiPin: true, lanTlsCurrentNotBefore: true,
        lanTlsCurrentNotAfter: true, lanTlsNextCertificateGeneration: true, lanTlsNextSpkiPin: true,
        lanTlsNextNotBefore: true, lanTlsNextNotAfter: true,
        manufacturingIdentity: { select: { identityGeneration: true, status: true } },
        home: { select: { activeHubInstallationId: true } },
      },
    });
    const claims = installation ? await prisma.homeClaimReference.findMany({ where: {
      hubInstallationId: installation.id, resolverGeneration: installation.permanentResolverGeneration,
      state: { in: ['AVAILABLE', 'RESERVED'] }, purpose: { in: ['INITIAL_OWNER', 'OWNERSHIP_TRANSFER'] },
      cancelledAt: null, revokedAt: null, invalidatedAt: null,
    }, select: { id: true, purpose: true, state: true, resolverGeneration: true, companyQrReferenceHash: true, transferRecipientEmailHash: true }, take: 2 }) : [];
    const claim = claims.length === 1 ? claims[0] : null;
    const expectedTransferRecipientHash = hashClaimReference(`dinodia-transfer-recipient-v1:${customer.email.trim().toLowerCase()}`);
    const claimMatches = Boolean(installation && claim && claim.resolverGeneration === installation.permanentResolverGeneration
      && (claim.purpose === 'INITIAL_OWNER' ? claim.companyQrReferenceHash === referenceHash
        : claim.purpose === 'OWNERSHIP_TRANSFER' && claim.transferRecipientEmailHash === expectedTransferRecipientHash));
    const now = new Date();
    if (!installation || !claimMatches || installation.lifecycleStatus !== 'ACTIVE'
      || installation.permanentResolverStatus !== 'ACTIVE' || installation.permanentResolverHash !== referenceHash
      || installation.home.activeHubInstallationId !== installation.id
      || installation.manufacturingIdentity.status !== 'ACTIVE') {
      throw new Stage1AuthError(404, 'claim_resolver_unavailable', 'The current claim resolver is unavailable');
    }
    const lanEndpoint = verifiedCustomerLanEndpoint({
      manufacturingIdentityGeneration: installation.manufacturingIdentity.identityGeneration,
      manufacturingIdentityStatus: installation.manufacturingIdentity.status,
      publicHubId: installation.publicHubId,
      lanTlsReportedAt: installation.lanTlsReportedAt,
      lanTlsState: installation.lanTlsState,
      lanTlsIdentityGeneration: installation.lanTlsIdentityGeneration,
      lanTlsCertificateGeneration: installation.lanTlsCertificateGeneration,
      lanTlsCurrentSpkiPin: installation.lanTlsCurrentSpkiPin,
      lanTlsCurrentNotBefore: installation.lanTlsCurrentNotBefore,
      lanTlsCurrentNotAfter: installation.lanTlsCurrentNotAfter,
      lanTlsNextCertificateGeneration: installation.lanTlsNextCertificateGeneration,
      lanTlsNextSpkiPin: installation.lanTlsNextSpkiPin,
      lanTlsNextNotBefore: installation.lanTlsNextNotBefore,
      lanTlsNextNotAfter: installation.lanTlsNextNotAfter,
    }, now);
    const lanAddress = verifiedCustomerClaimLanAddress({
      manufacturingIdentityGeneration: installation.manufacturingIdentity.identityGeneration,
      manufacturingIdentityStatus: installation.manufacturingIdentity.status,
      baseUrl: installation.baseUrl,
      lanEndpointReportedAt: installation.lanEndpointReportedAt,
      lanEndpointState: installation.lanEndpointState,
      lanEndpointIdentityGeneration: installation.lanEndpointIdentityGeneration,
    }, now);
    if (!lanAddress) throw new Stage1AuthError(404, 'claim_resolver_unavailable', 'The current claim resolver is unavailable');
    const lanAddressReportedAt = installation.lanEndpointReportedAt?.toISOString();
    const lanAddressValidUntil = installation.lanEndpointReportedAt
      ? customerClaimLanAddressValidUntil(installation.lanEndpointReportedAt).toISOString()
      : undefined;
    const claimLanEndpoint = lanEndpoint && lanAddressReportedAt && lanAddressValidUntil
      ? { ...lanEndpoint, lanAddress, lanAddressReportedAt, lanAddressValidUntil }
      : undefined;
    const receipt = { schemaVersion: 'dinodia.v1', ok: true, lanEndpoint: claimLanEndpoint };
    if (!lanEndpoint || !validateCustomerHomeClaimLanEndpointReceipt(receipt, now.getTime())) {
      throw new Stage1AuthError(404, 'claim_resolver_unavailable', 'The current claim resolver is unavailable');
    }
    return NextResponse.json(receipt, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) { return nativeV1ErrorResponse(error); }
}
