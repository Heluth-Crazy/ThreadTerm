# Provider test coverage matrix (G07)

Static inventory of which tests cover which capability and lifecycle case for every provider adapter the
ThreadTerm runtime supports. Built at commit `cd192c0` on 2026-11-01. Nothing here is executed by CI: this file
is documentation, and every reference in it was grepped in the tree at that commit.

**How to update.** When you add an adapter, add a table; when you add a capability, add a row to every adapter
that declares it; when you add a test, put its reference in the matching capability row and lifecycle column, and
remove it from "Top gaps" if the gap is now closed. Add a shared helper assertion to §3 instead of repeating it
in each table.

How to read a table:

- Rows are the capabilities the adapter declares or implements, derived from `ProviderAdapter::capability`,
  `ProviderCapability` (`runtime/src/providers.rs:287`), the `ChatSession` trait (`runtime/src/providers.rs:658`)
  and the adapter's own overrides.
- Columns are the seven lifecycle cases from the production-readiness review: success, failure, timeout, cancel,
  reconnect, duplicate request, late event.
- A cell holds `file::test_name` for Rust and `file:line` for JavaScript; `—` means no test covers that case.
- `fake` = a recorded fixture or a scripted fake CLI/server; `real CLI` = the real provider executable, driven
  without an account guarantee; `live account` = needs a real signed-in account or network (also listed in §15).

## 1. Adapters in scope

| Adapter | Kind | Where it is implemented | Capability source |
| --- | --- | --- | --- |
| Codex | builtin | `runtime/src/providers/codex.rs` | `CodexAdapter::capability` (`codex.rs:445`) |
| Claude Code | builtin + Node SDK sidecar | `runtime/src/providers/claude.rs`, `providers/claude-sdk/src` | `ClaudeAdapter::capability` (`claude.rs:302`) |
| Kimi | builtin ACP (`kimi_native`) | `runtime/src/providers/acp.rs`, `runtime/src/providers/kimi_plan_usage.rs` | `AcpAdapter::capability` (`acp.rs:173`) |
| Grok | builtin ACP-ish JSON-RPC | `runtime/src/providers/grok.rs` | `GrokAdapter::capability` (`grok.rs:172`) |
| OpenCode | builtin HTTP+SSE | `runtime/src/providers/opencode.rs` | `OpenCodeAdapter::capability` (`opencode.rs:46`) |
| Pi | builtin RPC | `runtime/src/providers/pi.rs` | `PiAdapter::capability` (`pi.rs:66`) |
| Gemini | bundled declarative plugin, ACP chat | `runtime/plugins/gemini/threadterm-plugin.json` via `runtime/src/plugins.rs:597` | same `AcpAdapter`, `kimi_native == false` |
| ACP plugin (user) | declarative plugin, ACP chat | `runtime/src/plugins.rs` → `AcpAdapter::from_descriptor` (`providers.rs:1432`) | same `AcpAdapter`, protocol-driven |
| Terminal-only plugin | declarative plugin, no chat | `runtime/src/plugins.rs` (`ManifestTerminalAdapter`) | manifest `terminal` block only |
| Terminal-mode agent detection | side feature, all providers | `runtime/src/terminal_agents.rs` | `SIGNATURES` (`terminal_agents.rs:34`) |

Registries: builtins are listed in `BUILTIN_AGENTS` (`runtime/src/providers.rs:168`) and constructed in
`ProviderRuntime::native` (`providers.rs:1408`); plugins come from `PluginRegistry::bundled`/`discover`
(`runtime/src/plugins.rs:279`). `provider.list` serialises `ProviderCapability`, so the declared field set is
`installed`, `version`, `terminal`, `chat`, `history`, `resume`, `terminalResumeCapture`, `auth`, `reason`,
`source`, `pluginId`, `icon`, `signIn`, `homepage`.

Shorthand used to keep cells short. Both forms resolve to a real path in this repository:

- `name::test_name` is a Rust test: `codex`, `claude`, `acp`, `grok`, `opencode`, `pi`, `kimi_plan_usage`,
  `codex_persistence_tests`, `codex_plan_approval_tests`, `retirement_tests`, `network`, `probes` are files under
  `runtime/src/providers/`; `plugins` is `runtime/src/plugins.rs`; `terminal_agents_tests` is
  `runtime/src/terminal_agents_tests.rs`; `pi_project_trust` is `runtime/src/pi_project_trust.rs`;
  `service/plugin_tests.rs` is `runtime/src/service/plugin_tests.rs`.
- `name.rs:line` is a source reference: `providers.rs` is `runtime/src/providers.rs`, `plugins.rs` is
  `runtime/src/plugins.rs`, `terminal_agents.rs` is `runtime/src/terminal_agents.rs`, and the remaining `*.rs`
  names are under `runtime/src/providers/`. `session.test.mjs`, `nativeFork.test.mjs`, `protocol.test.mjs` and
  `bundle.test.mjs` are under `providers/claude-sdk/test/`.
- `qa/...` and `scripts/...` are repository paths as written.

## 2. Capability vocabulary used below

Derived from the code, not from memory:

| Row label | Where the runtime expresses it |
| --- | --- |
| install/version probe | `ProviderCapability::installed`/`version`; `providers/common.rs` `version_probe` |
| auth check | `ProviderCapability::auth` (`authenticated`/`unauthenticated`/`unknown`) |
| terminal launch | `ProviderAdapter::terminal_command` |
| terminal identity capture | `ProviderAdapter::terminal_capture`/`prepare_terminal`, `TerminalCapture` (`providers.rs:319`) |
| chat connect | `ProviderRuntime::chat_open`, `ChatSession` handshake |
| send + stream | `ChatSession::send`, `ProviderEvent` `chat.delta`/`chat.item`/`chat.turn.*` |
| stop/interrupt | `ChatSession::cancel` (turn contract), `ChatSession::stop` (worker) |
| approvals | `ChatSession::approve` |
| questions | `ChatSession::answer` |
| model/effort/mode options | `ChatSession::set_option`, `ui_state` options |
| slash commands | `ui_state` commands, `validate_send` |
| attachments | `ChatSession::validate_images`/`send_with_images` |
| usage/context | usage + rate-limit/context `ProviderEvent` kinds |
| history + resume | `ProviderAdapter::history_list`/`history_read`, `ProviderRuntime::history_*` |
| fork | `ProviderAdapter::fork_session` |
| steer | `ChatSession::validate_steer`/`steer` |
| subagents | subagent transcript/lifecycle projection, `ProviderAdapter::subagent_transcript` |
| background tasks | `ChatSession::background_tasks`/`stop_background_task` |
| plan approval | `ChatSession::plan_response`/`plan_response_receipt` |
| tool server / MCP | `ProviderAdapter::open_chat_with_tools`, delegation and browser tools |

## 3. Shared coverage (do not repeat in the tables)

These helpers and harnesses cover every adapter that opts in. A table cites `see §3` for them.

