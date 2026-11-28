// The request-for-access half of the engine's state machine, against a stand-in wasm module:
// what the page shows while the host holds the request, and what each way it ends leaves.
//
// The engine uses constructor parameter properties, so `npm test` runs node with
// `--experimental-transform-types` rather than plain type stripping.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { useEnglish } from "./words.testing.ts";

useEnglish();

// The engine schedules its frame loop on construction; nothing here runs it.
globalThis.requestAnimationFrame = () => 0;

/** Every carrier dialled, in order: a WebTransport URL, or `ws <url>` for the bridge. */
const dialled: string[] = [];
/** What the next WebTransport does: never answer, refuse to be made, or fail before it opens. */
let transport: "silent" | "refuse" | "fail" = "silent";
/** Hosts whose first handshake completes: the race's probe opens, the session's dial waits. */
const opens = new Set<string>();
const opened = new Set<string>();
/** How long a host in `opens` takes to answer its first handshake, in ms; at once when unset. */
const openAfter = new Map<string, number>();
/** The round trip a host's connection measures, in ms; none told when unset. */
const measured = new Map<string, number>();
class FakeTransport {
  ready: Promise<void>;
  private readonly host: string;
  closed = new Promise<never>(() => {});
  constructor(url: string) {
    if (transport === "refuse") throw new TypeError("refused");
    dialled.push(url);
    const host = new URL(url).hostname;
    this.host = host;
    const first = opens.has(host) && !opened.has(host);
    if (first) opened.add(host);
    const after = openAfter.get(host);
    this.ready = first
      ? after === undefined
        ? Promise.resolve()
        : new Promise<void>((r) => setTimeout(r, after))
      : transport === "fail"
        ? Promise.reject(new Error("handshake failed"))
        : new Promise<never>(() => {});
  }
  close() {}
  async getStats() {
    const rtt = measured.get(this.host);
    return rtt === undefined ? {} : { minRtt: rtt };
  }
}
/** The WebRTC path a dial opens beside its race, as a stand-in: `rtt` is what it measures, and
 *  what the engine did with it is counted. */
function stubRtc(engine: object, rtt: number | null) {
  const seen = { adopted: 0, dropped: 0 };
  Object.assign(engine, {
    probeRtc: () => ({
      rtt: Promise.resolve(rtt),
      adopt: () => seen.adopted++,
      drop: () => seen.dropped++,
    }),
  });
  return seen;
}

/** A peer connection that never gets as far as an offer: enough to see WebRTC was chosen. */
class FakePeer {
  createDataChannel() {
    return { binaryType: "", readyState: "connecting", addEventListener() {}, close() {} };
  }
  addTransceiver() {}
  createOffer() {
    return new Promise<never>(() => {});
  }
  close() {}
}
/** The page server's bridge, opened or dropped by hand. */
const sockets: FakeSocket[] = [];
class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(url: string) {
    dialled.push(`ws ${url}`);
    sockets.push(this);
  }
  send() {}
  close() {}
}
Object.assign(globalThis, {
  WebTransport: FakeTransport,
  WebSocket: FakeSocket,
  RTCPeerConnection: FakePeer,
  location: { href: "https://page.example/" },
});
const flush = () => new Promise((r) => setImmediate(r));
/** Settle promises while `setTimeout` is mocked: `setImmediate` still runs. */
const flushMocked = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const { Engine } = await import("./engine.ts");

const ORIGIN = "https://192.168.1.21:47990";
const DENIED = 0x64;

/** An engine sitting in `kind` for `origin`, and the wasm exports it has called since. With
 *  `bridge`, the target offers the page server's WebSocket route. */
function engineIn(kind: "needs-pairing" | "ready", bridge?: string, origin = ORIGIN) {
  const calls: string[] = [];
  const base: Record<string, unknown> = {
    // What `_pf_device_fingerprint_hex` leaves at the one address `_malloc` hands out.
    HEAPU8: new TextEncoder().encode("4f2a91c307bed512".padEnd(64, "0")),
    stringToNewUTF8: () => 0,
    _malloc: () => 0,
    _free: () => {},
  };
  const mod = new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key as string];
      if (typeof key === "string" && key.startsWith("_pf_")) {
        return () => {
          calls.push(key);
          return 1;
        };
      }
      return undefined;
    },
  });
  // The constructor is private: `create()` loads the real module, which this test replaces.
  const Ctor = Engine as unknown as new (mod: unknown, opts: unknown) => import("./engine.ts").Engine;
  const engine = new Ctor(mod, { videoCanvas: {}, deviceName: "Safari on Mac" });
  Object.assign(engine, {
    origin,
    ...(bridge ? { target: { api: origin, plane: "192.168.1.21", bridge } } : {}),
    planeHost: "192.168.1.21",
    plane: { port: 9778, cert_hash_sha256: "00".repeat(32) },
    // What `connect` binds the credential to.
    boundHash: "00".repeat(32),
  });
  (engine as unknown as { set(s: unknown): void }).set({ kind, origin });
  return { engine, mod: base, calls };
}

const refuse = (mod: Record<string, unknown>, code: number, reason: string) =>
  (mod.__pfOnRefused as (code: number, reason: string) => void)(code, reason);
const close = (mod: Record<string, unknown>, code: number) =>
  (mod.__pfOnClosed as (code: number, reason: string) => void)(code, "");

