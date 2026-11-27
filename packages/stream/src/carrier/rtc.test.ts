// The WebRTC carrier against a peer connection written in a few lines: the offer it posts, the
// answer it refuses, what goes out framed, and what comes in reaches the feed.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Feed } from "./feed.ts";
import { decode, encode, type Frame, TAG } from "./frame.ts";
import { answeredCodecs, fingerprintOf, RtcCarrier, type RtcPlan, type RtpTotals, rtpTotals, rtpWindow, sendsAudio, sendsVideo, stereoOpus } from "./rtc.ts";

const HOST_HASH = "ab".repeat(32);
const answerWith = (hash: string) =>
  `v=0\r\na=fingerprint:sha-256 ${hash.match(/../g)!.join(":").toUpperCase()}\r\n`;

class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  binaryType = "blob";
  bufferedAmount = 0;
  sent: Uint8Array[] = [];
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(
    readonly label: string,
    readonly init?: RTCDataChannelInit,
  ) {
    super();
  }
  send(b: Uint8Array) {
    this.sent.push(b.slice());
  }
  // The other end.
  open() {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }
  deliver(b: Uint8Array) {
    this.onmessage?.({ data: b.slice().buffer });
  }
}

class FakePeer extends EventTarget {
  static last: FakePeer;
  channels: FakeChannel[] = [];
  localDescription: { sdp: string } | null = null;
  remote: { type: string; sdp: string } | null = null;
  iceGatheringState = "complete";
  connectionState = "new";
  closed = false;
  onconnectionstatechange: (() => void) | null = null;
  constructor(readonly config: RTCConfiguration) {
    super();
    FakePeer.last = this;
  }
  createDataChannel(label: string, init?: RTCDataChannelInit) {
    const c = new FakeChannel(label, init);
    this.channels.push(c);
    return c;
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0 offer" };
  }
  async setLocalDescription(d: { sdp: string }) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remote = d;
    queueMicrotask(() => this.channels.forEach((c) => c.open()));
  }
  close() {
    this.closed = true;
  }
  /** What the browser measured on the pair it chose: 42 ms, and an unused pair beside it. */
  async getStats() {
    return new Map<string, Record<string, unknown>>([
      ["a", { type: "candidate-pair", nominated: false, currentRoundTripTime: 0.3 }],
      ["b", { type: "candidate-pair", nominated: true, currentRoundTripTime: 0.042 }],
    ]);
  }
}

function fakeFeed() {
  const got: string[] = [];
  const feed: Feed = {
    datagram: (b) => got.push(`datagram ${[...b]}`),
    control: (b) => got.push(`control ${[...b]}`),
    uni: (b) => got.push(`uni ${[...b]}`),
    controlReady: () => got.push("ready"),
    closed: (code, reason) => got.push(`closed ${code} ${reason}`),
  };
  return { feed, got };
}

const PLAN: RtcPlan = {
  signal: "https://page.example/h/1/api/v1/webrtc",
  certHash: HOST_HASH,
  iceServers: ["stun:stun.example:3478"],
  port: 9783,
  planeHash: "cd".repeat(32),
};

/** A carrier, its peer, what it posted and what reached the feed, the host answering `answer`. */
function carrier(answer: string) {
  const { feed, got } = fakeFeed();
  const posted: { url: string; body: unknown }[] = [];
  const post = (async (url: string, init?: RequestInit) => {
    posted.push({ url, body: JSON.parse(String(init?.body)) });
    return { ok: true, status: 200, json: async () => ({ sdp: answer }) };
  }) as unknown as typeof fetch;
  const c = new RtcCarrier(feed, PLAN, post, FakePeer as unknown as typeof RTCPeerConnection);
  return { c, got, posted };
}

const frames = (ch: FakeChannel): Frame[] => ch.sent.map((b) => decode(b)!);

test("the answer's fingerprint is read without colons, in lowercase", () => {
  assert.equal(fingerprintOf(answerWith(HOST_HASH)), HOST_HASH);
  assert.equal(fingerprintOf("v=0\r\n"), null);
});

