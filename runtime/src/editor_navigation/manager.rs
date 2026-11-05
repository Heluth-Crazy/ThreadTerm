use super::{
    adapters::{self, Family, ToolConfiguration},
    lsp::{self, Document},
    transport::Transport,
};
use anyhow::{anyhow, Context as _, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, RwLock, TryLockError, Weak,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_CONTEXTS: usize = 2;
const SEMANTIC_IDLE: Duration = Duration::from_secs(5 * 60);
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);
const SYNC_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_ID_BYTES: usize = 256;
const MAX_VERSION_FENCES: usize = 256;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration {
    enabled: bool,
    #[serde(default)]
    tools: ToolConfiguration,
}
impl Default for Configuration {
    fn default() -> Self {
        Self {
            enabled: true,
            tools: ToolConfiguration::default(),
        }
    }
}

pub(super) struct Manager {
    data_dir: PathBuf,
    config_path: PathBuf,
    configuration: RwLock<Configuration>,
    configure_lock: Mutex<()>,
    detection: Mutex<DetectionState>,
    contexts: Mutex<HashMap<String, Arc<NavigationContext>>>,
    startup: Mutex<StartupState>,
    shutting_down: AtomicBool,
}

struct StartupState {
    running: bool,
    queue: VecDeque<Weak<NavigationContext>>,
}

struct DetectionState {
    generation: u64,
    completed_generation: Option<u64>,
    refreshing: bool,
    tools: ToolConfiguration,
    values: Vec<adapters::Detection>,
}

struct NavigationContext {
    id: String,
    principal: String,
    root: PathBuf,
    family: Family,
    buffer_group: String,
    state: Mutex<ContextState>,
    operation: Mutex<()>,
    requests: Mutex<HashMap<String, ActiveRequest>>,
    next_request_token: AtomicU64,
    generation: AtomicU64,
    last_semantic: Mutex<Instant>,
}
struct ContextState {
    phase: Phase,
    message: Option<String>,
    transport: Option<Arc<Transport>>,
    incremental_sync: bool,
    definition_supported: bool,
    symbols_supported: bool,
    documents: HashMap<PathBuf, Document>,
    version_fences: HashMap<PathBuf, VersionFence>,
}
#[derive(Clone)]
struct VersionFence {
    version: i64,
    digest: [u8; 32],
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Preparing,
    Ready,
    Failed,
}
struct ActiveRequest {
    token: u64,
    cancelled: Arc<AtomicBool>,
    lsp_id: Arc<AtomicU64>,
}

impl Manager {
    pub(super) fn new(data_dir: &Path) -> Arc<Self> {
        let config_path = data_dir.join("editor-navigation.json");
        let configuration = match load_configuration(&config_path) {
            Ok(configuration) => configuration,
            Err(_) => Configuration {
                enabled: false,
                tools: ToolConfiguration::default(),
            },
        };
        let initial_detection = adapters::detect_quick(&configuration.tools);
        let detection_tools = configuration.tools.clone();
        let manager = Arc::new(Self {
            data_dir: data_dir.to_path_buf(),
            config_path,
            configuration: RwLock::new(configuration),
            configure_lock: Mutex::new(()),
            detection: Mutex::new(DetectionState {
                generation: 1,
                completed_generation: None,
                refreshing: false,
                tools: detection_tools,
                values: initial_detection,
            }),
            contexts: Mutex::new(HashMap::new()),
            startup: Mutex::new(StartupState {
                running: false,
                queue: VecDeque::new(),
            }),
            shutting_down: AtomicBool::new(false),
        });
        start_idle_reaper(Arc::downgrade(&manager));
        manager
    }

