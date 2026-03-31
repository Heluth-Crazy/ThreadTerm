import React from 'react';

import FileTree from '../../FileTree';
import GitPanel from '../../GitPanel';
import ErrorBoundary from '../../ErrorBoundary';
import { TerminalGrid, HybridTerminalGrid } from '../../terminal-grid';
import ChatPanel from '../../chat/ChatPanel';

import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import type { MainContentProps } from '../types/types';

const AnyGitPanel = GitPanel as any;

function WorkspaceFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-hidden bg-background">
      <div className="mx-auto flex h-full w-full max-w-[1600px] flex-col px-4 py-4 sm:px-5 lg:px-6">{children}</div>
    </div>
  );
}

function WorkspaceShell({
  header,
  body,
  bodyClassName = 'px-2 pb-2 pt-2 sm:px-3 sm:pb-3',
}: {
  header?: React.ReactNode;
  body: React.ReactNode;
  bodyClassName?: string;
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[24px] border border-border/60 bg-card/72 shadow-sm">
      {header ? <div className="flex-shrink-0 px-2 pt-2 sm:px-3 sm:pt-3">{header}</div> : null}
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>
        <div className="h-full overflow-hidden rounded-[20px] border border-border/60 bg-background/92">{body}</div>
      </div>
    </section>
  );
}

function MainContent({
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  projects,
  sendMessage,
  latestMessage,
  messageSequence,
  getBufferedMessagesSince,
  isLoading,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  onReplaceTemporarySession,
  onNavigateToSession,
  externalMessageUpdate,
}: MainContentProps) {
  const showEmpty = !selectedProject && activeTab !== 'hybrid';
  const showProjectLanding = Boolean(selectedProject && !selectedSession && (activeTab === 'chat' || activeTab === 'shell'));

  const header = (
    <div className="overflow-hidden rounded-[20px] border border-border/60 bg-background/95">
      <MainContentHeader
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
      />
    </div>
  );

  if (isLoading) {
    return (
      <WorkspaceFrame>
        <WorkspaceShell
          bodyClassName="px-2 py-2 sm:px-3 sm:py-3"
          body={<MainContentStateView mode="loading" />}
        />
      </WorkspaceFrame>
    );
  }

  if (showEmpty) {
    return (
      <WorkspaceFrame>
        <WorkspaceShell
          header={header}
          body={<MainContentStateView mode="empty" />}
        />
      </WorkspaceFrame>
    );
  }

  if (showProjectLanding) {
    return (
      <WorkspaceFrame>
        <WorkspaceShell
          header={header}
          body={
            <MainContentStateView
              mode="project"
              projectName={selectedProject?.displayName || selectedProject?.name || ''}
            />
          }
        />
      </WorkspaceFrame>
    );
  }

  const body = (
    <>
      {activeTab === 'shell' && selectedProject ? (
        <div className="h-full w-full overflow-hidden">
          <ErrorBoundary showDetails>
            <TerminalGrid project={selectedProject} session={selectedSession} />
          </ErrorBoundary>
        </div>
      ) : null}

      {activeTab === 'chat' && selectedProject ? (
        <div className="h-full w-full overflow-hidden">
          <ErrorBoundary showDetails>
            <ChatPanel
              selectedProject={selectedProject}
              selectedSession={selectedSession}
              sendMessage={sendMessage}
              latestMessage={latestMessage}
              messageSequence={messageSequence}
              getBufferedMessagesSince={getBufferedMessagesSince}
              externalMessageUpdate={externalMessageUpdate}
              onSessionActive={onSessionActive}
              onSessionInactive={onSessionInactive}
              onSessionProcessing={onSessionProcessing}
              onSessionNotProcessing={onSessionNotProcessing}
              onReplaceTemporarySession={onReplaceTemporarySession}
              onNavigateToSession={onNavigateToSession}
            />
          </ErrorBoundary>
        </div>
      ) : null}

      {activeTab === 'files' && selectedProject ? (
        <div className="h-full overflow-hidden">
          <FileTree selectedProject={selectedProject} onFileOpen={() => {}} />
        </div>
      ) : null}

      {activeTab === 'git' && selectedProject ? (
        <div className="h-full overflow-hidden">
          <AnyGitPanel selectedProject={selectedProject} onFileOpen={() => {}} />
        </div>
      ) : null}

      {activeTab === 'hybrid' ? (
        <div className="h-full overflow-hidden">
          <ErrorBoundary showDetails>
            <HybridTerminalGrid projects={projects} />
          </ErrorBoundary>
        </div>
      ) : null}
    </>
  );

  return (
    <WorkspaceFrame>
      <WorkspaceShell header={header} body={body} />
    </WorkspaceFrame>
  );
}

export default MainContent;