| Shared asset | What it covers | Used by |
| --- | --- | --- |
| `runtime/src/providers/conformance.rs::assert_stop_of_finished_turn_succeeds` and `assert_stop_refuses_a_turn_that_is_not_live` | the one Stop contract (finished turn = no-op success, other turn while live = `turn_not_active`) | ACP/Kimi, Claude, Codex, Grok, OpenCode, Pi cancel tests |
| `runtime/src/providers/conformance.rs::assert_exactly_once` | one reply per outbound JSON-RPC id — duplicate-request case | ACP, Codex, Grok |
| `runtime/src/providers/conformance.rs::assert_no_parent_effect` + `fixture` | child/foreign frames never reach the parent transcript (late-event case) | ACP, Claude, Codex, Grok |
| `runtime/src/providers/conformance.rs::stop_recording_process` + `recorded_frames` | what a cancel actually put on the wire | ACP, Codex, Grok |
| `qa/provider-chat-smoke.mjs:145` | every chat provider with a CLI: connect, send + completion, cancel, native id, duplicate native owner (active and inactive), history list + read, resume + idempotent resume | Codex, Claude, Kimi, Grok, OpenCode, Pi (`live account`/`real CLI`) |
| `qa/provider-environment.mjs:70` | provider detection/version/env for `claude, codex, kimi, grok, opencode, gemini` | all builtins + Gemini |
| `qa/provider-refresh-real.mjs:97` | capability refresh for `codex, claude, kimi, opencode, grok, pi` | all builtins |
| `qa/provider-probes.mjs:16` | `provider.list` probe shape for `codex, claude, kimi, gemini, opencode` | all but Pi |
| `qa/permission-modes-live.mjs:19` | permission-mode scenarios for `codex, claude, kimi, grok` | those four |
| `qa/agent-terminal-resume.mjs` | terminal resume round trip through the shared terminal path | every adapter with `terminalResumeCapture == preassigned` |
| `runtime/src/providers/common.rs` tests (`history_page_omits_an_absent_cursor`, `approval_ids_round_trip_json_rpc_ids`, `missing_context_replies_are_bounded_and_expire_without_polling`, `successful_context_reply_retires_expiry_and_calls_back_once`, `terminating_a_retained_transport_ends_its_native_process_before_drop`) | shared JSON-RPC/envelope helpers: history paging, approval id mapping, context-reply expiry (timeout), transport teardown | every JSON-RPC adapter |
| `runtime/src/providers/retirement_tests.rs::stop_and_reconnect_persist_held_plan_before_invalidating_the_old_token`, `failed_retirement_persistence_leaves_the_original_worker_and_token_available_for_retry` | worker retirement on stop/reconnect | plan-capable adapters |
| `runtime/src/providers/network.rs` tests | per-provider proxy/alias settings | Grok (only adapter with a network setting today) |
| `runtime/src/providers/probes.rs::cache_key_changes_with_executable_or_version` | capability-probe cache invalidation on CLI upgrade | all builtins |
| `providers::cold_ui_reads_are_pending_and_share_one_probe_with_confirmed_admission`, `providers::forced_refresh_keeps_values_then_publishes_new_ones_once`, `providers::failed_cold_probe_never_retries_until_an_explicit_refresh`, `providers::spawn_failure_publishes_failed_and_clears_refreshing` | the shared install/version capability probe and its cache: cold, refresh, failure, timeout-with-pending (§3 covers the "install/version probe" row for every adapter unless the table names an adapter-specific test) | all adapters and plugins |
| `runtime/src/service/plugin_tests.rs:137`/`:212` | `provider.list` for plugins: pending, enabled, disabled, reload | Gemini + ACP plugins |

## 4. Codex (`runtime/src/providers/codex.rs`)

Declared: terminal, chat, history, resume, `terminalResumeCapture: preassigned`; auth via `codex login status`.

| Capability | Success | Failure | Timeout | Cancel | Reconnect | Duplicate request | Late event |
| --- | --- | --- | --- | --- | --- | --- | --- |
| install/version probe | `codex_persistence_tests::cli_version_comes_from_the_initialize_user_agent` | `codex::failed_version_probe_keeps_its_specific_error` | — | — | — | — | — |
| auth check | `codex::status_report_keeps_native_metadata_context_and_dynamic_limits` | `codex::status_report_warns_when_auth_is_required_without_account`, `codex::status_report_does_not_treat_loading_account_as_auth_failure` | — | — | — | — | — |
| terminal launch | `qa/agent-terminal-resume.mjs:94` (shared, §13) | — | — | — | — | — | `codex::terminal_output_never_becomes_codex_identity_evidence` |
| terminal identity capture | `codex::precreated_thread_id_launches_codex_resume_without_output_parsing`, `codex_persistence_tests::terminal_and_chat_use_the_same_verified_materialization_sequence` | `codex_persistence_tests::new_chat_verification_failure_never_emits_ready` | — | — | — | — | — |
| chat connect | `codex_persistence_tests::new_chat_materializes_and_verifies_in_a_separate_process_without_a_turn` | `codex_persistence_tests::chat_connects_and_chats_when_the_cli_lacks_inject_items` (older CLI degrades) | — | — | `codex_persistence_tests::existing_chat_thread_resumes_without_materializing_again` | — | `codex::an_untracked_terminal_event_fences_stale_lists_and_late_starts` |
| send + stream | `codex::transcript_preserves_native_turn_boundary_status_duration_error_and_reasoning`, `qa/codex-chat-adapt.mjs:73` | `codex::child_completed_messages_replace_parts_and_errors_stay_in_transcript` | — | — | — | — | `codex::foreign_threads_require_subagent_evidence_and_ignore_child_ui_and_deltas` |
| stop/interrupt | `codex::an_ended_codex_turn_is_an_idempotent_success_and_a_newer_turn_is_never_interrupted` (+ §3 stop contract) | — | — | `codex::an_ended_codex_turn_is_an_idempotent_success_and_a_newer_turn_is_never_interrupted` (wire frames), `retirement_tests::stop_and_reconnect_persist_held_plan_before_invalidating_the_old_token` | `retirement_tests::failed_retirement_persistence_leaves_the_original_worker_and_token_available_for_retry`, `qa/codex-reconnect-fixture.test.mjs:26` | — | — |
| approvals | `codex::file_approval_attaches_only_the_matching_started_changes`, `codex::child_approval_retains_parent_binding_and_native_reply` | `codex::oversized_file_approval_carries_an_explicit_preview_unavailable_reason`, `codex::file_approval_after_preview_cache_limit_explains_the_missing_preview` | — | — | — | `codex::codex_auto_approval_uses_only_exact_enabled_threadterm_tools`, `codex::codex_browser_auto_approval_requires_exact_managed_read_capability` (auto-approve exactly once) | — |
| questions | `codex::only_threadterm_form_elicitations_are_accepted_automatically`, `qa/question-codex.integration.mjs:34` | — | — | — | — | — | `codex::native_resolution_does_not_expire_a_submitting_question` |
| model/effort/mode options | `codex::options_come_from_catalog_and_thread`, `codex::switching_model_keeps_supported_effort`, `codex::native_effort_updates_replace_the_start_response_alias`, `codex::settings_params_use_codex_field_names` | `codex::ignored_settings_are_not_confirmation_and_errors_do_not_trigger_fallback`, `codex::unknown_model_omits_thinking_choices` | — | — | — | — | `codex::arbitrary_current_hidden_model_remains_selectable_without_pinned_ids`, `codex::hidden_test_model_stays_selectable` |
| permission mode | `codex::codex_startup_permissions_accept_only_mode_and_sandbox`, `codex::startup_permissions_are_sent_in_the_resume_frame`, `codex::permissions_use_native_fields_and_collaboration_stays_separate` | `codex::ignored_settings_are_not_confirmation_and_errors_do_not_trigger_fallback` | — | — | — | — | — |
| slash commands | `codex::slash_commands_include_builtins_and_skills`, `qa/codex-slash-lifecycle.mjs:65` | `codex::every_advertised_command_is_blocked_from_plain_model_input`, `codex::status_item_marks_requested_command_without_dropping_report_data` | — | — | — | — | — |
| attachments | `codex::native_images_keep_data_urls_as_native_image_items` | — | — | — | — | — | — |
| usage/context | `codex::context_usage_maps_codex_token_breakdown_and_window`, `codex::context_percent_uses_codex_reserved_baseline`, `codex::cumulative_usage_prefix_keys_distinguish_tool_only_calls_and_stay_stable` | `codex::rate_limit_load_state_distinguishes_pending_empty_and_error` | — | — | `codex::resumed_context_usage_survives_startup_discovery` | — | `codex::sparse_rate_limit_updates_merge_without_erasing_buckets`, `codex::emitted_codex_usage_accumulates_two_no_total_assistant_calls` |
| history + resume | `codex::history_listing_does_not_filter_out_runtime_started_threads`, `codex::history_item_keeps_native_identity`, `qa/codex-history-resume-smoke.mjs:58` | `codex_persistence_tests::missing_chat_native_thread_is_reported_without_adapter_replacement`, `codex_persistence_tests::missing_thread_classification_requires_an_exact_native_read_failure` | — | — | — | `codex::history_response_requires_the_requested_thread_and_explicit_turns_array` | `codex::native_list_preserves_finished_rows_and_loses_to_newer_events` |
| fork | `codex::native_fork_request_uses_the_inclusive_native_turn_boundary`, `codex::native_fork_uses_an_isolated_app_server_and_never_mutates_the_source_thread` | — | — | — | — | `codex::fork_from_the_first_reply_keeps_only_that_turn_without_a_duplicate_assistant` | — |
| steer | `codex::steer_sends_the_native_turn_once_and_a_mismatch_does_not_clear_it` | `codex::steer_sends_the_native_turn_once_and_a_mismatch_does_not_clear_it` (mismatch) | — | — | — | `codex::steer_sends_the_native_turn_once_and_a_mismatch_does_not_clear_it` (once) | — |
| subagents | `codex::parent_subagent_activity_maps_lifecycle_and_interactions`, `codex::collab_agent_tool_call_maps_receivers_states_and_spawn_details` | `codex::child_completion_statuses_do_not_settle_parent_turn` | — | — | — | `codex::conformance_child_request_writes_one_native_response` | `codex::conformance_child_thread_fixture_keeps_parent_items_and_terminal_signal_scoped`, `codex::foreign_threads_require_subagent_evidence_and_ignore_child_ui_and_deltas` |
| background tasks | `codex::foreground_commands_never_enter_the_background_strip`, `codex::native_background_rows_require_the_exact_schema_identity` | `codex::malformed_event_identities_do_not_promote_background_tasks`, `codex::native_background_pages_require_complete_acyclic_schema` | — | — | — | — | `codex::outstanding_command_survives_parent_end_and_settles_from_its_native_item` |
| plan approval | `codex_plan_approval_tests::approve_sends_the_exact_prompt_once_and_cancel_stop_clear_stale_plan_state`, `codex_plan_approval_tests::synthetic_plan_card_requires_a_completed_authoritative_item_in_plan_mode` | `codex_plan_approval_tests::synthetic_plan_card_supports_empty_plan_once_and_ignores_noncompleted_or_default_turns` | — | `codex_plan_approval_tests::approve_sends_the_exact_prompt_once_and_cancel_stop_clear_stale_plan_state` | — | `codex_plan_approval_tests::held_plan_item_falls_back_to_transcript_text_when_no_card_owns_it` | `codex_plan_approval_tests::retirement_barrier_rejects_a_late_plan_when_no_candidate_was_held` |
| tool server / MCP | `codex::delegation_tool_server_becomes_per_process_config_overrides`, `codex::codex_preapproves_delegation_tools_only_for_a_token_bearing_parent` | `codex::codex_preapproves_run_tools_only_when_the_run_switch_is_on` | — | — | — | — | — |
| older-CLI degradation | `codex_persistence_tests::a_missing_feature_notice_is_written_once_and_names_the_cli` | `codex_persistence_tests::limitation_notices_explain_each_loss_without_protocol_names`, `codex_persistence_tests::unsupported_codex_actions_keep_protocol_names_in_diagnostics_only` | — | — | — | `codex_persistence_tests::a_missing_method_is_recorded_once_for_every_chat` | — |