test("a denied request says why, and does not read as a forgotten pairing", () => {
  const { engine, mod, calls } = engineIn("needs-pairing");
  engine.requestAccess({ width: 1280, height: 720 });
  // The code the host's console shows beside the request: the fingerprint `4f 2a 91 c3 07 be d5 12 …`.
  assert.deepEqual(engine.current, { kind: "awaiting-approval", origin: ORIGIN, name: "Safari on Mac", code: "4F2A 91C3 07BE D512" });
  assert.equal(dialled.at(-1), "https://192.168.1.21:9778/probe", "asking dials the plane");

  refuse(mod, DENIED, "the request was denied on the host");
  assert.deepEqual(engine.current, {
    kind: "pair-refused",
    origin: ORIGIN,
    reason: "the request was denied on the host",
  });
  // The session stays `Offered` after a refusal unless reset, and five seconds of that reads as
  // "this host forgot you" — the wrong sentence for a request someone said no to.
  assert.ok(calls.includes("_pf_session_reset"));
  close(mod, DENIED);
  assert.equal(engine.current.kind, "pair-refused", "the transport's own close changes nothing");
});

test("a cancelled request goes back to pairing, and its close is not an error", () => {
  const { engine, mod, calls } = engineIn("needs-pairing");
  engine.requestAccess({ width: 1280, height: 720 });
  engine.cancelRequest();
  assert.deepEqual(engine.current, { kind: "needs-pairing", origin: ORIGIN });
  assert.ok(calls.includes("_pf_wt_close"));
  close(mod, -1);
  assert.deepEqual(engine.current, { kind: "needs-pairing", origin: ORIGIN });
});

test("a door's redirect dials the seat's plane once, with the credential bound to it", () => {
  const { engine, mod, calls } = engineIn("ready");
  const bound: string[] = [];
  mod.stringToNewUTF8 = (s: string) => {
    bound.push(s);
    return 0;
  };
  engine.startStream({ width: 1280, height: 720 });
  assert.ok(dialled.includes("https://192.168.1.21:9778/probe"), "the door first");

  const seat = "ab".repeat(32);
  const redirect = mod.__pfOnRedirect as (port: number, certHash: string) => void;
  const before = calls.length;
  redirect(9784, seat);
  assert.ok(calls.slice(before).includes("_pf_wt_close"), "the door's connection is closed first");
  assert.ok(calls.includes("_pf_device_init"), "the credential binds to the seat's plane");
  assert.ok(bound.includes(seat));
  (mod.__pfOnDeviceReady as () => void)();
  assert.ok(dialled.includes("https://192.168.1.21:9784/probe"), "then the seat's own port");

  redirect(9785, seat);
  assert.equal(engine.current.kind, "error", "a second redirect ends the connect");
});

test("a request for access offers every codec this browser decodes", () => {
  const { engine, mod } = engineIn("needs-pairing");
  const offers: number[] = [];
  mod._pf_session_codecs = (mask: number) => offers.push(mask);
  Object.assign(engine, { codecs: { mask: 0x07, tenBit: false }, refused: 0x02 });
  engine.requestAccess({ width: 5120, height: 1440 });
  assert.deepEqual(offers, [0x07], "the knock's Hello is the stream's, not H.264 alone");
});

test("a request for access a door redirects streams on the seat", () => {
  const { engine, mod, calls } = engineIn("needs-pairing");
  engine.requestAccess({ width: 1280, height: 720 });
  (mod.__pfOnCtlReady as () => void)();
  assert.equal(engine.current.kind, "awaiting-approval");

  const before = calls.length;
  (mod.__pfOnRedirect as (port: number, certHash: string) => void)(9784, "ab".repeat(32));
  assert.equal(engine.current.kind, "starting", "admitted: the stream is on its way");
  assert.ok(calls.slice(before).includes("_pf_wt_close"), "the door's connection is closed first");
  (mod.__pfOnDeviceReady as () => void)();
  assert.equal(dialled.at(-1), "https://192.168.1.21:9784/probe", "then the seat's own port");
});

test("a connect left before its host answers says nothing afterwards", async () => {
  const { engine } = engineIn("ready");
  let answer = (_: Response) => {};
  const fetched = globalThis.fetch;
  globalThis.fetch = () => new Promise<Response>((resolve) => (answer = resolve));
  try {
    const connecting = engine.connect("https://192.168.1.30:47990");
    assert.equal(engine.current.kind, "reaching");
    engine.disconnect();
    answer(new Response(null, { status: 504 }));
    await connecting;
    assert.deepEqual(engine.current, { kind: "idle" }, "Cancel stays cancelled");
  } finally {
    globalThis.fetch = fetched;
  }
});

test("a session the page can't read ends as a version mismatch, not a hang", () => {
  const { engine, mod, calls } = engineIn("ready");
  engine.startStream({ width: 1280, height: 720 });
  mod._pf_session_phase = () => 3;
  (engine as unknown as { updateSession(): void }).updateSession();
  assert.equal(engine.current.kind, "error");
  assert.equal((engine.current as { skew?: boolean }).skew, true);
  assert.ok(calls.includes("_pf_session_reset") && calls.includes("_pf_wt_close"));
});

test("an approval whose seat isn't up ends paired, not refused", async () => {
  const { engine, mod } = engineIn("needs-pairing");
  engine.requestAccess({ width: 1280, height: 720 });
  refuse(mod, 0x6f, "that profile's seat isn't available on this host");
  close(mod, 0x6f);
  assert.deepEqual(engine.current, { kind: "paired", origin: ORIGIN }, "the transport's close changes nothing");
});

