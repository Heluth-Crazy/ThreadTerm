import { validateWireRequest, validateWireSuccess } from './generated-validators.js';
import { isBrowserEvalArguments } from './browser.js';
export * from './browser.js';
export interface BrowserEvalApprovalRead {
 approvalId:string; operationId:string; code:string; codeHash:string; codeByteLength:number;
 tabId:string; origin:string; expiresAtUnixMs:number; settingsGeneration:string; status:'pending';
}
export const PROTOCOL_VERSION = 1 as const;
/** Semantic contract includes browser control and private per-snippet eval approvals. Framing/HMAC still use PROTOCOL_VERSION. */
export const PROTOCOL_CONTRACT = 17 as const;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Composer image attachments: at most this many images, whose data-URL strings sum to at most MAX_CHAT_IMAGE_BYTES.
 * Shared by the renderer composer and the desktop attach path so the picker never inlines more than the composer accepts. */
export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_BYTES = 4 * 1024 * 1024;
/** Agents that ship with ThreadTerm (native adapters, or `shell` / `custom` commands). */
export type BuiltinProviderId = 'codex'|'claude'|'kimi'|'gemini'|'opencode'|'shell'|'grok'|'custom';
/** Any agent id in the runtime's agent registry: a built-in id or one contributed by an enabled plugin
 * (`^[a-z][a-z0-9-]{1,31}$`). The runtime rejects ids it does not know; `provider.list` is the source of truth. */
export type ProviderId = string;
export type SessionMode = 'terminal'|'chat';
export type SessionStatus = 'starting'|'running'|'idle'|'waiting'|'exited'|'interrupted'|'error';
export interface Project { id:string; name:string; path:string; createdAt:string }
export interface CommitSummary { id:string; subject:string; committedAt:string }
export interface ProjectCatalogItem extends Project { revision:number; pinned:boolean; sortOrder:number; git:{available:boolean;branch?:string;upstream?:string;lastCommit?:CommitSummary} }
export interface CatalogVisibility { kind:'project'|'worktree'|'session'; id:string; visibility:'active'|'archived'|'removed'; revision:number; projectId?:string; worktreePath?:string }
export interface LocalBranch { name:string; current:boolean; upstream?:string; lastCommit:CommitSummary }
// awaiting_parent: a delegated session's request is waiting for the agent that delegated it, not the user.
export interface SessionActivity { state:'running'|'awaiting_approval'|'awaiting_parent'|'awaiting_input'|'idle'|'unknown'; revision:number; turnId?:string; reason?:string }
export type SessionDelegationState = 'starting'|'running'|'awaiting_parent'|'awaiting_user'|'completed'|'failed'|'cancelled';
// Present on a Chat session that another agent started through ThreadTerm delegation.
export interface SessionDelegation { id:string; parentSessionId:string; workspace:'shared'|'worktree'; branch?:string; state:SessionDelegationState; /** How many of the user's messages from the parent chat were attached to the delegate's first message; absent when none. */ userMessages?:number }
export interface SessionForkOrigin { sessionId:string; itemId?:string; title?:string }
/** Present on a Chat session linked to a group. */
export interface SessionGroup { /** Owning group id. */ id:string; /** This session's unique `@handle` within its group. */ handle:string }
export interface Session { id:string; projectId?:string; worktreePath?:string; title:string; provider:ProviderId; mode:SessionMode; status:SessionStatus; createdAt:string; updatedAt:string; nativeId?:string; exitCode?:number; cols?:number; rows?:number; followed?:boolean; readOnly?:boolean; activity?:SessionActivity; delegation?:SessionDelegation; /** Group grouping metadata for member Chat sessions. */ group?:SessionGroup; archived?:boolean; pinned?:boolean; bookmarked?:boolean; intent?:'review'|'fix'|'research'|'test'|'docs'; sortOrder?:number; organizationRevision?:number; /** Present when this terminal is a Quick Launch run. */ run?:SessionRun; forkedFrom?:SessionForkOrigin }
/** Quick Launch: per-project saved commands, each run as an ordinary managed terminal session in a chosen worktree.
 * One active run per command and worktree root (the runtime admits atomically and returns the existing run). */
export type QuickLaunchShell = 'cmd'|'powershell'|'pwsh';
/** `service` keeps running (dev server, API); `task` is expected to exit (build, test). Only changes wording/defaults. */
export type QuickLaunchKind = 'service'|'task';
export interface QuickLaunchEnvVar { name:string; /** `%NAME%` references expand against the inherited environment at run time. */ value:string }
export interface QuickLaunchCommand { id:string; projectId:string; revision:number; name:string; /** Verbatim command text for the shell (may hold several lines for PowerShell). */ command:string; shell:QuickLaunchShell;
 /** Relative to the worktree root, '' = the root; resolved again at every run and kept inside the root. */ cwd:string; kind:QuickLaunchKind; env:QuickLaunchEnvVar[];
 /** Fallback preview address when the run prints no local URL. */ previewUrl?:string; createdAt:string; updatedAt:string }
/** The launch snapshot of a run; editing or deleting the command later does not change it. */
export interface SessionRun { commandId:string; name:string; kind:QuickLaunchKind; shell:QuickLaunchShell; /** The first local http(s) URL this run printed (`output`), else the command's fallback (`configured`). */ url?:string; urlSource?:'output'|'configured';
 /** The user asked to stop it: an exit after this reads as "Stopped", not as a failure. */ stopRequested?:boolean;
 /** Present when a worktree setup sequence started this run: its id, 0-based step and step count. */ setup?:{runId:string;step:number;total:number} }
/** Worktree setup (Quick Launch): a project's chosen `task` commands, run in order in every new worktree of the project
 * and on request. Saving a non-empty list is the user's consent to run it automatically. Revision 0 = never saved. */
export interface QuickLaunchSetup { projectId:string; revision:number; commandIds:string[] }
export type WorktreeSetupState = 'running'|'completed'|'failed'|'cancelled'|'interrupted';
/** One sequence in one worktree. `commandIds`/`names` are snapshots taken at start. `step` is the step running now, or the
 * one that failed / was cancelled / was interrupted. `sessionIds` holds the terminal of every step started so far.
 * `exitCode` is the failed step's exit code. A runtime restart turns `running` into `interrupted`; it never resumes. */
export interface WorktreeSetupRun { id:string; projectId:string; root:string; commandIds:string[]; names:string[]; step:number;
 state:WorktreeSetupState; sessionIds:string[]; exitCode?:number; trigger:'worktree.create'|'manual'|'retry'; createdAt:string; updatedAt:string }
/** Prompt queue (Chat): messages written while the agent works wait here; the runtime sends them in order, one per
 * finished turn, through the same path as chat.send. Never while paused, disconnected, mid-turn or awaiting an approval. */
export interface ChatQueueItem { id:string; text:string; images:string[]; revision:number; createdAt:string; updatedAt:string;
 /** `sending`: handed to the provider. `failed`: not sent, or its outcome is unknown — the queue paused; never resent automatically. */
 state:'queued'|'sending'|'failed'; error?:string }
export interface ChatQueue { sessionId:string; paused:boolean; pauseReason?:'user'|'stopped'|'failed'|'restarted'|'disconnected'; items:ChatQueueItem[] }
/** User feedback is delivered once when the running agent checks its app-hosted tool. */
export interface ChatFeedbackNote { id:string; sessionId:string; turnId:string; text:string; status:'waiting'|'received'; createdAt:string }
export interface SessionConfig { sessionId:string; revision:number; provider:ProviderId; mode:SessionMode; cwd:string; projectId?:string; title?:string; executable?:string; args:string[]; sourceSessionId?:string }
export interface SessionRetryAttempt { id:string; sourceSessionId:string; attempt:number; dueAt:string; status:'pending'|'claimed'|'cancelled'|'completed'|'exhausted'; operationId:string; createdAt:string }
export interface SessionRetryState { sessionId:string; revision:number; enabled:boolean; maxRetries:number; delaySeconds:number; attempts:SessionRetryAttempt[] }
export interface ProviderCapability { id:ProviderId; name:string; installed:boolean; version?:string; terminal:boolean; chat:boolean; history:boolean; resume:boolean; terminalResumeCapture?:'preassigned'|'none'; reason?:string; auth?:'authenticated'|'unauthenticated'|'unknown';
 /** Where the agent comes from: built into ThreadTerm, or contributed by a plugin (see `plugin.list`). Absent = builtin. */
 source?:'builtin'|'plugin'; pluginId?:string;
 /** Plugin agents: the plugin's SVG icon as a `data:image/svg+xml;base64,` URL. Render it with <img>, never as markup. */
 icon?:string;
 /** The agent's interactive sign-in command, run in a terminal session; `display` is the command line to show. */
 signIn?:{ executable:string; args:string[]; display:string };
 homepage?:string }
/** One agent a plugin contributes. `commands` are the command lines it may run (version probe, terminal, ACP chat,
 * sign-in), shown to the user before the plugin is enabled. */
export interface PluginAgentInfo { id:ProviderId; name:string; terminal:boolean; chat:boolean; commands:string[] }
/** A plugin folder found by the runtime. `bundled` plugins ship with ThreadTerm and are enabled by default; `user`
 * plugins live in the plugins directory and stay disabled until the user enables them. `issues` lists problems:
 * an unloadable manifest or an invalid agent (bad id or command, id collision, icon outside the folder, …) means
 * that part contributes nothing; a warning such as an unknown contribution type does not block the agents. */
export interface BrowserBindingInfo { id:string; bindingVersion:number; providerId:string; requires:Record<string,number>; transport:string; tools:string[]; workflow:string; enabled:boolean; selected:boolean; availability:'eligible'|'disabled'|'unsupported_binding_version'|'unsupported_runtime_capability'|'unsupported_transport'|'conflict'; issue?:string }
export interface PluginInfo { id:string; name:string; version:string; publisher?:string; description?:string; homepage?:string; source:'bundled'|'user'; enabled:boolean; path?:string; agents:PluginAgentInfo[]; browserBindings?:BrowserBindingInfo[]; issues:string[] }
export interface PreviewError {code:string;message:string;retryable:boolean}
export type PreviewState='accepted'|'presented'|'closed'|'failed'|'unavailable'|'interrupted';
export type PreviewNavigation='not_started'|'pending'|'load_observed'|'failed';
export interface PreviewResult {requestId:string;previewId?:string;state:PreviewState;sequence:number;navigation:PreviewNavigation;applicationReady:'unknown';contentVerified:false;observedUrl?:string;observedTitle?:string;documentGeneration?:number;error?:PreviewError}
/** Runtime association, separate from the ordinary web ContentRef. */
export interface PreviewAssociation extends PreviewResult {previewId:string;sessionId:string;documentId:string;url:string;title?:string;tabId?:string;workspaceId?:string;observedUrl?:string;observedTitle?:string;documentGeneration?:number}
export interface PreviewPresentation {sessionId:string;attachmentId:string;viewId:string;workspaceId?:string;requestId:string;previewId:string;documentId:string;url:string;title?:string}
/** Page comments (desktop bridge only; never sent to the runtime). Rects are CSS pixels in the page viewport. Every
 * string from a pick comes from an untrusted page: the desktop bounds and validates it, the renderer shows it as text. */
export interface PageRect { x:number; y:number; width:number; height:number }
/** Best-effort dev-build hint for where an element is defined (React _debugSource, Vue __file, Svelte __svelte_meta,
 * code-inspector data attributes). Paths are as the page reports them (absolute or project-relative). */
export interface PageSourceHint { file:string; line?:number; column?:number; framework:'react'|'vue'|'svelte'|'attribute' }
export interface PageElementTarget { type:'element'; selector:string; tag:string; /** e.g. `button "Save changes"` */ label:string; text?:string; attributes:Record<string,string>; /** Opening tag + short text, ≤ 600 chars. */ html:string; rect:PageRect; source?:PageSourceHint; /** Nearest component names, innermost first (React/Vue/Svelte dev builds). */ components?:string[] }
export interface PageAreaTarget { type:'area'; rect:PageRect; /** Labels of the main elements inside the area, ≤ 8. */ elements:string[] }
/** A saved screenshot of the pick: the full image is a file in the app's data folder (agents can open `path`); the
 * thumbnail (≤ 240 px wide JPEG data URL) is kept with the comment. */
