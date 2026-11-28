import { test } from "node:test";
import assert from "node:assert/strict";
import type { PathReport } from "@punktfunk/stream";
import { reportTo } from "./report.ts";

test("a path report goes to the page's own server, and a failure to send it is nobody's", async () => {
  const sent: [string, RequestInit][] = [];
  const send = reportTo("https://pf.example/app/?host=desk", async (url, init) => {
    sent.push([String(url), init!]);
    throw new TypeError("offline");
  });
  const r: PathReport = { kind: "path", probes: [], direct_ms: null, webrtc_ms: 40, carrier: "rtc", why: "no-direct" };
  send(r);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]![0], "https://pf.example/app/diag");
  assert.equal(sent[0]![1].method, "POST");
  assert.equal(sent[0]![1].keepalive, true);
  assert.deepEqual(JSON.parse(sent[0]![1].body as string), r);
});
