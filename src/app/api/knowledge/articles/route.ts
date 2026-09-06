import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getOrCreateKnowledgeBase } from "@/lib/knowledge/retrieve";
import { embedArticle } from "@/lib/knowledge/ingest";
import { scanForSensitiveData } from "@/lib/knowledge/pii";

export const dynamic = "force-dynamic";

const KINDS = ["REFERENCE", "PROCEDURE", "POLICY", "DEFINITION"];

/** A path is a tree position, so it must be shaped like one. */
function normalisePath(raw: string): string {
  return String(raw || "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("/");
}

/**
 * Steps are stored as an ordered array rather than prose.
 *
 * That is what makes "every step, in order" mechanically checkable instead of
 * something the model is merely asked to do. A procedure that loses
 * step 3 is not a shorter answer, it is a wrong instruction someone carries out.
 */
function parseSteps(raw: unknown): string | null {
  if (!raw) return null;
  const list = Array.isArray(raw)
    ? raw
    : String(raw)
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*])\s*/, ""));
  const steps = list.map((s) => String(s).trim()).filter(Boolean);
  return steps.length ? JSON.stringify(steps) : null;
}

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");

  const kb = await getOrCreateKnowledgeBase(user.organizationId);

  const articles = await prisma.article.findMany({
    where: {
      knowledgeBaseId: kb.id,
      ...(status ? { status } : {}),
    },
    orderBy: [{ path: "asc" }, { title: "asc" }],
    select: {
      id: true,
      path: true,
      title: true,
      kind: true,
      status: true,
      version: true,
      confidence: true,
      sourceKind: true,
      answersServed: true,
      reviewedAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({ articles, isAdmin: user.role === "ADMIN" });
}

export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const body = await request.json().catch(() => null);
  if (!body?.title || !body?.body) {
    return NextResponse.json(
      { error: "A title and body are required.", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  const status = body.status === "PUBLISHED" ? "PUBLISHED" : "DRAFT";
  if (status === "PUBLISHED" && user.role !== "ADMIN") {
    return NextResponse.json(
      {
        error:
          "Only an administrator can publish. Save it as a draft and ask an admin to review it.",
        code: "FORBIDDEN",
      },
      { status: 403 }
    );
  }

  const kind = KINDS.includes(body.kind) ? body.kind : "REFERENCE";
  const steps = kind === "PROCEDURE" ? parseSteps(body.steps) : null;

  if (kind === "PROCEDURE" && !steps) {
    return NextResponse.json(
      {
        error:
          "A procedure needs its steps listed. They are stored in order so DAVIS can never " +
          "deliver a partial version of it.",
        code: "STEPS_REQUIRED",
      },
      { status: 400 }
    );
  }

  const kb = await getOrCreateKnowledgeBase(user.organizationId);

  // Articles are readable by everyone in the organisation. A flag here costs a
  // glance; a miss costs a disclosure.
  const sensitive = scanForSensitiveData(`${body.title}\n${body.body}\n${steps || ""}`);

  const article = await prisma.article.create({
    data: {
      path: normalisePath(body.path) || "Uncategorised",
      title: String(body.title).slice(0, 300),
      kind,
      body: String(body.body),
      steps,
      status,
      confidence: 1,
      sourceKind: "MANUAL",
      reviewedAt: status === "PUBLISHED" ? new Date() : null,
      reviewedById: status === "PUBLISHED" ? user.userId : null,
      knowledgeBaseId: kb.id,
    },
  });

  await prisma.articleVersion.create({
    data: {
      articleId: article.id,
      version: 1,
      title: article.title,
      body: article.body,
      steps: article.steps,
      changedById: user.userId,
      changeNote: "Created",
    },
  });

  if (status === "PUBLISHED") void embedArticle(article.id);

  return NextResponse.json(
    { article, sensitiveWarning: sensitive.atRisk ? sensitive.findings : null },
    { status: 201 }
  );
}
