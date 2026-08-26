#![cfg(all(feature = "pty-runtime", windows))]

use std::{
    io::{Read, Write},
    time::{Duration, Instant},
};

use tempfile::TempDir;
use terminal_host_core::{
    CatalogLookup, CatalogSelector, CloseMode, CloseOutcome, CreateDisposition, CreatePtyRequest,
    DaemonPtyEngine, PresentationTarget, PtyRuntimeConfig, RequestDigest, RuntimeEvent,
    RuntimeIdentity, TerminalState,
};
use terminal_host_protocol::{ExitBehavior, Presentation};

fn engine(temp: &TempDir) -> DaemonPtyEngine {
    engine_with_config(
        temp,
        PtyRuntimeConfig {
            output_queue_capacity: 4_096,
            raw_replay_bytes: 16 * 1024 * 1024,
            ..PtyRuntimeConfig::default()
        },
    )
}

fn engine_with_config(temp: &TempDir, config: PtyRuntimeConfig) -> DaemonPtyEngine {
    let (engine, _) = DaemonPtyEngine::open(
        temp.path().join("runtime.sqlite"),
        RuntimeIdentity {
            runtime_id: "test-runtime".to_owned(),
            launch_nonce: "test-nonce".to_owned(),
        },
        config,
    )
    .unwrap();
    engine
}

fn request(request_id: &str, helper: &str, digest: u8) -> CreatePtyRequest {
    CreatePtyRequest {
        request_id: request_id.to_owned(),
        digest: RequestDigest::new([digest; 32]),
        executable: std::env::current_exe().unwrap(),
        args: vec![
            "--ignored".to_owned(),
            "--exact".to_owned(),
            helper.to_owned(),
            "--nocapture".to_owned(),
        ],
        cwd: std::env::current_dir().unwrap(),
        rows: 30,
        cols: 100,
        title: None,
        target: PresentationTarget::Window,
        presentation: Presentation::Focused,
        exit_behavior: ExitBehavior::Keep,
    }
}

fn wait_for_live_count(engine: &DaemonPtyEngine, expected: usize) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while engine.session_count() != expected && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(engine.session_count(), expected);
}

