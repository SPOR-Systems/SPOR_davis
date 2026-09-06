import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { embedArticle } from "@/lib/knowledge/ingest";
import { scanForSensitiveData } from "@/lib/knowledge/pii";

export const dynamic = "force-dynamic";

const KINDS = ["REFERENCE", "PROCEDURE", "POLICY", "DEFINITION"];

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

async function scopedArticle(organizationId: string, id: string) {
  return prisma.article.findFirst({
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

  const article = await scopedArticle(user.organizationId, params.id);
  if (!article) {
    return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }

  const versions = await prisma.articleVersion.findMany({
    where: { articleId: article.id },
    orderBy: { version: "desc" },
    select: { version: true, changeNote: true, createdAt: true, changedById: true },
  });

  return NextResponse.json({
    article: { ...article, steps: article.steps ? JSON.parse(article.steps) : null },
    versions,
    isAdmin: user.role === "ADMIN",
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const existing = await scopedArticle(user.organizationId, params.id);
  if (!existing) {
    return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid body", code: "BAD_REQUEST" }, { status: 400 });
  }

  const nextStatus = body.status ?? existing.status;
  if (nextStatus === "PUBLISHED" && user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Only an administrator can publish.", code: "FORBIDDEN" },
      { status: 403 }
    );
  }

  const kind = KINDS.includes(body.kind) ? body.kind : existing.kind;
  const steps =
    kind === "PROCEDURE"
      ? body.steps !== undefined
        ? parseSteps(body.steps)
        : existing.steps
      : null;

  if (kind === "PROCEDURE" && !steps) {
    return NextResponse.json(
      { error: "A procedure needs its steps listed, in order.", code: "STEPS_REQUIRED" },
      { status: 400 }
    );
  }

  const title = body.title !== undefined ? String(body.title).slice(0, 300) : existing.title;
  const articleBody = body.body !== undefined ? String(body.body) : existing.body;

  const contentChanged =
    title !== existing.title || articleBody !== existing.body || steps !== existing.steps;

  // Version on content change only. Bumping the version because someone
  // toggled a status would make the version number meaningless as a way to
  // ask "is this the same text I read yesterday" — which is the whole point
  // of putting it in the citation.
  const version = contentChanged ? existing.version + 1 : existing.version;

  const article = await prisma.article.update({
    where: { id: existing.id },
    data: {
      title,
      body: articleBody,
      kind,
      steps,
      version,
      path: body.path !== undefined ? String(body.path) : existing.path,
      status: nextStatus,
      reviewedAt: nextStatus === "PUBLISHED" ? new Date() : existing.reviewedAt,
      reviewedById: nextStatus === "PUBLISHED" ? user.userId : existing.reviewedById,
      // A human editing a machine-generated draft is what makes it trustworthy.
      confidence: contentChanged ? 1 : existing.confidence,
    },
  });

  if (contentChanged) {
    await prisma.articleVersion.create({
      data: {
        articleId: article.id,
        version,
        title: article.title,
        body: article.body,
        steps: article.steps,
        changedById: user.userId,
        changeNote: body.changeNote ? String(body.changeNote).slice(0, 300) : null,
      },
    });
  }

  // Re-embed on any content change, or the index answers from the old text.
  if (article.status === "PUBLISHED" && contentChanged) void embedArticle(article.id);

  const sensitive = scanForSensitiveData(
    `${article.title}\n${article.body}\n${article.steps || ""}`
  );

  return NextResponse.json({
    article,
    sensitiveWarning: sensitive.atRisk ? sensitive.findings : null,
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  if (user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Only an administrator can delete articles.", code: "FORBIDDEN" },
      { status: 403 }
    );
  }

  const article = await scopedArticle(user.organizationId, params.id);
  if (!article) {
    return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }

  await prisma.article.delete({ where: { id: article.id } });
  return NextResponse.json({ ok: true });
}
