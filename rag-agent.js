import 'dotenv/config';
import Groq from 'groq-sdk';
import { pipeline } from '@xenova/transformers';
import { createClient } from '@supabase/supabase-js';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Pre-load the embedder instance for fast repeated queries
let embedderInstance = null;
async function getEmbedder() {
  if (!embedderInstance) {
    embedderInstance = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedderInstance;
}

// 1. Tool Implementations
const availableTools = {
  search_knowledge_base: async ({ query }) => {
    console.log(`\n🔎 [TOOL: pgvector RAG]: Searching database for: "${query}"...`);
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

    const context = data.map(d => `[${d.title}]: ${d.content}`).join('\n\n');
    console.log(`✅ [FOUND CONTEXT]:\n${context}`);
    return context;
  },

  find_next_available_slot: async ({ is_emergency }) => {
    console.log(`\n⚙️ [TOOL: Calendar]: Checking booking slots (Emergency: ${is_emergency})`);
    if (is_emergency) {
      return "VIP Emergency Slot: Today at 4:30 PM EST (Booking Link: https://cal.com/vip-sync)";
    }
    return "Standard Slot: Tomorrow at 11:00 AM EST (Booking Link: https://cal.com/standard-sync)";
  }
};

// 2. Tool Declarations
const tools = [
  {
    type: "function",
    function: {
      name: "search_knowledge_base",
      description: "Search official company documentation, policies, pricing, architecture, and warranties using semantic search.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query to match against documentation vectors"
          }
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
          is_emergency: {
            type: "boolean",
            description: "True if lead is experiencing urgent downtime or high loss"
          }
        },
        required: ["is_emergency"]
      }
    }
  }
];

// 3. Autonomous Execution Loop
async function processLeadWithRAG(lead) {
  console.log(`\n========================================`);
  console.log(`INCOMING INQUIRY: ${lead.name} (${lead.email})`);
  console.log(`MESSAGE: "${lead.message}"`);
  console.log(`========================================\n`);

  const messages = [
    {
      role: "system",
      content: `You are an autonomous technical solutions engineer.
Evaluate the inbound lead's message.
Use your tools to query company documentation and scheduling availability whenever necessary.
Ground every answer strictly in retrieved documentation.
Always address the lead courteously by their first name.`
    },
    {
      role: "user",
      content: `Lead Name: ${lead.name}\nEmail: ${lead.email}\nInquiry: ${lead.message}`
    }
  ];

  let response = await groq.chat.completions.create({
    model: "qwen/qwen3.8-27b", // Your active chat model ID
    messages: messages,
    tools: tools,
    tool_choice: "auto"
  });

  let responseMessage = response.choices[0].message;

  // Agent Resolution Loop
  while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
    messages.push(responseMessage);

    for (const toolCall of responseMessage.tool_calls) {
      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments);

      console.log(`🤖 [MODEL INTENT]: Wants to call "${functionName}" with:`, functionArgs);

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
      model: "qwen/qwen3.8-27b",
      messages: messages
    });

    responseMessage = response.choices[0].message;
  }

  console.log("\n--- GROUNDED RESPONSE GENERATED ---");
  console.log(responseMessage.content);
}

// Test with an inquiry that requires BOTH semantic docs AND emergency scheduling
processLeadWithRAG({
  name: "David Kim",
  email: "dkim@hyperflow.dev",
  message: "We're worried that if we hire you to build our pipeline and it crashes after deployment, we'll get stuck. What guarantees do you offer, and can we schedule an urgent call right now?"
});
