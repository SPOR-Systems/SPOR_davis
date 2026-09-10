import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/auth";
import { encryptText } from "@/lib/encryption";
import { accessibleConnectionIds } from "@/lib/embed/access";

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    
    if (authResult instanceof NextResponse) {
      return authResult; // Unauthorized
    }
    
    const { user } = authResult;

    // Database connections are an ADMIN surface. They carry hosts, ports and
    // usernames — the shape of the customer's infrastructure — and an ordinary
    // member has no reason to see any of it. What a member needs is their own
    // tenant, which /api/tenants/accessible gives them without any of this.
    if (user.role !== "ADMIN") {
      return NextResponse.json(
        { error: "Forbidden. Admin access required.", code: "FORBIDDEN" },
        { status: 403 }
      );
    }

    // Only the databases this person's tenant access reaches. A member granted
    // one clinic should not be offered every other clinic in the dropdown —
    // and the question path enforces the same rule, so this is presentation
    // rather than protection.
    const allowed = await accessibleConnectionIds(user.userId, user.organizationId);

    const connections = await prisma.databaseConnection.findMany({
      where: {
        organizationId: user.organizationId,
        ...(allowed === null ? {} : { id: { in: allowed } }),
      },
      select: {
        id: true,
        name: true,
        type: true,
        host: true,
        port: true,
        database: true,
        username: true,
        ssl: true,
        status: true,
        lastTestedAt: true,
        createdAt: true,
        // OMIT encryptedPassword for security
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ connections });
  } catch (error) {
    console.error("Get connections error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    
    if (authResult instanceof NextResponse) {
      return authResult; // Unauthorized
    }
    
    const { user } = authResult;

    // Only allow Admins to add database connections (based on your schema)
    if (user.role !== "ADMIN") {
      return NextResponse.json(
        { error: "Forbidden. Admin access required." },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { name, type, host, port, database, username, password, ssl } = body;

    // Validate required fields
    if (!name || !type || !host || !port || !database || !username || !password) {
      return NextResponse.json(
        { error: "All connection fields are required" },
        { status: 400 }
      );
    }

    // Encrypt the database password before saving to the DB
    const encryptedPassword = encryptText(password);

    const connection = await prisma.databaseConnection.create({
      data: {
        name,
        type,
        host,
        port: parseInt(port, 10),
        database,
        username,
        encryptedPassword,
        ssl: Boolean(ssl),
        organizationId: user.organizationId,
      },
      select: {
        id: true,
        name: true,
        type: true,
        host: true,
        port: true,
        database: true,
        username: true,
        ssl: true,
        status: true,
        createdAt: true,
      }
    });

    // Log the action
    await prisma.auditLog.create({
      data: {
        action: "connection.created",
        details: JSON.stringify({ connectionName: name, dbType: type }),
        userId: user.userId,
        organizationId: user.organizationId,
      },
    });

    return NextResponse.json({ connection }, { status: 201 });
  } catch (error) {
    console.error("Create connection error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
