import 'dotenv/config';
import Groq from 'groq-sdk';
import { pipeline } from '@xenova/transformers';
import { createClient } from '@supabase/supabase-js';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const MODEL_ID = "qwen/qwen3.8-27b";

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

    const { data } = await supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_threshold: 0.25,
      match_count: 2
    });

    return (data && data.length > 0)
      ? data.map(d => `[${d.title}]: ${d.content}`).join('\n\n')
      : "No documentation found.";
  },

  find_next_available_slot: async ({ is_emergency }) => {
    return is_emergency 
      ? "VIP Emergency Slot: Today at 4:30 PM EST (https://cal.com/vip-sync)"
      : "Standard Slot: Tomorrow at 11:00 AM EST (https://cal.com/standard-sync)";
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
        properties: { query: { type: "string" } },
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
        properties: { is_emergency: { type: "boolean" } },
        required: ["is_emergency"]
      }
    }
  }
];

const testCases = [
  {
    id: "TC-01-CRITICAL-OUTAGE",
    description: "Active system outage must call calendar tool with is_emergency = true",
    input: "Our payment webhook is down right now and we are bleeding revenue. Need a meeting immediately!",
    expected: {
      mustCallTool: "find_next_available_slot",
      toolArgMatch: (args) => args.is_emergency === true,
      mustContainInText: ["vip-sync", "4:30"]
    }
  },
  {
    id: "TC-02-POLICY-RETRIEVAL",
    description: "Warranty query must invoke semantic KB search and cite guarantee duration",
    input: "What guarantee do we have if the serverless functions break after deployment?",
    expected: {
      mustCallTool: "search_knowledge_base",
      toolArgMatch: () => true,
      mustContainAny: [["14-day", "14 days", "two weeks", "defect-free"]],
      mustContainInText: ["guarantee"]
    }
  },
  {
    id: "TC-03-CASUAL-GREETING",
    description: "Simple greetings must NOT invoke unnecessary tools (Zero Waste)",
    input: "Hello, what is your name and what can you help me with?",
    expected: {
      mustNotCallAnyTool: true,
      mustContainInText: ["solutions", "engineer"]
    }
  },
  {
    id: "TC-04-PRICING-AND-SLOT",
    description: "Multi-intent inquiry must execute dual tool resolution",
    input: "How much does a setup cost and can I book standard time tomorrow?",
    expected: {
      mustCallMultipleTools: ["search_knowledge_base", "find_next_available_slot"],
      mustContainInText: ["1,500", "standard-sync"]
    }
  }
];

async function runEvaluations() {
  console.log("==================================================");
  console.log("🧪 STARTING DETERMINISTIC AGENT EVALUATION MATRIX");
  console.log(`🤖 Target Model: ${MODEL_ID}`);
  console.log("==================================================\n");

  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    console.log(`▶ Running [${tc.id}]: ${tc.description}`);
    const recordedTools = [];

    const messages = [
      {
        role: "system",
        content: "You are an autonomous technical solutions engineer. Ground answers strictly in retrieved documentation. Quote exact guarantee terms and SLA durations directly from documentation. Call tools when needed, but never call tools for casual conversation."
      },
      { role: "user", content: tc.input }
    ];

    try {
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
          const fnName = toolCall.function.name;
          const fnArgs = JSON.parse(toolCall.function.arguments);
          recordedTools.push({ name: fnName, args: fnArgs });

          const result = await availableTools[fnName](fnArgs);
          messages.push({
            tool_call_id: toolCall.id,
            role: "tool",
            name: fnName,
            content: JSON.stringify(result)
          });
        }

        response = await groq.chat.completions.create({
          model: MODEL_ID,
          messages: messages
        });
        responseMessage = response.choices[0].message;
      }

      const finalReply = (responseMessage.content || '').toLowerCase();
      // DEBUG: print the raw response to inspect what the model actually said
      if (tc.id === "TC-02-POLICY-RETRIEVAL") {
        console.log(`\n--- [DEBUG TC-02 RESPONSE] ---\n${responseMessage.content}\n------------------------------\n`);
      }
      const failures = [];

      if (tc.expected.mustNotCallAnyTool && recordedTools.length > 0) {
        failures.push(`Expected 0 tool calls, but agent called: ${recordedTools.map(t => t.name).join(', ')}`);
      }

      if (tc.expected.mustCallTool) {
        const found = recordedTools.find(t => t.name === tc.expected.mustCallTool);
        if (!found) {
          failures.push(`Missing required tool execution: "${tc.expected.mustCallTool}"`);
        } else if (!tc.expected.toolArgMatch(found.args)) {
          failures.push(`Tool "${found.name}" executed with invalid args: ${JSON.stringify(found.args)}`);
        }
      }

      if (tc.expected.mustCallMultipleTools) {
        for (const requiredTool of tc.expected.mustCallMultipleTools) {
          if (!recordedTools.some(t => t.name === requiredTool)) {
            failures.push(`Missing expected multi-tool call: "${requiredTool}"`);
          }
        }
      }

      if (tc.expected.mustContainInText) {
        for (const term of tc.expected.mustContainInText) {
          if (!finalReply.includes(term.toLowerCase())) {
            failures.push(`Output omitted critical term: "${term}"`);
          }
        }
      }

      if (tc.expected.mustContainAny) {
        for (const options of tc.expected.mustContainAny) {
          const matched = options.some(opt => finalReply.includes(opt.toLowerCase()));
          if (!matched) {
            failures.push(`Output omitted required phrasing. Expected one of: [${options.join(', ')}]`);
          }
        }
      }

      if (failures.length === 0) {
        console.log(`  ✅ PASSED\n`);
        passed++;
      } else {
        console.log(`  ❌ FAILED:`);
        failures.forEach(f => console.log(`     - ${f}`));
        console.log(`\n`);
        failed++;
      }

    } catch (err) {
      console.log(`  ❌ ERROR DURING RUN: ${err.message}\n`);
      failed++;
    }
  }

  console.log("==================================================");
  console.log(`🏁 EVALUATION COMPLETE: ${passed}/${testCases.length} PASSED (${((passed / testCases.length) * 100).toFixed(0)}%)`);
  console.log("==================================================");
}

runEvaluations();
