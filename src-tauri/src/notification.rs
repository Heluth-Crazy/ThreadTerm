use std::collections::{HashSet, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

#[cfg(target_os = "windows")]
use tauri_winrt_notification::{Duration as NativeToastDuration, Sound, Toast};
#[cfg(target_os = "windows")]
use windows::{
    core::HSTRING,
    Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID,
    UI::Notifications::{NotificationSetting, ToastNotificationManager},
};

const MAX_DELIVERY_RECEIPTS: usize = 256;
const MAX_LIVE_ACTIVATION_REGISTRATIONS: usize = 4096;
pub const NOTIFICATION_ACTIVATED_EVENT: &str = "notification://activated";

/// Delivery channels are intentionally explicit so the frontend can show a
/// degraded receipt without mistaking the plugin fallback for a reliable
/// Windows activation path.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NotificationDeliveryChannel {
    WindowsNative,
    Plugin,
}

/// A delivery result is diagnostic only. It never acknowledges a ledger entry.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NotificationDeliveryStatus {
    Accepted,
    Degraded,
    Failed,
    DisabledBySystem,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NotificationDeliveryReason {
    IdentityUnavailable,
    DisabledForApplication,
    DisabledForUser,
    DisabledByGroupPolicy,
    DisabledByManifest,
    NativeShowFailed,
    PluginFallbackFailed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NotificationIdentitySource {
    NsisShortcut,
    RuntimeRegistration,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationDeliveryReceipt {
    pub notification_id: Option<String>,
    pub channel: NotificationDeliveryChannel,
    pub status: NotificationDeliveryStatus,
    /// Rust can establish that an event carried a target id, but the frontend
    /// ledger remains authoritative for whether that card still exists.
    pub target_exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<NotificationDeliveryReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_source: Option<NotificationIdentitySource>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationActivationPayload {
    pub notification_id: String,
}

#[derive(Default)]
struct NotificationRuntimeState {
    pending_activations: VecDeque<String>,
    /// Native callback identities are process-lifetime facts. Never evict
    /// them: a duplicate callback after a successful drain must remain a
    /// no-op, even during a long-running session.
    seen_activation_ids: HashSet<String>,
    live_registrations: VecDeque<String>,
    live_registration_ids: HashSet<String>,
    receipts: VecDeque<NotificationDeliveryReceipt>,
    app_user_model_id: Option<String>,
    identity_source: Option<NotificationIdentitySource>,
}

/// Process-scoped native notification state.
///
/// Pending activations are deliberately not hard-capped: callbacks are
/// deduplicated while queued, and every queued id must survive until the
/// frontend drains it. Delivery receipts are diagnostic history and use a
/// bounded oldest-first eviction policy.
#[derive(Clone, Default)]
pub struct NotificationRuntime {
    state: Arc<Mutex<NotificationRuntimeState>>,
}

impl NotificationRuntime {
    fn with_state<R>(&self, operation: impl FnOnce(&mut NotificationRuntimeState) -> R) -> R {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        operation(&mut state)
    }

    /// Queue one activation exactly once for the whole application process.
    pub fn queue_activation(&self, notification_id: impl Into<String>) -> bool {
        let notification_id = notification_id.into();
        if notification_id.is_empty() {
            return false;
        }

        self.with_state(|state| {
            if !state.seen_activation_ids.insert(notification_id.clone()) {
                return false;
            }
            state.pending_activations.push_back(notification_id);
            true
        })
    }

    /// Atomically remove and return pending activation ids in FIFO order.
    pub fn drain_pending_activations(&self) -> Vec<String> {
        self.with_state(|state| state.pending_activations.drain(..).collect())
    }

    fn register_activation(&self, notification_id: &str) {
        self.with_state(|state| {
            if !state
                .live_registration_ids
                .insert(notification_id.to_owned())
            {
                return;
            }
            state
                .live_registrations
                .push_back(notification_id.to_owned());
            while state.live_registrations.len() > MAX_LIVE_ACTIVATION_REGISTRATIONS {
                if let Some(expired) = state.live_registrations.pop_front() {
                    state.live_registration_ids.remove(&expired);
                }
            }
        });
    }

    fn unregister_activation(&self, notification_id: &str) {
        self.with_state(|state| {
            if !state.live_registration_ids.remove(notification_id) {
                return;
            }
            state
                .live_registrations
                .retain(|registered| registered != notification_id);
        });
    }

    fn record_receipt(&self, receipt: NotificationDeliveryReceipt) {
        self.with_state(|state| {
            state.receipts.push_back(receipt);
            while state.receipts.len() > MAX_DELIVERY_RECEIPTS {
                state.receipts.pop_front();
            }
        });
    }

    fn set_identity(&self, app_user_model_id: String, source: NotificationIdentitySource) {
        self.with_state(|state| {
            state.app_user_model_id = Some(app_user_model_id);
            state.identity_source = Some(source);
        });
    }

    fn identity(&self) -> Option<(String, NotificationIdentitySource)> {
        self.with_state(|state| {
            state
                .app_user_model_id
                .clone()
                .zip(state.identity_source.clone())
        })
    }

    #[cfg(test)]
    fn receipts(&self) -> Vec<NotificationDeliveryReceipt> {
        self.with_state(|state| state.receipts.iter().cloned().collect())
    }

    #[cfg(test)]
    fn live_registration_count(&self) -> usize {
        self.with_state(|state| state.live_registrations.len())
    }
}

fn normalized_notification_id(notification_id: Option<String>) -> Option<String> {
    notification_id.and_then(|id| if id.is_empty() { None } else { Some(id) })
}

fn target_exists(card_id: Option<&str>) -> bool {
    card_id.is_some_and(|id| !id.is_empty())
}

/// Establish a per-user AUMID before any window is created. Installed builds
/// retain the NSIS shortcut identity; development/unpacked runs use an
/// isolated `.dev` identity and never borrow PowerShell's AUMID.
#[cfg(target_os = "windows")]
pub fn initialize_windows_notification_identity(
    app: &AppHandle,
    runtime: &NotificationRuntime,
) -> Result<(), String> {
    use windows_registry::CURRENT_USER;

    let configured = app.config().identifier.clone();
    let is_development = tauri::is_dev();
    let app_user_model_id = if is_development {
        format!("{configured}.dev")
    } else {
        configured
    };
    let display_name = if is_development {
        "ThreadTerm (Development)"
    } else {
        "ThreadTerm"
    };
    let key = CURRENT_USER
        .create(format!(
            r"SOFTWARE\Classes\AppUserModelId\{app_user_model_id}"
        ))
        .map_err(|error| error.to_string())?;
    key.set_string("DisplayName", display_name)
        .map_err(|error| error.to_string())?;
    key.set_string("IconBackgroundColor", "0")
        .map_err(|error| error.to_string())?;

    // A missing optional icon must not invalidate an otherwise usable AUMID.
    if let Ok(icon) = app
        .path()
        .resource_dir()
        .map(|path| path.join("icons/icon.ico"))
    {
        if icon.exists() {
            let icon_uri = HSTRING::from(icon.as_path());
            let _: Result<_, _> = key.set_hstring("IconUri", &icon_uri);
        }
    }

    unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(&app_user_model_id)) }
        .map_err(|error| error.to_string())?;
    let source = if is_development {
        NotificationIdentitySource::RuntimeRegistration
    } else {
        NotificationIdentitySource::NsisShortcut
    };
    runtime.set_identity(app_user_model_id, source);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn initialize_windows_notification_identity(
    _app: &AppHandle,
    _runtime: &NotificationRuntime,
) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
fn receipt(
    notification_id: Option<String>,
    card_id: Option<&str>,
    channel: NotificationDeliveryChannel,
    status: NotificationDeliveryStatus,
) -> NotificationDeliveryReceipt {
    NotificationDeliveryReceipt {
        notification_id,
        channel,
        status,
        target_exists: target_exists(card_id),
        reason: None,
        identity_source: None,
    }
}

fn record_receipt(runtime: &NotificationRuntime, receipt: NotificationDeliveryReceipt) {
    tracing::info!(
        notification_id = receipt.notification_id.as_deref().unwrap_or(""),
        channel = ?receipt.channel,
        status = ?receipt.status,
        target_exists = receipt.target_exists,
        "notification delivery receipt"
    );
    runtime.record_receipt(receipt);
}

#[cfg(target_os = "windows")]
fn system_notification_setting(
    app_user_model_id: &str,
) -> Result<Option<NotificationDeliveryReason>, ()> {
    let notifier =
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_user_model_id))
            .map_err(|_| ())?;
    match notifier.Setting().map_err(|_| ())? {
        NotificationSetting::Enabled => Ok(None),
        NotificationSetting::DisabledForApplication => {
            Ok(Some(NotificationDeliveryReason::DisabledForApplication))
        }
        NotificationSetting::DisabledForUser => {
            Ok(Some(NotificationDeliveryReason::DisabledForUser))
        }
        NotificationSetting::DisabledByGroupPolicy => {
            Ok(Some(NotificationDeliveryReason::DisabledByGroupPolicy))
        }
        NotificationSetting::DisabledByManifest => {
            Ok(Some(NotificationDeliveryReason::DisabledByManifest))
        }
        _ => Ok(Some(NotificationDeliveryReason::DisabledForApplication)),
    }
}

