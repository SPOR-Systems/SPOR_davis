import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** GET one conversation, with its messages, so it can be reopened. */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const session = await prisma.chatSession.findFirst({
    where: { id: params.id, userId: user.userId, organizationId: user.organizationId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });

  if (!session) {
    return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json({
    session: { id: session.id, title: session.title },
    messages: session.messages.map((m: (typeof session.messages)[number]) => {
      let metadata: any = null;
      try {
        metadata = m.metadata ? JSON.parse(m.metadata) : null;
      } catch {
        metadata = null;
      }
      return {
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
        // Reopening a conversation must restore what was shown with it — the
        // chart, the citations, the trace. An answer stripped of its provenance
        // reads as a bare assertion, which is the opposite of the point.
        metadata,
      };
    }),
  });
}

/**
 * DELETE one conversation.
 *
 * Its messages go with it via the cascade on ChatSession. That includes the
 * metadata Phase 2's gap engine reads, so deleting a conversation also deletes
 * the evidence of what DAVIS could not answer in it — a real trade, and the
 * reason the UI says the conversation is gone for good rather than implying it
 * is archived somewhere.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const session = await prisma.chatSession.findFirst({
    where: { id: params.id, userId: user.userId, organizationId: user.organizationId },
    select: { id: true },
  });

  if (!session) {
    return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }

  await prisma.chatSession.delete({ where: { id: session.id } });
  return NextResponse.json({ ok: true });
}