    pub(super) fn dispatch(
        self: &Arc<Self>,
        db: &crate::db::Database,
        principal: &str,
        method: &str,
        params: &Value,
    ) -> Result<Option<Value>> {
        if !method.starts_with("editorNavigation.") {
            return Ok(None);
        }
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err(anyhow!("runtime_stopping"));
        }
        validate_id("principal", principal)?;
        let result = match method {
            "editorNavigation.configuration" => self.configuration(params),
            "editorNavigation.configure" => self.configure(params),
            "editorNavigation.prepare" => self.prepare(db, principal, params),
            "editorNavigation.status" => self.status(principal, params),
            "editorNavigation.sync" => self.sync(principal, params),
            "editorNavigation.definition" => self.definition(principal, params),
            "editorNavigation.documentSymbols" => self.document_symbols(principal, params),
            "editorNavigation.cancel" => self.cancel(principal, params),
            "editorNavigation.release" => self.release(principal, params),
            _ => Err(anyhow!(
                "navigation_unknown_method: unsupported editor navigation method"
            )),
        }?;
        Ok(Some(result))
    }

    pub(super) fn disconnect(&self, principal: &str) {
        for context in self.remove_where(|context| context.principal == principal) {
            self.retire(context);
        }
    }
    pub(super) fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        for context in self.remove_where(|_| true) {
            self.retire(context);
        }
    }

    fn configuration(self: &Arc<Self>, params: &Value) -> Result<Value> {
        exact_object(params, &[], &[])?;
        self.refresh_detection();
        self.configuration_value()
    }

    fn configuration_value(&self) -> Result<Value> {
        let configuration = self
            .configuration
            .read()
            .map_err(|_| anyhow!("navigation_internal"))?
            .clone();
        let detected = self
            .detection
            .lock()
            .map_err(|_| anyhow!("navigation_internal"))?
            .values
            .clone()
            .into_iter()
            .map(|entry| {
                let mut value = json!({"id":entry.id,"available":entry.available});
                if let Some(path) = entry.path {
                    value["path"] = json!(path);
                }
                if let Some(message) = entry.message {
                    value["message"] = json!(message);
                }
                value
            })
            .collect::<Vec<_>>();
        Ok(json!({"enabled":configuration.enabled,"tools":configuration.tools,"detected":detected}))
    }

    fn configure(self: &Arc<Self>, params: &Value) -> Result<Value> {
        let _configure = self
            .configure_lock
            .try_lock()
            .map_err(|error| match error {
                TryLockError::WouldBlock => {
                    anyhow!("navigation_busy: configuration update already in progress")
                }
                TryLockError::Poisoned(_) => anyhow!("navigation_internal"),
            })?;
        let object = exact_object(params, &["enabled", "tools"], &["enabled", "tools"])?;
        let enabled = object
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| anyhow!("navigation_invalid_params: enabled must be boolean"))?;
        let tools_value = object.get("tools").unwrap();
        exact_object(
            tools_value,
            &["typescript", "rust", "python", "java", "jdtls"],
            &[],
        )?;
        let tools: ToolConfiguration =
            serde_json::from_value(tools_value.clone()).map_err(|_| {
                anyhow!("navigation_invalid_params: tools must contain string paths only")
            })?;
        validate_tools(&tools)?;
        let next = Configuration { enabled, tools };
        persist_configuration(&self.config_path, &next)?;
        let previous = {
            let mut current = self
                .configuration
                .write()
                .map_err(|_| anyhow!("navigation_internal"))?;
            std::mem::replace(&mut *current, next.clone())
        };
        {
            let mut detection = self
                .detection
                .lock()
                .map_err(|_| anyhow!("navigation_internal"))?;
            let generation = detection.generation.wrapping_add(1).max(1);
            detection.generation = generation;
            detection.completed_generation = None;
            detection.tools = next.tools.clone();
            detection.values = adapters::detect_quick(&next.tools);
        }
        let affected = changed_families(&previous, &next);
        let retired = self.remove_where(|context| affected.contains(context.family.key()));
        self.retire_async(retired);
        self.refresh_detection();
        self.configuration_value()
    }

    fn refresh_detection(self: &Arc<Self>) {
        let generation = {
            let Ok(mut detection) = self.detection.lock() else {
                return;
            };
            if detection.refreshing || detection.completed_generation == Some(detection.generation)
            {
                return;
            }
            detection.refreshing = true;
            detection.generation
        };
        let manager = Arc::downgrade(self);
        let spawn = thread::Builder::new()
            .name("navigation-tool-detection".into())
            .spawn(move || loop {
                let Some(manager) = manager.upgrade() else {
                    return;
                };
                let (expected, tools) = match manager.detection.lock() {
                    Ok(detection) => (detection.generation, detection.tools.clone()),
                    Err(_) => return,
                };
                let values = adapters::detect(&tools);
                let Ok(mut detection) = manager.detection.lock() else {
                    return;
                };
                if detection.generation == expected {
                    detection.values = values;
                    detection.completed_generation = Some(expected);
                }
                if detection.completed_generation == Some(detection.generation) {
                    detection.refreshing = false;
                    return;
                }
            });
        if spawn.is_err() {
            if let Ok(mut detection) = self.detection.lock() {
                if detection.generation == generation {
                    detection.refreshing = false;
                }
            }
        }
    }

    fn prepare(
        self: &Arc<Self>,
        db: &crate::db::Database,
        principal: &str,
        params: &Value,
    ) -> Result<Value> {
        let object = exact_object(
            params,
            &["projectId", "worktreePath", "bufferGroup", "language"],
            &["projectId", "bufferGroup", "language"],
        )?;
        let project_id = bounded_string(object, "projectId", MAX_ID_BYTES)?;
        let worktree = optional_bounded_string(object, "worktreePath", 4_096)?;
        let buffer_group = bounded_string(object, "bufferGroup", MAX_ID_BYTES)?;
        let family = Family::from_language(bounded_string(object, "language", 32)?)
            .ok_or_else(|| anyhow!("navigation_unsupported_language"))?;
        if !self
            .configuration
            .read()
            .map_err(|_| anyhow!("navigation_internal"))?
            .enabled
        {
            return Err(anyhow!(
                "navigation_disabled: semantic navigation is disabled in host settings"
            ));
        }
        let root =
            db.transaction(|tx| crate::workspace_services::root_for(tx, project_id, worktree))?;
        let root = root
            .canonicalize()
            .map_err(|_| anyhow!("navigation_invalid_root"))?;
        let mut evicted = None;
        let context = {
            let mut contexts = self
                .contexts
                .lock()
                .map_err(|_| anyhow!("navigation_internal"))?;
            if let Some(existing) = contexts
                .values()
                .find(|context| {
                    context.principal == principal
                        && context.root == root
                        && context.family == family
                        && context.buffer_group == buffer_group
                })
                .cloned()
            {
                return Ok(existing.status());
            }
            if contexts.len() >= MAX_CONTEXTS {
                let candidate = contexts
                    .values()
                    .filter(|context| context.evictable())
                    .min_by_key(|context| {
                        context
                            .last_semantic
                            .lock()
                            .map(|value| *value)
                            .unwrap_or_else(|_| Instant::now())
                    })
                    .map(|context| context.id.clone());
                let Some(candidate) = candidate else {
                    return Err(anyhow!(
                        "navigation_busy: two navigation contexts are already busy"
                    ));
                };
                evicted = contexts.remove(&candidate);
            }
            let context = Arc::new(NavigationContext::new(
                principal,
                root,
                family,
                buffer_group,
            ));
            contexts.insert(context.id.clone(), Arc::clone(&context));
            context
        };
        if let Some(evicted) = evicted {
            self.retire(evicted);
        }
        self.start(Arc::clone(&context));
        Ok(context.status())
    }

    fn status(&self, principal: &str, params: &Value) -> Result<Value> {
        let object = exact_object(params, &["contextId"], &["contextId"])?;
        Ok(self
            .context(
                principal,
                bounded_string(object, "contextId", MAX_ID_BYTES)?,
            )?
            .status())
    }

    fn sync(&self, principal: &str, params: &Value) -> Result<Value> {
        let object = exact_object(
            params,
            &["contextId", "documents"],
            &["contextId", "documents"],
        )?;
        let context = self.context(
            principal,
            bounded_string(object, "contextId", MAX_ID_BYTES)?,
        )?;
        let values = object
            .get("documents")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("navigation_invalid_params: documents must be an array"))?;
        if values.len() > lsp::MAX_DOCUMENTS {
            return Err(anyhow!("navigation_too_many_documents"));
        }
        let mut documents = Vec::with_capacity(values.len());
        let mut total = 0usize;
        let mut paths = HashSet::new();
        for value in values {
            let item = exact_object(
                value,
                &["path", "content", "version"],
                &["path", "content", "version"],
            )?;
            let path = bounded_string(item, "path", 4_096)?;
            let content = item
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("navigation_invalid_params: content must be a string"))?;
            let version = integer(item, "version")?;
            total = total
                .checked_add(content.len())
                .ok_or_else(|| anyhow!("navigation_context_too_large"))?;
            if total > lsp::MAX_CONTEXT_BYTES {
                return Err(anyhow!("navigation_context_too_large"));
            }
            let document = lsp::document(&context.root, path, content.to_owned(), version)?;
            if !paths.insert(document.canonical.clone()) {
                return Err(anyhow!("navigation_duplicate_document"));
            }
            documents.push(document);
        }
        context.sync(documents)?;
        Ok(json!({"accepted":true}))
    }

    fn definition(&self, principal: &str, params: &Value) -> Result<Value> {
        let object = exact_object(
            params,
            &[
                "contextId",
                "path",
                "version",
                "line",
                "column",
                "requestId",
            ],
            &[
                "contextId",
                "path",
                "version",
                "line",
                "column",
                "requestId",
            ],
        )?;
        let context = self.context(
            principal,
            bounded_string(object, "contextId", MAX_ID_BYTES)?,
        )?;
        context.definition(
            bounded_string(object, "path", 4_096)?,
            integer(object, "version")?,
            integer(object, "line")?,
            integer(object, "column")?,
            bounded_string(object, "requestId", MAX_ID_BYTES)?,
        )
    }

    fn document_symbols(&self, principal: &str, params: &Value) -> Result<Value> {
        let object = exact_object(
            params,
            &["contextId", "path", "version", "requestId"],
            &["contextId", "path", "version", "requestId"],
        )?;
        let context = self.context(
            principal,
            bounded_string(object, "contextId", MAX_ID_BYTES)?,
        )?;
        context.document_symbols(
            bounded_string(object, "path", 4_096)?,
            integer(object, "version")?,
            bounded_string(object, "requestId", MAX_ID_BYTES)?,
        )
    }

    fn cancel(&self, principal: &str, params: &Value) -> Result<Value> {
        let object = exact_object(
            params,
            &["contextId", "requestId"],
            &["contextId", "requestId"],
        )?;
        let context = self.context(
            principal,
            bounded_string(object, "contextId", MAX_ID_BYTES)?,
        )?;
        context.cancel(bounded_string(object, "requestId", MAX_ID_BYTES)?);
        Ok(json!({"accepted":true}))
    }

    fn release(&self, principal: &str, params: &Value) -> Result<Value> {
        let object = exact_object(params, &["contextId"], &["contextId"])?;
        let id = bounded_string(object, "contextId", MAX_ID_BYTES)?;
        let context = {
            let mut contexts = self
                .contexts
                .lock()
                .map_err(|_| anyhow!("navigation_internal"))?;
            let existing = contexts
                .get(id)
                .ok_or_else(|| anyhow!("navigation_stale_context"))?;
            if existing.principal != principal {
                return Err(anyhow!("navigation_foreign_context"));
            }
            contexts.remove(id).unwrap()
        };
        self.retire(context);
        Ok(json!({"accepted":true}))
    }

    fn context(&self, principal: &str, id: &str) -> Result<Arc<NavigationContext>> {
        let contexts = self
            .contexts
            .lock()
            .map_err(|_| anyhow!("navigation_internal"))?;
        let context = contexts
            .get(id)
            .ok_or_else(|| anyhow!("navigation_stale_context"))?;
        if context.principal != principal {
            return Err(anyhow!("navigation_foreign_context"));
        }
        Ok(Arc::clone(context))
    }

    fn remove_where(
        &self,
        predicate: impl Fn(&NavigationContext) -> bool,
    ) -> Vec<Arc<NavigationContext>> {
        let Ok(mut contexts) = self.contexts.lock() else {
            return Vec::new();
        };
        let ids = contexts
            .values()
            .filter(|context| predicate(context))
            .map(|context| context.id.clone())
            .collect::<Vec<_>>();
        ids.into_iter()
            .filter_map(|id| contexts.remove(&id))
            .collect()
    }

    fn take_idle_at(&self, now: Instant) -> Vec<Arc<NavigationContext>> {
        self.remove_where(|context| {
            context.evictable()
                && context
                    .last_semantic
                    .lock()
                    .map(|last| now.saturating_duration_since(*last) >= SEMANTIC_IDLE)
                    .unwrap_or(false)
        })
    }

    fn contains(&self, context: &Arc<NavigationContext>) -> bool {
        self.contexts
            .lock()
            .ok()
            .and_then(|contexts| contexts.get(&context.id).cloned())
            .is_some_and(|current| Arc::ptr_eq(&current, context))
    }

    fn retire(&self, context: Arc<NavigationContext>) {
        context.stop();
        cleanup_context_data(&self.data_dir, &context.id);
    }

    fn retire_async(&self, contexts: Vec<Arc<NavigationContext>>) {
        if contexts.is_empty() {
            return;
        }
        let fallback = contexts.clone();
        let data_dir = self.data_dir.clone();
        if thread::Builder::new()
            .name("navigation-config-retire".into())
            .spawn(move || {
                for context in contexts {
                    context.stop();
                    cleanup_context_data(&data_dir, &context.id);
                }
            })
            .is_err()
        {
            for context in fallback {
                self.retire(context);
            }
        }
    }

    fn start(self: &Arc<Self>, context: Arc<NavigationContext>) {
        // Snapshot registry membership before taking the startup lock. This
        // avoids a contexts -> startup / startup -> contexts lock cycle while
        // still pruning tokens released during a slow Java initialization.
        let current = match self.contexts.lock() {
            Ok(contexts) => contexts.keys().cloned().collect::<HashSet<_>>(),
            Err(_) => {
                context.fail("navigation_internal: context registry is poisoned".into());
                return;
            }
        };
        let should_spawn = {
            let Ok(mut startup) = self.startup.lock() else {
                context.fail("navigation_internal: startup admission lock is poisoned".into());
                return;
            };
            startup.queue.retain(|queued| {
                queued
                    .upgrade()
                    .is_some_and(|queued| current.contains(&queued.id))
            });
            if startup.queue.len() >= MAX_CONTEXTS {
                context.fail("navigation_busy: language server startup queue is full".into());
                return;
            }
            startup.queue.push_back(Arc::downgrade(&context));
            if startup.running {
                false
            } else {
                startup.running = true;
                true
            }
        };
        if !should_spawn {
            return;
        }
        let manager = Arc::downgrade(self);
        if let Err(error) = thread::Builder::new()
            .name("navigation-lsp-start".into())
            .spawn(move || startup_worker(manager))
        {
            let queued = self
                .startup
                .lock()
                .map(|mut startup| {
                    startup.running = false;
                    startup.queue.drain(..).collect::<Vec<_>>()
                })
                .unwrap_or_default();
            for context in queued.into_iter().filter_map(|context| context.upgrade()) {
                context.fail(format!(
                    "navigation_internal: spawning startup worker: {error}"
                ));
            }
        }
    }
}