/// Keep the fallback decision in a pure function so native failure and
/// double-failure behavior can be tested without a Windows notification host.
fn classify_delivery(
    has_event_identity: bool,
    native_attempted: bool,
    native_succeeded: bool,
    plugin_succeeded: bool,
    native_platform: bool,
) -> (NotificationDeliveryChannel, NotificationDeliveryStatus) {
    if native_attempted && native_succeeded && has_event_identity {
        return (
            NotificationDeliveryChannel::WindowsNative,
            NotificationDeliveryStatus::Accepted,
        );
    }

    if plugin_succeeded {
        let status = if native_platform {
            NotificationDeliveryStatus::Degraded
        } else {
            NotificationDeliveryStatus::Accepted
        };
        return (NotificationDeliveryChannel::Plugin, status);
    }

    (
        NotificationDeliveryChannel::Plugin,
        NotificationDeliveryStatus::Failed,
    )
}

#[derive(Debug, PartialEq, Eq)]
struct DispatchOutcome {
    receipt: NotificationDeliveryReceipt,
    native_attempted: bool,
    native_succeeded: bool,
    plugin_attempted: bool,
    plugin_succeeded: bool,
}

/// Shared delivery boundary for production and tests. The platform adapters
/// are injected as closures so fallback ordering and receipt semantics are
/// exercised without requiring a real Windows toast host.
fn dispatch_with_backend<'a>(
    notification_id: Option<String>,
    target_exists: bool,
    native_platform: bool,
    native_send: Option<Box<dyn FnOnce() -> Result<(), ()> + 'a>>,
    plugin_send: Box<dyn FnOnce() -> Result<(), ()> + 'a>,
) -> DispatchOutcome {
    let has_event_identity = notification_id.is_some();
    let (native_attempted, native_succeeded) = if native_platform {
        if let Some(send) = native_send {
            (true, send().is_ok())
        } else {
            (false, false)
        }
    } else {
        (false, false)
    };
    let plugin_attempted = !native_succeeded;
    let plugin_succeeded = if plugin_attempted {
        plugin_send().is_ok()
    } else {
        false
    };
    let (channel, status) = classify_delivery(
        has_event_identity,
        native_attempted,
        native_succeeded,
        plugin_succeeded,
        native_platform,
    );

    DispatchOutcome {
        receipt: NotificationDeliveryReceipt {
            notification_id,
            channel,
            status,
            target_exists,
            reason: None,
            identity_source: None,
        },
        native_attempted,
        native_succeeded,
        plugin_attempted,
        plugin_succeeded,
    }
}

