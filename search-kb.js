import 'dotenv/config';
import { pipeline } from '@xenova/transformers';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function searchKB(userQuery) {
  console.log(`🔎 User Query: "${userQuery}"`);
  
  // 1. Embed user query with same model
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  const output = await embedder(userQuery, { pooling: 'mean', normalize: true });
  const queryEmbedding = Array.from(output.data);

  // 2. Call the Postgres match_documents RPC function
  const { data, error } = await supabase.rpc('match_documents', {
    query_embedding: queryEmbedding,
    match_threshold: 0.3, // Return results with >30% cosine similarity
    match_count: 2        // Top 2 most relevant chunks
  });

  if (error) {
    console.error("Search error:", error.message);
    return;
  }

  console.log("\n--- SEMANTIC SEARCH MATCHES ---");
  data.forEach((match, idx) => {
    console.log(`\n#${idx + 1} Match: [${match.title}] (Similarity: ${(match.similarity * 100).toFixed(1)}%)`);
    console.log(`Content: "${match.content}"`);
  });
}

// Notice: none of these words exist verbatim in "Refund & Trial Policy"
searchKB("What happens if the code stops working after you finish building it?");