const HASH = "00".repeat(32);
const BRIDGED = `ws wss://page.example/w/abc?port=9778&hash=${HASH}`;
const dial = (engine: object) => (engine as { dial(): void }).dial();

test("a WebTransport the browser refuses gives way to the bridge", async (t: TestContext) => {
  t.after(() => (transport = "silent"));
  const { engine } = engineIn("ready", "w/abc", "https://page.example/h/refuse");
  transport = "refuse";
  engine.startStream({ width: 1280, height: 720 });
  await flush();
  assert.equal(dialled.at(-1), BRIDGED);
  assert.equal(engine.current.kind, "starting");
});

test("a WebTransport that fails before it opens gives way to the bridge", async (t: TestContext) => {
  t.after(() => (transport = "silent"));
  const { engine } = engineIn("ready", "w/abc", "https://page.example/h/fail");
  transport = "fail";
  engine.startStream({ width: 1280, height: 720 });
  await flush();
  assert.equal(dialled.at(-1), BRIDGED);
  assert.equal(engine.current.kind, "starting", "no error on the way");
});

test("a silent WebTransport gives way after three seconds, and only with a bridge", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { engine } = engineIn("ready", "w/abc", "https://page.example/h/silent");
  engine.startStream({ width: 1280, height: 720 });
  assert.equal(dialled.at(-1), "https://192.168.1.21:9778/probe");
  t.mock.timers.tick(2999);
  await flushMocked();
  assert.equal(dialled.at(-1), "https://192.168.1.21:9778/probe");
  t.mock.timers.tick(1);
  await flushMocked();
  assert.equal(dialled.at(-1), BRIDGED);

  const direct = engineIn("ready", undefined, "https://192.168.1.40:47990");
  direct.engine.startStream({ width: 1280, height: 720 });
  t.mock.timers.tick(10_000);
  await flushMocked();
  assert.equal(dialled.at(-1), "https://192.168.1.21:9778/probe", "no bridge, no fallback");
  assert.equal(direct.engine.current.kind, "error", "and says no path answered");
});

test("the bridge is remembered for the origin, and forgotten when it fails", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { engine } = engineIn("needs-pairing", "w/abc", "https://page.example/h/hint");
  engine.pair("1234");
  t.mock.timers.tick(3000);
  await flushMocked();
  sockets.at(-1)!.readyState = 1;
  sockets.at(-1)!.onopen!();
  await flush();
  assert.equal(engine.current.kind, "pairing", "the PIN went over the bridge");

  const before = dialled.length;
  dial(engine);
  assert.deepEqual(dialled.slice(before), [BRIDGED], "the reconnect skips WebTransport");

  sockets.at(-1)!.onclose!({ code: 1006, reason: "" });
  await flush();
  dial(engine);
  assert.equal(dialled.at(-1), "https://192.168.1.21:9778/probe", "WebTransport first again");
});

test("the connection dot is the wire's rating, read once a second", () => {
  const { engine, mod } = engineIn("ready");
  Object.assign(mod, {
    _pf_session_phase: () => 2,
    _pf_session_audio_channels: () => 0,
    _pf_hud_text: () => 0,
  });
  const snapshot = () => ({ width: 0, height: 0, decoded: 60, dropped: 30, uploadMs: 0, backend: null });
  Object.assign(engine, { video: { snapshot } });
  const second = (rating: number) => {
    mod._pf_hud_quality = () => rating;
    Object.assign(engine, { lastSecond: performance.now() - 1000 });
    (engine as unknown as { updateSession(): void }).updateSession();
    return (engine.current as { stats: { quality: string } }).stats.quality;
  };
  assert.equal(second(3), "poor");
  assert.equal(second(0), "starting");
});

test("a codec this browser can't decode gives way to another on offer, once each", () => {
  const { engine, mod } = engineIn("ready");
  const offers: number[] = [];
  mod._pf_session_codecs = (mask: number) => offers.push(mask);
  Object.assign(engine, { codecs: { mask: 0x03, tenBit: false } });
  const undecodable = (codec: number) => (engine as unknown as { undecodable(codec: number): void }).undecodable(codec);
  engine.configure({ codec: "hevc" });
  engine.startStream({ width: 1280, height: 720 });
  const before = dialled.length;
  undecodable(0x02);
  assert.equal(engine.current.kind, "starting", "no error while H.264 is left");
  assert.deepEqual(offers, [0x03, 0x01], "the same stream, offered without HEVC");
  assert.equal(dialled.length, before + 1);

  // The session that took over names its codec once `Welcome` has.
  Object.assign(mod, { _pf_session_phase: () => 2, _pf_session_audio_channels: () => 0, _pf_hud_text: () => 0 });
  const snapshot = () => ({ codec: 0x01, width: 0, height: 0, decoded: 0, dropped: 0, uploadMs: 0, backend: null });
  Object.assign(engine, { video: { snapshot, close() {} } });
  (engine as unknown as { updateSession(): void }).updateSession();
  const live = engine.current as import("./engine.ts").EngineState;
  assert.equal(
    live.kind === "streaming" && live.stats.launchNotice,
    "This browser can't decode HEVC, so the stream uses H.264, ignoring the Video codec setting",
  );

  // H.264 fails too: nothing is left, and HEVC is not offered again.
  undecodable(0x01);
  assert.equal(engine.current.kind, "error");
  assert.deepEqual(offers, [0x03, 0x01]);

  // A stream the player starts offers every codec again.
  (engine as unknown as { set(s: unknown): void }).set({ kind: "ready", origin: ORIGIN });
  engine.startStream({ width: 1280, height: 720 });
  assert.equal(offers.at(-1), 0x03);
});