#[test]
fn real_conpty_direct_argv_input_resize_ansi_scrollback_large_output_and_reuse() {
    let temp = TempDir::new().unwrap();
    let engine = engine(&temp);
    let created = engine
        .create(request("windows/direct-argv", "pty_child_fixture", 1))
        .unwrap();
    assert_eq!(created.disposition, CreateDisposition::Created);
    let reused = engine
        .create(request("windows/direct-argv", "pty_child_fixture", 1))
        .unwrap();
    assert_eq!(reused.disposition, CreateDisposition::Reused);
    assert_eq!(created.identity, reused.identity);
    assert_eq!(created.child_pid, reused.child_pid);

    let attached = engine
        .attach(&created.identity.handle, "test-client")
        .unwrap();
    let dropped = engine
        .attach(&created.identity.handle, "dropped-client")
        .unwrap();
    assert_eq!(engine.detach_all("dropped-client").unwrap(), 1);
    assert!(engine
        .input(
            &dropped.attach_id,
            &dropped.identity.stream_id,
            b"stale".to_vec(),
        )
        .is_err());
    let detached = engine
        .attach(&created.identity.handle, "detached-client")
        .unwrap();
    assert!(engine
        .detach(&detached.attach_id, &detached.identity.stream_id)
        .unwrap());
    assert!(!engine
        .detach(&detached.attach_id, &detached.identity.stream_id)
        .unwrap());
    assert!(engine
        .resize(&attached.attach_id, &attached.identity.stream_id, 40, 120,)
        .unwrap());
    assert!(!engine
        .resize(&attached.attach_id, &attached.identity.stream_id, 40, 120,)
        .unwrap());
    engine
        .input(
            &attached.attach_id,
            &attached.identity.stream_id,
            b"first-stage\r\n".to_vec(),
        )
        .unwrap();

    let mut output = Vec::new();
    let mut last_seq = attached.barrier_seq;
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline && !output.windows(10).any(|v| v == b"LINES-DONE") {
        if let Some(RuntimeEvent::Output { seq, bytes, .. }) = attached
            .subscription
            .recv_timeout(Duration::from_millis(250))
        {
            assert!(seq > last_seq);
            last_seq = seq;
            output.extend_from_slice(&bytes);
        }
    }
    assert!(output.windows(10).any(|v| v == b"LINES-DONE"));
    assert!(output.windows(5).any(|v| v == b"INPUT"));
    assert!(engine
        .input(&attached.attach_id, "stale-stream", b"x".to_vec())
        .is_err());
    assert!(engine
        .acknowledge(&attached.attach_id, &attached.identity.stream_id, u64::MAX,)
        .is_err());
    assert!(engine
        .acknowledge(&attached.attach_id, &attached.identity.stream_id, last_seq,)
        .unwrap());
    assert!(!engine
        .acknowledge(
            &attached.attach_id,
            &attached.identity.stream_id,
            last_seq.saturating_sub(1),
        )
        .unwrap());

    let (barrier, snapshot) = engine
        .resync(&attached.attach_id, &attached.identity.stream_id)
        .unwrap();
    assert!(barrier >= last_seq);
    let snapshot = String::from_utf8_lossy(&snapshot.content);
    assert!(snapshot.contains("ansi-red"));
    assert!(snapshot.contains("line-2999"));
    assert!(!snapshot.contains("ALT-SCREEN"));

    engine
        .input(
            &attached.attach_id,
            &attached.identity.stream_id,
            b"large-stage\r\n".to_vec(),
        )
        .unwrap();
    let mut large_bytes = 0usize;
    let mut saw_exit = false;
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline && !saw_exit {
        match attached
            .subscription
            .recv_timeout(Duration::from_millis(250))
        {
            Some(RuntimeEvent::Output { bytes, .. }) => {
                large_bytes += bytes.len();
            }
            Some(RuntimeEvent::Exit { exit_code, .. }) => {
                assert_eq!(exit_code, Some(0));
                saw_exit = true;
            }
            Some(RuntimeEvent::State { .. }) => {}
            Some(RuntimeEvent::ResyncRequired { .. }) => panic!("unexpected output overflow"),
            None => {}
        }
    }
    assert!(saw_exit);
    let expected_burst = if cfg!(debug_assertions) {
        2 * 1024 * 1024
    } else {
        100 * 1024 * 1024
    };
    assert!(large_bytes >= expected_burst);
    assert_eq!(engine.session_count(), 0);
}

#[test]
fn real_conpty_force_close_reports_exit_without_shell_command() {
    let temp = TempDir::new().unwrap();
    let engine = engine(&temp);
    let created = engine
        .create(request("windows/force-close", "pty_child_wait", 2))
        .unwrap();
    let attached = engine
        .attach(&created.identity.handle, "force-client")
        .unwrap();
    let result = engine
        .close(
            &created.identity.handle,
            CloseMode::Force {
                timeout: Duration::from_secs(5),
            },
        )
        .unwrap();
    assert_eq!(result, CloseOutcome::Exited);
    assert_eq!(engine.session_count(), 0);
    assert!(matches!(
        attached
            .subscription
            .recv_timeout(Duration::from_millis(250)),
        Some(RuntimeEvent::State {
            state: TerminalState::Closing,
            ..
        })
    ));
    assert!(matches!(
        attached
            .subscription
            .recv_timeout(Duration::from_millis(250)),
        Some(RuntimeEvent::State {
            state: TerminalState::Exited,
            ..
        })
    ));
    assert!(matches!(
        attached
            .subscription
            .recv_timeout(Duration::from_millis(250)),
        Some(RuntimeEvent::Exit { .. })
    ));
}

