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
                "This runtime requires desktop contract {PROTOCOL_CONTRACT} for choice-based Chat approvals, but the desktop uses {contract}. Running jobs were not stopped."
            ),
            ContractRole::Desktop => format!(
                "This desktop requires runtime contract {PROTOCOL_CONTRACT} for choice-based Chat approvals, but the runtime uses {contract}. The existing runtime was left running."
            ),
        }),
        None => Some(match role {
            ContractRole::Runtime => format!(
                "This runtime requires desktop contract {PROTOCOL_CONTRACT} for choice-based Chat approvals. This client is older. Update the ThreadTerm desktop. Running jobs were not stopped."
            ),
            ContractRole::Desktop => format!(
                "This desktop requires runtime contract {PROTOCOL_CONTRACT} for choice-based Chat approvals. The connected runtime is older and was left running. Update ThreadTerm, or quit the old runtime from the tray before retrying."
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
}
