//! The page's reports of its path to a host, logged here for whoever runs the server: why a
//! connect streamed directly, over WebRTC or through the bridge, what a running stream's paths
//! measured, how a move between them went, and where a stream's video frames stopped on their
//! way to the screen. A report holds only addresses, numbers and named reasons, each bounded, so a
//! page can't write free text into the log.

use crate::visitor::Visitor;
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::Deserialize;
use std::fmt::Write as _;
use std::net::IpAddr;

/// A report's largest body, and the most probes one lists: a race dials a handful of addresses.
pub(crate) const MAX_BODY: usize = 4096;
const MAX_PROBES: usize = 16;
/// A time past this is no measurement.
const MAX_MS: f64 = 600_000.0;

#[derive(Deserialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum Report {
    Path {
        probes: Vec<Probe>,
        direct_ms: Option<f64>,
        direct_by: Option<RttBy>,
        webrtc_ms: Option<f64>,
        carrier: Carrier,
        why: Why,
    },
    Move {
        why: MoveWhy,
        from_carrier: Option<Carrier>,
        from: Option<Addr>,
        to_carrier: Option<Carrier>,
        to: Option<Addr>,
        probes: Vec<Probe>,
        ms: f64,
        outcome: Outcome,
    },
    Watch {
        carrier: Carrier,
        current_ms: Option<f64>,
        loaded_ms: Option<f64>,
        direct: Option<Addr>,
        direct_ms: Option<f64>,
        webrtc_ms: Option<f64>,
        move_to: Option<Carrier>,
        #[serde(default)]
        probes: Vec<Probe>,
    },
    Video(Box<Video>),
}

/// Where a stream's frames stopped on their way to the screen; see the page's `VideoReport`.
#[derive(Deserialize, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Video {
    phase: Phase,
    secs: u32,
    carrier: Option<Carrier>,
    codec: Codec,
    width: u32,
    height: u32,
    backend: Backend,
    accel: Accel,
    received: u32,
    not_ready: u32,
    waiting_key: u32,
    keys: u32,
    submitted: u32,
    decoded: u32,
    held: u32,
    dropped: u32,
    presented: u32,
    errors: u32,
    error: Option<Token>,
    first_frame_ms: Option<f64>,
}

/// An error's name, such as `EncodingError`: letters only.
#[derive(Deserialize, Debug, PartialEq)]
#[serde(try_from = "String")]
pub(crate) struct Token(String);

impl TryFrom<String> for Token {
    type Error = &'static str;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        let ok = (1..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphabetic());
        ok.then_some(Token(s)).ok_or("not an error name")
    }
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Probe {
    host: Addr,
    ms: Option<f64>,
    outcome: ProbeOutcome,
}

/// An IP address as the page dials it, IPv6 in brackets or not.
#[derive(Deserialize, Debug, PartialEq)]
#[serde(try_from = "String")]
pub(crate) struct Addr(IpAddr);

impl TryFrom<String> for Addr {
    type Error = &'static str;
    fn try_from(s: String) -> Result<Self, Self::Error> {
        let bare = s
            .strip_prefix('[')
            .and_then(|s| s.strip_suffix(']'))
            .unwrap_or(&s);
        bare.parse().map(Addr).map_err(|_| "not an IP address")
    }
}

