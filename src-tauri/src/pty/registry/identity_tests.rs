use std::sync::Arc;

use dashmap::DashMap;

use super::{is_current_in_map, remove_if_same_from_map};

#[test]
fn same_arc_is_current() {
    let sessions = DashMap::new();
    let current = Arc::new("current");
    sessions.insert("same".to_string(), Arc::clone(&current));

    assert!(is_current_in_map(&sessions, "same", &current));
}

#[test]
fn stale_arc_is_not_current_for_a_replacement() {
    let sessions = DashMap::new();
    let stale = Arc::new("stale");
    let replacement = Arc::new("replacement");
    sessions.insert("same".to_string(), Arc::clone(&replacement));

    assert!(!is_current_in_map(&sessions, "same", &stale));
}

#[test]
fn unknown_id_is_not_current() {
    let sessions = DashMap::<String, Arc<&str>>::new();
    let expected = Arc::new("missing");

    assert!(!is_current_in_map(&sessions, "unknown", &expected));
}

#[test]
fn same_arc_is_removed_atomically() {
    let sessions = DashMap::new();
    let current = Arc::new("current");
    sessions.insert("same".to_string(), Arc::clone(&current));

    let removed = remove_if_same_from_map(&sessions, "same", &current)
        .expect("the matching Arc should be removed");
    assert!(Arc::ptr_eq(&current, &removed));
    assert!(!sessions.contains_key("same"));
}

#[test]
fn stale_arc_preserves_a_replacement() {
    let sessions = DashMap::new();
    let stale = Arc::new("stale");
    let replacement = Arc::new("replacement");
    sessions.insert("same".to_string(), Arc::clone(&replacement));

    assert!(remove_if_same_from_map(&sessions, "same", &stale).is_none());
    let retained = sessions.get("same").expect("replacement must remain");
    assert!(Arc::ptr_eq(retained.value(), &replacement));
}

#[test]
fn unknown_id_is_a_no_op() {
    let sessions = DashMap::<String, Arc<&str>>::new();
    let expected = Arc::new("missing");

    assert!(remove_if_same_from_map(&sessions, "unknown", &expected).is_none());
    assert!(sessions.is_empty());
}
