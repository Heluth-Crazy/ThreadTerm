//! Handshake-level Chat contract checks.
//!
//! Wire HMAC still uses `PROTOCOL_VERSION`. Incompatible desktops/runtimes are
//! refused before commands run; a live daemon is not killed.

use anyhow::{bail, Result};
use serde_json::Value;

use crate::PROTOCOL_CONTRACT;

pub fn peer_contract(value: &Value) -> Option<u32> {
    value
        .get("contract")
        .and_then(Value::as_u64)
        .map(|value| value as u32)
}

pub fn incompatible_reason(peer: &Value, role: ContractRole) -> Option<String> {
    match peer_contract(peer) {
        Some(contract) if contract == PROTOCOL_CONTRACT => None,
        Some(contract) => Some(match role {
            ContractRole::Runtime => format!(
                "This runtime requires desktop contract {PROTOCOL_CONTRACT} for session documents, worktree setup, agent reviews, prompt queues, Quick Launch, the agent registry, choice-based Chat approvals, scoped browser previews, and Chat fork and feedback, but the desktop uses {contract}. Running jobs were not stopped."
            ),
            ContractRole::Desktop => format!(
                "This desktop requires runtime contract {PROTOCOL_CONTRACT} for session documents, worktree setup, agent reviews, prompt queues, Quick Launch, the agent registry, choice-based Chat approvals, scoped browser previews, and Chat fork and feedback, but the runtime uses {contract}. The existing runtime was left running."
            ),
        }),
        None => Some(match role {
            ContractRole::Runtime => format!(
                "This runtime requires desktop contract {PROTOCOL_CONTRACT} for session documents, worktree setup, agent reviews, prompt queues, Quick Launch, the agent registry, choice-based Chat approvals, scoped browser previews, and Chat fork and feedback. This client is older. Update the ThreadTerm desktop. Running jobs were not stopped."
            ),
            ContractRole::Desktop => format!(
                "This desktop requires runtime contract {PROTOCOL_CONTRACT} for session documents, worktree setup, agent reviews, prompt queues, Quick Launch, the agent registry, choice-based Chat approvals, scoped browser previews, and Chat fork and feedback. The connected runtime is older and was left running. Update ThreadTerm, or quit the old runtime from the tray before retrying."
            ),
        }),
    }
}

pub fn require_peer_contract(peer: &Value, role: ContractRole) -> Result<u32> {
    if let Some(reason) = incompatible_reason(peer, role) {
        bail!(reason);
    }
    Ok(PROTOCOL_CONTRACT)
}

#[derive(Clone, Copy)]
pub enum ContractRole {
    Runtime,
    Desktop,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matching_contract_is_accepted() {
        assert_eq!(
            require_peer_contract(
                &json!({"protocol":1,"contract":PROTOCOL_CONTRACT}),
                ContractRole::Runtime
            )
            .unwrap(),
            PROTOCOL_CONTRACT
        );
    }

    #[test]
    fn missing_contract_is_an_old_client_and_does_not_imply_shutdown() {
        let reason = incompatible_reason(&json!({"protocol":1}), ContractRole::Runtime).unwrap();
        assert!(reason.contains("older"));
        assert!(reason.contains("were not stopped"));
    }

    #[test]
    fn mismatched_contract_is_rejected() {
        let reason =
            incompatible_reason(&json!({"protocol":1,"contract":1}), ContractRole::Desktop)
                .unwrap();
        assert!(reason.contains("left running"));
        assert!(
            require_peer_contract(&json!({"protocol":1,"contract":1}), ContractRole::Runtime)
                .is_err()
        );
    }

    #[test]
    fn registry_contract_rejects_contract_two() {
        assert_eq!(PROTOCOL_CONTRACT, 13);
        assert!(
            require_peer_contract(&json!({"protocol":1,"contract":2}), ContractRole::Runtime)
                .is_err()
        );
        assert!(
            require_peer_contract(&json!({"protocol":1,"contract":2}), ContractRole::Desktop)
                .is_err()
        );
    }

    #[test]
    fn selected_commit_contract_rejects_previous_history_contract() {
        for role in [ContractRole::Runtime, ContractRole::Desktop] {
            assert!(require_peer_contract(&json!({"protocol":1,"contract":11}), role).is_err());
        }
    }

    #[test]
    fn fork_feedback_contract_rejects_the_previous_contract() {
        assert_eq!(PROTOCOL_CONTRACT, 13);
        for role in [ContractRole::Runtime, ContractRole::Desktop] {
            let reason = incompatible_reason(&json!({"protocol": 1, "contract": 12}), role).unwrap();
            assert!(reason.contains("13"));
            assert!(reason.contains("were not stopped") || reason.contains("left running"));
            assert!(require_peer_contract(&json!({"protocol": 1, "contract": 12}), role).is_err());
        }
    }

    #[test]
    fn quick_launch_contract_rejects_contract_three() {
        assert!(
            require_peer_contract(&json!({"protocol":1,"contract":3}), ContractRole::Runtime)
                .is_err()
        );
        assert!(
            require_peer_contract(&json!({"protocol":1,"contract":3}), ContractRole::Desktop)
                .is_err()
        );
    }
}
