// supabase/functions/faq-ask/index.ts
//
// FAQ Bot edge function for Suncore.
// Flow: embed question -> pgvector similarity search -> Gemini answer grounded in matched chunks
//
// Deploy with: supabase functions deploy faq-ask

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;

const EMBEDDING_MODEL = "gemini-embedding-001";
const OUTPUT_DIMENSIONALITY = 768;
const CHAT_MODEL = "gemini-3.5-flash"; // matches the model used in Suncore's Make.com lead-analysis pipeline

const GREETING_PATTERN = /^\s*(hi|hello|hey|good\s?(morning|afternoon|evening)|yo|greetings|sup)[\s!.,]*$/i;

const GREETING_REPLY =
  "Hi there! I'm the Suncore FAQ assistant. Ask me anything about financing, system sizing, warranty, installation, or net metering - what would you like to know?";

const FALLBACK_TEXT = "I don't have that information - please contact our team directly for details.";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // tighten to your domain in production
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type ChatTurn = { role: "user" | "bot"; text: string };

/**
 * Turns a context-dependent follow-up ("what about a 2-story house?") into a
 * standalone question using recent history, so embedding/retrieval works
 * correctly even when the latest message alone is ambiguous.
 * Returns the original question unchanged if there's no history, or if the
 * rewrite call fails for any reason.
 */
async function rewriteStandaloneQuestion(question: string, history: ChatTurn[]): Promise<string> {
  if (!history || history.length === 0) return question;

  const historyText = history
    .map((turn) => `${turn.role === "user" ? "Visitor" : "Assistant"}: ${turn.text}`)
    .join("\n");

  const prompt = `Conversation so far:
${historyText}

Latest visitor message: "${question}"

Rewrite the latest visitor message as a standalone question that makes full sense without
the conversation history, resolving any pronouns or implied context (e.g. "what about a
2-story house?" after a sizing question becomes "How does system sizing differ for a 2-story
house?"). If the latest message is already standalone, return it unchanged.

Respond with ONLY the rewritten question, no other text.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CHAT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
    });

    if (!res.ok) return question;

    const data = await res.json();
    const rewritten = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return rewritten || question;
  } catch (err) {
    console.error("Standalone question rewrite failed:", err);
    return question;
  }
}

async function embedQuestion(text: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: OUTPUT_DIMENSIONALITY,
    }),
  });

  if (!res.ok) {
    throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.embedding.values;
}

async function askGemini(
  question: string,
  contextChunks: { content: string }[]
): Promise<{ answer: string; leadIntent: boolean }> {
  const contextText = contextChunks.map((c) => c.content).join("\n\n---\n\n");

  const systemPrompt = `You are a friendly FAQ assistant for Suncore, a solar PV proposal company.
For factual questions, answer using ONLY the context below - do not use outside knowledge.
If the context does not contain relevant information to answer the question, use exactly this as the answer:
"${FALLBACK_TEXT}"
You may use a warm, conversational tone, but never invent facts not present in the context.
Do not start with a greeting (like "Hi there!") - this may be a follow-up in an ongoing
conversation, so jump straight into the answer.
Keep answers concise.

Separately, judge the visitor's underlying intent: are they showing genuine interest in getting
a personalized quote, pricing for their specific situation, or moving toward becoming a customer -
as opposed to just casually browsing general information? Base this on the meaning and tone of
their message, not on specific keywords. Set lead_intent to true only when that buying interest
is reasonably clear.

Context:
${contextText}

Visitor question: ${question}

Respond with ONLY a JSON object in this exact shape, no other text:
{"answer": "...", "lead_intent": true or false}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CHAT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: systemPrompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini generateContent failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;

  try {
    const parsed = JSON.parse(rawText);
    return {
      answer: typeof parsed.answer === "string" ? parsed.answer : FALLBACK_TEXT,
      leadIntent: parsed.lead_intent === true,
    };
  } catch {
    console.error("Failed to parse Gemini JSON response:", rawText);
    return { answer: FALLBACK_TEXT, leadIntent: false };
  }
}

/**
 * Lightweight standalone intent classification, used only when no FAQ chunks
 * matched (so askGemini's combined call never ran).
 */
async function classifyIntentOnly(question: string): Promise<boolean> {
  const prompt = `A visitor to a solar PV company's website asked: "${question}"

Judge their underlying intent: are they showing genuine interest in getting a personalized quote,
pricing for their specific situation, or moving toward becoming a customer - as opposed to just
casually browsing general information or asking something unrelated to solar? Base this on meaning
and tone, not specific keywords.

Respond with ONLY the word true or false, nothing else.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CHAT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
    });

    if (!res.ok) return false;

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    return text.trim().toLowerCase().startsWith("true");
  } catch (err) {
    console.error("Intent classification failed:", err);
    return false;
  }
}

async function logQuery(
  supabase: ReturnType<typeof createClient>,
  question: string,
  answer: string,
  matchedChunks: number
) {
  const wasFallback = answer.trim() === FALLBACK_TEXT;
  const { error } = await supabase.from("faq_query_log").insert({
    question,
    answer,
    matched_chunks: matchedChunks,
    was_fallback: wasFallback,
  });
  if (error) console.error("Failed to log query:", error.message);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { question, history } = await req.json();
    const chatHistory: ChatTurn[] = Array.isArray(history) ? history.slice(-6) : [];

    if (!question || typeof question !== "string" || question.trim().length === 0) {
      return new Response(JSON.stringify({ error: "Missing 'question' in request body." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 1a. Greeting / small talk -> friendly canned reply, skip RAG entirely
    if (GREETING_PATTERN.test(question)) {
      await logQuery(supabase, question, GREETING_REPLY, 0);
      return new Response(
        JSON.stringify({ answer: GREETING_REPLY, matched_chunks: 0, lead_intent: false }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Resolve follow-ups into a standalone question using recent history,
    // then embed THAT for retrieval (so vague follow-ups still match correctly)
    const standaloneQuestion = await rewriteStandaloneQuestion(question, chatHistory);
    const queryEmbedding = await embedQuestion(standaloneQuestion);

    // 2. Similarity search against faq_chunks
    const { data: matches, error: matchError } = await supabase.rpc("match_faq_chunks", {
      query_embedding: queryEmbedding,
      match_count: 5,
      match_threshold: 0.5,
    });

    if (matchError) throw matchError;

    // 3. No relevant chunks found -> fallback without calling the chat model,
    // but still classify intent since a visitor can show buying interest even
    // when nothing in the FAQ content matches their question.
    if (!matches || matches.length === 0) {
      const leadIntent = await classifyIntentOnly(standaloneQuestion);
      await logQuery(supabase, question, FALLBACK_TEXT, 0);
      return new Response(
        JSON.stringify({
          answer: FALLBACK_TEXT,
          matched_chunks: 0,
          lead_intent: leadIntent,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Ask Gemini, grounded in matched context - answer + intent in one call
    const { answer, leadIntent } = await askGemini(standaloneQuestion, matches);
    await logQuery(supabase, question, answer, matches.length);

    return new Response(
      JSON.stringify({
        answer,
        matched_chunks: matches.length,
        lead_intent: leadIntent,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("faq-ask error:", err);
    return new Response(JSON.stringify({ error: err.message ?? "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
