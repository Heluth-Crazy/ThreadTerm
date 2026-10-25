// Chat exports use the ledger when a managed session has a native coordinate. The old per-turn table remains only for
// legacy sessions that predate native ids; a failed or empty ledger lookup must stay unreported rather than regress.
import type { Session, UsageLedgerSessionDetail, UsageRecord } from '@threadterm/protocol';
import { chatExportUsage, type ChatExportMeta } from './chatMarkdownExport';

export type UsageExportReader = {
  ledgerSession: (provider: string, nativeSessionId: string) => Promise<UsageLedgerSessionDetail | null>;
  legacySession: (sessionId: string) => Promise<readonly UsageRecord[]>;
};

export async function readUsageExport(session: Pick<Session, 'id' | 'provider' | 'nativeId'>, reader: UsageExportReader): Promise<Pick<ChatExportMeta, 'model' | 'tokens'>> {
  if (!session.nativeId) return chatExportUsage(await reader.legacySession(session.id), session.id);
  const detail = await reader.ledgerSession(session.provider, session.nativeId);
  if (!detail) return {};
  return { model: detail.models.length === 1 ? detail.models[0] : undefined, tokens: { total: detail.tokens.total } };
}
