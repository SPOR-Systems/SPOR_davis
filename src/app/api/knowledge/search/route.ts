import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getOrCreateKnowledgeBase, retrieve } from "@/lib/knowledge/retrieve";

/**
 * POST /api/knowledge/search — the help centre's search box.
 *
 * The same retrieval the chat uses, so browsing and asking agree with each
 * other. A rep who searches the help centre and a rep who asks DAVIS must not
 * be shown different material for the same words.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const body = await request.json().catch(() => null);
  const query = String(body?.query || "").trim();

  if (!query) {
    return NextResponse.json({ results: [], topScore: 0 });
  }

  const kb = await getOrCreateKnowledgeBase(user.organizationId);
  const result = await retrieve({ question: query, knowledgeBaseId: kb.id, limit: 10 });

  return NextResponse.json({
    results: result.sources.map((s) => ({
      articleId: s.articleId,
      documentId: s.documentId,
      path: s.path,
      title: s.title,
      kind: s.kind,
      version: s.version,
      score: Number(s.score.toFixed(3)),
      // A short lead so a searcher can tell hits apart without opening each.
      excerpt: s.body.slice(0, 240).replace(/\s+/g, " ").trim(),
    })),
    topScore: result.topScore,
    unavailable: result.unavailable ?? null,
  });
}