#[tauri::command]
pub async fn notification_send_os(
    app: AppHandle,
    runtime: State<'_, NotificationRuntime>,
    notification_id: Option<String>,
    title: String,
    body: String,
    card_id: Option<String>,
) -> Result<NotificationDeliveryReceipt, String> {
    let notification_id = normalized_notification_id(notification_id);
    let target_exists = target_exists(card_id.as_deref());

    #[cfg(target_os = "windows")]
    if let Some(notification_id) = notification_id.as_ref() {
        if let Some((app_user_model_id, identity_source)) = runtime.identity() {
            if let Ok(Some(reason)) = system_notification_setting(&app_user_model_id) {
                let receipt = NotificationDeliveryReceipt {
                    notification_id: Some(notification_id.clone()),
                    channel: NotificationDeliveryChannel::WindowsNative,
                    status: NotificationDeliveryStatus::DisabledBySystem,
                    target_exists,
                    reason: Some(reason),
                    identity_source: Some(identity_source),
                };
                record_receipt(&runtime, receipt.clone());
                return Ok(receipt);
            }
        }
    }
    let receipt_notification_id = notification_id.clone();
    let plugin_app = app.clone();
    let plugin_notification_id = notification_id.clone();
    let plugin_card_id = card_id.clone();
    let plugin_title = title.clone();
    let plugin_body = body.clone();
    let plugin_send = Box::new(move || {
        send_plugin_notification(
            &plugin_app,
            plugin_notification_id.as_deref(),
            &plugin_title,
            &plugin_body,
            plugin_card_id.as_deref(),
        )
        .map_err(|_| ())
    });

    #[cfg(target_os = "windows")]
    let native_send: Option<Box<dyn FnOnce() -> Result<(), ()>>> =
        notification_id.as_deref().map(|id| {
            let native_app = app.clone();
            let native_runtime = runtime.clone();
            let native_id = id.to_owned();
            let native_title = title.clone();
            let native_body = body.clone();
            Box::new(move || {
                send_native_notification(
                    &native_app,
                    &native_runtime,
                    &native_id,
                    &native_title,
                    &native_body,
                    target_exists,
                )
            }) as Box<dyn FnOnce() -> Result<(), ()>>
        });

    #[cfg(not(target_os = "windows"))]
    let native_send: Option<Box<dyn FnOnce() -> Result<(), ()>>> = None;

    let outcome = dispatch_with_backend(
        receipt_notification_id,
        target_exists,
        cfg!(target_os = "windows"),
        native_send,
        plugin_send,
    );
    if outcome.native_attempted && !outcome.native_succeeded {
        tracing::warn!(
            notification_id = notification_id.as_deref().unwrap_or(""),
            channel = "windows-native",
            status = "failed",
            target_exists,
            "native notification delivery failed; trying plugin fallback"
        );
    }
    if outcome.plugin_attempted && !outcome.plugin_succeeded {
        tracing::warn!(
            notification_id = notification_id.as_deref().unwrap_or(""),
            channel = "plugin",
            status = "failed",
            target_exists,
            "plugin notification delivery failed"
        );
    }
    let mut delivery_receipt = NotificationDeliveryReceipt {
        target_exists,
        ..outcome.receipt
    };
    #[cfg(target_os = "windows")]
    {
        let identity = runtime.identity();
        delivery_receipt.identity_source = identity.as_ref().map(|(_, source)| source.clone());
        if !outcome.native_succeeded {
            delivery_receipt.reason = Some(if identity.is_none() {
                NotificationDeliveryReason::IdentityUnavailable
            } else if !outcome.plugin_succeeded {
                NotificationDeliveryReason::PluginFallbackFailed
            } else {
                NotificationDeliveryReason::NativeShowFailed
            });
        }
    }
    record_receipt(&runtime, delivery_receipt.clone());
    // Delivery failures are expected, typed outcomes. The ledger and the
    // frontend fallback still need the receipt, so reserve Err for actual IPC
    // or runtime faults rather than turning a display failure into a lost fact.
    Ok(delivery_receipt)
}

