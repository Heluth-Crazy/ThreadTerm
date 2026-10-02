import { useId, useState, type FormEvent } from "react";
import { chooseDirectory, operationId, request } from "../bridge";
import { useTranslation } from "../i18n";
import { Icon } from "./PrototypeIcon";
import { SurfaceDialog } from "./SurfaceDialog";
import "./session-create-dialog.css";

type Props = { onClose: () => void; onCreated: (id: string) => void };

const folderName = (value: string) => value.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ?? "";

export function AddProjectDialog({ onClose, onCreated }: Props) {
  const { locale } = useTranslation();
  const zh = locale === "zh-CN";
  const tx = (en: string, cn: string) => zh ? cn : en;
  const formId = useId();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [namedByUser, setNamedByUser] = useState(false);
  const [issue, setIssue] = useState<string>();
  const [busy, setBusy] = useState(false);
  const applyPath = (next: string) => {
    setPath(next);
    if (!namedByUser) setName(folderName(next));
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!path.trim()) {
      setIssue(tx("Choose a project directory before adding it.", "请先选择项目目录再添加。"));
      return;
    }
    setBusy(true);
    setIssue(undefined);
    try {
      const project = await request("project.add", {
        path: path.trim(),
        name: name.trim() || undefined,
        operationId: operationId(),
      });
      onCreated(project.id);
    } catch (caught) {
      setIssue(caught instanceof Error ? caught.message : tx("Project was not added.", "项目未添加。"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SurfaceDialog
      title={tx("Add project", "添加项目")}
      subtitle={tx("Choose a local directory. No command is started automatically.", "选择本地目录，不会自动运行命令。")}
      icon="folder"
      variant="create"
      onClose={() => { if (!busy) onClose(); }}
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>{tx("Cancel", "取消")}</button>
          <button className="btn btn-primary" disabled={busy || !path.trim()} type="submit" form={formId}>
            {busy ? tx("Adding…", "正在添加…") : tx("Add project", "添加项目")}
          </button>
        </>
      }
    >
      <form id={formId} className="create-form" onSubmit={(event) => void submit(event)}>
        <label className="create-block">
          <span className="create-label">{tx("Directory", "目录路径")}</span>
          <div className="create-path-row">
            <input
              className="create-input create-input-mono"
              value={path}
              onChange={(event) => applyPath(event.target.value)}
              placeholder={tx("Select a local folder", "选择本地文件夹")}
              autoFocus
              required
            />
            <button
              type="button"
              className="create-browse"
              disabled={busy}
              onClick={() => void chooseDirectory().then((value) => { if (value) applyPath(value); })}
            >
              <Icon name="folder" />{tx("Browse", "浏览")}
            </button>
          </div>
          <p className="create-hint">{tx("Git repositories show branches and worktrees. A plain folder can still host sessions.", "Git 仓库会显示分支和工作树；普通目录仍可创建会话。")}</p>
        </label>
        <label className="create-block">
          <span className="create-label">{tx("Display name", "显示名称")} <span className="create-optional">{tx("Optional", "可选")}</span></span>
          <input
            className="create-input"
            maxLength={60}
            value={name}
            onChange={(event) => { setNamedByUser(true); setName(event.target.value); }}
            placeholder={tx("Defaults to the folder name", "默认使用文件夹名称")}
          />
        </label>
        {issue && <p className="surface-error" role="alert">{issue}</p>}
      </form>
    </SurfaceDialog>
  );
}
