import 'dotenv/config';
import Groq from 'groq-sdk';
import { createClient } from '@supabase/supabase-js';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// 1. Mock Enterprise Context (Knowledge Base & Calendar)
const COMPANY_KB = {
  pricing: "Custom automations start at $1,500. Retainers are $500/month for monitoring and prompt optimization.",
  sla: "Standard response SLA is 24 hours. Critical tickets (urgency >= 8) guarantee a callback within 30 minutes.",
  tech_stack: "We deploy on Vercel edge functions, PostgreSQL via Supabase, and Groq high-throughput Llama inference."
};

// 2. Tool Implementations (Functions the model can execute)
const availableTools = {
  get_knowledge_base_info: ({ query_topic }) => {
    console.log(`\n⚙️ [TOOL EXECUTED]: Querying KB for topic: "${query_topic}"`);
    return COMPANY_KB[query_topic] || "No specific documentation found for this topic.";
  },
  
  find_next_available_slot: ({ is_emergency }) => {
    console.log(`\n⚙️ [TOOL EXECUTED]: Checking calendar (Emergency: ${is_emergency})`);
    if (is_emergency) {
      return "Today at 4:30 PM EST with Senior Solutions Architect (VIP Priority Link: https://cal.com/vip-sync)";
    }
    return "Tomorrow at 11:00 AM EST (Standard Link: https://cal.com/standard-sync)";
  }
};

// 3. Tool Schemas Provided to Groq/Llama
const tools = [
  {
    type: "function",
    function: {
      name: "get_knowledge_base_info",
      description: "Retrieve official company facts regarding pricing, SLA guarantees, or tech stack capabilities.",
      parameters: {
        type: "object",
        properties: {
          query_topic: {
            type: "string",
            enum: ["pricing", "sla", "tech_stack"],
            description: "The topic to look up in documentation"
          }
        },
        required: ["query_topic"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_next_available_slot",
      description: "Find an open consultation slot. Use emergency = true if urgency is critical (>= 8).",
      parameters: {
        type: "object",
        properties: {
          is_emergency: {
            type: "boolean",
            description: "Whether the prospect requires an immediate priority slot"
          }
        },
        required: ["is_emergency"]
      }
    }
  }
];

// 4. The Agent Execution Loop
async function runAgentPipeline(lead) {
  console.log(`\n--- INCOMING INQUIRY FROM ${lead.name} ---`);
  console.log(`Message: "${lead.message}"\n`);

  const messages = [
    {
      role: "system",
      content: `You are an autonomous enterprise solutions agent.
Analyze the user's message. Use tools to look up accurate company policies, pricing, and available calendar slots if relevant.
Once you have gathered all necessary information, provide a professional, highly concise reply addressing the lead by their first name.`
    },
    {
      role: "user",
      content: `Lead Name: ${lead.name}\nEmail: ${lead.email}\nMessage: ${lead.message}`
    }
  ];

  // Initial call with tool declarations
  let response = await groq.chat.completions.create({
    model: "qwen/qwen3.8-27b", // Or the exact model ID that succeeded for your account
    messages: messages,
    tools: tools,
    tool_choice: "auto"
  });

  let responseMessage = response.choices[0].message;

  // Step 5: Check if the model wants to call tools
  while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
    // Append the assistant's request to call tools to history
    messages.push(responseMessage);

    for (const toolCall of responseMessage.tool_calls) {
      const functionName = toolCall.function.name;
      const functionArgs = JSON.parse(toolCall.function.arguments);
      
      console.log(`🤖 [MODEL REQUEST]: Calling function "${functionName}" with args:`, functionArgs);

      // Execute the local tool
      const toolFunction = availableTools[functionName];
      const toolResult = toolFunction(functionArgs);

      // Return the tool output back to the conversation
      messages.push({
        tool_call_id: toolCall.id,
        role: "tool",
        name: functionName,
        content: JSON.stringify(toolResult)
      });
    }

    // Call the model again so it can digest the tool outputs
    response = await groq.chat.completions.create({
      model: "qwen/qwen3.8-27b", // Same model ID
      messages: messages
    });

    responseMessage = response.choices[0].message;
  }

  console.log("\n--- FINAL AGENT RESPONSE ---");
  console.log(responseMessage.content);
}

// 6. Test Case: High urgency inquiry asking about pricing & urgent meeting
runAgentPipeline({
  name: "Alexander Pierce",
  email: "apierce@nexusventures.com",
  message: "We are losing $10k/day because our webhook pipeline is down. What are your pricing plans and can we get an emergency call in the next couple hours?"
});