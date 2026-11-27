// Moving the running session to a new connection, as the host's handover does it.
//
// The new connection's control stream first carries the handover: the page asks, the device
// proves its key, the host acks. Its bytes after the ack are the session's next control frames,
// and they wait until the old connection's control stream has ended, which the host ends before
// it acks. So the session reads every frame in the order the host sent it.

import type { Feed } from "./feed.ts";

/** How long the host has to answer a handover, and how long the old control stream may take to
 *  end once it has. The old one is lost if it never ends: the session reads on from the new. */
export const ASK_MS = 5000;
export const OLD_END_MS = 2000;

/** What a move asks of the wasm session. */
export interface MoveWasm {
  /** Ask the host to move the session; `false` when none runs. */
  begin(): boolean;
  /** The new connection's control bytes before the ack: `1` moved, `-1` refused, `0` not yet. */
  recv(bytes: Uint8Array): number;
  /** The old control stream ended: read the new one from here. */
  adopt(): void;
  cancel(): void;
}

/** A carrier's feed into the session, until a move retires its carrier. A retired carrier's
 *  control still reaches the session until it ends; its close, or that end, is the move's. */
export class Retirable implements Feed {
  private move: Move | null = null;

  constructor(private readonly inner: Feed) {}

  retire(move: Move): void {
    this.move = move;
  }

  datagram(bytes: Uint8Array): void {
    this.inner.datagram(bytes);
  }
  control(bytes: Uint8Array): void {
    this.inner.control(bytes);
  }
  uni(bytes: Uint8Array): void {
    if (!this.move) this.inner.uni(bytes);
  }
  controlReady(): void {
    this.inner.controlReady();
  }
  controlEnded(): void {
    if (this.move) this.move.oldEnded();
    else this.inner.controlEnded?.();
  }
  closed(code: number, reason: string): void {
    if (this.move) this.move.oldEnded();
    else this.inner.closed(code, reason);
  }
}

type Phase = "asking" | "moved" | "adopted" | "failed";

/** One move. `done` is `true` once the host has the session on the new connection. */
export class Move {
  readonly done: Promise<boolean>;
  /** The new carrier's feed, retirable in its turn. */
  readonly feed: Retirable;
  private phase: Phase = "asking";
  private held: Uint8Array[] = [];
  private oldGone = false;
  private settle!: (moved: boolean) => void;
  private timer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly session: Feed,
    private readonly wasm: MoveWasm,
  ) {
    this.done = new Promise((resolve) => (this.settle = resolve));
    this.timer = setTimeout(() => this.fail(), ASK_MS);
    this.feed = new Retirable({
      datagram: (b) => session.datagram(b),
      control: (b) => this.control(b),
      uni: (b) => (this.phase === "asking" ? this.fail() : session.uni(b)),
      controlReady: () => {
        if (!this.wasm.begin()) this.fail();
      },
      controlEnded: () => session.controlEnded?.(),
      closed: (code, reason) => (this.phase === "asking" ? this.fail() : session.closed(code, reason)),
    });
  }

  /** The old connection's control stream ended, or the old connection closed. */
  oldEnded(): void {
    this.oldGone = true;
    if (this.phase === "moved") this.adopt();
  }

  /** No move: the host refused, never answered, or the new connection failed first. */
  fail(): void {
    if (this.phase !== "asking") return;
    this.phase = "failed";
    clearTimeout(this.timer);
    this.wasm.cancel();
    this.settle(false);
  }

  private control(bytes: Uint8Array): void {
    switch (this.phase) {
      case "asking": {
        const heard = this.wasm.recv(bytes);
        if (heard < 0) return this.fail();
        if (heard > 0) {
          this.phase = "moved";
          clearTimeout(this.timer);
          this.settle(true);
          if (this.oldGone) return this.adopt();
          this.timer = setTimeout(() => this.adopt(), OLD_END_MS);
        }
        return;
      }
      case "moved":
        this.held.push(bytes);
        return;
      case "adopted":
        return this.session.control(bytes);
      case "failed":
        return;
    }
  }

  private adopt(): void {
    if (this.phase !== "moved") return;
    this.phase = "adopted";
    clearTimeout(this.timer);
    this.wasm.adopt();
    for (const b of this.held) this.session.control(b);
    this.held = [];
  }
}