test("an answer sends video only with a video section that has a port", () => {
  assert.equal(sendsVideo("v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 102\r\na=sendonly\r\n"), true);
  assert.equal(sendsVideo("v=0\r\nm=video 0 UDP/TLS/RTP/SAVPF 0\r\n"), false, "rejected");
  assert.equal(sendsVideo("v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"), false);
});

test("an answer sends audio only with an audio section that has a port", () => {
  assert.equal(sendsAudio("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"), true);
  assert.equal(sendsAudio("v=0\r\nm=audio 0 UDP/TLS/RTP/SAVPF 0\r\n"), false);
});

test("the offer's Opus asks for stereo, once", () => {
  const offer = "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n";
  const once = stereoOpus(offer);
  assert.match(once, /a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1\r\n/);
  assert.equal(stereoOpus(once), once);
  assert.equal(stereoOpus("m=video 9 UDP/TLS/RTP/SAVPF 96\r\n"), "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n");
});

test("the overlay reads the video and audio receive totals, zero where a kind is absent", () => {
  const report = new Map<string, Record<string, unknown>>([
    ["v", { type: "inbound-rtp", kind: "video", frameWidth: 1920, frameHeight: 1080, framesDecoded: 60, bytesReceived: 5000, powerEfficientDecoder: true }],
    ["a", { type: "inbound-rtp", kind: "audio", jitterBufferDelay: 2, jitterBufferEmittedCount: 100 }],
    ["c", { type: "candidate-pair", bytesReceived: 9 }],
  ]) as unknown as RTCStatsReport;
  const t = rtpTotals(report);
  assert.deepEqual([t.width, t.height, t.decoded, t.bytes, t.hardware], [1920, 1080, 60, 5000, true]);
  assert.deepEqual([t.audioBufferSecs, t.audioEmitted, t.packetsLost], [2, 100, 0]);
  assert.equal(rtpTotals(new Map() as unknown as RTCStatsReport).hardware, null);
});

test("the answer's video codecs become the plane's codec bits", () => {
  const answer =
    "v=0\r\nm=audio 9 x 111\r\na=rtpmap:111 opus/48000/2\r\nm=video 9 x 45 49 102\r\n" +
    "a=rtpmap:45 AV1/90000\r\na=rtpmap:49 H265/90000\r\na=rtpmap:102 H264/90000\r\na=rtpmap:103 rtx/90000\r\n";
  assert.equal(answeredCodecs(answer), 0x07);
  assert.equal(answeredCodecs("v=0\r\nm=video 9 x 102\r\na=rtpmap:102 H264/90000\r\n"), 0x01);
  assert.equal(answeredCodecs("v=0\r\nm=audio 9 x 111\r\n"), 0);
});

test("the offer goes to the host with the plane it is for, and its channels open", async () => {
  const { c, got, posted } = carrier(answerWith(HOST_HASH));
  await c.open();
  const peer = FakePeer.last;
  assert.deepEqual(peer.config.iceServers, [{ urls: PLAN.iceServers }]);
  assert.deepEqual(posted, [{ url: PLAN.signal, body: { sdp: "v=0 offer", port: 9783, hash: PLAN.planeHash } }]);
  const [ctl, dg] = peer.channels;
  assert.equal(ctl!.label, "ctl");
  assert.deepEqual([dg!.label, dg!.init], ["dg", { ordered: false, maxRetransmits: 0 }]);
  // The control stream opens with its type byte, and the engine hears it is ready.
  assert.deepEqual(frames(ctl!), [{ tag: TAG.CONTROL, bytes: new Uint8Array([0]) }]);
  assert.deepEqual(got, ["ready"]);
  c.close();
});

test("an answer from any other certificate is refused before anything opens", async () => {
  const { c, got } = carrier(answerWith("ef".repeat(32)));
  await assert.rejects(c.open(), /fingerprint/);
  assert.equal(FakePeer.last.remote, null);
  assert.ok(FakePeer.last.closed);
  assert.deepEqual(got, []);
});

