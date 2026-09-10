import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword, createToken, setAuthCookie } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { organizationName, name, email, password } = body;
    // "create" makes a new organization with this person as its admin.
    // "join" asks an existing organization to let them in, and creates nothing
    // until an admin approves — see the join branch below.
    const mode = body.mode === "join" ? "join" : "create";

    // Validate required fields
    if (!organizationName || !name || !email || !password) {
      return NextResponse.json(
        { error: "All fields are required: organizationName, name, email, password" },
        { status: 400 }
      );
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { error: "Invalid email format" },
        { status: 400 }
      );
    }

    // Validate password strength
    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }

    // Generate slug from organization name
    const slug = organizationName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    const existingOrg = await prisma.organization.findUnique({
      where: { slug },
    });

    // Hash the password once, for either path.
    const passwordHash = await hashPassword(password);

    /* ---------------------------------------------------------------------- */
    /* JOINING an existing organization                                       */
    /* ---------------------------------------------------------------------- */
    // Nothing is created but a request. The person is NOT a user, is not in the
    // members list, and cannot sign in — an admin decides whether they belong
    // and what they may see. Anything else would mean a stranger who guessed an
    // organization name is inside it.
    if (mode === "join") {
      if (!existingOrg) {
        return NextResponse.json(
          {
            error:
              "We couldn't find an organization with that name. Check the exact " +
              "name with whoever runs it.",
            code: "NO_ORGANIZATION",
          },
          { status: 404 }
        );
      }

      const alreadyMember = await prisma.user.findFirst({
        where: { organizationId: existingOrg.id, email: email.toLowerCase() },
        select: { id: true },
      });
      if (alreadyMember) {
        return NextResponse.json(
          {
            error: "That email already has an account here. Try signing in instead.",
            code: "ALREADY_MEMBER",
          },
          { status: 409 }
        );
      }

      // Asking twice replaces the earlier request rather than erroring: someone
      // who mistyped their name and tried again should not be stuck.
      await prisma.pendingRegistration.upsert({
        where: {
          organizationId_email: {
            organizationId: existingOrg.id,
            email: email.toLowerCase(),
          },
        },
        update: { name, passwordHash, status: "PENDING", note: null, reviewedAt: null },
        create: {
          organizationId: existingOrg.id,
          email: email.toLowerCase(),
          name,
          passwordHash,
        },
      });

      // No audit row: AuditLog requires a user, and a pending registrant is
      // deliberately not one. The PendingRegistration row is the record.

      return NextResponse.json(
        {
          pending: true,
          organization: { name: existingOrg.name },
          message:
            `Your request to join ${existingOrg.name} has been sent. You'll be able ` +
            `to sign in once someone there approves it.`,
        },
        { status: 202 }
      );
    }

    /* ---------------------------------------------------------------------- */
    /* CREATING a new organization                                            */
    /* ---------------------------------------------------------------------- */
    if (existingOrg) {
      return NextResponse.json(
        {
          error:
            "An organization with a similar name already exists. If it's yours, " +
            "choose \"Join an existing organization\" instead.",
          code: "ORG_EXISTS",
        },
        { status: 409 }
      );
    }

    // Create organization and admin user in a transaction
    const result = await prisma.$transaction(async (tx: any) => {
      const organization = await tx.organization.create({
        data: {
          name: organizationName,
          slug,
        },
      });

      const user = await tx.user.create({
        data: {
          email: email.toLowerCase(),
          name,
          passwordHash,
          role: "ADMIN",
          organizationId: organization.id,
        },
      });

      // Create audit log
      await tx.auditLog.create({
        data: {
          action: "organization.created",
          details: JSON.stringify({ organizationName, adminEmail: email }),
          userId: user.id,
          organizationId: organization.id,
        },
      });

      return { organization, user };
    });

    // Create JWT
    const token = await createToken({
      userId: result.user.id,
      email: result.user.email,
      organizationId: result.organization.id,
      role: result.user.role,
    });

    // Return response with cookie
    const response = NextResponse.json(
      {
        user: {
          id: result.user.id,
          name: result.user.name,
          email: result.user.email,
          role: result.user.role,
        },
        organization: {
          id: result.organization.id,
          name: result.organization.name,
          slug: result.organization.slug,
        },
        token,
      },
      { status: 201 }
    );

    return setAuthCookie(response, token);
  } catch (error: unknown) {
    console.error("Registration error:", error);

    // Handle unique constraint violation
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      return NextResponse.json(
        { error: "A user with this email already exists in this organization" },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
