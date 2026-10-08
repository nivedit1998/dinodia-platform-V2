import crypto from 'node:crypto';
import { Stage1AuthError } from './stage1Auth';
import { hashClaimReference } from './stage1ClaimContract';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function claimPepper(): Buffer {
  const value = String(process.env.CLAIM_REFERENCE_PEPPER ?? '');
  if (!value) throw new Stage1AuthError(503, 'claim_reference_unconfigured', 'Transfer authority is not configured');
  return Buffer.from(value, 'utf8');
}

/** The same normal-journey claim reference is used by owner and staff transfers. */
export function transferReferenceForClaim(claimId: string): string {
  if (!UUID.test(claimId)) throw new Stage1AuthError(500, 'transfer_reference_invalid', 'The transfer reference is unavailable');
  const mac = crypto.createHmac('sha256', claimPepper()).update(`dinodia-transfer-reference-v1:${claimId}`, 'utf8').digest('base64url');
  return `dno_transfer_${claimId}_${mac}`;
}

/** Stable account-recipient binding; no plaintext email is required on a claim. */
export function transferRecipientHash(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 320) {
    throw new Stage1AuthError(400, 'transfer_recipient_invalid', 'A valid verified recipient is required');
  }
  return hashClaimReference(`dinodia-transfer-recipient-v1:${normalized}`);
}