fn startup_worker(manager: Weak<Manager>) {
    loop {
        let Some(manager) = manager.upgrade() else {
            return;
        };
        let context = {
            let Ok(mut startup) = manager.startup.lock() else {
                return;
            };
            match startup.queue.pop_front() {
                Some(context) => context,
                None => {
                    startup.running = false;
                    return;
                }
            }
        };
        let Some(context) = context.upgrade() else {
            continue;
        };
        if manager.shutting_down.load(Ordering::SeqCst) || !manager.contains(&context) {
            continue;
        }
        if let Err(error) = initialize_context(&manager, &context) {
            context.fail(error.to_string());
            if !manager.contains(&context) {
                cleanup_context_data(&manager.data_dir, &context.id);
            }
        }
    }
}

impl NavigationContext {
    fn new(principal: &str, root: PathBuf, family: Family, buffer_group: &str) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            principal: principal.to_owned(),
            root,
            family,
            buffer_group: buffer_group.to_owned(),
            state: Mutex::new(ContextState {
                phase: Phase::Preparing,
                message: None,
                transport: None,
                incremental_sync: false,
                definition_supported: false,
                symbols_supported: false,
                documents: HashMap::new(),
                version_fences: HashMap::new(),
            }),
            operation: Mutex::new(()),
            requests: Mutex::new(HashMap::new()),
            next_request_token: AtomicU64::new(1),
            generation: AtomicU64::new(1),
            last_semantic: Mutex::new(Instant::now()),
        }
    }

    fn status(&self) -> Value {
        let (phase, message) = match self.state.lock() {
            Ok(state) => (
                match state.phase {
                    Phase::Preparing => "preparing",
                    Phase::Ready => "ready",
                    Phase::Failed => "failed",
                },
                state.message.clone(),
            ),
            Err(_) => (
                "failed",
                Some("navigation_internal: context state is poisoned".into()),
            ),
        };
        let mut value = json!({"contextId":self.id,"state":phase});
        if let Some(message) = message {
            value["message"] = json!(message);
        }
        value
    }
    fn evictable(&self) -> bool {
        let not_preparing = self
            .state
            .lock()
            .map(|state| state.phase != Phase::Preparing)
            .unwrap_or(false);
        not_preparing
            && self
                .requests
                .lock()
                .map(|requests| requests.is_empty())
                .unwrap_or(false)
    }

    fn admit_operation(&self) -> Result<std::sync::MutexGuard<'_, ()>> {
        self.operation.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => {
                anyhow!("navigation_busy: context already has an active operation")
            }
            TryLockError::Poisoned(_) => anyhow!("navigation_internal"),
        })
    }

    fn sync(&self, documents: Vec<Document>) -> Result<()> {
        let _operation = self.admit_operation()?;
        let (transport, incremental, old, fences) = {
            let state = self
                .state
                .lock()
                .map_err(|_| anyhow!("navigation_internal"))?;
            (
                if state.phase == Phase::Ready {
                    state.transport.clone()
                } else {
                    None
                },
                state.incremental_sync,
                state.documents.clone(),
                state.version_fences.clone(),
            )
        };
        let next = documents
            .into_iter()
            .map(|document| (document.canonical.clone(), document))
            .collect::<HashMap<_, _>>();
        let new_paths = next
            .keys()
            .filter(|path| !fences.contains_key(*path))
            .count();
        if fences.len().saturating_add(new_paths) > MAX_VERSION_FENCES {
            return Err(anyhow!(
                "navigation_too_many_documents: context version history is full"
            ));
        }
        for (path, document) in &next {
            if let Some(previous) = fences.get(path) {
                let digest = content_digest(&document.content);
                if document.version < previous.version {
                    return Err(anyhow!("navigation_stale_version"));
                }
                if document.version == previous.version && digest != previous.digest {
                    return Err(anyhow!("navigation_version_conflict"));
                }
            }
        }
        if let Some(transport) = transport {
            let deadline = Instant::now() + SYNC_TIMEOUT;
            let notifications = (|| -> Result<()> {
                for (path, previous) in &old {
                    if Instant::now() >= deadline {
                        return Err(anyhow!(
                            "navigation_timeout: synchronizing documents timed out"
                        ));
                    }
                    if !next.contains_key(path) {
                        transport.notify("textDocument/didClose", previous.close_params())?;
                    }
                }
                for (path, document) in &next {
                    if Instant::now() >= deadline {
                        return Err(anyhow!(
                            "navigation_timeout: synchronizing documents timed out"
                        ));
                    }
                    match old.get(path) {
                        None => transport.notify("textDocument/didOpen", document.open_params())?,
                        Some(previous) if previous.version != document.version => {
                            transport.notify(
                                "textDocument/didChange",
                                document.change_params(previous, incremental),
                            )?;
                        }
                        Some(_) => {}
                    }
                }
                Ok(())
            })();
            if let Err(error) = notifications {
                self.fail(error.to_string());
                return Err(error);
            }
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("navigation_internal"))?;
        for (path, document) in &next {
            state.version_fences.insert(
                path.clone(),
                VersionFence {
                    version: document.version,
                    digest: content_digest(&document.content),
                },
            );
        }
        state.documents = next;
        Ok(())
    }

    fn definition(
        &self,
        path: &str,
        version: i64,
        line: i64,
        column: i64,
        request_id: &str,
    ) -> Result<Value> {
        if !(1..=1_000_000).contains(&line) || !(1..=1_000_000).contains(&column) {
            return Err(anyhow!("navigation_invalid_position"));
        }
        let _operation = self.admit_operation()?;
        let (transport, document, definition_supported, _) = self.ready_document(path, version)?;
        if !definition_supported {
            return Err(anyhow!("navigation_unsupported_capability: language server does not advertise definition support"));
        }
        let (line, character) = lsp::validate_position(&document.content, line, column)?;
        let request = self.begin_request(request_id)?;
        let epoch = self.generation.load(Ordering::SeqCst);
        *self
            .last_semantic
            .lock()
            .map_err(|_| anyhow!("navigation_internal"))? = Instant::now();
        let result = transport.request(
            "textDocument/definition",
            json!({"textDocument":{"uri":document.uri},"position":{"line":line,"character":character}}),
            LOOKUP_TIMEOUT, Some(&request.cancelled),
            |id| request.lsp_id.store(id, Ordering::SeqCst),
        );
        if !self.finish_request(request_id, request.token, epoch)? {
            return Err(anyhow!("navigation_stale_request"));
        }
        let response = self.server_result(&transport, result)?;
        lsp::definition_result(&self.root, &response)
    }

    fn document_symbols(&self, path: &str, version: i64, request_id: &str) -> Result<Value> {
        let _operation = self.admit_operation()?;
        let (transport, document, _, symbols_supported) = self.ready_document(path, version)?;
        if !symbols_supported {
            return Err(anyhow!("navigation_unsupported_capability: language server does not advertise document-symbol support"));
        }
        let request = self.begin_request(request_id)?;
        let epoch = self.generation.load(Ordering::SeqCst);
        *self
            .last_semantic
            .lock()
            .map_err(|_| anyhow!("navigation_internal"))? = Instant::now();
        let result = transport.request(
            "textDocument/documentSymbol",
            json!({"textDocument":{"uri":document.uri}}),
            LOOKUP_TIMEOUT,
            Some(&request.cancelled),
            |id| request.lsp_id.store(id, Ordering::SeqCst),
        );
        if !self.finish_request(request_id, request.token, epoch)? {
            return Err(anyhow!("navigation_stale_request"));
        }
        let response = self.server_result(&transport, result)?;
        let (symbols, truncated) =
            lsp::normalize_symbols(&self.root, &document.canonical, &response);
        Ok(json!({"symbols":symbols,"truncated":truncated}))
    }

    fn server_result(&self, transport: &Arc<Transport>, result: Result<Value>) -> Result<Value> {
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                if !transport.is_alive() {
                    self.fail(error.to_string());
                }
                Err(error)
            }
        }
    }

    fn ready_document(
        &self,
        path: &str,
        version: i64,
    ) -> Result<(Arc<Transport>, Document, bool, bool)> {
        if version < 0 {
            return Err(anyhow!("navigation_invalid_version"));
        }
        let canonical = crate::workspace_services::scoped_path(&self.root, path, true)
            .map_err(|_| anyhow!("navigation_invalid_path"))?;
        let state = self
            .state
            .lock()
            .map_err(|_| anyhow!("navigation_internal"))?;
        match state.phase {
            Phase::Preparing => return Err(anyhow!("navigation_preparing")),
            Phase::Failed => {
                return Err(anyhow!(
                    "navigation_server_failed: {}",
                    state.message.as_deref().unwrap_or("language server failed")
                ))
            }
            Phase::Ready => {}
        }
        let document = state
            .documents
            .get(&canonical)
            .ok_or_else(|| anyhow!("navigation_document_not_synced"))?;
        if document.version != version {
            return Err(anyhow!("navigation_stale_version"));
        }
        Ok((
            state
                .transport
                .clone()
                .ok_or_else(|| anyhow!("navigation_server_failed"))?,
            document.clone(),
            state.definition_supported,
            state.symbols_supported,
        ))
    }

    fn begin_request(&self, id: &str) -> Result<ActiveRequest> {
        validate_id("requestId", id)?;
        let token = self.next_request_token.fetch_add(1, Ordering::Relaxed);
        let stored = ActiveRequest {
            token,
            cancelled: Arc::new(AtomicBool::new(false)),
            lsp_id: Arc::new(AtomicU64::new(0)),
        };
        let returned = ActiveRequest {
            token,
            cancelled: Arc::clone(&stored.cancelled),
            lsp_id: Arc::clone(&stored.lsp_id),
        };
        let mut requests = self
            .requests
            .lock()
            .map_err(|_| anyhow!("navigation_internal"))?;
        if requests.contains_key(id) {
            return Err(anyhow!("navigation_duplicate_request"));
        }
        requests.insert(id.to_owned(), stored);
        Ok(returned)
    }

    fn finish_request(&self, id: &str, token: u64, epoch: u64) -> Result<bool> {
        let request = self
            .requests
            .lock()
            .map_err(|_| anyhow!("navigation_internal"))?
            .remove(id);
        Ok(request.is_some_and(|request| {
            request.token == token
                && !request.cancelled.load(Ordering::SeqCst)
                && self.generation.load(Ordering::SeqCst) == epoch
        }))
    }

    fn cancel(&self, id: &str) {
        let lsp_id = self.requests.lock().ok().and_then(|requests| {
            requests.get(id).map(|request| {
                request.cancelled.store(true, Ordering::SeqCst);
                request.lsp_id.load(Ordering::SeqCst)
            })
        });
        if let Some(lsp_id) = lsp_id {
            if let Ok(state) = self.state.lock() {
                if let Some(transport) = &state.transport {
                    transport.cancel(lsp_id);
                }
            }
        }
    }

    fn install(
        &self,
        transport: Arc<Transport>,
        incremental: bool,
        definition_supported: bool,
        symbols_supported: bool,
        generation: u64,
    ) -> Result<()> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| anyhow!("navigation_internal"))?;
        if self.generation.load(Ordering::SeqCst) != generation {
            return Err(anyhow!("navigation_stale_context"));
        }
        let documents = self
            .state
            .lock()
            .map_err(|_| anyhow!("navigation_internal"))?
            .documents
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let deadline = Instant::now() + SYNC_TIMEOUT;
        for document in documents {
            if Instant::now() >= deadline {
                return Err(anyhow!(
                    "navigation_timeout: replaying synchronized documents timed out"
                ));
            }
            transport.notify("textDocument/didOpen", document.open_params())?;
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("navigation_internal"))?;
        if self.generation.load(Ordering::SeqCst) != generation || state.phase != Phase::Preparing {
            return Err(anyhow!("navigation_stale_context"));
        }
        state.phase = Phase::Ready;
        state.message = None;
        state.incremental_sync = incremental;
        state.definition_supported = definition_supported;
        state.symbols_supported = symbols_supported;
        state.transport = Some(transport);
        Ok(())
    }

    fn attach_starting(&self, transport: Arc<Transport>, generation: u64) -> bool {
        if self.generation.load(Ordering::SeqCst) != generation {
            return false;
        }
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state.phase != Phase::Preparing || self.generation.load(Ordering::SeqCst) != generation {
            return false;
        }
        state.transport = Some(transport);
        true
    }

    fn fail(&self, message: String) {
        let transport = self.state.lock().ok().and_then(|mut state| {
            state.phase = Phase::Failed;
            state.message = Some(bounded_message(&message));
            state.transport.take()
        });
        if let Some(transport) = transport {
            transport.stop();
        }
    }

    fn stop(&self) {
        let transport = self.state.lock().ok().and_then(|mut state| {
            self.generation.fetch_add(1, Ordering::SeqCst);
            state.transport.take()
        });
        if let Ok(requests) = self.requests.lock() {
            for request in requests.values() {
                request.cancelled.store(true, Ordering::SeqCst);
            }
        }
        if let Some(transport) = transport {
            transport.stop();
        }
    }
}

