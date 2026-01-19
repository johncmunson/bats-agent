# Implementation Guide: BATS ReAct Subagent

## Overview

Implement `react-subagent.ts` to serve as the ReAct-style reasoning loop for the BATS (Budget-Aware Test-time Scaling) algorithm. This subagent handles the iterative think → plan → act cycle, managing budget-aware tool use, structured planning with deltas, and trajectory accumulation.

---

## Architecture Context

The BATS algorithm consists of three nested loops:

1. **Macro-Attempt Loop** (`macroAttemptLoop`): Runs until budget exhausted or verified answer(s) found
2. **Micro-Attempt Loop** (`microAttemptLoop`): Runs verification cycles; PIVOTs create new attempts
3. **ReAct Loop** (`reActLoop`): The iterative think/plan/tool cycle — **this is what you're implementing**

The ReAct subagent is called from within the micro-attempt loop and runs until either:

- A `proposedAnswer` is produced (exits to verification)
- Budget is exhausted (breaks to macro-attempt loop)

---

## Input/Output Contract

### Input

```ts
type ReActSubagentInput = {
  // Core
  question: string
  ledger: Ledger // Current budget state (mutable reference)
  plan: Plan // Current attempt's plan (mutable reference)

  // Tools (injected)
  tools: {
    search: SearchTool
    browse: BrowseTool
  }

  // Verification context
  allTrajectorySummaries: string[] // All trajectory_summary's from all verification outputs
  mostRecentVerification: {
    decision: Decision
    guidance: string // details.failure_analysis + details.useful_information
    recommendations: string // details.strategic_recommendations
  } | null

  // Configuration
  model: LanguageModel
  K: number // Compaction interval (default: 10)
}
```

### Output

```ts
type ReActSubagentOutput = {
  proposedAnswer: string | null // null if budget exhausted before answer
  trajectory: TrajectoryEntry[] // Full reasoning trace for verification
  budgetExhausted: boolean // true if we broke due to budget
}
```

---

## Core Data Types

### Trajectory Entry

The trajectory is a structured array. Each entry captures one iteration's reasoning and actions:

```ts
type TrajectoryEntry = {
  iteration: number
  thinking: string // LLM's reasoning/analysis
  toolCalls: {
    toolName: "search" | "browse"
    input: SearchInput | BrowseInput
  }[]
}
```

**Important**:

