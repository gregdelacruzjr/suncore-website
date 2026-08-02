/**
 * Suncore FAQ Ingestion Script
 * ------------------------------------------------------
 * Reads a markdown FAQ file, splits it into Q&A chunks,
 * generates embeddings via Gemini, and seeds the
 * `faq_chunks` table in Supabase.
 *
 * Usage:
 *   node ingest-faq.js path/to/faq-content.md
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (service role, not anon — bypasses RLS for seeding)
 *   GEMINI_API_KEY
 */

import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GEMINI_API_KEY) {
  console.error(
    "Missing required env vars. Need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY."
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const EMBEDDING_MODEL = "gemini-embedding-001"; // current GA embedding model
const OUTPUT_DIMENSIONALITY = 768; // truncated via Matryoshka — must match faq_chunks.embedding column

/**
 * Parses the FAQ markdown into chunks.
 * Each chunk = one Q&A pair, tagged with its section (## heading) as source_doc.
 */
function parseFaqMarkdown(markdown) {
  const chunks = [];
  let currentSection = "General";

  // Split on lines, walk through tracking current section + accumulating Q/A pairs
  const lines = markdown.split("\n");
  let currentQ = null;
  let currentA = [];

  function flush() {
    if (currentQ) {
      const content = `Q: ${currentQ}\nA: ${currentA.join(" ").trim()}`;
      chunks.push({ source_doc: currentSection, content });
    }
    currentQ = null;
    currentA = [];
  }

  for (const line of lines) {
    const sectionMatch = line.match(/^##\s+(.*)/);
    const qMatch = line.match(/^\*\*Q:\s*(.*?)\*\*$/);
    const aMatch = line.match(/^A:\s*(.*)/);

    if (sectionMatch) {
      flush();
      currentSection = sectionMatch[1].trim();
      continue;
    }

    if (qMatch) {
      flush();
      currentQ = qMatch[1].trim();
      continue;
    }

    if (aMatch && currentQ) {
      currentA.push(aMatch[1].trim());
      continue;
    }
  }
  flush();

  return chunks;
}

/**
 * Calls Gemini's embedding endpoint for a single text chunk.
 */
async function embedText(text) {
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
    const errText = await res.text();
    throw new Error(`Gemini embedding request failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  return data.embedding.values; // array of 768 floats
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node ingest-faq.js path/to/faq-content.md");
    process.exit(1);
  }

  const absPath = path.resolve(filePath);
  const markdown = fs.readFileSync(absPath, "utf-8");

  const chunks = parseFaqMarkdown(markdown);
  console.log(`Parsed ${chunks.length} FAQ chunks from ${filePath}`);

  if (chunks.length === 0) {
    console.warn("No chunks found — check the markdown format matches the expected pattern.");
    return;
  }

  let successCount = 0;
  let failCount = 0;

  for (const [i, chunk] of chunks.entries()) {
    try {
      console.log(`[${i + 1}/${chunks.length}] Embedding: "${chunk.content.slice(0, 60)}..."`);
      const embedding = await embedText(chunk.content);

      const { error } = await supabase.from("faq_chunks").insert({
        source_doc: chunk.source_doc,
        content: chunk.content,
        embedding,
      });

      if (error) throw error;
      successCount++;
    } catch (err) {
      console.error(`  Failed to ingest chunk ${i + 1}:`, err.message);
      failCount++;
    }
  }

  console.log(`\nDone. ${successCount} chunks inserted, ${failCount} failed.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