fn initialize_context(manager: &Arc<Manager>, context: &Arc<NavigationContext>) -> Result<()> {
    let configuration = manager
        .configuration
        .read()
        .map_err(|_| anyhow!("navigation_internal"))?
        .clone();
    if !configuration.enabled {
        return Err(anyhow!("navigation_disabled"));
    }
    let context_data = manager.data_dir.join("editor-navigation").join(&context.id);
    let launch = adapters::resolve(
        context.family,
        &configuration.tools,
        &context.root,
        &context_data,
    )?;
    let root_uri = lsp::file_uri(&context.root);
    let generation = context.generation.load(Ordering::SeqCst);
    let initialize_deadline = Instant::now() + launch.initialization_timeout;
    let transport = Transport::spawn(
        &launch.spec,
        &context.root.to_string_lossy(),
        &root_uri,
        launch.settings.clone(),
    )?;
    if !context.attach_starting(Arc::clone(&transport), generation)
        || manager.shutting_down.load(Ordering::SeqCst)
        || !manager.contains(context)
    {
        transport.stop();
        cleanup_context_data(&manager.data_dir, &context.id);
        return Ok(());
    }
    let response = transport.request(
        "initialize",
        json!({
            "processId":Value::Null,
            "clientInfo":{"name":"ThreadTerm","version":env!("CARGO_PKG_VERSION")},
            "rootUri":root_uri,
            "workspaceFolders":[{"uri":root_uri,"name":"workspace"}],
            "capabilities":{
                "workspace":{"configuration":true,"workspaceFolders":true},
                "experimental":if context.family == Family::Rust { json!({"serverStatusNotification":true}) } else { json!({}) },
                "textDocument":{
                    "definition":{"linkSupport":true},
                    "documentSymbol":{"hierarchicalDocumentSymbolSupport":true}
                }
            },
            "initializationOptions":launch.initialize_options
        }),
        launch.initialization_timeout,
        None,
        |_| {},
    );
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            let stderr = transport.stderr_summary();
            transport.stop();
            if context.family == Family::Java {
                // A protocol failure can make the reader own stop while this
                // thread wakes. Its stop is then already in progress, so give
                // Equinox a short bounded window to finish its private log.
                let diagnostic_deadline = Instant::now() + Duration::from_millis(500);
                loop {
                    if let Some(message) = adapters::java_startup_failure(&context_data) {
                        return Err(anyhow!(message));
                    }
                    let now = Instant::now();
                    if now >= diagnostic_deadline {
                        break;
                    }
                    thread::sleep(
                        diagnostic_deadline
                            .saturating_duration_since(now)
                            .min(Duration::from_millis(10)),
                    );
                }
            }
            return Err(if stderr.is_empty() {
                error
            } else {
                anyhow!("{}: {}", error, bounded_message(&stderr))
            });
        }
    };
    let sync_kind = response
        .pointer("/capabilities/textDocumentSync/change")
        .and_then(Value::as_i64)
        .or_else(|| {
            response
                .pointer("/capabilities/textDocumentSync")
                .and_then(Value::as_i64)
        })
        .unwrap_or(1);
    let definition_supported =
        capability_enabled(response.pointer("/capabilities/definitionProvider"));
    let symbols_supported =
        capability_enabled(response.pointer("/capabilities/documentSymbolProvider"));
    transport.notify("initialized", json!({}))?;
    if let Some(settings) = launch.settings {
        transport.notify(
            "workspace/didChangeConfiguration",
            json!({"settings":settings}),
        )?;
    }
    if manager.shutting_down.load(Ordering::SeqCst) || !manager.contains(context) {
        transport.stop();
        return Ok(());
    }
    if context.family == Family::Rust {
        transport.wait_for_rust_quiescence(
            initialize_deadline.saturating_duration_since(Instant::now()),
        )?;
    }
    context.install(
        transport,
        sync_kind == 2,
        definition_supported,
        symbols_supported,
        generation,
    )
}

