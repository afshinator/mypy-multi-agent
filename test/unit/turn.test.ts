/**
 * Unit tests for `shared/turn.ts`: turn pairing by identity (#21), the guards
 * that keep malformed log entries out of the durations, and the "no mutation of
 * inputs" promise in the module header.
 *
 * StrykerJS found four surviving behaviours here (issue #141 follow-up): an
 * id-less pair could be mixed up, a payload-less entry could throw, and a second
 * close for the same key was never exercised.
 */
import { describe, expect, it } from "vitest";
import { turnDurations } from "../../shared/turn";

const agents = new Set(["a1"]);

type Entry = Record<string, unknown>;

const order = (ts: number, payload: Record<string, unknown> = {}): Entry => ({
  type: "WORK_ORDER",
  sender: "supervisor",
  recipient: "a1",
  timestamp: ts,
  payload,
});

const report = (ts: number, payload: Record<string, unknown> = {}): Entry => ({
  type: "FINAL_REPORT",
  sender: "a1",
  recipient: "supervisor",
  timestamp: ts,
  payload,
});

describe("turnDurations", () => {
  it("pairs an order with its report by task id", () => {
    const conversation = [order(1000, { taskId: "t1" }), report(6000, { taskId: "t1" })];
    expect(turnDurations(conversation, agents)).toEqual({ a1: [5000] });
  });

  it("does not pair two turns that share no identity", () => {
    // Both entries are identity-less. Pairing them would invent a duration from
    // nothing, which is the pre-#21 zip-by-order behaviour.
    const conversation = [order(1000), report(6000)];
    expect(turnDurations(conversation, agents)).toEqual({});
  });

  it("skips a turn whose identity is not a usable string", () => {
    const numeric = [
      {
        type: "WORK_ORDER",
        sender: "supervisor",
        recipient: "a1",
        timestamp: 1000,
        correlationId: 5,
        payload: {},
      },
      {
        type: "FINAL_REPORT",
        sender: "a1",
        recipient: "supervisor",
        timestamp: 6000,
        correlationId: 5,
        payload: {},
      },
    ];
    expect(turnDurations(numeric, agents)).toEqual({});
    const empty = [
      {
        type: "PROMPT",
        sender: "supervisor",
        recipient: "a1",
        timestamp: 1000,
        correlationId: "",
        payload: {},
      },
      {
        type: "RESPONSE",
        sender: "a1",
        recipient: "supervisor",
        timestamp: 6000,
        correlationId: "",
        payload: {},
      },
    ];
    expect(turnDurations(empty, agents)).toEqual({});
  });

  it("skips an entry with no payload instead of throwing", () => {
    const noPayload: Entry = { type: "WORK_ORDER", sender: "supervisor", recipient: "a1" };
    expect(() => turnDurations([noPayload], agents)).not.toThrow();
    expect(turnDurations([noPayload, report(6000, { taskId: "t1" })], agents)).toEqual({});
  });

  it("pairs every close when one key has more than one", () => {
    const conversation = [
      order(1000, { taskId: "t1" }),
      order(2000, { taskId: "t1" }),
      report(6000, { taskId: "t1" }),
      report(7000, { taskId: "t1" }),
    ];
    expect(turnDurations(conversation, agents)).toEqual({ a1: [5000, 5000] });
  });

  it("pairs out-of-order closes by identity, not by arrival", () => {
    // Closes arrive t2 then t1; the durations must follow the ids, not the order.
    const conversation = [
      order(1000, { taskId: "t1" }),
      order(2000, { taskId: "t2" }),
      report(4000, { taskId: "t2" }),
      report(6000, { taskId: "t1" }),
    ];
    expect(turnDurations(conversation, agents)).toEqual({ a1: [5000, 2000] });
  });

  it("drops a turn whose close is not later than its open", () => {
    expect(
      turnDurations([order(2000, { taskId: "t1" }), report(2000, { taskId: "t1" })], agents),
    ).toEqual({});
    expect(
      turnDurations([order(3000, { taskId: "t1" }), report(2000, { taskId: "t1" })], agents),
    ).toEqual({});
  });

  it("does not emit an agent whose only turn never completed", () => {
    expect(turnDurations([order(1000, { taskId: "t1" })], agents)).toEqual({});
  });

  it("leaves the caller's entries untouched", () => {
    const conversation = [
      order(2000, { taskId: "t1" }),
      order(1000, { taskId: "t1" }),
      report(6000, { taskId: "t1" }),
    ];
    const snapshot = JSON.parse(JSON.stringify(conversation));
    turnDurations(conversation, agents);
    expect(conversation).toEqual(snapshot);
  });
});
