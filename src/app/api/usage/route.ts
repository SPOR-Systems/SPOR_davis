import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { billingPeriod, usageForPeriod, sweepRetention } from "@/lib/embed/usage";

export const dynamic = "force-dynamic";

/** One period's usage, per tenant, for the billing screen. */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  const url = new URL(request.url);
  const raw = url.searchParams.get("period");
  const period = raw && /^\d{4}-\d{2}$/.test(raw) ? raw : billingPeriod();

  return NextResponse.json(await usageForPeriod(user.organizationId, period));
}

/**
 * Run the retention sweep for this organization.
 *
 * Exposed so it can be driven by a scheduler the integrator controls, and so it
 * can be run on demand when someone asks for their data to be deleted.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  const { user } = authResult;

  if (user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Forbidden. Admin access required.", code: "FORBIDDEN" },
      { status: 403 }
    );
  }

  return NextResponse.json(await sweepRetention(user.organizationId));
}
