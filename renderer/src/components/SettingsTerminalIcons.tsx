// Settings → Appearance → Terminal icons: which icon a terminal shows while a program runs
// in it. One line per rule; a program saves on blur or Enter, an icon as soon as it is
// picked, and "Upload icon…" adds the user's own. Images go when no rule uses them.
import { useRef, useState, type CSSProperties, type ChangeEvent } from "react";
import type { Settings, TerminalIconSettings } from "@threadterm/protocol";
import { AgentTile, BUILT_IN_ICON_IDS } from "./PrototypeIcon";
import { Select } from "./ui/Select";
import { MAX_TERMINAL_ICON_IMAGES, MAX_TERMINAL_ICON_MATCH, MAX_TERMINAL_ICON_RULES, TERMINAL_ICON_ACCEPT, iconFileName, iconFileProblem, parseTerminalIcons, uniqueIconId, withoutUnusedImages } from "../terminalIcons";
import "./settings-terminal-icons.css";

const UPLOAD = "__upload";
const PENDING = "__pending";
const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", kimi: "Kimi", grok: "Grok", opencode: "OpenCode", pi: "Pi" };
type Draft = { match: string; icon: string; image?: { name: string; src: string } };
const EMPTY_DRAFT: Draft = { match: "", icon: "shell" };

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

