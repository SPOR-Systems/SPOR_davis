import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/connections/[id]
 *
 * The connection row holds the encrypted credentials and the cached schema
 * profile; removing it removes DAVIS's access, not the database itself. Chat
 * messages reference the connection with onDelete: SetNull, so past answers
 * survive the deletion and simply lose the link back to the source — which is
 * the right trade. Losing a year of answers because someone rotated a
 * connection would be far worse than an answer that can no longer say which
 * database it came from.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  if (user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Only an administrator can remove a database connection.", code: "FORBIDDEN" },
      { status: 403 }
    );
  }

  const connection = await prisma.databaseConnection.findFirst({
    where: { id: params.id, organizationId: user.organizationId },
    select: { id: true, name: true },
  });

  if (!connection) {
    return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }

  const affected = await prisma.chatMessage.count({
    where: { connectionId: connection.id },
  });

  await prisma.databaseConnection.delete({ where: { id: connection.id } });

  return NextResponse.json({
    ok: true,
    // Reported rather than silently done, so the person deleting knows what
    // just lost its provenance link.
    messagesUnlinked: affected,
  });
}
