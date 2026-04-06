import type { Project, ProjectSession, SessionProvider } from '../../types/app';
import { useChatPanel } from './hooks/useChatPanel';
import SessionHeader from './components/SessionHeader';
import MessageList from './components/MessageList';
import InputArea from './components/InputArea';
import PermissionRequestCard from './components/PermissionRequestCard';

type ChatPanelProps = {
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  sendMessage: (message: unknown) => boolean;
  latestMessage: any | null;
  messageSequence: number;
  getBufferedMessagesSince: (sequence: number) => Array<{ sequence: number; message: any }>;
  externalMessageUpdate?: number;
  onSessionActive?: (sessionId?: string | null) => void;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  onReplaceTemporarySession?: (sessionId?: string | null) => void;
  onNavigateToSession?: (targetSessionId: string) => void;
};

export default function ChatPanel(props: ChatPanelProps) {
  const chat = useChatPanel(props);

  return (
    <div className={`h-full flex flex-col ${chat.providerTheme.panel}`}>
      <SessionHeader
        activeProvider={chat.activeProvider}
        providerTheme={chat.providerTheme}
        model={chat.model}
        canSwitchModelInSession={chat.canSwitchModelInSession}
        isSessionActive={Boolean(props.selectedSession?.id)}
        onProviderChange={(p: SessionProvider) => chat.setProvider(p)}
        onModelChange={chat.setModel}
      />

      <MessageList
        messages={chat.messages}
        historyLoading={chat.historyLoading}
        messagesContainerRef={chat.messagesContainerRef}
        messagesEndRef={chat.messagesEndRef}
      />

      {chat.pendingPermission && (
        <div className="px-4 pb-2">
          <PermissionRequestCard
            permission={chat.pendingPermission}
            onRespond={chat.handlePermissionResponse}
          />
        </div>
      )}

      <InputArea
        input={chat.input}
        isSending={chat.isSending}
        phase={chat.phase}
        phaseLabel={chat.phaseLabel}
        attachedFiles={chat.attachedFiles}
        onSetAttachedFiles={chat.setAttachedFiles}
        isFilePickerOpen={chat.isFilePickerOpen}
        onSetIsFilePickerOpen={chat.setIsFilePickerOpen}
        filePickerQuery={chat.filePickerQuery}
        onSetFilePickerQuery={chat.setFilePickerQuery}
        filePickerView={chat.filePickerView}
        onSetFilePickerView={chat.setFilePickerView}
        filePickerSuggestions={chat.filePickerSuggestions}
        projectFileTree={chat.projectFileTree}
        expandedDirectories={chat.expandedDirectories}
        onToggleDirectoryExpanded={chat.toggleDirectoryExpanded}
        onToggleAttachedFile={chat.toggleAttachedFile}
        onSelectAllFromCurrentPickerView={chat.selectAllFromCurrentPickerView}
        isLoadingFiles={chat.isLoadingFiles}
        isMentionOpen={chat.isMentionOpen}
        mentionSuggestions={chat.mentionSuggestions}
        mentionActiveIndex={chat.mentionActiveIndex}
        onSetMentionActiveIndex={chat.setMentionActiveIndex}
        onSelectMention={chat.handleSelectMention}
        isCmdOpen={chat.isCmdOpen}
        cmdQuery={chat.cmdQuery}
        cmdActiveIndex={chat.cmdActiveIndex}
        cmdFilteredCount={chat.cmdFilteredCommands.length}
        onSelectCommand={chat.handleSelectCommand}
        onSend={() => void chat.sendChatMessage()}
        onAbort={chat.abortCurrentRequest}
        providerTheme={chat.providerTheme}
        activeProvider={chat.activeProvider}
        selectedProject={chat.selectedProject}
        inputRef={chat.inputRef}
        filePickerRef={chat.filePickerRef}
        filePickerToggleRef={chat.filePickerToggleRef}
        onInputChange={chat.handleInputChange}
        onInputKeyDown={chat.handleInputKeyDown}
        onInputSelect={chat.handleInputSelect}
        onInputFocus={chat.handleInputFocus}
        onInputBlur={chat.handleInputBlur}
        onCompositionStart={chat.handleCompositionStart}
        onCompositionEnd={chat.handleCompositionEnd}
      />
    </div>
  );
}
