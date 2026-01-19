import { generateText, tool, Output, type LanguageModel } from "ai"
import { z } from "zod"
import type {
  Ledger,
  Plan,
  PlanNode,
  PlanDelta,
  NodeId,
  TrajectoryEntry,
  ReActSubagentInput,
  ReActSubagentOutput,
  MostRecentVerification,
  VerificationOutput,
} from "./types"
import { summarizeTrajectory } from "./summarize-trajectory"

// ============================================================================
// Budget Utilities
// ============================================================================

function budgetIsExhausted(ledger: Ledger): boolean {
  return ledger.search.remaining <= 0 || ledger.browse.remaining <= 0
}

type BudgetRegime = "HIGH" | "MEDIUM" | "LOW" | "CRITICAL"

function getBudgetRegime(ledger: Ledger): BudgetRegime {
  const searchTotal = ledger.search.used + ledger.search.remaining
  const browseTotal = ledger.browse.used + ledger.browse.remaining

  const searchPercent =
    searchTotal > 0 ? ledger.search.remaining / searchTotal : 0
  const browsePercent =
    browseTotal > 0 ? ledger.browse.remaining / browseTotal : 0

  // Use the lower of the two percentages
  const minPercent = Math.min(searchPercent, browsePercent)

  if (minPercent >= 0.7) return "HIGH"
  if (minPercent >= 0.3) return "MEDIUM"
  if (minPercent >= 0.1) return "LOW"
  return "CRITICAL"
}

function formatBudgetStatus(ledger: Ledger): string {
  const regime = getBudgetRegime(ledger)
  return `<budget>
Query Budget Used: ${ledger.search.used}, Query Budget Remaining: ${ledger.search.remaining}
URL Budget Used: ${ledger.browse.used}, URL Budget Remaining: ${ledger.browse.remaining}
Budget Regime: ${regime}
Make the best use of the available resources.
</budget>`
}

// ============================================================================
// Plan Utilities
// ============================================================================

function findNode(roots: PlanNode[], nodeId: NodeId): PlanNode | null {
  for (const node of roots) {
    if (node.id === nodeId) return node
    if (node.children) {
      const found = findNode(node.children, nodeId)
      if (found) return found
    }
  }
  return null
}

function applyPlanDeltas(plan: Plan, deltas: PlanDelta[]): void {
  for (const delta of deltas) {
    switch (delta.op) {
      case "addNode": {
        const newNode: PlanNode = {
          ...delta.node,
          children: [],
        }
        if (delta.parentId === null) {
          plan.roots.push(newNode)
        } else {
          const parent = findNode(plan.roots, delta.parentId)
          if (parent) {
            parent.children = parent.children || []
            parent.children.push(newNode)
          }
        }
        break
      }
      case "updateStatus": {
        const node = findNode(plan.roots, delta.nodeId)
        if (node) {
          node.status = delta.status
        }
        break
      }
      case "appendNotes": {
        const node = findNode(plan.roots, delta.nodeId)
        if (node) {
          node.notes = (node.notes || "") + "\n" + delta.notes
        }
        break
      }
      case "setCursor": {
        plan.executionCursor = delta.nodeId
        break
      }
    }
  }
}

function formatPlan(plan: Plan): string {
  const formatNode = (node: PlanNode, indent: number): string => {
    const prefix = "  ".repeat(indent)
    const statusMarker =
      node.status === "done"
        ? "[x]"
        : node.status === "failed"
          ? "[!]"
          : node.status === "partial"
            ? "[~]"
            : "[ ]"
    const cursor = plan.executionCursor === node.id ? " ← CURSOR" : ""
    const usage =
      node.usage.query > 0 || node.usage.url > 0
        ? ` (Query=${node.usage.query}, URL=${node.usage.url})`
        : ""
    const notes = node.notes ? `\n${prefix}  Notes: ${node.notes}` : ""

    let result = `${prefix}${statusMarker} ${node.id}: ${node.description}${usage}${cursor}${notes}`

    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        result += "\n" + formatNode(child, indent + 1)
      }
    }

    return result
  }

  if (plan.roots.length === 0) {
    return "<plan>\nNo plan steps yet. Create your initial plan.\n</plan>"
  }

  const formattedRoots = plan.roots.map((root) => formatNode(root, 0)).join("\n")
  return `<plan>
Status: ${plan.status}
Total Usage: Query=${plan.totalUsage.query}, URL=${plan.totalUsage.url}

${formattedRoots}
</plan>`
}

