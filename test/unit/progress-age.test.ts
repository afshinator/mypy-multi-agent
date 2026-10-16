/**
 * Unit tests for the pure progress-age label and throttle-bucket helpers.
 */
import { describe, expect, it } from "vitest";
import {
  formatProgressAge,
  PROGRESS_BUCKET_MS,
  progressBucket,
  turnDisplayState,
} from "../../src/peer/progress-age";

describe("formatProgressAge", () => {
  it("renders sub-minute ages as whole seconds", () => {
    expect(formatProgressAge(0)).toBe("0s");
    expect(formatProgressAge(12_000)).toBe("12s");
    expect(formatProgressAge(59_999)).toBe("59s");
  });

  it("renders minute-scale ages", () => {
    expect(formatProgressAge(60_000)).toBe("1m");
    expect(formatProgressAge(180_000)).toBe("3m");
    expect(formatProgressAge(3_599_000)).toBe("59m");
  });

  it("renders hour-scale ages", () => {
    expect(formatProgressAge(3_600_000)).toBe("1h00m");
    expect(formatProgressAge(3_900_000)).toBe("1h05m");
  });

  it("clamps a negative age to zero", () => {
    expect(formatProgressAge(-5)).toBe("0s");
  });
});

describe("turnDisplayState", () => {
  it("stays WORKING just below the stall threshold", () => {
    expect(turnDisplayState(299_999, 300_000)).toBe("WORKING");
  });

  it("becomes STALLED at and above the stall threshold", () => {
    expect(turnDisplayState(300_000, 300_000)).toBe("STALLED");
    expect(turnDisplayState(300_001, 300_000)).toBe("STALLED");
  });

  it("stallTimeoutMs 0 disables the label", () => {
    expect(turnDisplayState(0, 0)).toBe("WORKING");
    expect(turnDisplayState(999_999, 0)).toBe("WORKING");
  });
});

describe("progressBucket", () => {
  it("advances one step per bucket window", () => {
    expect(progressBucket(0)).toBe(0);
    expect(progressBucket(PROGRESS_BUCKET_MS)).toBe(1);
    expect(progressBucket(PROGRESS_BUCKET_MS * 2)).toBe(2);
  });

  it("does not change within a bucket window", () => {
    expect(progressBucket(0)).toBe(progressBucket(14_000));
    expect(progressBucket(14_000)).toBe(progressBucket(14_999));
    expect(progressBucket(15_000)).toBe(progressBucket(29_999));
  });
});
