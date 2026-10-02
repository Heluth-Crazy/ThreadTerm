import { Select } from "./ui/Select";
import { useEffect, useMemo, useState } from "react";
import type { ProviderId, SessionStatus, Snapshot, UsageRecord, UsageSource } from "@threadterm/protocol";
import { operationId, request } from "../bridge";
import { endOfUtcDay, estimatedCost, knownTokenTrend, parsePrices, savedPrices, type ModelPrices } from "./usageMetrics";

const providers: ProviderId[] = ["codex", "claude", "kimi", "gemini", "opencode", "shell", "grok", "custom"];
const statuses: SessionStatus[] = ["starting", "running", "idle", "waiting", "exited", "interrupted", "error"];
const sources: UsageSource[] = ["created", "native-history", "rerun"];
const pageSize = 5;
type Range = "all" | "today" | "7d";

/** Reference-shaped usage details. Values come only from usage.query records. */
export function UsagePanel({ data, initialProjectId }: { data: Snapshot; initialProjectId?: string }) {
  const zh = data.settings.language === "zh-CN";
  const copy = zh ? zhCopy : en;
  const configuredPrices = useMemo(() => savedPrices(data.settings.modelPrices), [data.settings.modelPrices]);
  const [prices, setPrices] = useState(() => JSON.stringify(configuredPrices, null, 2));
  const [activePrices, setActivePrices] = useState<ModelPrices>(configuredPrices);
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [range, setRange] = useState<Range>("all");
  const [provider, setProvider] = useState<ProviderId | "">("");
  const [model, setModel] = useState("");
  const [status, setStatus] = useState<SessionStatus | "">("");
  const [source, setSource] = useState<UsageSource | "">("");
  const [projectId, setProjectId] = useState(initialProjectId ?? "");
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string>();
  const [saveMessage, setSaveMessage] = useState<string>();

  useEffect(() => { setActivePrices(configuredPrices); setPrices(JSON.stringify(configuredPrices, null, 2)); }, [configuredPrices]);
  useEffect(() => { if (initialProjectId !== undefined) { setProjectId(initialProjectId); setPage(0); } }, [initialProjectId]);
  const dates = rangeDates(range);
  useEffect(() => {
    let current = true;
    void request("usage.query", { provider: provider || undefined, status: status || undefined, source: source || undefined, projectId: projectId || undefined, from: dates.from, to: dates.to }).then(value => {
      if (!current) return;
      setRecords(value.records); setError(undefined);
    }).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : copy.unavailable); });
    return () => { current = false; };
  }, [provider, status, source, projectId, dates.from, dates.to, copy.unavailable]);

  const filtered = useMemo(() => records.filter(row => !model || row.model === model), [records, model]);
  const totals = useMemo(() => filtered.reduce((sum, row) => {
    const tokens = (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
    if (row.inputTokens !== undefined || row.outputTokens !== undefined) { sum.tokens += tokens; sum.known += 1; }
    const cost = estimatedCost(row, activePrices); if (cost !== undefined) { sum.cost += cost; sum.priced += 1; }
    return sum;
  }, { tokens: 0, known: 0, cost: 0, priced: 0 }), [filtered, activePrices]);
  const ranking = useMemo(() => Object.entries(filtered.reduce<Record<string, number>>((sum, row) => { if (row.inputTokens !== undefined || row.outputTokens !== undefined) sum[row.provider] = (sum[row.provider] ?? 0) + (row.inputTokens ?? 0) + (row.outputTokens ?? 0); return sum; }, {})).sort(([, a], [, b]) => b - a), [filtered]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize)); const currentPage = Math.min(page, pages - 1); const visible = filtered.slice(currentPage * pageSize, currentPage * pageSize + pageSize);
  const models = [...new Set(records.map(row => row.model).filter((value): value is string => Boolean(value)))];
  const savePrices = () => { let next: ModelPrices; try { next = parsePrices(prices); } catch (cause) { setSaveMessage(undefined); setError(cause instanceof Error ? cause.message : copy.invalidPrices); return; } void request("settings.update", { patch: { modelPrices: next }, expectedRevision: data.settings.revision, operationId: operationId() }).then(() => { setActivePrices(next); setSaveMessage(copy.pricesSaved); setError(undefined); }).catch(cause => { setSaveMessage(undefined); setError(cause instanceof Error ? cause.message : copy.pricesFailed); }); };
  const changeRange = (next: Range) => { setRange(next); setPage(0); };

  return <section className="usage-details" aria-label={copy.title}>
    <div className="sheet-filters">
      <div className="sheet-chip-row" role="group" aria-label={copy.timeRange}>{(["all", "today", "7d"] as Range[]).map(value => <button key={value} type="button" className="sheet-chip" aria-pressed={range === value} onClick={() => changeRange(value)}>{copy.range[value]}</button>)}</div>
      <div className="sheet-filter-grid">
        {!initialProjectId && <Select value={projectId} aria-label={copy.project} onChange={event => { setProjectId(event.target.value); setPage(0); }}><option value="">{copy.allProjects}</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</Select>}
        <Select value={provider} aria-label={copy.provider} onChange={event => { setProvider(event.target.value as ProviderId | ""); setPage(0); }}><option value="">{copy.allProviders}</option>{providers.map(value => <option value={value} key={value}>{value}</option>)}</Select>
        <Select value={model} aria-label={copy.model} onChange={event => { setModel(event.target.value); setPage(0); }}><option value="">{copy.allModels}</option>{models.map(value => <option value={value} key={value}>{value}</option>)}</Select>
        <Select value={status} aria-label={copy.result} onChange={event => { setStatus(event.target.value as SessionStatus | ""); setPage(0); }}><option value="">{copy.allResults}</option>{statuses.map(value => <option value={value} key={value}>{value}</option>)}</Select>
        <Select value={source} aria-label={copy.source} onChange={event => { setSource(event.target.value as UsageSource | ""); setPage(0); }}><option value="">{copy.allSources}</option>{sources.map(value => <option value={value} key={value}>{value}</option>)}</Select>
      </div>
    </div>
    <div className="sheet-scroll">{error ? <p className="surface-error" role="alert">{error}</p> : <>
      <div className="usage-summary"><b>{totals.priced ? `USD ${totals.cost.toFixed(4)}` : copy.unknown}</b><p>{formatTokens(totals.tokens, totals.known > 0, copy.unknown)} · {filtered.length} {copy.records} · {totals.priced ? copy.priced(totals.priced) : copy.costUnknown}</p><div className="usage-summary-grid"><span>{copy.knownTokens(totals.known, filtered.length)}</span><span>{copy.requestUnknown}</span></div></div>
      <div className="usage-detail-grid"><section><h3 className="sheet-section-label">{copy.recordsTitle}</h3>{visible.length ? visible.map((row, index) => <UsageLog key={`${row.sessionId}-${row.recordedAt}-${index}`} row={row} price={estimatedCost(row, activePrices)} unknown={copy.unknown} />) : <p className="sheet-empty-copy">{copy.empty}</p>}<div className="page-actions"><span className="sheet-foot-meta">{filtered.length} {copy.records} · {copy.page(currentPage + 1, pages)}</span><button className="btn-subtle" type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{copy.previous}</button><button className="btn-subtle" type="button" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}>{copy.next}</button></div></section>
      <aside className="usage-rank"><h3 className="sheet-section-label">{copy.providerRanking}</h3>{ranking.length ? <ol>{ranking.map(([name, tokens]) => <li key={name}><span>{name}</span><b>{formatTokens(tokens, true, copy.unknown)}</b></li>)}</ol> : <p className="sheet-empty-copy">{copy.noKnownTokens}</p>}<UsageTrend records={filtered} label={copy.trend} /></aside></div>
      <details className="usage-pricing"><summary>{copy.pricing}</summary><p>{copy.pricingHint}</p><label>{copy.prices}<textarea value={prices} rows={3} onChange={event => { setPrices(event.target.value); setSaveMessage(undefined); }} spellCheck={false} /></label><button className="btn-subtle" type="button" onClick={savePrices}>{copy.savePrices}</button>{saveMessage && <p role="status">{saveMessage}</p>}</details>
    </>}</div>
  </section>;
}