test("only a 401 at sign-in reads as a forgotten pairing", async () => {
  const fetched = globalThis.fetch;
  const device = { spki: async () => "", sign: async () => new Uint8Array(64) };
  try {
    for (const [status, kind] of [[401, "forgotten"], [429, "error"], [502, "ready"]] as const) {
      globalThis.fetch = (async () => new Response("no", { status })) as typeof fetch;
      const { engine } = engineIn("needs-pairing");
      (engine as unknown as { checkHost(o: string, fp: string, d: unknown): void }).checkHost(ORIGIN, "cd".repeat(32), device);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(engine.current.kind, kind, `status ${status}`);
      if (status === 429) assert.match((engine.current as { message: string }).message, /too many requests/i);
      if (status === 502) {
        const host = (engine.current as { host: { info(): Promise<unknown> } }).host;
        await assert.rejects(host.info(), (e: Error) => /couldn't sign in/.test(e.message) && !/pair/.test(e.message));
      }
    }
  } finally {
    globalThis.fetch = fetched;
  }
});

test("the dial races the host's direct addresses and streams over the first that opens", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => opens.clear());
  const { engine } = engineIn("ready", "w/abc", "https://page.example/h/race");
  Object.assign(engine, { direct: ["192.168.1.21", "100.64.1.2", "2001:db8::21"] });
  opens.add("100.64.1.2");
  const before = dialled.length;
  engine.startStream({ width: 1280, height: 720 });
  t.mock.timers.tick(250);
  await flushMocked();
  assert.deepEqual(dialled.slice(before), [
    "https://192.168.1.21:9778/probe",
    "https://100.64.1.2:9778/probe",
    "https://100.64.1.2:9778/pf2",
  ], "two probes a quarter second apart, then the session on the one that opened");
  assert.equal(engine.current.kind, "starting");

  // The next dial tries the winner first.
  opened.clear();
  const again = dialled.length;
  dial(engine);
  await flushMocked();
  assert.equal(dialled[again], "https://100.64.1.2:9778/probe");
});

test("with no direct path the host's WebRTC peer punches through, never the bridge first", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { engine } = engineIn("ready", "w/abc", "https://page.example/h/punch");
  const seen = stubRtc(engine, 50);
  const reports = reportsOf(engine);
  const sockets_before = sockets.length;
  engine.startStream({ width: 1280, height: 720 });
  t.mock.timers.tick(3000);
  await flushMocked();
  assert.deepEqual(seen, { adopted: 1, dropped: 0 });
  assert.deepEqual(reports, [
    { kind: "path", probes: [{ host: "192.168.1.21", ms: null, outcome: "late" }], direct_ms: null, direct_by: null, webrtc_ms: 50, carrier: "rtc", why: "no-direct" },
  ]);
  assert.equal(sockets.length, sockets_before, "nothing through the page's server");
});

test("WebRTC beside the race streams only when its pings are clearly faster than direct's", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => (opens.clear(), openAfter.clear(), measured.clear()));
  /** A dial whose direct path opens in `handshake` ms and answers its pings in `ping` (`null`: a
   *  host that echoes none), WebRTC pinging `rtt`. */
  const dialWith = async (name: string, handshake: number, rtt: number, ping: number | null) => {
    const { engine } = engineIn("ready", "w/abc", `https://page.example/h/${name}`);
    Object.assign(engine, { planeHost: "", direct: ["100.64.0.5"], pingPath: async () => ping });
    opens.add("100.64.0.5");
    opened.clear();
    openAfter.set("100.64.0.5", handshake);
    measured.delete("100.64.0.5");
    const seen = stubRtc(engine, rtt);
    const reports = reportsOf(engine);
    const before = dialled.length;
    engine.startStream({ width: 1280, height: 720 });
    t.mock.timers.tick(handshake);
    await flushMocked();
    told.push(...reports);
    return { seen, session: dialled.slice(before).includes("https://100.64.0.5:9778/pf2") };
  };
  const told: Record<string, unknown>[] = [];
  const direct = { seen: { adopted: 0, dropped: 1 }, session: true };
  assert.deepEqual(await dialWith("lan", 4, 1, 2), direct, "2 ms can't lose");
  assert.deepEqual(await dialWith("derp", 400, 40, 200), { seen: { adopted: 1, dropped: 0 }, session: false }, "200 ms against 40");
  assert.deepEqual(await dialWith("close", 200, 90, 100), direct, "100 ms against 90 stays direct");
  assert.deepEqual(await dialWith("older", 400, 5, null), direct, "a host that can't be pinged streams direct");
  const probe = (ms: number) => [{ host: "100.64.0.5", ms, outcome: "open" }];
  assert.deepEqual(told, [
    { kind: "path", probes: probe(4), direct_ms: 2, direct_by: "ping", webrtc_ms: null, carrier: "wt", why: "direct-close" },
    { kind: "path", probes: probe(400), direct_ms: 200, direct_by: "ping", webrtc_ms: 40, carrier: "rtc", why: "webrtc-faster" },
    { kind: "path", probes: probe(200), direct_ms: 100, direct_by: "ping", webrtc_ms: 90, carrier: "wt", why: "direct-faster" },
    { kind: "path", probes: probe(400), direct_ms: 200, direct_by: "handshake", webrtc_ms: null, carrier: "wt", why: "direct-unpinged" },
  ], "each dial reports what it raced, what it measured and what it took");
});

