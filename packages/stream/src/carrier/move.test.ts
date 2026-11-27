import { test } from "node:test";
import assert from "node:assert/strict";
import type { Feed } from "./feed.ts";
import { ASK_MS, Move, type MoveWasm, OLD_END_MS, Retirable } from "./move.ts";

const b = (...xs: number[]) => new Uint8Array(xs);

/** The session's feed, recording what reached it. */
function session() {
  const got: string[] = [];
  const feed: Feed = {
    datagram: (d) => got.push(`dgram ${d[0]}`),
    control: (d) => got.push(`ctl ${[...d].join(",")}`),
    uni: () => got.push("uni"),
    controlReady: () => got.push("ready"),
    closed: (code) => got.push(`closed ${code}`),
  };
  return { feed, got };
}

/** A wasm side whose `recv` answers from `answers`, one per call. */
function wasm(answers: number[], began = true) {
  const calls: string[] = [];
  const w: MoveWasm = {
    begin: () => (calls.push("begin"), began),
    recv: () => answers.shift() ?? 0,
    adopt: () => calls.push("adopt"),
    cancel: () => calls.push("cancel"),
  };
  return { w, calls };
}

test("after the ack, the new connection's frames wait for the old control stream to end", async () => {
  const s = session();
  const { w, calls } = wasm([0, 1]);
  const move = new Move(s.feed, w);
  move.feed.controlReady();
  move.feed.control(b(1)); // the challenge
  move.feed.control(b(2)); // the ack
  assert.equal(await move.done, true);
  move.feed.control(b(3));
  assert.deepEqual(s.got, [], "nothing of the new stream before the old one ends");
  move.oldEnded();
  assert.deepEqual(calls, ["begin", "adopt"]);
  assert.deepEqual(s.got, ["ctl 3"]);
  move.feed.control(b(4));
  assert.deepEqual(s.got, ["ctl 3", "ctl 4"], "then straight through");
});

test("an old stream that already ended lets the session read on at the ack", async () => {
  const s = session();
  const { w, calls } = wasm([1]);
  const move = new Move(s.feed, w);
  move.oldEnded();
  move.feed.control(b(2));
  assert.equal(await move.done, true);
  assert.deepEqual(calls, ["adopt"]);
});

test("an old stream that never ends is given up after a while", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = session();
  const { w, calls } = wasm([1]);
  const move = new Move(s.feed, w);
  move.feed.control(b(2));
  move.feed.control(b(3));
  t.mock.timers.tick(OLD_END_MS);
  assert.deepEqual(calls, ["adopt"]);
  assert.deepEqual(s.got, ["ctl 3"]);
});

test("a refusal, no answer, no session or a close before the ack moves nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const refused = new Move(session().feed, wasm([-1]).w);
  refused.feed.control(b(1));
  assert.equal(await refused.done, false);

  const silent = wasm([]);
  const unanswered = new Move(session().feed, silent.w);
  t.mock.timers.tick(ASK_MS);
  assert.equal(await unanswered.done, false);
  assert.deepEqual(silent.calls, ["cancel"]);

  const none = new Move(session().feed, wasm([], false).w);
  none.feed.controlReady();
  assert.equal(await none.done, false);

  const s = session();
  const closed = new Move(s.feed, wasm([]).w);
  closed.feed.closed(0, "");
  assert.equal(await closed.done, false);
  assert.deepEqual(s.got, [], "the session never hears of the new connection's close");
});

test("a retired carrier's control reaches the session to its end, and its close only ends the move", async () => {
  const s = session();
  const old = new Retirable(s.feed);
  const { w, calls } = wasm([1]);
  const move = new Move(s.feed, w);
  old.retire(move);
  move.feed.control(b(2));
  assert.equal(await move.done, true);
  old.control(b(9));
  old.datagram(b(8));
  old.closed(0x53, "moved");
  assert.deepEqual(s.got, ["ctl 9", "dgram 8"]);
  assert.deepEqual(calls, ["adopt"]);
  move.feed.closed(0, "");
  assert.deepEqual(s.got, ["ctl 9", "dgram 8", "closed 0"], "the new carrier's close is the session's");
});
