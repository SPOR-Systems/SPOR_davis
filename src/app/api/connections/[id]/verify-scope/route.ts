import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { verifyScope } from "@/lib/db/verifyScope";
import { ScopeError } from "@/lib/db/scope";

export const dynamic = "force-dynamic";

/**
 * Run the isolation check. This is the only thing that marks a connection
 * verified, and a scoped connection that is not verified refuses to answer.
 *
 * GET reports the last result; POST re-runs the check.
 */

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const conn = await prisma.databaseConnection.findFirst({
    where: { id: params.id, organizationId: user.organizationId },
    select: { scopeMode: true, verifiedAt: true, verifyNote: true },
  });
  if (!conn) {
    return NextResponse.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({
    mode: conn.scopeMode,
    verified: !!conn.verifiedAt,
    verifiedAt: conn.verifiedAt,
    note: conn.verifyNote,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  if (user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Forbidden. Admin access required.", code: "FORBIDDEN" },
      { status: 403 }
    );
  }

  try {
    const result = await verifyScope(params.id, user.organizationId);
    // A failed check is a successful request that returns bad news, so it is
    // 200 with verified:false — the caller reads the checks, not the status.
    return NextResponse.json(result);
  } catch (error: any) {
    if (error instanceof ScopeError) {
      return NextResponse.json(
        { verified: false, error: error.message, code: error.code },
        { status: 400 }
      );
    }
    console.error("verify-scope error:", error);
    return NextResponse.json(
      {
        verified: false,
        error: `The isolation check could not be completed: ${error?.message || error}`,
        code: "CHECK_FAILED",
      },
      { status: 500 }
    );
  }
}