macro_rules! named {
    ($name:ident { $($v:ident = $s:literal),+ $(,)? }) => {
        #[derive(Deserialize, Debug, PartialEq, Clone, Copy)]
        pub(crate) enum $name { $(#[serde(rename = $s)] $v),+ }
        impl $name {
            fn as_str(self) -> &'static str {
                match self { $(Self::$v => $s),+ }
            }
        }
    };
}

named!(RttBy { Ping = "ping", Stats = "stats", Handshake = "handshake" });
named!(Phase { Start = "start", End = "end" });
named!(Codec { H264 = "h264", Hevc = "hevc", Av1 = "av1", Rtp = "rtp", Nothing = "none" });
named!(Backend { Webgpu = "webgpu", Webgl2 = "webgl2", Rtp = "rtp", Nothing = "none" });
named!(Accel {
    Hardware = "prefer-hardware",
    Software = "prefer-software",
    Either = "no-preference",
    Browser = "browser",
});
named!(Carrier { Wt = "wt", Rtc = "rtc", Ws = "ws", Nothing = "none" });
named!(Why {
    Pinned = "pinned",
    Door = "door",
    Start = "start",
    BridgeBefore = "bridge-before",
    NoWebTransport = "no-webtransport",
    NoAddress = "no-address",
    DirectClose = "direct-close",
    DirectUnpinged = "direct-unpinged",
    WebrtcFaster = "webrtc-faster",
    DirectFaster = "direct-faster",
    Direct = "direct",
    NoDirect = "no-direct",
    NoPath = "no-path",
});
named!(MoveWhy { Lost = "lost", Stall = "stall", Better = "better" });
named!(Outcome { Moved = "moved", NoPath = "no-path", NotTaken = "not-taken", Gone = "gone" });
named!(ProbeOutcome { Open = "open", Refused = "refused", Late = "late" });

impl Report {
    fn probes(&self) -> &[Probe] {
        match self {
            Report::Path { probes, .. } | Report::Move { probes, .. } => probes,
            Report::Watch { probes, .. } => probes,
            Report::Video(_) => &[],
        }
    }

    /// Whether every count and time is in bounds.
    fn sane(&self) -> bool {
        let ms = |t: f64| t.is_finite() && (0.0..=MAX_MS).contains(&t);
        let opt = |t: Option<f64>| t.is_none_or(ms);
        let probes = self.probes();
        probes.len() <= MAX_PROBES
            && probes.iter().all(|p| opt(p.ms))
            && match self {
                Report::Path {
                    direct_ms,
                    webrtc_ms,
                    ..
                } => opt(*direct_ms) && opt(*webrtc_ms),
                Report::Move { ms: t, .. } => ms(*t),
                Report::Watch {
                    current_ms,
                    loaded_ms,
                    direct_ms,
                    webrtc_ms,
                    ..
                } => opt(*current_ms) && opt(*loaded_ms) && opt(*direct_ms) && opt(*webrtc_ms),
                Report::Video(v) => opt(v.first_frame_ms),
            }
    }
}

/// The probes as one field: `addr=outcome@ms`, space-separated.
fn probes_field(probes: &[Probe]) -> String {
    let mut out = String::new();
    for p in probes {
        if !out.is_empty() {
            out.push(' ');
        }
        let _ = write!(out, "{}={}", p.host.0, p.outcome.as_str());
        if let Some(ms) = p.ms {
            let _ = write!(out, "@{}ms", ms.round());
        }
    }
    out
}

fn ms_field(t: Option<f64>) -> String {
    t.map_or_else(|| "-".into(), |t| format!("{}", t.round()))
}

fn addr_field(a: &Option<Addr>) -> String {
    a.as_ref().map_or_else(|| "-".into(), |a| a.0.to_string())
}

/// `POST /diag`: log one report of the page's.
pub(crate) async fn report(
    Extension(visitor): Extension<Visitor>,
    Json(r): Json<Report>,
) -> StatusCode {
    if !r.sane() {
        return StatusCode::UNPROCESSABLE_ENTITY;
    }
    let browser = visitor.addr.map_or_else(|| "-".into(), |a| a.to_string());
    let probes = probes_field(r.probes());
    match &r {
        Report::Path {
            direct_ms,
            direct_by,
            webrtc_ms,
            carrier,
            why,
            ..
        } => tracing::info!(
            %browser,
            carrier = carrier.as_str(),
            why = why.as_str(),
            direct_ms = %ms_field(*direct_ms),
            direct_by = direct_by.map_or("-", RttBy::as_str),
            webrtc_ms = %ms_field(*webrtc_ms),
            %probes,
            "browser chose its path"
        ),
        Report::Video(v) => tracing::info!(
            %browser,
            phase = v.phase.as_str(),
            secs = v.secs,
            carrier = v.carrier.map_or("-", Carrier::as_str),
            codec = v.codec.as_str(),
            size = %format!("{}x{}", v.width, v.height),
            backend = v.backend.as_str(),
            accel = v.accel.as_str(),
            received = v.received,
            not_ready = v.not_ready,
            waiting_key = v.waiting_key,
            keys = v.keys,
            submitted = v.submitted,
            decoded = v.decoded,
            held = v.held,
            dropped = v.dropped,
            presented = v.presented,
            errors = v.errors,
            error = v.error.as_ref().map_or("-", |t| t.0.as_str()),
            first_frame_ms = %ms_field(v.first_frame_ms),
            "browser video"
        ),
        Report::Move {
            why,
            from_carrier,
            from,
            to_carrier,
            to,
            ms,
            outcome,
            ..
        } => tracing::info!(
            %browser,
            why = why.as_str(),
            outcome = outcome.as_str(),
            from_carrier = from_carrier.map_or("-", Carrier::as_str),
            from = %addr_field(from),
            to_carrier = to_carrier.map_or("-", Carrier::as_str),
            to = %addr_field(to),
            ms = %ms_field(Some(*ms)),
            %probes,
            "browser moved its stream"
        ),
        Report::Watch {
            carrier,
            current_ms,
            loaded_ms,
            direct,
            direct_ms,
            webrtc_ms,
            move_to,
            ..
        } => tracing::info!(
            %browser,
            carrier = carrier.as_str(),
            current_ms = %ms_field(*current_ms),
            loaded_ms = %ms_field(*loaded_ms),
            direct = %addr_field(direct),
            direct_ms = %ms_field(*direct_ms),
            webrtc_ms = %ms_field(*webrtc_ms),
            move_to = move_to.map_or("-", Carrier::as_str),
            %probes,
            "browser watched its paths"
        ),
    }
    StatusCode::NO_CONTENT
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Result<Report, serde_json::Error> {
        serde_json::from_str(json)
    }

    #[test]
    fn a_path_report_reads_and_its_probes_print_on_one_line() {
        let r = parse(
            r#"{"kind":"path","probes":[{"host":"192.168.1.21","ms":null,"outcome":"late"},
                {"host":"[2001:db8::21]","ms":12.4,"outcome":"open"}],
                "direct_ms":6.2,"direct_by":"stats","webrtc_ms":null,"carrier":"wt","why":"direct-close"}"#,
        )
        .unwrap();
        assert!(r.sane());
        assert_eq!(
            probes_field(r.probes()),
            "192.168.1.21=late 2001:db8::21=open@12ms"
        );
    }

    #[test]
    fn a_move_report_reads() {
        let r = parse(
            r#"{"kind":"move","why":"stall","from_carrier":"wt","from":"192.168.1.21",
                "to_carrier":null,"to":null,"probes":[],"ms":3001,"outcome":"no-path"}"#,
        )
        .unwrap();
        assert!(r.sane());
        let better = parse(
            r#"{"kind":"move","why":"better","from_carrier":"rtc","from":null,
                "to_carrier":"wt","to":"100.64.7.7","probes":[],"ms":180,"outcome":"moved"}"#,
        )
        .unwrap();
        assert!(better.sane());
    }

    #[test]
    fn a_watch_report_reads() {
        let w = parse(
            r#"{"kind":"watch","carrier":"wt","current_ms":120,"loaded_ms":300,"direct":"192.168.1.21",
                "direct_ms":120,"webrtc_ms":30,"move_to":"rtc",
                "probes":[{"host":"100.81.0.1","ms":null,"outcome":"late"}]}"#,
        )
        .unwrap();
        assert!(w.sane());
        let far = parse(
            r#"{"kind":"watch","carrier":"wt","current_ms":-1,"direct":null,"direct_ms":null,
                "webrtc_ms":null,"move_to":null}"#,
        )
        .unwrap();
        assert!(!far.sane(), "a negative round trip");
    }

    #[test]
    fn a_pinged_path_and_a_video_report_read() {
        let r = parse(
            r#"{"kind":"path","probes":[],"direct_ms":4,"direct_by":"ping","webrtc_ms":5,
                "carrier":"wt","why":"direct-close"}"#,
        )
        .unwrap();
        assert!(r.sane());
        let older = parse(
            r#"{"kind":"path","probes":[],"direct_ms":20,"direct_by":"handshake","webrtc_ms":null,
                "carrier":"wt","why":"direct-unpinged"}"#,
        );
        assert!(older.is_ok(), "a host that answers no pings");
        let v = parse(
            r#"{"kind":"video","phase":"start","secs":5,"carrier":"wt","codec":"hevc","width":886,
                "height":1972,"backend":"webgl2","accel":"prefer-hardware","received":300,
                "not_ready":0,"waiting_key":290,"keys":0,"submitted":0,"decoded":0,"held":0,
                "dropped":0,"presented":0,"errors":1,"error":"EncodingError","first_frame_ms":null}"#,
        )
        .unwrap();
        assert!(v.sane());
        assert!(parse(
            r#"{"kind":"path","probes":[],"direct_ms":null,"direct_by":"guess","webrtc_ms":null,
                "carrier":"wt","why":"direct"}"#
        )
        .is_err());
        assert!(parse(
            r#"{"kind":"video","phase":"end","secs":5,"carrier":null,"codec":"hevc","width":1,
                "height":1,"backend":"none","accel":"browser","received":0,"not_ready":0,
                "waiting_key":0,"keys":0,"submitted":0,"decoded":0,"held":0,"dropped":0,
                "presented":0,"errors":1,"error":"two words","first_frame_ms":null}"#
        )
        .is_err());
    }

    #[test]
    fn a_report_with_text_of_its_own_is_refused() {
        for junk in [
            // A name, not an address.
            r#"{"kind":"move","why":"lost","from":"evil\nline","probes":[],"to":null,"ms":1,"outcome":"gone"}"#,
            // A reason the page never gives.
            r#"{"kind":"path","probes":[],"direct_ms":null,"webrtc_ms":null,"carrier":"wt","why":"because"}"#,
            // A field the page never sends.
            r#"{"kind":"path","probes":[],"direct_ms":null,"webrtc_ms":null,"carrier":"wt","why":"direct","note":"x"}"#,
        ] {
            assert!(parse(junk).is_err(), "{junk}");
        }
        let far = parse(
            r#"{"kind":"path","probes":[],"direct_ms":1e12,"webrtc_ms":null,"carrier":"wt","why":"direct"}"#,
        )
        .unwrap();
        assert!(!far.sane(), "a time past any measurement");
    }
}
