import { useEffect, useRef, useState } from 'react';
import type { Snapshot, UsageLedgerSettings } from '@threadterm/protocol';
import { agentIds, agentName } from '../agents';
import { subscribeEvents } from '../bridge';
import { readUsageSettings, updateUsageSettings, useUsageSources } from '../usageLedger';
import { sourceState } from '../usageSources';
import { usageCopy, type UsageCopy } from '../usageCopy';
import {
  adoptStoredUsageSettings, changedUsageSettings, draftFromPriceOverrides, editUsageSettings, initialUsageSettingsDraft,
  mergeStoredUsageSettings, PRICE_FIELDS, priceModelKey, priceOverridesFromDraft, providerHistoryEnabled, savedUsageSettings,
  usageSettingsEqual, type PriceDraft, type UsageSettingsDraft,
} from '../usageSettingsDraft';
import type { UsageLocale } from '../usageFormat';
import { Select } from './ui/Select';
import { SettingsSwitch } from './SettingsControls';
import { Icon } from './PrototypeIcon';
import './settings-usage.css';

type Props = { data: Snapshot; zh: boolean };

/**
 * Settings → Usage. Reads and writes `usage.ledger.settings` (the ledger's own view of the settings revision), keeps the
 * user's edits in a draft so a concurrent settings change never overwrites a dirty field, and saves only what changed.
 */
