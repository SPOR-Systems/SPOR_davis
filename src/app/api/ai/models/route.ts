import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { aiDiagnostics } from "@/lib/ai/gemini";

/**
 * GET /api/ai/models
 *
 * Answers the question "why did that 404?" without a redeploy: what chains are
 * configured, which models this API key can actually reach, and which models
 * DAVIS has disqualified or is cooling down after an overload.
 *
 * Auth-gated because it reveals server configuration.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;

  try {
    const diagnostics = await aiDiagnostics();

    // Flag configured models that the key cannot see, which is the single most
    // common cause of a chain failing.
    const available = new Set(diagnostics.availableModels);
    const unreachable = [
      ...new Set([...diagnostics.chains.sql, ...diagnostics.chains.prose]),
    ].filter((m) => available.size > 0 && !available.has(m));

    return NextResponse.json({
      ...diagnostics,
      unreachableConfiguredModels: unreachable,
      ok: unreachable.length === 0,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Failed to read AI diagnostics" },
      { status: 500 }
    );
  }
}
