import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { PendingPermissionRequest } from '../../../stores/sessionStatusStore';

interface PermissionRequestCardProps {
  permission: PendingPermissionRequest;
  onRespond: (allow: boolean, answer?: string) => void;
}

export default function PermissionRequestCard({ permission, onRespond }: PermissionRequestCardProps) {
  const { toolName, input } = permission;

  if (toolName === 'AskUserQuestion') {
    return <AskUserQuestionCard input={input} onRespond={onRespond} />;
  }
  if (toolName === 'exit_plan_mode') {
    return <PlanModeCard input={input} onRespond={onRespond} />;
  }
  return <ToolConfirmCard toolName={toolName} input={input} onRespond={onRespond} />;
}

/* ─── AskUserQuestion ──────────────────────────────────────────────────────── */

interface SubCardProps {
  input: Record<string, unknown>;
  onRespond: (allow: boolean, answer?: string) => void;
}

function AskUserQuestionCard({ input, onRespond }: SubCardProps) {
  const { t } = useTranslation('chat');
  const question = typeof input.question === 'string' ? input.question : '';
  const options = Array.isArray(input.options) ? (input.options as string[]) : null;
  const multiselect = input.multiselect === true;

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedSet, setSelectedSet] = useState<Set<number>>(new Set());
  const [freeformText, setFreeformText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const submitOptions = useCallback(() => {
    if (!options) return;
    if (multiselect) {
      const answers = Array.from(selectedSet)
        .sort((a, b) => a - b)
        .map((i) => options[i])
        .join(', ');
      onRespond(true, answers || options[selectedIndex]);
    } else {
      onRespond(true, options[selectedIndex]);
    }
  }, [options, multiselect, selectedSet, selectedIndex, onRespond]);

  useEffect(() => {
    if (!options) {
      inputRef.current?.focus();
      return;
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, options.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === ' ' && multiselect) {
        e.preventDefault();
        setSelectedSet((prev) => {
          const next = new Set(prev);
          if (next.has(selectedIndex)) next.delete(selectedIndex);
          else next.add(selectedIndex);
          return next;
        });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (multiselect) {
          submitOptions();
        } else {
          onRespond(true, options[selectedIndex]);
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [options, multiselect, selectedIndex, selectedSet, onRespond, submitOptions]);

  return (
    <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-4 mb-3 shadow-sm">
      <p className="text-xs font-medium text-blue-400 mb-2">{t('permission.askQuestion')}</p>
      <p className="font-semibold mb-3 whitespace-pre-wrap">{question}</p>

      {options ? (
        <>
          <div className="flex flex-col gap-1.5 mb-3">
            {options.map((opt, i) => {
              const isSelected = multiselect ? selectedSet.has(i) : i === selectedIndex;
              return (
                <button
                  key={i}
                  className={`px-3 py-2 rounded-lg border text-sm text-left transition-colors ${
                    isSelected
                      ? 'border-blue-400 bg-blue-500/20 font-medium'
                      : 'border-white/10 hover:border-white/20'
                  }`}
                  onClick={() => {
                    if (multiselect) {
                      setSelectedIndex(i);
                      setSelectedSet((prev) => {
                        const next = new Set(prev);
                        if (next.has(i)) next.delete(i);
                        else next.add(i);
                        return next;
                      });
                    } else {
                      onRespond(true, opt);
                    }
                  }}
                >
                  {multiselect && (
                    <span className="inline-block w-4 mr-2 text-center">
                      {selectedSet.has(i) ? '☑' : '☐'}
                    </span>
                  )}
                  {opt}
                </button>
              );
            })}
          </div>
          {multiselect && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/50">{t('permission.multiSelectHint')}</span>
              <button
                className="bg-green-600 hover:bg-green-700 text-white px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
                onClick={submitOptions}
              >
                {t('permission.submit')}
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400"
            placeholder={t('permission.freeformPlaceholder')}
            value={freeformText}
            onChange={(e) => setFreeformText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && freeformText.trim()) {
                e.preventDefault();
                onRespond(true, freeformText.trim());
              }
            }}
          />
          <button
            className="bg-green-600 hover:bg-green-700 text-white px-4 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            disabled={!freeformText.trim()}
            onClick={() => onRespond(true, freeformText.trim())}
          >
            {t('permission.submit')}
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── ToolConfirm ──────────────────────────────────────────────────────────── */

interface ToolConfirmCardProps {
  toolName: string;
  input: Record<string, unknown>;
  onRespond: (allow: boolean, answer?: string) => void;
}

function ToolConfirmCard({ toolName, input, onRespond }: ToolConfirmCardProps) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);

  const jsonStr = JSON.stringify(input, null, 2);
  const lines = jsonStr.split('\n');
  const truncated = lines.length > 3;
  const preview = truncated && !expanded ? lines.slice(0, 3).join('\n') + '\n…' : jsonStr;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onRespond(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onRespond(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onRespond]);

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 mb-3 shadow-sm">
      <p className="text-xs font-medium text-amber-400 mb-1">{t('permission.toolConfirm')}</p>
      <p className="font-semibold mb-2">{toolName}</p>

      {Object.keys(input).length > 0 && (
        <div className="mb-3">
          <p className="text-xs text-white/50 mb-1">{t('permission.toolInput')}</p>
          <pre className="text-xs bg-black/20 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all">
            {preview}
          </pre>
          {truncated && (
            <button
              className="text-xs text-amber-400 hover:underline mt-1"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? t('permission.showLess') : t('permission.showMore')}
            </button>
          )}
        </div>
      )}

      <div className="flex gap-2 justify-end">
        <button
          className="bg-red-600 hover:bg-red-700 text-white px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
          onClick={() => onRespond(false)}
        >
          {t('permission.deny')}
        </button>
        <button
          className="bg-green-600 hover:bg-green-700 text-white px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
          onClick={() => onRespond(true)}
        >
          {t('permission.allow')}
        </button>
      </div>
    </div>
  );
}

/* ─── PlanMode ─────────────────────────────────────────────────────────────── */

function PlanModeCard({ input, onRespond }: SubCardProps) {
  const { t } = useTranslation('chat');
  const plan = typeof input.plan === 'string' ? input.plan : null;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onRespond(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onRespond(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onRespond]);

  return (
    <div className="rounded-xl border border-purple-500/30 bg-purple-500/10 p-4 mb-3 shadow-sm">
      <p className="text-xs font-medium text-purple-400 mb-1">{t('permission.planMode')}</p>
      <p className="text-sm text-white/70 mb-3">{t('permission.planModeHint')}</p>

      {plan && (
        <pre className="text-xs bg-black/20 rounded-lg p-2 mb-3 overflow-x-auto whitespace-pre-wrap break-all">
          {plan}
        </pre>
      )}

      <div className="flex gap-2 justify-end">
        <button
          className="bg-red-600 hover:bg-red-700 text-white px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
          onClick={() => onRespond(false)}
        >
          {t('permission.cancel')}
        </button>
        <button
          className="bg-green-600 hover:bg-green-700 text-white px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
          onClick={() => onRespond(true)}
        >
          {t('permission.approve')}
        </button>
      </div>
    </div>
  );
}
