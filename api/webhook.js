import Groq from 'groq-sdk';
import { createClient } from '@supabase/supabase-js';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed. Send a POST request.' });
  }

  const { name, email, message } = req.body || {};

  if (!name || !email || !message) {
    return res.status(400).json({ 
      error: 'Invalid Payload. "name", "email", and "message" are required.' 
    });
  }

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
      model: "qwen/qwen3.8-27b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Name: ${name}\nEmail: ${email}\nMessage: ${message}` }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2
    });

    const rawContent = response.choices[0]?.message?.content;
    const structuredData = JSON.parse(rawContent);

    const sanitizedRecord = {
      prospect_name: name.trim(),
      prospect_email: email.toLowerCase().trim(),
      category: ["Sales", "Technical Support", "General"].includes(structuredData.category)
        ? structuredData.category 
        : "General",
      urgency_score: Math.min(Math.max(Number(structuredData.urgency_score) || 5, 1), 10),
      draft_reply: structuredData.draft_reply,
      processed_at: new Date().toISOString()
    };

    // Insert directly into Supabase
    const { data, error } = await supabase
      .from('leads')
      .insert([sanitizedRecord])
      .select();

    if (error) throw error;

    return res.status(200).json({
      success: true,
      record_id: data[0].id,
      data: data[0]
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
