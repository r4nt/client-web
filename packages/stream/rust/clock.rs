//! The stream's round trip under load: a `ClockProbe` on the control stream, which the host
//! echoes at once. Its bytes queue behind the video on the way, as a relay that buffers holds
//! them, so the round trip it measures is the one the stream sees, not an idle path's.

use punktfunk_core::quic::v2::msg::V2Message;
use punktfunk_core::quic::{ClockEcho, ClockProbe};

/// The probe sent at `t1_ms` on the page's clock, which the echo hands back.
pub(crate) fn probe(t1_ms: f64) -> Vec<u8> {
    ClockProbe {
        t1_ns: (t1_ms.max(0.0) * 1e6) as u64,
    }
    .encode_v2()
}

/// When the probe that `body` (a `ClockEcho`'s) answers was sent, in ms on the page's clock.
pub(crate) fn echoed(body: &[u8]) -> Option<f64> {
    ClockEcho::from_body(body).ok().map(|e| e.t1_ns as f64 / 1e6)
}

/// The frame type an echo comes as.
pub(crate) const ECHO: u64 = ClockEcho::TYPE;

#[cfg(test)]
mod tests {
    use super::*;
    use punktfunk_core::quic::v2::field::split_frame;
    use punktfunk_core::quic::v2::registry as reg;

    #[test]
    fn an_echo_hands_back_when_its_probe_went() {
        let frame = probe(1234.5);
        let (ty, body, _) = split_frame(&frame, reg::max_body).unwrap().unwrap();
        assert_eq!(ty, ClockProbe::TYPE);
        let t1 = ClockProbe::from_body(body).unwrap().t1_ns;
        let echo = ClockEcho { t1_ns: t1, t2_ns: 9, t3_ns: 10 }.encode_v2();
        let (ty, body, _) = split_frame(&echo, reg::max_body).unwrap().unwrap();
        assert_eq!(ty, ECHO);
        assert_eq!(echoed(body), Some(1234.5));
        assert_eq!(echoed(&[0xff]), None, "a body that is no echo");
    }
}
