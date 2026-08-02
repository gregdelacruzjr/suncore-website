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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // tighten to your domain in production
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

async function askGemini(question: string, contextChunks: { content: string }[]): Promise<string> {
  const contextText = contextChunks.map((c) => c.content).join("\n\n---\n\n");

  const systemPrompt = `You are a friendly FAQ assistant for Suncore, a solar PV proposal company.
For factual questions, answer using ONLY the context below - do not use outside knowledge.
If the context does not contain relevant information to answer the question, respond exactly with:
"I don't have that information - please contact our team directly for details."
You may use a warm, conversational tone, but never invent facts not present in the context.
Keep answers concise.

Context:
${contextText}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CHAT_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: `${systemPrompt}\n\nVisitor question: ${question}` }],
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini generateContent failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text
    ?? "I don't have that information - please contact our team directly for details.";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { question } = await req.json();

    if (!question || typeof question !== "string" || question.trim().length === 0) {
      return new Response(JSON.stringify({ error: "Missing 'question' in request body." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 1a. Greeting / small talk -> friendly canned reply, skip RAG entirely
    if (GREETING_PATTERN.test(question)) {
      return new Response(
        JSON.stringify({ answer: GREETING_REPLY, matched_chunks: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Embed the question
    const queryEmbedding = await embedQuestion(question);

    // 2. Similarity search against faq_chunks
    const { data: matches, error: matchError } = await supabase.rpc("match_faq_chunks", {
      query_embedding: queryEmbedding,
      match_count: 5,
      match_threshold: 0.5,
    });

    if (matchError) throw matchError;

    // 3. No relevant chunks found -> fallback without calling the chat model
    if (!matches || matches.length === 0) {
      return new Response(
        JSON.stringify({
          answer: "I don't have that information - please contact our team directly for details.",
          matched_chunks: 0,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Ask Gemini, grounded in matched context
    const answer = await askGemini(question, matches);

    return new Response(
      JSON.stringify({ answer, matched_chunks: matches.length }),
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