Untested for Codex: no cancel-timeout case (an interrupt that is never acknowledged), no reconnect while a turn is
live, and no late-event case for the usage/context reads beyond the rate-limit merges above.

## 5. Claude Code (`runtime/src/providers/claude.rs`, `providers/claude-sdk`)

Declared: terminal, chat, history, resume, `terminalResumeCapture: preassigned`; `chat` requires the Node sidecar
to start and `claude auth status` to be signed in. Images are not supported (`claude.rs:652` rejects them) and
steering is native (`ui_state.inputCapabilities.steer == "native"`, `claude.rs:99`).

The sidecar has its own suite (`providers/claude-sdk/test/*.test.mjs`), which is where protocol-level behaviour
lives; the Rust adapter tests cover mapping and projection.

| Capability | Success | Failure | Timeout | Cancel | Reconnect | Duplicate request | Late event |
| --- | --- | --- | --- | --- | --- | --- | --- |
| install/version probe | `claude::auth_status_and_version_note_parsing` | `claude::auth_status_and_version_note_parsing` (old CLI note) | — | — | — | — | — |
| auth check | `claude::auth_status_and_version_note_parsing` | `claude::auth_status_and_version_note_parsing` (signed out) | — | — | — | — | — |
| terminal launch | `qa/claude-terminal-launch.mjs:66`, `qa/agent-terminal-resume.mjs:94` (shared, §13) | — | — | — | — | — | — |
| terminal identity capture | `qa/claude-empty-resume.mjs:53` | `qa/claude-empty-resume.mjs:57` (resume of a still-empty native id is refused) | — | — | — | — | — |
| chat connect | `claude::sidecar_handshake_gates_open_and_internal_death_ends_liveness`, `providers/claude-sdk/test/session.test.mjs:170` | `providers/claude-sdk/test/session.test.mjs:181`, `claude::host_fatal_ends_liveness_with_the_original_worker_token` | `providers/claude-sdk/test/session.test.mjs:188` | `providers/claude-sdk/test/session.test.mjs:195` | — | — | `providers/claude-sdk/test/session.test.mjs:207`, `claude::closed_and_error_phases_mark_the_worker_ended` |
| send + stream | `claude::a_later_text_block_in_the_turn_starts_a_new_paragraph`, `claude::streamed_claude_reply_final_snapshot_updates_only_the_fork_anchor`, `qa/claude-chat-live.mjs:76` | `claude::sdk_tool_use_and_failed_result_keep_native_id_without_duplicate_text` | — | — | — | — | `claude::child_stream_deltas_never_become_parent_deltas` |
| stop/interrupt | `claude::cancel_carries_the_turn_and_refuses_a_stale_one` (+ §3 stop contract) | — | — | `claude::cancel_carries_the_turn_and_refuses_a_stale_one`, `providers/claude-sdk/test/session.test.mjs:125` | — | — | `providers/claude-sdk/test/session.test.mjs:144` (late cancel emits nothing) |
| approvals | `claude::approval_card_and_ui_updates_carry_claude_choices_and_state`, `providers/claude-sdk/test/session.test.mjs:57` | `claude::approval_offers_always_only_for_sdk_suggestions_and_names_their_scope` | — | `providers/claude-sdk/test/session.test.mjs:73` (pre-cancelled request) | — | `providers/claude-sdk/test/session.test.mjs:144` | `providers/claude-sdk/test/session.test.mjs:264` (callback after stop) |
| questions | `claude::ask_user_question_maps_questions_and_keeps_the_subagent_label`, `providers/claude-sdk/test/session.test.mjs:97` | `providers/claude-sdk/test/session.test.mjs:114` (dismissal) | — | — | — | — | — |
| model/effort/mode options | `claude::claude_startup_permission_mode_accepts_only_restorable_modes`, `qa/claude-chat-options-visual.mjs:68` | `claude::request_cancelled_maps_to_a_targeted_expired_resolution` | — | — | — | — | — |
| slash commands | `claude::local_command_output_is_shown_once_and_streamed_answers_are_not_repeated` | `claude::chat_rejects_commands_that_would_break_the_session_or_open_a_browser` | — | — | — | — | — |
| usage/context | `providers/claude-sdk/test/session.test.mjs:273`, `claude::per_message_speed_usage_uses_the_native_stream_message_id` | `providers/claude-sdk/test/session.test.mjs:333` | — | — | — | — | `providers/claude-sdk/test/session.test.mjs:299`, `providers/claude-sdk/test/session.test.mjs:320`, `claude::emitted_claude_usage_replaces_a_message_and_accumulates_calls` |
| history + resume | `claude::keeps_claude_session_id`, `claude::claude_history_derives_plan_parts`, `qa/provider-chat-smoke.mjs:145` | `claude::mismatched_native_identity_cannot_replace_a_resumed_binding` | — | — | — | — | `claude::claude_history_does_not_infer_completion_without_a_terminal_stop_reason` |
| fork | `claude::claude_fork_request_uses_the_uuid_boundary_and_omits_it_for_full_history`, `providers/claude-sdk/test/nativeFork.test.mjs:5` | `providers/claude-sdk/test/nativeFork.test.mjs:13` | — | — | — | — | — |
| steer | `claude::steer_forwards_the_target_turn_and_maps_turn_changed`, `providers/claude-sdk/test/session.test.mjs:664` | `providers/claude-sdk/test/session.test.mjs:687` (replaced turn) | — | — | — | `providers/claude-sdk/test/session.test.mjs:974` (batched steer folds once) | `providers/claude-sdk/test/session.test.mjs:769` (leftover steer) |
| subagents | `claude::parent_agent_and_task_spawns_and_results_are_cards_not_tools`, `claude::history_agent_and_task_spawns_have_static_subagent_parts` | `claude::subagent_permissions_resolve_known_task_and_label_unknown_agent` | — | — | — | — | `claude::task_events_before_agent_blocks_wait_for_root_binding`, `claude::child_snapshots_replace_text_and_merge_native_tool_parts` |
| background tasks | `providers/claude-sdk/test/session.test.mjs:342`, `providers/claude-sdk/test/session.test.mjs:384` | `providers/claude-sdk/test/session.test.mjs:422` | — | `providers/claude-sdk/test/session.test.mjs:406` | — | — | `providers/claude-sdk/test/session.test.mjs:393` |
| plan approval (ExitPlanMode) | `providers/claude-sdk/test/session.test.mjs:515`, `claude::exit_plan_mode_maps_plan_and_tracks_its_bound_turn` | `claude::exit_plan_mode_partial_success_is_terminal_and_recoverable`, `providers/claude-sdk/test/session.test.mjs:553` | — | `providers/claude-sdk/test/session.test.mjs:573` (feedback/abandon) | — | `providers/claude-sdk/test/session.test.mjs:591` (one pending approval) | — |
| tool server / MCP | `providers/claude-sdk/test/session.test.mjs:435`, `providers/claude-sdk/test/session.test.mjs:452` | `providers/claude-sdk/test/session.test.mjs:484` | — | — | — | — | — |

