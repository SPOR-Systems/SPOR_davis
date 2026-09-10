import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** The people in this organization, for the access screen. Admin only. */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  if (user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Forbidden. Admin access required.", code: "FORBIDDEN" },
      { status: 403 }
    );
  }

  const users = await prisma.user.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      tenantAccessMode: true,
      _count: { select: { tenantGrants: true } },
    },
  });

  return NextResponse.json({
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      // The stored value and the EFFECTIVE value differ for an admin who has
      // never been given one, and showing only the stored "NONE" would tell an
      // administrator that their admins cannot reach anything, which is false.
      storedMode: u.tenantAccessMode,
      effectiveMode:
        u.tenantAccessMode && u.tenantAccessMode !== "NONE"
          ? u.tenantAccessMode
          : u.role === "ADMIN"
          ? "ALL"
          : "NONE",
      grantCount: u._count.tenantGrants,
    })),
  });
}
