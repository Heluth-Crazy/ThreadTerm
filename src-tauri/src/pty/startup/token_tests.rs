use std::collections::HashSet;

use super::{mint_generation, validate_generation};

#[test]
fn generation_is_lowercase_hex_and_valid() {
    let generation = mint_generation().expect("OS CSPRNG should be available");

    assert_eq!(generation.len(), 32);
    assert!(generation
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    assert!(validate_generation(&generation).is_ok());
}

#[test]
fn batch_generations_are_unique() {
    let generations: HashSet<_> = (0..256)
        .map(|_| mint_generation().expect("OS CSPRNG should be available"))
        .collect();

    assert_eq!(generations.len(), 256);
}