fn capability_enabled(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(value)) => *value,
        Some(Value::Object(_)) => true,
        _ => false,
    }
}

fn start_idle_reaper(manager: Weak<Manager>) {
    let _ = thread::Builder::new()
        .name("navigation-idle-reaper".into())
        .spawn(move || loop {
            thread::sleep(Duration::from_secs(30));
            let Some(manager) = manager.upgrade() else {
                break;
            };
            if manager.shutting_down.load(Ordering::SeqCst) {
                break;
            }
            let expired = manager.take_idle_at(Instant::now());
            for context in expired {
                manager.retire(context);
            }
        });
}

fn load_configuration(path: &Path) -> Result<Configuration> {
    if !path.exists() {
        return Ok(Configuration::default());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .context("opening editor navigation configuration")?
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .context("reading editor navigation configuration")?;
    if bytes.len() > 64 * 1024 {
        return Err(anyhow!("navigation_invalid_configuration"));
    }
    serde_json::from_slice(&bytes).context("decoding editor navigation configuration")
}

fn persist_configuration(path: &Path, configuration: &Configuration) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("navigation_invalid_configuration"))?;
    fs::create_dir_all(parent).context("creating editor navigation configuration directory")?;
    let bytes = serde_json::to_vec_pretty(configuration)?;
    crate::workspace_services::replace_file_atomically(parent, path, &bytes)
        .context("publishing editor navigation configuration")?;
    Ok(())
}