export function SettingsUsage({ data, zh }: Props) {
  const locale: UsageLocale = zh ? 'zh-CN' : 'en';
  const copy = usageCopy(locale);
  const [draft, setDraft] = useState<UsageSettingsDraft>();
  const [revision, setRevision] = useState<number>();
  const [prices, setPrices] = useState<PriceDraft>({});
  const [newModel, setNewModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [issue, setIssue] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const current = useRef<UsageSettingsDraft | undefined>(undefined);
  current.current = draft;
  const writing = useRef(false);
  writing.current = saving;
  // The ledger already knows which native histories are available; this is a read of that result, not a provider probe.
  const { sources } = useUsageSources(0, true);
  const sourceStates = new Map((sources?.providers ?? []).map(source => [source.provider, sourceState(source.status)]));
  const providers = [...new Set([...agentIds(data.providers), ...Object.keys(draft?.value.providers ?? {})])];
  const providerLabel = (id: string) => agentName(id, data.providers) || id;

  const load = async (merge?: UsageSettingsDraft) => {
    try {
      const result = await readUsageSettings();
      const next = merge ? mergeStoredUsageSettings(merge, result.value) : initialUsageSettingsDraft(result.value);
      setRevision(result.revision);
      setDraft(next);
      setPrices(draftFromPriceOverrides(next.value.priceOverrides));
      setIssue(undefined);
    } catch (caught) {
      setIssue(caught instanceof Error ? caught.message : String(caught));
    }
  };

  // One read on mount, then only settings events: no timer asks the runtime again.
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => subscribeEvents(event => {
    if (event.event !== 'state.changed') return;
    if ((event.data as { kind?: string } | undefined)?.kind !== 'settings') return;
    // Our own write publishes the same event; its response already carries the stored value, and merging a draft that
    // is still in flight would report a conflict against itself.
    if (writing.current) return;
    void load(current.current);
  }), []);

  /** Writes the dirty fields. A revision conflict keeps the draft and asks the user which side to keep. */
  const save = async (next: UsageSettingsDraft) => {
    if (!next.dirty.length || revision === undefined) { setDraft(next); return; }
    setDraft(next); setSaving(true); setSaved(undefined); setIssue(undefined);
    try {
      const result = await updateUsageSettings(changedUsageSettings(next), revision);
      setRevision(result.revision);
      setDraft(savedUsageSettings(result.value));
      setPrices(draftFromPriceOverrides(result.value.priceOverrides));
      setSaved(copy.settings.saved);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message.includes('revision_conflict')) {
        try {
          const stored = await readUsageSettings();
          setRevision(stored.revision);
          const merged = mergeStoredUsageSettings(next, stored.value);
          setDraft(merged);
          setIssue(undefined);
          if (!merged.dirty.length) setPrices(draftFromPriceOverrides(stored.value.priceOverrides));
        } catch { setIssue(message); }
      } else setIssue(`${copy.settings.failed}${message}`);
    } finally {
      setSaving(false);
    }
  };

  /** Toggle-style fields save at once; the price table waits for its own Save button. */
  const change = (patch: Partial<UsageLedgerSettings>) => {
    if (!draft) return;
    const next = editUsageSettings(draft, patch);
    setDraft(next);
    void save(next);
  };

  const savePrices = () => {
    if (!draft) return;
    const overrides = priceOverridesFromDraft(prices);
    const next = editUsageSettings(draft, { priceOverrides: overrides });
    if (!next.dirty.length) { setSaved(undefined); return; }
    setPrices(draftFromPriceOverrides(overrides));
    void save(next);
  };

  const editPrice = (model: string, field: typeof PRICE_FIELDS[number], value: string) => {
    setPrices(state => ({ ...state, [model]: { ...state[model], [field]: value } }));
    setSaved(undefined);
  };

  const addModel = () => {
    const key = priceModelKey(newModel);
    if (!key) { setIssue(copy.settings.invalidModel); return; }
    setPrices(state => ({ ...state, [key]: state[key] ?? {} }));
    setNewModel('');
    setIssue(undefined);
  };

  const priceRows = Object.keys(prices);
  const pricesDraft = draft && { ...draft.value, priceOverrides: priceOverridesFromDraft(prices) };
  const pricesDirty = Boolean(draft && pricesDraft && !usageSettingsEqual(pricesDraft, draft.value));

  if (!draft) return <div className="settings-card" aria-busy={!issue}><div className="settings-card-row"><div>
    <div className="settings-card-title">{copy.settings.title}</div>
    {issue ? <p className="surface-error" role="alert">{`${copy.settings.unavailable} ${issue}`}</p>
      : <p role="status" aria-live="polite">{copy.settings.loading}</p>}
  </div></div></div>;

  return <>
    {draft.conflict && <div className="settings-usage-conflict" role="status">
      <p>{copy.settings.conflict}</p>
      <span className="settings-usage-conflict-actions">
        <button type="button" className="btn btn-sm" onClick={() => setDraft({ ...draft, conflict: false, loaded: draft.loaded })}>{copy.settings.keepMine}</button>
        <button type="button" className="btn btn-sm" onClick={() => { const next = adoptStoredUsageSettings(draft); setDraft(next); setPrices(draftFromPriceOverrides(next.value.priceOverrides)); }}>{copy.settings.useStored}</button>
      </span>
    </div>}
    {issue && <p className="surface-error" role="alert">{issue}</p>}

    <div className="settings-card">
      <div className="settings-card-row">
        <div>
          <div className="settings-card-title">{copy.settings.includeOutside}</div>
          <p>{copy.settings.includeOutsideHint}</p>
        </div>
        <SettingsSwitch checked={draft.value.includeOutside} disabled={saving} aria-label={copy.settings.includeOutside}
          onChange={enabled => change({ includeOutside: enabled })}>
          {draft.value.includeOutside ? copy.settings.on : copy.settings.off}
        </SettingsSwitch>
      </div>
    </div>

    <div className="settings-card">
      <div className="settings-card-title">{copy.settings.providers}</div>
      <div className="settings-provider-list">
        {providers.map(provider => <div key={provider} className={`settings-card-row${draft.value.includeOutside ? '' : ' is-muted'}`}>
          <div>
            <div className="settings-card-title">{providerLabel(provider)}</div>
            {sourceStates.get(provider) === 'notInstalled' || data.providers.some(capability => capability.id === provider && capability.installed === false)
              ? <p className="settings-provider-detail"><span className="chip flat settings-provider-state">{copy.sources.state.notInstalled}</span><span>{draft.value.includeOutside && providerHistoryEnabled(draft.value, provider) ? copy.settings.providerToggle(providerLabel(provider)) : copy.settings.providerOff(providerLabel(provider))}</span></p>
              : <p>{draft.value.includeOutside && providerHistoryEnabled(draft.value, provider)
                ? copy.settings.providerToggle(providerLabel(provider))
                : copy.settings.providerOff(providerLabel(provider))}</p>}
          </div>
          <SettingsSwitch checked={providerHistoryEnabled(draft.value, provider)} disabled={saving || !draft.value.includeOutside}
            aria-label={copy.settings.providerToggle(providerLabel(provider))}
            onChange={enabled => change({ providers: { ...draft.value.providers, [provider]: enabled } })}>
            {providerHistoryEnabled(draft.value, provider) ? copy.settings.on : copy.settings.off}
          </SettingsSwitch>
        </div>)}
      </div>
    </div>

    <div className="settings-card">
      <div className="settings-card-row">
        <div>
          <div className="settings-card-title">{copy.settings.weekStart}</div>
          <p>{copy.settings.weekHint}</p>
        </div>
        <Select aria-label={copy.settings.weekStart} value={draft.value.weekStart} disabled={saving}
          onChange={event => change({ weekStart: event.target.value as UsageLedgerSettings['weekStart'] })}>
          <option value="auto">{copy.settings.weekAuto}</option>
          <option value="monday">{copy.settings.weekMonday}</option>
          <option value="sunday">{copy.settings.weekSunday}</option>
        </Select>
      </div>
    </div>

    <div className="settings-card">
      <div className="settings-card-title">{copy.settings.prices}</div>
      <p>{copy.settings.pricesHint}</p>
      <div className="settings-price-table">
        <div className="settings-price-head" aria-hidden="true">
          <span>{copy.settings.model}</span>
          {PRICE_FIELDS.map(field => <span key={field}>{priceFieldLabel(field, copy)}</span>)}
          <span />
        </div>
        {priceRows.length === 0 && <p className="settings-price-empty">{copy.settings.noPrices}</p>}
        {priceRows.map(model => <div key={model} className="settings-price-row">
          <span className="settings-price-model" title={model}>{model}</span>
          {PRICE_FIELDS.map(field => <input key={field} inputMode="decimal" className="settings-price-input" value={prices[model]?.[field] ?? ''}
            aria-label={`${model} ${priceFieldLabel(field, copy)}`} disabled={saving}
            onChange={event => editPrice(model, field, event.target.value)} />)}
          <button type="button" className="icon-btn icon-btn-sm" aria-label={`${copy.settings.removePrice} ${model}`} title={copy.settings.removePrice}
            disabled={saving} onClick={() => { setPrices(state => Object.fromEntries(Object.entries(state).filter(([key]) => key !== model))); setSaved(undefined); }}><Icon name="close" /></button>
        </div>)}
        <div className="settings-price-row is-new">
          <input className="settings-price-model-input" value={newModel} placeholder={copy.settings.model} aria-label={copy.settings.model}
            disabled={saving} onChange={event => setNewModel(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') addModel(); }} />
          <span className="settings-price-add">
            <button type="button" className="btn btn-sm" disabled={saving || !newModel.trim()} onClick={addModel}>{copy.settings.addPrice}</button>
          </span>
        </div>
      </div>
      <div className="settings-price-foot">
        <button type="button" className="btn btn-primary btn-sm" disabled={saving || !pricesDirty} onClick={savePrices}>{saving ? copy.settings.saving : copy.settings.save}</button>
        {saved && <span role="status" className="settings-price-note">{saved}</span>}
      </div>
    </div>
  </>;
}

const priceFieldLabel = (field: typeof PRICE_FIELDS[number], copy: UsageCopy) =>
  field === 'input' ? copy.settings.input : field === 'output' ? copy.settings.output : field === 'cacheRead' ? copy.settings.cacheRead
    : field === 'cacheWrite5m' ? copy.settings.cacheWrite5m : copy.settings.cacheWrite1h;
