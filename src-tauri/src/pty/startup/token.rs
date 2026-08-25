const GENERATION_BYTES: usize = 16;

pub const STARTUP_GENERATION_FAILED: &str = "startup_generation_failed";

/// Mint a generation identifier from the operating system CSPRNG.
pub fn mint_generation() -> Result<String, String> {
    let mut bytes = [0u8; GENERATION_BYTES];
    getrandom::getrandom(&mut bytes).map_err(|_| STARTUP_GENERATION_FAILED.to_owned())?;

    let mut generation = String::with_capacity(GENERATION_BYTES * 2);
    for byte in bytes {
        generation.push(hex_digit(byte >> 4));
        generation.push(hex_digit(byte & 0x0f));
    }
    Ok(generation)
}

fn hex_digit(nibble: u8) -> char {
    let digit = if nibble < 10 {
        b'0' + nibble
    } else {
        b'a' + nibble - 10
    };
    digit as char
}
