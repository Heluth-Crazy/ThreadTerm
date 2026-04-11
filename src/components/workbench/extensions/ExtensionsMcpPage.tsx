import { Globe, Plus, RefreshCw, Save, Terminal, Trash2, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { settings } from '../../../lib/tauri-bridge';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';

type McpServer = {
  id: string;
  name: string;
  type?: string;
  scope?: string;
  projectPath?: string;
  config?: {
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
  };
};

type FormState = {
  mode: 'create' | 'edit';
  provider: 'claude' | 'codex';
  originalName?: string;
  name: string;
  type: 'stdio' | 'http' | 'sse';
  scope: 'user' | 'local';
  projectPath: string;
  command: string;
  argsText: string;
  url: string;
  envText: string;
};

function defaultForm(provider: 'claude' | 'codex'): FormState {
  return {
    mode: 'create',
    provider,
    name: '',
    type: 'stdio',
    scope: 'user',
    projectPath: '',
    command: '',
    argsText: '',
    url: '',
    envText: '',
  };
}

function parseEnv(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce((acc, line) => {
      const separatorIndex = line.indexOf('=');
      if (separatorIndex === -1) {
        return acc;
      }
      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      if (key) {
        acc[key] = value;
      }
      return acc;
    }, {} as Record<string, string>);
}

function toArgs(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function toFormState(provider: 'claude' | 'codex', server: McpServer): FormState {
  return {
    mode: 'edit',
    provider,
    originalName: server.name,
    name: server.name,
    type: (server.type as 'stdio' | 'http' | 'sse') || 'stdio',
    scope: (server.scope as 'user' | 'local') || 'user',
    projectPath: server.projectPath || '',
    command: server.config?.command || '',
    argsText: (server.config?.args || []).join('\n'),
    url: server.config?.url || '',
    envText: Object.entries(server.config?.env || {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  };
}

function providerLabel(provider: 'claude' | 'codex') {
  return provider === 'claude' ? 'Claude' : 'Codex';
}

function transportLabel(type: string, t: TFunction) {
  return t(`workbench.mcpPage.transport.${type}`);
}

function scopeLabel(scope: string, t: TFunction) {
  return t(`workbench.mcpPage.scope.${scope}`);
}

function FieldLabel({ children }: { children: string }) {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
      <span className="text-muted-foreground/90">{label}</span>
      <span className="truncate text-foreground/90">{value}</span>
    </div>
  );
}

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 rounded-xl border border-border/60 bg-background px-3.5 py-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function ServerRow({
  server,
  provider,
  onEdit,
  onDelete,
  t,
}: {
  server: McpServer;
  provider: 'claude' | 'codex';
  onEdit: () => void;
  onDelete: () => void;
  t: TFunction;
}) {
  const isRemote = Boolean(server.config?.url) || server.type === 'http' || server.type === 'sse';
  const transport = server.type ? transportLabel(server.type, t) : null;
  const scope = server.scope ? scopeLabel(server.scope, t) : null;
  const providerTone =
    provider === 'claude'
      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
      : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';

  return (
    <div className="rounded-xl border border-border/60 bg-background px-3 py-2.5 shadow-sm">
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2.5">
            <div
              className={cn(
                'mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg',
                isRemote ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300' : providerTone,
              )}
            >
              {isRemote ? <Globe className="h-3.5 w-3.5" /> : <Terminal className="h-3.5 w-3.5" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <div className="truncate text-[13px] font-medium leading-5 text-foreground">{server.name}</div>
                <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] uppercase">
                  {providerLabel(provider)}
                </Badge>
                {transport ? (
                  <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] uppercase">
                    {transport}
                  </Badge>
                ) : null}
                {scope ? (
                  <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] uppercase">
                    {scope}
                  </Badge>
                ) : null}
              </div>
              <div className="mt-1.5 space-y-1 text-[11px] leading-4 text-muted-foreground">
                {server.config?.command ? <DetailRow label={t('workbench.mcpPage.server.command')} value={server.config.command} /> : null}
                {server.config?.args?.length ? <DetailRow label={t('workbench.mcpPage.server.args')} value={server.config.args.join(' ')} /> : null}
                {server.config?.url ? <DetailRow label={t('workbench.mcpPage.server.url')} value={server.config.url} /> : null}
                {server.projectPath ? <DetailRow label={t('workbench.mcpPage.server.project')} value={server.projectPath} /> : null}
                {server.config?.env && Object.keys(server.config.env).length > 0 ? (
                  <DetailRow label={t('workbench.mcpPage.server.env')} value={Object.keys(server.config.env).join(', ')} />
                ) : null}
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button type="button" size="sm" variant="outline" onClick={onEdit} className="h-8 rounded-lg px-2.5 text-[13px]">
            {t('workbench.mcpPage.actions.edit')}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={onDelete}
            title={t('workbench.mcpPage.actions.delete')}
            className="h-8 w-8 rounded-lg"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function ProviderSection({
  provider,
  caption,
  servers,
  onAdd,
  onEdit,
  onDelete,
  t,
}: {
  provider: 'claude' | 'codex';
  caption: string;
  servers: McpServer[];
  onAdd: () => void;
  onEdit: (server: McpServer) => void;
  onDelete: (server: McpServer) => void;
  t: TFunction;
}) {
  const title = providerLabel(provider);

  return (
    <section className="rounded-[22px] border border-border/60 bg-card/72 p-3.5 shadow-sm">
      <div className="mb-2.5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
            <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] uppercase">
              {servers.length}
            </Badge>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{caption}</p>
        </div>
        <Button type="button" size="sm" onClick={onAdd} className="h-8 rounded-lg px-2.5 text-[13px]">
          <Plus className="h-3.5 w-3.5" />
          {t('workbench.mcpPage.actions.add')}
        </Button>
      </div>
      <div className="space-y-2">
        {servers.length > 0 ? (
          servers.map((server) => (
            <ServerRow
              key={`${title}:${server.id}`}
              server={server}
              provider={provider}
              onEdit={() => onEdit(server)}
              onDelete={() => onDelete(server)}
              t={t}
            />
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-border/60 bg-background px-3.5 py-3 text-sm text-muted-foreground">
            {t('workbench.mcpPage.empty')}
          </div>
        )}
      </div>
    </section>
  );
}

type ExtensionsMcpPageProps = {
  createRequest?: {
    token: number;
    provider: 'claude' | 'codex';
  } | null;
  onCreateRequestHandled?: () => void;
};

export default function ExtensionsMcpPage({
  createRequest = null,
  onCreateRequestHandled,
}: ExtensionsMcpPageProps) {
  const { t } = useTranslation('sidebar');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claudeServers, setClaudeServers] = useState<McpServer[]>([]);
  const [codexServers, setCodexServers] = useState<McpServer[]>([]);
  const [form, setForm] = useState<FormState | null>(null);

  const codexCaption = useMemo(() => t('workbench.mcpPage.providers.codexDescription'), [t]);

  const loadData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const allSettings = await settings.getAll();
      const claudeServersData = Array.isArray((allSettings as any)?.mcpClaudeServers) ? (allSettings as any).mcpClaudeServers : [];
      const codexServersData = Array.isArray((allSettings as any)?.mcpCodexServers) ? (allSettings as any).mcpCodexServers : [];
      setClaudeServers(claudeServersData);
      setCodexServers(codexServersData);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('workbench.mcpPage.errors.load'));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  useEffect(() => {
    if (!createRequest?.token) {
      return;
    }

    setError(null);
    setForm(defaultForm(createRequest.provider));
    onCreateRequestHandled?.();
  }, [createRequest, onCreateRequestHandled]);

  const handleDelete = async (provider: 'claude' | 'codex', server: McpServer) => {
    if (!window.confirm(t('workbench.mcpPage.confirmDelete', { name: server.name }))) {
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      if (provider === 'claude') {
        const allS = await settings.getAll();
        const servers = ((allS as any)?.mcpClaudeServers || []).filter((srv: any) => srv.name !== (server.id || server.name));
        await settings.set('mcpClaudeServers', servers);
      } else {
        const allS = await settings.getAll();
        const servers = ((allS as any)?.mcpCodexServers || []).filter((srv: any) => srv.name !== server.name);
        await settings.set('mcpCodexServers', servers);
      }
      await loadData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t('workbench.mcpPage.errors.delete'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = async () => {
    if (!form) {
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      if (form.provider === 'claude') {
        if (form.mode === 'edit' && form.originalName) {
          const allS = await settings.getAll();
          const servers = ((allS as any)?.mcpClaudeServers || []).filter((srv: any) => srv.name !== form.originalName);
          await settings.set('mcpClaudeServers', servers);
        }

        const allS2 = await settings.getAll();
        const existingServers = ((allS2 as any)?.mcpClaudeServers || []) as any[];
        const newServer = {
          name: form.name,
          scope: form.scope,
          type: form.type,
          ...(form.type === 'stdio'
            ? { command: form.command, args: toArgs(form.argsText), env: parseEnv(form.envText) }
            : { url: form.url }),
        };
        await settings.set('mcpClaudeServers', [...existingServers, newServer]);
      } else {
        const allS3 = await settings.getAll();
        const existingServers = ((allS3 as any)?.mcpCodexServers || []) as any[];
        const newServer = {
          name: form.name,
          type: 'stdio',
          command: form.command,
          args: toArgs(form.argsText),
          env: parseEnv(form.envText),
        };

        if (form.mode === 'edit' && form.originalName && form.originalName !== form.name) {
          const filtered = existingServers.filter((srv: any) => srv.name !== form.originalName);
          await settings.set('mcpCodexServers', [...filtered, newServer]);
        } else {
          await settings.set('mcpCodexServers', [...existingServers.filter((srv: any) => srv.name !== form.name), newServer]);
        }
      }

      setForm(null);
      await loadData();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('workbench.mcpPage.errors.save'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-5 py-4 lg:px-6">
        <section className="rounded-[22px] border border-border/60 bg-card/72 px-4 py-3.5 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">OpenWork</p>
              <h1 className="mt-1 text-base font-semibold text-foreground">{t('workbench.mcp')}</h1>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('workbench.mcpPage.subtitle')}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px]">
                {claudeServers.length + codexServers.length}
              </Badge>
              <Button
                type="button"
                size="icon"
                variant="outline"
                onClick={() => void loadData()}
                disabled={isLoading || isSaving}
                title={t('actions.refresh')}
                className="h-8 w-8 rounded-lg"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {error ? (
            <div className="mt-3 rounded-lg border border-red-300/60 bg-red-50 px-3.5 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
              {error}
            </div>
          ) : null}
        </section>

        {form ? (
          <section className="rounded-[22px] border border-border/60 bg-card/72 p-3.5 shadow-sm">
            <div className="flex flex-col gap-3 border-b border-border/60 pb-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]">
                    {providerLabel(form.provider)}
                  </Badge>
                  <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]">
                    {form.mode === 'create' ? t('workbench.mcpPage.form.addTitle') : t('workbench.mcpPage.form.editTitle')}
                  </Badge>
                </div>
                <h2 className="mt-1.5 text-sm font-semibold text-foreground">
                  {form.mode === 'create' ? t('workbench.mcpPage.form.addTitle') : t('workbench.mcpPage.form.editTitle')}
                </h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t('workbench.mcpPage.form.providerConfig', { provider: providerLabel(form.provider) })}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <Button type="button" size="sm" variant="outline" onClick={() => setForm(null)} className="h-8 rounded-lg px-2.5 text-[13px]">
                  <X className="h-3.5 w-3.5" />
                  {t('workbench.mcpPage.actions.close')}
                </Button>
                <Button type="button" size="sm" onClick={() => void handleSave()} disabled={isSaving} className="h-8 rounded-lg px-2.5 text-[13px]">
                  <Save className="h-3.5 w-3.5" />
                  {isSaving ? t('workbench.mcpPage.actions.saving') : t('workbench.mcpPage.actions.save')}
                </Button>
              </div>
            </div>

            <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <div className="space-y-3">
                <FormSection title={t('workbench.mcpPage.form.sections.identity')}>
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-1">
                    <label className="space-y-1.5 text-sm">
                      <FieldLabel>{t('workbench.mcpPage.form.name')}</FieldLabel>
                      <Input
                        value={form.name}
                        onChange={(event) => setForm({ ...form, name: event.target.value })}
                        className="h-9 rounded-lg text-[13px]"
                      />
                    </label>
                    <label className="space-y-1.5 text-sm">
                      <FieldLabel>{t('workbench.mcpPage.form.transport')}</FieldLabel>
                      <select
                        value={form.provider === 'codex' ? 'stdio' : form.type}
                        onChange={(event) => setForm({ ...form, type: event.target.value as 'stdio' | 'http' | 'sse' })}
                        className="flex h-9 w-full rounded-lg border border-input bg-background px-3 py-2 text-[13px]"
                        disabled={form.provider === 'codex'}
                      >
                        <option value="stdio">{transportLabel('stdio', t)}</option>
                        <option value="http">{transportLabel('http', t)}</option>
                        <option value="sse">{transportLabel('sse', t)}</option>
                      </select>
                    </label>
                    {form.provider === 'claude' ? (
                      <label className="space-y-1.5 text-sm md:col-span-2 xl:col-span-1">
                        <FieldLabel>{t('workbench.mcpPage.form.scope')}</FieldLabel>
                        <select
                          value={form.scope}
                          onChange={(event) => setForm({ ...form, scope: event.target.value as 'user' | 'local' })}
                          className="flex h-9 w-full rounded-lg border border-input bg-background px-3 py-2 text-[13px]"
                        >
                          <option value="user">{scopeLabel('user', t)}</option>
                          <option value="local">{scopeLabel('local', t)}</option>
                        </select>
                      </label>
                    ) : null}
                    {form.provider === 'claude' && form.scope === 'local' ? (
                      <label className="space-y-1.5 text-sm md:col-span-2 xl:col-span-1">
                        <FieldLabel>{t('workbench.mcpPage.form.projectPath')}</FieldLabel>
                        <Input
                          value={form.projectPath}
                          onChange={(event) => setForm({ ...form, projectPath: event.target.value })}
                          className="h-9 rounded-lg text-[13px]"
                        />
                      </label>
                    ) : null}
                  </div>
                </FormSection>

                <FormSection title={t('workbench.mcpPage.form.sections.transport')}>
                  {form.type === 'stdio' ? (
                    <label className="space-y-1.5 text-sm">
                      <FieldLabel>{t('workbench.mcpPage.form.command')}</FieldLabel>
                      <Input
                        value={form.command}
                        onChange={(event) => setForm({ ...form, command: event.target.value })}
                        placeholder={t('workbench.mcpPage.form.commandPlaceholder')}
                        className="h-9 rounded-lg text-[13px]"
                      />
                    </label>
                  ) : (
                    <label className="space-y-1.5 text-sm">
                      <FieldLabel>{t('workbench.mcpPage.form.url')}</FieldLabel>
                      <Input
                        value={form.url}
                        onChange={(event) => setForm({ ...form, url: event.target.value })}
                        placeholder={t('workbench.mcpPage.form.urlPlaceholder')}
                        className="h-9 rounded-lg text-[13px]"
                      />
                    </label>
                  )}
                </FormSection>
              </div>

              {form.type === 'stdio' ? (
                <FormSection title={t('workbench.mcpPage.form.sections.runtime')}>
                  <div className="grid gap-2 md:grid-cols-2">
                    <label className="space-y-1.5 text-sm">
                      <FieldLabel>{t('workbench.mcpPage.form.args')}</FieldLabel>
                      <textarea
                        value={form.argsText}
                        onChange={(event) => setForm({ ...form, argsText: event.target.value })}
                        className="min-h-40 w-full rounded-lg border border-input bg-background px-3 py-2 text-[13px]"
                      />
                    </label>
                    <label className="space-y-1.5 text-sm">
                      <FieldLabel>{t('workbench.mcpPage.form.env')}</FieldLabel>
                      <textarea
                        value={form.envText}
                        onChange={(event) => setForm({ ...form, envText: event.target.value })}
                        className="min-h-40 w-full rounded-lg border border-input bg-background px-3 py-2 text-[13px]"
                      />
                    </label>
                  </div>
                </FormSection>
              ) : (
                <FormSection title={t('workbench.mcpPage.form.sections.transport')}>
                  <div className="rounded-lg border border-dashed border-border/60 px-3 py-2.5 text-sm text-muted-foreground">
                    {t('workbench.mcpPage.form.providerConfig', { provider: providerLabel(form.provider) })}
                  </div>
                </FormSection>
              )}
            </div>
          </section>
        ) : null}

        {isLoading ? (
          <div className="flex h-32 items-center justify-center rounded-[22px] border border-border/60 bg-card/40 text-sm text-muted-foreground">
            {t('workbench.mcpPage.loading')}
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            <ProviderSection
              provider="claude"
              caption={t('workbench.mcpPage.providers.claudeDescription')}
              servers={claudeServers}
              onAdd={() => setForm(defaultForm('claude'))}
              onEdit={(server) => setForm(toFormState('claude', server))}
              onDelete={(server) => void handleDelete('claude', server)}
              t={t}
            />
            <ProviderSection
              provider="codex"
              caption={codexCaption}
              servers={codexServers}
              onAdd={() => setForm(defaultForm('codex'))}
              onEdit={(server) => setForm(toFormState('codex', server))}
              onDelete={(server) => void handleDelete('codex', server)}
              t={t}
            />
          </div>
        )}
      </div>
    </div>
  );
}
