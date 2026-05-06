import { describe, expect, it } from 'vitest';

import {
  SUPERVISOR_RULES,
  SUPERVISOR_RULE_IDS,
  getSupervisorRule,
  isSupervisorRuleId,
  type SupervisorRuleId,
} from './rules';

// Compile-time exhaustiveness check: if the SUPERVISOR_RULE_IDS tuple ever
// drifts from the SupervisorRuleId union, this assignment fails to type-check.
const _exhaustive: ReadonlyArray<SupervisorRuleId> = SUPERVISOR_RULE_IDS;
void _exhaustive;

const EXPECTED_IDS: SupervisorRuleId[] = [
  'sudo-password',
  'yes-no-bracket',
  'yes-no-paren',
  'press-any-key',
  'git-credentials',
  'ai-proceed',
  'ai-apply-diff',
  'arrow-select',
];

describe('SUPERVISOR_RULES', () => {
  it('contains exactly the 8 rules locked in PRD D5', () => {
    expect(Object.keys(SUPERVISOR_RULES).sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it('SUPERVISOR_RULE_IDS lists every rule id exactly once', () => {
    expect([...SUPERVISOR_RULE_IDS].sort()).toEqual([...EXPECTED_IDS].sort());
    expect(new Set(SUPERVISOR_RULE_IDS).size).toBe(SUPERVISOR_RULE_IDS.length);
  });

  it('every rule has matching alertTitle / alertBody i18n keys', () => {
    for (const id of EXPECTED_IDS) {
      const spec = SUPERVISOR_RULES[id];
      expect(spec.id).toBe(id);
      expect(spec.alertTitleKey).toBe(`supervisor.alertTitle.${id}`);
      expect(spec.alertBodyKey).toBe(`supervisor.alertBody.${id}`);
    }
  });

  it('getSupervisorRule returns the matching spec', () => {
    expect(getSupervisorRule('sudo-password').alertTitleKey).toBe(
      'supervisor.alertTitle.sudo-password',
    );
    expect(getSupervisorRule('arrow-select').alertBodyKey).toBe(
      'supervisor.alertBody.arrow-select',
    );
  });
});

describe('isSupervisorRuleId', () => {
  it('accepts every known wire id', () => {
    for (const id of EXPECTED_IDS) {
      expect(isSupervisorRuleId(id)).toBe(true);
    }
  });

  it('rejects unknown strings', () => {
    expect(isSupervisorRuleId('')).toBe(false);
    expect(isSupervisorRuleId('SudoPassword')).toBe(false); // wrong case
    expect(isSupervisorRuleId('sudo_password')).toBe(false); // wrong delimiter
    expect(isSupervisorRuleId('totally-made-up')).toBe(false);
  });
});
