/**
 * Supervisor rule registry — frontend-side metadata only.
 *
 * The Rust backend (`src-tauri/src/supervisor.rs`) is the *authoritative*
 * regex matcher (PRD D12 implementation note). The frontend never re-matches
 * patterns; it just needs i18n keys for the alert title/body it shows in the
 * Notification Centre, keyed by the stable `ruleId` string the backend emits.
 *
 * The 8 rule IDs MUST stay byte-equal to the strings produced by
 * `RuleId::as_str()` in `src-tauri/src/supervisor.rs:68-79`. Changing one
 * means a coordinated frontend + backend release.
 */

/**
 * Stable wire identifier for each supervisor rule. These strings appear:
 *   • in the `supervisor://alert` event payload `ruleId` field
 *   • as i18n key suffixes (`supervisor.alertTitle.<id>` etc.)
 *   • as the per-(card, rule) cooldown key in `supervisorStore`
 */
export type SupervisorRuleId =
  | 'sudo-password'
  | 'yes-no-bracket'
  | 'yes-no-paren'
  | 'press-any-key'
  | 'git-credentials'
  | 'ai-proceed'
  | 'ai-apply-diff'
  | 'arrow-select';

/**
 * Exhaustive tuple of all rule IDs. Useful for telemetry buckets and tests
 * that need to iterate every rule. Order matches the Rust `RuleId` enum
 * declaration so logs from both sides line up.
 */
export const SUPERVISOR_RULE_IDS = [
  'sudo-password',
  'yes-no-bracket',
  'yes-no-paren',
  'press-any-key',
  'git-credentials',
  'ai-proceed',
  'ai-apply-diff',
  'arrow-select',
] as const satisfies readonly SupervisorRuleId[];

export interface SupervisorRuleSpec {
  id: SupervisorRuleId;
  /** i18n key for the notification title (resolved by PR3's locale files). */
  alertTitleKey: string;
  /** i18n key for the notification body. Receives `{ sampleText }` interpolation. */
  alertBodyKey: string;
}

function spec(id: SupervisorRuleId): SupervisorRuleSpec {
  return {
    id,
    alertTitleKey: `supervisor.alertTitle.${id}`,
    alertBodyKey: `supervisor.alertBody.${id}`,
  };
}

export const SUPERVISOR_RULES: Record<SupervisorRuleId, SupervisorRuleSpec> = {
  'sudo-password': spec('sudo-password'),
  'yes-no-bracket': spec('yes-no-bracket'),
  'yes-no-paren': spec('yes-no-paren'),
  'press-any-key': spec('press-any-key'),
  'git-credentials': spec('git-credentials'),
  'ai-proceed': spec('ai-proceed'),
  'ai-apply-diff': spec('ai-apply-diff'),
  'arrow-select': spec('arrow-select'),
};

/**
 * Lookup helper. Returns `undefined` for unknown ids so callers can decide
 * whether to silently drop or log a wire-protocol mismatch.
 */
export function getSupervisorRule(id: SupervisorRuleId): SupervisorRuleSpec {
  return SUPERVISOR_RULES[id];
}

/**
 * Type guard for the wire `ruleId` string. The backend should never send
 * an unknown value, but treating the IPC boundary as untrusted keeps a
 * frontend-only test environment safe.
 */
export function isSupervisorRuleId(value: string): value is SupervisorRuleId {
  return (SUPERVISOR_RULE_IDS as readonly string[]).includes(value);
}
