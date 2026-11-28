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

/** How many pings time a path, and how long each waits for its echo. */
export const PINGS = 5;
export const PING_WAIT_MS = 500;

/** The winner of a race: its host, how long its handshake took, and its round trip: the lowest
 *  of its pings, else what the connection measured, else half the handshake (`rttBy`). */
export interface Won {
  host: string;
  ms: number;
  rtt: number;
  rttBy: "ping" | "stats" | "handshake";
}

/** The round trip of `wt` in ms: the lowest of `n` pings over its datagrams, which a probe
 *  echoes, each sent once the last came back or waited `waitMs`. `null` when the first never
 *  came back. */
export async function pingWt(wt: WebTransport, n = PINGS, waitMs = PING_WAIT_MS): Promise<number | null> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  try {
    const d = wt.datagrams as unknown as {
      readable: ReadableStream<Uint8Array>;
      writable?: WritableStream<Uint8Array>;
      createWritable?: () => WritableStream<Uint8Array>;
    };
    reader = d.readable.getReader();
    writer = (d.createWritable ? d.createWritable() : d.writable!).getWriter();
  } catch {
    return null;
  }
  let best: number | null = null;
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  try {
    for (let i = 0; i < n; i++) {
      const ping = new Uint8Array([0x70, 0x66, 0x70, 0x67, i >> 24, i >> 16, i >> 8, i]);
      const sent = performance.now();
      await writer.write(ping);
      const deadline = sent + waitMs;
      for (;;) {
        const left = deadline - performance.now();
        if (left <= 0) break;
        pending ??= reader.read();
        const got = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), left))]);
        // A host that never echoed one: an older one, with no pings to answer.
        if (got === null) {
          if (best === null) return null;
          break;
        }
        pending = null;
        if (got.done) return best;
        if (got.value.length === ping.length && got.value.every((b, j) => b === ping[j])) {
          best = Math.min(best ?? Infinity, performance.now() - sent);
          break;
        }
      }
    }
  } catch {
    // A connection that closed mid-ping: what came back before stands.
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
  return best;
}

/** How one probe of a race ended: its handshake opened or was refused after `ms`, or it was
 *  still out when the race ended. */
export interface Probe {
  host: string;
  ms: number | null;
  outcome: "open" | "refused" | "late";
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
 *  `null` when none does. Every probe is closed before this returns; `onProbe` hears how each
 *  dialled one ended. */
export function raceWebTransport(
  hosts: readonly string[],
  port: number,
  certHash: string,
  opts: {
    WT?: typeof WebTransport;
    staggerMs?: number;
    timeoutMs?: number;
    onProbe?: (p: Probe) => void;
    ping?: (wt: WebTransport) => Promise<number | null>;
  } = {},
): Promise<Won | null> {
  const WT = opts.WT ?? globalThis.WebTransport;
  const stagger = opts.staggerMs ?? STAGGER_MS;
  const probes: WebTransport[] = [];
  const out = new Set<string>();
  const told = (host: string, ms: number | null, outcome: Probe["outcome"]) => {
    out.delete(host);
    opts.onProbe?.({ host, ms, outcome });
  };
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
      for (const host of [...out]) told(host, null, "late");
      resolve(won);
    };
    // A probe that opened is timing its path: the deadline no longer ends the race.
    let opened = false;
    const deadline = setTimeout(() => opened || finish(null), opts.timeoutMs ?? RACE_MS);
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
        if (!done) told(host, 0, "refused");
        return refused();
      }
      probes.push(wt);
      out.add(host);
      wt.ready.then(
        async () => {
          const ms = Date.now() - started;
          if (done) return;
          opened = true;
          told(host, ms, "open");
          const pinged = await (opts.ping ?? pingWt)(wt);
          const stats = pinged === null ? await measuredRtt(wt) : null;
          finish(
            pinged !== null
              ? { host, ms, rtt: pinged, rttBy: "ping" }
              : stats !== null
                ? { host, ms, rtt: stats, rttBy: "stats" }
                : { host, ms, rtt: ms / 2, rttBy: "handshake" },
          );
        },
        () => {
          if (done) return;
          told(host, Date.now() - started, "refused");
          refused();
        },
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
