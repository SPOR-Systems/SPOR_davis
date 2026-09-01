import { NextRequest, NextResponse } from "next/server";
import { verifyToken, JWTPayload } from "./jwt";

export interface AuthenticatedRequest extends NextRequest {
  user?: JWTPayload;
}

/**
 * Extract and verify the JWT from the Authorization header or cookie.
 * Returns the decoded payload or null if unauthenticated.
 */
export async function getAuthUser(
  request: NextRequest
): Promise<JWTPayload | null> {
  // Check Authorization header first
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    return verifyToken(token);
  }

  // Fall back to cookie
  const tokenCookie = request.cookies.get("davis-token");
  if (tokenCookie?.value) {
    return verifyToken(tokenCookie.value);
  }

  return null;
}

/**
 * Middleware wrapper that enforces authentication.
 * Returns 401 if not authenticated.
 */
export async function requireAuth(
  request: NextRequest
): Promise<{ user: JWTPayload } | NextResponse> {
  const user = await getAuthUser(request);

  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized. Please log in." },
      { status: 401 }
    );
  }

  return { user };
}

/**
 * Middleware wrapper that enforces admin role.
 * Returns 403 if not an admin.
 */
export async function requireAdmin(
  request: NextRequest
): Promise<{ user: JWTPayload } | NextResponse> {
  const result = await requireAuth(request);

  if (result instanceof NextResponse) {
    return result;
  }

  if (result.user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Forbidden. Admin access required." },
      { status: 403 }
    );
  }

  return result;
}

/**
 * Helper to create a response with the auth cookie set.
 */
export function setAuthCookie(
  response: NextResponse,
  token: string
): NextResponse {
  response.cookies.set("davis-token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: "/",
  });
  return response;
}

/**
 * Helper to clear the auth cookie.
 */
export function clearAuthCookie(response: NextResponse): NextResponse {
  response.cookies.set("davis-token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  return response;
}
