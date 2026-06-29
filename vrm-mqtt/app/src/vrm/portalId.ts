/**
 * Derive the value the VRM broker actually uses as the N/{portalId}/... topic
 * segment from the API's `identifier` field.
 *
 * VRM appends the marker `USEDASREPLACEMENT AT <unix-timestamp>` to the
 * identifier of an installation that was created as a replacement for another
 * one. The broker keeps the original portalId for both — only the API record
 * carries the marker. We strip it here so that N/{...} subscriptions and
 * W/{...} publishes can address the broker's actual topic key.
 *
 * Returns '' when the result is empty after stripping — callers should drop
 * the record rather than build an N//... subscribe path.
 */
export function toBrokerPortalId(identifier: string): string {
  const stripped = identifier.replace(/\s*-?\s*USEDASREPLACEMENT\s+AT\s+\d+\s*$/, '');
  return stripped.trim();
}