test("the overlay names the path: the address it dials, WebRTC, or the page's server", () => {
  const { engine } = engineIn("ready");
  const e = engine as unknown as { pathLine(): string | null };
  const ride = (carrierKind: string, address: string | null) => {
    Object.assign(engine, { carrierKind, address });
    return e.pathLine();
  };
  assert.equal(ride("wt", "100.64.1.2"), "Path: direct to 100.64.1.2");
  assert.equal(ride("wt", "[2001:db8::21]"), "Path: direct to [2001:db8::21]");
  assert.equal(ride("rtc", null), "Path: WebRTC, peer to peer");
  assert.equal(ride("ws", null), "Carrier: WebSocket via page server");
});

test("a bridge that never opens names the page's server, not UDP", async (t: TestContext) => {
  const message = () => (engine.current as { message: string }).message;
  // No plane address: the bridge is the only carrier.
  let { engine } = engineIn("ready", "w/abc", "https://page.example/h/unopened");
  Object.assign(engine, { planeHost: "" });
  engine.startStream({ width: 1280, height: 720 });
  sockets.at(-1)!.onclose!({ code: 1006, reason: "" });
  await flush();
  assert.equal(engine.current.kind, "error");
  assert.match(message(), /page's server couldn't open a connection/);

  t.after(() => Object.assign(globalThis, { WebSocket: FakeSocket }));
  Object.assign(globalThis, {
    WebSocket: class {
      constructor() {
        throw new SyntaxError("blocked");
      }
    },
  });
  ({ engine } = engineIn("ready", "w/abc", "https://page.example/h/unbuilt"));
  Object.assign(engine, { planeHost: "" });
  engine.startStream({ width: 1280, height: 720 });
  assert.match(message(), /page's server couldn't open a connection/, "not the WebTransport sentence");
});

test("a carrier that fails after a newer dial says nothing to it", async () => {
  const { engine } = engineIn("ready", "w/abc", "https://page.example/h/stale");
  Object.assign(engine, { planeHost: "" });
  engine.startStream({ width: 1280, height: 720 });
  const stale = sockets.at(-1)!;
  dial(engine);
  assert.notEqual(sockets.at(-1), stale, "a second bridge");
  stale.onclose?.({ code: 1006, reason: "" });
  await flush();
  assert.equal(engine.current.kind, "starting", "the newer dial goes on");
});