fn cleanup_context_data(data_dir: &Path, context_id: &str) {
    if uuid::Uuid::parse_str(context_id).is_err() {
        return;
    }
    let base = data_dir.join("editor-navigation");
    let target = base.join(context_id);
    if target.parent() != Some(base.as_path()) || !target.is_dir() {
        return;
    }
    let (Ok(data_root), Ok(base), Ok(target)) = (
        data_dir.canonicalize(),
        base.canonicalize(),
        target.canonicalize(),
    ) else {
        return;
    };
    if base.parent() != Some(data_root.as_path()) || target.parent() != Some(base.as_path()) {
        return;
    }
    let _ = fs::remove_dir_all(target);
}

fn validate_tools(tools: &ToolConfiguration) -> Result<()> {
    for (name, value, directory) in [
        ("typescript", tools.typescript.as_str(), false),
        ("rust", tools.rust.as_str(), false),
        ("python", tools.python.as_str(), false),
        ("java", tools.java.as_str(), false),
        ("jdtls", tools.jdtls.as_str(), true),
    ] {
        if value.len() > 4_096 || value.chars().any(char::is_control) {
            return Err(anyhow!(
                "navigation_invalid_configuration: {name} path is invalid"
            ));
        }
        if value.is_empty() {
            continue;
        }
        let path = Path::new(value);
        if !path.is_absolute() || (directory && !path.is_dir()) || (!directory && !path.is_file()) {
            return Err(anyhow!(
                "navigation_invalid_configuration: {name} must be an existing absolute {} path",
                if directory { "directory" } else { "executable" }
            ));
        }
    }
    Ok(())
}

fn changed_families(previous: &Configuration, next: &Configuration) -> HashSet<&'static str> {
    let mut changed = HashSet::new();
    if previous.enabled != next.enabled {
        changed.extend([
            Family::TypeScript.key(),
            Family::Rust.key(),
            Family::Python.key(),
            Family::Java.key(),
        ]);
    }
    if previous.tools.typescript != next.tools.typescript {
        changed.insert(Family::TypeScript.key());
    }
    if previous.tools.rust != next.tools.rust {
        changed.insert(Family::Rust.key());
    }
    if previous.tools.python != next.tools.python {
        changed.insert(Family::Python.key());
    }
    if previous.tools.java != next.tools.java || previous.tools.jdtls != next.tools.jdtls {
        changed.insert(Family::Java.key());
    }
    changed
}

