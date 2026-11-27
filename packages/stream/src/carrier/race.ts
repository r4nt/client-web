// Which of a host's direct addresses this browser reaches: each is dialled at the plane's
// `/probe`, which only completes a handshake, and the first to open is the one the session then
// dials at `/pf2`. A probe is never a session, so the host starts nothing for it.

import { hexBytes } from "../tunnel.ts";

/** How far apart the probes start, and how long the race waits for any of them. */
export const STAGGER_MS = 250;
export const RACE_MS = 3000;

/** The hosts to try, as a URL takes them: the one that won last time, the page's own, then the
 *  host's published addresses, each once. Only plain IP literals of the host's are taken. */
export function directHosts(own: string, published: readonly string[], remembered: string | null): string[] {
  const ip = (a: string) => /^[0-9.]+$/.test(a) || /^[0-9a-f:]+$/i.test(a);
  const url = (a: string) => (a.includes(":") && !a.startsWith("[") ? `[${a}]` : a);
  const hosts = [...(remembered ? [remembered] : []), ...(own ? [own] : []), ...published.filter(ip).map(url)];
  return [...new Set(hosts)];
}

/** The winner of a race: its host, how long its handshake took, and its round trip, as the
 *  connection measured it, else half the handshake. */
export interface Won {
  host: string;
  ms: number;
  rtt: number;
}

/** What the browser measured on `wt`, in ms: the lowest round trip it saw, else its smoothed
 *  one; `null` where it says neither. A handshake overstates a short path's round trip, which
 *  a pure measure such as WebRTC's would then beat on the same path. */
async function measuredRtt(wt: WebTransport): Promise<number | null> {
  const getStats = (wt as unknown as { getStats?: () => Promise<{ minRtt?: number; smoothedRtt?: number }> }).getStats;
  if (typeof getStats !== "function") return null;
  const s = await getStats.call(wt).catch(() => null);
  const rtt = s?.minRtt ?? s?.smoothedRtt;
  return typeof rtt === "number" && rtt > 0 ? rtt : null;
}

/** The first of `hosts` whose plane at `port`, pinned to `certHash`, completes a handshake
 *  within `timeoutMs`, each started `staggerMs` after the last or at once after a refusal.
 *  `null` when none does. Every probe is closed before this returns. */
export function raceWebTransport(
  hosts: readonly string[],
  port: number,
  certHash: string,
  opts: { WT?: typeof WebTransport; staggerMs?: number; timeoutMs?: number } = {},
): Promise<Won | null> {
  const WT = opts.WT ?? globalThis.WebTransport;
  const stagger = opts.staggerMs ?? STAGGER_MS;
  const probes: WebTransport[] = [];
  return new Promise<Won | null>((resolve) => {
    if (!WT || hosts.length === 0) return resolve(null);
    let next = 0;
    let failed = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (won: Won | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      resolve(won);
    };
    const deadline = setTimeout(() => finish(null), opts.timeoutMs ?? RACE_MS);
    const start = () => {
      clearTimeout(timer);
      if (done || next >= hosts.length) return;
      const host = hosts[next++]!;
      const started = Date.now();
      let wt: WebTransport;
      try {
        wt = new WT(`https://${host}:${port}/probe`, {
          allowPooling: false,
          serverCertificateHashes: [{ algorithm: "sha-256", value: hexBytes(certHash) }],
        });
      } catch {
        return refused();
      }
      probes.push(wt);
      wt.ready.then(
        async () => {
          const ms = Date.now() - started;
          finish({ host, ms, rtt: (await measuredRtt(wt)) ?? ms / 2 });
        },
        () => refused(),
      );
      timer = setTimeout(start, stagger);
    };
    // A refusal starts the next at once; the last one's ends the race.
    const refused = () => {
      if (++failed === hosts.length) return finish(null);
      start();
    };
    start();
  }).finally(() => {
    for (const wt of probes) {
      try {
        wt.close();
      } catch {
        // A probe that never opened has nothing to close.
      }
    }
  });
}
