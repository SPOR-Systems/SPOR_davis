import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getOrCreateKnowledgeBase } from "@/lib/knowledge/retrieve";

/**
 * GET /api/knowledge — the organisation's knowledge base and its counts.
 *
 * One knowledge base per organisation (a settled decision), created on first
 * access rather than at signup, so an org that never opens this page never
 * grows an empty row.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const kb = await getOrCreateKnowledgeBase(user.organizationId);

  const [documents, articles, published, sensitiveFlagged, failed] = await Promise.all([
    prisma.document.count({ where: { knowledgeBaseId: kb.id } }),
    prisma.article.count({ where: { knowledgeBaseId: kb.id } }),
    prisma.article.count({ where: { knowledgeBaseId: kb.id, status: "PUBLISHED" } }),
    prisma.document.count({ where: { knowledgeBaseId: kb.id, containsSensitiveData: true } }),
    prisma.document.count({ where: { knowledgeBaseId: kb.id, status: "FAILED" } }),
  ]);

  return NextResponse.json({
    knowledgeBase: { id: kb.id, name: kb.name, description: kb.description },
    counts: { documents, articles, published, sensitiveFlagged, failed },
    isAdmin: user.role === "ADMIN",
  });
}