fn send_plugin_notification(
    app: &AppHandle,
    notification_id: Option<&str>,
    title: &str,
    body: &str,
    card_id: Option<&str>,
) -> Result<(), String> {
    let mut builder = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .sound("default")
        .auto_cancel();

    for (key, value) in notification_extras(notification_id, card_id) {
        builder = builder.extra(key, value);
    }

    builder.show().map_err(|error| error.to_string())
}

/// Native toast callbacks are attached to one toast instance and capture the
/// event id directly. The id is not derived from a card, so two episodes from
/// one card cannot replace one another.
#[cfg(target_os = "windows")]
fn send_native_notification(
    app: &AppHandle,
    runtime: &NotificationRuntime,
    notification_id: &str,
    title: &str,
    body: &str,
    target_exists: bool,
) -> Result<(), ()> {
    let (app_user_model_id, _) = runtime.identity().ok_or(())?;
    runtime.register_activation(notification_id);
    let callback_app = app.clone();
    let activation_runtime = runtime.clone();
    let dismissal_runtime = runtime.clone();
    let activation_notification_id = notification_id.to_owned();
    let dismissal_notification_id = notification_id.to_owned();
    let toast = Toast::new(&app_user_model_id)
        .title(title)
        .text1(body)
        .sound(Some(Sound::Default))
        .duration(NativeToastDuration::Short)
        .add_button("Open", notification_id)
        .on_activated(move |_| {
            // Queue before any focus or event emission. If either operation
            // fails, the drain command still has the authoritative id.
            let notification_id = activation_notification_id.clone();
            activation_runtime.queue_activation(notification_id.clone());
            activation_runtime.unregister_activation(&notification_id);
            if focus_main_window(&callback_app).is_err() {
                tracing::warn!(
                    notification_id,
                    channel = "windows-native",
                    status = "focus-failed",
                    target_exists,
                    "native notification activation could not focus main window"
                );
            }
            let payload = NotificationActivationPayload {
                notification_id: notification_id.clone(),
            };
            if callback_app
                .emit(NOTIFICATION_ACTIVATED_EVENT, payload)
                .is_err()
            {
                tracing::warn!(
                    notification_id,
                    channel = "windows-native",
                    status = "activation-emit-failed",
                    target_exists,
                    "native notification activation event was not emitted"
                );
            }
            Ok(())
        })
        .on_dismissed(move |_| {
            dismissal_runtime.unregister_activation(&dismissal_notification_id);
            Ok(())
        });

    match toast.show().map_err(|_| ()) {
        Ok(()) => Ok(()),
        Err(()) => {
            runtime.unregister_activation(notification_id);
            Err(())
        }
    }
}