#[test]
fn engine_catalog_facade_keeps_one_generation_and_attachment_count_is_bounded() {
    let temp = TempDir::new().unwrap();
    let engine = engine_with_config(
        &temp,
        PtyRuntimeConfig {
            max_attachments_per_session: 1,
            ..PtyRuntimeConfig::default()
        },
    );
    let created = engine
        .create(request("windows/catalog-facade", "pty_child_wait", 9))
        .unwrap();

    let lookup = engine
        .lookup(CatalogSelector::Handle(created.identity.handle.clone()))
        .unwrap();
    assert!(matches!(lookup, CatalogLookup::ActiveOrTombstone { .. }));
    let page = engine.list_page(1).unwrap();
    assert_eq!(page.records.len(), 1);
    assert!(!page.has_more);

    let attached = engine
        .attach(&created.identity.handle, "bounded-client")
        .unwrap();
    assert!(matches!(
        engine.attach(&created.identity.handle, "excess-client"),
        Err(terminal_host_core::PtyRuntimeError::AttachmentLimit)
    ));
    assert!(engine
        .detach(&attached.attach_id, &attached.identity.stream_id)
        .unwrap());
    assert_eq!(
        engine
            .close(
                &created.identity.handle,
                CloseMode::Force {
                    timeout: Duration::from_secs(5),
                },
            )
            .unwrap(),
        CloseOutcome::Exited
    );
}

#[test]
fn engine_presentation_seam_is_revision_guarded_and_exposes_only_live_pid() {
    let temp = TempDir::new().unwrap();
    let engine = engine(&temp);
    let created = engine
        .create(request("windows/presentation-seam", "pty_child_wait", 16))
        .unwrap();
    assert_eq!(
        engine.live_child_pid(&created.identity.handle).unwrap(),
        created.child_pid
    );
    let current = engine
        .authoritative_lookup(&created.identity.handle)
        .unwrap();
    let presented = engine
        .set_desired_presentation(
            &created.identity.handle,
            PresentationTarget::Workspace {
                normalized_path: "C:\\workspace-presentation".to_owned(),
            },
            Presentation::Background,
            current.revision,
        )
        .unwrap();
    assert_eq!(presented.record.revision, current.revision + 1);
    assert!(!presented.record.surface_hidden);
    let hidden = engine
        .set_surface_hidden(&created.identity.handle, presented.record.revision)
        .unwrap();
    assert!(hidden.record.surface_hidden);
    assert!(matches!(
        engine.set_surface_hidden(&created.identity.handle, presented.record.revision),
        Err(terminal_host_core::PtyRuntimeError::Catalog(
            terminal_host_core::CatalogError::StalePresentation
        ))
    ));
    assert_eq!(
        engine
            .close(
                &created.identity.handle,
                CloseMode::Force {
                    timeout: Duration::from_secs(5),
                },
            )
            .unwrap(),
        CloseOutcome::Exited
    );
    assert_eq!(
        engine.live_child_pid(&created.identity.handle).unwrap(),
        None
    );
}

#[test]
fn real_conpty_replay_wins_at_registry_capacity_and_close_releases_capacity() {
    let temp = TempDir::new().unwrap();
    let engine = engine_with_config(
        &temp,
        PtyRuntimeConfig {
            max_sessions: 1,
            ..PtyRuntimeConfig::default()
        },
    );
    let first_request = request("windows/capacity-first", "pty_child_wait", 4);
    let first = engine.create(first_request.clone()).unwrap();
    let replay = engine.create(first_request).unwrap();
    assert_eq!(replay.disposition, CreateDisposition::Reused);
    assert_eq!(first.identity, replay.identity);
    assert!(matches!(
        engine.create(request("windows/capacity-second", "pty_child_wait", 5)),
        Err(terminal_host_core::PtyRuntimeError::RegistryFull)
    ));
    assert_eq!(
        engine
            .close(
                &first.identity.handle,
                CloseMode::Force {
                    timeout: Duration::from_secs(5),
                },
            )
            .unwrap(),
        CloseOutcome::Exited
    );
    let second = engine
        .create(request("windows/capacity-second", "pty_child_wait", 5))
        .unwrap();
    assert_eq!(second.disposition, CreateDisposition::Created);
    let _ = engine.close(
        &second.identity.handle,
        CloseMode::Force {
            timeout: Duration::from_secs(5),
        },
    );
}