test("a device key an earlier connect asked for says nothing to a newer one", async () => {
  const { engine, mod } = engineIn("ready");
  const fetched = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = ((u: string) => {
    asked.push(String(u));
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  try {
    void engine.connect("https://192.168.1.31:47990");
    (mod.__pfOnDeviceReady as () => void)();
    (mod.__pfOnDeviceFailed as () => void)();
    await flush();
    assert.equal(engine.current.kind, "reaching", "the newer connect's checks come first");
    assert.deepEqual(asked, ["https://192.168.1.31:47990/api/v1/health"]);
  } finally {
    engine.disconnect();
    globalThis.fetch = fetched;
  }
});

test("a paired host without a pass is renewed once before the dial", async (t: TestContext) => {
  const origin = "https://page.example/h/renew";
  const store = new Map([["pf.hosts", JSON.stringify({ [origin]: { fingerprint: "cd".repeat(32) } })]]);
  Object.assign(globalThis, { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem() {} } });
  t.after(() => Reflect.deleteProperty(globalThis, "localStorage"));
  const { engine } = engineIn("ready", "w/abc", origin);
  let renewals = 0;
  Object.assign(engine, { host: { renewPass: async () => void renewals++ } });
  const before = dialled.length;
  engine.startStream({ width: 1280, height: 720 });
  assert.equal(dialled.length, before, "nothing dialled while the pass is asked for");
  await flush();
  assert.equal(renewals, 1);
  assert.equal(dialled.at(-1), "https://192.168.1.21:9778/probe", "then the dial, with or without a pass");
});

const LOCKED = 0x74;

test("an unlock goes to wasm with its dial, wiped from the page's heap and never kept", () => {
  const { engine, mod, calls } = engineIn("ready");
  const heap = new Uint8Array(64);
  const sent: { bytes: number[]; stay: number }[] = [];
  Object.assign(mod, {
    HEAPU8: heap,
    _malloc: () => 8,
    _pf_session_unlock: (p: number, len: number, stay: number) => {
      sent.push({ bytes: [...heap.subarray(p, p + len)], stay });
      return 1;
    },
  });
  engine.startStream({ width: 1280, height: 720, profile: "kid", unlock: { secret: "2468", stay: true } });
  assert.deepEqual(sent, [{ bytes: [0x32, 0x34, 0x36, 0x38], stay: 1 }]);
  assert.ok(heap.every((b) => b === 0), "this page's copy is wiped");
  assert.equal(engine.current.kind, "starting");
  // A restart or a redirect dials from these, so neither may hold the secret.
  const kept = engine as unknown as { streamed: object; pendingStream: object };
  assert.equal("unlock" in kept.streamed, false);
  assert.equal("unlock" in kept.pendingStream, false);
  assert.ok(!calls.includes("_pf_console_unlock"), "the console's prompt is not asked for one");
});

test("a dial without an unlock takes what the console's prompt typed", () => {
  const { engine, calls } = engineIn("ready");
  engine.startStream({ width: 1280, height: 720, profile: "kid" });
  assert.ok(calls.includes("_pf_console_unlock"));
  assert.ok(!calls.includes("_pf_session_unlock"));
});

test("a profile-locked close asks for the unlock, and the prompt's dial starts from it", () => {
  const { engine, mod } = engineIn("ready");
  const host = {};
  Object.assign(engine, { host });
  engine.startStream({ width: 1280, height: 720, profile: "kid" });
  refuse(mod, LOCKED, "");
  assert.deepEqual(engine.current, { kind: "profile-locked", origin: ORIGIN, host });
  close(mod, LOCKED);
  assert.equal(engine.current.kind, "profile-locked", "the transport's own close changes nothing");

  const before = dialled.length;
  engine.startStream({ width: 1280, height: 720, profile: "kid", unlock: { secret: "0000" } });
  assert.equal(engine.current.kind, "starting");
  assert.equal(dialled.length, before + 1, "dialled again, with no new connect");
  // The host's own sentence for a wrong PIN, as it arrived.
  refuse(mod, LOCKED, "That isn't this profile's PIN.");
  assert.deepEqual(engine.current, { kind: "profile-locked", origin: ORIGIN, host, said: "That isn't this profile's PIN." });
  engine.leave();
  assert.deepEqual(engine.current, { kind: "ready", origin: ORIGIN, host });
});

test("a host that says Pending holds the dial: an unlock's is its desktop starting", () => {
  const { engine, mod } = engineIn("ready");
  Object.assign(engine, { host: {} });
  let pending = 0;
  Object.assign(mod, { _pf_session_phase: () => 1, _pf_session_pending: () => pending });
  const tick = () => (engine as unknown as { updateSession(): void }).updateSession();
  const longSilent = () => Object.assign(engine, { offeredSince: performance.now() - 10_000 });
  engine.startStream({ width: 1280, height: 720, profile: "kid", unlock: { secret: "2468" } });
  pending = 1;
  longSilent();
  tick();
  assert.deepEqual(engine.current, { kind: "starting", origin: ORIGIN, opening: true });
  // Without the host's word the same silence still reads as a pairing it forgot.
  pending = 0;
  longSilent();
  tick();
  assert.equal(engine.current.kind, "forgotten");
});

test("an approved request whose profile is locked ends paired, not refused", () => {
  const { engine, mod } = engineIn("needs-pairing");
  engine.requestAccess({ width: 1280, height: 720 });
  refuse(mod, LOCKED, "");
  assert.deepEqual(engine.current, { kind: "paired", origin: ORIGIN });
});

test("the prompt's dial has its own grace, however long the typing took", () => {
  const { engine, mod } = engineIn("ready");
  Object.assign(engine, { host: {} });
  Object.assign(mod, { _pf_session_phase: () => 1, _pf_session_pending: () => 0 });
  const tick = () => (engine as unknown as { updateSession(): void }).updateSession();
  engine.startStream({ width: 1280, height: 720, profile: "kid", unlock: { secret: "1111" } });
  tick();
  refuse(mod, LOCKED, "That isn't this profile's PIN.");
  // The refused dial's clock, ten seconds on: the player typed the PIN again.
  Object.assign(engine, { offeredSince: performance.now() - 10_000 });
  engine.startStream({ width: 1280, height: 720, profile: "kid", unlock: { secret: "2468" } });
  tick();
  assert.equal(engine.current.kind, "starting", "not a forgotten pairing");
});

/** An engine streaming over WebTransport, its next move's connection stubbed: it opens its
 *  control stream and hears the host's ack at once. */
/** What `engine` reports of its path choices and moves, without the times a test can't pin. */
function reportsOf(engine: object): Record<string, unknown>[] {
  const got: Record<string, unknown>[] = [];
  const opts = (engine as unknown as { opts: object }).opts;
  Object.assign(engine, {
    opts: {
      ...opts,
      onReport: (r: Record<string, unknown>) => {
        const { ms: _ms, secs: _secs, ...rest } = r;
        got.push(rest);
      },
    },
  });
  return got;
}

function streamingOver(name: string) {
  const { engine, mod, calls } = engineIn("ready", undefined, `https://page.example/h/${name}`);
  const e = engine as unknown as { set(s: unknown): void; feed: import("./carrier/feed.ts").Feed };
  const old = { closed: 0, close() {} };
  const made: string[] = [];
  const { Retirable } = moveModule;
  Object.assign(engine, {
    direct: ["100.64.7.7"],
    carrierKind: "wt",
    carrierPlane: { port: 9778, hash: "00".repeat(32) },
    carrierFeed: new Retirable(e.feed),
    address: "192.168.1.21",
    openMove: (to: { kind: string; host?: string }, _port: number, _hash: string, feed: import("./carrier/feed.ts").Feed) => {
      made.push(to.kind === "wt" ? to.host! : to.kind);
      return {
        open: async () => {
          feed.controlReady();
          feed.control(new Uint8Array([1]));
        },
        close() {},
      };
    },
  });
  mod.__pfCarrier = old;
  e.set({ kind: "streaming", origin: `https://page.example/h/${name}`, stats: {} });
  return { engine, mod, calls, made, old };
}
const moveModule = await import("./carrier/move.ts");

test("a stream whose connection is lost moves to a new one and streams on", async (t) => {
  opens.add("100.64.7.7");
  t.after(() => opens.clear());
  const { engine, mod, calls, made, old } = streamingOver("lost");
  const reports = reportsOf(engine);
  close(mod, -1);
  assert.equal(await (engine as unknown as { moving: Promise<boolean> }).moving, true);
  assert.deepEqual(made, ["100.64.7.7"], "the move dials the path that won the race");
  assert.notEqual(mod.__pfCarrier, old, "the session sends on the new connection");
  assert.ok(calls.includes("_pf_handover_begin"));
  assert.equal(engine.current.kind, "streaming", "no dialog");
  assert.equal((engine as unknown as { address: string }).address, "100.64.7.7");
  const probes = (r: Record<string, unknown>) => (r.probes as { host: string; outcome: string }[]).map((p) => `${p.host} ${p.outcome}`);
  assert.deepEqual(
    reports.map((r) => ({ ...r, probes: probes(r) })),
    [
      {
        kind: "move",
        why: "lost",
        from_carrier: "wt",
        from: "192.168.1.21",
        to_carrier: "wt",
        to: "100.64.7.7",
        probes: ["100.64.7.7 open", "192.168.1.21 late"],
        outcome: "moved",
      },
    ],
  );
});

test("a lost stream with no path to move to ends as lost", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { engine, mod } = streamingOver("nowhere");
  const reports = reportsOf(engine);
  close(mod, -1);
  assert.equal(engine.current.kind, "streaming", "a move is tried first");
  t.mock.timers.tick(3000);
  await flushMocked();
  assert.deepEqual(reports.map((r) => [r.why, r.to, r.outcome]), [["lost", null, "no-path"]]);
  assert.deepEqual(engine.current, { kind: "error", origin: "https://page.example/h/nowhere", message: "the connection was lost" });
});