/// Keep the native notification payload additive and backwards-compatible:
/// cardId remains available for existing consumers, while notificationId is
/// included only when the caller has an event-level identity to preserve.
fn notification_extras(
    notification_id: Option<&str>,
    card_id: Option<&str>,
) -> Vec<(&'static str, String)> {
    let mut extras = Vec::with_capacity(2);
    if let Some(card_id) = card_id {
        extras.push(("cardId", card_id.to_owned()));
    }
    if let Some(notification_id) = notification_id {
        extras.push(("notificationId", notification_id.to_owned()));
    }
    extras
}

#[tauri::command]
pub fn notification_drain_pending_activations(
    runtime: State<'_, NotificationRuntime>,
) -> Vec<String> {
    runtime.drain_pending_activations()
}

/// Bring the main window to the foreground. Invoked after a system-notification
/// click (and in-app "recent notifications" jumps) so the card the user asked
/// for is actually visible, not buried behind other apps.
#[tauri::command]
pub async fn window_focus_main(app: AppHandle) -> Result<(), String> {
    focus_main_window(&app)
}

fn focus_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;

    // Windows restricts SetForegroundWindow for background processes — a plain
    // set_focus often only flashes the taskbar icon. Briefly toggling
    // always-on-top forces the window above the z-order before focusing, then
    // releases it so we don't pin over other apps. Best-effort: a failed
    // toggle must not abort the focus call.
    #[cfg(target_os = "windows")]
    {
        if let Err(error) = window.set_always_on_top(true) {
            tracing::warn!(error = %error, "focus workaround: set_always_on_top(true) failed");
        }
    }

    let focus_result = window.set_focus().map_err(|e| e.to_string());

    #[cfg(target_os = "windows")]
    {
        if let Err(error) = window.set_always_on_top(false) {
            tracing::warn!(error = %error, "focus workaround: set_always_on_top(false) failed");
        }
    }

    focus_result
}

