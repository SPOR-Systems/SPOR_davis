import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPassword, createToken, setAuthCookie } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400 }
      );
    }

    /* ---------------------------------------------------------------------- */
    /* ONE EMAIL CAN BELONG TO SEVERAL ORGANIZATIONS                          */
    /* ---------------------------------------------------------------------- */
    // The schema makes email unique PER ORGANIZATION — the same person can be
    // in two of them, which is normal and intended. So `findFirst` on email
    // alone was picking whichever row the database happened to yield first,
    // and quietly signing people into an organization they did not ask for.
    //
    // That does not read as a bug. It reads as "my data is gone": you land in
    // a real, working account that simply has none of your documents,
    // connections or tenants in it.
    const candidates = await prisma.user.findMany({
      where: {
        email: email.toLowerCase(),
        // Set on the second request, once the person has picked.
        ...(typeof body.organizationSlug === "string" && body.organizationSlug
          ? { organization: { slug: body.organizationSlug } }
          : {}),
      },
      include: { organization: true },
    });

    // The password is checked against every candidate rather than against the
    // first one found. Two accounts with the same email may have DIFFERENT
    // passwords, and matching only the first would lock the other out entirely.
    const matches = [];
    for (const candidate of candidates) {
      if (await verifyPassword(password, candidate.passwordHash)) {
        matches.push(candidate);
      }
    }

    if (matches.length === 0) {
      // Generic, and identical whether the email is unknown or the password is
      // wrong, so this cannot be used to find out who has an account.
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

    // Same email AND same password in more than one organization. Guessing here
    // is what caused the problem in the first place, so ask instead. Only
    // organizations whose password already matched are listed, so this reveals
    // nothing to someone who does not hold the credentials.
    if (matches.length > 1) {
      return NextResponse.json(
        {
          chooseOrganization: true,
          organizations: matches.map((m) => ({
            name: m.organization.name,
            slug: m.organization.slug,
          })),
          message: "This email is used by more than one organization. Choose which one to sign in to.",
        },
        // 409 rather than a 3xx: this is not a redirect, and nothing between
        // the browser and here should be tempted to treat it as one.
        { status: 409 }
      );
    }

    const user = matches[0];

    // Create JWT
    const token = await createToken({
      userId: user.id,
      email: user.email,
      organizationId: user.organizationId,
      role: user.role,
    });

    const response = NextResponse.json(
      {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
        organization: {
          id: user.organization.id,
          name: user.organization.name,
          slug: user.organization.slug,
        },
        token,
      },
      { status: 200 }
    );

    return setAuthCookie(response, token);
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
