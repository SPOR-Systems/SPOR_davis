import { GoogleGenerativeAI } from "@google/generative-ai";

const API_KEY = process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(API_KEY);

// We will use gemini-3.1-flash-lite for speed and SQL reasoning
const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });

export interface GenerateSQLParams {
  question: string;
  schema: string;
  dialect: string; // e.g. "PostgreSQL", "MySQL"
  chatHistory?: string;
}

async function withRetry<T>(operation: () => Promise<T>, maxRetries = 3): Promise<T> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await operation();
    } catch (error: any) {
      if ((error.message?.includes("503") || error.message?.includes("429") || error.message?.includes("500") || error.message?.includes("unavailable")) && attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`API overloaded. Retrying in ${delay}ms... (Attempt ${attempt + 1})`);
        await new Promise(res => setTimeout(res, delay));
        attempt++;
      } else {
        throw error;
      }
    }
  }
  throw new Error("Max retries reached");
}

export async function generateSQLQuery({ question, schema, dialect, chatHistory }: GenerateSQLParams): Promise<string> {
  const prompt = `
You are an expert Data Analyst and SQL Developer.
Your task is to translate a natural language question into a valid ${dialect} SQL query.

--- DATABASE SCHEMA ---
${schema}
-----------------------

--- INSTRUCTIONS ---
1. Analyze the user's question and the provided database schema.
2. If the user refers to previous context (e.g., "what about next week", "who were they"), refer to the CHAT HISTORY to resolve it.
3. Write a valid ${dialect} SQL query to answer the question.
4. ALWAYS use fully qualified table names or aliases if joining.
5. Ensure the query is read-only (SELECT statements only). Never generate INSERT, UPDATE, DELETE, or DROP.
6. You MUST return ONLY the raw SQL query. Do not wrap it in markdown code blocks (\`\`\`sql ... \`\`\`). Do not include any explanations or conversational text. Just the exact SQL string that can be executed directly.
7. Limit results to a reasonable amount if not specified (e.g., LIMIT 100).
8. When answering questions about the 'most common', 'top', or similar superlatives, DO NOT use LIMIT 1. Always return multiple rows so ties can be detected.
9. SQLite Date Arithmetic: SQLite stores dates as strings. To calculate age or date differences, strictly use standard SQLite date functions like \`CAST(strftime('%Y', 'now') - strftime('%Y', PT_DOB_DT) AS INTEGER)\`.
10. Avoid manual calculations if a pre-calculated column exists.
11. Be extremely careful when joining tables. Always follow the explicit foreign key relationships defined in the schema to avoid accidentally dropping rows.
12. ALL math and aggregations (SUM, COUNT, AVG, MIN, MAX) MUST be performed within the SQL query itself. DO NOT return raw rows expecting the downstream application to calculate it.
13. Pay extremely close attention to explicit filters and adjectives in the user's question (e.g., "paid", "completed", "active"). You MUST apply a WHERE clause to filter the rows. Do not assume that selecting a specific column fulfills a row filter condition.
14. If you are unsure of the exact categorical string value in the database for a filter, use a case-insensitive LIKE clause (e.g., \`WHERE CLM_STAT_CD LIKE '%PAID%'\` or \`WHERE ENC_STAT_CD LIKE '%COMPLETED%'\`).
15. DO NOT BE LAZY. You must be correct. Check your work if needed.
16. If the user's question is a follow-up asking for clarification, explanation, or confirmation (e.g., "what SQL did you use?", "are you sure?"), DO NOT write a new query from scratch. Instead, extract and return the EXACT SAME SQL query that was executed in the previous ASSISTANT response, which is provided in the Chat History as [Previously Executed SQL: ...].
--- CHAT HISTORY (For context only) ---
${chatHistory || "No previous history."}

--- USER QUESTION ---
${question}

--- SQL QUERY (RAW STRING ONLY) ---
`;

  try {
    const result = await withRetry(() => model.generateContent(prompt));
    const response = await result.response;
    let sqlText = response.text().trim();

    // Strip markdown formatting if the model disobeys rule 5
    if (sqlText.startsWith("```sql")) {
      sqlText = sqlText.replace(/^```sql/, "").replace(/```$/, "").trim();
    } else if (sqlText.startsWith("```")) {
      sqlText = sqlText.replace(/^```/, "").replace(/```$/, "").trim();
    }

    return sqlText;
  } catch (error: any) {
    console.error("Gemini SQL Generation Error:", error.message || error);
    throw new Error("Failed to generate SQL query.");
  }
}

export interface GenerateAnswerParams {
  question: string;
  sql: string;
  data: any[];
  chatHistory?: string;
}

export async function generateConversationalAnswer({ question, sql, data, chatHistory }: GenerateAnswerParams): Promise<string> {
  const prompt = `
You are an expert Data Analyst and helpful AI Assistant named DAVIS. Only mention your name when asked.
Your task is to answer the user's question directly and conversationally using the provided data.

--- INSTRUCTIONS ---
1. Review the User Question, the Chat History, the SQL Query Used, and the Data Results below.
2. Synthesize the data into a clear, concise, and personable answer.
3. Do not mention the SQL query or database schema unless the user specifically asks how you calculated the answer, what the query was, or how you arrived at the result.
4. Just deliver the insights directly to the user as if you are their personal assistant.
5. If the data is empty or indicates no results, say so politely.
6. CRITICAL: Be strictly factual and precise. Do not hallucinate or invent facts.
7. CRITICAL: Answer ONLY using the provided Data Results. If the data does not contain the answer, explicitly state that you cannot answer based on the current data.
8. CRITICAL: You are only provided with a maximum of 50 rows of data. If the user asks for a total, sum, or average, and the Data Results contain raw unaggregated rows, DO NOT attempt to calculate the math yourself. Explicitly state that you cannot calculate the total because you only have a sample of the data.

--- CHAT HISTORY (For context only) ---
${chatHistory || "No previous history."}

--- USER QUESTION ---
${question}

--- SQL QUERY USED ---
${sql}

--- DATA RESULTS ---
${JSON.stringify(data.slice(0, 50), null, 2)}

--- YOUR ANSWER ---
`;

  try {
    const result = await withRetry(() => model.generateContent(prompt));
    const response = await result.response;
    return response.text().trim();
  } catch (error: any) {
    console.error("Gemini Answer Generation Error:", error.message || error);
    throw new Error("Failed to generate conversational answer.");
  }
}
