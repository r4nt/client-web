// The plane through the host's own WebRTC peer: the carrier for a page reached through a tunnel,
// where the host's UDP port is out of reach but a direct path can be punched with STUN. Only the
// offer and answer ride the page's HTTPS; the session goes peer to peer.
//
// The host bridges the peer connection into the plane at `port` over loopback, so this speaks
// the WebSocket bridge's framing (`frame.ts`) on the reliable `ctl` channel and sends datagrams
// bare on the lossy `dg` channel. The answer's DTLS fingerprint must be the hash the host's
// identity attests, so a page server or tunnel that rewrites the signalling is refused.

import type { Carrier } from "../emscripten.ts";
import type { Feed } from "./feed.ts";
import { decode, encode, type Frame, TAG } from "./frame.ts";

/** How often the bridge is pinged. Its round trip is what `rttUs` reports. */
const PING_MS = 1000;
/** Pings in a row without a pong before the bridge counts as gone. The host's bridge answers
 *  every one, the first included. */
const UNANSWERED = 10;
/** How long ICE may gather before the offer goes with what it has. A public (`srflx`) candidate
 *  ends the wait early: it is the one a host behind NAT needs to punch through. */
const GATHER_MS = 8000;
/** How long the channels may take to open once the answer is in, unless the plan says: punching
 *  into a home behind NAT from a mobile network can take tens of seconds. */
const OPEN_MS = 90_000;
/** Bytes waiting on `dg` past which a datagram is dropped, as a full UDP buffer drops it. */
const DATAGRAM_BUFFER = 256 * 1024;

/** What the host publishes for its peer, and the plane a session goes to. */
export interface RtcPlan {
  /** `POST` the offer here: the host's `/api/v1/webrtc`, as the page reaches the host's API. */
  signal: string;
  /** The SHA-256 of the host peer's DTLS certificate, lowercase hex, as its identity attests. */
  certHash: string;
  iceServers: string[];
  /** The plane the host bridges this session to, and its certificate hash. */
  port: number;
  planeHash: string;
  /** How long to wait for a path and the channels, in ms. */
  waitMs?: number;
}

/** The `a=fingerprint:sha-256` of `sdp` as lowercase hex without colons, or `null`. */
export function fingerprintOf(sdp: string): string | null {
  const m = /^a=fingerprint:sha-256 ([0-9A-Fa-f:]+)\s*$/m.exec(sdp);
  return m?.[1] ? m[1].replace(/:/g, "").toLowerCase() : null;
}

export class RtcCarrier implements Carrier {
  private pc: RTCPeerConnection | null = null;
  private ctlChannel: RTCDataChannel | null = null;
  private dg: RTCDataChannel | null = null;
  private live = false;
  private ctl = false;
  private ping: ReturnType<typeof setInterval> | undefined;
  private rtt = 0;
  private bridgeRtt = 0;
  private unanswered = 0;

  constructor(
    private readonly feed: Feed,
    private readonly plan: RtcPlan,
    private readonly post: typeof fetch = (input, init) => fetch(input, init),
    private readonly Peer: typeof RTCPeerConnection = RTCPeerConnection,
  ) {}

  open(): Promise<void> {
    const pc = new this.Peer({ iceServers: [{ urls: this.plan.iceServers }] });
    this.pc = pc;
    const ctl = pc.createDataChannel("ctl");
    const dg = pc.createDataChannel("dg", { ordered: false, maxRetransmits: 0 });
    for (const c of [ctl, dg]) c.binaryType = "arraybuffer";
    this.ctlChannel = ctl;
    this.dg = dg;
    return this.connect(pc, ctl, dg).catch((e) => {
      if (this.pc === pc) this.stop();
      pc.close();
      console.error("punktfunk: WebRTC did not open", e);
      throw e;
    });
  }

