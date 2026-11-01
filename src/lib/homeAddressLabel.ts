/** The street address a member sees on the Choose a Home page, from the address given at setup ("Flat 2, 14 High Street"); null when none was given. */
export function homeAddressLabel(home: { addressLine1: string | null; addressLine2: string | null }): string | null {
  const parts = [home.addressLine2, home.addressLine1].map((part) => (part ?? '').replace(/\s+/g, ' ').trim()).filter((part) => part.length > 0);
  const label = parts.join(', ');
  return label.length === 0 ? null : label.slice(0, 200);
}