function UsageLog({ row, price, unknown }: { row: UsageRecord; price: number | undefined; unknown: string }) { const tokens = row.inputTokens === undefined && row.outputTokens === undefined ? unknown : formatTokens((row.inputTokens ?? 0) + (row.outputTokens ?? 0), true, unknown); return <article className="usage-log"><div className="usage-log-top"><b>{row.model ?? `${row.provider} · ${unknown}`}</b><span className={`usage-log-status st-${row.status ?? "unknown"}`}>{row.status ?? unknown}</span></div><div className="usage-log-meta"><span>{new Date(row.recordedAt).toLocaleString()} · {row.provider} · {row.source ?? unknown} · {tokens}</span><span>{price === undefined ? unknown : `USD ${price.toFixed(4)}`}</span></div></article>; }
function UsageTrend({ records, label }: { records: UsageRecord[]; label: string }) { const rows = knownTokenTrend(records); if (!rows.length) return <p className="sheet-empty-copy">{label}: unknown</p>; const max = Math.max(1, ...rows.map(([, value]) => value)); const step = 180 / Math.max(1, rows.length - 1); const points = rows.map(([, value], index) => `${index * step},${32 - value / max * 28}`).join(" "); return <svg className="spark" aria-label={label} viewBox="0 0 180 36" preserveAspectRatio="none"><polyline fill="none" stroke="currentColor" strokeWidth="1.25" points={points} /></svg>; }
function rangeDates(range: Range) { if (range === "all") return { from: undefined, to: undefined }; const end = new Date(); const start = new Date(end); start.setUTCDate(start.getUTCDate() - (range === "today" ? 0 : 6)); return { from: `${start.toISOString().slice(0, 10)}T00:00:00.000Z`, to: endOfUtcDay(end.toISOString().slice(0, 10)) }; }
function formatTokens(value: number, known: boolean, unknown: string) { return known ? `${value.toLocaleString()} Token` : unknown; }
const en = { title:"Usage details",timeRange:"Time range",range:{all:"All",today:"Today","7d":"Last 7 days"},project:"Project",allProjects:"All projects",provider:"Provider",allProviders:"All providers",model:"Model",allModels:"All models",result:"Result",allResults:"All results",source:"Source",allSources:"All sources",unknown:"unknown",records:"records",recordsTitle:"Recorded usage",providerRanking:"Provider ranking",noKnownTokens:"No known token totals.",empty:"No usage records match these filters.",previous:"Previous",next:"Next",page:(page:number,pages:number)=>`Page ${page}/${pages}`,knownTokens:(known:number,total:number)=>`${known}/${total} records have known token values`,requestUnknown:"Request count is unknown",costUnknown:"Cost unknown",priced:(count:number)=>`estimated from ${count} priced records`,trend:"Known token trend",pricing:"Pricing configuration",pricingHint:"Local USD estimates only; saved prices never alter recorded usage.",prices:"Model price JSON per million tokens",savePrices:"Save model prices",pricesSaved:"Model prices saved.",pricesFailed:"Could not save model prices.",invalidPrices:"Invalid model price JSON.",unavailable:"Usage data is unavailable." };
const zhCopy = { ...en, title:"用量明细",timeRange:"时间范围",range:{all:"全部",today:"今日","7d":"近 7 日"},project:"项目",allProjects:"全部项目",provider:"提供商",allProviders:"全部提供商",model:"模型",allModels:"全部模型",result:"结果",allResults:"全部结果",source:"来源",allSources:"全部来源",unknown:"未知",records:"条记录",recordsTitle:"已记录用量",providerRanking:"提供商排行",noKnownTokens:"没有已知 Token 总量。",empty:"没有符合筛选条件的用量记录。",previous:"上一页",next:"下一页",page:(page:number,pages:number)=>`第 ${page}/${pages} 页`,knownTokens:(known:number,total:number)=>`${known}/${total} 条记录有已知 Token`,requestUnknown:"请求数未知",costUnknown:"成本未知",priced:(count:number)=>`来自 ${count} 条已定价记录的估算`,trend:"已知 Token 趋势",pricing:"价格配置",pricingHint:"仅本地 USD 估算；保存价格不会改写已记录用量。",prices:"每百万 Token 的模型价格 JSON",savePrices:"保存模型价格",pricesSaved:"模型价格已保存。",pricesFailed:"无法保存模型价格。",invalidPrices:"模型价格 JSON 无效。",unavailable:"用量数据不可用。" };
