import { describe, expect, it } from "vitest";
import { HANDSHAKE_TIMEOUT_MS } from "@gb-ava/protocol";
import { initialState, reduce, type SupervisorEffect, type SupervisorEvent, type SupervisorState } from "../../extension/src/lib/supervisor.js";

const T0 = 1_000_000;
const options = { random: () => 0.5 };

interface Run {
  state: SupervisorState;
  effects: SupervisorEffect[];
  log: SupervisorEffect[][];
}

/** Distributes the Omit across the union so each variant keeps its discriminants. */
type EventInput = SupervisorEvent extends infer Event
  ? Event extends { now: number }
    ? Omit<Event, "now"> & { now?: number }
    : never
  : never;

function run(events: EventInput[], start?: SupervisorState): Run {
  let state = start ?? initialState(T0);
  const log: SupervisorEffect[][] = [];
  let effects: SupervisorEffect[] = [];
  for (const event of events) {
    const next = reduce(state, { ...event, now: event.now ?? T0 } as SupervisorEvent, options);
    state = next.state;
    effects = next.effects;
    log.push(effects);
  }
  return { state, effects, log };
}

function effectTypes(effects: SupervisorEffect[]): string[] {
  return effects.map((effect) => effect.type);
}

describe("supervisor — configuration gating", () => {
  it("does not connect without a token", () => {
    const { state, effects } = run([{ type: "boot", hasToken: false, hasHandshaked: false }]);
    expect(state.phase).toBe("unconfigured");
    expect(effectTypes(effects)).toEqual([]);
  });

  it("connects when a token is present", () => {
    const { state, effects } = run([{ type: "boot", hasToken: true, hasHandshaked: false }]);
    expect(state.phase).toBe("connecting");
    expect(effectTypes(effects)).toEqual(["connect"]);
  });

  it("stops hammering when the token is removed", () => {
    const connected = run(
      [
        { type: "boot", hasToken: true, hasHandshaked: false },
        { type: "socket_open" },
        { type: "handshake_ok", sessionId: "s1" },
      ],
    );
    expect(connected.state.phase).toBe("connected");

    const after = run([{ type: "settings_changed", hasToken: false }, { type: "tick" }], connected.state);
    expect(after.state.phase).toBe("unconfigured");
    expect(after.log.flat().some((effect) => effect.type === "close_socket")).toBe(true);
    expect(effectTypes(after.effects)).toEqual([]);
  });
});

describe("supervisor — handshake", () => {
  it("sends hello when the socket opens and becomes connected only after hello_ok", () => {
    const opened = run([
      { type: "boot", hasToken: true, hasHandshaked: false },
      { type: "socket_open" },
    ]);
    expect(opened.state.phase).toBe("handshaking");
    expect(effectTypes(opened.effects)).toEqual(["send_hello"]);

    const done = run([{ type: "handshake_ok", sessionId: "sess-1" }], opened.state);
    expect(done.state.phase).toBe("connected");
    expect(done.state.sessionId).toBe("sess-1");
    expect(done.state.attempts).toBe(0);
  });

  it("blocks on an unauthorized rejection instead of retrying a wrong token forever", () => {
    const { state, effects } = run([
      { type: "boot", hasToken: true, hasHandshaked: false },
      { type: "socket_open" },
      { type: "handshake_rejected", code: "unauthorized" },
      { type: "tick", now: T0 + 60_000 },
    ]);
    expect(state.phase).toBe("blocked");
    expect(state.blockedReason).toBe("unauthorized");
    expect(effectTypes(effects)).toEqual([]);
    expect(state.nextAttemptAt).toBeUndefined();
  });

  it("recovers from blocked when the human changes the configuration", () => {
    const blocked = run([
      { type: "boot", hasToken: true, hasHandshaked: false },
      { type: "socket_open" },
      { type: "handshake_rejected", code: "unauthorized" },
    ]);
    const after = run([{ type: "settings_changed", hasToken: true }], blocked.state);
    expect(after.state.phase).toBe("connecting");
    expect(effectTypes(after.effects)).toContain("connect");
  });

  it("times out a handshake that never completes", () => {
    const opened = run([
      { type: "boot", hasToken: true, hasHandshaked: false },
      { type: "socket_open" },
    ]);
    const stuck = run([{ type: "tick", now: T0 + HANDSHAKE_TIMEOUT_MS + 1 }], opened.state);
    expect(stuck.state.phase).toBe("backoff");
    expect(effectTypes(stuck.effects)).toContain("schedule_retry");
  });
});

