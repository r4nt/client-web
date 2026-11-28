import { test } from "node:test";
import assert from "node:assert/strict";
import { carrierParams } from "./carrier-params.ts";

test("carrier= and start= name the same paths, and WebRTC always carries its media as RTP", () => {
  const p = (q: string) => carrierParams(new URLSearchParams(q));
  assert.deepEqual(p(""), { rtcVideo: true });
  assert.deepEqual(p("carrier=direct"), { carrier: "wt", rtcVideo: true });
  assert.deepEqual(p("carrier=webrtc"), { carrier: "rtc", rtcVideo: true });
  assert.deepEqual(p("carrier=bridge"), { carrier: "ws", rtcVideo: true });
  assert.deepEqual(p("start=direct"), { startOn: "wt", rtcVideo: true });
  assert.deepEqual(p("start=webrtc"), { startOn: "rtc", rtcVideo: true });
  assert.deepEqual(p("start=bridge"), { rtcVideo: true }, "the bridge is only ever a fallback or a pin");
  assert.deepEqual(p("rtcwait=20"), { rtcWaitSecs: 20, rtcVideo: true });
  assert.deepEqual(p("carrier=wt&rtp=0&rtcwait=2"), { rtcVideo: true }, "old names and knobs are gone");
});