test("what arrives reaches the feed, datagrams go bare, and the host's close is the engine's", async () => {
  const { c, got } = carrier(answerWith(HOST_HASH));
  await c.open();
  const [ctl, dg] = FakePeer.last.channels;
  ctl!.deliver(encode({ tag: TAG.CONTROL, bytes: new Uint8Array([7, 8]) }));
  ctl!.deliver(encode({ tag: TAG.UNI, bytes: new Uint8Array([9]) }));
  dg!.deliver(new Uint8Array([5, 1, 2]));
  assert.ok(c.sendDatagram(new Uint8Array([1, 3])));
  assert.deepEqual(dg!.sent, [new Uint8Array([1, 3])]);
  ctl!.deliver(encode({ tag: TAG.CLOSE, code: 0x6c, reason: "busy" }));
  assert.deepEqual(got, ["ready", "control 7,8", "uni 9", "datagram 5,1,2", "closed 108 busy"]);
  assert.ok(FakePeer.last.closed);
  assert.equal(c.sendDatagram(new Uint8Array([1])), false);
});

test("closing tells the host its code before the peer connection goes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { c } = carrier(answerWith(HOST_HASH));
  await c.open();
  const peer = FakePeer.last;
  const ctl = peer.channels[0]!;
  c.close(0x51);
  assert.deepEqual(frames(ctl).at(-1), { tag: TAG.CLOSE, code: 0x51, reason: "" });
  assert.equal(peer.closed, false);
  t.mock.timers.tick(250);
  assert.ok(peer.closed);
});

test("a bridge that never answers a ping is gone after ten", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { c, got } = carrier(answerWith(HOST_HASH));
  await c.open();
  t.mock.timers.tick(10_000);
  assert.deepEqual(got, ["ready"], "ten pings out");
  t.mock.timers.tick(1_000);
  assert.deepEqual(got, ["ready", "closed -1 "]);
  assert.ok(FakePeer.last.closed);
});

test("an overlay window is what changed since the last read, the audio buffer's mean too", () => {
  const at = (s: Partial<RtpTotals>): RtpTotals => ({ ...rtpTotals(new Map() as unknown as RTCStatsReport), ...s });
  const first = at({ framesReceived: 60, bytes: 9000, decoded: 58, decodeSecs: 0.116, audioBufferSecs: 10, audioEmitted: 100 });
  assert.deepEqual(rtpWindow(null, first), { frames: 60, bytes: 9000, decoded: 58, dropped: 0, lost: 0, decodeUs: 2000, audioMs: 100 });
  const next = at({ framesReceived: 120, bytes: 18000, decoded: 118, decodeSecs: 0.236, audioBufferSecs: 12, audioEmitted: 200 });
  assert.deepEqual(rtpWindow(first, next), { frames: 60, bytes: 9000, decoded: 60, dropped: 0, lost: 0, decodeUs: 2000, audioMs: 20 });
  assert.equal(rtpWindow(next, at({ framesReceived: 5 })).frames, 0, "totals that went back count nothing");
});

test("a deferred carrier opens its path, times it, and starts the session only when told", async () => {
  const { feed, got } = fakeFeed();
  const post = (async () => ({ ok: true, status: 200, json: async () => ({ sdp: answerWith(HOST_HASH) }) })) as unknown as typeof fetch;
  const c = new RtcCarrier(feed, { ...PLAN, deferControl: true }, post, FakePeer as unknown as typeof RTCPeerConnection);
  await c.open();
  const ctl = FakePeer.last.channels[0]!;
  assert.deepEqual(got, [], "no session yet");
  assert.deepEqual(ctl.sent, []);
  assert.equal(await c.pathRttMs(), 42, "the chosen pair's round trip");
  c.openControl();
  assert.deepEqual(got, ["ready"]);
  assert.deepEqual(frames(ctl), [{ tag: TAG.CONTROL, bytes: new Uint8Array([0]) }]);
  c.close();
});