Untested for Claude: no Rust-side timeout case (the sidecar test at `session.test.mjs:188` covers the handshake
only), no adapter-level reconnect test, and images are excluded by design (§14).

## 6. Kimi (`runtime/src/providers/acp.rs` kimi-native path, `runtime/src/providers/kimi_plan_usage.rs`)

Declared via ACP `initialize`: `chat` true once the CLI answers, `history` = `session/list` + `session/load`,
`resume` = `load` or `resume`, `terminal` from the builtin descriptor, `terminalResumeCapture: preassigned`
(`acp.rs:238`), `auth` permanently `unknown` (`acp.rs:206`). Kimi adds native extras on top of generic ACP: an
`AskUserQuestion` bridge, native plan options, its own session reader, and the plan/usage panel.

| Capability | Success | Failure | Timeout | Cancel | Reconnect | Duplicate request | Late event |
| --- | --- | --- | --- | --- | --- | --- | --- |
| install/version probe | `qa/provider-environment.mjs:70` | `acp::failed_version_probe_keeps_its_specific_error` | — | — | — | — | — |
| terminal launch | `acp::kimi_terminal_cwd_preserves_non_verbatim_paths`, `qa/kimi-terminal-cwd.mjs:104` | `acp::kimi_terminal_cwd_uses_cli_windows_spelling_only_on_windows` | — | — | — | — | — |
| terminal identity capture | `acp::kimi_terminal_assignment_uses_its_preassigned_session_flag`, `acp::kimi_prepares_identity_through_acp_while_gemini_remains_unverified` | — | — | — | — | — | — |
| chat connect | `acp::acp_conformance_terminal_and_kimi_wire`, `qa/acp-settings.integration.mjs:76` | `acp::kimi_already_active_exception_is_exact`, `acp::normalizes_session_identity` | — | — | `qa/cold-provider-startup.mjs:141` (fake Kimi cold start) | — | — |
| send + stream | `acp::kimi_redacted_wire_maps_prompt_thinking_tools_output_and_error`, `acp::transcript_merges_chunked_thinking_and_text_reply`, `acp::splits_kimi_think_tags_across_chunks` | `acp::kimi_wire_caps_items_bounds_strings_and_merges_failed_tool_results` | — | — | — | — | `acp::foreign_acp_updates_do_not_project_or_mutate_parent_state` |
| stop/interrupt | `acp::an_ended_acp_turn_is_an_idempotent_success_and_a_newer_turn_is_never_cancelled` (+ §3 stop contract, `session/cancel` frames) | — | — | `acp::an_ended_acp_turn_is_an_idempotent_success_and_a_newer_turn_is_never_cancelled` | — | — | `acp::kimi_usage_cancellation_suppresses_late_results_and_preserves_new_turn` |
| approvals (ACP `session/request_permission`) | `acp::acp_conformance_foreign_frames_and_reverse_requests` | — | — | `acp::acp_conformance_foreign_frames_and_reverse_requests` (late permission answered once) | — | `acp::acp_conformance_foreign_frames_and_reverse_requests` (exactly once) | `acp::acp_subagent_permissions_label_only_unmatched_calls_while_agents_run` |
| questions (`AskUserQuestion` bridge) | `acp::kimi_ask_user_question_bridge_is_a_question_only_for_kimi`, `qa/kimi-live.mjs:455` | — | — | — | — | — | — |
| config options (model/thinking/mode) | `acp::parses_kimi_config_options_and_slash_commands`, `acp::option_listing_marks_current_value_and_choices`, `acp::a_successful_set_adopts_the_agent_confirmed_value` | `acp::a_rejected_non_model_setting_never_falls_back_to_set_model`, `acp::model_fallback_is_limited_to_method_not_found`, `acp::startup_mode_restore_uses_config_option_and_rejects_a_mismatch` | — | — | — | — | `acp::config_notification_wins_over_an_older_setting_response`, `acp::modern_acp_mode_keeps_config_route_and_accepts_mode_notifications` |
| slash commands | `acp::parses_slash_command_name_and_args`, `acp::local_commands_merge_into_the_menu_once` | `acp::guidance_covers_every_documented_tui_only_command` | — | — | — | — | — |
| usage/context | `acp::kimi_usage_buffers_native_statistics_and_emits_one_complete_reply`, `acp::acp_usage_update_emits_a_context_snapshot`, `kimi_plan_usage::window_normalization_only_collapses_whole_hours` | `acp::kimi_usage_failure_retains_context_and_finishes`, `acp::kimi_usage_native_error_releases_turn_without_a_late_card` | `kimi_plan_usage::cached_usage_and_failures_are_account_scoped_and_expire` | `kimi_plan_usage::plan_usage_timing_probe` | — | — | `acp::usage_notifications_keep_the_originating_worker_token` |
| history + resume | `acp::kimi_native_reader_finds_session_bounds_tail_and_rejects_path_ids`, `acp::history_item_never_serializes_optional_nulls`, `acp::repair_fixture_normalizes_kimi_and_generic_acp_history`, `qa/kimi-live.mjs:326` | `acp::browser_privacy_kimi_wire_history_removes_result_and_retains_failure` | — | — | — | — | — |
| fork | `acp::acp_native_fork_loads_the_source_then_returns_the_child_without_touching_it` | `acp::recognizes_nested_session_capabilities` (capability gate) | — | — | — | — | — |
| note steering (not native) | `acp::a_granted_feedback_tool_offers_a_note_not_native_steering` | — | — | — | — | — | — |
| subagents | `acp::subagent_live_and_history_replace_tools_through_completion`, `acp::kimi_agent_first_frame_with_partial_input_is_a_card`, `acp::subagent_result_headers_map_status_identity_and_summary` | `acp::subagent_detection_is_provider_scoped_and_remembers_sparse_updates` | — | — | — | — | `acp::acp_late_subagent_detection_retracts_the_projected_parent_tool` |
| plan | `acp::kimi_plan_card_answers_with_the_native_plan_options`, `acp::only_kimis_plain_plan_review_becomes_a_plan`, `acp::plan_updates_project_one_upserted_plan_part` | `acp::acp_plan_mapper_distinguishes_empty_snapshots_from_malformed_entries` | — | — | — | `acp::acp_history_keeps_one_plan_per_user_turn` | `acp::acp_history_derives_a_plan_part_and_keeps_the_latest` |
| tool server / MCP | `acp::kimi_and_gemini_tool_updates_keep_native_identity_and_file_candidates` | `acp::acp_rejects_a_threadterm_tool_name_from_a_foreign_namespace` | — | — | — | — | `acp::browser_privacy_acp_nameless_completion_and_history_redact_before_fanout` |

Kimi gaps: no timeout case for a prompt that never answers, no reconnect-while-live case (the cold-start probe is
an app-start case only), and no test of a rejected or cancelled `AskUserQuestion`.

## 7. Grok (`runtime/src/providers/grok.rs`)

Declared: terminal, chat, history, resume from `session/list` + `session/load` (`grok.rs:172`),
`terminalResumeCapture: preassigned`, `auth` from the CLI's own state. Native extras: plan cards, billing/usage,
background tasks, a per-provider proxy setting (`runtime/src/providers/network.rs`), and note-only steering.

