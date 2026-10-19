import { TracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { trace, context, propagation, SpanStatusCode, type Context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { randomHex, formatTraceparent, parseTraceparent, type SpanRecord, type SpanName, type Kind } from "./core";

export interface SpanHandle {
  id: string;                 // span_id
  traceId?: string;           // trace_id this span belongs to (needed for cross-process)
  remote?: boolean;           // extract() handle: no local span
  otelSpan?: unknown;
  otelContext?: unknown;
}

export interface StartOpts {
  parent: SpanHandle | null;
  kind: Kind;
  scopeId: string | null;
  agentId: string | null;
  operationId?: string;
  attrs?: Record<string, unknown>;
}

export interface Tracing {
  label: string;
  startSpan(name: SpanName, opts: StartOpts): SpanHandle;
  endSpan(h: SpanHandle, status?: "ok" | "error" | "aborted"): void;
  inject(env: Record<string, unknown>, h: SpanHandle): void;
  extract(env: Record<string, unknown>): SpanHandle | null;
  collect(): SpanRecord[];
}

// ---------------------------------------------------------------------------
// Fields-only: manual span store + manual W3C traceparent inject/extract.
// ---------------------------------------------------------------------------
export class FieldsOnly implements Tracing {
  label = "fields-only";
  private readonly traceId = randomHex(16);
  private readonly spans: SpanRecord[] = [];
  private readonly now = () => Date.now();

  startSpan(name: SpanName, opts: StartOpts): SpanHandle {
    const spanId = randomHex(8);
    const traceId = opts.parent?.traceId ?? this.traceId;
    this.spans.push({
      trace_id: traceId,
      span_id: spanId,
      parent_span_id: opts.parent ? opts.parent.id : null,
      name,
      kind: opts.kind,
      scope_id: opts.scopeId,
      agent_id: opts.agentId,
      start_time: this.now(),
      end_time: null,
      status: "ok",
      links: [],
      operation_id: opts.operationId,
      attributes: opts.attrs,
    });
    return { id: spanId, traceId };
  }

  endSpan(h: SpanHandle, status: "ok" | "error" | "aborted" = "ok"): void {
    const s = this.spans.find((s) => s.span_id === h.id);
    if (s) { s.end_time = this.now(); s.status = status; }
  }

  inject(env: Record<string, unknown>, h: SpanHandle): void {
    env.traceparent = formatTraceparent(h.traceId ?? this.traceId, h.id);
  }

  extract(env: Record<string, unknown>): SpanHandle | null {
    const tp = env.traceparent;
    if (typeof tp !== "string") return null;
    const parsed = parseTraceparent(tp);
    if (!parsed) return null;
    return { id: parsed.spanId, traceId: parsed.traceId, remote: true };
  }

  collect(): SpanRecord[] {
    return this.spans;
  }
}

// ---------------------------------------------------------------------------
// OTel SDK: BasicTracerProvider + AsyncLocalStorageContextManager + W3C propagator.
// ---------------------------------------------------------------------------
export class OtelSdk implements Tracing {
  label = "otel-sdk";
  private readonly exporter = new InMemorySpanExporter();
  private readonly tracer;

  constructor() {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager());
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter: this.exporter })],
    });
    trace.setGlobalTracerProvider(provider);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    this.tracer = trace.getTracer("s4-proto");
  }

  startSpan(name: SpanName, opts: StartOpts): SpanHandle {
    const parentCtx = opts.parent?.otelContext
      ? (opts.parent.otelContext as Context)
      : context.active();
    const attrs: Record<string, string> = { "oracle.kind": opts.kind };
    if (opts.scopeId !== null) attrs["oracle.scope_id"] = opts.scopeId;
    if (opts.agentId !== null) attrs["oracle.agent_id"] = opts.agentId;
    if (opts.operationId !== undefined) attrs["oracle.operation_id"] = opts.operationId;
    if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) attrs[`oracle.${k}`] = String(v);
    const span = this.tracer.startSpan(name, { attributes: attrs }, parentCtx);
    return { id: span.spanContext().spanId, otelSpan: span, otelContext: trace.setSpan(context.active(), span) };
  }

  endSpan(h: SpanHandle, status: "ok" | "error" | "aborted" = "ok"): void {
    const span = h.otelSpan as { setStatus: (s: unknown) => void; end: () => void } | undefined;
    if (status === "error") span?.setStatus({ code: SpanStatusCode.ERROR });
    span?.end();
  }

  inject(env: Record<string, unknown>, h: SpanHandle): void {
    const ctx = trace.setSpan(context.active(), h.otelSpan as never);
    propagation.inject(ctx, env, {
      set: (carrier, k, v) => { (carrier as Record<string, unknown>)[k] = v; },
    });
  }

  extract(env: Record<string, unknown>): SpanHandle | null {
    const ctx = propagation.extract(context.active(), env);
    const remote = trace.getSpan(ctx)?.spanContext().spanId ?? "";
    return { id: remote, otelContext: ctx, remote: true };
  }

  collect(): SpanRecord[] {
    const finished = this.exporter.getFinishedSpans() as Array<{
      spanContext: () => { traceId: string; spanId: string };
      parentSpanId?: string;
      name: string;
      attributes?: Record<string, unknown>;
      startTime: [number, number];
      endTime: [number, number];
      status: { code: number };
      links: Array<{ context: { spanId: string }; attributes?: Record<string, unknown> }>;
    }>;
    const hrToMs = (t: [number, number]) => t[0] * 1000 + t[1] / 1e6;
    return finished.map((span) => {
      const attrs = span.attributes ?? {};
      return {
        trace_id: span.spanContext().traceId,
        span_id: span.spanContext().spanId,
        parent_span_id: span.parentSpanContext?.spanId ?? null,
        name: span.name as SpanName,
        kind: attrs["oracle.kind"] as Kind,
        scope_id: (attrs["oracle.scope_id"] as string) ?? null,
        agent_id: (attrs["oracle.agent_id"] as string) ?? null,
        start_time: hrToMs(span.startTime),
        end_time: span.endTime ? hrToMs(span.endTime) : null,
        status: span.status.code === SpanStatusCode.ERROR ? "error" : "ok",
        links: span.links.map((l) => ({ span_id: l.context.spanId, reason: (l.attributes?.reason as string) ?? "" })),
        operation_id: attrs["oracle.operation_id"] as string | undefined,
        attributes: { tool: attrs["oracle.tool"], command: attrs["oracle.command"] },
      };
    });
  }
}