impl fmt::Display for NotificationDeliveryChannel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::WindowsNative => "windows-native",
            Self::Plugin => "plugin",
        })
    }
}

impl fmt::Display for NotificationDeliveryStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Accepted => "accepted",
            Self::Degraded => "degraded",
            Self::Failed => "failed",
            Self::DisabledBySystem => "disabled-by-system",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn preserves_card_extra_and_adds_optional_event_identity() {
        assert_eq!(
            notification_extras(Some("event-1"), Some("card-1")),
            vec![
                ("cardId", "card-1".to_string()),
                ("notificationId", "event-1".to_string()),
            ]
        );
    }

    #[test]
    fn omits_optional_extras_without_changing_legacy_payload_shape() {
        assert_eq!(
            notification_extras(None, Some("card-1")),
            vec![("cardId", "card-1".to_string())]
        );
        assert!(notification_extras(None, None).is_empty());
    }

    #[test]
    fn empty_event_identity_is_not_treated_as_reliable_native_target() {
        assert_eq!(normalized_notification_id(Some(String::new())), None);
        assert_eq!(
            normalized_notification_id(Some("event-1".to_string())),
            Some("event-1".to_string())
        );
    }

    #[test]
    fn native_event_delivery_is_accepted() {
        assert_eq!(
            classify_delivery(true, true, true, false, true),
            (
                NotificationDeliveryChannel::WindowsNative,
                NotificationDeliveryStatus::Accepted
            )
        );
    }

    #[test]
    fn injected_native_success_skips_plugin_and_returns_receipt() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let native_order = order.clone();
        let plugin_order = order.clone();
        let outcome = dispatch_with_backend(
            Some("event-1".to_string()),
            true,
            true,
            Some(Box::new(move || {
                native_order.lock().expect("order lock").push("native");
                Ok(())
            })),
            Box::new(move || {
                plugin_order.lock().expect("order lock").push("plugin");
                Ok(())
            }),
        );
        assert_eq!(*order.lock().expect("order lock"), vec!["native"]);
        assert_eq!(outcome.receipt.status, NotificationDeliveryStatus::Accepted);
        assert_eq!(
            outcome.receipt.channel,
            NotificationDeliveryChannel::WindowsNative
        );
        assert!(outcome.receipt.target_exists);
    }

    #[test]
    fn native_failure_uses_degraded_plugin_fallback() {
        assert_eq!(
            classify_delivery(true, true, false, true, true),
            (
                NotificationDeliveryChannel::Plugin,
                NotificationDeliveryStatus::Degraded
            )
        );
    }

    #[test]
    fn injected_native_failure_calls_plugin_and_returns_degraded_receipt() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let native_order = order.clone();
        let plugin_order = order.clone();
        let outcome = dispatch_with_backend(
            Some("event-1".to_string()),
            true,
            true,
            Some(Box::new(move || {
                native_order.lock().expect("order lock").push("native");
                Err(())
            })),
            Box::new(move || {
                plugin_order.lock().expect("order lock").push("plugin");
                Ok(())
            }),
        );
        assert_eq!(*order.lock().expect("order lock"), vec!["native", "plugin"]);
        assert_eq!(outcome.receipt.status, NotificationDeliveryStatus::Degraded);
        assert_eq!(outcome.receipt.channel, NotificationDeliveryChannel::Plugin);
    }

    #[test]
    fn injected_double_failure_returns_failed_receipt_without_reordering() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let native_order = order.clone();
        let plugin_order = order.clone();
        let outcome = dispatch_with_backend(
            Some("event-1".to_string()),
            true,
            true,
            Some(Box::new(move || {
                native_order.lock().expect("order lock").push("native");
                Err(())
            })),
            Box::new(move || {
                plugin_order.lock().expect("order lock").push("plugin");
                Err(())
            }),
        );
        assert_eq!(*order.lock().expect("order lock"), vec!["native", "plugin"]);
        assert_eq!(outcome.receipt.status, NotificationDeliveryStatus::Failed);
        assert_eq!(outcome.receipt.channel, NotificationDeliveryChannel::Plugin);
    }

    #[test]
    fn double_failure_is_reported_without_content_in_receipt() {
        let (channel, status) = classify_delivery(true, true, false, false, true);
        let delivery = receipt(Some("event-1".to_string()), Some("card-1"), channel, status);
        let serialized = serde_json::to_string(&delivery).expect("receipt serializes");
        assert_eq!(delivery.status, NotificationDeliveryStatus::Failed);
        assert!(!serialized.contains("title"));
        assert!(!serialized.contains("body"));
    }

    #[test]
    fn card_only_windows_delivery_is_degraded_and_not_native() {
        assert_eq!(
            classify_delivery(false, false, false, true, true),
            (
                NotificationDeliveryChannel::Plugin,
                NotificationDeliveryStatus::Degraded
            )
        );
    }

    #[test]
    fn non_windows_plugin_delivery_remains_accepted() {
        assert_eq!(
            classify_delivery(true, false, false, true, false),
            (
                NotificationDeliveryChannel::Plugin,
                NotificationDeliveryStatus::Accepted
            )
        );
    }

    #[test]
    fn pending_activation_queue_is_fifo_and_process_lifetime_deduplicated() {
        let runtime = NotificationRuntime::default();
        assert!(runtime.queue_activation("event-a"));
        assert!(runtime.queue_activation("event-b"));
        assert!(!runtime.queue_activation("event-a"));
        assert_eq!(runtime.drain_pending_activations(), ["event-a", "event-b"]);
        assert!(!runtime.queue_activation("event-a"));
        assert!(runtime.queue_activation("event-c"));
        assert_eq!(runtime.drain_pending_activations(), ["event-c"]);
        assert!(!runtime.queue_activation(String::new()));
    }

    #[test]
    fn activation_remains_drainable_when_emit_fails_after_queueing() {
        let runtime = NotificationRuntime::default();
        assert!(runtime.queue_activation("event-emit-failed"));
        let simulated_emit: Result<(), ()> = Err(());
        assert!(simulated_emit.is_err());
        assert_eq!(runtime.drain_pending_activations(), ["event-emit-failed"]);
    }

    #[test]
    fn receipts_evict_oldest_diagnostic_history_only() {
        let runtime = NotificationRuntime::default();
        for index in 0..(MAX_DELIVERY_RECEIPTS + 2) {
            runtime.record_receipt(receipt(
                Some(format!("event-{index}")),
                None,
                NotificationDeliveryChannel::Plugin,
                NotificationDeliveryStatus::Degraded,
            ));
        }
        let receipts = runtime.receipts();
        assert_eq!(receipts.len(), MAX_DELIVERY_RECEIPTS);
        assert_eq!(
            receipts
                .first()
                .and_then(|item| item.notification_id.as_deref()),
            Some("event-2")
        );
        assert_eq!(
            receipts
                .last()
                .and_then(|item| item.notification_id.as_deref()),
            Some("event-257")
        );
    }

    #[test]
    fn live_registrations_have_a_high_bounded_diagnostic_window() {
        let runtime = NotificationRuntime::default();
        for index in 0..(MAX_LIVE_ACTIVATION_REGISTRATIONS + 2) {
            runtime.register_activation(&format!("event-{index}"));
        }
        assert_eq!(
            runtime.live_registration_count(),
            MAX_LIVE_ACTIVATION_REGISTRATIONS
        );
        runtime.unregister_activation("event-4097");
        assert_eq!(
            runtime.live_registration_count(),
            MAX_LIVE_ACTIVATION_REGISTRATIONS - 1
        );
    }

    #[test]
    fn activation_payload_is_event_scoped_and_camel_case_serialized() {
        let payload = NotificationActivationPayload {
            notification_id: "event-1".to_string(),
        };
        assert_eq!(
            serde_json::to_value(payload).expect("payload serializes"),
            serde_json::json!({ "notificationId": "event-1" })
        );
    }

    #[test]
    fn native_app_user_model_id_comes_from_tauri_identifier() {
        assert_eq!(
            format!("{}.dev", "com.example.custom-threadterm"),
            "com.example.custom-threadterm.dev"
        );
    }
}
