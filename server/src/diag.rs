//! The page's reports of its path to a host, logged here for whoever runs the server: why a
//! connect streamed directly, over WebRTC or through the bridge, and how a move of a running
//! stream went. A report holds only addresses, numbers and named reasons, each bounded, so a
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
        webrtc_ms: Option<f64>,
        carrier: Carrier,
        why: Why,
    },
    Move {
        why: MoveWhy,
        from: Option<Addr>,
        probes: Vec<Probe>,
        to: Option<Addr>,
        ms: f64,
        outcome: Outcome,
    },
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

named!(Carrier { Wt = "wt", Rtc = "rtc", Ws = "ws", Nothing = "none" });
named!(Why {
    Pinned = "pinned",
    BridgeBefore = "bridge-before",
    NoWebTransport = "no-webtransport",
    NoAddress = "no-address",
    DirectClose = "direct-close",
    WebrtcFaster = "webrtc-faster",
    DirectFaster = "direct-faster",
    Direct = "direct",
    NoDirect = "no-direct",
    NoPath = "no-path",
});
named!(MoveWhy { Lost = "lost", Stall = "stall" });
named!(Outcome { Moved = "moved", NoPath = "no-path", NotTaken = "not-taken", Gone = "gone" });
named!(ProbeOutcome { Open = "open", Refused = "refused", Late = "late" });

impl Report {
    fn probes(&self) -> &[Probe] {
        match self {
            Report::Path { probes, .. } | Report::Move { probes, .. } => probes,
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
            webrtc_ms,
            carrier,
            why,
            ..
        } => tracing::info!(
            %browser,
            carrier = carrier.as_str(),
            why = why.as_str(),
            direct_ms = %ms_field(*direct_ms),
            webrtc_ms = %ms_field(*webrtc_ms),
            %probes,
            "browser chose its path"
        ),
        Report::Move {
            why,
            from,
            to,
            ms,
            outcome,
            ..
        } => tracing::info!(
            %browser,
            why = why.as_str(),
            outcome = outcome.as_str(),
            from = %addr_field(from),
            to = %addr_field(to),
            ms = %ms_field(Some(*ms)),
            %probes,
            "browser moved its stream"
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
                "direct_ms":6.2,"webrtc_ms":null,"carrier":"wt","why":"direct-close"}"#,
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
            r#"{"kind":"move","why":"stall","from":"192.168.1.21","probes":[],"to":null,
                "ms":3001,"outcome":"no-path"}"#,
        )
        .unwrap();
        assert!(r.sane());
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