export interface PageShot { id:string; path:string; width:number; height:number; thumbnail:string }
export interface PagePick { url:string; title:string; viewport:{ width:number; height:number }; target:PageElementTarget|PageAreaTarget; shot?:PageShot }
export interface PageTargetRef { selector?:string; rect?:PageRect }
export interface PluginList { /** Where user plugins are installed (one folder per plugin, each with threadterm-plugin.json). */ directory:string; plugins:PluginInfo[] }
/** A saved composer snippet inserted at the caret from the `+` menu or the composer's right-click menu. */
export interface QuickMessage { id:string; title:string; text:string }
export interface Settings { revision:number; theme?:'light'|'dark'|'system'; language?:'zh-CN'|'en'; 'chatTools.ask'?:boolean; 'chatTools.sessionInfo'?:boolean; 'chatTools.feedback'?:boolean; 'chatTools.delegation'?:boolean; quickMessages?:QuickMessage[]; [key:string]:unknown }
/** A file picked through the desktop's native open dialog. */
export interface AttachedFile { path:string; name:string; dataUrl?:string }
export interface Workspace { id:string; name:string; revision:number; layout:PaneLayout; projectId?:string; worktreePath?:string }
export interface InboxItem { id:string; sessionId:string; kind:string; title:string; createdAt:string; read:boolean }
export interface Snapshot { epoch:string; revision:number; projects:Project[]; sessions:Session[]; settings:Settings; workspaces:Workspace[]; inbox:InboxItem[]; providers:ProviderCapability[] }
export interface NativeHistoryItem { provider:ProviderId; nativeId:string; title:string; cwd?:string; updatedAt:string; resumable:boolean; reason?:string }
export interface FileReference { path:string; line?:number; column?:number }
export interface ResolvedFileReference extends FileScope, FileReference { kind:'text'|'image' }
export type ChatPlanEntryStatus = 'pending'|'in_progress'|'completed';
export type ChatPlanEntryPriority = 'high'|'medium'|'low';
/** Agent plan/todo snapshot. Lives on a `type:'plan'` part; distinct from the plan-usage card (`data.kind:'plan'` on a text part). */
export interface ChatPlanEntry { content:string; status:ChatPlanEntryStatus; priority?:ChatPlanEntryPriority }
export interface ChatPlanData { entries:ChatPlanEntry[]; explanation?:string }
/** The legacy, provider-defined chat part shapes. Their data remains opaque. */
export interface ChatPartBase { type:'text'|'thinking'|'tool'|'approval'|'usage'|'error'|'status'|'subagent'; text?:string; toolName?:string; toolId?:string; approvalId?:string; status?:string; data?:unknown; fileReferences?:FileReference[]; phase?:'commentary'|'final_answer' }
/** A plan snapshot is the one chat-part payload with a protocol-owned shape. Empty entries deliberately clear a prior plan. */
export interface ChatPlanPart { type:'plan'; text?:string; toolName?:string; toolId?:string; approvalId?:string; status?:string; data:ChatPlanData; fileReferences?:FileReference[]; phase?:'commentary'|'final_answer' }
/** Additive union: persisted non-plan provider rows retain their opaque data contract. */
export type ChatPart = ChatPartBase|ChatPlanPart;
/** Native turn outcome is independent of measured wall-clock duration. Missing status remains unknown. */
/** Opaque provider-owned identifiers; only the runtime resolves a chosen reply to a native fork point. */
export interface NativeForkAnchor { nativeId:string; turnId?:string; messageId?:string; entryId?:string }
export interface ChatTurnReview { from:string; to:string; fileCount:number }
export interface ChatItem { id:string; role:'user'|'assistant'|'system'|'tool'; parts:ChatPart[]; createdAt:string; turnId?:string; elapsedMs?:number; turnStatus?:'completed'|'interrupted'|'failed'|'inProgress'|'unknown'; turnOrigin?:'history'; forkAnchor?:NativeForkAnchor; turnModel?:string; turnUsage?:ChatContextUsage; turnReview?:ChatTurnReview }
/** Runtime-authored, on-demand availability. Integrity is durable; repair never resumes an agent or queue. */
export interface ChatRepairAvailability {
 offered:boolean;
 mode?:'rebuild';
 reason?:'healthy'|'busy'|'unknown_activity'|'missing_native_id'|'history_unavailable'|'session_unavailable'|'history_metadata_missing';
 degraded:boolean;
 diagnostic?:string;
 /** Global ingress failure permanently fences queued dispatch until restart. */
 ingressFailed?:boolean;
}
export interface ChatRepairResult {
 sessionId:string;
 mode:'rebuild';
 added:number;
 updated:number;
 removed:number;
 expired:number;
 total:number;
 revision:number;
}
export type SubagentStatus = 'running'|'completed'|'failed'|'cancelled'|'unknown';
export type SubagentTranscript = 'live'|'native'|'none';
export interface SubagentInfo {
 key:string;
 provider:string;
 agentType?:string;
 name?:string;
 description?:string;
 prompt?:string;
 status:SubagentStatus;
 background?:boolean;
 depth?:number;
 startedAt?:string;
 endedAt?:string;
 toolCount?:number;
 itemCount?:number;
 lastActivity?:string;
 summary?:string;
 usage?:{totalTokens?:number;toolUses?:number;durationMs?:number};
 transcript:SubagentTranscript;
 native?:{kind:'claude-agent'|'codex-thread'|'opencode-session'|'kimi-agent'|'grok-subagent';id:string};
 rev?:number;
 truncated?:boolean;
}
export interface SubagentTranscriptRead { items:ChatItem[]; rev:number; truncated:boolean; source:SubagentTranscript; error?:string }
export interface ChatSessionChoice { value:string; name:string; description?:string; group?:string; recommended?:boolean }
export interface ChatSessionOption { id:string; name:string; value:string; choices:ChatSessionChoice[]; kind?:'select'|'boolean'; category?:'mode'|'model'|'thinking'|'other'; description?:string; recommended?:string }
export interface ChatSlashCommand { name:string; description?:string }
/** A provider skill that can be invoked by text (provider-matrix §E3). */
export interface ChatSkill { name:string; description?:string; invocation:string }
export type ChatOptionsLoadState = 'idle'|'loading'|'ready'|'empty'|'error'|'unknown';
export interface PiTrustState {
 protectedResources:string[];
 outsideProtectedResources?:{path:string;target:string}[];
 piDecision:'trusted'|'declined'|'none';
 defaultProjectTrust:'always'|'ask'|'never';
 threadtermDecision:'trusted'|'declined'|'none';
 effective:'loaded'|'skipped';
}
export interface ChatBackgroundTask {
 id:string;
 title:string;
 command?:string;
 status:'running'|'completed'|'failed'|'stopped';
 startedAt?:string;
 endedAt?:string;
 canStop:boolean;
 /** Existing transcript tool/subagent identity used by the Output action. */
 toolId?:string;
}
/** A complete composer UI snapshot, sent by both `chat.options` and `chat.ui`; it replaces prior UI state. */
export interface ChatUiState {
 options:ChatSessionOption[];
 commands:ChatSlashCommand[];
 /** Skills the provider can tell apart from ordinary commands; absent when it cannot. */
 skills?:ChatSkill[];
 backgroundTasks?:ChatBackgroundTask[];
 inputCapabilities?:{images?:boolean;steer?:'native'|'note'};
 loadState?:ChatOptionsLoadState;
 error?:{code:string;message:string};
 piTrust?:PiTrustState;
}
export type ChatConnectionPhase = 'disconnected'|'connecting'|'ready'|'failed'|'unavailable';
export interface ChatConnectionError {
 code:string;
 message:string;
 retryable:boolean;
 category?:'auth'|'install'|'version'|'cwd'|'runtime'|'control'|'provider';
 /** Present only when a saved provider permission could not be restored. */
 permissionRestore?:{optionId:string;savedValue:string;reportedValue?:string;reason:'missing'|'mismatch'|'rejected';optionName?:string;savedLabel?:string;reportedLabel?:string};
}
/** Latest context-window usage for one Chat session, pushed by `chat.context` and read by `chat.context.read`. */
export interface ChatContextUsage {
 usedTokens?:number;
 windowTokens?:number;
 percent?:number;
 inputTokens?:number;
 outputTokens?:number;
 /** Model generation time for this turn, excluding tool execution and user waits. */
 generationMs?:number;
 /** Milliseconds from turn start to the first model output event. */
 firstTokenMs?:number;
 /** True when outputTokens was estimated from streamed text rather than reported by the provider. */
 outputTokensEstimated?:boolean;
 cacheReadTokens?:number;
 cacheWriteTokens?:number;
 totalTokens?:number;
 updatedAt?:string;
}
/** Ephemeral turn-speed update. Published as `chat.turnSpeed`; it is never persisted by this event. */
export interface ChatTurnSpeed { sessionId:string; turnId:string; active:boolean; usage?:ChatContextUsage }
export interface ChatConnectionState {
 sessionId:string;
 runtimeEpoch:string;
 connectionGeneration:number;
 revision:number;
 phase:ChatConnectionPhase;
 nativeId?:string;
 error?:ChatConnectionError;
 optionsLoadState:ChatOptionsLoadState;
 optionsError?:{code:string;message:string};
}
export type ChatApprovalKind = 'allow'|'deny'|'cancel'|'other';
export type ChatApprovalScope = 'once'|'turn'|'session'|'persistent'|'unknown';
export interface ChatApprovalChoice {
 choiceId:string;
 label:string;
 kind:ChatApprovalKind;
 scope:ChatApprovalScope;
 description?:string;
}
export type ChatApprovalOutcome = 'pending'|'submitting'|'resolved'|'answered'|'dismissed'|'expired'|'failed'|'outcomeUnknown';
export interface ChatQuestion {
 id:string; header?:string; question:string;
 options:{label:string;description?:string}[];
 multiSelect:boolean; allowOther:boolean; secret:boolean;
}
export interface ChatFormField {
 id:string; title?:string; description?:string;
 type:'string'|'number'|'integer'|'boolean'|'enum'|'multiEnum'; required:boolean;
 options?:{value:string;label:string}[]; default?:unknown; secret?:boolean; multiline?:boolean;
 minimum?:number; maximum?:number; minLength?:number; maxLength?:number;
 minItems?:number; maxItems?:number; format?:'email'|'uri'|'date'|'date-time';
}
export type ChatInteractionForm =
 | {kind:'questions';questions:ChatQuestion[]}
 | {kind:'form';message:string;fields:ChatFormField[]}
 | {kind:'url';message:string;url:string};
export type ChatAnswerResponse =
 | {action:'submit';values:Record<string,string[]|string|number|boolean>}
 | {action:'dismiss'}
 | {action:'approve'|'request_changes'|'abandon';feedback?:string};
