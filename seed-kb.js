import 'dotenv/config';
import { pipeline } from '@xenova/transformers';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Raw company documentation to chunk and embed
const documents = [
  {
    title: "Pricing & Plans",
    content: "Our core build starts at a flat $1,500 one-time fee. We offer a dedicated monthly retainer at $500/month for proactive monitoring, webhook error fixes, and LLM prompt tuning."
  },
  {
    title: "Emergency SLA & On-Call",
    content: "Standard inquiries have an SLA of 24 hours. For critical pipeline outages with urgency scores >= 8, our team guarantees a direct 30-minute callback via VIP bridge: https://cal.com/vip-sync"
  },
  {
    title: "Infrastructure & Tech Stack",
    content: "We construct zero-maintenance architectures using Node.js/TypeScript on Vercel Serverless Functions, PostgreSQL with pgvector hosted on Supabase, and ultra-low-latency Groq hardware inference."
  },
  {
    title: "Refund & Trial Policy",
    content: "We deliver full-stack builds with a 14-day defect-free guarantee. If any webhook or schema breaks within two weeks of deployment, patches are issued free of charge. Retainers can be cancelled anytime with 7 days notice."
  }
];

async function seedKnowledgeBase() {
  console.log("⏳ Initializing local embedding pipeline (all-MiniLM-L6-v2)...");
  
  // Loads compact model directly into memory (~80MB)
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

  console.log(" Embedding and inserting records into Supabase pgvector table...\n");

  for (const doc of documents) {
    // Generate 384-dimensional vector embedding
    const output = await embedder(doc.content, { pooling: 'mean', normalize: true });
    const embedding = Array.from(output.data);

    const { error } = await supabase
      .from('enterprise_kb')
      .insert({
        title: doc.title,
        content: doc.content,
        embedding: embedding
      });

    if (error) {
      console.error(`❌ Failed to insert "${doc.title}":`, error.message);
    } else {
      console.log(`✅ [SEEDED]: "${doc.title}" (384-dim vector stored)`);
    }
  }

  console.log("\n Knowledge base vectorization complete.");
}

seedKnowledgeBase();
