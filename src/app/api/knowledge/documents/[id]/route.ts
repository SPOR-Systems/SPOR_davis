import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

async function scopedDocument(organizationId: string, id: string) {
  return prisma.document.findFirst({
    where: { id, knowledgeBase: { organizationId } },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const document = await scopedDocument(user.organizationId, params.id);
  if (!document) {
    return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json({
    document: {
      ...document,
      sensitiveFindings: document.sensitiveFindings
        ? JSON.parse(document.sensitiveFindings)
        : [],
    },
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  // Deleting source material changes what every future answer can cite, so it
  // is an ADMIN action for the same reason publishing is.
  if (user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Only an administrator can remove documents.", code: "FORBIDDEN" },
      { status: 403 }
    );
  }

  const document = await scopedDocument(user.organizationId, params.id);
  if (!document) {
    return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }

  await prisma.document.delete({ where: { id: document.id } });
  return NextResponse.json({ ok: true });
}
