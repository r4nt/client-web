//! The page's side of a handover: the running session moves to a second connection.
//!
//! The new connection's control stream carries `Handover` with the session's id, then the
//! device's answer to the host's challenge, as a first connect does. [`Asking`] reads what the
//! host says back on it until `HandoverAck`. The bytes after the ack are the session's next
//! control frames: they wait until the old connection's control stream has ended, so frames
//! stay in the order the host sent them.

use punktfunk_core::error::PunktfunkError;
use punktfunk_core::quic::v2::field::split_frame;
use punktfunk_core::quic::v2::msg::{Handover, HandoverAck, V2Message};
use punktfunk_core::quic::v2::registry as reg;
use punktfunk_core::quic::{AuthChallenge, Refused};

/// The `Handover` frame that opens the new connection's control stream.
pub(crate) fn ask(session: [u8; 16]) -> Vec<u8> {
    Handover { session }.encode_v2()
}

/// What the host said on the new connection.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Heard {
    /// Prove the device key over this nonce.
    Challenge([u8; 32]),
    /// The session runs on the new connection; the bytes that followed the ack.
    Moved(Vec<u8>),
    /// No session moved: a refusal, or a frame this page can't read.
    Refused,
}

/// The new connection's control stream, read until the host has answered the handover.
#[derive(Default)]
pub(crate) struct Asking {
    inbox: Vec<u8>,
}

impl Asking {
    /// Read `bytes`, in whatever chunks they arrived. Returns what the whole frames said; after
    /// `Moved` or `Refused` nothing more is read.
    pub(crate) fn hear(&mut self, bytes: &[u8]) -> Vec<Heard> {
        self.inbox.extend_from_slice(bytes);
        let mut heard = Vec::new();
        loop {
            match self.next() {
                Ok(Some(h @ (Heard::Moved(_) | Heard::Refused))) => {
                    heard.push(h);
                    return heard;
                }
                Ok(Some(h)) => heard.push(h),
                Ok(None) => return heard,
                Err(_) => {
                    heard.push(Heard::Refused);
                    return heard;
                }
            }
        }
    }

    fn next(&mut self) -> Result<Option<Heard>, PunktfunkError> {
        let Some((ty, body, used)) = split_frame(&self.inbox, reg::max_body)? else {
            return Ok(None);
        };
        let heard = match ty {
            AuthChallenge::TYPE => Some(Heard::Challenge(AuthChallenge::from_body(body)?.nonce)),
            HandoverAck::TYPE => Some(Heard::Moved(self.inbox[used..].to_vec())),
            Refused::TYPE => Some(Heard::Refused),
            // Nothing else comes before the ack; an unknown frame is skipped.
            _ => None,
        };
        self.inbox.drain(..used);
        match heard {
            Some(h) => Ok(Some(h)),
            None => self.next(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use punktfunk_core::quic::v2::hello::Ready;

    #[test]
    fn the_ask_names_the_session() {
        let frame = ask([7; 16]);
        let (ty, body, _) = split_frame(&frame, reg::max_body).unwrap().unwrap();
        assert_eq!(ty, Handover::TYPE);
        assert_eq!(Handover::from_body(body).unwrap().session, [7; 16]);
    }

    #[test]
    fn a_challenge_then_the_ack_moves_and_keeps_what_followed() {
        let mut a = Asking::default();
        let challenge = AuthChallenge { nonce: [5; 32] }.encode_v2();
        let (first, rest) = challenge.split_at(10);
        assert!(a.hear(first).is_empty(), "half a frame says nothing");
        assert_eq!(a.hear(rest), vec![Heard::Challenge([5; 32])]);
        let next = Ready {}.encode_v2();
        let mut chunk = HandoverAck {}.encode_v2();
        chunk.extend_from_slice(&next);
        assert_eq!(a.hear(&chunk), vec![Heard::Moved(next)]);
    }

    #[test]
    fn a_refusal_or_an_unreadable_frame_moves_nothing() {
        let refused = Refused {
            code: 0x54,
            ..Default::default()
        };
        assert_eq!(Asking::default().hear(&refused.encode_v2()), vec![Heard::Refused]);
        // A length past the frame type's bound.
        let junk = [0x0f, 0x80, 0xff, 0xff, 0xff];
        assert_eq!(Asking::default().hear(&junk), vec![Heard::Refused]);
    }
}
