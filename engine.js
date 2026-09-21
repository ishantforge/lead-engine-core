import 'dotenv/config';
import Groq from 'groq-sdk';
import { createClient } from '@supabase/supabase-js';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const dummySubmission = {
  name: "Marcus Vance",
  email: "marcus@vancemedia.io",
  message: "Hey, our agency handles 300 leads a month for local dentists. We are losing deals because our team takes 3 hours to reply. Can we automate the triage and Slack alerts urgently?"
};

async function processInboundLead(lead) {
  console.log(`[INGESTED]: Processing inquiry from ${lead.name}...`);

  const systemPrompt = `
You are an enterprise Lead Triage Engine.
Analyze the user's inquiry and output ONLY a valid JSON object matching this exact schema:
{
  "category": "Sales" | "Technical Support" | "General",
  "urgency_score": <number between 1 and 10>,
  "draft_reply": "<3-sentence professional email addressing the sender by first name, acknowledging their specific pain point, and proposing a fast sync>"
}
Do NOT include markdown backticks (\`\`\`json) or conversational filler. Return raw JSON only.
`;

  try {
    const response = await groq.chat.completions.create({
      model: "qwen/qwen3.8-27b", // Ensure this matches the working model ID you just ran
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Name: ${lead.name}\nEmail: ${lead.email}\nMessage: ${lead.message}` }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2
    });

    const rawContent = response.choices[0]?.message?.content;
    const structuredData = JSON.parse(rawContent);

    // Data Sanitization & Fallback Layer
    const sanitizedRecord = {
      prospect_name: lead.name.trim(),
      prospect_email: lead.email.toLowerCase().trim(),
      category: ["Sales", "Technical Support", "General"].includes(structuredData.category)
        ? structuredData.category 
        : "General",
      urgency_score: Math.min(Math.max(Number(structuredData.urgency_score) || 5, 1), 10),
      draft_reply: structuredData.draft_reply,
      processed_at: new Date().toISOString()
    };

    console.log("\n--- ENRICHMENT COMPLETE. SYNCING TO SUPABASE... ---");

    // Write to PostgreSQL
    const { data, error } = await supabase
      .from('leads')
      .insert([sanitizedRecord])
      .select();

    if (error) throw error;

    console.log("[DB SUCCESS]: Inserted lead record with ID:", data[0].id);
    console.dir(data[0], { depth: null });
    return data[0];

  } catch (error) {
    console.error("[PIPELINE ERROR]:", error.message);
  }
}

// Execute
processInboundLead(dummySubmission); 