#[test]
fn natural_exit_reaps_live_runtime_but_preserves_idempotency_and_capacity() {
    let temp = TempDir::new().unwrap();
    let engine = engine_with_config(
        &temp,
        PtyRuntimeConfig {
            max_sessions: 1,
            ..PtyRuntimeConfig::default()
        },
    );
    let first_request = request("windows/natural-first", "pty_child_exit", 6);
    let first = engine.create(first_request.clone()).unwrap();
    let attached = engine
        .attach(&first.identity.handle, "natural-client")
        .unwrap();
    engine
        .input(
            &attached.attach_id,
            &attached.identity.stream_id,
            b"exit-now\r\n".to_vec(),
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut saw_exit = false;
    while Instant::now() < deadline && !saw_exit {
        saw_exit = matches!(
            attached
                .subscription
                .recv_timeout(Duration::from_millis(100)),
            Some(RuntimeEvent::Exit {
                exit_code: Some(0),
                ..
            })
        );
    }
    assert!(
        saw_exit,
        "queued exit remains receivable after natural reaping"
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while engine.session_count() != 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(engine.session_count(), 0);

    let replay = engine.create(first_request.clone()).unwrap();
    assert_eq!(replay.disposition, CreateDisposition::Reused);
    assert_eq!(replay.identity, first.identity);
    assert_eq!(replay.child_pid, None);
    let mut conflicting = first_request;
    conflicting.digest = RequestDigest::new([7; 32]);
    assert!(matches!(
        engine.create(conflicting),
        Err(terminal_host_core::PtyRuntimeError::Catalog(
            terminal_host_core::CatalogError::RequestConflict
        ))
    ));

    let second = engine
        .create(request("windows/natural-second", "pty_child_wait", 8))
        .unwrap();
    assert_eq!(second.disposition, CreateDisposition::Created);
    assert_eq!(
        engine
            .close(
                &second.identity.handle,
                CloseMode::Force {
                    timeout: Duration::from_secs(5),
                },
            )
            .unwrap(),
        CloseOutcome::Exited
    );
}

#[test]
fn overflow_exit_retains_final_resync_until_last_detach_and_bounds_registry() {
    let temp = TempDir::new().unwrap();
    let engine = engine_with_config(
        &temp,
        PtyRuntimeConfig {
            max_sessions: 1,
            max_registered_sessions: 1,
            output_queue_capacity: 1,
            raw_replay_bytes: 1024 * 1024,
            ..PtyRuntimeConfig::default()
        },
    );
    let created = engine
        .create(request("windows/overflow-exit", "pty_child_burst_exit", 10))
        .unwrap();
    let attached = engine
        .attach(&created.identity.handle, "overflow-client")
        .unwrap();
    engine
        .input(
            &attached.attach_id,
            &attached.identity.stream_id,
            b"exit-now\r\n".to_vec(),
        )
        .unwrap();
    wait_for_live_count(&engine, 0);
    assert!(matches!(
        engine.attach(&created.identity.handle, "late-client"),
        Err(terminal_host_core::PtyRuntimeError::SessionNotFound)
    ));

    assert!(matches!(
        engine.create(request("windows/retained-bound", "pty_child_wait", 11)),
        Err(terminal_host_core::PtyRuntimeError::RegistryFull)
    ));
    assert!(matches!(
        attached.subscription.recv_timeout(Duration::from_secs(1)),
        Some(RuntimeEvent::ResyncRequired { .. })
    ));
    let (barrier, snapshot) = engine
        .resync(&attached.attach_id, &attached.identity.stream_id)
        .unwrap();
    assert!(barrier > attached.barrier_seq);
    assert!(String::from_utf8_lossy(&snapshot.content).contains("FINAL-SNAPSHOT"));
    assert!(matches!(
        attached.subscription.recv_timeout(Duration::from_secs(1)),
        Some(RuntimeEvent::State {
            state: TerminalState::Exited,
            ..
        })
    ));
    assert!(matches!(
        attached.subscription.recv_timeout(Duration::from_secs(1)),
        Some(RuntimeEvent::Exit {
            exit_code: Some(0),
            ..
        })
    ));
    assert!(attached.subscription.is_finished());

    assert!(engine
        .detach(&attached.attach_id, &attached.identity.stream_id)
        .unwrap());
    assert!(engine
        .resync(&attached.attach_id, &attached.identity.stream_id)
        .is_err());
    let replacement = engine
        .create(request("windows/retained-bound", "pty_child_wait", 11))
        .unwrap();
    assert_eq!(
        engine
            .close(
                &replacement.identity.handle,
                CloseMode::Force {
                    timeout: Duration::from_secs(5),
                },
            )
            .unwrap(),
        CloseOutcome::Exited
    );
}

#[test]
fn explicit_close_finalizes_an_exited_retained_session() {
    let temp = TempDir::new().unwrap();
    let engine = engine_with_config(
        &temp,
        PtyRuntimeConfig {
            max_sessions: 1,
            max_registered_sessions: 1,
            ..PtyRuntimeConfig::default()
        },
    );
    let created = engine
        .create(request("windows/exited-close", "pty_child_exit", 12))
        .unwrap();
    let attached = engine
        .attach(&created.identity.handle, "close-client")
        .unwrap();
    engine
        .input(
            &attached.attach_id,
            &attached.identity.stream_id,
            b"exit-now\r\n".to_vec(),
        )
        .unwrap();
    wait_for_live_count(&engine, 0);

    assert_eq!(
        engine
            .close(
                &created.identity.handle,
                CloseMode::Force {
                    timeout: Duration::from_secs(1),
                },
            )
            .unwrap(),
        CloseOutcome::Exited
    );
    assert!(engine
        .resync(&attached.attach_id, &attached.identity.stream_id)
        .is_err());
    let replacement = engine
        .create(request("windows/after-exited-close", "pty_child_wait", 13))
        .unwrap();
    let _ = engine.close(
        &replacement.identity.handle,
        CloseMode::Force {
            timeout: Duration::from_secs(5),
        },
    );
}

#[test]
fn detach_all_reaps_an_exited_retained_session() {
    let temp = TempDir::new().unwrap();
    let engine = engine_with_config(
        &temp,
        PtyRuntimeConfig {
            max_sessions: 1,
            max_registered_sessions: 1,
            ..PtyRuntimeConfig::default()
        },
    );
    let created = engine
        .create(request("windows/exited-detach-all", "pty_child_exit", 14))
        .unwrap();
    let attached = engine
        .attach(&created.identity.handle, "disconnect-client")
        .unwrap();
    engine
        .input(
            &attached.attach_id,
            &attached.identity.stream_id,
            b"exit-now\r\n".to_vec(),
        )
        .unwrap();
    wait_for_live_count(&engine, 0);
    assert_eq!(engine.detach_all("disconnect-client").unwrap(), 1);
    assert!(engine
        .resync(&attached.attach_id, &attached.identity.stream_id)
        .is_err());

    let replacement = engine
        .create(request("windows/after-detach-all", "pty_child_wait", 15))
        .unwrap();
    let _ = engine.close(
        &replacement.identity.handle,
        CloseMode::Force {
            timeout: Duration::from_secs(5),
        },
    );
}

#[test]
fn sequential_unattached_natural_exits_reuse_live_and_registry_capacity() {
    let temp = TempDir::new().unwrap();
    let engine = engine_with_config(
        &temp,
        PtyRuntimeConfig {
            max_sessions: 1,
            max_registered_sessions: 1,
            ..PtyRuntimeConfig::default()
        },
    );
    for index in 0..3_u8 {
        let request_id = format!("windows/unattached-{index}");
        let deadline = Instant::now() + Duration::from_secs(5);
        let created = loop {
            match engine.create(request(&request_id, "pty_child_auto_exit", 20 + index)) {
                Ok(created) => break created,
                Err(terminal_host_core::PtyRuntimeError::RegistryFull)
                    if Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("unattached create failed: {error}"),
            }
        };
        assert_eq!(created.disposition, CreateDisposition::Created);
        wait_for_live_count(&engine, 0);
    }
}

#[test]
fn real_conpty_graceful_interrupt_is_bounded_and_does_not_force() {
    let temp = TempDir::new().unwrap();
    let engine = engine(&temp);
    let created = engine
        .create(request("windows/graceful-close", "pty_child_wait", 3))
        .unwrap();
    let result = engine
        .close(
            &created.identity.handle,
            CloseMode::Graceful {
                timeout: Duration::from_secs(5),
            },
        )
        .unwrap();
    if result == CloseOutcome::Pending {
        assert_eq!(engine.session_count(), 1);
        assert_eq!(
            engine
                .close(
                    &created.identity.handle,
                    CloseMode::Force {
                        timeout: Duration::from_secs(5),
                    },
                )
                .unwrap(),
            CloseOutcome::Exited
        );
    }
    assert_eq!(engine.session_count(), 0);
}

#[test]
#[ignore = "subprocess fixture; invoked by the real ConPTY test"]
fn pty_child_fixture() {
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).unwrap();
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(b"INPUT:").unwrap();
    stdout.write_all(line.as_bytes()).unwrap();
    stdout.write_all(b"\x1b[31mansi-red\x1b[0m\r\n").unwrap();
    stdout
        .write_all(b"\x1b[?1049hALT-SCREEN\x1b[?1049l")
        .unwrap();
    for index in 0..3_000 {
        writeln!(stdout, "line-{index:04}\r").unwrap();
    }
    stdout.write_all(b"LINES-DONE\r\n").unwrap();
    stdout.flush().unwrap();
    line.clear();
    std::io::stdin().read_line(&mut line).unwrap();
    let burst_bytes = if cfg!(debug_assertions) {
        2 * 1024 * 1024
    } else {
        100 * 1024 * 1024
    };
    let burst = vec![b'Z'; burst_bytes];
    stdout.write_all(b"\x1bPthreadterm-stress;").unwrap();
    stdout.write_all(&burst).unwrap();
    stdout.write_all(b"\x1b\\").unwrap();
    stdout.flush().unwrap();
}

#[test]
#[ignore = "subprocess fixture; invoked by the real ConPTY close test"]
fn pty_child_wait() {
    let mut byte = [0_u8; 1];
    loop {
        if std::io::stdin().read(&mut byte).unwrap_or(0) == 0 {
            return;
        }
    }
}

#[test]
#[ignore = "subprocess fixture; invoked by the natural-exit test"]
fn pty_child_exit() {
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).unwrap();
    std::io::stdout().write_all(b"natural-exit\r\n").unwrap();
}

#[test]
#[ignore = "subprocess fixture; invoked by the overflow/resync test"]
fn pty_child_burst_exit() {
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).unwrap();
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(&vec![b'Z'; 512 * 1024]).unwrap();
    stdout.write_all(b"\r\nFINAL-SNAPSHOT\r\n").unwrap();
    stdout.flush().unwrap();
}

#[test]
#[ignore = "subprocess fixture; invoked by the unattached-exit test"]
fn pty_child_auto_exit() {
    std::io::stdout()
        .write_all(b"unattached-natural-exit\r\n")
        .unwrap();
}
