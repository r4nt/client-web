// The engine's path reports, sent to the page's own server, which logs them: whoever runs it can
// read there why a phone streamed over WebRTC rather than directly, or how a move went.

import type { PathReport } from "@punktfunk/stream";

/** Send each report to `diag` beside the page at `page`. A server without the route, or none
 *  reachable, loses the report and nothing else. */
export function reportTo(page: string, via: typeof fetch = fetch): (r: PathReport) => void {
  const url = new URL("diag", page).href;
  return (r) => {
    via(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(r),
      keepalive: true,
    }).catch(() => {});
  };
}
