import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateSQLQuery, generateConversationalAnswer } from "@/lib/ai/gemini";
import { introspectSchema, executeQuery } from "@/lib/db/queryRunner";

export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const { user } = authResult;

    const body = await request.json();
    const { question, connectionId, sessionId } = body;

    if (!question || !connectionId) {
      return NextResponse.json({ error: "Question and connectionId are required" }, { status: 400 });
    }

    const conn = await prisma.databaseConnection.findFirst({
      where: { id: connectionId, organizationId: user.organizationId },
    });

    if (!conn) {
      return NextResponse.json({ error: "Database connection not found" }, { status: 404 });
    }

    const schema = await introspectSchema(connectionId, user.organizationId);

    // 1. Fetch Chat History (if session exists) for context
    let chatHistory = "";
    if (sessionId) {
      const messages = await prisma.chatMessage.findMany({
        where: { sessionId },
        orderBy: { createdAt: "asc" },
        take: 20, // Get last 20 messages for context
      });
      if (messages.length > 0) {
        chatHistory = messages.map(m => {
          let text = `${m.role}: ${m.content}`;
          if (m.role === 'ASSISTANT' && m.metadata) {
            try {
              const meta = JSON.parse(m.metadata as string);
              if (meta.sql) {
                text += `\n[Previously Executed SQL: ${meta.sql}]`;
              }
            } catch (e) {}
          }
          return text;
        }).join("\n\n");
      }
    }

    // 2. Generate SQL
    const sqlQuery = await generateSQLQuery({
      question,
      schema,
      dialect: conn.type,
      chatHistory,
    });

    // 3. Execute SQL
    const result = await executeQuery(connectionId, user.organizationId, sqlQuery);
    if (result.error) {
      throw new Error("Generated SQL failed to execute: " + result.error);
    }

    // 4. Generate Conversational Answer
    const answer = await generateConversationalAnswer({
      question,
      sql: sqlQuery,
      data: result.rows,
      chatHistory,
    });

    // 4. Save Session and Messages
    let actualSessionId = sessionId;
    if (!actualSessionId) {
      const session = await prisma.chatSession.create({
        data: {
          title: question.substring(0, 50) + "...",
          userId: user.userId,
          organizationId: user.organizationId,
        },
      });
      actualSessionId = session.id;
    }

    await prisma.chatMessage.create({
      data: {
        sessionId: actualSessionId,
        role: "USER",
        content: question,
      }
    });

    const assistantMsg = await prisma.chatMessage.create({
      data: {
        sessionId: actualSessionId,
        role: "ASSISTANT",
        content: answer,
        metadata: JSON.stringify({
          sql: sqlQuery,
          status: "success",
          rowCount: result.rows.length
        }),
      }
    });

    return NextResponse.json({
      sessionId: actualSessionId,
      messageId: assistantMsg.id,
      message: assistantMsg.content
    });

  } catch (error: any) {
    console.error("Generate Chat API Error:", error);
    return NextResponse.json({ error: error.message || "Failed to generate SQL" }, { status: 500 });
  }
}