  private async connect(pc: RTCPeerConnection, ctl: RTCDataChannel, dg: RTCDataChannel): Promise<void> {
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    const offer = pc.localDescription?.sdp;
    if (!offer) throw new Error("no local description");
    const r = await this.post(this.plan.signal, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sdp: offer, port: this.plan.port, hash: this.plan.planeHash }),
    });
    if (!r.ok) throw new Error(`the host answered the offer with ${r.status}`);
    const { sdp } = (await r.json()) as { sdp: string };
    if (fingerprintOf(sdp) !== this.plan.certHash) {
      throw new Error("the answer's DTLS fingerprint is not the one the host attests");
    }
    await pc.setRemoteDescription({ type: "answer", sdp });
    await opened([ctl, dg], this.plan.waitMs ?? OPEN_MS);
    if (this.pc !== pc) throw new Error("closed while opening");
    this.live = true;
    ctl.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (this.pc === pc) this.receive(new Uint8Array(e.data));
    };
    dg.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (this.pc === pc && this.live) this.feed.datagram(new Uint8Array(e.data));
    };
    const lost = () => {
      if (this.pc === pc && this.live) this.end(-1, "");
    };
    ctl.onclose = lost;
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") lost();
    };
    this.ping = setInterval(() => {
      if (this.unanswered >= UNANSWERED) return this.end(-1, "");
      this.unanswered++;
      this.send({ tag: TAG.PING, sentMs: performance.now() });
    }, PING_MS);
    this.openControl();
  }

  sendDatagram(bytes: Uint8Array): boolean {
    const dg = this.dg;
    if (!this.live || dg?.readyState !== "open") return false;
    if (dg.bufferedAmount < DATAGRAM_BUFFER) dg.send(new Uint8Array(bytes));
    return true;
  }

  // The bridge opens the host's control stream on the first tag 1, so it carries the stream-type
  // byte every punktfunk/2 stream opens with; the control stream's is 0.
  openControl(): void {
    if (!this.live || this.ctl) return;
    this.ctl = true;
    this.send({ tag: TAG.CONTROL, bytes: new Uint8Array([0]) });
    this.feed.controlReady();
  }

  sendControl(bytes: Uint8Array): void {
    if (this.ctl) this.send({ tag: TAG.CONTROL, bytes });
  }

  // Tag 3 carries the close code to the host: `QUIT_CLOSE_CODE` ends the title, 0 leaves it
  // running. The peer connection closes a moment later, so the message leaves first.
  close(code?: number): void {
    const pc = this.pc;
    const live = this.live;
    if (live) this.send({ tag: TAG.CLOSE, code: code ?? 0, reason: "" });
    this.stop();
    if (pc) setTimeout(() => pc.close(), live ? 250 : 0);
  }

  rttUs(): number {
    return this.rtt ? this.rtt + this.bridgeRtt : 0;
  }

  private receive(msg: Uint8Array): void {
    const f = decode(msg);
    if (!f) return this.end(-1, "");
    switch (f.tag) {
      case TAG.CONTROL:
        return this.feed.control(f.bytes);
      case TAG.UNI:
        return this.feed.uni(f.bytes);
      case TAG.CLOSE:
        return this.end(f.code, f.reason);
      case TAG.PING: {
        if (f.bridgeRttUs === undefined) return;
        this.unanswered = 0;
        const sample = Math.round((performance.now() - f.sentMs) * 1000);
        this.rtt = this.rtt ? Math.round(this.rtt + (sample - this.rtt) / 8) : sample;
        this.bridgeRtt = f.bridgeRttUs;
        return;
      }
      default:
        return this.end(-1, "");
    }
  }

  /** The session is over: say so once, and let the peer connection go. */
  private end(code: number, reason: string): void {
    const pc = this.pc;
    this.stop();
    pc?.close();
    this.feed.closed(code, reason);
  }

  private send(f: Frame): void {
    if (this.ctlChannel?.readyState === "open") this.ctlChannel.send(encode(f));
  }

  private stop(): void {
    clearInterval(this.ping);
    this.pc = null;
    this.ctlChannel = null;
    this.dg = null;
    this.live = false;
    this.ctl = false;
    this.rtt = 0;
    this.bridgeRtt = 0;
    this.unanswered = 0;
  }
}

/** ICE gathering done, a public candidate found, or `GATHER_MS` gone: the offer carries what
 *  was found. */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      pc.removeEventListener("icecandidate", candidate);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const candidate = (e: Event) => {
      const c = (e as RTCPeerConnectionIceEvent).candidate;
      if (c?.type === "srflx") done();
    };
    const timer = setTimeout(done, GATHER_MS);
    pc.addEventListener("icegatheringstatechange", check);
    pc.addEventListener("icecandidate", candidate);
  });
}

/** Every channel open, or a rejection after `ms`. */
function opened(channels: RTCDataChannel[], ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the data channels did not open")), ms);
    const check = () => {
      if (channels.every((c) => c.readyState === "open")) {
        clearTimeout(timer);
        resolve();
      } else if (channels.some((c) => c.readyState === "closed")) {
        clearTimeout(timer);
        reject(new Error("a data channel closed while opening"));
      }
    };
    for (const c of channels) {
      c.addEventListener("open", check);
      c.addEventListener("close", check);
    }
    check();
  });
}
