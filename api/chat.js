import Groq from 'groq-sdk';
import { pipeline } from '@xenova/transformers';
import { createClient } from '@supabase/supabase-js';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

let embedderInstance = null;
async function getEmbedder() {
  if (!embedderInstance) {
    embedderInstance = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedderInstance;
}

const availableTools = {
  search_knowledge_base: async ({ query }) => {
    const embedder = await getEmbedder();
    const output = await embedder(query, { pooling: 'mean', normalize: true });
    const queryEmbedding = Array.from(output.data);

    const { data, error } = await supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_threshold: 0.25,
      match_count: 2
    });

    if (error || !data || data.length === 0) {
      return "No directly matching documentation found in database.";
    }

    return data.map(d => `[${d.title}]: ${d.content}`).join('\n\n');
  },

  find_next_available_slot: async ({ is_emergency }) => {
    if (is_emergency) {
      return "VIP Emergency Slot: Today at 4:30 PM EST (Link: https://cal.com/vip-sync)";
    }
    return "Standard Slot: Tomorrow at 11:00 AM EST (Link: https://cal.com/standard-sync)";
  }
};

const tools = [
  {
    type: "function",
    function: {
      name: "search_knowledge_base",
      description: "Search official company documentation, policies, pricing, architecture, and warranties using semantic search.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query to match against documentation vectors" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_next_available_slot",
      description: "Look up scheduling availability. Set is_emergency = true if the client reports active outages or severe business loss.",
      parameters: {
        type: "object",
        properties: {
          is_emergency: { type: "boolean", description: "True if lead is experiencing urgent downtime or high loss" }
        },
        required: ["is_emergency"]
      }
    }
  }
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { sessionId, name, email, message } = req.body || {};

  if (!message || (!sessionId && (!name || !email))) {
    return res.status(400).json({ error: 'Invalid payload: missing message or session identity.' });
  }

  try {
    let currentSessionId = sessionId;

    // 1. Create session if new
    if (!currentSessionId) {
      const { data: newSession, error: sError } = await supabase
        .from('sessions')
        .insert([{ prospect_name: name.trim(), prospect_email: email.toLowerCase().trim() }])
        .select()
        .single();

      if (sError) throw sError;
      currentSessionId = newSession.id;
    }

    // 2. Persist the inbound user message
    await supabase.from('session_messages').insert([{
      session_id: currentSessionId,
      role: 'user',
      content: message
    }]);

    // 3. Hydrate previous conversation turns from Supabase (last 8 messages)
    const { data: history } = await supabase
      .from('session_messages')
      .select('role, content')
      .eq('session_id', currentSessionId)
      .order('created_at', { ascending: true })
      .limit(8);

    const messages = [
      {
        role: "system",
        content: `You are an autonomous technical solutions engineer.
Ground every answer strictly in retrieved documentation.
Use tools whenever company policies, pricing, or calendar slots are needed.
Be concise, technical, and refer to previous context if provided.`
      },
      ...history.map(m => ({ role: m.role, content: m.content }))
    ];

    // 4. Initial Agent Inference
    let response = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: messages,
      tools: tools,
      tool_choice: "auto"
    });

    let responseMessage = response.choices[0].message;

    // 5. Tool Resolution Loop
    while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      messages.push(responseMessage);

      for (const toolCall of responseMessage.tool_calls) {
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);
        const toolFn = availableTools[functionName];
        const result = await toolFn(functionArgs);

        messages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: functionName,
          content: JSON.stringify(result)
        });
      }

      response = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: messages
      });

      responseMessage = response.choices[0].message;
    }

    const assistantReply = responseMessage.content;

    // 6. Persist assistant reply in session memory
    await supabase.from('session_messages').insert([{
      session_id: currentSessionId,
      role: 'assistant',
      content: assistantReply
    }]);

    return res.status(200).json({
      success: true,
      sessionId: currentSessionId,
      reply: assistantReply
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}