- Include thinking and tool calls + inputs
- Do NOT include tool results (they're ephemeral, only kept for the next iteration)
- Do NOT include plan deltas (they're policy, not state)

### Plan Delta Schema

Use a simple, LLM-friendly delta format. Each delta is an atomic operation:

```ts
type PlanDelta =
  | { op: "addNode"; parentId: NodeId | null; node: Omit<PlanNode, "children"> }
  | { op: "updateStatus"; nodeId: NodeId; status: NodeStatus }
  | { op: "appendNotes"; nodeId: NodeId; notes: string }
  | { op: "setCursor"; nodeId: NodeId | null }
```

The harness deterministically applies deltas to the plan after each iteration.

**Note**: The harness (not the LLM) is responsible for:

- Setting `plan.status = "abandoned"` on PIVOT decisions
- Initializing a fresh plan for new attempts
- Maintaining `plan.totalUsage` counters

---

## Tool Contracts

Tools must conform to the paper's interface (Section C.1) while being AI SDK compatible.

### Search Tool

```ts
const searchTool = tool({
  description:
    "Performs batched web searches. Each query string in the array consumes 1 unit of Query Budget.",
  inputSchema: z.object({
    query: z.array(z.string()).describe("Array of search query strings"),
  }),
  execute: async ({ query }) => {
    // Returns search results for each query
    // Budget accounting: ledger.search.used += query.length
  },
})
```

### Browse Tool

```ts
const browseTool = tool({
  description:
    "Visit webpage(s) and return content. Each URL consumes 1 unit of URL Budget. Content is truncated to 150k characters.",
  inputSchema: z.object({
    url: z.array(z.string()).describe("Array of URLs to visit"),
    goal: z.string().describe("The specific information goal for browsing"),
  }),
  execute: async ({ url, goal }) => {
    // Returns page content for each URL (truncated to 150k chars)
    // Budget accounting: ledger.browse.used += url.length
  },
})
```

**Critical**: When a tool is called with multiple queries/URLs, each counts separately against the budget. Update the ledger _before_ checking for exhaustion.

---

## Iteration Flow

Each iteration follows this sequence:

### 1. Budget Pre-check

```ts
if (budgetIsExhausted(ledger)) {
  return { proposedAnswer: null, trajectory, budgetExhausted: true }
}
```

### 2. Construct LLM Context

Inject into the LLM context (in order of appearance):

1. **System prompt** with budget regime guidance (HIGH/MEDIUM/LOW/CRITICAL thresholds)
2. **Original question**
3. **All prior trajectory summaries** from verification outputs
4. **Most recent verification guidance** (if any): failure_analysis, useful_information, strategic_recommendations, decision
5. **Accumulated trajectory** (thinking + tool calls from prior iterations in this micro-attempt)
6. **Full persistent plan tree** (all attempts with their steps, statuses, notes)
7. **Most recent tool response** (from previous iteration, if any)
8. **Budget status block**: current used/remaining for both search and browse

### 3. Tool-Enabled LLM Call

Make a single `generateText` call with tools enabled. The LLM should output:

**A. Thinking** (required)

- Analysis of the current state
- Reasoning about budget allocation strategy
- Justification for tool selection OR answer proposal
- Rationale for plan updates

**B. Plan Deltas** (required, even if empty)

- Structured array of `PlanDelta` operations
- Must include `setCursor` to indicate execution focus
- If proposing an answer, should mark relevant tasks as "done"

**C. Action** (exactly one of):

- **Tool call(s)**: Use search and/or browse tools
- **Proposed answer**: A `submitAnswer` tool or structured output field

### 4. Post-LLM Processing

After the LLM responds:

1. **Extract thinking** → append to trajectory
2. **Apply plan deltas** deterministically to the plan
3. **If tool calls made**:
   - Update ledger (each query/URL counts separately)
   - Execute tools
   - Store results for next iteration's context (discard after use)
   - Append tool calls + inputs to trajectory
   - Check budget exhaustion
4. **If answer proposed**:
   - Set `proposedAnswer` to break the ReAct loop

### 5. Periodic Compaction

```ts
if (iterationsSinceLastCompaction >= K) {
  trajectory = await summarizeTrajectory(verificationOutputs, trajectory)
  iterationsSinceLastCompaction = 0
}
```

---

## LLM Output Schema

Use structured output with the AI SDK's `Output.object()`:

```ts
const reActOutputSchema = z.object({
  thinking: z
    .string()
    .describe("Your reasoning process, budget analysis, and justification"),

  planDeltas: z
    .array(planDeltaSchema)
    .describe("Atomic operations to update the plan"),

  action: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("useTool"),
      // Tool calls handled natively by AI SDK
    }),
    z.object({
      type: z.literal("proposeAnswer"),
      answer: z.string().describe("The proposed answer to the question"),
    }),
  ]),
})
```

**Alternative**: Use a `submitAnswer` tool instead of the discriminated union. This may be more natural for the AI SDK's tool-calling flow:

```ts
const submitAnswerTool = tool({
  description:
    "Submit a proposed answer when you have gathered sufficient evidence",
  inputSchema: z.object({
    answer: z.string().describe("The proposed answer"),
    justification: z.string().describe("Brief justification for this answer"),
  }),
  execute: async ({ answer }) => answer, // Just returns the answer
})
```

**Recommendation**: Use the `submitAnswer` tool approach. It's more aligned with the paper's framing where "proposing an answer" is an action alongside tool use, and it works naturally with AI SDK's tool-calling patterns.

---

## System Prompt Template

```markdown
You are an AI reasoning agent solving information-seeking questions through iterative search and analysis.

## Budget Awareness

You have two independent budgets:

- **Query Budget** (search): Used {used}, Remaining {remaining}
- **URL Budget** (browse): Used {used}, Remaining {remaining}

Adapt your strategy based on budget regime:

- **HIGH (≥70%)**: Broad exploration, 3-5 diverse queries, 2-3 URLs per cycle
- **MEDIUM (30-70%)**: Focused refinement, 2-3 precise queries, 1-2 key URLs
- **LOW (10-30%)**: Verification only, 1 targeted query, 1 critical URL
- **CRITICAL (<10%)**: Final answer attempt, minimal tool use

## Planning

Maintain a tree-structured plan with:

- Status markers: [ ] pending, [x] done, [!] failed, [~] partial
- Resource tracking per step
- Never delete steps; update status instead

Output plan changes as structured deltas, not full rewrites.

## Your Task

1. **Think**: Analyze the current state, budget, and progress
2. **Update Plan**: Output deltas to refine your plan and set execution focus
3. **Act**: Either use tools (search/browse) OR submit your answer

If you have sufficient evidence, use the submitAnswer tool.
```

---

## Integration with bats-agent.ts

The ReAct subagent integrates into the existing structure:

```ts
// Inside microAttemptLoop, replace the reActLoop pseudocode:

const { proposedAnswer, trajectory, budgetExhausted } = await runReActSubagent({
  question,
  ledger,
  plan: plans[`attempt_${microAttemptNumber}`],
  tools: { search: searchTool, browse: browseTool },
  allTrajectorySummaries: getAllTrajectorySummaries(verificationOutputs),
  mostRecentVerification: getMostRecentVerification(
    verificationOutputs,
    microAttemptNumber,
  ),
  model,
  K,
})

if (budgetExhausted) break macroAttemptLoop
// Continue to verification with proposedAnswer and trajectory...
```

---

## Harness vs. LLM Responsibilities

| Responsibility                                  | Owner                          |
| ----------------------------------------------- | ------------------------------ |
| Budget accounting (incrementing used/remaining) | Harness (after tool execution) |
| Budget exhaustion detection                     | Harness                        |
| Plan status = "abandoned" on PIVOT              | Harness                        |
| Initialize fresh plan on new attempt            | Harness                        |
| Maintaining `plan.totalUsage`                   | Harness                        |
| Plan delta generation                           | LLM                            |
| Execution cursor (`setCursor`)                  | LLM                            |
| Task status updates (done/failed/partial)       | LLM                            |
| Tool selection and parameters                   | LLM                            |
| Thinking/reasoning                              | LLM                            |
| Answer proposal timing                          | LLM                            |

---

## File Structure

```
bats/
├── bats-agent.ts           # Main orchestrator (existing)
├── react-subagent.ts       # NEW: ReAct loop implementation
├── types.ts                # Type definitions (extend as needed)
├── verification-subagent.ts # Verification (existing)
└── summarize-trajectory.ts  # Trajectory compaction (existing, may need updates)
```

---

## Additional Notes

1. **Temperature**: Use 0.7 during agent execution (per paper)
2. **Context Management**: Only retain most recent tool results; inject fresh each iteration
3. **Trajectory Format**: Update `summarize-trajectory.ts` to accept `TrajectoryEntry[]` instead of `string`
4. **AI SDK Patterns**: Consider using `prepareStep` or `experimental_context` if implementing as an Agent class, but a manual loop with `generateText` is equally valid
5. **Error Handling**: Tool failures should update node status to "failed" and continue (don't crash)

---

## Implementation Approach

Recommended order:

1. Define new types in `types.ts` (TrajectoryEntry, PlanDelta, etc.)
2. Create tool definitions with proper budget accounting
3. Implement the core `runReActSubagent` function
4. Build the system prompt with budget injection
5. Implement plan delta application logic
6. Wire into `bats-agent.ts`
7. Update `summarize-trajectory.ts` for new trajectory format
