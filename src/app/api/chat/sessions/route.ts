import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/chat/sessions — the signed-in user's conversations.
 *
 * Sessions have been accumulating since the first release with no way to see or
 * remove them. A conversation is not disposable: it carries the SQL that was
 * run, the assumptions that were made, and the figures someone may have acted
 * on. Listing them is the precondition for deleting them — you cannot
 * meaningfully remove what you cannot see.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const sessions = await prisma.chatSession.findMany({
    // Scoped to the individual, not the organisation: a conversation is the
    // person's own working notes, not shared org content.
    where: { userId: user.userId, organizationId: user.organizationId },
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });

  return NextResponse.json({
    sessions: sessions.map((s: (typeof sessions)[number]) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s._count.messages,
    })),
  });
}
