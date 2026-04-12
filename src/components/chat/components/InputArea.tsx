import { Check, ChevronDown, ChevronRight, FileText, Files, Folder, Loader2, Send, Square, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SessionProvider, Project } from '../../../types/app';
import type { ChatPhase, FlatFileNode, FileTreeNode, MentionSuggestionItem, ProviderThemeConfig } from '../types/chatTypes';
import type { DiscoveredCommand } from '../../../lib/tauri-bridge';
import CommandSuggestions from './CommandSuggestions';

type InputAreaProps = {
  // Core state
  input: string;
  isSending: boolean;
  phase: ChatPhase;
  phaseLabel: string;

  // File attachments
  attachedFiles: string[];
  onSetAttachedFiles: React.Dispatch<React.SetStateAction<string[]>>;

  // File picker
  isFilePickerOpen: boolean;
  onSetIsFilePickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  filePickerQuery: string;
  onSetFilePickerQuery: (query: string) => void;
  filePickerView: 'search' | 'tree';
  onSetFilePickerView: (view: 'search' | 'tree') => void;
  filePickerSuggestions: FlatFileNode[];
  projectFileTree: FileTreeNode[];
  expandedDirectories: Record<string, boolean>;
  onToggleDirectoryExpanded: (path: string) => void;
  onToggleAttachedFile: (filePath: string) => void;
  onSelectAllFromCurrentPickerView: () => void;
  isLoadingFiles: boolean;

  // Mentions
  isMentionOpen: boolean;
  mentionSuggestions: MentionSuggestionItem[];
  mentionActiveIndex: number;
  onSetMentionActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  onSelectMention: (filePath: string, isSkill?: boolean) => void;

  // Command suggestions
  isCmdOpen: boolean;
  cmdQuery: string;
  cmdActiveIndex: number;
  cmdFilteredCount: number;
  onSelectCommand: (cmd: string) => void;
  discoveredCommands?: DiscoveredCommand[];

  // Actions
  onSend: () => void;
  onAbort: () => void;

  // Theme & config
  providerTheme: ProviderThemeConfig;
  activeProvider: SessionProvider;
  selectedProject: Project;

  // Refs
  inputRef: React.RefObject<HTMLTextAreaElement>;
  filePickerRef: React.RefObject<HTMLDivElement>;
  filePickerToggleRef: React.RefObject<HTMLButtonElement>;

  // Event handler delegates
  onInputChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onInputKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onInputSelect: (event: React.SyntheticEvent<HTMLTextAreaElement>) => void;
  onInputFocus: (event: React.FocusEvent<HTMLTextAreaElement>) => void;
  onInputBlur: () => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
};

const renderFileTreeNodes = (
  nodes: FileTreeNode[],
  expandedDirectories: Record<string, boolean>,
  attachedFiles: string[],
  providerTheme: ProviderThemeConfig,
  onToggleDirectoryExpanded: (path: string) => void,
  onToggleAttachedFile: (filePath: string) => void,
  depth = 0,
): JSX.Element[] => nodes.map((node) => {
  const rowPadding = 8 + depth * 16;

  if (node.type === 'directory') {
    const isExpanded = expandedDirectories[node.path] !== false;
    const childNodes = Array.isArray(node.children) ? node.children : [];

    return (
      <div key={node.path}>
        <button
          type="button"
          onClick={() => onToggleDirectoryExpanded(node.path)}
          className="w-full py-1.5 text-left text-xs hover:bg-accent flex items-center gap-1 rounded-sm"
          style={{ paddingLeft: rowPadding }}
        >
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          )}
          <Folder className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <span className="truncate">{node.name}</span>
        </button>
        {isExpanded && childNodes.length > 0 ? renderFileTreeNodes(childNodes, expandedDirectories, attachedFiles, providerTheme, onToggleDirectoryExpanded, onToggleAttachedFile, depth + 1) : null}
      </div>
    );
  }

  const selected = attachedFiles.includes(node.path);
  return (
    <button
      key={node.path}
      type="button"
      onClick={() => onToggleAttachedFile(node.path)}
      className={`w-full py-1.5 text-left text-xs hover:bg-accent flex items-center gap-2 rounded-sm ${
        selected ? providerTheme.activePickRow : ''
      }`}
      style={{ paddingLeft: rowPadding + 16 }}
    >
      <span className={`inline-flex h-4 w-4 items-center justify-center rounded border ${
        selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
      }`}>
        {selected ? <Check className="w-3 h-3" /> : null}
      </span>
      <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <span className="truncate">{node.name}</span>
    </button>
  );
});