// ============================================================================
// Trajectory Utilities
// ============================================================================

function formatTrajectory(trajectory: TrajectoryEntry[]): string {
  if (trajectory.length === 0) {
    return "<trajectory>\nNo prior iterations in this attempt.\n</trajectory>"
  }

  const formatted = trajectory
    .map((entry) => {
      const toolCallsStr =
        entry.toolCalls.length > 0
          ? entry.toolCalls
              .map((tc) => `  - ${tc.toolName}: ${JSON.stringify(tc.input)}`)
              .join("\n")
          : "  (no tool calls)"

      return `--- Iteration ${entry.iteration} ---
Thinking: ${entry.thinking}
Tool Calls:
${toolCallsStr}`
    })
    .join("\n\n")

  return `<trajectory>
${formatted}
</trajectory>`
}

// ============================================================================
// Tool Definitions
// ============================================================================

const planDeltaSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("addNode"),
    parentId: z
      .string()
      .nullable()
      .describe("Parent node ID, or null for root node"),
    node: z.object({
      id: z.string().describe("Unique identifier for this node"),
      description: z.string().describe("What this step aims to accomplish"),
      status: z
        .enum(["pending", "partial", "done", "failed"])
        .describe("Current status"),
      usage: z
        .object({
          query: z.number().describe("Search queries used for this node"),
          url: z.number().describe("URLs browsed for this node"),
        })
        .describe("Resource usage for this node"),
      notes: z.string().optional().describe("Optional notes about this step"),
    }),
  }),
  z.object({
    op: z.literal("updateStatus"),
    nodeId: z.string().describe("ID of the node to update"),
    status: z
      .enum(["pending", "partial", "done", "failed"])
      .describe("New status"),
  }),
  z.object({
    op: z.literal("appendNotes"),
    nodeId: z.string().describe("ID of the node to append notes to"),
    notes: z.string().describe("Notes to append"),
  }),
  z.object({
    op: z.literal("setCursor"),
    nodeId: z
      .string()
      .nullable()
      .describe("ID of the node to focus on, or null"),
  }),
])

const searchInputSchema = z.object({
  query: z
    .array(z.string())
    .min(1)
    .describe(
      "Array of search query strings. Each query consumes 1 budget unit.",
    ),
})

const browseInputSchema = z.object({
  url: z
    .array(z.string())
    .min(1)
    .describe("Array of URLs to visit. Each URL consumes 1 budget unit."),
  goal: z
    .string()
    .describe("The specific information goal for browsing these pages."),
})

const submitAnswerInputSchema = z.object({
  answer: z.string().describe("The proposed answer to the question"),
  justification: z
    .string()
    .describe("Brief justification explaining why this answer is correct"),
})

function createSearchTool() {
  return tool({
    description:
      "Performs batched web searches. Each query string in the array consumes 1 unit of Query Budget. Returns top 10 results per query.",
    inputSchema: searchInputSchema,
    execute: async ({ query }) => {
      // This is a stub - actual implementation would call a search API
      return {
        results: query.map((q: string) => ({
          query: q,
          results: [
            {
              title: `[Stub] Result for: ${q}`,
              snippet: "This is a stub implementation. Connect to actual search API.",
              url: `https://example.com/search?q=${encodeURIComponent(q)}`,
            },
          ],
        })),
      }
    },
  })
}