fn exact_object<'a>(
    value: &'a Value,
    allowed: &[&str],
    required: &[&str],
) -> Result<&'a Map<String, Value>> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("navigation_invalid_params: params must be an object"))?;
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(anyhow!("navigation_invalid_params: unknown field {key}"));
    }
    if let Some(key) = required.iter().find(|key| !object.contains_key(**key)) {
        return Err(anyhow!("navigation_invalid_params: missing field {key}"));
    }
    Ok(object)
}
fn bounded_string<'a>(
    object: &'a Map<String, Value>,
    name: &str,
    maximum: usize,
) -> Result<&'a str> {
    let value = object
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("navigation_invalid_params: {name} must be a string"))?;
    if value.is_empty() || value.len() > maximum || value.chars().any(char::is_control) {
        return Err(anyhow!("navigation_invalid_params: {name} is invalid"));
    }
    Ok(value)
}
fn optional_bounded_string<'a>(
    object: &'a Map<String, Value>,
    name: &str,
    maximum: usize,
) -> Result<Option<&'a str>> {
    match object.get(name) {
        None => Ok(None),
        Some(Value::String(value))
            if !value.is_empty()
                && value.len() <= maximum
                && !value.chars().any(char::is_control) =>
        {
            Ok(Some(value))
        }
        _ => Err(anyhow!("navigation_invalid_params: {name} is invalid")),
    }
}
fn integer(object: &Map<String, Value>, name: &str) -> Result<i64> {
    object
        .get(name)
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow!("navigation_invalid_params: {name} must be an integer"))
}
fn validate_id(name: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.len() > MAX_ID_BYTES || value.chars().any(char::is_control) {
        Err(anyhow!("navigation_invalid_params: {name} is invalid"))
    } else {
        Ok(())
    }
}
fn bounded_message(value: &str) -> String {
    value.chars().take(2_048).collect()
}

