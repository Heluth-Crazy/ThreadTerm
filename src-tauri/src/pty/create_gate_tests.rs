use std::sync::Arc;

use super::{acquire_pty_create_gate, PTY_CREATE_GATES};

fn gate_for(id: &str) -> Arc<tokio::sync::Mutex<()>> {
    PTY_CREATE_GATES
        .get(id)
        .expect("create gate should remain registered")
        .value()
        .clone()
}

#[tokio::test]
async fn queued_and_later_acquisitions_keep_the_same_gate_arc() {
    let id = format!("__create_gate_identity_{}__", std::process::id());
    let first = acquire_pty_create_gate(&id).await;
    let original_gate = gate_for(&id);

    let (attempted_tx, attempted_rx) = tokio::sync::oneshot::channel();
    let (acquired_tx, acquired_rx) = tokio::sync::oneshot::channel();
    let waiter_id = id.clone();
    let waiter = tokio::spawn(async move {
        attempted_tx
            .send(())
            .expect("attempt notification receiver");
        let lease = acquire_pty_create_gate(&waiter_id).await;
        let gate = gate_for(&waiter_id);
        acquired_tx.send(gate).expect("acquisition receiver");
        drop(lease);
    });

    attempted_rx.await.expect("waiter should start");
    tokio::task::yield_now().await;
    assert!(
        !waiter.is_finished(),
        "the queued waiter must not enter while the first lease is held"
    );
    assert!(Arc::ptr_eq(&original_gate, &gate_for(&id)));

    drop(first);
    let waited_gate = acquired_rx.await.expect("waiter should acquire");
    assert!(Arc::ptr_eq(&original_gate, &waited_gate));
    waiter.await.expect("waiter task should finish");

    let third = acquire_pty_create_gate(&id).await;
    let later_gate = gate_for(&id);
    assert!(Arc::ptr_eq(&original_gate, &later_gate));
    drop(third);

    // Dropping every lease must not create an opportunity for a replacement
    // gate: the process-lifetime entry remains the identity anchor.
    assert!(Arc::ptr_eq(&original_gate, &gate_for(&id)));
}
