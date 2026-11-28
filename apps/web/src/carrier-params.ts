// The page address's knobs for the stream's path, for trying one by hand: `carrier=` pins it,
// `start=` only starts there and lets the stream move as its paths measure. Both name a path
// `direct` (WebTransport), `webrtc` (the host's WebRTC peer) or `bridge` (the page server's
// WebSocket). `rtcwait=<seconds>` is how long a WebRTC dial waits.

import type { EngineOptions } from "@punktfunk/stream";

const PATHS = { direct: "wt", webrtc: "rtc", bridge: "ws" } as const;

type Params = Pick<EngineOptions, "carrier" | "rtcWaitSecs" | "rtcVideo" | "startOn">;

/** The engine options `q` asks for. WebRTC carries the video and audio as RTP tracks. */
export function carrierParams(q: URLSearchParams): Params {
  const path = (name: string | null) => (name && Object.hasOwn(PATHS, name) ? PATHS[name as keyof typeof PATHS] : null);
  const carrier = path(q.get("carrier"));
  const start = path(q.get("start"));
  const wait = Number(q.get("rtcwait"));
  return {
    ...(carrier ? { carrier } : {}),
    ...(start === "wt" || start === "rtc" ? { startOn: start } : {}),
    ...(wait >= 5 && wait <= 600 ? { rtcWaitSecs: wait } : {}),
    rtcVideo: true,
  };
}