export function SettingsTerminalIcons({ settings, zh, update }: { settings: Settings; zh: boolean; update: (patch: Record<string, unknown>) => Promise<void> }) {
  const saved = parseTerminalIcons(settings.terminalIcons);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<string>();
  const picker = useRef<HTMLInputElement>(null);
  // The rule an upload is for; null is the new-rule line.
  const uploadFor = useRef<string | null>(null);
  const text = (cn: string, en: string) => zh ? cn : en;

  const save = async (next: TerminalIconSettings) => {
    if (busy) return false;
    setBusy(true); setIssue(undefined);
    try { await update({ terminalIcons: withoutUnusedImages(next) }); return true; }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)); return false; }
    finally { setBusy(false); }
  };
  const dropEdit = (id: string) => setEdits(current => { const next = { ...current }; delete next[id]; return next; });
  const commitMatch = (id: string) => {
    const value = edits[id];
    if (value === undefined) return;
    dropEdit(id);
    const match = value.trim(), rule = saved.rules.find(item => item.id === id);
    if (!match || !rule || match === rule.match) return;
    void save({ ...saved, rules: saved.rules.map(item => item.id === id ? { ...item, match } : item) });
  };
  const chooseIcon = (id: string | null, value: string) => {
    if (value === PENDING) return;
    if (value === UPLOAD) { uploadFor.current = id; picker.current?.click(); return; }
    if (id === null) { setDraft(current => ({ ...current, icon: value, image: undefined })); return; }
    void save({ ...saved, rules: saved.rules.map(item => item.id === id ? { ...item, icon: value } : item) });
  };
  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (iconFileProblem(file)) { setIssue(text("图标须为 SVG、PNG、WebP、JPG 或 GIF，且不超过 64 KB。", "Icons must be SVG, PNG, WebP, JPG or GIF, up to 64 KB.")); return; }
    if (saved.images.length >= MAX_TERMINAL_ICON_IMAGES) { setIssue(text(`最多保存 ${MAX_TERMINAL_ICON_IMAGES} 个自定义图标。`, `Up to ${MAX_TERMINAL_ICON_IMAGES} custom icons can be saved.`)); return; }
    let src: string;
    try { src = await readDataUrl(file); } catch (error) { setIssue(error instanceof Error ? error.message : String(error)); return; }
    const name = iconFileName(file.name), target = uploadFor.current;
    if (target === null) { setDraft(current => ({ ...current, image: { name, src } })); return; }
    const id = uniqueIconId(name, saved.images);
    void save({ rules: saved.rules.map(item => item.id === target ? { ...item, icon: `image:${id}` } : item), images: [...saved.images, { id, name, src }] });
  };
  const add = async () => {
    const match = draft.match.trim();
    if (!match) return;
    if (saved.rules.length >= MAX_TERMINAL_ICON_RULES) { setIssue(text(`最多保存 ${MAX_TERMINAL_ICON_RULES} 条规则。`, `Up to ${MAX_TERMINAL_ICON_RULES} rules can be saved.`)); return; }
    let images = saved.images, icon = draft.icon;
    if (draft.image) { const id = uniqueIconId(draft.image.name, images); images = [...images, { id, ...draft.image }]; icon = `image:${id}`; }
    if (await save({ rules: [...saved.rules, { id: uniqueIconId(match, saved.rules), match, icon }], images })) setDraft(EMPTY_DRAFT);
  };
  const options = <>
    {BUILT_IN_ICON_IDS.map(id => <option key={id} value={id}>{id === "shell" ? text("终端", "Terminal") : NAMES[id]}</option>)}
    {saved.images.map(image => <option key={image.id} value={`image:${image.id}`}>{image.name}</option>)}
    <option value={UPLOAD}>{text("上传图标…", "Upload icon…")}</option>
  </>;

  return <>
    <div className="setting-divider" />
    <h4>{text("终端图标", "Terminal icons")}</h4>
    <p className="hint">{text("终端运行这些程序时显示对应图标。Claude、Codex、Gemini、Kimi、OpenCode、Grok 和 Pi 无需规则。", "A terminal running one of these programs shows its icon. Claude, Codex, Gemini, Kimi, OpenCode, Grok and Pi need no rule.")}</p>
    <ul className="terminal-icons-list" data-testid="terminal-icons-list">
      {saved.rules.map(rule => <li className="terminal-icons-row" key={rule.id} data-testid="terminal-icon-row">
        <AgentTile provider={rule.icon} size={18} />
        <input type="text" value={edits[rule.id] ?? rule.match} maxLength={MAX_TERMINAL_ICON_MATCH} disabled={busy} aria-label={text("程序", "Program")}
          onChange={event => { const value = event.target.value; setEdits(current => ({ ...current, [rule.id]: value })); }}
          onBlur={() => commitMatch(rule.id)}
          onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") dropEdit(rule.id); }} />
        <Select className="settings-select" value={rule.icon} disabled={busy} aria-label={text("图标", "Icon")} onChange={event => chooseIcon(rule.id, event.target.value)}>{options}</Select>
        <button type="button" className="btn btn-sm btn-danger" disabled={busy} data-testid="terminal-icon-remove" onClick={() => void save({ ...saved, rules: saved.rules.filter(item => item.id !== rule.id) })}>{text("删除", "Remove")}</button>
      </li>)}
      <li className="terminal-icons-row is-new" data-testid="terminal-icon-new">
        {draft.image
          ? <span className="agent-tile agent-tile-shell" style={{ "--s": "18px" } as CSSProperties} aria-hidden="true"><img src={draft.image.src} alt="" /></span>
          : <AgentTile provider={draft.icon} size={18} />}
        <input type="text" value={draft.match} maxLength={MAX_TERMINAL_ICON_MATCH} disabled={busy} placeholder={text("程序，例如 copilot", "Program, e.g. copilot")} aria-label={text("程序", "Program")}
          onChange={event => { const value = event.target.value; setDraft(current => ({ ...current, match: value })); }}
          onKeyDown={event => { if (event.key === "Enter") void add(); }} />
        <Select className="settings-select" value={draft.image ? PENDING : draft.icon} disabled={busy} aria-label={text("图标", "Icon")} onChange={event => chooseIcon(null, event.target.value)}>
          {draft.image && <option value={PENDING}>{draft.image.name}</option>}
          {options}
        </Select>
        <button type="button" className="btn btn-sm" disabled={busy || !draft.match.trim()} data-testid="terminal-icon-add" onClick={() => void add()}>{text("添加", "Add")}</button>
      </li>
    </ul>
    <input ref={picker} type="file" accept={TERMINAL_ICON_ACCEPT} hidden onChange={event => void onFile(event)} />
    {issue && <p className="surface-error" role="alert">{issue}</p>}
  </>;
}