test("a quiet stream moves once, and again only after datagrams came back or a retry's wait", () => {
  const { engine } = streamingOver("quiet");
  const e = engine as unknown as { watchStall(now: number): void; heardAt: number; movedAt: number };
  let moves = 0;
  Object.assign(engine, { move: () => (moves++, Promise.resolve(true)) });
  e.heardAt = 1000;
  e.watchStall(2500);
  assert.equal(moves, 0, "1.5 s is not quiet yet");
  e.watchStall(3000);
  assert.equal(moves, 1);
  e.movedAt = 3000;
  e.watchStall(4000);
  assert.equal(moves, 1, "nothing heard since the move");
  e.watchStall(8000);
  assert.equal(moves, 2, "a failed move tries again after its wait");
  e.movedAt = 8000;
  e.heardAt = 9000;
  e.watchStall(11_000);
  assert.equal(moves, 3, "quiet again after datagrams came back");
});

test("a stream reports what became of its video five seconds in, and again at its end", () => {
  const { engine, mod } = streamingOver("video");
  const reports = reportsOf(engine);
  const snap = {
    codec: 2, notReady: 3, waitingKey: 40, keys: 1, submitted: 9, decoded: 9, dropped: 0, errors: 1, error: "EncodingError",
    held: 2, presented: 7, firstPresentedAt: 1800, accel: "prefer-hardware", uploadMs: 0, width: 886, height: 1972, backend: "webgl2",
  };
  Object.assign(engine, { video: { snapshot: () => snap, close() {} }, videoSince: 1000 });
  Object.assign(mod, { _pf_session_frames: () => 50 });
  const e = engine as unknown as { watchVideo(now: number): void; stopSession(): void };
  e.watchVideo(5999);
  assert.equal(reports.length, 0, "not before five seconds");
  e.watchVideo(6000);
  e.watchVideo(7000);
  e.stopSession();
  e.stopSession();
  const video = {
    kind: "video", carrier: "wt", codec: "hevc", width: 886, height: 1972, backend: "webgl2", accel: "prefer-hardware",
    received: 50, not_ready: 3, waiting_key: 40, keys: 1, submitted: 9, decoded: 9, held: 2, dropped: 0, presented: 7,
    errors: 1, error: "EncodingError", first_frame_ms: 800,
  };
  assert.deepEqual(reports, [{ ...video, phase: "start" }, { ...video, phase: "end" }], "once at five seconds, once at the end");
});

test("only the carrier the stream rides shows its RTP video, and another carrier takes it down", () => {
  const { engine, mod } = engineIn("ready");
  const shown: string[] = [];
  let removed = 0;
  Object.assign(engine, {
    opts: { ...(engine as unknown as { opts: object }).opts, rtcVideo: true },
    plane: { port: 9778, cert_hash_sha256: "00".repeat(32), rtc: { cert_hash_sha256: "11".repeat(32), ice_servers: [] } },
    showRtpVideo: (t: { id: string }) => {
      shown.push(t.id);
      Object.assign(engine, { rtpVideo: { remove: () => removed++ } });
    },
  });
  const e = engine as unknown as {
    rtcCarrier(o: string, p: number, h: string, f: unknown, d: boolean): { plan: { onVideo(t: unknown): void }; videoTrack: unknown };
    showTracks(c: unknown): void;
    openCarrier(kind: string, port: number, hash: string, address?: string): void;
    feed: unknown;
  };
  const probe = e.rtcCarrier(ORIGIN, 9778, "00".repeat(32), e.feed, true);
  // What the carrier's `ontrack` does with the answer's track.
  probe.videoTrack = { id: "probe" };
  probe.plan.onVideo({ id: "probe" });
  assert.deepEqual(shown, [], "a WebRTC path beside the race shows nothing while it is not chosen");
  mod.__pfCarrier = probe;
  e.showTracks(probe);
  assert.deepEqual(shown, ["probe"], "chosen, its track is shown");
  e.openCarrier("wt", 9778, "00".repeat(32), "192.168.1.21");
  assert.equal(removed, 1, "a direct carrier takes the old track's video down");
});

