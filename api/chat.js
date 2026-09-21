import Groq from "groq-sdk";
import { createClient } from "@supabase/supabase-js";
import { pipeline } from "@xenova/transformers";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Downstream background dispatcher to Make
async function dispatchToMake(payload) {
  const webhookUrl = process.env.MAKE_DISPATCH_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log("[Make Dispatch] No webhook URL configured.");
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    console.log("[Make Dispatch] Response status:", response.status);
  } catch (err) {
    console.error("[Make Dispatch] Transmission failed:", err.message);
  }
}

// Tool definitions for function calling
const tools = [
  {
    type: "function",
    function: {
      name: "search_knowledge_base",
      description: "Searches the vector database for internal pricing, SLA terms, architecture, and company policies.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The specific search concept or question to look up.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_next_available_slot",
      description: "Finds available calendar sync slots for consultations or urgent downtime triage.",
      parameters: {
        type: "object",
        properties: {
          is_emergency: {
            type: "boolean",
            description: "Set to true if user mentions downtime, crashes, financial loss, or urgent issues.",
          },
        },
        required: ["is_emergency"],
      },
    },
  },
];

const availableTools = {
  search_knowledge_base: async ({ query }) => {
    try {
      const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
      const output = await extractor(query, { pooling: "mean", normalize: true });
      const queryEmbedding = Array.from(output.data);

      const { data, error } = await supabase.rpc("match_documents", {
        query_embedding: queryEmbedding,
        match_threshold: 0.25,
        match_count: 2,
      });

      if (error || !data || data.length === 0) {
        return "No directly matching documentation found in database.";
      }
      return data.map((d) => `[${d.title}]: ${d.content}`).join("\n\n");
    } catch (err) {
      return `Error querying knowledge base: ${err.message}`;
    }
  },
  find_next_available_slot: async ({ is_emergency }) => {
    if (is_emergency) {
      return JSON.stringify({
        slot: "Today at 4:30 PM EST",
        type: "Emergency Outage Triage (VIP)",
        bookingUrl: "https://cal.com/vip-sync",
      });
    }
    return JSON.stringify({
      slot: "Tomorrow at 11:00 AM EST",
      type: "Standard Technical Architecture Consultation",
      bookingUrl: "https://cal.com/consultation",
    });
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { message, sessionId, name, email } = req.body || {};
  const currentSessionId = sessionId || `session_${Date.now()}`;
  const incomingUserPrompt = message || "Hello";

  // Set SSE response headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  try {
    const messages = [
      {
        role: "system",
        content: `You are an enterprise solutions engineer. You evaluate technical inquiries, query internal vector knowledge docs for accurate pricing/guarantees, and provision calendar slots using tools. Always cite documentation directly.`,
      },
      {
        role: "user",
        content: incomingUserPrompt,
      },
    ];

const messages = [
      {
        role: "system",
        content: `You are an enterprise solutions engineer. You evaluate technical inquiries, query internal vector knowledge docs for accurate pricing/guarantees, and provision calendar slots using tools. Always cite documentation and provisioned URLs directly.`,
      },
      {
        role: "user",
        content: incomingUserPrompt,
      },
    ];

    // 1. Resolve all required tools iteratively (handles multi-tool queries)
    let completeAssistantReply = "";
    let stepCount = 0;
    const MAX_STEPS = 4;

    while (stepCount < MAX_STEPS) {
      stepCount++;

      const completion = await groq.chat.completions.create({
        model: "openai/gpt-oss-20b",
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0.1,
        max_tokens: 600,
      });

      const choice = completion.choices[0];
      const assistantMessage = choice?.message;

      // If the model invoked tools, resolve them and continue the loop
      if (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0) {
        messages.push(assistantMessage);

        for (const toolCall of assistantMessage.tool_calls) {
          const functionName = toolCall.function.name;
          const functionArgs = JSON.parse(toolCall.function.arguments || "{}");
          const toolFunction = availableTools[functionName];

          let toolOutput = "Tool not found.";
          if (toolFunction) {
            toolOutput = await toolFunction(functionArgs);
          }

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: functionName,
            content: toolOutput,
          });
        }
      } else {
        // All tools are resolved; capture the final generated response
        completeAssistantReply = assistantMessage?.content || "";
        break;
      }
    }

    // 2. Stream the completed response smoothly over SSE to the frontend
    const tokens = completeAssistantReply.match(/\S+\s*/g) || [completeAssistantReply];
    for (const token of tokens) {
      res.write(`event: token\ndata: ${JSON.stringify({ token })}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 20)); // smooth streaming pacing
    }

    // 3. Close SSE token stream
    res.write(`event: done\ndata: {}\n\n`);

    // 4. Calculate urgency tier
    const isEmergency =
      completeAssistantReply.includes("vip-sync") ||
      completeAssistantReply.toLowerCase().includes("emergency");
    const urgencyScore = isEmergency ? 9 : 5;

    // 5. Persist lead directly to Supabase public.leads
    try {
      await supabase.from("leads").insert({
        prospect_name: name || "Inbound Prospect",
        prospect_email: email || "inbound@lead-engine.local",
        category: isEmergency ? "Technical Support" : "General Inquiry",
        urgency_score: urgencyScore,
        draft_reply: completeAssistantReply,
        processed_at: new Date().toISOString(),
      });
    } catch (dbErr) {
      console.error("[Database Leads Insert Error]:", dbErr.message);
    }

    // 6. Push event to Make webhook
    await dispatchToMake({
      sessionId: currentSessionId,
      name: name || "Inbound Prospect",
      email: email || "inbound@lead-engine.local",
      userMessage: incomingUserPrompt,
      assistantReply: completeAssistantReply,
      urgencyScore: urgencyScore,
      timestamp: new Date().toISOString(),
    });

    res.end();


  } catch (err) {
    console.error("[Runtime Error]:", err);
    res.write(
      `event: token\ndata: ${JSON.stringify({
        token: `\n\n[Pipeline Error: ${err.message}]`,
      })}\n\n`
    );
    res.write(`event: done\ndata: {}\n\n`);
    res.end();
  }
}
