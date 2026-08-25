use super::marker::{ReadyMarkerFilter, STARTUP_MARKER_INVALID, STARTUP_MARKER_MAX_TAIL};

const NONCE: &str = "0123456789abcdef0123456789abcdef";
const BODY: &[u8] = b"\x1b]777;threadterm;ready;";

fn marker(terminator: &[u8]) -> Vec<u8> {
    let mut bytes = BODY.to_vec();
    bytes.extend_from_slice(NONCE.as_bytes());
    bytes.extend_from_slice(terminator);
    bytes
}

#[test]
fn validates_lowercase_nonce_without_echoing_it() {
    for nonce in ["", "ABCDEF0123456789ABCDEF0123456789", "0123"] {
        assert_eq!(
            ReadyMarkerFilter::new(nonce).err(),
            Some(STARTUP_MARKER_INVALID)
        );
    }
}

#[test]
fn filters_bel_and_seven_bit_st_markers() {
    let mut filter = ReadyMarkerFilter::new(NONCE).unwrap();
    let bel = filter.consume(&marker(b"\x07"));
    assert!(bel.visible.is_empty());
    assert_eq!(bel.matched, 1);
    let st = filter.consume(&marker(b"\x1b\\"));
    assert!(st.visible.is_empty());
    assert_eq!(st.matched, 1);
    let opaque = filter.consume(&[0x9c]);
    assert_eq!(opaque.visible, vec![0x9c]);
    assert_eq!(opaque.matched, 0);
}

#[test]
fn filters_when_split_at_every_byte() {
    let mut input = b"before".to_vec();
    input.extend(marker(b"\x07"));
    input.extend_from_slice(b"after");
    let mut filter = ReadyMarkerFilter::new(NONCE).unwrap();
    let mut visible = Vec::new();
    let mut matched = 0;
    for byte in input.iter() {
        let output = filter.consume(std::slice::from_ref(byte));
        visible.extend(output.visible);
        matched += output.matched;
        assert!(filter.buffered_len() <= STARTUP_MARKER_MAX_TAIL);
    }
    assert_eq!(visible, b"beforeafter");
    assert_eq!(matched, 1);
}

#[test]
fn wrong_nonce_and_malformed_terminator_are_opaque() {
    let mut wrong = BODY.to_vec();
    wrong.extend_from_slice(&[b'f'; 32]);
    wrong.push(0x07);
    let mut malformed = BODY.to_vec();
    malformed.extend_from_slice(NONCE.as_bytes());
    malformed.extend_from_slice(b"\x1bXunfinished");
    let mut filter = ReadyMarkerFilter::new(NONCE).unwrap();
    let wrong_out = filter.consume(&wrong);
    assert_eq!(wrong_out.visible, wrong);
    assert_eq!(wrong_out.matched, 0);
    let malformed_out = filter.consume(&malformed);
    let eof = filter.finish();
    let mut visible = malformed_out.visible;
    visible.extend(eof.visible);
    assert_eq!(visible, malformed);
}

#[test]
fn adjacent_markers_and_eof_flush_preserve_order() {
    let first = marker(b"\x07");
    let second = marker(b"\x1b\\");
    let mut adjacent = b"A".to_vec();
    adjacent.extend_from_slice(&first);
    adjacent.extend_from_slice(&second);
    adjacent.push(b'Z');
    let mut filter = ReadyMarkerFilter::new(NONCE).unwrap();
    let output = filter.consume(&adjacent);
    assert_eq!(output.visible, b"AZ");
    assert_eq!(output.matched, 2);

    let incomplete = marker(b"\x07");
    let split = incomplete.len() - 1;
    let _ = filter.consume(&incomplete[..split]);
    assert_eq!(filter.buffered_len(), split);
    let eof = filter.finish();
    assert_eq!(eof.visible, &incomplete[..split]);
    assert_eq!(eof.matched, 0);
    filter.reset();
    assert_eq!(filter.buffered_len(), 0);
}

#[test]
fn nested_osc_dcs_and_utf8_are_not_filtered() {
    let owned = marker(b"\x07");
    let mut osc = b"\x1b]0;payload ".to_vec();
    osc.push(0x9c);
    osc.extend_from_slice(&owned);
    osc.extend_from_slice(b"\x07");
    let mut dcs = b"\x1bPpayload ".to_vec();
    dcs.push(0x9c);
    dcs.extend_from_slice(&owned);
    dcs.extend_from_slice(b"\x1b\\");
    let mut input = "中文🙂".as_bytes().to_vec();
    input.extend_from_slice(&osc);
    input.extend_from_slice(&dcs);
    let mut filter = ReadyMarkerFilter::new(NONCE).unwrap();
    let output = filter.consume(&input);
    assert_eq!(output.visible, input);
    assert_eq!(output.matched, 0);
}

#[test]
fn adversarial_prefix_stays_bounded() {
    let mut input = BODY.to_vec();
    input.extend(std::iter::repeat(b'a').take(32_768));
    let mut filter = ReadyMarkerFilter::new(NONCE).unwrap();
    let output = filter.consume(&input);
    assert_eq!(output.visible, input);
    assert_eq!(output.matched, 0);
    assert!(filter.buffered_len() <= STARTUP_MARKER_MAX_TAIL);
}