| Capability | Success | Failure | Timeout | Cancel | Reconnect | Duplicate request | Late event |
| --- | --- | --- | --- | --- | --- | --- | --- |
| install/version probe | `qa/provider-environment.mjs:70` | — | — | — | — | — | — |
| terminal launch / identity | `grok::preassigned_identity_does_not_parse_exit_output` | — | — | — | — | — | — |
| chat connect | `qa/grok-chat-smoke.mjs:82` | `grok::grok_session_update_rejects_foreign_and_accepts_matching_or_missing_session_id` | — | — | — | — | `grok::grok_foreign_frames_never_reach_parent_and_buffer_drops_oldest` |
| send + stream | `grok::streams_thought_and_message_chunks`, `grok::grok_history_merges_native_tool_updates_and_failed_paths` | `grok::grok_nameless_completion_keeps_first_tool_name_and_meta` | — | — | — | — | `grok::grok_child_tool_updates_keep_first_identity`, `grok::grok_tool_identity_cache_resets_on_new_turn` |
| stop/interrupt | `grok::an_ended_grok_turn_is_an_idempotent_success_and_a_newer_turn_is_never_cancelled` (+ §3 stop contract, `session/cancel` frames) | — | — | `grok::an_ended_grok_turn_is_an_idempotent_success_and_a_newer_turn_is_never_cancelled` | — | — | — |
| approvals | `grok::reverse_rpc_rejects_unknown_client_methods_but_keeps_permissions`, `grok::grok_child_permission_approve_writes_selected_rpc_response`, `grok::grok_preapproval_args_are_exact_and_precede_agent` | — | — | — | — | `grok::grok_conformance_reverse_request_lifecycle` (one reply per id) | `grok::grok_late_child_question_is_not_published_or_left_pending` |
| questions | `grok::grok_question_fixture_maps_single_and_multi_with_exact_responses`, `grok::grok_question_fixture_preserves_tool_identity_live_and_history`, `qa/question-grok-live.mjs:28` | — | — | — | — | — | `grok::grok_late_child_question_is_not_published_or_left_pending` |
| model/thinking/mode options | `grok::maps_grok_config_options_to_model_and_thinking`, `grok::models_update_refreshes_thinking_choices`, `grok::a_native_mode_change_moves_the_mode_chip` | `grok::grok_empty_set_mode_result_is_an_ack_but_explicit_state_wins`, `grok::startup_mode_update_never_marks_a_permission_change_confirmed` | — | — | — | — | `grok::grok_empty_set_mode_result_is_an_ack_but_explicit_state_wins` |
| permission mode | `grok::grok_startup_restore_errors_keep_structured_permission_metadata`, `qa/permission-modes-live.mjs:19` | `grok::startup_mode_update_never_marks_a_permission_change_confirmed` | — | — | — | — | — |
| slash commands | `grok::grok_command_catalog_filters_unimplemented_native_commands`, `qa/grok-commands.integration.mjs:97` | `grok::grok_command_catalog_filters_unimplemented_native_commands` | — | — | — | — | — |
| note steering (not native) | `grok::a_granted_feedback_tool_offers_a_note_not_native_steering` | — | — | — | — | — | — |
| usage/context | `grok::native_usage_preserves_units_and_absent_metrics`, `grok::the_prompt_result_gives_the_turn_total_and_the_context_occupancy`, `grok::billing_card_uses_native_plan_percent_and_reset_time` | `grok::usage_partial_failure_and_timeout_never_fabricate_account_limits` | `grok::usage_partial_failure_and_timeout_never_fabricate_account_limits`, `grok::usage_completion_and_cancellation_release_timeout_workers_immediately` | `grok::usage_completion_and_cancellation_release_timeout_workers_immediately` | `grok::resumed_usage_matches_cli_no_calls_state_and_keeps_account_limits` | `grok::session_usage_rpc_shape_populates_context_snapshot` | `grok::cancelled_usage_discards_late_card_without_touching_newer_turn`, `grok::usage_notifications_keep_the_originating_worker_token` |
| history + resume | `grok::history_item_uses_session_id`, `grok::repair_fixture_normalizes_grok_load_history`, `qa/provider-chat-smoke.mjs:145` | — | — | — | `grok::resumed_usage_matches_cli_no_calls_state_and_keeps_account_limits` | — | — |
| subagents | `grok::grok_subagent_history_replaces_spawn_tool_with_static_card`, `grok::grok_subagent_finished_maps_terminal_and_unknown_statuses`, `grok::grok_subagent_probe_replay_keeps_parent_turn_and_projects_child_transcript` | `grok::grok_subagent_buffers_probe_child_frames_until_binding`, `grok::grok_subagent_tool_status_filter_strips_bytes_and_preserves_input` | — | — | — | `grok::grok_subagent_binding_matches_description_then_spawn_order` | `grok::grok_conformance_child_and_foreign_frames_keep_parent_scope`, `grok::grok_subagent_chunks_flush_as_full_items_at_each_boundary` |
| background tasks | `grok::grok_background_spawn_waits_for_finished_and_keeps_original_turn`, `grok::grok_background_subagent_replay_starts_and_completes_its_own_parent_turn` | — | — | — | — | — | `grok::background_tasks_retire_terminal_calls_at_the_next_turn` |
| plan | `grok::exit_plan_mode_becomes_a_plan_card_with_the_native_replies`, `grok::grok_plan_update_maps_acp_entries` | — | — | `grok::grok_history_projects_and_upserts_plan_frames_per_user_turn` | — | — | `grok::grok_history_projects_and_upserts_plan_frames_per_user_turn` |
| network/proxy | `network::grok_alias_is_child_scoped_and_preserves_bypass`, `qa/grok-network.integration.mjs:78` | `network::invalid_saved_proxy_is_rejected_without_echoing_its_value` | — | — | — | `network::updates_are_shared_but_bad_updates_do_not_replace_valid_settings` | — |

Grok gaps: no fork (see §14), no timeout for a turn whose prompt never returns, and no reconnect-while-live case.

## 8. OpenCode (`runtime/src/providers/opencode.rs`)

Declared: terminal, chat, history, resume, `terminalResumeCapture: preassigned`; auth from `opencode auth list`
("0 credentials" ⇒ `unauthenticated`). Native extras: native fork, images, plan (todo) cards, compaction
commands, and tasks/subagents over one SSE stream. It has no steering and no background-task capability.
Two dialects behind one Chat contract: 1.18.35 (floor) and 2.2.5 (`/api/*`, verified 2026-11-09, see
`docs/provider-compat.md`). 2.2.5 reports a denied tool as `session.execution.interrupted {reason:"shutdown"}`
while its server keeps answering: the adapter proves liveness (`/api/info`, live stream) before it settles the
turn as `interrupted` and keeps the Chat connected, and only a gone server or stream fences it. A 2.2.5 child
session id comes from the subagent tool's own `<subagent sessionID="...">` output marker (older builds send
`state.metadata.sessionID`); either is a claim, and ownership still requires the verified native parent link.