export interface ChatApprovalData {
 approvalId:string;
 sessionId?:string;
 turnId?:string;
 provider?:ProviderId;
 requestType?:string;
 title?:string;
 details?:unknown;
 previewUnavailableReason?:string;
 choices:ChatApprovalChoice[];
 interaction?:'permission'|'userInput'|'elicitation'|'question'|'plan'|'unknown';
 plan?:string;
 runtimeOwned?:boolean;
 waitingForPrompt?:boolean;
 planOutcome?:'approved'|'changes_requested'|'abandoned';
 feedback?:string;
 outcome?:'submitted'|'partial';
 recovery?:'reconnect';
 message?:string;
 form?:ChatInteractionForm;
 answerable?:boolean;
 answerSummary?:Record<string,string>;
 isBlocking?:boolean;
 autoResolutionMs?:number;
 submittable?:boolean;
}
export interface RuntimeError { code:string; message:string; details?:unknown }
export type DevicePermission = 'readonly'|'fullcontrol';
export interface RemoteAccessStatus { enabled:boolean; url?:string; port?:number; tlsFingerprint:string; error?:string }
export interface PairingOffer { id:string; code:string; qrPayload:string; permission:DevicePermission; expiresAt:string; serverUrl:string; tlsFingerprint:string }
export interface PairedDevice { id:string; name:string; permission:DevicePermission; createdAt:string; expiresAt:string; lastSeenAt?:string; revokedAt?:string }
export interface DataRelocationStatus { frozen:boolean; sourceRoot:string; targetRoot?:string }
export interface DataRelocationPrepared { sourceRoot:string; targetRoot:string; activationToken:string }
export interface RuntimeEvent<E extends string=string,D=unknown> { v:1; event:E; epoch:string; seq:number; data:D }
export type ChatTurnSpeedEvent=RuntimeEvent<'chat.turnSpeed',ChatTurnSpeed>;
export interface TerminalLaunchState { phase:'preparing'|'launching'|'running'|'failed'|'cancelled'; error?:{code:string;message:string} }
/** Native prerequisites are checked on demand and shared with group creation admission. */
export interface GroupPrerequisiteProvider {
 /** Provider requested by the prospective member. */ provider:ProviderId;
 /** Whether this machine can start the provider now. */ usable:boolean;
 /** Machine-specific reason the provider is unavailable. */ reason?:string;
 /** Actionable remediation when the provider is unavailable. */ fix?:{kind:'install'|'sign_in'|'update'|'enable_plugin'|'configure';text:string;homepage?:string;command?:string};
 /** Read-only enforcement available for this provider. */ readOnly:'enforced'|'prompt';
 /** Human-readable read-only mechanism explanation. */ readOnlyNote:string;
}
/** Portable creation prerequisites for a group folder and requested providers. */
export interface GroupPrerequisites {
 /** One result per requested provider, including repeats. */ providers:GroupPrerequisiteProvider[];
 /** Git discovery status on this machine. */ git:{found:boolean;version?:string};
 /** Folder repository status when a folder was supplied. */ folder?:{repository:boolean;reason?:string};
}
/** Availability of changed-file attribution for the group's folder. */
export interface GroupFilesCheck { /** Whether attribution is enabled. */ state:'on'|'off'; /** Why it is disabled. */ reason?:'no_git'|'not_a_repository'|'error'; /** Safe diagnostic detail. */ detail?:string }
/** Derived state shown for one member in a group. */
export type GroupMemberState='idle'|'queued'|'working'|'needs_user'|'failed';
/** One linked ordinary Chat session. Handles are unique lowercase `@` names in a group. */
export interface GroupMember {
 /** Linked Chat session id. */ sessionId:string;
 /** Provider selected for this member. */ provider:ProviderId;
 /** Unique group handle without the `@` prefix (`[a-z0-9-]{1,24}`). */ handle:string;
 /** Requested model selection when the provider supports it. */ model?:string;
 /** Whether the member uses saved permissions or the group read-only setup. */ mode:'default'|'read_only';
 /** Native read-only enforcement, when this member uses it. */ readOnly?:'enforced'|'prompt';
 /** Human-readable read-only setup explanation. */ readOnlyNote?:string;
 /** Current delivery/session-derived state. */ state:GroupMemberState;
 /** Latest delivery error retained for the member. */ error?:string;
 /** UTC time the member joined the group. */ joinedAt:string;
}
/** Explicit context attached to one user message. */
export interface GroupReference {
 /** Source kind; reply/message content is copied, files and URLs are identifiers only. */ kind:'reply'|'message'|'file'|'url';
 /** Referenced group message id for reply/message references. */ messageId?:string;
 /** Referenced member handle for reply references. */ handle?:string;
 /** Group-root-relative file path for file references. */ path?:string;
 /** Absolute http(s) URL for URL references. */ url?:string;
 /** User-visible reference label. */ title:string;
 /** UTF-8 bytes delivered to recipients after bounding. */ bytes:number;
 /** True when copied reply/message content was shortened. */ shortened?:boolean;
}
/** Lifecycle of one recipient's delivery of a user message. */
export type GroupDeliveryState='queued'|'working'|'needs_user'|'replied'|'failed'|'stopped';
/** One recipient delivery of a user-authored group message. */
export interface GroupDelivery {
 /** Recipient Chat session id. */ sessionId:string;
 /** Recipient handle. */ handle:string;
 /** Current delivery lifecycle state. */ state:GroupDeliveryState;
 /** Group reply id created when the delivery completes. */ replyId?:string;
 /** Failure or stop explanation. */ error?:string;
 /** UTC time the provider turn started. */ startedAt?:string;
 /** UTC time the turn completed, failed, or stopped. */ finishedAt?:string;
}
/** Outputs extracted from a completed member reply. */
export interface GroupOutputs {
  /** Root-relative paths named in the reply. */ files:string[];
  /** http(s) URLs named in the reply. */ urls:string[];
 /** Root-relative files attributed to the member during its delivery turn. */ changed:string[];
 /** Per-file status and evidence for attributed changes; absent on older replies. `changed` is a tool report without a verified folder delta. */
 changedDetails?:{path:string;status:'added'|'modified'|'deleted'|'changed';evidence:'tool'|'folder'}[];
 /** Root-relative files changed while one or more concurrent members could have written them. */
 possiblyChanged?:string[];
 /** Whether a bounded folder comparison could have omitted changes. */
 changedIncomplete?:boolean;
 /** Handles that were concurrent possible writers of `possiblyChanged` paths. */
 possiblyChangedWith?:string[];
}
/** A persisted user, member, or runtime timeline entry. */
export interface GroupMessage {
 /** Stable message id. */ id:string;
 /** Whether the message came from the user, a member, or the runtime. */ author:'user'|'member'|'system';
 /** Author Chat session for member messages. */ sessionId?:string;
 /** Author handle for member messages. */ handle?:string;
 /** Verbatim user text or bounded stored reply/system body. */ body:string;
 /** Recipient handles for a user message. */ recipients?:string[];
 /** Explicit references shown before the user sent the message. */ references?:GroupReference[];
 /** One delivery per recipient on a user message. */ deliveries?:GroupDelivery[];
 /** User message id answered by a member reply. */ replyTo?:string;
 /** Extracted files, URLs, and changed paths on a member reply. */ outputs?:GroupOutputs;
 /** User-controlled routing suggestions extracted from a member reply. */ suggestions?:{handle:string;text:string}[];
 /** UTC creation time. */ createdAt:string;
}
/** Durable room state and the current chronological timeline page. */
export interface Group {
 /** Stable group id. */ id:string;
 /** Optimistic-concurrency revision. */ revision:number;
 /** Display title. */ title:string;
 /** Optional registered project id. */ projectId?:string;
 /** Optional registered worktree path. */ worktreePath?:string;
 /** Canonical shared working directory. */ cwd:string;
 /** Linked Chat members. */ members:GroupMember[];
 /** Current chronological timeline page, not the whole unbounded timeline. */ messages:GroupMessage[];
 /** Recipients used when the composer had no leading mention. */ lastRecipients:string[];
 /** Folder-wide availability of changed-file attribution. */ filesCheck?:GroupFilesCheck;
 /** True when older messages exist before this page. */ hasMore?:boolean;
 /** Cursor to pass as `before` to load the preceding page. */ before?:string;
 /** Whether this group is archived. */ archived?:boolean;
 /** UTC creation time. */ createdAt:string;
 /** UTC time of the last state mutation. */ updatedAt:string;
}
/** Compact group row for sidebars and project views. */
export interface GroupSummary {
 /** Stable group id. */ id:string;
 /** Display title. */ title:string;
 /** Optional registered project id. */ projectId?:string;
 /** Optional registered worktree path. */ worktreePath?:string;
 /** Member identities and cheap derived states. */ members:{sessionId:string;provider:ProviderId;handle:string;state:GroupMemberState}[];
 /** UTC time of the last state mutation. */ updatedAt:string;
}
/** Result of parsing composer mentions without changing the user's text. */
export interface GroupMentionParse { /** Explicit leading recipients, prior recipients, or `all`. */ to:string[]; /** Later known handles whose latest replies should be reference chips. */ referenceHandles:string[]; /** Handles not present in the group, without `@`. */ unknownHandles:string[] }
/** Parses mentions for the group composer. Leading whitespace-separated known `@handles` or `@All` address recipients;
 * later known handles reference their latest reply. With no leading mention it returns a copy of `previousRecipients`,
 * or `['all']` for the first message. Unknown handles are reported for an add-member affordance and never routed. */
export function parseGroupMentions(text:string,handles:readonly string[],previousRecipients:readonly string[]=[]):GroupMentionParse {
 const known=new Set(handles.map(handle=>handle.toLowerCase())); const mentions=[...text.matchAll(/@([a-z0-9-]{1,24})\b/gi)];
 const unknown=[...new Set(mentions.map(match=>match[1].toLowerCase()).filter(handle=>handle!=='all'&&!known.has(handle)))];
 let end=0; const to:string[]=[];
 for(const match of mentions) { if(match.index!==end&&text.slice(end,match.index!).trim()!=='') break; const handle=match[1].toLowerCase(); if(handle==='all') { to.splice(0,to.length,'all'); end=(match.index??0)+match[0].length; continue; } if(!known.has(handle)||to.includes('all')) break; if(!to.includes(handle)) to.push(handle); end=(match.index??0)+match[0].length; }
 const leadingEnd=end; const references=[...new Set(mentions.filter(match=>(match.index??0)>=leadingEnd&&known.has(match[1].toLowerCase())).map(match=>match[1].toLowerCase()))];
 return {to:to.length?to:(previousRecipients.length?[...previousRecipients]:['all']),referenceHandles:references,unknownHandles:unknown};
}

export interface RequestMap {
 'preview.attach': [{sessionId:string;viewId:string;workspaceId?:string},{attachmentId:string;associations:PreviewAssociation[]}];
 'preview.detach': [{sessionId:string;attachmentId:string},null];
 'preview.snapshot': [{sessionId:string;attachmentId:string},PreviewAssociation[]];
 'preview.prepare': [{sessionId:string;attachmentId:string;requestId:string;previewId:string;documentId:string},PreviewAssociation];
 'preview.ack': [{sessionId:string;attachmentId:string;requestId:string;previewId:string;documentId:string;state:'presented'|'failed';tabId?:string;workspaceId?:string;workspaceRevision?:number;error?:PreviewError},PreviewResult];
 'preview.observe': [{sessionId:string;attachmentId:string;requestId:string;previewId:string;documentId:string;sequence:number;navigation:'pending'|'load_observed'|'failed';url?:string;title?:string;documentGeneration?:number;error?:PreviewError},PreviewResult];
 'preview.close': [{sessionId:string;attachmentId:string;previewId:string},null];
 'session.launch.read': [{sessionId:string},TerminalLaunchState];
 'catalog.visibility.list': [{},CatalogVisibility[]];
 'catalog.visibility.update': [{kind:CatalogVisibility['kind'];id:string;visibility:CatalogVisibility['visibility'];expectedRevision:number;operationId:string},CatalogVisibility];
 'device.status': [{},RemoteAccessStatus];
 'device.enable': [{operationId:string},RemoteAccessStatus];
 'device.disable': [{operationId:string},RemoteAccessStatus];
 'device.pairing.create': [{permission:DevicePermission;operationId:string},PairingOffer];
 'device.pairing.cancel': [{pairingId:string;operationId:string},null];
 'device.list': [{},PairedDevice[]];
 'device.rename': [{deviceId:string;name:string;operationId:string},PairedDevice];
 'device.renew': [{deviceId:string;operationId:string},PairedDevice];
 'device.revoke': [{deviceId:string;operationId:string},null];
 'terminal.read': [{sessionId:string;cursor?:number;limit?:number;tail?:boolean},{sessionId:string;fromCursor:number;nextCursor:number;truncated:boolean;encoding:'base64';data:string}];
 'session.lookup': [{operationId:string},Session|null];
 'session.resume': [{sessionId:string;cwd?:string;operationId:string},Session];
 'session.rerun': [{sessionId:string;operationId:string},Session];
 'session.present': [{sessionId:string;placement:'workspace'|'window';presentation:'background'|'focused';workspacePath?:string;operationId:string},{queued:boolean}];
 'chat.read': [{sessionId:string},ChatItem[]];
 'chat.subagent.read': [{sessionId:string;key:string;afterRev?:number},SubagentTranscriptRead];
 'chat.snapshot': [{sessionId:string},{items:ChatItem[];revision:number;repair:ChatRepairAvailability}];
 'chat.repair': [{sessionId:string;leaseEpoch:number;operationId:string},ChatRepairResult];
 'chat.draft.read': [{sessionId:string},{text:string;revision:number}];
 'chat.feedback.add': [{sessionId:string;turnId:string;text:string;operationId:string;leaseEpoch:number},{note:ChatFeedbackNote}];
 'chat.feedback.read': [{sessionId:string},{notes:ChatFeedbackNote[]}];
 /** E2: retire unread notes after the user sent them as a message. */
 'chat.feedback.dismiss': [{sessionId:string;noteIds:string[];operationId:string;leaseEpoch:number},{removed:string[]}];
 'chat.fork': [{sessionId:string;itemId?:string;operationId:string;leaseEpoch:number},{session:Session;mode:'native'|'copy'}];
 'chat.draft.save': [{sessionId:string;text:string;expectedRevision:number;leaseEpoch:number;operationId:string},{text:string;revision:number}];
 'data.status': [{},DataStatus];
 'data.backup': [{targetPath:string;operationId:string},{path:string;sizeBytes:number}];
 'data.relocation.status': [{},DataRelocationStatus];
 'data.relocation.prepare': [{targetPath:string;operationId:string},DataRelocationPrepared];
 'data.relocation.cancel': [{preparedOperationId:string;operationId:string},null];
 'settings.export': [{},SettingsBundle];
 'settings.import.preview': [{bundle:string},{valid:boolean;issues:string[];currentRevision:number;changes:{key:string;current:unknown;incoming:unknown}[]}];
 'settings.import.apply': [{bundle:string;selected:string[];expectedRevision:number;operationId:string},Settings];
 'usage.query': [{from?:string;to?:string;sessionId?:string;projectId?:string;provider?:ProviderId;status?:SessionStatus;source?:UsageSource;sourceSessionId?:string},UsageResult];

