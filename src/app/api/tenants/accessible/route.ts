import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { listAccessibleTenants } from "@/lib/embed/access";

export const dynamic = "force-dynamic";

/**
 * The tenant picker.
 *
 * Separate from GET /api/tenants, which is administration and lists everything
 * in the organization. This one lists only what the signed-in person may query,
 * so a regional manager's picker cannot show a store they have no business
 * seeing — and, because an ungranted tenant is simply absent rather than
 * greyed out, the picker does not disclose the rest of the estate either.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const url = new URL(request.url);
  return NextResponse.json(
    await listAccessibleTenants(user.userId, user.organizationId, {
      search: url.searchParams.get("q") || undefined,
      take: Number(url.searchParams.get("take")) || undefined,
    })
  );
}
