import React from 'react';
import { Virtuoso } from 'react-virtuoso';
import { FileText, Files, Loader2, User, Wrench } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import SessionProviderLogo from '../../SessionProviderLogo';
import type { ChatMessage } from '../types/chatTypes';
import { PROVIDER_THEME } from '../utils/chatConstants';
import { compactMessageText, shouldRenderAsPreformatted, getProviderDisplayName } from '../utils/chatUtils';
import { MermaidBlock } from './MermaidBlock';

type MessageListProps = {
  messages: ChatMessage[];
  historyLoading: boolean;
  messagesContainerRef: React.RefObject<HTMLDivElement>;
  messagesEndRef: React.RefObject<HTMLDivElement>;
};

export default function MessageList({
  messages,
  historyLoading,
  messagesContainerRef,
  messagesEndRef,
}: MessageListProps) {
  const { t } = useTranslation('chat');

  if (historyLoading) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2.5">
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          {t('session.loading.sessionMessages')}
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2.5">
        <div className="h-full flex items-center justify-center text-center px-6">
          <div>
            <p className="text-sm font-medium text-foreground mb-1">{t('session.continue.title')}</p>
            <p className="text-xs text-muted-foreground">{t('session.continue.description')}</p>
          </div>
        </div>
      </div>
    );
  }

  function renderMessage(_index: number, message: ChatMessage) {
    const isUser = message.kind === 'user';
    const isAssistant = message.kind === 'assistant';
    const isError = message.kind === 'error';
    const isTool = message.kind === 'tool';
    const isThinking = message.kind === 'thinking';
    const messageTheme = PROVIDER_THEME[message.provider] || PROVIDER_THEME.claude;
    const normalizedBody = compactMessageText(message.text || (message.streaming ? t('thinking.emoji') : ''));
    const usePreformattedBody = (isAssistant || isUser) && shouldRenderAsPreformatted(normalizedBody);
    const fileCount = message.files?.length || 0;
    const loadedFileCount = message.files?.filter((file) => file.loaded).length || 0;
    const failedFileCount = fileCount - loadedFileCount;
    const truncatedFileCount = message.files?.filter((file) => file.truncated).length || 0;

    return (
      <div className="px-3 pt-2.5">
        <div className={`w-full flex ${isUser ? 'justify-end' : 'justify-start'}`}>
          <div
            className={`max-w-[86%] rounded-xl border px-3 py-2 ${
              isUser
                ? messageTheme.userBubble
                : isError
                  ? 'bg-red-50 border-red-200 text-red-700 dark:bg-red-950/30 dark:text-red-200 dark:border-red-900/40'
                  : isThinking
                    ? 'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-950/30 dark:text-amber-200 dark:border-amber-900/40'
                    : isTool
                      ? 'bg-blue-50 border-blue-200 text-blue-700 dark:bg-blue-950/30 dark:text-blue-200 dark:border-blue-900/40'
                      : messageTheme.assistantBubble
            }`}
          >
            <div className="flex items-center gap-1.5 text-[11px] opacity-80 mb-1">
              {isUser ? <User className="w-3 h-3" /> : isTool ? <Wrench className="w-3 h-3" /> : <SessionProviderLogo provider={message.provider} className="w-3 h-3" />}
              <span>
                {isUser ? 'You' : isThinking ? t('thinking.title') : getProviderDisplayName(message.provider)}
              </span>
              {message.streaming && <span className="chat-typing-dots"><i /><i /><i /></span>}
            </div>

            <div className="text-[14px] break-words leading-6 tracking-normal">
              {isAssistant || isUser ? (
                usePreformattedBody ? (
                  <pre className="m-0 overflow-x-auto rounded-md bg-muted/70 p-2 text-[12px] leading-5 font-mono whitespace-pre">
                    {normalizedBody}
                  </pre>
                ) : (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      p({ children }) {
                        return <p className="my-0 leading-6">{children}</p>;
                      },
                      ul({ children }) {
                        return <ul className="my-1 list-disc pl-4 space-y-0.5">{children}</ul>;
                      },
                      ol({ children }) {
                        return <ol className="my-1 list-decimal pl-4 space-y-0.5">{children}</ol>;
                      },
                      li({ children }) {
                        return <li className="leading-6">{children}</li>;
                      },
                      code({ children, className }) {
                        const langMatch = /language-(\w+)/.exec(className || '');
                        if (langMatch?.[1] === 'mermaid') {
                          return <MermaidBlock code={String(children).replace(/\n$/, '')} />;
                        }
                        return (
                          <code className="rounded bg-muted px-1 py-0.5 text-[12px]">
                            {children}
                          </code>
                        );
                      },
                      pre({ children }) {
                        // When the code component renders a MermaidBlock, unwrap from <pre>
                        if (
                          React.isValidElement(children) &&
                          (children.props as Record<string, unknown>)?.className?.toString().includes('language-mermaid')
                        ) {
                          return <>{children}</>;
                        }
                        return (
                          <pre className="m-0 overflow-x-auto rounded-md bg-muted p-2 text-[12px] leading-5">
                            {children}
                          </pre>
                        );
                      },
                      table({ children }) {
                        return (
                          <div className="my-1.5 overflow-x-auto rounded-md border border-border/70">
                            <table className="w-full min-w-[420px] border-collapse text-xs">
                              {children}
                            </table>
                          </div>
                        );
                      },
                      thead({ children }) {
                        return <thead className="bg-muted/60">{children}</thead>;
                      },
                      tbody({ children }) {
                        return <tbody>{children}</tbody>;
                      },
                      tr({ children }) {
                        return <tr className="border-b border-border/60">{children}</tr>;
                      },
                      th({ children }) {
                        return (
                          <th className="border-r border-border/60 px-2 py-1 text-left font-semibold align-top last:border-r-0">
                            {children}
                          </th>
                        );
                      },
                      td({ children }) {
                        return (
                          <td className="border-r border-border/40 px-2 py-1 align-top last:border-r-0">
                            {children}
                          </td>
                        );
                      },
                    }}
                  >
                    {normalizedBody}
                  </ReactMarkdown>
                )
              ) : (
                <pre className="m-0 whitespace-pre-wrap break-words font-sans text-[14px] leading-6">
                  {normalizedBody}
                </pre>
              )}
            </div>

            {message.files && message.files.length > 0 && (
              isUser ? (
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-black/10 px-2.5 py-1 text-[11px] text-white/90">
                  <Files className="w-3 h-3" />
                  <span>Attached {fileCount} path{fileCount > 1 ? 's' : ''}</span>
                  {failedFileCount > 0 && <span>· {failedFileCount} failed</span>}
                  {truncatedFileCount > 0 && <span>· {truncatedFileCount} truncated</span>}
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {message.files.map((file) => (
                    <span
                      key={`${message.id}-${file.path}`}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
                        file.loaded
                          ? 'bg-background/70 border-border'
                          : 'bg-red-100 border-red-300 text-red-700 dark:bg-red-900/40 dark:border-red-800 dark:text-red-200'
                      }`}
                    >
                      <FileText className="w-3 h-3" />
                      {file.path}
                      {file.truncated ? ' (truncated)' : ''}
                      {file.error ? ` (${file.error})` : ''}
                    </span>
                  ))}
                </div>
              )
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <Virtuoso
      data={messages}
      followOutput="smooth"
      className="flex-1 min-h-0"
      scrollerRef={(ref) => {
        if (ref instanceof HTMLDivElement) {
          (messagesContainerRef as React.MutableRefObject<HTMLDivElement>).current = ref;
        }
      }}
      itemContent={renderMessage}
      components={{
        Footer: () => <div ref={messagesEndRef} className="h-2.5" />,
      }}
    />
  );
}
