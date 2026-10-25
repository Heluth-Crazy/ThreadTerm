// Draft state for Settings → Usage (F21's retry-draft rule applied to a settings object): the stored value and what the
// user has changed stay separate, so an unrelated settings event never discards a dirty field. Only dirty top-level
// fields travel in the update, and a stored value that moved underneath raises one conflict instead.
import type { UsageLedgerPriceOverride, UsageLedgerSettings } from '@threadterm/protocol';

export const USAGE_SETTING_KEYS = ['includeOutside', 'providers', 'weekStart', 'priceOverrides'] as const;
export type UsageSettingKey = typeof USAGE_SETTING_KEYS[number];

export type UsageSettingsDraft = {
  loaded: UsageLedgerSettings;
  value: UsageLedgerSettings;
  dirty: UsageSettingKey[];
  conflict: boolean;
};

/** Key-order-insensitive shape, so a rebuilt provider map is still the same settings. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]));
  }
  return value;
}

const sameField = (left: unknown, right: unknown) => JSON.stringify(canonical(left ?? null)) === JSON.stringify(canonical(right ?? null));

export function initialUsageSettingsDraft(loaded: UsageLedgerSettings): UsageSettingsDraft {
  return { loaded, value: loaded, dirty: [], conflict: false };
}

/** Applies one user edit. Typing a field back to its stored value clears its dirty flag again. */
export function editUsageSettings(draft: UsageSettingsDraft, patch: Partial<UsageLedgerSettings>): UsageSettingsDraft {
  const value = { ...draft.value, ...patch };
  const dirty = USAGE_SETTING_KEYS.filter(key => !sameField(value[key], draft.loaded[key]));
  return { loaded: draft.loaded, value, dirty, conflict: false };
}

/**
 * Applies a settings event: clean fields follow the stored value, dirty ones keep the draft. A dirty field whose stored
 * value changed underneath is reported once as a conflict and otherwise left alone.
 */
export function mergeStoredUsageSettings(draft: UsageSettingsDraft, stored: UsageLedgerSettings): UsageSettingsDraft {
  let value = draft.value;
  const dirty: UsageSettingKey[] = [];
  let conflict = false;
  for (const key of USAGE_SETTING_KEYS) {
    const changed = !sameField(draft.value[key], draft.loaded[key]);
    if (changed) {
      dirty.push(key);
      if (!sameField(stored[key], draft.loaded[key])) conflict = true;
    } else {
      value = { ...value, [key]: stored[key] };
    }
  }
  return { loaded: stored, value, dirty, conflict: draft.conflict || conflict };
}

/** The user chose the stored value over their own edits. */
export const adoptStoredUsageSettings = (draft: UsageSettingsDraft): UsageSettingsDraft => initialUsageSettingsDraft(draft.loaded);

/** A successful save returned the stored value: the draft is clean again. */
export const savedUsageSettings = (stored: UsageLedgerSettings): UsageSettingsDraft => initialUsageSettingsDraft(stored);

/** Only the dirty fields are sent, so an untouched default never overwrites a value changed on another device. */
export function changedUsageSettings(draft: UsageSettingsDraft): Partial<UsageLedgerSettings> {
  const patch: Partial<UsageLedgerSettings> = {};
  for (const key of draft.dirty) (patch as Record<string, unknown>)[key] = draft.value[key];
  return patch;
}

export const usageSettingsPatchField = (patch: Partial<UsageLedgerSettings>): UsageSettingKey[] =>
  USAGE_SETTING_KEYS.filter(key => patch[key] !== undefined);

/** True when both settings objects would produce the same ledger view (used to skip a redundant save). */
export function usageSettingsEqual(left: UsageLedgerSettings, right: UsageLedgerSettings): boolean {
  return USAGE_SETTING_KEYS.every(key => sameField(left[key], right[key]));
}

/** Provider switches default to on; an absent key is not an "off". */
export function providerHistoryEnabled(settings: UsageLedgerSettings | undefined, provider: string): boolean {
  return settings?.providers?.[provider] !== false;
}

/** A price override is a USD-per-million rate: finite and non-negative, or absent. */
export type PriceDraft = Record<string, Partial<Record<keyof UsageLedgerPriceOverride, string>>>;

export const PRICE_FIELDS: Array<keyof UsageLedgerPriceOverride> = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];

/** Text inputs keep what the user typed; only parseable fields become numbers. An empty field removes the rate. */
export function priceOverridesFromDraft(draft: PriceDraft): Record<string, UsageLedgerPriceOverride> {
  const overrides: Record<string, UsageLedgerPriceOverride> = {};
  for (const [model, fields] of Object.entries(draft)) {
    if (!priceModelKey(model)) continue;
    const override: UsageLedgerPriceOverride = {};
    for (const field of PRICE_FIELDS) {
      const text = (fields[field] ?? '').trim();
      if (!text) continue;
      const value = Number(text);
      if (Number.isFinite(value) && value >= 0) override[field] = value;
    }
    if (Object.keys(override).length) overrides[model] = override;
  }
  return overrides;
}

/** The inverse: stored overrides as editable text, keeping the model order the runtime returned. */
export function draftFromPriceOverrides(overrides: Record<string, UsageLedgerPriceOverride> | undefined): PriceDraft {
  const draft: PriceDraft = {};
  for (const [model, override] of Object.entries(overrides ?? {})) {
    const fields: Partial<Record<keyof UsageLedgerPriceOverride, string>> = {};
    for (const field of PRICE_FIELDS) {
      const value = override[field];
      if (value === undefined || !Number.isFinite(value)) continue;
      fields[field] = `${value}`;
    }
    draft[model] = fields;
  }
  return draft;
}

/** A model key is `provider/model` or a bare model id; both are accepted, blank is not. */
export function priceModelKey(text: string): string | null {
  const key = text.trim();
  if (!key || key.length > 128) return null;
  if (/\s/.test(key)) return null;
  return key;
}

/** The sample line every row above is measured against, so the model price table reads evenly. */
export const priceOverrideText = (override: UsageLedgerPriceOverride | undefined, field: keyof UsageLedgerPriceOverride): string =>
  override?.[field] === undefined ? '' : `${override[field]}`;
