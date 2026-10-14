/**
 * C2 peer→supervisor injection gate: screens the content of an already-valid
 * inbound FINAL_REPORT / RESPONSE frame with a classifier (Jev) and annotates the
 * frame. Annotation only — never dropped, never re-routed, exit code untouched
 * (DC-JEV-C2-GATE v1.1.0, §3-§9).
 *
 * A failed classifier call is flagged (unknown, not a pass), never raised — the
 * same posture as `verdict-advisory.ts`: an exception here would break inbound
 * delivery.
 */
import type { A2AEnvelope } from "../contracts/a2a-schema";

/** Closed subset of EVENT_TYPES the gate screens. Derived from the frame, never chosen. */
export type ScreenedEventType = "FINAL_REPORT" | "RESPONSE";

/** Which payload field was screened. §8 ordinals: "report" 0, "text" 1. */
export type ScreenedField = "report" | "text";

/** P(content is a prompt-injection attempt) in [0,1]; the classifier call seam. */
export type InjectionEstimate = (content: string) => Promise<number>;

export interface InjectionScreenInput {
  frameId: string;
  correlationId: string | null;
  sender: string;
  recipient: string;
  frameTimestamp: number;
  eventType: ScreenedEventType;
  screenedField: ScreenedField;
  content: string;
}

export interface InjectionScreenResult {
  frameId: string;
  correlationId: string | null;
  sender: string;
  screenedField: ScreenedField;
  score: number | null;
  threshold: number;
  flagged: boolean;
  error: string | null;
}

export interface InjectionGateDecision {
  gate: "jev-injection-gate";
  contractVersion: "1.1.0";
  frameId: string;
  correlationId: string | null;
  sender: string;
  eventType: ScreenedEventType;
  model: string;
  threshold: number;
  flagged: boolean;
  screens: InjectionScreenResult[];
}

export type InjectionGateEvent =
  | "injection_screened"
  | "injection_flagged"
  | "injection_classifier_error";

export type InjectionGateLogLevel = "info" | "warn";

export interface InjectionGateLogEntry {
  at: number;
  level: InjectionGateLogLevel;
  event: InjectionGateEvent;
  frameId: string;
  correlationId: string | null;
  sender: string;
  screenedField: ScreenedField;
  score: number | null;
  threshold: number;
  flagged: boolean;
  error: string | null;
}

export interface InjectionGateDeps {
  estimate: InjectionEstimate;
  now?: () => number;
}

/** §8: ScreenedField ordinal — "report" before "text". */
const FIELD_ORDINAL: Record<ScreenedField, number> = { report: 0, text: 1 };

/** §3: the field is derived from the event type, never chosen. */
function screenTargetFor(
  eventType: A2AEnvelope["type"],
): { eventType: ScreenedEventType; screenedField: ScreenedField } | null {
  switch (eventType) {
    case "FINAL_REPORT":
      return { eventType, screenedField: "report" };
    case "RESPONSE":
      return { eventType, screenedField: "text" };
    default:
      return null;
  }
}

export function shouldScreenEnvelope(env: A2AEnvelope): boolean {
  return screenTargetFor(env.type) !== null;
}

/**
 * §3: the one input record per screened frame. `classifyFrame` already validated
 * the payload, so a non-string field means the gate was called off-contract.
 */
export function createScreenInput(env: A2AEnvelope): InjectionScreenInput | null {
  const target = screenTargetFor(env.type);
  if (target === null) return null;
  const content = (env.payload as Record<string, unknown>)[target.screenedField];
  if (typeof content !== "string") return null;
  return {
    frameId: env.id,
    correlationId: env.correlationId ?? null,
    sender: env.sender,
    recipient: env.recipient,
    frameTimestamp: env.timestamp,
    eventType: target.eventType,
    screenedField: target.screenedField,
    content,
  };
}

/** §6: the single derivation rule, so an empty error can never be emitted. */
export function deriveClassifierError(err: unknown): string {
  if (err instanceof Error && err.message !== "") return err.message;
  const text = String(err);
  return text !== "" ? text : "classifier error";
}

/** §4/§6/§7: `flagged = score === null || score >= threshold` — equality flags, no epsilon. */
export function evaluateScreenResult(
  input: InjectionScreenInput,
  score: number | null,
  threshold: number,
  error: string | null,
): InjectionScreenResult {
  return {
    frameId: input.frameId,
    correlationId: input.correlationId,
    sender: input.sender,
    screenedField: input.screenedField,
    score,
    threshold,
    flagged: score === null || score >= threshold,
    error,
  };
}

/** §3: a promise unsettled after the bound is a classifier error; `0` disables the bound. */
function bound<T>(call: Promise<T>, ms: number): Promise<T> {
  if (ms === 0) return call;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`classify failed: timeout after ${ms} ms`)), ms);
  });
  return Promise.race([call, expiry]).finally(() => clearTimeout(timer));
}

function usableScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * §3-§9: screen one frame and return its annotation (decision + log entry), or
 * null when the event type is outside the closed subset — never `undefined`,
 * never an exception, never a dropped frame.
 */
export async function screenInboundFrame(
  env: A2AEnvelope,
  config: { model: string; injection_threshold: number; injection_timeout_ms: number },
  deps: InjectionGateDeps,
): Promise<{ decision: InjectionGateDecision; logEntry: InjectionGateLogEntry } | null> {
  const input = createScreenInput(env);
  if (input === null) return null;

  let screen: InjectionScreenResult;
  try {
    const result: unknown = await bound(deps.estimate(input.content), config.injection_timeout_ms);
    screen = usableScore(result)
      ? evaluateScreenResult(input, result, config.injection_threshold, null)
      : evaluateScreenResult(
          input,
          null,
          config.injection_threshold,
          deriveClassifierError(result),
        );
  } catch (err) {
    screen = evaluateScreenResult(
      input,
      null,
      config.injection_threshold,
      deriveClassifierError(err),
    );
  }

  // §8. shortcut: one screen per frame today, so this sort is a single-element
  // no-op; it becomes observable when a frame screens two fields.
  const screens = [screen].sort(
    (a, b) => FIELD_ORDINAL[a.screenedField] - FIELD_ORDINAL[b.screenedField],
  );
  const decision: InjectionGateDecision = {
    gate: "jev-injection-gate",
    contractVersion: "1.1.0",
    frameId: input.frameId,
    correlationId: input.correlationId,
    sender: input.sender,
    eventType: input.eventType,
    model: config.model,
    threshold: config.injection_threshold,
    flagged: screens.some((s) => s.flagged),
    screens,
  };
  return {
    decision,
    logEntry: {
      at: deps.now?.() ?? Date.now(),
      level: screen.flagged ? "warn" : "info",
      event:
        screen.error !== null
          ? "injection_classifier_error"
          : screen.flagged
            ? "injection_flagged"
            : "injection_screened",
      frameId: screen.frameId,
      correlationId: screen.correlationId,
      sender: screen.sender,
      screenedField: screen.screenedField,
      score: screen.score,
      threshold: screen.threshold,
      flagged: screen.flagged,
      error: screen.error,
    },
  };
}
