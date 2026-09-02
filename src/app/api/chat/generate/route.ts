import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import {
  runChatPipeline,
  type StreamEvent,
} from "@/lib/chat/pipeline";

/**
 * POST /api/chat/generate
 *
 * Two delivery modes over one pipeline:
 *
 *   default        — await the whole thing, return a single JSON body. This is
 *                    the original contract and stays unchanged.
 *   stream: true   — newline-delimited JSON, one event per line, so the client
 *                    can show what DAVIS is actually doing during the ~20-30s
 *                    a high-thinking plan takes.
 *
 * NDJSON rather than SSE framing: the client already parses JSON, and there is
 * no need for event names or reconnection semantics here.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  /* ------------------------------------------------------------------ */
  /* Buffered mode (unchanged contract)                                 */
  /* ------------------------------------------------------------------ */
  if (!body?.stream) {
    const outcome = await runChatPipeline({ user, body });
    return NextResponse.json(outcome.body, {
      status: outcome.status,
      headers: outcome.headers,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Streaming mode                                                     */
  /* ------------------------------------------------------------------ */
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (event: StreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          // The client hung up mid-answer; stop trying to write.
          closed = true;
        }
      };

      try {
        const outcome = await runChatPipeline({ user, body, emit: write });
        // Once the response has started streaming the HTTP status is already
        // sent, so the real status travels inside the final event instead.
        write(
          outcome.status >= 400
            ? { t: "error", status: outcome.status, body: outcome.body }
            : { t: "done", status: outcome.status, body: outcome.body }
        );
      } catch (error: any) {
        // runChatPipeline handles its own errors; this is the last resort.
        console.error("[davis] streaming pipeline crashed:", error);
        write({
          t: "error",
          status: 500,
          body: {
            error: error?.message || "Failed to answer the question",
            code: "INTERNAL_ERROR",
          },
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      // no-transform and X-Accel-Buffering stop dev proxies and nginx from
      // buffering the whole body, which would defeat the point.
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
