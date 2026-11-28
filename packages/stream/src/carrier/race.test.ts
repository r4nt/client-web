// Racing the host's direct addresses: which are tried, in what order, and which one wins.

import { test } from "node:test";
import assert from "node:assert/strict";
import { directHosts, raceWebTransport } from "./race.ts";

test("the hosts to try: the remembered one, the page's own, then the host's, each once", () => {
  assert.deepEqual(directHosts("pf.example", ["192.168.1.21", "100.64.1.2", "2001:db8::21"], null), [
    "pf.example",
    "192.168.1.21",
    "100.64.1.2",
    "[2001:db8::21]",
  ]);
  assert.deepEqual(directHosts("", ["192.168.1.21", "100.64.1.2"], "100.64.1.2"), ["100.64.1.2", "192.168.1.21"]);
  assert.deepEqual(directHosts("192.168.1.21", ["192.168.1.21"], null), ["192.168.1.21"], "once");
  assert.deepEqual(directHosts("", [], null), [], "nothing to dial");
  assert.deepEqual(directHosts("", ["not an address", "fe80::1%eth0"], null), [], "only plain IPs");
});

/** A WebTransport whose handshake each host answers as `answers` says, after `ms`. */
function fakeTransport(
  answers: Record<string, { open: boolean; ms: number; rtt?: { minRtt?: number; smoothedRtt?: number } }>,
  made: string[],
  closed: string[],
) {
  return class {
    ready: Promise<void>;
    closed = new Promise<never>(() => {});
    constructor(readonly url: string) {
      made.push(url);
      const host = new URL(url).hostname;
      const a = answers[host] ?? { open: false, ms: 10_000 };
      this.ready = new Promise((resolve, reject) => setTimeout(() => (a.open ? resolve() : reject(new Error("no"))), a.ms));
      this.ready.catch(() => {});
    }
    close() {
      closed.push(this.url);
    }
    async getStats() {
      return answers[new URL(this.url).hostname]?.rtt ?? {};
    }
  } as unknown as typeof WebTransport;
}

test("the first host whose handshake completes wins, and every probe is closed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const made: string[] = [];
  const closed: string[] = [];
  const WT = fakeTransport({ "192.168.1.21": { open: true, ms: 400 }, "100.64.1.2": { open: true, ms: 50 } }, made, closed);
  const won = raceWebTransport(["192.168.1.21", "100.64.1.2"], 9778, "00".repeat(32), { WT, staggerMs: 250, timeoutMs: 3000 });
  t.mock.timers.tick(250);
  assert.deepEqual(made, ["https://192.168.1.21:9778/probe", "https://100.64.1.2:9778/probe"], "the second a quarter second later");
  t.mock.timers.tick(50);
  assert.deepEqual(await won, { host: "100.64.1.2", ms: 50, rtt: 25 }, "the faster path, though it started later: half its handshake, with no stats to say better");
  assert.deepEqual(closed.sort(), made.sort());
});

test("a host that refuses gives way to the next at once, and none by the deadline is no path", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const made: string[] = [];
  const WT = fakeTransport({ a: { open: false, ms: 10 }, b: { open: true, ms: 20 } }, made, []);
  const won = raceWebTransport(["a", "b"], 1, "00".repeat(32), { WT, staggerMs: 250, timeoutMs: 3000 });
  t.mock.timers.tick(10);
  await Promise.resolve();
  assert.deepEqual(made, ["https://a:1/probe", "https://b:1/probe"], "no wait after a refusal");
  t.mock.timers.tick(20);
  assert.equal((await won)?.host, "b");

  const none = raceWebTransport(["c"], 1, "00".repeat(32), { WT, staggerMs: 250, timeoutMs: 3000 });
  t.mock.timers.tick(3000);
  assert.equal(await none, null);
  assert.equal(await raceWebTransport([], 1, "00".repeat(32), { WT, staggerMs: 250, timeoutMs: 3000 }), null);
});

test("a path's round trip is what the connection measured, the lowest it saw first", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const WT = fakeTransport(
    {
      lan: { open: true, ms: 30, rtt: { minRtt: 3, smoothedRtt: 5 } },
      older: { open: true, ms: 30, rtt: { smoothedRtt: 4 } },
    },
    [],
    [],
  );
  const lan = raceWebTransport(["lan"], 1, "00".repeat(32), { WT });
  t.mock.timers.tick(30);
  assert.deepEqual(await lan, { host: "lan", ms: 30, rtt: 3 }, "a handshake overstates a LAN's round trip");
  const older = raceWebTransport(["older"], 1, "00".repeat(32), { WT });
  t.mock.timers.tick(30);
  assert.equal((await older)?.rtt, 4, "the smoothed one where no lowest is told");
});

test("each probe's end is told: opened, refused, or still out when the race ended", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const WT = fakeTransport(
    { "192.168.1.21": { open: false, ms: 20 }, "100.64.1.2": { open: true, ms: 60 }, "10.0.0.9": { open: true, ms: 900 } },
    [],
    [],
  );
  const probes: unknown[] = [];
  const won = raceWebTransport(["192.168.1.21", "100.64.1.2", "10.0.0.9", "10.0.0.10"], 9778, "00".repeat(32), {
    WT,
    staggerMs: 50,
    timeoutMs: 3000,
    onProbe: (p) => probes.push(p),
  });
  const flush = () => new Promise((r) => setImmediate(r));
  t.mock.timers.tick(20); // the first refuses: the second starts at once
  await flush();
  t.mock.timers.tick(50); // the third starts
  await flush();
  t.mock.timers.tick(10); // the second opens
  await won;
  assert.deepEqual(probes, [
    { host: "192.168.1.21", ms: 20, outcome: "refused" },
    { host: "100.64.1.2", ms: 60, outcome: "open" },
    { host: "10.0.0.9", ms: null, outcome: "late" },
  ], "a host never dialled is not told");
});
