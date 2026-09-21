import Groq from 'groq-sdk';
import { pipeline } from '@xenova/transformers';
import { createClient } from '@supabase/supabase-js';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const MODEL_ID = "qwen/qwen3.8-27b"; // Ensure this matches your active Groq model

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

    async function dispatchToMake(payload) {
  const webhookUrl = process.env.MAKE_DISPATCH_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(err => console.error("Make dispatch async error:", err.message));
  } catch (e) {
    console.error("Failed to trigger Make dispatch:", e.message);
  }
}

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
      description: "Search official company documentation, pricing, guarantees, and SLA terms.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_next_available_slot",
      description: "Look up scheduling availability. Set is_emergency = true for critical downtime or active loss.",
      parameters: {
        type: "object",
        properties: { is_emergency: { type: "boolean", description: "True if active emergency" } },
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
    return res.status(400).json({ error: 'Missing message or identity' });
  }

  try {
    let currentSessionId = sessionId;

    // 1. Initialize session if new
    if (!currentSessionId) {
      const { data: newSession, error: sError } = await supabase
        .from('sessions')
        .insert([{ prospect_name: name.trim(), prospect_email: email.toLowerCase().trim() }])
        .select()
        .single();
      if (sError) throw sError;
      currentSessionId = newSession.id;
    }

    // 2. Persist new user message
    await supabase.from('session_messages').insert([{
      session_id: currentSessionId,
      role: 'user',
      content: message
    }]);

    // 3. Hydrate session summary & message count
    const { data: sessionData } = await supabase
      .from('sessions')
      .select('summary')
      .eq('id', currentSessionId)
      .single();

    const { data: allMessages } = await supabase
      .from('session_messages')
      .select('role, content')
      .eq('session_id', currentSessionId)
      .order('created_at', { ascending: true });

    let runningSummary = sessionData?.summary || '';

    // Sliding Window Summarization: Trigger if conversation history exceeds 6 turns
    if (allMessages.length > 6) {
      const olderTurns = allMessages.slice(0, allMessages.length - 4);
      const summaryPrompt = `Condense the following conversation into 2-3 factual bullet points. Retain client identity, budget constraints, technical needs, and booked slots:\n` +
        olderTurns.map(m => `${m.role}: ${m.content}`).join('\n');

      const sumRes = await groq.chat.completions.create({
        model: "qwen/qwen3.8-27b",
        messages: [{ role: 'user', content: summaryPrompt }],
        temperature: 0.1
      });

      runningSummary = sumRes.choices[0]?.message?.content || runningSummary;
      await supabase.from('sessions').update({ summary: runningSummary }).eq('id', currentSessionId);
    }

    // Use summary + last 4 messages for token-efficient prompt payload
    const recentMessages = allMessages.slice(-4);
    const messages = [
      {
        role: "system",
        content: `You are an autonomous technical solutions engineer. Ground every answer strictly in retrieved documentation. Use tools when needed.
${runningSummary ? `\nRolling Conversation Context:\n${runningSummary}` : ''}`
      },
      ...recentMessages.map(m => ({ role: m.role, content: m.content }))
    ];

    // 4. Resolve Tool Calls (Non-streaming evaluation pass)
    let response = await groq.chat.completions.create({
      model: MODEL_ID,
      messages: messages,
      tools: tools,
      tool_choice: "auto"
    });

    let responseMessage = response.choices[0].message;

    while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      messages.push(responseMessage);
      for (const toolCall of responseMessage.tool_calls) {
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);
        const result = await availableTools[functionName](functionArgs);

        messages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: functionName,
          content: JSON.stringify(result)
        });
      }

      response = await groq.chat.completions.create({
        model: "qwen/qwen3.8-27b",
        messages: messages
      });
      responseMessage = response.choices[0].message;
    }

    // 5. Open Server-Sent Events (SSE) Stream for real-time delivery
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    // Send metadata header event with session ID
    res.write(`event: session\ndata: ${JSON.stringify({ sessionId: currentSessionId })}\n\n`);

    const stream = await groq.chat.completions.create({
      model: "qwen/qwen3.8-27b",
      messages: messages,
      stream: true
    });

    let completeAssistantReply = '';

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) {
        completeAssistantReply += delta;
        res.write(`event: token\ndata: ${JSON.stringify({ token: delta })}\n\n`);
      }
    }

    res.write(`event: done\ndata: {}\n\n`);
    res.end();

    // Check if lead was high urgency or scheduled an emergency
      const isEmergencySync = fullAssistantReply.includes("vip-sync") || fullAssistantReply.toLowerCase().includes("emergency");
      const computedUrgency = isEmergencySync ? 9 : 5;

      // Fire non-blocking downstream webhook to Make
      dispatchToMake({
        sessionId: currentSessionId,
        name: name || "Anonymous Lead",
        email: email || "Not Provided",
        userMessage: message,
        assistantReply: fullAssistantReply,
        urgencyScore: computedUrgency,
        timestamp: new Date().toISOString()
      });

    // 6. Asynchronously commit the final generated response into Supabase
    if (completeAssistantReply) {
      await supabase.from('session_messages').insert([{
        session_id: currentSessionId,
        role: 'assistant',
        content: completeAssistantReply
      }]);
    }

  } catch (err) {
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message });
    }
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
}
