use super::StartupSideEffects;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ProjectionDecision {
    LegacyPassThrough,
    AcceptIncoming,
    MergeSamePty,
    AcceptReconfigure,
    RejectStale,
}

pub(super) fn classify_projection(
    current_pty_id: &str,
    incoming_pty_id: &str,
    current: Option<&StartupSideEffects>,
    incoming: Option<&StartupSideEffects>,
) -> Result<ProjectionDecision, String> {
    if current_pty_id.is_empty() || incoming_pty_id.is_empty() {
        return Err("projection PTY id must not be empty".to_string());
    }
    match (current, incoming) {
        (None, None) => Ok(ProjectionDecision::LegacyPassThrough),
        (None, Some(_)) => Ok(ProjectionDecision::AcceptIncoming),
        (Some(_), None) if current_pty_id == incoming_pty_id => {
            Ok(ProjectionDecision::MergeSamePty)
        }
        (Some(_), None) => Ok(ProjectionDecision::RejectStale),
        (Some(current), Some(incoming)) if current_pty_id == incoming_pty_id => {
            if current.projection_epoch == incoming.projection_epoch {
                Ok(ProjectionDecision::MergeSamePty)
            } else {
                Ok(ProjectionDecision::RejectStale)
            }
        }
        (Some(current), Some(incoming))
            if incoming.parent_projection_epoch.as_deref()
                == Some(current.projection_epoch.as_str())
                && incoming.projection_epoch != current.projection_epoch =>
        {
            Ok(ProjectionDecision::AcceptReconfigure)
        }
        (Some(_), Some(_)) => Ok(ProjectionDecision::RejectStale),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn projection(epoch: &str, parent: Option<&str>) -> StartupSideEffects {
        StartupSideEffects {
            schema: 1,
            projection_epoch: epoch.to_string(),
            parent_projection_epoch: parent.map(str::to_string),
            applied: Vec::new(),
        }
    }

    #[test]
    fn projection_truth_table_covers_legacy_first_and_missing_incoming() {
        let current = projection("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", None);
        let incoming = projection("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", None);
        assert_eq!(
            classify_projection("pty", "pty", None, None).unwrap(),
            ProjectionDecision::LegacyPassThrough
        );
        assert_eq!(
            classify_projection("pty", "pty", None, Some(&incoming)).unwrap(),
            ProjectionDecision::AcceptIncoming
        );
        assert_eq!(
            classify_projection("pty", "pty", Some(&current), None).unwrap(),
            ProjectionDecision::MergeSamePty
        );
        assert_eq!(
            classify_projection("old", "new", Some(&current), None).unwrap(),
            ProjectionDecision::RejectStale
        );
    }

    #[test]
    fn same_pty_requires_same_epoch_and_ignores_parent_spoof() {
        let current = projection("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", None);
        let same = projection(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            Some(&current.projection_epoch),
        );
        let stale = projection(
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            Some(&current.projection_epoch),
        );
        assert_eq!(
            classify_projection("pty", "pty", Some(&current), Some(&same)).unwrap(),
            ProjectionDecision::MergeSamePty
        );
        assert_eq!(
            classify_projection("pty", "pty", Some(&current), Some(&stale)).unwrap(),
            ProjectionDecision::RejectStale
        );
    }

    #[test]
    fn different_pty_requires_current_parent_and_new_epoch() {
        let current = projection("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", None);
        let legal = projection(
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            Some(&current.projection_epoch),
        );
        let missing_parent = projection("cccccccccccccccccccccccccccccccc", None);
        let sibling = projection(
            "dddddddddddddddddddddddddddddddd",
            Some("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
        );
        let same_epoch = projection(&current.projection_epoch, Some(&current.projection_epoch));
        assert_eq!(
            classify_projection("old", "new", Some(&current), Some(&legal)).unwrap(),
            ProjectionDecision::AcceptReconfigure
        );
        assert_eq!(
            classify_projection("old", "new", Some(&current), Some(&missing_parent)).unwrap(),
            ProjectionDecision::RejectStale
        );
        assert_eq!(
            classify_projection("old", "new", Some(&current), Some(&sibling)).unwrap(),
            ProjectionDecision::RejectStale
        );
        assert_eq!(
            classify_projection("old", "new", Some(&current), Some(&same_epoch)).unwrap(),
            ProjectionDecision::RejectStale
        );
    }

    #[test]
    fn empty_pty_ids_return_errors_without_panicking() {
        let projection = projection("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", None);
        assert!(classify_projection("", "pty", None, Some(&projection)).is_err());
        assert!(classify_projection("pty", "", Some(&projection), None).is_err());
    }
}