| Capability | Success | Failure | Timeout | Cancel | Reconnect | Duplicate request | Late event |
| --- | --- | --- | --- | --- | --- | --- | --- |
| install/version probe | `qa/opencode-heartbeat.probe.mjs:33` | `opencode::typed_errors_are_readable_and_categorized_without_raw_response_bodies` | — | — | — | — | — |
| terminal launch / identity | `opencode::terminal_identity_is_prepared_through_native_session_api` | — | — | — | — | — | — |
| chat connect | `qa/opencode-chat.integration.mjs:90`, `qa/opencode-options-persistence.integration.mjs:56` | `opencode::catalogue_failure_is_visible_without_breaking_the_other_controls` | — | — | `opencode::prompt_http_success_after_stream_loss_stays_disconnected` | — | `opencode::prompt_http_acceptance_keeps_active_and_never_reopens_an_early_idle` |
| send + stream | `opencode::text_tool_reasoning_and_later_text_keep_native_part_order`, `opencode::deltas_then_full_snapshot_update_one_part_without_duplicates`, `opencode::two_distinct_messages_and_two_parts_of_one_message_all_survive` | `opencode::prompt_http_rejection_clears_only_its_turn_and_retains_the_stream` | `opencode::sse_header_timeout_settles_failed_without_runtime_retry` | — | `opencode::sse_watchdog_requires_complete_native_frames_and_three_missed_heartbeats`, `qa/opencode-reconnect-ordering.test.mjs:1` | — | `opencode::foreign_and_stopped_events_cannot_project_or_settle_this_turn`, `opencode::delayed_native_snapshot_cannot_publish_after_watchdog_expiry` |
| stop/interrupt | `opencode::an_ended_opencode_turn_succeeds_without_an_abort_and_a_newer_turn_is_never_aborted`, `opencode::confirmed_abort_classifies_early_idle_as_interrupted_once` (+ §3 stop contract) | `opencode::uncertain_abort_keeps_unknown_outcome_and_never_claims_completion`, `opencode::error_projection_and_authoritative_aborted_outcome_are_distinct` | — | `opencode::confirmed_abort_reserves_the_slot_until_native_idle`, `opencode::sse_expiry_and_explicit_stop_are_single_terminal_transitions` | — | `opencode::status_idle_clears_retry_but_does_not_duplicate_the_native_idle_boundary` | — |
| approvals | `opencode::permission_replied_resolves_only_the_matching_card`, `opencode::permission_replies_distinguish_rejection_cancellation_and_unknown`, `opencode::an_aborted_step_shutdown_settles_the_turn_while_the_owned_server_answers` | `opencode::prompt_http_uncertain_results_expire_permissions_and_stream_exactly_once`, `opencode::a_real_native_shutdown_still_closes_the_chat` | `opencode::child_permissions_expire_and_late_updates_do_not_reopen_them` | — | — | `opencode::conformance_opencode_child_permission_and_question_settlements_are_exactly_once` | `opencode::replied_permission_cannot_be_reopened_by_late_update` |
| questions | `opencode::questions_map_root_and_buffered_child_with_native_resolution`, `qa/question-opencode.integration.mjs:42` | — | — | — | — | `opencode::repeated_ask_keeps_original_turn_identity` | — |
| model/agent/variant options | `opencode::options_validate_locally_and_change_only_subsequent_prompt_overrides`, `opencode::catalogue_options_preserve_structured_ids_and_filter_unavailable_choices` | `opencode::catalogue_failure_is_visible_without_breaking_the_other_controls`, `opencode::oc2_optional_command_failure_preserves_selected_model_agent_and_variant` | — | — | `opencode::oc2_recovery_endpoint_failures_are_independent_and_do_not_clear_options_or_plans` | — | `opencode::next_turn_selection_never_invents_the_effective_footer_model` |
| slash commands | `opencode::oc2_native_catalogue_dispatches_only_exact_names_with_options_and_files` | `opencode::oc2_compact_rejection_unknown_and_stop_never_claim_success`, `opencode::oc2_compact_uses_current_model_and_rejects_arguments_before_dispatch` | — | — | — | `opencode::oc2_compact_confirmation_and_idle_in_either_order_emit_one_receipt_and_no_summary` | — |
| attachments | `opencode::oc2_image_capability_is_selected_model_only_and_file_parts_are_validated` | `opencode::oc2_image_capability_is_selected_model_only_and_file_parts_are_validated` (invalid part) | — | — | — | — | — |
| usage/context | `opencode::assistant_message_usage_emits_distinct_exact_speed_calls_before_context`, `opencode::established_message_updated_event_emits_context_usage` | — | — | — | — | — | `opencode::native_timestamp_cache_switches_to_authoritative_snapshots_at_the_message_bound` |
| history + resume | `opencode::filters_history_by_cwd`, `opencode::history_hides_children_but_accepts_null_or_absent_parent`, `opencode::oc2_history_reuses_live_normalizer_and_keeps_native_time_and_anchor`, `opencode::repair_fixture_normalizes_opencode_export` | — | — | — | `opencode::oc2_recovery_uses_live_identity_and_deduplicates_pending_cards_and_children` | `opencode::oc2_recovery_uses_live_identity_and_deduplicates_pending_cards_and_children` | `opencode::native_session_title_is_projected_for_untitled_chats_only` |
| fork | `opencode::oc2_fork_latest_and_selected_reply_resolve_exclusive_native_boundary` | `opencode::oc2_unavailable_native_fork_falls_back_once_and_preserves_source`, `opencode::oc2_uncertain_native_fork_stops_without_copy_and_never_reposts` | — | — | — | `opencode::oc2_unavailable_native_fork_falls_back_once_and_preserves_source` (falls back once) | — |
| subagents | `opencode::task_lifecycle_projects_cards_with_summary_and_error_without_parent_tools`, `opencode::parallel_tasks_preserve_parent_text_tools_and_independent_child_ownership`, `opencode::a_captured_225_marker_binds_the_child_only_through_the_verified_parent_link`, `qa/subagent-opencode.integration.mjs:46` | `opencode::child_errors_idle_and_foreign_events_cannot_settle_parent_or_permissions`, `opencode::a_marker_naming_an_unrelated_session_never_owns_it` | — | — | — | `opencode::nested_session_registration_and_inner_tasks_keep_the_root_key` | `opencode::unbound_child_buffer_drops_oldest_and_ignores_deltas`, `opencode::child_snapshots_before_and_after_binding_replace_text_and_merge_tools` |
| plan | `opencode::the_session_todo_list_becomes_the_turn_plan` | — | — | — | — | — | `opencode::seeded_messages_require_authoritative_snapshots_and_reject_wrong_identity` |

OpenCode gaps: no fork duplicate-request case beyond the single fallback, no timeout case for a prompt that is
accepted but never streamed (`sse_header_timeout` covers the SSE header only), and no cancel-timeout case.

## 9. Pi (`runtime/src/providers/pi.rs`, `runtime/src/providers/pi_project_trust.rs`)

Declared: terminal, chat, history, resume, `terminalResumeCapture: preassigned` (`pi.rs:109`, `pi --session-id`),
`auth: unknown`. Native extras: steer (with images), fork, an extension-dialog question bridge, and the
ThreadTerm-owned per-project Pi trust decision (`chat.projectTrust.set`). Pi has no interactive approval channel
(`pi.rs:1059` returns `approval_unsupported`).

| Capability | Success | Failure | Timeout | Cancel | Reconnect | Duplicate request | Late event |
| --- | --- | --- | --- | --- | --- | --- | --- |
| install/version probe | `providers::cold_ui_reads_are_pending_and_share_one_probe_with_confirmed_admission` (§3) | `probes::pi_requires_every_read_only_flag` | — | — | — | — | — |
| terminal launch / identity | `pi::terminal_mapping_preserves_pi_resume_and_preassigned_identity_contracts` | — | — | — | — | — | `pi::unverified_roundtable_marker_adds_no_pi_flags` |
| chat connect | `pi::real_pi_open_chat_returns_a_live_native_session`, `pi::session_header_binds_the_native_id` | — | — | — | — | — | — |
| send + stream | `pi::fake_pi_chat_turn_streams_and_completes`, `pi::real_pi_chat_turn_streams_and_completes`, `pi::text_and_thinking_deltas_stream_as_chat_parts` | `pi::failed_assistant_message_reports_the_error_only_when_the_turn_settles` | — | — | — | `pi::agent_settled_completes_the_active_turn_once` | `pi::late_turn_scoped_records_do_not_project_or_poison_the_next_turn`, `pi::sparse_or_late_tool_frames_cannot_cross_pi_turn_ownership` |
| stop/interrupt | `pi::an_ended_pi_turn_is_an_idempotent_success_and_a_newer_turn_is_never_aborted`, `pi::aborted_agent_settled_reports_a_cancelled_turn` (+ §3 stop contract) | — | — | `pi::aborted_agent_settled_reports_a_cancelled_turn`, `pi::cancel_fallback_and_native_settlement_share_one_refresh_generation` | — | — | `pi::late_turn_scoped_records_do_not_project_or_poison_the_next_turn` |
| questions (extension dialogs) | `pi::extension_dialogs_use_question_contract_and_preserve_native_ids`, `qa/pi-question-editor.mjs:78` | — | — | — | — | — | — |
| model/thinking options | `pi::ui_state_matches_the_protocol_option_shape`, `pi::real_pi_rpc_round_trips_state_and_thinking_levels`, `pi::model_choice_qualifies_the_value_with_the_provider` | — | — | — | — | — | `pi::superseded_context_reads_cannot_publish_in_reverse_order` |
| slash commands | `pi::slash_parsing_and_builtin_merging_are_stable`, `pi::slash_mutations_and_abort_fallback_refresh_context_over_the_rpc_transport` | — | — | — | — | — | — |
| steering (native) | `pi::steer_uses_the_pi_command_and_keeps_the_active_turn` | `pi::steer_uses_the_pi_command_and_keeps_the_active_turn` (rejects empty) | — | — | — | — | — |
| usage/context | `pi::context_usage_maps_pi_session_stats_and_hides_missing_values`, `pi::a_settled_turn_reports_its_summed_usage_with_the_stats_read` | — | — | — | — | — | `pi::context_mutations_clear_pressure_and_fence_pre_mutation_reads`, `pi::superseded_context_reads_cannot_publish_in_reverse_order` |
| history + resume | `pi::transcript_follows_pi_active_branch_instead_of_importing_abandoned_messages`, `pi::transcript_reads_text_and_thinking_from_message_entries`, `pi::pi_history_replies_keep_the_exact_entry_fork_anchor` | `pi::broken_pi_parent_chain_fails_closed_instead_of_importing_other_branches`, `pi::pi_history_status_requires_a_native_terminal_stop_reason` | — | — | — | — | — |
| fork | `pi::pi_fork_target_uses_next_user_on_the_active_branch_only`, `pi::completed_live_reply_uses_only_the_reported_pi_entry_id_as_fork_anchor` | — | — | — | — | — | — |
| session file / state | `pi::only_a_written_session_file_counts_as_saved`, `pi::configured_session_directory_takes_priority_without_process_environment_mutation` | `pi::only_a_written_session_file_counts_as_saved` (no file ⇒ not saved) | — | — | — | — | — |
| project trust | `pi_project_trust::settings_override_and_threadterm_decision_control_effective_state`, `qa/pi-trust-real.mjs:9` | `pi_project_trust::malformed_settings_and_trust_fail_closed_and_flags_are_exact`, `pi_project_trust::trust_store_bom_invalid_values_and_verbatim_windows_keys_are_safe` | — | — | `qa/pi-trust-real.mjs:10` (reconnect after restart) | — | `pi_project_trust::closest_pi_decision_wins_and_null_continues_inheritance` |
| tool cache | `pi::tool_execution_projection_retains_pi_args_and_result_across_updates` | `pi::pi_tool_cache_is_bounded_per_active_turn` | — | — | — | — | — |