test("a stream on an RTP track moves to a direct path, and the page's bitrate control takes over again", async () => {
  const { engine, mod, calls, made } = streamingOver("off-rtp");
  let removed = 0;
  Object.assign(engine, { carrierKind: "rtc", address: null, rtpVideo: { remove: () => removed++ } });
  const e = engine as unknown as { move(why: string, to?: unknown): Promise<boolean>; carrierKind: string; address: string | null };
  assert.equal(await e.move("better", { kind: "wt", host: "100.64.7.7" }), true);
  assert.deepEqual(made, ["100.64.7.7"]);
  assert.equal(e.carrierKind, "wt");
  assert.equal(e.address, "100.64.7.7");
  assert.equal(removed, 1, "the track's video comes down");
  assert.ok(calls.includes("_pf_session_external_video"), "the module decodes and paces the video again");
  assert.notEqual(mod.__pfCarrier, undefined);
});

test("a direct stream moves onto WebRTC as the watch's target", async () => {
  const { engine, made } = streamingOver("onto-rtc");
  const e = engine as unknown as { move(why: string, to?: unknown): Promise<boolean>; carrierKind: string; address: string | null };
  assert.equal(await e.move("better", { kind: "rtc" }), true);
  assert.deepEqual(made, ["rtc"], "no race: the watch already measured it");
  assert.equal(e.carrierKind, "rtc");
  assert.equal(e.address, null);
});

test("a watch moves a stream only to a path its pings found clearly faster", async () => {
  const run = async (name: string, kind: "wt" | "rtc", m: unknown) => {
    const { engine } = streamingOver(name);
    const reports = reportsOf(engine);
    const moves: unknown[] = [];
    Object.assign(engine, {
      carrierKind: kind,
      address: kind === "wt" ? "192.168.1.21" : null,
      measurePaths: async () => m,
      move: (why: string, to: unknown) => (moves.push([why, to]), Promise.resolve(true)),
    });
    const e = engine as unknown as { watchPath(now: number): void; watchedAt: number; movedAt: number };
    e.watchedAt = 0;
    e.movedAt = 0;
    e.watchPath(1000);
    assert.equal(reports.length, 0, "not before its first interval");
    e.watchPath(20_000);
    await new Promise((r) => setImmediate(r));
    return { moves, watch: reports.find((r) => r.kind === "watch") };
  };
  const derp = await run("derp-to-rtc", "wt", { current: 120, direct: { host: "192.168.1.21", ms: 120 }, webrtc: 30 });
  assert.deepEqual(derp.moves, [["better", { kind: "rtc" }]], "a relayed direct path gives way to a punched one");
  assert.deepEqual(derp.watch, {
    kind: "watch", carrier: "wt", current_ms: 120, direct: "192.168.1.21", direct_ms: 120, webrtc_ms: 30, move_to: "rtc",
  });
  const back = await run("rtc-to-direct", "rtc", { current: 40, direct: { host: "100.64.7.7", ms: 8 }, webrtc: null });
  assert.deepEqual(back.moves, [["better", { kind: "wt", host: "100.64.7.7" }]], "a path that got through its NAT wins back");
  const near = await run("near", "wt", { current: 20, direct: { host: "100.64.7.7", ms: 15 }, webrtc: 12 });
  assert.deepEqual(near.moves, [], "12 ms against 20 is too close to move for");
  const blind = await run("blind", "wt", { current: null, direct: null, webrtc: 5 });
  assert.deepEqual(blind.moves, [], "a path it couldn't ping is never left on a guess");
});

test("a stream moved onto WebRTC takes the bridge's RTP track, and the bridge paces it", async () => {
  const { engine, calls } = streamingOver("onto-rtp");
  const { RtcCarrier } = await import("./carrier/rtc.ts");
  const shown: unknown[] = [];
  let audioClosed = 0;
  Object.assign(engine, {
    audio: { close: () => audioClosed++ },
    showRtpVideo: (t: unknown) => shown.push(t),
    playRtpAudio: (t: unknown) => shown.push(t),
    openMove: (_to: unknown, _p: number, _h: string, feed: import("./carrier/feed.ts").Feed) => {
      const c = Object.create(RtcCarrier.prototype) as InstanceType<typeof RtcCarrier>;
      Object.assign(c, {
        rtpVideo: true,
        rtpAudio: true,
        videoTrack: { id: "v" },
        audioTrack: { id: "a" },
        open: async () => {
          feed.controlReady();
          feed.control(new Uint8Array([1]));
        },
        close() {},
      });
      return c;
    },
  });
  Object.assign((engine as unknown as { opts: object }).opts, { rtcVideo: true });
  const e = engine as unknown as { move(why: string, to?: unknown): Promise<boolean>; carrierKind: string };
  assert.equal(await e.move("better", { kind: "rtc" }), true);
  assert.equal(e.carrierKind, "rtc");
  assert.deepEqual(shown, [{ id: "v" }, { id: "a" }], "the tracks go up once the stream rides them");
  assert.equal(audioClosed, 1, "the module's own audio gives way to the track's");
  assert.ok(calls.includes("_pf_session_external_video"), "the page's bitrate control steps aside for the bridge's");
});