export default function InputArea({
  input,
  isSending,
  phase,
  phaseLabel,
  attachedFiles,
  onSetAttachedFiles,
  isFilePickerOpen,
  onSetIsFilePickerOpen,
  filePickerQuery,
  onSetFilePickerQuery,
  filePickerView,
  onSetFilePickerView,
  filePickerSuggestions,
  projectFileTree,
  expandedDirectories,
  onToggleDirectoryExpanded,
  onToggleAttachedFile,
  onSelectAllFromCurrentPickerView,
  isLoadingFiles,
  isMentionOpen,
  mentionSuggestions,
  mentionActiveIndex,
  onSetMentionActiveIndex: _onSetMentionActiveIndex,
  onSelectMention,
  isCmdOpen,
  cmdQuery,
  cmdActiveIndex,
  cmdFilteredCount: _cmdFilteredCount,
  onSelectCommand,
  discoveredCommands,
  onSend,
  onAbort,
  providerTheme,
  activeProvider,
  selectedProject,
  inputRef,
  filePickerRef,
  filePickerToggleRef,
  onInputChange,
  onInputKeyDown,
  onInputSelect,
  onInputFocus,
  onInputBlur,
  onCompositionStart,
  onCompositionEnd,
}: InputAreaProps) {
  const { t } = useTranslation('chat');

  return (
    <div className={`border-t border-border/60 p-3.5 ${providerTheme.composer}`}>
      {phase !== 'idle' && isSending && (
        <div className="mb-2 text-xs text-muted-foreground flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>{phaseLabel}</span>
        </div>
      )}

      {attachedFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachedFiles.map((filePath) => (
            <button
              key={filePath}
              type="button"
              onClick={() => onSetAttachedFiles((prev) => prev.filter((item) => item !== filePath))}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs hover:bg-muted"
            >
              <FileText className="w-3 h-3" />
              <span>{filePath}</span>
              <XCircle className="w-3 h-3" />
            </button>
          ))}
        </div>
      )}

      <div className="relative">
        {isFilePickerOpen && (
          <div
            ref={filePickerRef}
            className={`absolute bottom-full mb-2 left-0 right-0 h-[min(62vh,560px)] min-h-[280px] max-h-[72vh] resize-y rounded-md border bg-popover shadow-md z-30 overflow-hidden flex flex-col ${providerTheme.picker}`}
            onWheelCapture={(event) => event.stopPropagation()}
          >
            <div className="border-b border-border/70 p-2 space-y-2 sticky top-0 bg-popover z-10">
              <div className="rounded-md border border-border/70 bg-muted/40 p-2">
                <div className="mb-1 text-[11px] font-medium text-foreground/90">视图切换</div>
                <div className="inline-flex h-9 w-full items-center rounded-md border border-input p-0.5 bg-background">
                  <button
                    type="button"
                    onClick={() => onSetFilePickerView('tree')}
                    className={`inline-flex h-7 flex-1 items-center justify-center gap-1 rounded px-2.5 text-xs font-medium ${
                      filePickerView === 'tree'
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    <Folder className="w-3 h-3" />
                    {"\u76ee\u5f55"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSetFilePickerView('search')}
                    className={`inline-flex h-7 flex-1 items-center justify-center gap-1 rounded px-2.5 text-xs font-medium ${
                      filePickerView === 'search'
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    <FileText className="w-3 h-3" />
                    {"\u641c\u7d22"}
                  </button>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">{"\u76ee\u5f55\u4ec5\u5c55\u5f00\uff0c\u53ea\u80fd\u52fe\u9009\u6587\u4ef6"}</div>
              </div>

              {filePickerView === 'search' && (
                <input
                  value={filePickerQuery}
                  onChange={(event) => onSetFilePickerQuery(event.target.value)}
                  placeholder={"\u6309\u8def\u5f84\u641c\u7d22\u6587\u4ef6..."}
                  className="mobile-ime-input h-8 w-full rounded-md border border-input bg-background px-2 text-xs focus:outline-none"
                />
              )}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onSelectAllFromCurrentPickerView}
                  className="h-8 rounded-md border border-input px-2 text-xs hover:bg-accent whitespace-nowrap"
                >
                  {filePickerView === 'tree' ? '\u5168\u9009\u6587\u4ef6' : '\u5168\u9009\u5f53\u524d\u641c\u7d22\u7ed3\u679c'}
                </button>
                <button
                  type="button"
                  onClick={() => onSetAttachedFiles([])}
                  className="h-8 rounded-md border border-input px-2 text-xs hover:bg-accent whitespace-nowrap"
                >
                  {"\u6e05\u7a7a"}
                </button>
                <button
                  type="button"
                  onClick={() => onSetIsFilePickerOpen(false)}
                  className="ml-auto h-8 rounded-md border border-input px-2 text-xs hover:bg-accent whitespace-nowrap"
                >
                  {"\u5b8c\u6210"}
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-1">
              {filePickerView === 'search' ? (
                filePickerSuggestions.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-muted-foreground">{"\u672a\u627e\u5230\u5339\u914d\u6587\u4ef6"}</div>
                ) : (
                  filePickerSuggestions.map((file) => {
                    const selected = attachedFiles.includes(file.path);
                    return (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() => onToggleAttachedFile(file.path)}
                        className={`w-full px-2 py-1.5 text-left text-xs hover:bg-accent flex items-center gap-2 rounded-sm ${
                          selected ? providerTheme.activePickRow : ''
                        }`}
                      >
                        <span className={`inline-flex h-4 w-4 items-center justify-center rounded border ${
                          selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                        }`}>
                          {selected ? <Check className="w-3 h-3" /> : null}
                        </span>
                        <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="truncate">{file.path}</span>
                      </button>
                    );
                  })
                )
              ) : (
                projectFileTree.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-muted-foreground">{"\u6682\u65e0\u53ef\u7528\u6587\u4ef6"}</div>
                ) : (
                  renderFileTreeNodes(projectFileTree, expandedDirectories, attachedFiles, providerTheme, onToggleDirectoryExpanded, onToggleAttachedFile)
                )
              )}
            </div>
          </div>
        )}

        {isMentionOpen && mentionSuggestions.length > 0 && (
          <div className={`absolute bottom-full mb-2 left-0 right-0 max-h-56 overflow-y-auto rounded-md border bg-popover shadow-md z-30 ${providerTheme.picker}`}>
            {mentionSuggestions.map((file, index) => (
              <button
                key={file.isSkill ? `skill:${file.path}` : file.path}
                type="button"
                onClick={() => onSelectMention(file.path, file.isSkill)}
                className={`w-full px-2 py-1.5 text-left text-xs hover:bg-accent flex items-center gap-2 ${
                  index === mentionActiveIndex ? providerTheme.activePickRow : ''
                }`}
              >
                {file.isSkill ? (
                  <span className="w-3.5 h-3.5 flex-shrink-0 text-center">🧩</span>
                ) : file.type === 'directory' ? (
                  <Folder className="w-3.5 h-3.5 text-muted-foreground" />
                ) : (
                  <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                )}
                <span className="truncate">{file.isSkill ? (file.displayName || file.path) : file.path}</span>
                {file.isSkill && file.description && (
                  <span className="text-muted-foreground truncate ml-1">{file.description}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {isCmdOpen && (
          <CommandSuggestions
            provider={activeProvider}
            query={cmdQuery}
            onSelect={onSelectCommand}
            onClose={() => {/* handled by keydown */}}
            activeIndex={cmdActiveIndex}
            discoveredCommands={discoveredCommands}
          />
        )}

        <textarea
          ref={inputRef}
          value={input}
          onChange={onInputChange}
          onKeyDown={onInputKeyDown}
          onSelect={onInputSelect}
          onFocus={onInputFocus}
          onBlur={onInputBlur}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          placeholder={
            selectedProject
              ? t('input.placeholder', { provider: activeProvider })
              : t('projectSelection.startChatWithProvider', { provider: activeProvider })
          }
          className="mobile-ime-input w-full min-h-[96px] max-h-56 resize-none sm:resize-y rounded-md border border-input bg-background px-3 py-2.5 text-[14px] leading-6 focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="text-[11px] text-muted-foreground flex items-center gap-2">
          <button
            ref={filePickerToggleRef}
            type="button"
            onClick={() => {
              onSetIsFilePickerOpen((prev) => {
                const next = !prev;
                if (next) {
                  onSetFilePickerView('tree');
                }
                return next;
              });
            }}
            className="inline-flex items-center gap-1 rounded border border-input px-2 py-1 hover:bg-accent text-[11px]"
          >
            <Files className="w-3 h-3" />
            {"\u591a\u9009\u6587\u4ef6"}
          </button>
          <span>{"@ \u5feb\u901f\u5f15\u7528"}</span>
          {isLoadingFiles && <span>{"\u6b63\u5728\u52a0\u8f7d\u6587\u4ef6..."}</span>}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onAbort}
            disabled={!isSending}
            className="inline-flex items-center gap-1 rounded-md border border-input px-2.5 py-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Square className="w-3.5 h-3.5" />
            {t('input.stop')}
          </button>
          <button
            type="button"
            onClick={onSend}
            disabled={isSending || !input.trim()}
            className={`inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed ${providerTheme.sendButton}`}
          >
            <Send className="w-3.5 h-3.5" />
            {t('input.send')}
          </button>
        </div>
      </div>
    </div>
  );
}