function createBrowseTool() {
  return tool({
    description:
      "Visit webpage(s) and return content. Each URL consumes 1 unit of URL Budget. Content is truncated to 150k characters.",
    inputSchema: browseInputSchema,
    execute: async ({ url, goal }) => {
      // This is a stub - actual implementation would call a browse API
      return {
        pages: url.map((u: string) => ({
          url: u,
          content: `[Stub] Content for ${u} with goal: ${goal}. Connect to actual browse API.`,
        })),
      }
    },
  })
}

function createSubmitAnswerTool() {
  return tool({
    description:
      "Submit a proposed answer when you have gathered sufficient evidence. Use this when you are confident in your answer.",
    inputSchema: submitAnswerInputSchema,
    execute: async ({ answer, justification }) => {
      return { answer, justification }
    },
  })
}

// ============================================================================
// System Prompt
// ============================================================================

function buildSystemPrompt(ledger: Ledger): string {
  const regime = getBudgetRegime(ledger)

  return `You are an AI reasoning agent solving information-seeking questions through iterative search and analysis.

## Budget Awareness

You have two independent budgets:
- **Query Budget** (search): Used ${ledger.search.used}, Remaining ${ledger.search.remaining}
- **URL Budget** (browse): Used ${ledger.browse.used}, Remaining ${ledger.browse.remaining}

Current Regime: **${regime}**

Adapt your strategy based on budget regime:
- **HIGH (≥70% remaining)**: Broad exploration, 3-5 diverse queries, 2-3 URLs per cycle
- **MEDIUM (30-70%)**: Focused refinement, 2-3 precise queries, 1-2 key URLs
- **LOW (10-30%)**: Verification only, 1 targeted query, 1 critical URL
- **CRITICAL (<10%)**: Final answer attempt, minimal tool use

## Planning

Maintain a tree-structured plan with:
- Status markers: [ ] pending, [x] done, [!] failed, [~] partial
- Resource tracking per step
- Never delete steps; update status instead

Output plan changes as structured deltas in the \`planDeltas\` field.

## Constraint Analysis

Questions contain two types of constraints:
- **Exploration**: Broad, core requirements. Use for initial searches.
- **Verification**: Narrow, specific details. Use to validate candidates.

Start with exploration queries, then use verification to validate results.

## Your Task

For each iteration:
1. **Think**: Analyze the current state, budget, and progress in the \`thinking\` field
2. **Update Plan**: Output deltas to refine your plan in the \`planDeltas\` field
3. **Act**: EITHER use tools (search/browse) OR submit your answer with submitAnswer

If you have sufficient evidence to answer the question, use the submitAnswer tool.
If you need more information, use search and/or browse tools.

## Important Rules

- Always justify your tool selection based on remaining budget
- Never exceed budget limits - check before making tool calls
- Update plan status after tool calls complete
- When proposing an answer, mark relevant plan tasks as "done"
- If stuck or out of options, submit your best answer even if uncertain`
}

// ============================================================================
// Output Schema
// ============================================================================

const reActOutputSchema = z.object({
  thinking: z
    .string()
    .describe(
      "Your reasoning process: analyze current state, budget, progress, and justify your next action.",
    ),
  planDeltas: z
    .array(planDeltaSchema)
    .describe(
      "Atomic operations to update the plan. Include setCursor to indicate execution focus.",
    ),
})

// ============================================================================
// Main ReAct Subagent
// ============================================================================