describe("supervisor — reconnect loop", () => {
  it("backs off with a scheduled retry when the socket drops, and reconnects on the tick after it is due", () => {
    const connected = run([
      { type: "boot", hasToken: true, hasHandshaked: false },
      { type: "socket_open" },
      { type: "handshake_ok", sessionId: "s1" },
    ]);
    const dropped = run([{ type: "socket_closed", now: T0 + 5_000 }], connected.state);
    expect(dropped.state.phase).toBe("backoff");
    expect(dropped.state.attempts).toBe(1);
    const retry = dropped.effects.find((effect) => effect.type === "schedule_retry");
    expect(retry).toBeDefined();
    expect(dropped.state.nextAttemptAt).toBeGreaterThan(T0 + 5_000);

    const early = run([{ type: "tick", now: T0 + 5_100 }], dropped.state);
    expect(early.state.phase).toBe("backoff");
    // An early tick (a timer firing just before its due time by the wall clock)
    // re-arms the retry for the remainder instead of dropping it until the next
    // keepalive tick, which in a real browser can be 20 s away.
    const rearmed = early.effects.find((effect) => effect.type === "schedule_retry") as
      | { type: "schedule_retry"; delayMs: number }
      | undefined;
    expect(rearmed?.delayMs).toBe((dropped.state.nextAttemptAt ?? 0) - (T0 + 5_100));
    const oneMsEarly = run([{ type: "tick", now: (dropped.state.nextAttemptAt ?? 0) - 1 }], dropped.state);
    expect(oneMsEarly.effects.find((effect) => effect.type === "schedule_retry")).toMatchObject({ delayMs: 1 });

    const due = run([{ type: "tick", now: (dropped.state.nextAttemptAt ?? 0) + 1 }], dropped.state);
    expect(due.state.phase).toBe("connecting");
    expect(effectTypes(due.effects)).toEqual(["connect"]);
  });

  it("keeps escalating attempts until a handshake succeeds, then resets", () => {
    let state = run([{ type: "boot", hasToken: true, hasHandshaked: false }]).state;
    const waits: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      // Each cycle: the retry timer fires (tick), the connect fails, a new delay is chosen.
      const due = run([{ type: "tick", now: (state.nextAttemptAt ?? state.since) + 1 }], state);
      state = due.state;
      const failed = run([{ type: "connect_failed", now: (state.nextAttemptAt ?? state.since) }], state);
      state = failed.state;
      const retry = failed.effects.find((effect) => effect.type === "schedule_retry");
      waits.push(retry !== undefined && retry.type === "schedule_retry" ? retry.delayMs : -1);
    }
    expect(state.attempts).toBe(6);
    expect(waits[0]).toBe(500);
    expect(waits[waits.length - 1]).toBeLessThanOrEqual(30_000);

    const recovered = run(
      [
        { type: "tick", now: (state.nextAttemptAt ?? 0) + 1 },
        { type: "socket_open", now: (state.nextAttemptAt ?? 0) + 2 },
        { type: "handshake_ok", now: (state.nextAttemptAt ?? 0) + 3, sessionId: "s2" },
      ],
      state,
    );
    expect(recovered.state.phase).toBe("connected");
    expect(recovered.state.attempts).toBe(0);
  });

  it("pings on every tick while connected and does not reopen the socket", () => {
    const connected = run([
      { type: "boot", hasToken: true, hasHandshaked: false },
      { type: "socket_open" },
      { type: "handshake_ok", sessionId: "s1" },
    ]);
    const tick = run([{ type: "tick", now: T0 + 20_000 }], connected.state);
    expect(effectTypes(tick.effects)).toEqual(["send_ping"]);
    expect(tick.state.phase).toBe("connected");
  });

  it("marks a resumed session so the bridge can tell a worker restart from a fresh install", () => {
    const { state } = run([{ type: "boot", hasToken: true, hasHandshaked: true }]);
    expect(state.hasHandshaked).toBe(true);
  });

  it("never reconnects after stop", () => {
    const connected = run([
      { type: "boot", hasToken: true, hasHandshaked: false },
      { type: "socket_open" },
      { type: "handshake_ok", sessionId: "s1" },
      { type: "stop" },
    ]);
    expect(connected.state.phase).toBe("stopped");
    const later = run([{ type: "tick", now: T0 + 10 * 60_000 }, { type: "socket_closed" }], connected.state);
    expect(later.state.phase).toBe("stopped");
    expect(effectTypes(later.effects)).toEqual([]);
  });
});
