/**
 * The model catalog's vendor for rows an organization's or Personal AI
 * gateway serves: `org-gateway:<organization id>`. Shared so the catalog that
 * writes it and the pickers and icons that read it can't drift.
 */
export const ORG_GATEWAY_VENDOR_PREFIX = 'org-gateway:';

/** The catalog vendor for an AI gateway's rows. */
export function orgGatewayVendor(organizationId: string): string {
  return `${ORG_GATEWAY_VENDOR_PREFIX}${organizationId}`;
}

/** Whether a catalog vendor names an AI gateway's rows. */
export function isOrgGatewayVendor(vendor: string | undefined): boolean {
  return vendor?.startsWith(ORG_GATEWAY_VENDOR_PREFIX) === true;
}