export async function runReActSubagent(
  input: ReActSubagentInput & {
    model: LanguageModel
    verificationOutputs: VerificationOutput[]
  },
): Promise<ReActSubagentOutput> {
  const {
    question,
    ledger,
    plan,
    allTrajectorySummaries,
    mostRecentVerification,
    K,
    model,
    verificationOutputs,
  } = input

  const trajectory: TrajectoryEntry[] = []
  let proposedAnswer: string | null = null
  let iteration = 0
  let iterationsSinceLastCompaction = 0
  let lastToolResponse: string | null = null

  // Create tools
  const searchTool = createSearchTool()
  const browseTool = createBrowseTool()
  const submitAnswerTool = createSubmitAnswerTool()

  while (!proposedAnswer) {
    // 1. Budget Pre-check
    if (budgetIsExhausted(ledger)) {
      return { proposedAnswer: null, trajectory, budgetExhausted: true }
    }

    iteration++
    iterationsSinceLastCompaction++

    // 2. Construct LLM Context
    const systemPrompt = buildSystemPrompt(ledger)

    let userPrompt = `## Question
${question}

`

    // Add trajectory summaries from all prior attempts
    if (allTrajectorySummaries.length > 0) {
      userPrompt += `## Prior Attempt Summaries
${allTrajectorySummaries.map((s, i) => `### Attempt ${i + 1}\n${s}`).join("\n\n")}

`
    }

    // Add most recent verification guidance
    if (mostRecentVerification) {
      userPrompt += `## Most Recent Verification
Decision: ${mostRecentVerification.decision}

### Guidance
${mostRecentVerification.guidance}

### Strategic Recommendations
${mostRecentVerification.recommendations}

`
    }

    // Add accumulated trajectory
    userPrompt += `## Current Attempt Trajectory
${formatTrajectory(trajectory)}

`

    // Add current plan
    userPrompt += `## Current Plan
${formatPlan(plan)}

`

    // Add most recent tool response
    if (lastToolResponse) {
      userPrompt += `## Most Recent Tool Response
${lastToolResponse}

`
    }

    // Add budget status
    userPrompt += `## Current Budget Status
${formatBudgetStatus(ledger)}

Now analyze the situation and decide your next action.`

    // 3. Tool-Enabled LLM Call
    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: userPrompt,
      tools: {
        search: searchTool,
        browse: browseTool,
        submitAnswer: submitAnswerTool,
      },
      output: Output.object({
        schema: reActOutputSchema,
      }),
      temperature: 0.7,
      maxOutputTokens: 16384,
    })

    // 4. Post-LLM Processing

    // Extract thinking from structured output or text
    const thinking = result.output?.thinking || result.text || ""

    // Apply plan deltas
    if (result.output?.planDeltas) {
      applyPlanDeltas(plan, result.output.planDeltas as PlanDelta[])
    }

    // Create trajectory entry
    const trajectoryEntry: TrajectoryEntry = {
      iteration,
      thinking,
      toolCalls: [],
    }

    // Process tool calls
    const toolCalls = result.toolCalls
    if (toolCalls && toolCalls.length > 0) {
      lastToolResponse = ""

      for (const toolCall of toolCalls) {
        // Skip dynamic tool calls
        if ("dynamic" in toolCall && toolCall.dynamic) continue

        // Access input property from the tool call
        const toolInput = "input" in toolCall ? toolCall.input : undefined

        if (toolCall.toolName === "submitAnswer" && toolInput) {
          // Answer proposed - exit loop
          const input = toolInput as z.infer<typeof submitAnswerInputSchema>
          proposedAnswer = input.answer
          trajectoryEntry.toolCalls.push({
            toolName: "search", // Log as action taken
            input: { query: [`[Answer submitted: ${input.answer}]`] },
          })
          break
        } else if (toolCall.toolName === "search" && toolInput) {
          const input = toolInput as z.infer<typeof searchInputSchema>
          const queryCount = input.query.length

          // Update ledger BEFORE checking exhaustion
          ledger.search.used += queryCount
          ledger.search.remaining -= queryCount
          plan.totalUsage.query += queryCount

          // Update current cursor node usage if set
          if (plan.executionCursor) {
            const cursorNode = findNode(plan.roots, plan.executionCursor)
            if (cursorNode) {
              cursorNode.usage.query += queryCount
            }
          }

          // Execute tool
          const toolResult = await searchTool.execute!(input, {
            toolCallId: toolCall.toolCallId,
            messages: [],
            abortSignal: undefined as unknown as AbortSignal,
          })

          trajectoryEntry.toolCalls.push({
            toolName: "search",
            input,
          })

          lastToolResponse += `\n### Search Results\n${JSON.stringify(toolResult, null, 2)}\n`
        } else if (toolCall.toolName === "browse" && toolInput) {
          const input = toolInput as z.infer<typeof browseInputSchema>
          const urlCount = input.url.length

          // Update ledger BEFORE checking exhaustion
          ledger.browse.used += urlCount
          ledger.browse.remaining -= urlCount
          plan.totalUsage.url += urlCount

          // Update current cursor node usage if set
          if (plan.executionCursor) {
            const cursorNode = findNode(plan.roots, plan.executionCursor)
            if (cursorNode) {
              cursorNode.usage.url += urlCount
            }
          }

          // Execute tool
          const toolResult = await browseTool.execute!(input, {
            toolCallId: toolCall.toolCallId,
            messages: [],
            abortSignal: undefined as unknown as AbortSignal,
          })

          trajectoryEntry.toolCalls.push({
            toolName: "browse",
            input,
          })

          lastToolResponse += `\n### Browse Results\n${JSON.stringify(toolResult, null, 2)}\n`
        }
      }
    } else {
      // No tool calls - if no answer was proposed, something went wrong
      // Give the model another chance or force an answer
      lastToolResponse = "[No tools were called. Please either use tools to gather information or submit your answer.]"
    }

    // Add entry to trajectory
    trajectory.push(trajectoryEntry)

    // 5. Periodic Compaction
    if (iterationsSinceLastCompaction >= K && !proposedAnswer) {
      const summarized = await summarizeTrajectory(verificationOutputs, trajectory)
      // Replace trajectory with a single summarized entry
      trajectory.length = 0
      trajectory.push({
        iteration: 0,
        thinking: `[Compacted trajectory summary]\n${summarized}`,
        toolCalls: [],
      })
      iterationsSinceLastCompaction = 0
    }

    // Check budget after tool execution
    if (budgetIsExhausted(ledger) && !proposedAnswer) {
      return { proposedAnswer: null, trajectory, budgetExhausted: true }
    }
  }

  return { proposedAnswer, trajectory, budgetExhausted: false }
}

