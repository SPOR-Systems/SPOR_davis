import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getOrCreateKnowledgeBase } from "@/lib/knowledge/retrieve";
import { scanForSensitiveData } from "@/lib/knowledge/pii";

/**
 * ============================================================================
 *  POST /api/knowledge/rescan
 * ============================================================================
 *  Re-runs the personal-data scan over every document's STORED text.
 *
 *  WHY THIS HAS TO EXIST
 *  ---------------------
 *  A scan result is a snapshot of what the rules caught on the day the file was
 *  uploaded. Two things invalidate it, and both are routine:
 *
 *    1. The rules improve. Every fix to a false positive or a missed pattern
 *       leaves every already-ingested document judged by the old version. A
 *       scanner you cannot re-run is a scanner that only ever protects
 *       documents uploaded after its last bug was fixed.
 *    2. A schema change wipes the column. Renaming a field is a table rebuild
 *       on SQLite, which drops the old column and defaults the new one — so
 *       every existing flag silently became "clean" with nothing in the UI to
 *       suggest anything had happened. That is exactly how it was discovered.
 *
 *  This is cheap on purpose: `extractedText` is already stored, so there is no
 *  re-upload, no re-parse, and no model call. Nothing is re-embedded and no
 *  chunk is touched — only the flag and its findings.
 * ============================================================================
 */

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  if (user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Only an administrator can re-scan the knowledge base.", code: "FORBIDDEN" },
      { status: 403 }
    );
  }

  const kb = await getOrCreateKnowledgeBase(user.organizationId);

  const documents = await prisma.document.findMany({
    where: { knowledgeBaseId: kb.id, extractedText: { not: null } },
    select: { id: true, name: true, extractedText: true, containsSensitiveData: true },
  });

  let flagged = 0;
  let changed = 0;
  const newlyFlagged: string[] = [];
  const cleared: string[] = [];

  for (const doc of documents) {
    const result = scanForSensitiveData(doc.extractedText || "");
    if (result.atRisk) flagged++;

    if (result.atRisk !== doc.containsSensitiveData) {
      changed++;
      if (result.atRisk) newlyFlagged.push(doc.name);
      else cleared.push(doc.name);
    }

    await prisma.document.update({
      where: { id: doc.id },
      data: {
        containsSensitiveData: result.atRisk,
        sensitiveFindings: result.findings.length
          ? JSON.stringify(result.findings)
          : null,
      },
    });
  }

  return NextResponse.json({
    scanned: documents.length,
    flagged,
    changed,
    // Named, not just counted: the point of re-scanning is to find out what the
    // previous rules got wrong, and a bare count answers none of that.
    newlyFlagged: newlyFlagged.slice(0, 20),
    cleared: cleared.slice(0, 20),
  });
}