fn content_digest(content: &str) -> [u8; 32] {
    Sha256::digest(content.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context(root: &Path) -> NavigationContext {
        NavigationContext::new(
            "desktop:one",
            root.canonicalize().unwrap(),
            Family::Rust,
            "group",
        )
    }

    fn assert_retired_request(
        manager: &Manager,
        context: &Arc<NavigationContext>,
        request_id: &str,
        request: ActiveRequest,
        epoch: u64,
    ) {
        assert!(!manager.contexts.lock().unwrap().contains_key(&context.id));
        assert!(request.cancelled.load(Ordering::SeqCst));
        assert_ne!(context.generation.load(Ordering::SeqCst), epoch);
        assert!(!context
            .finish_request(request_id, request.token, epoch)
            .unwrap());
        assert!(!context.requests.lock().unwrap().contains_key(request_id));
    }

    #[test]
    fn full_snapshots_are_atomic_across_version_conflicts_and_omissions() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("a.rs"), "fn a() {}").unwrap();
        fs::write(temp.path().join("b.py"), "def b(): pass").unwrap();
        let context = context(temp.path());
        let a = lsp::document(temp.path(), "a.rs", "fn a() {}".into(), 1).unwrap();
        let b = lsp::document(temp.path(), "b.py", "def b(): pass".into(), 4).unwrap();
        context.sync(vec![a.clone(), b]).unwrap();
        let conflicting = lsp::document(temp.path(), "a.rs", "fn changed() {}".into(), 1).unwrap();
        assert!(context
            .sync(vec![conflicting])
            .unwrap_err()
            .to_string()
            .starts_with("navigation_version_conflict"));
        assert_eq!(context.state.lock().unwrap().documents.len(), 2);
        context.sync(vec![a]).unwrap();
        assert_eq!(context.state.lock().unwrap().documents.len(), 1);
        context.sync(Vec::new()).unwrap();
        let reopened_older = lsp::document(temp.path(), "a.rs", "fn a() {}".into(), 0).unwrap();
        assert_eq!(
            context.sync(vec![reopened_older]).unwrap_err().to_string(),
            "navigation_stale_version"
        );
    }

    #[test]
    fn request_cancel_is_generation_fenced_without_taking_the_operation_lock() {
        let temp = tempfile::tempdir().unwrap();
        let context = context(temp.path());
        let request = context.begin_request("request-1").unwrap();
        context.cancel("request-1");
        assert!(request.cancelled.load(Ordering::SeqCst));
        assert!(!context
            .finish_request(
                "request-1",
                request.token,
                context.generation.load(Ordering::SeqCst)
            )
            .unwrap());
    }

    #[test]
    fn startup_queue_prunes_released_weak_contexts_and_rejects_a_third_live_context() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir_all(&root).unwrap();
        let db = crate::db::Database::open(&temp.path().join("runtime.sqlite")).unwrap();
        let project = db
            .add_project(root.to_str().unwrap(), Some("Navigation"), "project")
            .unwrap();
        let manager = Manager::new(&temp.path().join("data"));
        manager.startup.lock().unwrap().running = true;
        let prepare = |buffer_group: &str| {
            manager.prepare(
                &db,
                "desktop:one",
                &json!({
                    "projectId": project.id,
                    "bufferGroup": buffer_group,
                    "language": "rust"
                }),
            )
        };

        let first = prepare("pane-a").unwrap()["contextId"]
            .as_str()
            .unwrap()
            .to_owned();
        let second = prepare("pane-b").unwrap()["contextId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(manager.startup.lock().unwrap().queue.len(), MAX_CONTEXTS);

        manager
            .release("desktop:one", &json!({"contextId": first}))
            .unwrap();
        let replacement = prepare("pane-c").unwrap()["contextId"]
            .as_str()
            .unwrap()
            .to_owned();
        let queued = manager
            .startup
            .lock()
            .unwrap()
            .queue
            .iter()
            .filter_map(Weak::upgrade)
            .map(|context| context.id.clone())
            .collect::<HashSet<_>>();
        assert_eq!(queued, HashSet::from([second.clone(), replacement.clone()]));
        assert_eq!(queued.len(), MAX_CONTEXTS);
        assert_eq!(manager.contexts.lock().unwrap().len(), MAX_CONTEXTS);

        assert_eq!(
            prepare("pane-d").unwrap_err().to_string(),
            "navigation_busy: two navigation contexts are already busy"
        );
        assert_eq!(manager.startup.lock().unwrap().queue.len(), MAX_CONTEXTS);
        manager.shutdown();
    }

    #[test]
    fn idle_selection_removes_only_stale_inactive_contexts() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Manager::new(temp.path());
        let root = temp.path().canonicalize().unwrap();
        let stale = Arc::new(NavigationContext::new(
            "desktop:one",
            root.clone(),
            Family::Rust,
            "stale",
        ));
        let recent = Arc::new(NavigationContext::new(
            "desktop:one",
            root.clone(),
            Family::Rust,
            "recent",
        ));
        let active = Arc::new(NavigationContext::new(
            "desktop:one",
            root,
            Family::Rust,
            "active",
        ));
        for context in [&stale, &recent, &active] {
            context.state.lock().unwrap().phase = Phase::Failed;
        }
        let now = Instant::now();
        *stale.last_semantic.lock().unwrap() = now - SEMANTIC_IDLE - Duration::from_secs(1);
        *recent.last_semantic.lock().unwrap() = now - SEMANTIC_IDLE + Duration::from_secs(1);
        active.begin_request("active-request").unwrap();
        *active.last_semantic.lock().unwrap() = now - SEMANTIC_IDLE - Duration::from_secs(1);
        manager.contexts.lock().unwrap().extend([
            (stale.id.clone(), Arc::clone(&stale)),
            (recent.id.clone(), Arc::clone(&recent)),
            (active.id.clone(), Arc::clone(&active)),
        ]);

        let expired = manager.take_idle_at(now);
        assert_eq!(expired.len(), 1);
        assert!(Arc::ptr_eq(&expired[0], &stale));
        let remaining = manager.contexts.lock().unwrap();
        assert!(!remaining.contains_key(&stale.id));
        assert!(remaining.contains_key(&recent.id));
        assert!(remaining.contains_key(&active.id));
        drop(remaining);
        for context in expired {
            manager.retire(context);
        }
        manager.shutdown();
    }

    #[test]
    fn release_disconnect_and_shutdown_cancel_and_fence_active_requests() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Manager::new(temp.path());
        let root = temp.path().canonicalize().unwrap();
        let released = Arc::new(NavigationContext::new(
            "desktop:release",
            root.clone(),
            Family::Rust,
            "release",
        ));
        let disconnected = Arc::new(NavigationContext::new(
            "desktop:disconnect",
            root.clone(),
            Family::Rust,
            "disconnect",
        ));
        let shutdown = Arc::new(NavigationContext::new(
            "desktop:shutdown",
            root,
            Family::Rust,
            "shutdown",
        ));
        manager.contexts.lock().unwrap().extend([
            (released.id.clone(), Arc::clone(&released)),
            (disconnected.id.clone(), Arc::clone(&disconnected)),
        ]);

        let released_request = released.begin_request("release-request").unwrap();
        let released_epoch = released.generation.load(Ordering::SeqCst);
        manager
            .release(
                "desktop:release",
                &json!({"contextId": released.id.clone()}),
            )
            .unwrap();
        assert_retired_request(
            &manager,
            &released,
            "release-request",
            released_request,
            released_epoch,
        );
        manager
            .contexts
            .lock()
            .unwrap()
            .insert(shutdown.id.clone(), Arc::clone(&shutdown));

        let disconnected_request = disconnected.begin_request("disconnect-request").unwrap();
        let disconnected_epoch = disconnected.generation.load(Ordering::SeqCst);
        manager.disconnect("desktop:disconnect");
        assert_retired_request(
            &manager,
            &disconnected,
            "disconnect-request",
            disconnected_request,
            disconnected_epoch,
        );
        assert!(manager.contexts.lock().unwrap().contains_key(&shutdown.id));

        let shutdown_request = shutdown.begin_request("shutdown-request").unwrap();
        let shutdown_epoch = shutdown.generation.load(Ordering::SeqCst);
        manager.shutdown();
        assert_retired_request(
            &manager,
            &shutdown,
            "shutdown-request",
            shutdown_request,
            shutdown_epoch,
        );
        assert!(manager.contexts.lock().unwrap().is_empty());
    }

    #[test]
    fn context_operations_reject_queueing_behind_an_active_operation() {
        let temp = tempfile::tempdir().unwrap();
        let context = context(temp.path());
        let _active = context.operation.lock().unwrap();
        assert_eq!(
            context.sync(Vec::new()).unwrap_err().to_string(),
            "navigation_busy: context already has an active operation"
        );
    }

    #[test]
    fn strict_params_and_family_specific_invalidation_are_exact() {
        assert!(exact_object(
            &json!({"contextId":"x","extra":true}),
            &["contextId"],
            &["contextId"]
        )
        .is_err());
        let before = Configuration::default();
        let mut after = before.clone();
        after.tools.python = "configured".into();
        assert_eq!(
            changed_families(&before, &after),
            HashSet::from([Family::Python.key()])
        );
        assert!(capability_enabled(Some(&json!({"workDoneProgress":true}))));
        assert!(capability_enabled(Some(&json!(true))));
        assert!(!capability_enabled(Some(&json!(false))));
        assert!(!capability_enabled(None));
    }

    #[test]
    fn context_tokens_bind_principal_root_family_and_buffer_group() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Manager::new(temp.path());
        let root = temp.path().canonicalize().unwrap();
        let first = Arc::new(NavigationContext::new(
            "desktop:one",
            root.clone(),
            Family::TypeScript,
            "pane-a",
        ));
        let divergent = Arc::new(NavigationContext::new(
            "desktop:one",
            root,
            Family::TypeScript,
            "pane-b",
        ));
        manager.contexts.lock().unwrap().extend([
            (first.id.clone(), Arc::clone(&first)),
            (divergent.id.clone(), Arc::clone(&divergent)),
        ]);
        assert_ne!(first.id, divergent.id);
        assert!(manager.context("desktop:one", &first.id).is_ok());
        assert_eq!(
            manager
                .context("desktop:two", &first.id)
                .err()
                .unwrap()
                .to_string(),
            "navigation_foreign_context"
        );
        manager.shutdown();
    }

    #[test]
    fn private_context_cleanup_is_uuid_scoped_under_runtime_data() {
        let temp = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let target = temp.path().join("editor-navigation").join(&id);
        let sibling = temp.path().join("editor-navigation").join("keep-me");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(target.join("state"), b"private").unwrap();
        cleanup_context_data(temp.path(), &id);
        assert!(!target.exists());
        assert!(sibling.exists());
        cleanup_context_data(temp.path(), "../keep-me");
        assert!(sibling.exists());
    }

    #[test]
    fn configuration_reads_are_bounded_and_atomic_replacement_round_trips() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("editor-navigation.json");
        fs::write(&path, vec![b'x'; 64 * 1024 + 1]).unwrap();
        assert_eq!(
            load_configuration(&path).unwrap_err().to_string(),
            "navigation_invalid_configuration"
        );
        let disabled = Configuration {
            enabled: false,
            tools: ToolConfiguration::default(),
        };
        persist_configuration(&path, &disabled).unwrap();
        assert_eq!(load_configuration(&path).unwrap(), disabled);
        let enabled = Configuration::default();
        persist_configuration(&path, &enabled).unwrap();
        assert_eq!(load_configuration(&path).unwrap(), enabled);
    }
}