 'runtime.health': [{},{version:string;epoch:string;contract:number}];
 /** Which console host Windows terminals run on: the in-box ConPTY or ThreadTerm's bundled OpenConsole. */
 'terminal.host': [{},{conptyHost:'system'|'bundled';bundledAvailable:boolean}];
 'runtime.shutdown': [{operationId:string},null];
 'runtime.snapshot': [{},Snapshot];
 'project.add': [{path:string;name?:string;operationId:string},Project];
 'project.remove': [{id:string;operationId:string},null];
 'project.catalog.list': [{},ProjectCatalogItem[]];
 'project.update': [{id:string;name?:string;pinned?:boolean;sortOrder?:number;expectedRevision:number;operationId:string},ProjectCatalogItem];
 'session.create': [{projectId?:string;cwd:string;title?:string;provider:ProviderId;mode:SessionMode;executable?:string;args?:string[];nativeId?:string;deferLaunch?:boolean;operationId:string},Session];
 'history.import': [{projectId?:string;provider:ProviderId;nativeId:string;cwd:string;mode:SessionMode;title?:string;operationId:string},Session];
 'session.config.read': [{sessionId:string},SessionConfig];
 'session.config.save': [{sessionId:string;provider:ProviderId;mode:SessionMode;cwd:string;projectId?:string;title?:string;executable?:string;args?:string[];expectedRevision:number;operationId:string},SessionConfig];
 'session.retry.read': [{sessionId:string},SessionRetryState];
 'session.retry.update': [{sessionId:string;enabled:boolean;maxRetries?:number;delaySeconds?:number;expectedRevision:number;operationId:string},SessionRetryState];
 'session.stop': [{sessionId:string;operationId:string;force?:boolean},null];
 'session.organize': [{sessionId:string;archived?:boolean;pinned?:boolean;bookmarked?:boolean;intent?:'review'|'fix'|'research'|'test'|'docs'|'none';sortOrder?:number;expectedRevision:number;operationId:string},Session];
 'session.update': [{sessionId:string;title?:string;followed?:boolean;operationId:string},Session];
 'session.attention.acknowledge': [{sessionId:string;expectedRevision:number;operationId:string},Session];
 'session.claim': [{sessionId:string;clientId:string},{leaseEpoch:number}];
 'session.renew': [{sessionId:string;leaseEpoch:number},{leaseEpoch:number}];
 'session.release': [{sessionId:string;leaseEpoch:number},null];
 'terminal.input': [{sessionId:string;data:string;leaseEpoch:number},null];
 'terminal.resize': [{sessionId:string;cols:number;rows:number;leaseEpoch:number},null];
 'settings.update': [{patch:Record<string,unknown>;expectedRevision:number;operationId:string},Settings];
 'provider.list': [{},ProviderCapability[]];
 /** Forces one fresh provider capability round and returns its id before the probe completes. Additive. */
 'provider.refresh': [{},{refreshId:number}];
 'plugin.list': [{},PluginList];
 'plugin.setEnabled': [{pluginId:string;enabled:boolean;operationId:string},PluginList];
 'plugin.selectBrowserBinding': [{pluginId:string;bindingId:string;operationId:string},PluginList];
 'plugin.reload': [{operationId:string},PluginList];
 'chat.queue.read': [{sessionId:string},ChatQueue];
 /** Mutations need the Chat write lease (like chat.send); each returns the whole queue. ≤ 20 items. */
 'chat.queue.add': [{sessionId:string;text:string;images?:string[];operationId:string;leaseEpoch:number},ChatQueue];
 'chat.queue.update': [{sessionId:string;itemId:string;text:string;expectedRevision:number;operationId:string;leaseEpoch:number},ChatQueue];
 'chat.queue.remove': [{sessionId:string;itemId:string;operationId:string;leaseEpoch:number},ChatQueue];
 'chat.queue.move': [{sessionId:string;itemId:string;toIndex:number;operationId:string;leaseEpoch:number},ChatQueue];
 'chat.queue.pause': [{sessionId:string;operationId:string;leaseEpoch:number},ChatQueue];
 /** Unpauses and sends the next item when the agent is idle. */
 'chat.queue.resume': [{sessionId:string;operationId:string;leaseEpoch:number},ChatQueue];
 /** Moves the item to the front, unpauses, and sends it when the agent is idle. */
 'chat.queue.send': [{sessionId:string;itemId:string;operationId:string;leaseEpoch:number},ChatQueue];
 'quickLaunch.list': [{projectId:string},QuickLaunchCommand[]];
 /** Creates (no `id`) or replaces a command (`id` + `expectedRevision`; a stale revision fails with `revision_conflict`). */
 'quickLaunch.save': [{projectId:string;id?:string;expectedRevision?:number;name:string;command:string;shell:QuickLaunchShell;cwd:string;kind:QuickLaunchKind;env:QuickLaunchEnvVar[];previewUrl?:string;operationId:string},QuickLaunchCommand];
 /** Running runs of the command keep running. */
 'quickLaunch.delete': [{id:string;expectedRevision:number;operationId:string},null];
 /** Runs the command in the worktree whose root is `cwd` (a registered root of the command's project). When a run of this
  * command is already active in that root, returns it with `existing: true` instead of starting another. */
 'quickLaunch.run': [{commandId:string;cwd:string;operationId:string},{session:Session;existing:boolean}];
 'quickLaunch.setup.read': [{projectId:string},QuickLaunchSetup];
 /** Ordered `task` commands of the project, unique, at most 20; [] turns setup off. Stale revision → `revision_conflict`.
  * Deleting a command removes it from the list. */
 'quickLaunch.setup.save': [{projectId:string;commandIds:string[];expectedRevision:number;operationId:string},QuickLaunchSetup];
 /** Runs setup in the worktree whose root is `cwd`. Without `fromStep`: the saved list from step 0 (`manual`; `setup_empty`
  * when none). With `fromStep`: the latest sequence of that root again from that step, with its snapshot (`retry`;
  * `invalid_step` when out of range or no sequence exists). A sequence already running in that root is returned as is. */
 'quickLaunch.setup.run': [{projectId:string;cwd:string;fromStep?:number;operationId:string},WorktreeSetupRun];
 /** The latest sequence of each worktree root of the project. */
 'quickLaunch.setup.status': [{projectId:string},WorktreeSetupRun[]];
 'history.list': [{provider:ProviderId;cursor?:string;limit?:number;cwd?:string},{items:NativeHistoryItem[];nextCursor?:string}];
 'history.read': [{provider:ProviderId;nativeId:string},ChatItem[]];
 'chat.send': [{sessionId:string;text:string;images?:string[];operationId:string;leaseEpoch:number},{turnId:string}];
 /** Inserts into the running turn. `note` is reserved for a later fallback; native steering returns `delivered` or `queued`. */
 'chat.steer': [{sessionId:string;turnId:string;text:string;images?:string[];operationId:string;leaseEpoch:number;queueItemId?:string},{disposition:'delivered'|'queued'|'note'}];
 'chat.cancel': [{sessionId:string;turnId:string;leaseEpoch:number},null];
 'chat.approve': [{sessionId:string;turnId:string;approvalId:string;choiceId:string;leaseEpoch:number;operationId:string},null];
 'browser.approval.read': [{sessionId:string;turnId:string;approvalId:string;leaseEpoch:number},BrowserEvalApprovalRead];
 'browser.approval.resolve': [{sessionId:string;turnId:string;approvalId:string;leaseEpoch:number;operationId:string;codeHash:string;choice:'approve_once'|'deny'},{status:'approved'|'denied'}];
 'chat.answer': [{sessionId:string;turnId:string;approvalId:string;leaseEpoch:number;operationId:string;response:ChatAnswerResponse},null];
 'chat.projectTrust.set': [{sessionId:string;decision:'trusted'|'declined'|'none';leaseEpoch:number;operationId:string},ChatUiState];
 'chat.options': [{sessionId:string},ChatUiState];
 'chat.backgroundTasks.list': [{sessionId:string},{tasks:ChatBackgroundTask[]}];
 'chat.backgroundTask.stop': [{sessionId:string;taskId:string;leaseEpoch:number;operationId:string},{accepted:boolean}];
 'chat.context.read': [{sessionId:string},ChatContextUsage|null];
 'chat.option.set': [{sessionId:string;optionId:string;value:string;leaseEpoch:number;operationId:string},ChatUiState];
 'chat.connection': [{sessionId:string},ChatConnectionState];
 'chat.connect': [{sessionId:string;leaseEpoch:number;operationId:string},ChatConnectionState];
 'filesystem.list': [FileScope&{path:string},FileEntry[]];
 'filesystem.resolve': [{sessionId:string}&FileReference,ResolvedFileReference];
 'filesystem.read': [FileScope&{path:string},FileDocument];
 'filesystem.image': [FileScope&{path:string},{mime:'image/png'|'image/jpeg'|'image/gif'|'image/webp';data:string}];
 'filesystem.write': [FileScope&{path:string;content:string;expectedFingerprint:string;operationId:string},FileDocument];
 'draft.list': [FileScope,Draft[]];
 'draft.put': [FileScope&{path:string;content:string;baseFingerprint:string;expectedRevision:number;operationId:string},Draft];
 'draft.delete': [{id:string;expectedRevision:number;operationId:string},null];
 'git.status': [FileScope,GitStatus];
 'git.stage': [FileScope&{paths:string[];expectedFingerprints?:Record<string,string>;operationId:string},{paths:string[]}];
 'git.unstage': [FileScope&{paths:string[];expectedFingerprints?:Record<string,string>;operationId:string},{paths:string[]}];
 'git.commit': [FileScope&{message:string;amend?:boolean;operationId:string},{commit:string}];
 'git.commit.selected': [FileScope&{message:string;selected:GitSelectedCommitEntry[];expectedHead:GitHeadSnapshot;expectedIndexFingerprint:string;operationId:string},GitSelectedCommitResult];
 'git.fetch': [FileScope&{operationId:string},{output:string}];
 'git.pull': [FileScope&{operationId:string},{output:string}];
 'git.push': [FileScope&{setUpstream?:boolean;operationId:string},{output:string}];
 'git.merge': [FileScope&{branch:string;operationId:string},{output:string;conflicted:boolean}];
 'git.merge.abort': [FileScope&{operationId:string},{output:string}];
 'git.diff': [FileScope&{path:string;staged:boolean},GitDiff];
 'git.index.write': [FileScope&{path:string;content:string;expectedIndexFingerprint:string|null;operationId:string},{path:string;indexFingerprint:string}];
 'git.discard': [FileScope&{paths:string[];expectedFingerprints?:Record<string,string>;operationId:string},{paths:string[];recycled:string[]}];
 'git.checkout': [FileScope&{branch:string;create?:boolean;startPoint?:string;operationId:string},{branch:string}];
 'git.branch.delete': [FileScope&{branch:string;force?:boolean;operationId:string},{branch:string}];
 'git.branches': [FileScope,GitBranches];
 'git.log': [FileScope&{path?:string;skip?:number;limit?:number;all?:boolean},GitLog];
 'git.commit.show': [FileScope&{commit:string},GitCommitDetail];
 'git.commit.diff': [FileScope&{commit:string;path:string;originalPath?:string},GitTextPair];
 'git.blame': [FileScope&{path:string},GitBlame];
 'filesystem.create': [FileScope&{path:string;kind:'file'|'directory';operationId:string},FileEntry];
 'filesystem.rename': [FileScope&{path:string;newPath:string;operationId:string},FileEntry];
 'filesystem.delete': [FileScope&{path:string;permanent?:boolean;operationId:string},{path:string;recycled:boolean}];
 'filesystem.files': [FileScope,FileListResult];
 'filesystem.search': [FileScope&SearchQuery,SearchResult];
 'review.list': [{sessionId:string},ReviewState];
 'review.changes': [{sessionId:string;from:string;to?:string},{files:ReviewFile[]}];
 'review.diff': [{sessionId:string;from:string;to?:string;path:string},ReviewDiff];
 'review.revert': [{sessionId:string;checkpointId:string;paths:string[];expectedFingerprints:Record<string,string|null>;operationId:string},{restored:string[];recycled:string[]}];
 'review.checkpoint': [{sessionId:string;kind:'manual'|'baseline';operationId:string},ReviewCheckpoint];
 /** Starts a reviewer Chat of `agent` in the session's worktree with the captured changes. No lease: the reviewed session
  * is not written. Errors: unknown_agent, agent_unavailable, checkpoint_not_found, not_a_git_worktree, no_changes,
  * agent_review_limit (3 reviews of one session starting or running). */
 'agentReview.start': [{sessionId:string;agent:ProviderId;scope:AgentReviewScope;operationId:string},AgentReview];
 /** Newest first, at most 20. A finished reviewer's last reply is parsed once, and again only after it answers again. */
 'agentReview.list': [{sessionId:string},AgentReview[]];
 'agentReview.mark': [{reviewId:string;findingIds:string[];state:'open'|'added'|'dismissed';operationId:string},AgentReview];
 /** Detects portable provider and folder prerequisites without starting a model turn. */
 'group.prerequisites': [{cwd?:string;providers?:ProviderId[]},GroupPrerequisites];
 /** Creates one to six linked Chat members; the first descriptor binds `fromSessionId` when supplied. */
 'group.create': [{projectId?:string;cwd:string;title?:string;members:{provider:ProviderId;handle?:string;model?:string;mode?:'default'|'read_only'}[];fromSessionId?:string;expectedRevision?:number;operationId:string},Group];
 /** Most recently updated groups, optionally scoped to a project. */
 'group.list': [{projectId?:string},GroupSummary[]];
 /** Reads a chronological timeline page. `before` is the previous response's cursor; limit defaults to 100 and is at most 200. */
 'group.read': [{id:string;before?:string;limit?:number},Group];
 /** Posts verbatim user text to explicit recipient handles with visible references. */
 'group.send': [{id:string;text:string;to:string[];references?:{kind:GroupReference['kind'];messageId?:string;path?:string;url?:string}[];expectedRevision?:number;operationId:string},Group];
 /** Stops all deliveries for a message, or only the named recipient. */
 'group.stop': [{id:string;messageId:string;handle?:string;expectedRevision?:number;operationId:string},Group];
 /** Requeues a failed, stopped, or restart-interrupted delivery. */
 'group.resend': [{id:string;messageId:string;handle:string;expectedRevision?:number;operationId:string},Group];
 /** Adds one new provider-backed Chat member. */
 'group.member.add': [{id:string;provider:ProviderId;handle?:string;model?:string;mode?:'default'|'read_only';expectedRevision?:number;operationId:string},Group];
 /** Renames a member and/or changes its read-only mode. */
 'group.member.update': [{id:string;sessionId:string;handle?:string;mode?:'default'|'read_only';expectedRevision?:number;operationId:string},Group];
 /** Removes only the group link; the Chat session remains available. */
 'group.member.remove': [{id:string;sessionId:string;expectedRevision?:number;operationId:string},Group];
 /** Renames the group. */
 'group.rename': [{id:string;title:string;expectedRevision?:number;operationId:string},Group];
 /** Archives by default; pass `archived:false` to restore. */
 'group.archive': [{id:string;archived?:boolean;expectedRevision?:number;operationId:string},Group];
 /** In pin order. */
 'session.documents.list': [{sessionId:string},SessionDocument[]];
 /** Pins a file inside the session's worktree (≤ 2 MiB; at most 20 pins → `too_many_documents`; `not_a_file`,
  * `path_outside_root`). Pinning a pinned file changes nothing. Both return the whole list. */
 'session.documents.pin': [{sessionId:string;path:string;operationId:string},SessionDocument[]];
 'session.documents.unpin': [{sessionId:string;path:string;operationId:string},SessionDocument[]];
 'worktree.list': [{projectId:string},Worktree[]];
 'worktree.create': [{projectId:string;path:string;branch:string;createBranch:boolean;operationId:string},Worktree];
 'worktree.remove': [{id:string;operationId:string},null];
 'worktree.branches': [{projectId:string},LocalBranch[]];
 'worktree.relocate': [{id:string;path:string;operationId:string},Worktree];
 'workspace.save': [WorkspaceSave,Workspace];
 'workspace.delete': [{id:string;expectedRevision:number;operationId:string},null];
 'inbox.read': [{ids:string[];operationId:string},null];
}
export type Method = keyof RequestMap;
export type RequestParams<M extends Method> = RequestMap[M][0];
export type RequestResult<M extends Method> = RequestMap[M][1];
export interface OutputChunk { sessionId:string; cursor:number; data:Uint8Array; gap?:boolean }
export interface ThreadTermBridge {
 readonly platform:string;
 readonly windowsPty?:{backend:'conpty';buildNumber:number};
 request<M extends Method>(method:M,params:RequestParams<M>):Promise<RequestResult<M>>;
 onEvent(listener:(event:RuntimeEvent)=>void):()=>void;
 onDesktopNavigate(listener:(target:{sessionId?:string;workspaceId?:string;action?:"command-palette"})=>void):()=>void;
 windowState():Promise<{maximized:boolean}>;
 onWindowState(listener:(state:{maximized:boolean})=>void):()=>void;
 subscribeOutput(sessionId:string,cursor:number,onChunk:(chunk:OutputChunk)=>void|Promise<void>):Promise<()=>void>;
 chooseDirectory():Promise<string|null>;
 /** Files picked through the native open dialog. Images within the composer's
  * size budget carry a data URL so they use the existing image attachment path;
  * every other file is a `file` context chip the agent can read by path. */
 attachFiles():Promise<AttachedFile[]>;
 chooseSavePath(kind:'database'|'settings'|'theme'):Promise<string|null>;
 exportFile(kind:'settings'|'theme'):Promise<{path:string}|null>;
 exportChatMarkdown?(payload:{title:string;markdown:string;locale?:'en'|'zh-CN';images?:{name:string;dataUrl:string}[];assetToken?:string}):Promise<string|null>;
 activateDataRelocation(prepared:DataRelocationPrepared):Promise<{activated:boolean}>;
 windowAction(action:'minimize'|'maximize'|'close'|'quit'):Promise<void>;
 openWindow(options:{sessionId?:string;workspaceId?:string}):Promise<void>;
 openExternal(url:string):Promise<void>;
 /** Opens the user plugins directory (`PluginList.directory`) in the file manager, creating it if needed. */
 openPluginsFolder():Promise<void>;
 /** Page comments: lets the user pick an element (click) or an area (drag) inside the preview iframe named
  * `frameName` (`tt-preview-…`, a frame of the calling window). `frameRect` is the iframe's CSS-pixel rect in the
  * window. Resolves with the pick, or null when cancelled (Esc in the page, cancelPagePick, navigation). */
 pickPageTarget(request:{ frameName:string; frameRect:PageRect }):Promise<PagePick|null>;
 cancelPagePick(frameName:string):Promise<void>;
 /** Outlines a target in the preview (kept while a comment form is open, `flash` = brief highlight + scroll into
  * view); `target` undefined clears. Resolves false when the target can no longer be found on the page. */
 markPageTarget(request:{ frameName:string; target?:PageTargetRef; flash?:boolean }):Promise<boolean>;
 /** The full screenshot of a pick as a data URL (for Chat image attachments); undefined when it was removed. */
 readPageShot(shotId:string):Promise<string|undefined>;
 deletePageShots(shotIds:string[]):Promise<void>;
  /** Desktop preview element menu. This is an Electron-only event and never reaches the runtime. */
  onPageContextMenu(listener:(value:{frameName:string;x:number;y:number;pick?:PagePick;staticFrame?:boolean;selectionText:string})=>void):()=>void;
 openDirectory(projectId:string,worktreeId?:string):Promise<void>;
 revealFile?(sessionId:string,path:string):Promise<void>;
 desktopPreferences():Promise<{shortcuts:Record<string,string>}>;
 testNotification():Promise<{sent:boolean;reason?:string}>;
 exportDiagnostics():Promise<string|null>;
 scheduleElectronCacheCleanup(schedule:boolean):Promise<{scheduled:boolean;available:boolean;result?:string}>;
}
export const METHODS = ['browser.approval.read','browser.approval.resolve','git.commit.selected','preview.attach','preview.detach','preview.snapshot','preview.prepare','preview.ack','preview.observe','preview.close','chat.repair','filesystem.resolve','session.launch.read','catalog.visibility.list','catalog.visibility.update','session.resume','session.organize','git.merge','git.merge.abort','project.catalog.list','project.update','worktree.branches','worktree.relocate','session.rerun','git.fetch','git.pull','git.push','session.config.read','session.config.save','session.retry.read','session.retry.update','chat.draft.read','chat.draft.save','device.status','device.enable','device.disable','device.pairing.create','device.pairing.cancel','device.list','device.rename','device.renew','device.revoke','git.stage','git.unstage','git.commit','filesystem.image','chat.snapshot','terminal.read','session.lookup','session.present','chat.read','chat.subagent.read','data.status','data.backup','data.relocation.status','data.relocation.prepare','data.relocation.cancel','settings.export','settings.import.preview','settings.import.apply','usage.query','runtime.health','terminal.host','runtime.shutdown','runtime.snapshot','project.add','project.remove','session.create','history.import','session.stop','session.update','session.attention.acknowledge','session.claim','session.renew','session.release','terminal.input','terminal.resize','settings.update','provider.list','provider.refresh','plugin.list','plugin.setEnabled','plugin.selectBrowserBinding','plugin.reload','chat.queue.read','chat.queue.add','chat.queue.update','chat.queue.remove','chat.queue.move','chat.queue.pause','chat.queue.resume','chat.queue.send','quickLaunch.list','quickLaunch.save','quickLaunch.delete','quickLaunch.run','quickLaunch.setup.read','quickLaunch.setup.save','quickLaunch.setup.run','quickLaunch.setup.status','history.list','history.read','chat.send','chat.cancel','chat.approve','chat.answer','chat.options','chat.option.set','chat.connection','chat.context.read','chat.connect','filesystem.list','filesystem.read','filesystem.write','draft.list','draft.put','draft.delete','git.status','git.diff','worktree.list','worktree.create','worktree.remove','workspace.save','workspace.delete','inbox.read','git.index.write','git.discard','git.checkout','git.branch.delete','git.branches','git.log','git.commit.show','git.commit.diff','git.blame','filesystem.create','filesystem.rename','filesystem.delete','filesystem.files','filesystem.search','review.list','review.changes','review.diff','review.revert','review.checkpoint','agentReview.start','agentReview.list','agentReview.mark','group.prerequisites','group.create','group.list','group.read','group.send','group.stop','group.resend','group.member.add','group.member.update','group.member.remove','group.rename','group.archive','session.documents.list','session.documents.pin','session.documents.unpin','chat.projectTrust.set','chat.feedback.add','chat.feedback.read','chat.feedback.dismiss','chat.fork','chat.backgroundTasks.list','chat.backgroundTask.stop','chat.steer'] as const satisfies readonly Method[];
// Kept additive while this long-standing literal remains source-compatible.
// The RPC has a RequestMap entry above and must also pass the runtime registry.
const stringFields: Partial<Record<Method,readonly string[]>> = {
 'browser.approval.read':['sessionId','turnId','approvalId'],
 'browser.approval.resolve':['sessionId','turnId','approvalId','operationId','codeHash'],
 'git.commit.selected':['projectId','message','operationId','expectedIndexFingerprint'],
 'plugin.selectBrowserBinding':['pluginId','bindingId','operationId'],
 'preview.attach':['sessionId','viewId'],'preview.detach':['sessionId','attachmentId'],'preview.snapshot':['sessionId','attachmentId'],
 'preview.prepare':['sessionId','attachmentId','requestId','previewId','documentId'],
 'preview.ack':['sessionId','attachmentId','requestId','previewId','documentId'],'preview.observe':['sessionId','attachmentId','requestId','previewId','documentId'],'preview.close':['sessionId','attachmentId','previewId'],
 'filesystem.resolve':['sessionId','path'],
 'session.launch.read':['sessionId'],
 'catalog.visibility.update':['kind','id','visibility','operationId'],
 'session.resume':['sessionId','operationId'],
 'session.organize':['sessionId','operationId'],'git.merge':['projectId','branch','operationId'],'git.merge.abort':['projectId','operationId'],
 'project.update':['id','operationId'],'worktree.branches':['projectId'],'worktree.relocate':['id','path','operationId'],
 'device.enable':['operationId'],'device.disable':['operationId'],'device.pairing.create':['permission','operationId'],'device.pairing.cancel':['pairingId','operationId'],'device.rename':['deviceId','name','operationId'],'device.renew':['deviceId','operationId'],'device.revoke':['deviceId','operationId'],
 'terminal.read':['sessionId'],'session.lookup':['operationId'],'session.present':['sessionId','placement','presentation','operationId'],
 'chat.read':['sessionId'],
 'chat.subagent.read':['sessionId','key'],
 'chat.snapshot':['sessionId'],
 'chat.repair':['sessionId','operationId'],
 'data.backup':['targetPath','operationId'],'data.relocation.prepare':['targetPath','operationId'],'data.relocation.cancel':['preparedOperationId','operationId'],'settings.import.preview':['bundle'],'settings.import.apply':['bundle','operationId'],
 'runtime.shutdown':['operationId'],
 'project.add':['path','operationId'],'project.remove':['id','operationId'],
 'session.create':['cwd','provider','mode','operationId'],'history.import':['cwd','provider','nativeId','mode','operationId'],'session.config.read':['sessionId'],'session.config.save':['sessionId','cwd','provider','mode','operationId'],'session.retry.read':['sessionId'],'session.retry.update':['sessionId','operationId'],'session.stop':['sessionId','operationId'],
 'session.update':['sessionId','operationId'],'session.attention.acknowledge':['sessionId','operationId'],'session.claim':['sessionId','clientId'],'session.release':['sessionId'],
 'session.renew':['sessionId'],
 'terminal.input':['sessionId','data'],'terminal.resize':['sessionId'],
 'settings.update':['operationId'],'plugin.setEnabled':['pluginId','operationId'],'plugin.reload':['operationId'],'chat.queue.read':['sessionId'],'chat.queue.add':['sessionId','text','operationId'],'chat.queue.update':['sessionId','itemId','text','operationId'],'chat.queue.remove':['sessionId','itemId','operationId'],'chat.queue.move':['sessionId','itemId','operationId'],'chat.queue.pause':['sessionId','operationId'],'chat.queue.resume':['sessionId','operationId'],'chat.queue.send':['sessionId','itemId','operationId'],'quickLaunch.list':['projectId'],'quickLaunch.save':['projectId','name','command','shell','kind','operationId'],'quickLaunch.delete':['id','operationId'],'quickLaunch.run':['commandId','cwd','operationId'],'quickLaunch.setup.read':['projectId'],'quickLaunch.setup.save':['projectId','operationId'],'quickLaunch.setup.run':['projectId','cwd','operationId'],'quickLaunch.setup.status':['projectId'],'history.list':['provider'],'history.read':['provider','nativeId'],
 'chat.send':['sessionId','text','operationId'],'chat.steer':['sessionId','turnId','text','operationId'],'chat.cancel':['sessionId','turnId'],
 'chat.approve':['sessionId','turnId','approvalId','choiceId','operationId'],'chat.projectTrust.set':['sessionId','decision','operationId'],
 'chat.answer':['sessionId','turnId','approvalId','operationId'],
 'chat.feedback.add':['sessionId','turnId','text','operationId'],'chat.feedback.read':['sessionId'],'chat.feedback.dismiss':['sessionId','operationId'],
 'chat.fork':['sessionId','operationId'],
 'chat.options':['sessionId'],'chat.backgroundTasks.list':['sessionId'],'chat.backgroundTask.stop':['sessionId','taskId','operationId'],'chat.option.set':['sessionId','optionId','value','operationId'],
 'chat.connection':['sessionId'],'chat.context.read':['sessionId'],'chat.connect':['sessionId','operationId'],
 'filesystem.list':['projectId'], 'filesystem.read':['projectId','path'],
 'filesystem.write':['projectId','path','expectedFingerprint','operationId'],
 'draft.list':['projectId'],'draft.put':['projectId','path','baseFingerprint','operationId'],
 'draft.delete':['id','operationId'],'git.status':['projectId'],'git.diff':['projectId','path'],
 'worktree.list':['projectId'],'worktree.create':['projectId','path','branch','operationId'],
 'worktree.remove':['id','operationId'],'workspace.save':['name','operationId'],
 'workspace.delete':['id','operationId'],'inbox.read':['operationId'],
 'git.index.write':['projectId','path','operationId'],'git.discard':['projectId','operationId'],'git.checkout':['projectId','branch','operationId'],'git.branch.delete':['projectId','branch','operationId'],
 'git.branches':['projectId'],'git.log':['projectId'],'git.commit.show':['projectId','commit'],'git.commit.diff':['projectId','commit','path'],'git.blame':['projectId','path'],
 'filesystem.create':['projectId','path','kind','operationId'],'filesystem.rename':['projectId','path','newPath','operationId'],'filesystem.delete':['projectId','path','operationId'],'filesystem.files':['projectId'],'filesystem.search':['projectId','query'],
 'review.list':['sessionId'],'review.changes':['sessionId','from'],'review.diff':['sessionId','from','path'],'review.revert':['sessionId','checkpointId','operationId'],'review.checkpoint':['sessionId','kind','operationId'],
 'agentReview.start':['sessionId','agent','operationId'],'agentReview.list':['sessionId'],'agentReview.mark':['reviewId','state','operationId'],
 'group.create':['cwd','operationId'],'group.read':['id'],'group.send':['id','text','operationId'],'group.stop':['id','messageId','operationId'],'group.resend':['id','messageId','handle','operationId'],'group.member.add':['id','provider','operationId'],'group.member.update':['id','sessionId','operationId'],'group.member.remove':['id','sessionId','operationId'],'group.rename':['id','title','operationId'],'group.archive':['id','operationId'],
 'session.documents.list':['sessionId'],'session.documents.pin':['sessionId','path','operationId'],'session.documents.unpin':['sessionId','path','operationId'],
};
export function isRecord(value:unknown):value is Record<string,unknown> { return typeof value==='object' && value!==null && !Array.isArray(value); }
export function validateRequest(method:unknown,params:unknown):asserts method is Method {
 if(typeof method!=='string'||!(METHODS as readonly string[]).includes(method)) throw new Error('Unsupported runtime method');
 if(!isRecord(params)) throw new Error('Request parameters must be an object');
 if(!validateWireRequest({v:1,id:'boundary',method,params})) throw new Error('Request does not match the protocol schema');
 const m=method as Method;
 if(m==='git.commit.selected') {
  if(typeof params.message!=='string'||!params.message.trim()||new TextEncoder().encode(params.message).length+(params.message.endsWith('\n')?0:1)>64*1024)throw new Error('Invalid commit message');
  if(typeof params.expectedIndexFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(params.expectedIndexFingerprint))throw new Error('Invalid index snapshot');
  if(!Array.isArray(params.selected)||!params.selected.length||params.selected.length>500)throw new Error('Invalid selected paths');
  const paths=new Set<string>();
  for(const row of params.selected) {
   if(!isRecord(row)||typeof row.path!=='string'||!row.path||new TextEncoder().encode(row.path).length>4096||/[\u0000-\u001f\u007f]/.test(row.path)||/^(?:[\\/]|[a-z]:)/i.test(row.path)||row.path.split(/[\\/]/).some(part=>!part||part==='.'||part==='..')||paths.has(row.path)||typeof row.indexStatus!=='string'||!/^[AMDRCT]$/.test(row.indexStatus))throw new Error('Invalid selected path');
   paths.add(row.path);
   if(row.indexStatus==='R'&&(!row.originalPath||typeof row.originalPath!=='string'))throw new Error('Rename requires its original path');
   if(row.originalPath!==undefined&&(typeof row.originalPath!=='string'||new TextEncoder().encode(row.originalPath).length>4096||/[\u0000-\u001f\u007f]/.test(row.originalPath)||/^(?:[\\/]|[a-z]:)/i.test(row.originalPath)||row.originalPath.split(/[\\/]/).some(part=>!part||part==='.'||part==='..')))throw new Error('Invalid original path');
  }
  const head=params.expectedHead;
  if(!isRecord(head)||!['branch','detached','unborn'].includes(String(head.kind))||(head.kind!=='unborn'&&(typeof head.oid!=='string'||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head.oid)))||(head.kind!=='detached'&&(typeof head.target!=='string'||!head.target.startsWith('refs/heads/')||head.target.length>1024||/[\u0000-\u0020\u007f]/.test(head.target))))throw new Error('Invalid HEAD snapshot');
 }
 if(m.startsWith('preview.')) {
  for(const field of ['sessionId','viewId','workspaceId','attachmentId','requestId','previewId','documentId','tabId']) {
   const value=params[field];if(value!==undefined&&(typeof value!=='string'||!value||value.length>256||/[\u0000-\u001f\u007f]/.test(value)))throw new Error('Invalid preview identity');
  }
  if(m==='preview.ack'&&params.state==='presented'&&(!params.tabId||!params.workspaceId||!Number.isSafeInteger(params.workspaceRevision)||Number(params.workspaceRevision)<1))throw new Error('Preview presentation requires a saved tab revision');
  if(m==='preview.observe'&&(!Number.isSafeInteger(params.sequence)||Number(params.sequence)<0))throw new Error('Invalid preview sequence');
  if(m==='preview.observe'&&params.documentGeneration!==undefined&&(!Number.isSafeInteger(params.documentGeneration)||Number(params.documentGeneration)<0))throw new Error('Invalid preview document generation');
  if(params.error!==undefined&&isRecord(params.error)&&(typeof params.error.code!=='string'||!params.error.code||params.error.code.length>256||typeof params.error.message!=='string'||params.error.message.length>2048))throw new Error('Invalid preview error');
 }
 for(const key of stringFields[m]??[]) {
  const imageOnlyText=(m==='chat.send'||m==='chat.steer'||m==='chat.queue.add')&&key==='text'&&Array.isArray(params.images)&&params.images.length>0;
  if(typeof params[key]!=='string'||(key!=='data'&&!imageOnlyText&&params[key]==='')) throw new Error(`Invalid ${key}`);
 }
 if(m==='device.pairing.create'&&!['readonly','fullcontrol'].includes(String(params.permission))) throw new Error('Invalid device permission');
 if(m==='catalog.visibility.update') {
  if(!['project','worktree','session'].includes(String(params.kind))) throw new Error('Invalid catalog kind');
  if(!['active','archived','removed'].includes(String(params.visibility))) throw new Error('Invalid catalog visibility');
 }
 if(m==='device.rename') {
  const name=String(params.name).trim();
  if(name.length===0||[...name].length>80) throw new Error('Invalid device name');
 }
 if(m==='session.stop'&&params.force!==undefined&&typeof params.force!=='boolean') throw new Error('Invalid force');
 if('leaseEpoch' in params && (!Number.isSafeInteger(params.leaseEpoch)||Number(params.leaseEpoch)<1)) throw new Error('Invalid leaseEpoch');
 if(m==='browser.approval.read'||m==='browser.approval.resolve') {
  if(!Number.isSafeInteger(params.leaseEpoch)||Number(params.leaseEpoch)<1)throw new Error('Invalid browser approval lease');
  for(const key of ['sessionId','turnId','approvalId',...(m==='browser.approval.resolve'?['operationId']:[])]) {
   if(typeof params[key]!=='string'||!params[key]||new TextEncoder().encode(params[key]).byteLength>256||/[\u0000-\u001f\u007f-\u009f]/.test(params[key] as string))throw new Error('Invalid browser approval identity');
  }
  if(m==='browser.approval.resolve'&&(!['approve_once','deny'].includes(String(params.choice))||typeof params.codeHash!=='string'||!/^[a-f0-9]{64}$/.test(params.codeHash)))throw new Error('Invalid browser approval decision');
 }
 if(['session.renew','session.release','terminal.input','terminal.resize','chat.fork','chat.send','chat.queue.add','chat.queue.update','chat.queue.remove','chat.queue.move','chat.queue.pause','chat.queue.resume','chat.queue.send','chat.cancel','chat.approve','chat.answer','chat.projectTrust.set','chat.repair','chat.backgroundTask.stop','chat.option.set','chat.connect','chat.steer','chat.feedback.dismiss'].includes(m)&&!('leaseEpoch' in params)) throw new Error('Missing leaseEpoch');
 if(m==='chat.projectTrust.set'&&!['trusted','declined','none'].includes(String(params.decision))) throw new Error('Invalid Pi project trust decision');
 if(m==='terminal.resize') for(const key of ['cols','rows']) if(!Number.isInteger(params[key])||Number(params[key])<1||Number(params[key])>1000) throw new Error(`Invalid ${key}`);
 if(m==='session.create'||m==='history.import'||m==='session.config.save') {
  // Shape only: the runtime's agent registry (built-ins + enabled plugins) decides whether the agent exists.
  if(typeof params.provider!=='string'||!/^[a-z][a-z0-9-]{1,31}$/.test(params.provider)) throw new Error('Invalid provider');
  if(!['terminal','chat'].includes(String(params.mode))) throw new Error('Invalid mode');
  if(params.args!==undefined&&(!Array.isArray(params.args)||params.args.some(x=>typeof x!=='string'))) throw new Error('Invalid args');
 }
 if(m==='settings.update'&&(!isRecord(params.patch)||!Number.isSafeInteger(params.expectedRevision))) throw new Error('Invalid settings revision or patch');
 if(m==='chat.approve'&&(typeof params.choiceId!=='string'||!params.choiceId)) throw new Error('Invalid approval choice');
 if(m==='chat.answer') {
  const response=params.response;
  if(!isRecord(response)) throw new Error('Invalid chat answer');
  if(['approve','request_changes','abandon'].includes(String(response.action))) {
   if(response.feedback!==undefined&&(typeof response.feedback!=='string'||response.feedback.trim().length===0||response.feedback.length>16_000)) throw new Error('Invalid plan feedback');
  }
 }
 if(m==='filesystem.list' && typeof params.path!=='string') throw new Error('Invalid path');
 if(m==='filesystem.resolve') {
  if(String(params.path).length>16*1024||String(params.path).includes('\0')) throw new Error('Invalid file reference');
  for(const key of ['line','column']) if(params[key]!==undefined&&(!Number.isSafeInteger(params[key])||Number(params[key])<1||Number(params[key])>1_000_000)) throw new Error(`Invalid ${key}`);
 }
 if(['filesystem.write','draft.put'].includes(m) && (typeof params.content!=='string'||params.content.length>1024*1024)) throw new Error('Invalid file content');
 if(['catalog.visibility.update','session.organize','project.update','draft.put','draft.delete','workspace.save','workspace.delete','settings.import.apply','session.config.save','session.retry.update','session.attention.acknowledge'].includes(m)&&(!Number.isSafeInteger(params.expectedRevision)||Number(params.expectedRevision)<0)) throw new Error('Invalid revision');
 if(m==='git.diff'&&typeof params.staged!=='boolean') throw new Error('Invalid diff mode');
 const pathOk=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=4096&&!value.includes('\0');
 if(['filesystem.create','filesystem.rename','filesystem.delete','git.index.write','git.blame','git.commit.diff','review.diff'].includes(m)&&!pathOk(params.path)) throw new Error('Invalid path');
 if(m==='filesystem.rename'&&!pathOk(params.newPath)) throw new Error('Invalid path');
 if(m==='git.log'&&params.path!==undefined&&!pathOk(params.path)) throw new Error('Invalid path');
 if(m==='git.log'&&params.all!==undefined&&typeof params.all!=='boolean') throw new Error('Invalid history scope');
 if(m==='git.log'&&params.skip!==undefined&&(!Number.isSafeInteger(params.skip)||Number(params.skip)<0||Number(params.skip)>1_000_000)) throw new Error('Invalid history offset');
 if(m==='filesystem.search') {
  if(String(params.query).length>1000) throw new Error('Invalid search query');
  for(const key of ['include','exclude']) if(params[key]!==undefined&&(typeof params[key]!=='string'||String(params[key]).length>2000)) throw new Error(`Invalid ${key}`);
 }
 if(m==='git.index.write') {
  if(typeof params.content!=='string'||params.content.length>1024*1024) throw new Error('Invalid file content');
  if(!('expectedIndexFingerprint' in params)||(params.expectedIndexFingerprint!==null&&(typeof params.expectedIndexFingerprint!=='string'||!params.expectedIndexFingerprint))) throw new Error('Invalid index fingerprint');
 }
 if(['git.stage','git.unstage','git.discard','review.revert'].includes(m)&&(!Array.isArray(params.paths)||params.paths.length===0||params.paths.length>500||params.paths.some(path=>!pathOk(path)))) throw new Error('Invalid paths');
 if(m==='review.revert') {
  const expected=params.expectedFingerprints,paths=params.paths as string[];
  if(!isRecord(expected)||Object.keys(expected).some(key=>!paths.includes(key))||paths.some(path=>!(path in expected))||Object.values(expected).some(value=>value!==null&&(typeof value!=='string'||!value))) throw new Error('Invalid fingerprints');
 }
 if(['git.checkout','git.branch.delete'].includes(m)&&(String(params.branch).length>255||String(params.branch).startsWith('-'))) throw new Error('Invalid branch');
 if(m==='git.checkout'&&params.startPoint!==undefined&&(typeof params.startPoint!=='string'||!params.startPoint||params.startPoint.length>255||params.startPoint.startsWith('-'))) throw new Error('Invalid start point');
 if(['git.commit.show','git.commit.diff'].includes(m)&&!/^[0-9a-f]{4,64}$/i.test(String(params.commit))) throw new Error('Invalid commit');
 if(m==='session.retry.update' && (typeof params.enabled!=='boolean'||(params.maxRetries!==undefined&&(!Number.isInteger(params.maxRetries)||Number(params.maxRetries)<1||Number(params.maxRetries)>10))||(params.delaySeconds!==undefined&&(!Number.isInteger(params.delaySeconds)||Number(params.delaySeconds)<1||Number(params.delaySeconds)>3600)))) throw new Error('Invalid retry policy');
 if(m==='worktree.create'&&typeof params.createBranch!=='boolean') throw new Error('Invalid branch mode');
 if(m==='inbox.read'&&(!Array.isArray(params.ids)||params.ids.length>500||params.ids.some(id=>typeof id!=='string'||!id))) throw new Error('Invalid inbox ids');
 if(m==='workspace.save') validateLayout(params.layout);
 if(m==='terminal.read') {
  if(params.cursor!==undefined&&(!Number.isSafeInteger(params.cursor)||Number(params.cursor)<0)) throw new Error('Invalid output cursor');
  if(params.tail===true&&params.cursor!==undefined) throw new Error('tail and cursor are mutually exclusive');
 }
 if(m==='chat.queue.move'&&(!Number.isInteger(params.toIndex)||Number(params.toIndex)<0||Number(params.toIndex)>19)) throw new Error('Invalid queue position');
 if(m==='chat.feedback.add'&&(typeof params.text!=='string'||!params.text.trim()||[...params.text].length>4000)) throw new Error('Invalid feedback text');
 if(m==='chat.feedback.dismiss'&&(!Array.isArray(params.noteIds)||params.noteIds.length<1||params.noteIds.length>40||params.noteIds.some(id=>typeof id!=='string'||!id||id.length>128)||new Set(params.noteIds).size!==params.noteIds.length)) throw new Error('Invalid feedback note ids');
 if(m==='chat.fork'&&params.itemId!==undefined&&(typeof params.itemId!=='string'||!params.itemId||params.itemId.length>1024)) throw new Error('Invalid fork item');
 if(m==='chat.queue.update'&&(!Number.isSafeInteger(params.expectedRevision)||Number(params.expectedRevision)<1)) throw new Error('Invalid queue item revision');
 if((m==='chat.queue.add'||m==='chat.queue.update')&&String(params.text).length>1024*1024) throw new Error('Invalid text');
 if(m==='quickLaunch.save') {
  const name=String(params.name).trim(),command=String(params.command);
  if(!name||[...name].length>80||/[\u0000-\u001f\u007f]/.test(name)) throw new Error('Invalid command name');
  if(!command.trim()||command.length>8000||command.includes('\u0000')) throw new Error('Invalid command text');
  if(!['cmd','powershell','pwsh'].includes(String(params.shell))) throw new Error('Invalid shell');
  if(!['service','task'].includes(String(params.kind))) throw new Error('Invalid command kind');
  // Relative to the worktree root; the runtime resolves it again at every run and keeps it inside the root.
  if(typeof params.cwd!=='string'||params.cwd.length>260||/^([a-z]:|[\\/])/i.test(params.cwd)||/(^|[\\/])\.\.([\\/]|$)/.test(params.cwd)||/[\u0000-\u001f<>"|?*]/.test(params.cwd)) throw new Error('Invalid working directory');
  if(!Array.isArray(params.env)||params.env.length>32||params.env.some(item=>!isRecord(item)||typeof item.name!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item.name)||typeof item.value!=='string'||item.value.length>8192||item.value.includes('\u0000'))||new Set(params.env.map(item=>String((item as {name:unknown}).name).toUpperCase())).size!==params.env.length) throw new Error('Invalid environment overrides');
  if(params.previewUrl!==undefined&&!isWebPreviewUrl(params.previewUrl)) throw new Error('Invalid preview address');
  if((params.id===undefined)!==(params.expectedRevision===undefined)||(params.expectedRevision!==undefined&&(!Number.isSafeInteger(params.expectedRevision)||Number(params.expectedRevision)<1))) throw new Error('Invalid command revision');
 }
 if(m==='quickLaunch.delete'&&(!Number.isSafeInteger(params.expectedRevision)||Number(params.expectedRevision)<1)) throw new Error('Invalid command revision');
 if(m==='quickLaunch.setup.save') {
  const ids=params.commandIds;
  if(!Array.isArray(ids)||ids.length>20||ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length) throw new Error('Invalid setup commands');
  if(!Number.isSafeInteger(params.expectedRevision)||Number(params.expectedRevision)<0) throw new Error('Invalid setup revision');
 }
 if(m==='quickLaunch.setup.run'&&params.fromStep!==undefined&&(!Number.isInteger(params.fromStep)||Number(params.fromStep)<0||Number(params.fromStep)>19)) throw new Error('Invalid setup step');
 if(m==='agentReview.start') {
  if(!/^[a-z][a-z0-9-]{1,31}$/.test(String(params.agent))) throw new Error('Invalid agent');
  const scope=params.scope, id=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=200;
  if(!isRecord(scope)||(scope.kind==='checkpoints'?!id(scope.from)||(scope.to!==undefined&&!id(scope.to)):scope.kind!=='uncommitted')) throw new Error('Invalid review scope');
 }
 if(m==='agentReview.mark'&&(!Array.isArray(params.findingIds)||params.findingIds.length<1||params.findingIds.length>100||params.findingIds.some(id=>typeof id!=='string'||!id))) throw new Error('Invalid findings');
 if(m==='group.prerequisites') {
  if(params.cwd!==undefined&&(typeof params.cwd!=='string'||!params.cwd.trim()||params.cwd.length>32*1024)) throw new Error('Invalid group folder');
  if(params.providers!==undefined&&(!Array.isArray(params.providers)||params.providers.length>64||params.providers.some(provider=>typeof provider!=='string'||!/^[a-z][a-z0-9-]{1,31}$/.test(provider)))) throw new Error('Invalid group providers');
 }
 const groupHandle=(value:unknown)=>typeof value==='string'&&/^[a-z0-9-]{1,24}$/.test(value);
 const groupMember=(value:unknown)=>isRecord(value)&&typeof value.provider==='string'&&/^[a-z][a-z0-9-]{1,31}$/.test(value.provider)&&(value.handle===undefined||groupHandle(value.handle))&&(value.model===undefined||(typeof value.model==='string'&&value.model.trim().length>0&&[...value.model].length<=200))&&(value.mode===undefined||value.mode==='default'||value.mode==='read_only');
 if(m==='group.create') {
  if(typeof params.cwd!=='string'||!params.cwd.trim()||params.cwd.length>32*1024) throw new Error('Invalid group folder');
  if(params.title!==undefined&&(typeof params.title!=='string'||!params.title.trim()||[...params.title].length>160)) throw new Error('Invalid group title');
  if(!Array.isArray(params.members)||params.members.length<1||params.members.length>6||params.members.some(member=>!groupMember(member))) throw new Error('Invalid group members');
  if(params.fromSessionId!==undefined&&(typeof params.fromSessionId!=='string'||!params.fromSessionId||params.fromSessionId.length>200)) throw new Error('Invalid group source session');
 }
 if(m==='group.read'&&params.before!==undefined&&(typeof params.before!=='string'||!params.before||params.before.length>256)) throw new Error('Invalid group page cursor');
 if(m==='group.send') {
  if(typeof params.text!=='string'||!params.text.trim()||new TextEncoder().encode(params.text).length>64*1024) throw new Error('Invalid group message');
  if(!Array.isArray(params.to)||params.to.length<1||params.to.length>6||params.to.some(handle=>handle!=='all'&&!groupHandle(handle))||new Set(params.to).size!==params.to.length||(params.to.includes('all')&&params.to.length!==1)) throw new Error('Invalid group recipients');
  if(params.references!==undefined&&(!Array.isArray(params.references)||params.references.length>8||params.references.some(reference=>!isRecord(reference)||!['reply','message','file','url'].includes(String(reference.kind))||(reference.messageId!==undefined&&(typeof reference.messageId!=='string'||!reference.messageId))||(reference.path!==undefined&&(typeof reference.path!=='string'||!reference.path))||(reference.url!==undefined&&!isWebPreviewUrl(reference.url))))) throw new Error('Invalid group references');
 }
 if(m==='group.stop'&&params.handle!==undefined&&!groupHandle(params.handle)) throw new Error('Invalid group handle');
 if(m==='group.resend'&&!groupHandle(params.handle)) throw new Error('Invalid group handle');
 if(m==='group.member.add'&&!groupMember({provider:params.provider,handle:params.handle,model:params.model,mode:params.mode})) throw new Error('Invalid group member');
 if(m==='group.member.update'&&params.handle===undefined&&params.mode===undefined) throw new Error('Empty group member update');
 if(m==='group.member.update'&&((params.handle!==undefined&&!groupHandle(params.handle))||(params.mode!==undefined&&params.mode!=='default'&&params.mode!=='read_only'))) throw new Error('Invalid group member update');
 if(m==='group.archive'&&params.archived!==undefined&&typeof params.archived!=='boolean') throw new Error('Invalid group archive state');
 if(m==='group.create'&&params.expectedRevision!==undefined&&params.expectedRevision!==0) throw new Error('Invalid group revision');
 if(m.startsWith('group.')&&m!=='group.create'&&m!=='group.list'&&m!=='group.read'&&m!=='group.prerequisites'&&params.expectedRevision!==undefined&&(!Number.isSafeInteger(params.expectedRevision)||Number(params.expectedRevision)<1)) throw new Error('Invalid group revision');
 // Relative to the session's worktree root: no drive, no leading separator, no `..` segment.
 if((m==='session.documents.pin'||m==='session.documents.unpin')&&(!pathOk(params.path)||/^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$)/.test(String(params.path)))) throw new Error('Invalid path');
 const maxLimit=m==='terminal.read'?(params.tail===true?8192:1024*1024):200;
 if(params.limit!==undefined&&(!Number.isInteger(params.limit)||Number(params.limit)<1||Number(params.limit)>maxLimit)) throw new Error('Invalid page limit');
}
export function validateResult<M extends Method>(method:M,result:unknown):asserts result is RequestResult<M> {
 if(method==='browser.approval.read') {
  const value=result as BrowserEvalApprovalRead;
  if(!isRecord(result)||!isBrowserEvalArguments({tabId:value.tabId,code:value.code})
   ||value.codeByteLength!==new TextEncoder().encode(value.code).byteLength
   ||typeof value.codeHash!=='string'||!/^[a-f0-9]{64}$/.test(value.codeHash)
   ||!Number.isSafeInteger(value.expiresAtUnixMs)||value.expiresAtUnixMs<1)throw new Error('Invalid browser approval result');
  for(const field of ['approvalId','operationId','settingsGeneration'] as const) {
   if(typeof value[field]!=='string'||!value[field]||new TextEncoder().encode(value[field]).byteLength>256||/[\u0000-\u001f\u007f-\u009f]/.test(value[field]))throw new Error('Invalid browser approval result');
  }
  try {const url=new URL(value.origin);if(!['http:','https:'].includes(url.protocol)||url.origin!==value.origin||new TextEncoder().encode(value.origin).byteLength>4096)throw new Error();}
  catch {throw new Error('Invalid browser approval origin');}
 }
 if(!validateWireSuccess({v:1,id:'boundary',method,result})) throw new Error(`Invalid runtime result for ${method}`);
 if(method==='chat.repair'&&isRecord(result)) {
  if(!result.sessionId) throw new Error('Invalid repair sessionId');
  for(const key of ['added','updated','removed','expired','total','revision']) if(!Number.isSafeInteger(result[key])||Number(result[key])<0) throw new Error(`Invalid repair ${key}`);
 }
}
/** A page a `web` tab may show: an absolute http(s) URL of at most 2048 characters, no whitespace or control characters. */
export function isWebPreviewUrl(value:unknown):value is string {
 if(typeof value!=='string'||!value||value.length>2048||/[\s\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
 try { const url=new URL(value); return (url.protocol==='http:'||url.protocol==='https:')&&Boolean(url.hostname); } catch { return false; }
}
export function validateLayout(value:unknown):asserts value is PaneLayout {
 let panes=0; const ids=new Set<string>();
 function visit(node:unknown,depth:number):void {
  if(depth>4||!isRecord(node)||typeof node.id!=='string'||!node.id||ids.has(node.id)) throw new Error('Invalid workspace layout');
  ids.add(node.id);
  if(node.kind==='split') {
   if(!['horizontal','vertical'].includes(String(node.direction))||typeof node.ratio!=='number'||node.ratio<0.1||node.ratio>0.9) throw new Error('Invalid workspace split');
   visit(node.first,depth+1); visit(node.second,depth+1);
  } else if(node.kind==='pane') {
   panes++; if(panes>4||!Array.isArray(node.tabs)||node.tabs.length>100) throw new Error('Invalid workspace panes');
   const tabs=new Set<string>();
   for(const tab of node.tabs) {
    if(!isRecord(tab)||typeof tab.id!=='string'||!tab.id||tabs.has(tab.id)) throw new Error('Invalid workspace tab');
    tabs.add(tab.id);
    if(tab.kind==='session') { if(typeof tab.sessionId!=='string'||!tab.sessionId) throw new Error('Invalid session tab'); }
    else if(['file','diff','preview'].includes(String(tab.kind))) {
     if(typeof tab.projectId!=='string'||!tab.projectId||typeof tab.path!=='string'||!tab.path) throw new Error('Invalid file tab');
     if(tab.ownerSessionId!==undefined&&(typeof tab.ownerSessionId!=='string'||!tab.ownerSessionId||tab.ownerSessionId.length>256||/[\u0000-\u001f\u007f]/.test(tab.ownerSessionId))) throw new Error('Invalid file tab owner');
    }
    else if(tab.kind==='history') {
     if(typeof tab.projectId!=='string'||!tab.projectId||(tab.path!==undefined&&(typeof tab.path!=='string'||!tab.path))) throw new Error('Invalid history tab');
    }
    else if(tab.kind==='review') {
     for(const key of ['projectId','path','sessionId','checkpointId']) if(typeof tab[key]!=='string'||!tab[key]) throw new Error('Invalid review tab');
     if(tab.toCheckpointId!==undefined&&(typeof tab.toCheckpointId!=='string'||!tab.toCheckpointId)) throw new Error('Invalid review tab');
    }
    // A web page is an independent tab (no session owner): owned views are reached only through a file header.
    else if(tab.kind==='web') { if(!isWebPreviewUrl(tab.url)||tab.ownerSessionId!==undefined) throw new Error('Invalid web tab'); if(tab.title!==undefined&&(typeof tab.title!=='string'||new TextEncoder().encode(tab.title).length>512||/[\u0000-\u001f\u007f-\u009f]/.test(tab.title))) throw new Error('Invalid web tab title'); }
    else if(tab.kind==='map') { if(typeof tab.sessionId!=='string'||!tab.sessionId||tab.sessionId.length>256||tab.ownerSessionId!==undefined) throw new Error('Invalid map tab'); }
    else if(tab.kind==='group'||tab.kind==='roundtable') { const id=tab.kind==='group'?tab.groupId:tab.roundtableId; if(typeof id!=='string'||!id||id.length>256||typeof tab.title!=='string'||new TextEncoder().encode(tab.title).length>512||/[\u0000-\u001f\u007f-\u009f]/.test(tab.title)||tab.ownerSessionId!==undefined) throw new Error(`Invalid ${tab.kind} tab`); }
    else throw new Error('Invalid tab kind');
   }
   if(node.activeTabId!==null&&!tabs.has(String(node.activeTabId))) throw new Error('Invalid active tab');
  } else throw new Error('Invalid layout kind');
 }
 visit(value,0);
}
export function isRuntimeEvent(value:unknown):value is RuntimeEvent { return isRecord(value)&&value.v===1&&typeof value.event==='string'&&typeof value.epoch==='string'&&Number.isSafeInteger(value.seq)&&'data' in value; }
declare global { interface Window { threadterm:ThreadTermBridge } }

// File paths below are relative to a runtime-registered project or worktree root.
export interface FileScope { projectId:string; worktreePath?:string }
export interface FileEntry { name:string; path:string; kind:'file'|'directory'|'symlink'; size?:number }
export interface FileDocument { path:string; content:string; fingerprint:string; readonly:boolean; size:number; modifiedAt:string }
export interface Draft { id:string; projectId:string; worktreePath?:string; path:string; content:string; baseFingerprint:string; revision:number; updatedAt:string }
export interface GitChange { path:string; originalPath?:string; indexStatus:string; worktreeStatus:string; untracked:boolean }
export type GitHeadSnapshot = {kind:'branch';oid:string;target:string}|{kind:'detached';oid:string}|{kind:'unborn';target:string};
export interface GitSelectedCommitSnapshot { head:GitHeadSnapshot; indexFingerprint:string; supported:boolean; unsupportedReason?:string; gitVersion?:string }
export interface GitSelectedCommitEntry { path:string; indexStatus:string; originalPath?:string }
export interface GitSelectedCommitResult { commit:string; tree:string; parent:string|null; refTarget:string|null; committedPaths:string[]; retainedStagedPaths:string[]; retainedStagedPathsTruncated?:boolean; postCommitError?:string; cleanupError?:string }
export interface GitStatus { branch:string|null; upstream:string|null; ahead:number; behind:number; changes:GitChange[]; selectedCommit?:GitSelectedCommitSnapshot }
/** staged=false: index → working tree (fingerprint is the working file); staged=true: HEAD → index. indexFingerprint is null when the path has no stage-0 index entry. */
export interface GitDiff { path:string; staged:boolean; oldText:string; newText:string; binary:boolean; fingerprint:string; indexFingerprint?:string|null; deleted?:boolean }
export interface FileListResult { paths:string[]; truncated:boolean }
export interface SearchQuery { query:string; regex?:boolean; caseSensitive?:boolean; wholeWord?:boolean; include?:string; exclude?:string }
/** line is 1-based; column/length/previewColumn are UTF-16 code units (column 1-based). */
export interface SearchMatch { line:number; column:number; length:number; preview:string; previewColumn:number }
export interface SearchResult { files:{path:string;matches:SearchMatch[]}[]; truncated:boolean; searchedFiles:number }
export interface GitCommitInfo { hash:string; parents:string[]; authorName:string; authorEmail:string; authoredAt:string; subject:string; refs:string[] }
/** Commits in date order (children before parents). all=true lists every local/remote branch and tag (ignored for
 * file history); scope echoes it and is missing from runtimes older than the commit graph. */
export interface GitLog { commits:GitCommitInfo[]; hasMore:boolean; scope?:'head'|'all' }
export interface GitCommitFile { path:string; originalPath?:string; status:string }
export interface GitCommitDetail { commit:GitCommitInfo; body:string; files:GitCommitFile[] }
export interface GitTextPair { path:string; oldText:string; newText:string; binary:boolean }
/** Uncommitted lines use commit ''. Ranges are 1-based and cover the working file. */
export interface GitBlame { path:string; ranges:{start:number;count:number;commit:string}[]; commits:Record<string,{authorName:string;authoredAt:string;summary:string}> }
export interface GitBranch { name:string; remote:boolean; current:boolean; upstream?:string; ahead?:number; behind?:number; gone?:boolean; lastCommit?:{hash:string;subject:string;committedAt:string} }
export interface GitBranches { current:string|null; detached:boolean; branches:GitBranch[] }
export interface ReviewCheckpoint { id:string; sessionId:string; kind:'turn'|'launch'|'manual'|'baseline'; turnId?:string; label?:string; createdAt:string; status:'ready'|'failed'; error?:string; skipped:string[] }
export interface ReviewState { available:boolean; reason?:string; projectId?:string; worktreePath?:string; checkpoints:ReviewCheckpoint[] }
export interface ReviewFile { path:string; status:'A'|'M'|'D'; added?:number; removed?:number; binary?:boolean }
/** exists/fingerprint describe the current working file when `to` is omitted. */
export interface ReviewDiff { path:string; oldText:string; newText:string; binary:boolean; exists:boolean; fingerprint?:string }
/** A plan, spec or research note pinned to a session ("Plans & docs" in Session details). `path` is relative to the
 * session's worktree root with `/` separators. `title` is the first Markdown heading of a .md/.markdown file. `missing`
 * when the file is gone; it stays listed until unpinned. */
export interface SessionDocument { path:string; title?:string; pinnedAt:string; missing?:boolean }
/** Independent agent review (Agent Changes): a fresh Chat of the chosen agent reviews a snapshot of a session's changes,
 * captured when the review starts. `checkpoints` is the `review.changes` range (`to` omitted: the current files);
 * `uncommitted` is the worktree against git HEAD, untracked files included. */
export type AgentReviewScope = {kind:'checkpoints';from:string;to?:string}|{kind:'uncommitted'};
export type AgentReviewSeverity = 'high'|'medium'|'low'|'info';
/** `path` is relative to the reviewed worktree root and `line` 1-based in the current file; both absent for a general finding. */
export interface AgentReviewFinding { id:string; severity:AgentReviewSeverity; path?:string; line?:number; title:string; body:string; state:'open'|'added'|'dismissed' }
/** `files`: changed files in the snapshot. `truncated`: files left out of the reviewer's prompt by the size budget.
 * `instructions`: `.threadterm/review.md` from the worktree root, or the built-in review prompt.
 * `findings` once the reviewer's turn completed and its last reply ended in a valid ```threadterm-review block;
 * `unparsed` when that reply had none (the user opens the reviewer's reply instead). */
export interface AgentReview { id:string; sessionId:string; reviewerSessionId:string; agent:ProviderId; scope:AgentReviewScope;
 state:'starting'|'running'|'completed'|'failed'; files:number; truncated:string[]; instructions:'repository'|'built-in';
 createdAt:string; updatedAt:string; error?:string; findings?:AgentReviewFinding[]; unparsed?:boolean }
export interface Worktree { id:string; projectId:string; path:string; branch:string|null; head:string; isMain:boolean; locked:boolean; missing:boolean; upstream?:string; lastCommit?:CommitSummary }
export type ContentRef = {id:string;kind:'map';sessionId:string;ownerSessionId?:undefined;projectId?:undefined;worktreePath?:undefined;path?:undefined;assetKind?:undefined}|{id:string;kind:'group';groupId:string;/** User-supplied room title, bounded before persistence. */title:string;ownerSessionId?:undefined;projectId?:undefined;worktreePath?:undefined;path?:undefined;assetKind?:undefined}|{id:string;/** Persisted v16 workspace-tab compatibility only; no Roundtable runtime API remains. */kind:'roundtable';roundtableId:string;/** User-supplied room title, bounded before persistence. */title:string;ownerSessionId?:undefined;projectId?:undefined;worktreePath?:undefined;path?:undefined;assetKind?:undefined}|{id:string;kind:'session';sessionId:string}|{id:string;kind:'file'|'diff'|'preview';projectId:string;worktreePath?:string;path:string;assetKind?:'text'|'image';ownerSessionId?:string;staged?:boolean}|{id:string;kind:'history';projectId:string;worktreePath?:string;path?:string;ownerSessionId?:undefined;assetKind?:undefined}|{id:string;kind:'review';projectId:string;worktreePath?:string;path:string;sessionId:string;checkpointId:string;toCheckpointId?:string;ownerSessionId?:undefined;assetKind?:undefined}|{id:string;kind:'web';url:string;/** Sanitized page title, at most 512 UTF-8 bytes. */title?:string;ownerSessionId?:undefined;projectId?:undefined;worktreePath?:undefined;path?:undefined};
export type PaneLayout = {kind:'pane';id:string;tabs:ContentRef[];activeTabId:string|null}|{kind:'split';id:string;direction:'horizontal'|'vertical';ratio:number;first:PaneLayout;second:PaneLayout};
export interface WorkspaceSave { id?:string;name:string;projectId?:string;worktreePath?:string;layout:PaneLayout;expectedRevision:number;operationId:string }


export function protocolContractOf(value:unknown):number|undefined {
 if(!isRecord(value)||typeof value.contract!=='number'||!Number.isInteger(value.contract)) return undefined;
 return value.contract;
}
export function protocolIncompatibleReason(peer:unknown,role:'desktop'|'runtime'='desktop'):string|undefined {
 if(!isRecord(peer)) {
  return role==='desktop'
   ? 'The runtime did not identify its protocol. The existing runtime was left running.'
   : 'The desktop client did not identify its protocol. Running jobs were not stopped.';
 }
 if(peer.protocol!==undefined&&peer.protocol!==PROTOCOL_VERSION) {
  return role==='desktop'
   ? `This desktop speaks wire protocol ${PROTOCOL_VERSION}, but the runtime spoke ${String(peer.protocol)}. The existing runtime was left running.`
   : `This runtime speaks wire protocol ${PROTOCOL_VERSION}, but the desktop spoke ${String(peer.protocol)}. Running jobs were not stopped.`;
 }
 const contract=protocolContractOf(peer);
 if(contract===PROTOCOL_CONTRACT) return undefined;
 if(contract===undefined) {
  return role==='desktop'
   ? `This desktop requires runtime contract ${PROTOCOL_CONTRACT} for choice-based Chat approvals, Chat fork, and feedback notes. The connected runtime is older and was left running. Update ThreadTerm, or quit the old runtime from the tray before retrying.`
   : `This runtime requires desktop contract ${PROTOCOL_CONTRACT} for choice-based Chat approvals, Chat fork, and feedback notes. This client is older. Update the ThreadTerm desktop. Running jobs were not stopped.`;
 }
 return role==='desktop'
  ? `This desktop requires contract ${PROTOCOL_CONTRACT}, but the runtime uses ${contract}. The existing runtime was left running.`
  : `This runtime requires contract ${PROTOCOL_CONTRACT}, but the desktop uses ${contract}. Running jobs were not stopped.`;
}

export type WireRequest = { [M in Method]: { v:1; id:string; method:M; params:RequestParams<M> } }[Method];
export type WireSuccess = { [M in Method]: { v:1; id:string; method:M; result:RequestResult<M> } }[Method];

export interface DataStatus { root:string;database:{path:string;sizeBytes:number};counts:{projects:number;sessions:number;workspaces:number;drafts:number;usageRecords:number} }
export interface ThemeTokens { background:string;surface:string;text:string;muted:string;accent:string;border:string }
export interface SettingsBundle { marker:'threadterm-v3-settings';version:1;exportedAt:string;settings:{theme?:'light'|'dark'|'system';language?:'zh-CN'|'en';shortcuts?:Record<string,string>;notifications?:Record<string,boolean>;customThemes?:Record<string,ThemeTokens>;themeSelection?:string;terminalCompatibility?:{aiCompletionHints:boolean};quickMessages?:QuickMessage[];'chatTools.ask'?:boolean;'chatTools.sessionInfo'?:boolean;'chatTools.feedback'?:boolean;'chatTools.delegation'?:boolean} }
export interface UsageRecord { source?:UsageSource;status?:SessionStatus;sessionId:string;provider:ProviderId;recordedAt:string;inputTokens?:number;outputTokens?:number;estimatedCost?:number;currency?:string;model?:string }
export type UsageSource = 'created'|'native-history'|'rerun';
export interface SessionLifecycleMetric { sessionId:string;projectId?:string;provider:ProviderId;mode:SessionMode;status:SessionStatus;source?:UsageSource;sourceSessionId?:string;startedAt:string;endedAt?:string;sessionLifetimeSeconds?:number;durationKind:'session_lifetime';history:{status:SessionStatus;recordedAt:string}[] }
export interface UsageResult { records:UsageRecord[];sessions?:SessionLifecycleMetric[];summary?:{sessionCount:number;runningCount:number;endedCount:number;sessionLifetimeSeconds:number};pricing:'unknown'|'estimated' }
