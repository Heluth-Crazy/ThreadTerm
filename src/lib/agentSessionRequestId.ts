let nextRequestId = Date.now() * 1_000;

/** Window-wide request identity shared by every Agent Session Catalog consumer. */
export function nextAgentSessionCatalogRequestId(): number {
  nextRequestId += 1;
  if (!Number.isSafeInteger(nextRequestId)) {
    nextRequestId = Date.now() * 1_000;
  }
  return nextRequestId;
}