// ============================================================================
// Helper Functions for Integration
// ============================================================================

export function getAllTrajectorySummaries(
  verificationOutputs: Record<`attempt_${number}`, VerificationOutput[]>,
): string[] {
  const summaries: string[] = []
  const attemptKeys = Object.keys(verificationOutputs).sort()

  for (const key of attemptKeys) {
    const outputs = verificationOutputs[key as `attempt_${number}`]
    if (outputs) {
      for (const output of outputs) {
        if (output.trajectory_summary) {
          summaries.push(output.trajectory_summary)
        }
      }
    }
  }

  return summaries
}

export function getMostRecentVerification(
  verificationOutputs: Record<`attempt_${number}`, VerificationOutput[]>,
  currentAttempt: number,
): MostRecentVerification | null {
  // Check current attempt first
  const currentOutputs = verificationOutputs[`attempt_${currentAttempt}`]
  if (currentOutputs && currentOutputs.length > 0) {
    const latest = currentOutputs[currentOutputs.length - 1]
    if (latest.details) {
      return {
        decision: latest.decision,
        guidance: `${latest.details.failure_analysis}\n\n${latest.details.useful_information}`,
        recommendations: latest.details.strategic_recommendations,
      }
    }
  }

  // Check previous attempts
  for (let i = currentAttempt - 1; i >= 1; i--) {
    const outputs = verificationOutputs[`attempt_${i}`]
    if (outputs && outputs.length > 0) {
      const latest = outputs[outputs.length - 1]
      if (latest.details) {
        return {
          decision: latest.decision,
          guidance: `${latest.details.failure_analysis}\n\n${latest.details.useful_information}`,
          recommendations: latest.details.strategic_recommendations,
        }
      }
    }
  }

  return null
}