Pi gaps: no timeout case at all, no approvals (excluded, §14), and subagent projection has no Pi-specific test
(`subagent_transcript` is not overridden).

## 10. Gemini (bundled declarative plugin, ACP chat)

Same `AcpAdapter` as Kimi but with `kimi_native == false`, so it has no Kimi extras: no `AskUserQuestion` bridge,
no native session reader, no plan card from a plain plan review, `terminalResumeCapture: none`
(`acp.rs:238`), and `auth: unknown`.

| Capability | Success | Failure | Timeout | Cancel | Reconnect | Duplicate request | Late event |
| --- | --- | --- | --- | --- | --- | --- | --- |
| install/version probe | `qa/provider-environment.mjs:70` | `acp::failed_version_probe_keeps_its_specific_error` | — | — | — | — | — |
| terminal launch | `acp::bundled_gemini_descriptor_keeps_its_acp_and_terminal_commands` | — | — | — | — | — | — |
| terminal identity capture | — (excluded: no pre-assignment, §14) | `acp::kimi_prepares_identity_through_acp_while_gemini_remains_unverified` | — | — | — | — | — |
| chat connect | `acp::acp_conformance_terminal_and_kimi_wire` (runs for `gemini` and `kimi`), `qa/agent-plugins.mjs:125` | `acp::failed_version_probe_keeps_its_specific_error` | — | — | — | — | — |
| send + stream | `acp::settings_contract_is_shared_by_kimi_and_gemini`, `acp::chat_ui_event_matches_acp_ui_state` | `acp::acp_conformance_terminal_and_kimi_wire` (foreign frames dropped) | — | — | — | — | `acp::foreign_acp_updates_do_not_project_or_mutate_parent_state` |
| stop/interrupt | `acp::an_ended_acp_turn_is_an_idempotent_success_and_a_newer_turn_is_never_cancelled` (+ §3) | — | — | `acp::an_ended_acp_turn_is_an_idempotent_success_and_a_newer_turn_is_never_cancelled` | — | — | — |
| approvals | `acp::acp_conformance_foreign_frames_and_reverse_requests` | — | — | — | — | `acp::acp_conformance_foreign_frames_and_reverse_requests` | — |
| config options / mode | `acp::option_listing_marks_current_value_and_choices`, `acp::maps_boolean_like_config_options_to_on_off_chips`, `acp::preserves_generic_acp_mode_category_and_legacy_modes` | `acp::startup_mode_restore_uses_config_option_and_rejects_a_mismatch` | — | — | — | — | `acp::modern_acp_mode_keeps_config_route_and_accepts_mode_notifications` |
| slash commands | `acp::local_commands_merge_into_the_menu_once` | — | — | — | — | — | — |
| usage/context | `acp::acp_usage_update_emits_a_context_snapshot` | — | — | — | — | — | `acp::usage_notifications_keep_the_originating_worker_token` |
| history + resume | `acp::repair_fixture_normalizes_kimi_and_generic_acp_history`, `acp::history_item_never_serializes_optional_nulls` | — | — | — | — | — | — |
| fork | `acp::acp_native_fork_loads_the_source_then_returns_the_child_without_touching_it` | `acp::recognizes_nested_session_capabilities` | — | — | — | — | — |
| subagents | `acp::subagent_detection_is_provider_scoped_and_remembers_sparse_updates` | — | — | — | — | — | `acp::acp_late_subagent_detection_retracts_the_projected_parent_tool` |
| plugin lifecycle | `plugins::bundled_registry_contains_enabled_gemini_agent_and_codex_binding`, `qa/agent-plugins.mjs:104` | `plugins::rejects_paths_outside_the_plugin_folder_and_unknown_chat_protocol`, `qa/agent-plugins.mjs:128` | — | — | `service/plugin_tests.rs::plugin_dispatch_enable_reload_metadata_delegation_and_live_chat` | — | — |

Gemini gaps: no Gemini-only chat/turn test (it is always covered as the second provider of a Kimi test), no plan,
usage or fork test that asserts Gemini-specific behaviour, and no reconnect-while-live case.

## 11. ACP plugin (user-declared, `chat.protocol == "acp"`)

`AcpAdapter::from_descriptor` (`runtime/src/providers.rs:1432`). Everything protocol-level is shared with §10; the
plugin-specific coverage is manifest validation, capability advertisement and the enable/reload path.

| Capability | Success | Failure | Timeout | Cancel | Reconnect | Duplicate request | Late event |
| --- | --- | --- | --- | --- | --- | --- | --- |
| manifest/agent contribution | `plugins::accepts_a_complete_acp_manifest`, `plugins::enabled_user_plugin_contributes_and_collisions_are_rejected` | `plugins::rejects_invalid_commands_placeholders_and_limits`, `plugins::rejects_metadata_agent_and_resume_limits`, `plugins::rejects_too_many_and_duplicate_agents` | — | — | — | `plugins::plugin_id_order_determines_agent_collision_winner` | — |
| capability advertisement | `service/plugin_tests.rs::plugin_dispatch_enable_reload_metadata_delegation_and_live_chat`, `qa/agent-plugins.mjs:125` | `service/plugin_tests.rs::failed_provider_discovery_keeps_runtime_snapshot_and_existing_sessions_available` | `service/plugin_tests.rs::provider_refresh_returns_before_the_probe_completes` | — | `service/plugin_tests.rs::plugin_dispatch_enable_reload_metadata_delegation_and_live_chat` (reload) | — | — |
| chat connect + options | `qa/acp-settings.integration.mjs:73`, `qa/acp-settings.integration.mjs:76`, `qa/acp-settings.integration.mjs:78` | — | — | — | — | — | — |
| terminal launch | `service/plugin_tests.rs::enabled_plugin_terminal_session_launches_the_temporary_echo_script` | `plugins::command_path_is_rechecked_at_launch`, `plugins::command_path_rejects_a_symlink_replaced_outside_the_plugin` | — | — | — | — | — |
| icon/path safety | `plugins::rejects_an_icon_symlink_outside_the_plugin_folder` | `plugins::windows_verbatim_paths_are_normalized_for_plugin_launches` | — | — | — | — | — |

ACP-plugin gaps: no test drives a plugin ACP chat through cancel, approvals, questions, history or fork from the
plugin side (those are only covered as `kimi`/`gemini` in §6/§10).

## 12. Terminal-only plugin (`ManifestTerminalAdapter`)

A manifest with a `terminal` block and no `chat` block. It declares `chat: false`, `history: false`, `resume`
only when the manifest supplies resume arguments (`plugins::terminal_resume_is_optional_and_agent_homepage_inherits_plugin_homepage`).

| Capability | Success | Failure | Timeout | Cancel | Reconnect | Duplicate request | Late event |
| --- | --- | --- | --- | --- | --- | --- | --- |
| capability shape | `plugins::terminal_only_agent_has_no_chat_capability` | — | — | — | — | — | — |
| terminal launch | `service/plugin_tests.rs::enabled_plugin_terminal_session_launches_the_temporary_echo_script`, `service/plugin_tests.rs::plugin_agents_support_session_creation_and_saved_launches` | `plugins::command_path_is_rechecked_at_launch`, `plugins::command_path_rejects_a_symlink_replaced_outside_the_plugin` | — | — | — | — | — |
| resume arguments | `plugins::public_commands_include_terminal_and_resume_arguments` | — | — | — | — | — | — |
| argument expansion | `plugins::command_composition_expands_plugin_and_session_placeholders_without_spawning` | `plugins::rejects_each_argument_list_limit_and_invalid_argument_form`, `plugins::rejects_schema_ids_and_placeholder_misuse` | — | — | — | — | — |
| disabled/unknown contributions | `plugins::unknown_contributions_warn_without_disabling_valid_agents` | `plugins::invalid_manifest_does_not_reserve_an_unrelated_plugin_id` | — | — | — | — | — |

## 13. Terminal-mode agents (`runtime/src/terminal_agents.rs`)

