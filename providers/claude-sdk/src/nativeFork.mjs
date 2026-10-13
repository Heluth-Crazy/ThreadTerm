/** Native history operation: never opens a query or changes the live card. */
export async function forkHistory(sdk, request) {
  if (typeof request.sessionId !== 'string' || !request.sessionId.trim()) throw new Error('sessionId is required');
  if (request.messageId !== undefined && (typeof request.messageId !== 'string' || !request.messageId.trim())) throw new Error('messageId must be a non-empty string');
  if (request.cwd !== undefined && (typeof request.cwd !== 'string' || !request.cwd.trim())) throw new Error('cwd must be a non-empty string');
  return sdk.forkSession(request.sessionId, {
    ...(request.cwd ? { dir: request.cwd } : {}),
    ...(request.messageId ? { upToMessageId: request.messageId } : {}),
  });
}
