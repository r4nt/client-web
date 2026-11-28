//! The host resizing the stream's datagrams. A shrink applies at once; a grow waits for this
//! page's ack, which every size gets: the page reassembles any shard up to the protocol's
//! largest, whatever `Welcome` said.

use punktfunk_core::quic::v2::msg::V2Message;
use punktfunk_core::quic::{ShardPayloadAck, ShardPayloadChanged};

/// The frame type a resize comes as.
pub(crate) const CHANGED: u64 = ShardPayloadChanged::TYPE;

/// The ack for the resize `body` (a `ShardPayloadChanged`'s); `None` for a body that is none.
pub(crate) fn ack(body: &[u8]) -> Option<Vec<u8>> {
    let changed = ShardPayloadChanged::from_body(body).ok()?;
    Some(
        ShardPayloadAck {
            shard_payload: changed.shard_payload,
        }
        .encode_v2(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use punktfunk_core::quic::v2::field::split_frame;
    use punktfunk_core::quic::v2::registry as reg;

    #[test]
    fn every_resize_is_acked_with_its_size() {
        let changed = ShardPayloadChanged { shard_payload: 1400 }.encode_v2();
        let (ty, body, _) = split_frame(&changed, reg::max_body).unwrap().unwrap();
        assert_eq!(ty, CHANGED);
        let ack = ack(body).expect("an ack");
        let (ty, body, _) = split_frame(&ack, reg::max_body).unwrap().unwrap();
        assert_eq!(ty, ShardPayloadAck::TYPE);
        assert_eq!(ShardPayloadAck::from_body(body).unwrap().shard_payload, 1400);
        assert!(super::ack(&[0xff]).is_none(), "a body that is no resize");
    }
}