Provider-specific behaviour for agents running inside a plain shell or a custom terminal: process detection
(`SIGNATURES`), the `terminalAgent` projection, and the shared terminal launch/resume path used by every adapter.
There is no chat, no approvals and no usage here.

| Capability | Success | Failure | Timeout | Cancel | Reconnect | Duplicate request | Late event |
| --- | --- | --- | --- | --- | --- | --- | --- |
| agent detection | `terminal_agents_tests::signature_table_matches_and_rejects_ordinary_programs`, `terminal_agents_tests::windows_pty_detects_and_clears_a_renamed_claude` | `terminal_agents_tests::signature_table_matches_and_rejects_ordinary_programs` (ordinary programs rejected) | — | — | — | `terminal_agents_tests::watcher_writes_once_per_change_and_clears_on_exit` | `terminal_agents_tests::the_outermost_agent_wins_over_one_it_runs_as_a_tool` |
| projection | `terminal_agents_tests::projection_carries_terminal_agent_only_for_shell_custom` | — | — | — | — | — | `terminal_agents_tests::startup_clear_drops_rows` |
| path normalization | `terminal_agents_tests::normalize_folds_case_and_slashes` | — | — | — | — | — | — |
| terminal resume (all adapters) | `qa/agent-terminal-resume.mjs:90`, `qa/agent-terminal-resume.mjs:94` (`codex`, `kimi`, `opencode` by default; `THREADTERM_QA_PROVIDERS` extends it) | `qa/claude-empty-resume.mjs:57` | — | — | — | — | — |

## 14. Intentional exclusions

Cases an adapter cannot have, with the code that makes them impossible. These stay `—` in the tables on
purpose.

| Adapter | Case it cannot have | Code that proves it |
| --- | --- | --- |
| Kimi, Gemini, ACP plugins | auth check | `auth: "unknown"` is hard-coded (`acp.rs:206`), so no probe can ever report signed-in or signed-out |
| Gemini, ACP plugins, terminal-only plugins | terminal resume for a NEW session | `terminal_capture` returns `TerminalCapture::None` for non-Kimi ACP (`acp.rs:238`) and the trait default is `None` (`providers.rs:441`) |
| Terminal-only plugins | every chat lifecycle case | no chat block ⇒ `chat: false` (`plugins::terminal_only_agent_has_no_chat_capability`) |
| Claude | chat attachments | `validate_steer` rejects images (`claude.rs:652`) and there is no `send_with_images` override, so the trait default rejects them (`providers.rs:674`) |
| Kimi, Gemini, ACP plugins, Grok | chat attachments | same trait default (`providers.rs:674`); neither `acp.rs` nor `grok.rs` overrides `validate_images`/`send_with_images` (Codex and OpenCode do) |
| Pi | chat attachments on send | only `validate_steer`/`steer` accept images (`pi.rs:976`, `pi.rs:999`); `send` has no image path |
| Pi | approvals | `approve` returns `approval_unsupported` (`pi.rs:1067`) |
| OpenCode | plan approval | no `plan_response` override, so the trait default returns `plan_unsupported` (`providers.rs:760`); its todo list becomes a plan part instead |
| Pi | plan approval | no `plan_response` override either (`providers.rs:760`) |
| Pi | provider-side subagent transcripts | `subagent_transcript` is not overridden (`providers.rs:474`), so a Pi child transcript cannot be read |
| Kimi, Gemini, ACP plugins, Grok, OpenCode | native steering | no `steer` override (`providers.rs:716`); Kimi/ACP and Grok advertise note-only steering instead (`acp.rs:614`, `grok.rs:502`) |
| Kimi, Gemini, ACP plugins, OpenCode | background tasks | no `background_tasks` override ⇒ empty list (`providers.rs:775`); only Claude, Codex and Grok implement it |
| Grok | native fork | no `fork_session` override ⇒ `None` (`providers.rs:453`) |
| Terminal-only plugins | native fork | same trait default (`providers.rs:453`) |
| Codex | attachments that are not data URLs | `validate_images`/`send_with_images` accept data URLs only (`codex.rs:869`, `codex.rs:902`) |

## 15. Live-account-only checks

Behaviour that only a real signed-in account, real CLI or real network can produce. These are environment
harnesses, not CI steps (see the `QA` allow-list in `scripts/check.mjs:296`): they need an installed CLI and often a
network, so they are run manually and are excluded from `npm run check`.

| Check | Ref | Needs |
| --- | --- | --- |
| end-to-end chat for every authenticated provider | `qa/provider-chat-smoke.mjs:145` | real CLI + signed-in account for each provider |
| Kimi question, chat, terminal, resume, delegation, history, subagent scenarios | `qa/kimi-live.mjs:17` | real Kimi CLI + account |
| Claude SDK against the real SDK and CLI | `qa/claude-sdk-live-probe.mjs:65` | real Claude CLI + account |
| Claude chat with real approvals | `qa/claude-chat-live.mjs:76`, `qa/claude-chat-handshake.mjs:27` | real Claude CLI + account |
| Codex slash-command lifecycle against the real CLI | `qa/codex-slash-lifecycle.mjs:65`, `qa/codex-compat-live.mjs:38` | real Codex CLI + account |
| Codex image paste through the real CLI | `qa/codex-image-paste-live.mjs:70` | Windows desktop probe + real Codex CLI |
| Codex old-CLI degradation | `qa/codex-old-cli-chat.mjs:42` | fake old-CLI fixture + Electron |
| Grok questions, subagents and repair against the real CLI | `qa/question-grok-live.mjs:28`, `qa/grok-bg-subagent-live.mjs:21`, `qa/chat-repair-grok-live.mjs:21` | real Grok CLI (`THREADTERM_QA_GROK`) |
| Provider usage/quota cards with real account data | `qa/grok-usage-visual.mjs:12`, `qa/kimi_acp_usage_timing.py` | real account usage endpoints |
| Provider environment/detection on a real machine | `qa/provider-environment.mjs:70` | real CLIs on PATH |
| Capability refresh with real probes | `qa/provider-refresh-real.mjs:97` | real CLIs |
| Cold start while a provider probe is still running | `qa/cold-provider-startup.mjs:141` | Electron + fake Kimi fixture |
| Terminal resume for real CLIs | `qa/agent-terminal-resume.mjs:17` | real CLIs for the selected providers |

## 16. Top gaps (ranked by user impact, 15 max)

1. **Codex, stop/interrupt, timeout** — no test for an interrupt the CLI never acknowledges, so a wedged
   `turn/interrupt` is invisible.
2. **Grok, stop/interrupt, timeout** — a turn whose prompt never returns has no test, while the usage path does.
3. **Pi, every capability, timeout** — no timeout case at all; a Pi RPC that never answers is untested.
4. **Gemini, send + stream, success** — Gemini is only ever the second provider inside a Kimi test, so a
   Gemini-only regression (for example in plan or usage projection) would pass.
5. **ACP plugins, approvals/questions/cancel, all cases** — a plugin ACP chat is never driven through them from the
   plugin path; only `kimi`/`gemini` are.
6. **Claude, chat connect, reconnect** — the sidecar handshake has success/failure/timeout/cancel tests but no
   reconnect-after-death case at adapter level.
7. **Kimi, questions, failure/cancel** — a rejected or cancelled `AskUserQuestion` has no test, so a stuck pending
   card is only caught by the live probe.
8. **OpenCode, send + stream, cancel** — an explicit Stop between HTTP acceptance and the first SSE frame is only
   covered after the first frame (`confirmed_abort_*`), so the earliest window is untested.
9. **Grok, history + resume, failure** — no test for a `session/load` that fails or returns a foreign session.
10. **Codex, reconnect while a turn is live** — the reconnect fixture (`qa/codex-reconnect-fixture.test.mjs:26`)
    covers an empty new chat only.
11. **OpenCode, fork, cancel** — a fork cancelled mid-flight has no test; only success, unavailable and uncertain.
12. **Pi, subagents, all cases** — `subagent_transcript` is not overridden for Pi and no Pi test projects a child
    transcript.
13. **Claude, attachments, all cases** — excluded by design, but the renderer still offers no explanation when a
    user pastes an image; there is no test that the `images_unsupported` error is surfaced.
14. **Terminal-mode agents, detection, timeout** — the watcher polls every 1.25 s (`terminal_agents.rs:19`), but no
    test covers a process that exits between two polls.
15. **All adapters, plugin and builtin, duplicate request on send** — only Codex (steer/auto-approve) and ACP
    (JSON-RPC ids) assert exactly-once; a duplicated `chat.send` for Claude, Grok, OpenCode or Pi is not covered.
