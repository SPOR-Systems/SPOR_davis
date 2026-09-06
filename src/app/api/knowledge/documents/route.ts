import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getOrCreateKnowledgeBase } from "@/lib/knowledge/retrieve";
import { hashContent, ingestDocument } from "@/lib/knowledge/ingest";
import { detectKind } from "@/lib/knowledge/extract";

export const dynamic = "force-dynamic";

/** Above this, extraction and embedding stop being a background job and start being a problem. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const kb = await getOrCreateKnowledgeBase(user.organizationId);

  const documents = await prisma.document.findMany({
    where: { knowledgeBaseId: kb.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      type: true,
      size: true,
      status: true,
      pageCount: true,
      ingestError: true,
      containsSensitiveData: true,
      sensitiveFindings: true,
      createdAt: true,
      _count: { select: { chunks: true } },
    },
  });

  return NextResponse.json({
    documents: documents.map((d: (typeof documents)[number]) => ({
      ...d,
      chunkCount: d._count.chunks,
      sensitiveFindings: d.sensitiveFindings ? JSON.parse(d.sensitiveFindings) : [],
      _count: undefined,
    })),
  });
}

/**
 * POST /api/knowledge/documents — upload a file.
 *
 * The row is created and the response returns immediately; ingest runs after.
 * A 200-page handbook is tens of seconds of parsing plus several embedding
 * round-trips, and holding the request open for it gives the user a spinner
 * that looks indistinguishable from a hang. The document's `status` is the
 * progress channel instead.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected a multipart upload.", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  const file = form.get("file");
  if (!file || typeof file === "string") {
    return NextResponse.json(
      { error: "No file was included.", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `That file is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is ${
          MAX_UPLOAD_BYTES / 1024 / 1024
        }MB — split it, or upload the relevant section.`,
        code: "TOO_LARGE",
      },
      { status: 413 }
    );
  }

  const kind = detectKind(file.name, file.type);
  if (!kind) {
    return NextResponse.json(
      {
        error: `DAVIS cannot read "${file.name}". Supported: PDF, Word (.docx), Markdown, plain text, CSV and Excel.`,
        code: "UNSUPPORTED_TYPE",
      },
      { status: 415 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const kb = await getOrCreateKnowledgeBase(user.organizationId);
  const contentHash = hashContent(buffer);

  // Re-uploading the same bytes is almost always an accident — a second copy
  // means the same passage is retrieved twice under two names, which reads as
  // corroboration when it is duplication.
  const duplicate = await prisma.document.findFirst({
    where: { knowledgeBaseId: kb.id, contentHash },
    select: { id: true, name: true },
  });
  if (duplicate) {
    return NextResponse.json(
      {
        error: `This file is already in the knowledge base as "${duplicate.name}".`,
        code: "DUPLICATE",
        documentId: duplicate.id,
      },
      { status: 409 }
    );
  }

  const document = await prisma.document.create({
    data: {
      name: file.name,
      type: kind,
      size: file.size,
      status: "PENDING",
      contentHash,
      knowledgeBaseId: kb.id,
    },
  });

  // Fire and forget. Errors land on the row, which is where the UI reads them.
  void ingestDocument({
    documentId: document.id,
    buffer,
    filename: file.name,
    mimeType: file.type,
  }).catch((error) => {
    console.error("[davis] unhandled ingest failure:", error);
  });

  return NextResponse.json({ document }, { status: 202 });
}
