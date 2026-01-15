# BATSAgent Implementation Specification

## Vercel AI SDK Integration

This document specifies how to implement the BATS (Budget-Aware Test-time Scaling) algorithm as a `BATSAgent` class that conforms to the Vercel AI SDK `Agent` interface.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         BATSAgent                               │
│                   (implements Agent interface)                  │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   Budget    │  │   Planner   │  │       Verifier          │  │
│  │   Tracker   │  │             │  │  (control operator)     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                      Attempt Orchestrator                       │
│         (manages multi-attempt loop + answer selection)         │
├─────────────────────────────────────────────────────────────────┤
│                    generateText() / streamText()                │
│                      (Vercel AI SDK Core)                       │
└─────────────────────────────────────────────────────────────────┘
```

### Key Insight

The Vercel AI SDK's `ToolLoopAgent` handles single-loop execution with `stopWhen` conditions. BATS requires **multi-attempt orchestration** with verification gates. Therefore:

- `BATSAgent` implements the `Agent` interface directly
- Internally uses `generateText()` / `streamText()` for each reasoning step
- Manages attempts, budget, and verification at a higher abstraction level

---

## 2. Agent Interface Conformance

```ts
import type {
  Agent,
  AgentCallParameters,
  GenerateTextResult,
  StreamTextResult,
  ToolSet,
} from "ai"

export class BATSAgent<
  TOOLS extends ToolSet = BATSToolSet,
> implements Agent<BATSCallOptions, TOOLS, never> {
  readonly version = "agent-v1"
  readonly id: string | undefined
  readonly tools: TOOLS

  constructor(settings: BATSAgentSettings<TOOLS>) { /* ... */ }

  async generate(
    options: AgentCallParameters<BATSCallOptions>
  ): Promise<GenerateTextResult<TOOLS, never>> { /* ... */ }

  async stream(
    options: AgentCallParameters<BATSCallOptions>
  ): Promise<StreamTextResult<TOOLS, never>> { /* ... */ }
}
```

---

## 3. Type Definitions

### 3.1 Tool Types

```ts
export type ToolName = "search" | "browse"

export interface BATSToolSet extends ToolSet {
  search: SearchTool
  browse: BrowseTool
}
```

### 3.2 Budget Types

```ts
export interface BudgetConfig {
  /** Maximum search queries allowed */
  search: number
  /** Maximum browse (URL fetch) calls allowed */
  browse: number
}

export interface BudgetState {
  readonly used: Record<ToolName, number>
  readonly remaining: Record<ToolName, number>
  readonly total: Record<ToolName, number>
}

export type BudgetRegime = "HIGH" | "MEDIUM" | "LOW" | "CRITICAL"

// Regime thresholds (percentage of remaining budget)
// HIGH: >= 70%
// MEDIUM: 30% - 70%
// LOW: 10% - 30%
// CRITICAL: < 10%
```

### 3.3 Plan Types

```ts
export type PlanStepStatus = "pending" | "partial" | "done" | "failed"

export interface PlanStep {
  readonly id: string // e.g., "1", "1.2", "1.2.1"
  readonly description: string
  status: PlanStepStatus
  readonly parentId?: string
  resourceUsage: Partial<Record<ToolName, number>>
  /**
   * Append-only execution trace for this plan step.
   * Paper-faithful: the checklist is never overwritten; completed/failed/partial steps remain as history.
   */
  notesLog?: string[]
}

export interface ConstraintAnalysis {
  /** Broad constraints for candidate generation */
  exploration: string[]
  /** Narrow constraints for candidate validation */
  verification: string[]
}
```

### 3.4 Verification Types

```ts
export type VerificationDecision = "SUCCESS" | "CONTINUE" | "PIVOT"

export interface ConstraintCheck {
  /** Must exactly match one of the provided constraint strings (no paraphrasing). */
  constraint: string
  status: "satisfied" | "contradicted" | "unverifiable"
}

export interface TrajectorySummary {
  goal: string
  attemptedApproach: string
  keyFindings: string[]
  failureReason?: string
  reusableFacts?: string[]
  recommendations: string[]
}

export interface VerificationResult {
  decision: VerificationDecision
  checks: ConstraintCheck[]
  justification: string
  /** Required when decision !== SUCCESS */
  trajectorySummary?: TrajectorySummary
}
```

### 3.5 Agent Configuration

```ts
export type GlobalPolicy = "early-stop" | "budget-exhaustive"

export interface BATSAgentSettings<TOOLS extends ToolSet = BATSToolSet> {
  /** Language model to use */
  model: LanguageModel

  /**
   * Optional dedicated judge model for answer selection.
   * Paper setup uses a separate model for judging/selection (e.g., Gemini-2.5-Flash).
   * If omitted, fall back to `model`.
   */
  judgeModel?: LanguageModel

  /** Optional agent identifier */
  id?: string

  /** Tool implementations */
  tools: TOOLS

  /** Budget allocation per tool */
  budget: BudgetConfig

  /** Global termination policy */
  globalPolicy: GlobalPolicy

  /** System instructions for the reasoning agent */
  instructions?: string

  /** Model settings */
  temperature?: number
  maxOutputTokens?: number

  /** Browse tool content truncation limit (default: 150000 characters) */
  browseContentLimit?: number

  /** Iterations before periodic trajectory summarization (default: 10) */
  summarizationInterval?: number

  /** Callbacks */
  onAttemptStart?: (attemptNumber: number, budget: BudgetState) => void
  onAttemptEnd?: (attemptNumber: number, result: AttemptResult) => void
  onVerification?: (result: VerificationResult) => void
  onBudgetUpdate?: (budget: BudgetState) => void
}

export interface BATSCallOptions {
  /** Override global policy for this call */
  globalPolicy?: GlobalPolicy
  /** Override budget for this call */
  budget?: Partial<BudgetConfig>
}
```

---

## 4. Control Schema

The agent communicates intent through a structured control schema embedded in its responses. The orchestrator parses this to determine control flow.

### 4.1 Agent Output Schema

```ts
import { z } from "zod"

/**
 * Paper-faithful planning: the agent maintains a tree-structured checklist (Appendix C.2).
 *
 * Therefore we require explicit, structured plan deltas that the orchestrator can apply
 * deterministically (instead of heuristically parsing free-form text).
 */
export const PlanStepIdSchema = z.string().describe(
  'Tree-structured step id: "1", "1.2", "1.2.1", ...'
)

export const PlanDeltaSchema = z.object({
  /**
   * Add new nodes (branches/leads) to the checklist.
   * Paper-faithful: never delete steps; instead add new branches and mark old ones failed/partial.
   */
  addSteps: z.array(z.object({
    id: PlanStepIdSchema,
    parentId: PlanStepIdSchema.optional(),
    description: z.string(),
    status: z.enum(["pending", "partial", "done", "failed"]).default("pending"),
    noteAppend: z.string().optional(),
  })).optional(),

  /**
   * Update existing nodes.
   * Paper-faithful: append-only notes; status/resource usage may change, but steps are never removed.
   */
  updateSteps: z.array(z.object({
    id: PlanStepIdSchema,
    status: z.enum(["pending", "partial", "done", "failed"]).optional(),
    noteAppend: z.string().optional(),
  })).optional(),
}).optional()

export const AgentControlSchema = z.discriminatedUnion("type", [
  // Agent wants to execute tool calls
  z.object({
    type: z.literal("TOOL_CALLS"),
    reasoning: z.string(),
    /**
     * Paper-faithful attribution: the agent must indicate which plan step it is currently executing.
     * The orchestrator will attribute tool usage in this iteration to `activeStepId`.
     */
    activeStepId: PlanStepIdSchema.optional(),
    planDelta: PlanDeltaSchema,
  }),

  // Agent proposes a final answer for verification
  z.object({
    type: z.literal("PROPOSE_ANSWER"),
    answer: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
    reasoning: z.string(),
    planDelta: PlanDeltaSchema,
  }),

  // Agent requests more thinking without tool calls
  z.object({
    type: z.literal("THINK_ONLY"),
    reasoning: z.string(),
    planDelta: PlanDeltaSchema,
  }),
])

export type AgentControl = z.infer<typeof AgentControlSchema>
```

### 4.2 Detection Logic

```ts
function parseAgentControl(response: string): AgentControl | null {
  // Look for JSON block in response
  const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/)
  if (!jsonMatch) return null

  try {
    const parsed = JSON.parse(jsonMatch[1])
    return AgentControlSchema.parse(parsed)
  } catch {
    return null
  }
}
```

---

## 5. Tool Interfaces

### 5.1 Search Tool (Google Custom Search JSON API)

```ts
import { tool } from "ai"
import { z } from "zod"

export const searchInputSchema = z.object({
  queries: z.array(z.string()).min(1).max(5).describe(
    "Array of search queries. Include multiple complementary queries in a single call. Budget: each string consumes 1 unit of search budget."
  ),
})

export interface SearchResult {
  title: string
  snippet: string
  url: string
  displayLink: string
}

export interface SearchToolOutput {
  results: Record<string, SearchResult[]> // query -> results
  queriesUsed: number
}

export const createSearchTool = (config: {
  apiKey: string
  searchEngineId: string
  resultsPerQuery?: number // default: 10
}) => tool({
  description: `Performs batched web searches. Supply an array of queries; returns top results for each.
  
Budget guidance:
- HIGH budget: Use 3-5 diverse queries per call
- MEDIUM budget: Use 2-3 precise queries per call  
- LOW budget: Use 1-2 focused queries per call
- CRITICAL budget: Use only 1 essential query`,

  inputSchema: searchInputSchema,

  execute: async ({ queries }, { experimental_context }) => {
    const ctx = experimental_context as BATSContext
    const snapshot = ctx.budgetTracker.getSnapshot()
    
    // Check budget before execution
    // Budget semantics: each string in `queries` consumes 1 unit of search budget.
    if (snapshot.remaining.search < queries.length) {
      throw new Error(
        `Insufficient search budget: need ${queries.length}, have ${snapshot.remaining.search}`
      )
    }

    const results: Record<string, SearchResult[]> = {}
    
    for (const query of queries) {
      const response = await fetch(
        `https://www.googleapis.com/customsearch/v1?` +
        `key=${config.apiKey}&cx=${config.searchEngineId}&q=${encodeURIComponent(query)}&num=${config.resultsPerQuery ?? 10}`
      )
      
      const data = await response.json()
      results[query] = (data.items ?? []).map((item: any) => ({
        title: item.title,
        snippet: item.snippet,
        url: item.link,
        displayLink: item.displayLink,
      }))
      
      // Consume budget
      ctx.budgetTracker.consume("search", 1)
    }

    return {
      results,
      queriesUsed: queries.length,
    } satisfies SearchToolOutput
  },
})
```

### 5.2 Browse Tool Interface

```ts
export const browseInputSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(3).describe(
    "URLs to fetch and extract content from. Budget: each string consumes 1 unit of browse budget."
  ),
  goal: z.string().describe(
    "The specific information goal for browsing these pages"
  ),
})

export interface BrowseResult {
  url: string
  title?: string
  content: string
  contentTruncated: boolean
  error?: string
}

export interface BrowseToolOutput {
  results: BrowseResult[]
  urlsUsed: number
}
```

### 5.3 Browse Tool: Jina.ai Implementation

```ts
export const createJinaBrowseTool = (config: {
  apiKey?: string
  contentLimit?: number // default: 150000
}) => tool({
  description: `Fetches and extracts content from webpages using Jina.ai Reader.

Budget guidance:
- HIGH budget: Browse up to 3 high-value URLs
- MEDIUM budget: Browse 1-2 URLs that close key knowledge gaps
- LOW budget: Browse at most 1 most promising URL
- CRITICAL budget: Avoid browsing unless absolutely essential`,

  inputSchema: browseInputSchema,

  execute: async ({ urls, goal }, { experimental_context }) => {
    const ctx = experimental_context as BATSContext
    const contentLimit = config.contentLimit ?? 150000
    const snapshot = ctx.budgetTracker.getSnapshot()

    // Check budget before execution
    // Budget semantics: each string in `urls` consumes 1 unit of browse budget.
    if (snapshot.remaining.browse < urls.length) {
      throw new Error(
        `Insufficient browse budget: need ${urls.length}, have ${snapshot.remaining.browse}`
      )
    }

    const results: BrowseResult[] = []

    for (const url of urls) {
      try {
        const response = await fetch(`https://r.jina.ai/${url}`, {
          headers: config.apiKey 
            ? { Authorization: `Bearer ${config.apiKey}` }
            : {},
        })

        if (!response.ok) {
          results.push({
            url,
            content: "",
            contentTruncated: false,
            error: `HTTP ${response.status}: ${response.statusText}`,
          })
          continue
        }

        let content = await response.text()
        const originalLength = content.length
        
        // TRUNCATION: Mechanical cutoff, not semantic
        if (content.length > contentLimit) {
          content = content.slice(0, contentLimit)
        }

        results.push({
          url,
          content,
          contentTruncated: originalLength > contentLimit,
        })

        // Consume budget
        ctx.budgetTracker.consume("browse", 1)
      } catch (error) {
        results.push({
          url,
          content: "",
          contentTruncated: false,
          error: error instanceof Error ? error.message : "Unknown error",
        })
      }
    }

    return {
      results,
      urlsUsed: urls.length,
    } satisfies BrowseToolOutput
  },
})
```

### 5.4 Browse Tool: Crawl4AI Implementation

```ts
export const createCrawl4AIBrowseTool = (config: {
  baseUrl: string // Crawl4AI server URL
  contentLimit?: number // default: 150000
}) => tool({
  description: `Fetches and extracts content from webpages using Crawl4AI.

Budget guidance:
- HIGH budget: Browse up to 3 high-value URLs
- MEDIUM budget: Browse 1-2 URLs that close key knowledge gaps
- LOW budget: Browse at most 1 most promising URL
- CRITICAL budget: Avoid browsing unless absolutely essential`,

  inputSchema: browseInputSchema,

  execute: async ({ urls, goal }, { experimental_context }) => {
    const ctx = experimental_context as BATSContext
    const contentLimit = config.contentLimit ?? 150000
    const snapshot = ctx.budgetTracker.getSnapshot()

    // Check budget before execution
    // Budget semantics: each string in `urls` consumes 1 unit of browse budget.
    if (snapshot.remaining.browse < urls.length) {
      throw new Error(
        `Insufficient browse budget: need ${urls.length}, have ${snapshot.remaining.browse}`
      )
    }

    const results: BrowseResult[] = []

    for (const url of urls) {
      try {
        const response = await fetch(`${config.baseUrl}/crawl`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            urls: [url],
            word_count_threshold: 10,
            extraction_strategy: "markdown",
          }),
        })

        if (!response.ok) {
          results.push({
            url,
            content: "",
            contentTruncated: false,
            error: `HTTP ${response.status}: ${response.statusText}`,
          })
          continue
        }

        const data = await response.json()
        let content = data.results?.[0]?.markdown ?? ""
        const originalLength = content.length

        // TRUNCATION: Mechanical cutoff, not semantic
        if (content.length > contentLimit) {
          content = content.slice(0, contentLimit)
        }

        results.push({
          url,
          title: data.results?.[0]?.title,
          content,
          contentTruncated: originalLength > contentLimit,
        })

        // Consume budget
        ctx.budgetTracker.consume("browse", 1)
      } catch (error) {
        results.push({
          url,
          content: "",
          contentTruncated: false,
          error: error instanceof Error ? error.message : "Unknown error",
        })
      }
    }

    return {
      results,
      urlsUsed: urls.length,
    } satisfies BrowseToolOutput
  },
})
```

---

## 6. Core Components

### 6.1 BudgetTracker

```ts
export class BudgetTracker {
  private _used: Record<ToolName, number>
  private _total: Record<ToolName, number>

  constructor(budget: BudgetConfig) {
    this._total = { ...budget }
    this._used = { search: 0, browse: 0 }
  }

  /** Current authoritative budget state */
  getSnapshot(): BudgetState {
    return {
      used: { ...this._used },
      remaining: {
        search: this._total.search - this._used.search,
        browse: this._total.browse - this._used.browse,
      },
      total: { ...this._total },
    }
  }

  /** Advisory regime derived from remaining / total */
  getRegime(): BudgetRegime {
    const snapshot = this.getSnapshot()
    const minRatio = Math.min(
      snapshot.remaining.search / snapshot.total.search,
      snapshot.remaining.browse / snapshot.total.browse
    )

    if (minRatio >= 0.7) return "HIGH"
    if (minRatio >= 0.3) return "MEDIUM"
    if (minRatio >= 0.1) return "LOW"
    return "CRITICAL"
  }

  /**
   * Record a tool invocation.
   * Throws if remaining budget would go negative.
   */
  consume(tool: ToolName, units: number = 1): void {
    const remaining = this._total[tool] - this._used[tool]
    if (remaining < units) {
      throw new BudgetExhaustedError(tool, units, remaining)
    }
    this._used[tool] += units
  }

  /** True iff at least the required units remain for specified tools */
  hasRemaining(required?: Partial<Record<ToolName, number>>): boolean {
    const snapshot = this.getSnapshot()
    if (!required) {
      // Paper-faithful default: terminate once ANY budgeted resource is exhausted.
      // Therefore we can only keep running while ALL tool budgets still have > 0 remaining.
      return snapshot.remaining.search > 0 && snapshot.remaining.browse > 0
    }
    for (const [tool, units] of Object.entries(required)) {
      if ((snapshot.remaining[tool as ToolName] ?? 0) < units) {
        return false
      }
    }
    return true
  }

  /** True iff at least one budgeted tool is exhausted. */
  isAnyExhausted(): boolean {
    const snapshot = this.getSnapshot()
    return snapshot.remaining.search <= 0 || snapshot.remaining.browse <= 0
  }

  /** OR-style helper for callers that explicitly want "any budget remains" semantics. */
  hasAnyRemaining(): boolean {
    const snapshot = this.getSnapshot()
    return snapshot.remaining.search > 0 || snapshot.remaining.browse > 0
  }

  /** Format budget state for injection into prompts */
  formatForPrompt(): string {
    const snapshot = this.getSnapshot()
    const regime = this.getRegime()
    return `<budget regime="${regime}">
Search: ${snapshot.used.search}/${snapshot.total.search} used, ${snapshot.remaining.search} remaining
Browse: ${snapshot.used.browse}/${snapshot.total.browse} used, ${snapshot.remaining.browse} remaining
</budget>`
  }
}

export class BudgetExhaustedError extends Error {
  constructor(
    public readonly tool: ToolName,
    public readonly requested: number,
    public readonly available: number
  ) {
    super(
      `Budget exhausted for ${tool}: requested ${requested}, available ${available}`
    )
    this.name = "BudgetExhaustedError"
  }
}
```

### 6.2 Planner

```ts
export class Planner {
  private steps: Map<string, PlanStep> = new Map()
  private constraints: ConstraintAnalysis | null = null

  /** Initialize a new plan for a fresh attempt */
  initialize(question: string, constraints: ConstraintAnalysis): void {
    this.steps.clear()
    this.constraints = constraints

    // Create initial exploration steps from constraints
    constraints.exploration.forEach((constraint, i) => {
      this.addStep({
        id: `${i + 1}`,
        description: `Explore: ${constraint}`,
        status: "pending",
        resourceUsage: {},
        notesLog: [],
      })
    })
  }

  /** Read-only view of all plan steps */
  getPlan(): ReadonlyArray<PlanStep> {
    return Array.from(this.steps.values())
  }

  /** Get constraints analysis */
  getConstraints(): ConstraintAnalysis | null {
    return this.constraints
  }

  /** Update plan state after tool execution or reasoning */
  update(
    stepId: string,
    update: {
      status?: PlanStepStatus
      resourceUsageDelta?: Partial<Record<ToolName, number>>
      /** Append-only note line. */
      noteAppend?: string
    }
  ): void {
    const step = this.steps.get(stepId)
    if (!step) {
      throw new Error(`Step ${stepId} not found`)
    }

    if (update.status) {
      step.status = update.status
    }
    if (update.resourceUsageDelta) {
      for (const [tool, delta] of Object.entries(update.resourceUsageDelta)) {
        step.resourceUsage[tool as ToolName] =
          (step.resourceUsage[tool as ToolName] ?? 0) + delta
      }
    }
    if (update.noteAppend) {
      step.notesLog ??= []
      step.notesLog.push(update.noteAppend)
    }
  }

  /** Add new branches or steps. Steps are never removed. */
  addStep(step: PlanStep): void {
    if (this.steps.has(step.id)) {
      throw new Error(`Step ${step.id} already exists`)
    }
    // Paper-faithful checklist invariants:
    // - Tree-structured IDs: "1", "1.2", "1.2.1", ...
    // - If a step has a dot, its parent must exist (unless explicitly provided via parentId and added earlier).
    // - Steps are append-only: never removed, never edited (except status/resourceUsage/notesLog append).
    if (step.id.includes(".") && !step.parentId) {
      const parentId = step.id.split(".").slice(0, -1).join(".")
      if (!this.steps.has(parentId)) {
        throw new Error(`Parent step ${parentId} must exist before adding child ${step.id}`)
      }
    }
    this.steps.set(step.id, { ...step })
  }

  /** Format plan for injection into prompts */
  formatForPrompt(): string {
    const lines: string[] = ["<plan>"]

    // Paper-faithful: render as a tree-structured checklist (not a flat list).
    // Indentation is derived from hierarchical id depth ("1.2.1" => depth 3).
    const stepsSorted = Array.from(this.steps.values()).sort((a, b) =>
      a.id.localeCompare(b.id, undefined, { numeric: true })
    )

    for (const step of stepsSorted) {
      const statusIcon = {
        pending: "[ ]",
        partial: "[~]",
        done: "[x]",
        failed: "[!]",
      }[step.status]
      
      const usage = Object.entries(step.resourceUsage)
        .filter(([_, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")

      const depth = step.id.split(".").length
      const indent = "  ".repeat(Math.max(0, depth - 1))
      const notesSuffix = (step.notesLog?.length ?? 0) > 0
        ? ` — ${step.notesLog!.at(-1)}`
        : ""

      lines.push(
        `${indent}${statusIcon} ${step.id}: ${step.description}` +
        (usage ? ` (${usage})` : "") +
        notesSuffix
      )
    }
    
    lines.push("</plan>")
    return lines.join("\n")
  }

  /**
   * Paper-faithful note on cross-attempt learning:
   *
   * BATS preserves lessons via verifier-produced trajectory summaries that are
   * injected into later prompts. Do NOT heuristically mutate plan steps from
   * free-form summary text (it is brittle and can silently corrupt the plan).
   *
   * If you want deterministic plan carry-over, extend the verifier schema to
   * emit explicit plan step deltas (id/status/notes) and apply them here.
   * Otherwise, keep cross-attempt learning prompt-only via `previousSummaries`.
   */
}
```

### 6.3 Verifier

```ts
import { generateObject } from "ai"

export const VerificationResultSchema = z.object({
  checks: z.array(z.object({
    constraint: z.string(),
    status: z.enum(["satisfied", "contradicted", "unverifiable"]),
  })).describe(
    "One check per provided constraint (exploration + verification), exactly once; checks[].constraint must be a verbatim copy of the provided constraint string."
  ),
  decision: z.enum(["SUCCESS", "CONTINUE", "PIVOT"]),
  justification: z.string().describe("Explanation for the decision"),
  trajectorySummary: z.object({
    goal: z.string(),
    attemptedApproach: z.string(),
    keyFindings: z.array(z.string()),
    failureReason: z.string().optional(),
    reusableFacts: z.array(z.string()).optional(),
    recommendations: z.array(z.string()),
  }).optional(),
})

export class Verifier {
  constructor(
    private model: LanguageModel,
    private temperature: number = 0
  ) {}

  /**
   * Perform verification.
   * Verification is deterministic (temperature 0).
   */
  async verify(input: {
    mode?: "answer_verification" | "periodic_summary"
    question: string
    constraints: ConstraintAnalysis
    proposedAnswer: string
    trajectory: string
    budget: BudgetState
  }): Promise<VerificationResult> {
    const mode = input.mode ?? "answer_verification"
    const { object } = await generateObject({
      model: this.model,
      schema: VerificationResultSchema,
      temperature: this.temperature,
      system: VERIFIER_SYSTEM_PROMPT,
      prompt: this.formatVerificationPrompt(input),
    })

    // Enforce hard rules
    const result = this.enforceDecisionRules(object, {
      mode,
      budget: input.budget,
      constraints: input.constraints,
    })
    
    return {
      decision: result.decision,
      checks: result.checks,
      justification: result.justification,
      trajectorySummary: result.trajectorySummary,
    }
  }

  private enforceDecisionRules(
    result: z.infer<typeof VerificationResultSchema>,
    input: {
      mode: "answer_verification" | "periodic_summary"
      budget: BudgetState
      constraints: ConstraintAnalysis
    }
  ): z.infer<typeof VerificationResultSchema> {
    const { budget, mode, constraints } = input

    // Enforce: checks cover all constraints exactly once
    const allConstraints = [
      ...constraints.exploration,
      ...constraints.verification,
    ]
    const seen = new Set<string>()
    for (const c of result.checks) {
      if (seen.has(c.constraint)) {
        throw new Error(`Verifier must not repeat constraint in checks[]: ${c.constraint}`)
      }
      seen.add(c.constraint)
    }
    if (seen.size !== allConstraints.length) {
      throw new Error("Verifier checks[] must cover all provided constraints exactly once")
    }
    for (const c of allConstraints) {
      if (!seen.has(c)) {
        throw new Error(`Verifier missing constraint in checks[]: ${c}`)
      }
    }

    // Periodic summarization mode: summarization-only. Always CONTINUE.
    if (mode === "periodic_summary") {
      if (!result.trajectorySummary) {
        throw new Error("Verifier must provide trajectorySummary for periodic_summary")
      }
      return {
        ...result,
        decision: "CONTINUE",
        justification: `${result.justification} [Coerced CONTINUE: periodic summarization mode is summarization-only]`,
      }
    }

    // Paper-faithful termination semantics:
    // The full BATS loop terminates once ANY tool budget is exhausted.
    // If the verifier returns CONTINUE but execution can no longer proceed, coerce to PIVOT
    // (the orchestrator will terminate immediately due to budget exhaustion).
    const isAnyExhausted =
      budget.remaining.search <= 0 || budget.remaining.browse <= 0
    if (isAnyExhausted && result.decision === "CONTINUE") {
      return {
        ...result,
        decision: "PIVOT",
        justification:
          `${result.justification} ` +
          `[Coerced PIVOT: budget exhausted; execution must terminate under paper semantics]`,
      }
    }

    // trajectorySummary required for non-SUCCESS
    if (result.decision !== "SUCCESS" && !result.trajectorySummary) {
      throw new Error("Verifier must provide trajectorySummary for CONTINUE/PIVOT")
    }

    return result
  }

  private formatVerificationPrompt(input: {
    mode?: "answer_verification" | "periodic_summary"
    question: string
    constraints: ConstraintAnalysis
    proposedAnswer: string
    trajectory: string
    budget: BudgetState
  }): string {
    const mode = input.mode ?? "answer_verification"
    return `## Question
${input.question}

## Constraints
Exploration: ${input.constraints.exploration.join(", ")}
Verification: ${input.constraints.verification.join(", ")}

## Proposed Answer
${mode === "periodic_summary" ? "(omitted for periodic summarization)" : input.proposedAnswer}

## Trajectory
${input.trajectory}

## Budget Status
Search: ${input.budget.remaining.search}/${input.budget.total.search} remaining
Browse: ${input.budget.remaining.browse}/${input.budget.total.browse} remaining

## Task
You must return JSON matching the schema, including:
- checks[]: exactly one entry per constraint (exploration + verification), status ∈ satisfied|contradicted|unverifiable
- checks[].constraint MUST be a verbatim copy of the provided constraint string (no paraphrasing)
- decision:
  - SUCCESS iff all checks are satisfied AND mode === answer_verification
  - Otherwise CONTINUE or PIVOT based on contradictions and remaining budget viability
- trajectorySummary required iff decision != SUCCESS

Mode:
- answer_verification (default): verify the proposed answer against constraints.
- periodic_summary: do NOT judge SUCCESS; set decision to CONTINUE and produce a trajectorySummary to replace old trajectory context.`
  }
}

const VERIFIER_SYSTEM_PROMPT = `You are an AI Strategic Verifier. Your goal is to evaluate a proposed answer, assess the viability of the current problem-solving approach, and decide the best course of action.

## Your Task: A 3-Step Process

### Step 1: Conduct Verification Analysis
Go through each constraint from the original question one by one.
For each constraint, state your finding: satisfied, contradicted, or unverifiable.
Return these findings as structured `checks[]` (one entry per constraint), with status ∈ satisfied|contradicted|unverifiable.

IMPORTANT:
- `checks[]` must include every provided constraint exactly once (no omissions, no extras).
- `checks[].constraint` must copy the constraint string verbatim (no paraphrasing).

### Step 2: Make a Strategic Decision
Based on verification and budget, choose one:

1. SUCCESS: All constraints are satisfied. Task is complete.

2. CONTINUE: Verification failed because some constraints are unverifiable, but:
   - The trajectory is generally sound and failures are correctable
   - Sufficient budget remains to attempt correction
   
3. PIVOT: Verification failed due to:
   - Fundamental flaw in the approach that cannot be easily fixed
   - Repeated unsuccessful attempts to find certain information
   - Insufficient budget for meaningful correction

### Step 3: Summarize for Next Step
If decision is CONTINUE or PIVOT, provide:
- Trajectory summary: provide a structured `trajectorySummary` object with:
  - goal
  - attemptedApproach
  - keyFindings
  - failureReason (optional)
  - reusableFacts (optional)
  - recommendations
- Failure analysis: root cause and failure pattern
- Useful information: intermediate findings to preserve
- Strategic recommendations: actionable advice for next attempt`
```

---

## 7. Context Management

### 7.1 Two Distinct Mechanisms

BATS uses two independent context-control mechanisms:

| Aspect         | Tool Truncation         | Trajectory Summarization       |
| -------------- | ----------------------- | ------------------------------ |
| Operates on    | Webpage content         | Agent reasoning history        |
| When           | Immediately after fetch | On CONTINUE / PIVOT / periodic |
| Who            | Tool adapter            | Verifier                       |
| Type           | Mechanical cutoff       | Semantic, structured           |
| Purpose        | Hard context bounds     | Control flow + learning        |

### 7.2 Tool Truncation

Implemented in browse tools (see Section 5.3, 5.4):

```ts
// TRUNCATION: Mechanical cutoff, not semantic
if (content.length > contentLimit) {
  content = content.slice(0, contentLimit)
}
```

- Default limit: 150,000 characters
- Applied immediately after fetch, before LLM sees content
- No semantic judgment involved
- Information may be lost irreversibly (acceptable for external evidence)

### 7.3 Trajectory Summarization

Triggered in three cases:

1. **Verification returns CONTINUE** — Attempt is promising but incomplete
2. **Verification returns PIVOT** — Attempt is terminated, lessons preserved
3. **Periodic safeguard** — After K iterations (default: 10)

```ts
type LatestToolResult =
  | { toolName: ToolName; output: unknown; at: number }
  | null

interface AttemptState {
  /**
   * Either a full trajectory (many steps) OR a single verifier-produced summary entry.
   * This is a destructive replacement, not an append.
   */
  trajectory: string[]

  /** At most one tool output payload: the most recent tool result. */
  latestToolResult: LatestToolResult

  /** Iteration counter for periodic summarization */
  iterationsSinceLastSummary: number
}

function shouldSummarize(
  state: AttemptState,
  verificationResult: VerificationResult | null,
  summarizationInterval: number
): boolean {
  // Verification-triggered summarization
  if (verificationResult?.decision === "CONTINUE") return true
  if (verificationResult?.decision === "PIVOT") return true
  
  // Periodic safeguard
  if (state.iterationsSinceLastSummary >= summarizationInterval) return true
  
  return false
}
```

When summarization occurs:
- **Entire raw trajectory is replaced** with structured summary
- This is a **destructive replacement**, not an append
- Verifier produces the summary (it has constraint context)

### 7.4 Tool-output eviction (paper-faithful invariant)

In addition to truncation and trajectory summarization, BATS enforces a strict tool-output eviction rule to control context growth (paper Appendix A.2).

At any time, the attempt prompt context must include:
- Plan (checklist + status)
- Trajectory (reasoning + plan updates + tool-call args only)
- Verifier summaries (when generated)
- At most one tool output payload: the most recent tool result

It must NOT include:
- Tool outputs from earlier steps
- Accumulated browse page content in `trajectory[]`

Implementation pattern (used in Section 9.1):
- Store tool results out-of-band as `latestToolResult`
- Inject `latestToolResult` as a single `role: "tool"` message (optional)

---

## 8. BATSContext (Shared State)

```ts
export interface BATSContext {
  /** Budget tracker instance */
  budgetTracker: BudgetTracker
  
  /** Current attempt number (1-indexed) */
  attemptNumber: number
  
  /** Planner instance */
  planner: Planner
  
  /** Previous trajectory summaries (for cross-attempt learning) */
  previousSummaries: TrajectorySummary[]
}
```

Passed to tools via `experimental_context`:

```ts
const result = await generateText({
  model: this.model,
  tools: this.tools,
  experimental_context: {
    budgetTracker: this.budgetTracker,
    attemptNumber: this.currentAttempt,
    planner: this.planner,
    previousSummaries: this.summaries,
  } satisfies BATSContext,
  // ...
})
```

---

## 9. Attempt Execution Loop

### 9.1 Single Attempt Logic

```ts
interface AttemptResult {
  status: "SUCCESS" | "PIVOT" | "BUDGET_EXHAUSTED"
  answer?: string
  verification?: VerificationResult
  summary?: TrajectorySummary
}

async function runAttempt(
  context: BATSContext,
  question: string,
  model: LanguageModel,
  tools: BATSToolSet,
  verifier: Verifier,
  settings: {
    summarizationInterval: number
    /** Non-paper safety guard to prevent infinite loops / runaway token cost */
    safetyMaxIterationsPerAttempt: number
    onBudgetUpdate?: (budget: BudgetState) => void
  }
): Promise<AttemptResult> {
  type LatestToolResult =
    | { toolName: ToolName; output: unknown }
    | null

  interface AttemptState {
    /** Reasoning + plan updates + tool-call args ONLY. Never include tool outputs. */
    trajectory: string[]
    /** The single most recent tool output payload (paper eviction invariant). */
    latestToolResult: LatestToolResult
    iterationsSinceLastSummary: number
  }

  function buildAttemptMessages(state: AttemptState) {
    return [
      ...state.trajectory.map(t => ({ role: "assistant", content: t })),
      ...(state.latestToolResult
        ? [
            // Paper-faithful eviction invariant: include ONLY the most recent tool output.
            // Keep the payload as close to the tool's native output as possible.
            { role: "tool", content: JSON.stringify(state.latestToolResult) },
          ]
        : []),
    ]
  }

  function formatStepWithoutToolOutputs(step: GenerateTextResult): string {
    // NOTE: This must not include tool outputs (toolResults).
    // It should contain: the agent's reasoning text + any plan updates + tool-call args.
    return step.text
  }

  function getLastToolResult(step: GenerateTextResult): { toolName: ToolName; result: unknown } | null {
    const last = step.toolResults?.at(-1)
    if (!last) return null
    return { toolName: last.toolName as ToolName, result: last.result }
  }

  function updateEvictedToolState(state: AttemptState, step: GenerateTextResult) {
    state.trajectory.push(formatStepWithoutToolOutputs(step))
    const lastToolResult = getLastToolResult(step)
    if (lastToolResult) {
      state.latestToolResult = {
        toolName: lastToolResult.toolName,
        output: lastToolResult.result,
      }
    }
  }

  function computeToolUsageDeltaFromStep(step: GenerateTextResult): Partial<Record<ToolName, number>> {
    // Paper-faithful logging: "Log resource usage after execution: (Query=#, URL=#)".
    // IMPORTANT: budget semantics are per-STRING (not per tool invocation):
    // - search: each string in `queries` consumes 1 unit (SearchToolOutput.queriesUsed)
    // - browse: each string in `urls` consumes 1 unit (BrowseToolOutput.urlsUsed)
    const delta: Partial<Record<ToolName, number>> = {}
    for (const tr of step.toolResults ?? []) {
      const tool = tr.toolName as ToolName
      const result: any = tr.result

      if (tool === "search") {
        const used = typeof result?.queriesUsed === "number" ? result.queriesUsed : 1
        delta.search = (delta.search ?? 0) + used
        continue
      }

      if (tool === "browse") {
        const used = typeof result?.urlsUsed === "number" ? result.urlsUsed : 1
        delta.browse = (delta.browse ?? 0) + used
        continue
      }

      // Fallback: count one unit if a new tool is added without explicit "units used" metadata.
      delta[tool] = (delta[tool] ?? 0) + 1
    }
    return delta
  }

  function applyPlanDelta(planner: Planner, delta: AgentControl["planDelta"]): void {
    if (!delta) return

    for (const s of delta.addSteps ?? []) {
      planner.addStep({
        id: s.id,
        description: s.description,
        status: s.status ?? "pending",
        parentId: s.parentId,
        resourceUsage: {},
        notesLog: s.noteAppend ? [s.noteAppend] : [],
      })
    }

    for (const u of delta.updateSteps ?? []) {
      planner.update(u.id, {
        status: u.status,
        noteAppend: u.noteAppend,
      })
    }
  }

  const state: AttemptState = {
    trajectory: [],
    latestToolResult: null,
    iterationsSinceLastSummary: 0,
  }

  while (context.budgetTracker.hasRemaining()) {
    // Inject budget state into prompt
    const budgetPrompt = context.budgetTracker.formatForPrompt()
    const planPrompt = context.planner.formatForPrompt()
    
    // Generate next step
    const result = await generateText({
      model,
      tools,
      experimental_context: context,
      system: buildSystemPrompt(question, budgetPrompt, planPrompt, context.previousSummaries),
      messages: buildAttemptMessages(state),
      stopWhen: stepCountIs(1), // Single step at a time for control
    })

    // Update attempt state with tool-output eviction:
    // - trajectory: no tool outputs (reasoning + plan updates + tool-call args only)
    // - latestToolResult: overwrite with most recent tool result (if any)
    updateEvictedToolState(state, result)
    // Budget update event boundary (simple wiring): once per loop iteration
    settings.onBudgetUpdate?.(context.budgetTracker.getSnapshot())
    state.iterationsSinceLastSummary++

    // Parse agent control signal
    const control = parseAgentControl(result.text)

    // Paper-faithful: apply structured plan deltas every iteration.
    // This is what makes the checklist "maintained throughout execution".
    if (control?.planDelta) {
      applyPlanDelta(context.planner, control.planDelta)
    }

    // Paper-faithful: attribute tool usage in this iteration to the active plan step.
    // If tool usage happened but the agent did not specify activeStepId, treat it as a protocol error
    // (otherwise per-step resource accounting becomes unenforceable and the plan degrades into a flat narrative).
    const toolUsageDelta = computeToolUsageDeltaFromStep(result)
    const usedAnyTools = Object.values(toolUsageDelta).some(v => (v ?? 0) > 0)
    if (usedAnyTools) {
      const activeStepId =
        control?.type === "TOOL_CALLS" ? control.activeStepId : undefined
      if (!activeStepId) {
        throw new Error("Agent used tools but did not provide activeStepId in TOOL_CALLS control")
      }
      context.planner.update(activeStepId, { resourceUsageDelta: toolUsageDelta })
    }
    
    if (control?.type === "PROPOSE_ANSWER") {
      // Run verification
      const verification = await verifier.verify({
        mode: "answer_verification",
        question,
        constraints: context.planner.getConstraints()!,
        proposedAnswer: control.answer,
        trajectory: state.trajectory.join("\n\n"),
        budget: context.budgetTracker.getSnapshot(),
      })

      if (verification.decision === "SUCCESS") {
        return {
          status: "SUCCESS",
          answer: control.answer,
          verification,
        }
      }

      if (verification.decision === "PIVOT") {
        return {
          status: "PIVOT",
          summary: verification.trajectorySummary,
          verification,
        }
      }

      // CONTINUE: Replace trajectory with summary
      state.trajectory = [formatSummary(verification.trajectorySummary!)]
      state.latestToolResult = null
      state.iterationsSinceLastSummary = 0
      continue
    }

    // Periodic summarization safeguard
    // Paper-faithful: summaries are derived from verifier outputs.
    if (state.iterationsSinceLastSummary >= settings.summarizationInterval) {
      const periodic = await verifier.verify({
        mode: "periodic_summary",
        question,
        constraints: context.planner.getConstraints()!,
        proposedAnswer: "",
        trajectory: state.trajectory.join("\n\n"),
        budget: context.budgetTracker.getSnapshot(),
      })
      state.trajectory = [formatSummary(periodic.trajectorySummary!)]
      state.latestToolResult = null
      state.iterationsSinceLastSummary = 0
    }

    // Check iteration limit
    if (state.trajectory.length > settings.safetyMaxIterationsPerAttempt) {
      return { status: "BUDGET_EXHAUSTED" }
    }
  }

  return { status: "BUDGET_EXHAUSTED" }
}
```

### 9.2 Global Control Loop

```ts
async function runBATSLoop(
  question: string,
  settings: BATSAgentSettings,
  globalPolicy: GlobalPolicy
): Promise<string> {
  const budgetTracker = new BudgetTracker(settings.budget)
  const verifier = new Verifier(settings.model)
  const judgeModel = settings.judgeModel ?? settings.model
  
  const verifiedAnswers: Array<{
    answer: string
    verification: VerificationResult
  }> = []
  
  const summaries: TrajectorySummary[] = []
  let attemptNumber = 0

  // Initialize constraints from question
  const constraints = await analyzeConstraints(settings.model, question)

  while (budgetTracker.hasRemaining()) {
    attemptNumber++
    settings.onAttemptStart?.(attemptNumber, budgetTracker.getSnapshot())

    // Paper-faithful: each attempt maintains its own checklist plan.
    // Cross-attempt learning occurs via verifier summaries (previousSummaries) injected into the prompt.
    const planner = new Planner()
    planner.initialize(question, constraints)

    const context: BATSContext = {
      budgetTracker,
      attemptNumber,
      planner,
      previousSummaries: summaries,
    }

    const result = await runAttempt(
      context,
      question,
      settings.model,
      settings.tools,
      verifier,
      {
        summarizationInterval: settings.summarizationInterval ?? 10,
        safetyMaxIterationsPerAttempt: 100,
        onBudgetUpdate: settings.onBudgetUpdate,
      }
    )

    settings.onAttemptEnd?.(attemptNumber, result)

    if (result.status === "SUCCESS" && result.answer && result.verification) {
      verifiedAnswers.push({
        answer: result.answer,
        verification: result.verification,
      })

      // Global policy decision
      if (globalPolicy === "early-stop") {
        return result.answer
      }
      // budget-exhaustive: continue to find more candidates
    }

    if (result.summary) {
      summaries.push(result.summary)
      // Paper-faithful: cross-attempt learning occurs via `previousSummaries` injected
      // into the prompt, not by heuristic plan mutation.
    }

    if (result.status === "BUDGET_EXHAUSTED") {
      break
    }
  }

  // Tool budget exhausted (paper semantics: ANY tool budget hit 0): select best verified answer
  if (verifiedAnswers.length === 0) {
    throw new Error("No verified answer found within budget")
  }

  return selectBestAnswer(judgeModel, verifiedAnswers, question)
}
```

---

## 10. BATSAgent Implementation

```ts
import {
  generateText,
  streamText,
  type Agent,
  type AgentCallParameters,
  type GenerateTextResult,
  type StreamTextResult,
  type LanguageModel,
} from "ai"

export class BATSAgent<TOOLS extends BATSToolSet = BATSToolSet>
  implements Agent<BATSCallOptions, TOOLS, never>
{
  readonly version = "agent-v1"
  readonly id: string | undefined
  readonly tools: TOOLS

  private readonly settings: BATSAgentSettings<TOOLS>

  constructor(settings: BATSAgentSettings<TOOLS>) {
    this.settings = settings
    this.id = settings.id
    this.tools = settings.tools
  }

  async generate(
    options: AgentCallParameters<BATSCallOptions>
  ): Promise<GenerateTextResult<TOOLS, never>> {
    const question = this.extractQuestion(options)
    const globalPolicy = options.options?.globalPolicy ?? this.settings.globalPolicy
    const budget = { ...this.settings.budget, ...options.options?.budget }

    const finalAnswer = await runBATSLoop(question, {
      ...this.settings,
      budget,
    }, globalPolicy)

    // Return in GenerateTextResult format
    return {
      text: finalAnswer,
      toolCalls: [],
      toolResults: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      response: {
        id: crypto.randomUUID(),
        modelId: this.settings.model.modelId,
        timestamp: new Date(),
        messages: [],
      },
      steps: [],
      // ... other required fields
    } as GenerateTextResult<TOOLS, never>
  }

  async stream(
    options: AgentCallParameters<BATSCallOptions>
  ): Promise<StreamTextResult<TOOLS, never>> {
    // For streaming, we need to emit events during the BATS loop
    // This requires refactoring runBATSLoop to yield progress events
    
    const question = this.extractQuestion(options)
    const globalPolicy = options.options?.globalPolicy ?? this.settings.globalPolicy
    const budget = { ...this.settings.budget, ...options.options?.budget }

    // Create an async generator that yields progress
    const progressGenerator = runBATSLoopStreaming(question, {
      ...this.settings,
      budget,
    }, globalPolicy)

    // Wrap in StreamTextResult format
    return createStreamTextResult(progressGenerator)
  }

  private extractQuestion(options: AgentCallParameters<BATSCallOptions>): string {
    if (options.prompt) {
      return typeof options.prompt === "string"
        ? options.prompt
        : options.prompt.map(m => m.content).join("\n")
    }
    if (options.messages) {
      const lastUserMessage = options.messages
        .filter(m => m.role === "user")
        .pop()
      return typeof lastUserMessage?.content === "string"
        ? lastUserMessage.content
        : ""
    }
    throw new Error("No prompt or messages provided")
  }
}
```

---

## 11. Streaming Support

### 11.1 Progress Events

```ts
export type BATSProgressEvent =
  | { type: "attempt_start"; attemptNumber: number; budget: BudgetState }
  | { type: "thinking"; content: string }
  | { type: "tool_call"; toolName: ToolName; input: unknown }
  | { type: "tool_result"; toolName: ToolName; output: unknown }
  | { type: "answer_proposed"; answer: string }
  | { type: "verification_start" }
  | { type: "verification_result"; result: VerificationResult }
  | { type: "attempt_end"; result: AttemptResult }
  | { type: "budget_update"; budget: BudgetState }
  | { type: "final_answer"; answer: string }
  | { type: "error"; error: Error }
```

### 11.2 Streaming Loop

```ts
async function* runBATSLoopStreaming(
  question: string,
  settings: BATSAgentSettings,
  globalPolicy: GlobalPolicy
): AsyncGenerator<BATSProgressEvent> {
  // Similar to runBATSLoop but yields events at each step
  
  const budgetTracker = new BudgetTracker(settings.budget)
  // ... setup ...

  while (budgetTracker.hasRemaining()) {
    attemptNumber++
    yield { type: "attempt_start", attemptNumber, budget: budgetTracker.getSnapshot() }

    // Use streamText instead of generateText for streaming within attempts.
    // IMPORTANT: Tool-output eviction invariant still applies (Section 7.4):
    // - Emit all tool_result events to the caller for observability
    // - But only retain the MOST RECENT tool result in the next-step prompt context
    //   (i.e., update AttemptState.latestToolResult on each tool-result and drop older outputs)
    const stream = streamText({
      model: settings.model,
      tools: settings.tools,
      // ...
    })

    for await (const chunk of stream.fullStream) {
      if (chunk.type === "text-delta") {
        yield { type: "thinking", content: chunk.textDelta }
      }
      if (chunk.type === "tool-call") {
        yield { type: "tool_call", toolName: chunk.toolName as ToolName, input: chunk.args }
      }
      if (chunk.type === "tool-result") {
        yield { type: "tool_result", toolName: chunk.toolName as ToolName, output: chunk.result }
        // Internal state update (evicted tool context):
        // state.latestToolResult = { toolName: chunk.toolName as ToolName, output: chunk.result, at: Date.now() }
      }
    }

    // ... verification and attempt logic with yields ...
    
    yield { type: "budget_update", budget: budgetTracker.getSnapshot() }
  }

  yield { type: "final_answer", answer: selectedAnswer }
}
```

---

## 12. System Prompts

### 12.1 Main Reasoning Prompt

```ts
const BATS_SYSTEM_PROMPT = `You are a research agent using the BATS (Budget-Aware Test-time Scaling) framework.

## Core Principles

1. **Budget Awareness**: You have limited tool calls. Adapt your strategy to the current budget regime.
2. **Exploration vs Verification**: Start with broad exploration queries, then verify with specific checks.
3. **Plan Persistence**: Never delete plan steps. Mark them as done, failed, or partial.
4. **Propose Answers Explicitly**: When you have a candidate answer, use the PROPOSE_ANSWER control.

## Budget Regimes

- HIGH (≥70% remaining): Broad exploration, multiple queries, parallel investigations
- MEDIUM (30-70%): Focused queries, prioritize promising leads
- LOW (10-30%): Minimal queries, verify critical facts only
- CRITICAL (<10%): Avoid new queries, synthesize from gathered information

## Control Schema

End each response with a JSON control block:

\`\`\`json
{
  "type": "TOOL_CALLS" | "PROPOSE_ANSWER" | "THINK_ONLY",
  "reasoning": "Your reasoning for this action",
  // For TOOL_CALLS:
  "activeStepId": "1.2.1",
  // Optional but strongly encouraged in ALL response types:
  "planDelta": {
    "addSteps": [
      {
        "id": "1.2",
        "parentId": "1",
        "description": "New branch / candidate lead ...",
        "status": "pending",
        "noteAppend": "Why this branch was created"
      }
    ],
    "updateSteps": [
      {
        "id": "1",
        "status": "partial",
        "noteAppend": "What changed this iteration"
      }
    ]
  },
  // For PROPOSE_ANSWER:
  "answer": "Your proposed answer",
  "confidence": "high" | "medium" | "low"
}
\`\`\`

## Planning

Questions contain two types of constraints:
- **Exploration**: Broad, core requirements for finding candidates
- **Verification**: Narrow, specific details for confirming candidates

Always start with exploration, then verify.

Maintain an explicit tree-structured checklist plan throughout execution (paper Appendix C.2):
- Use step ids like "1", "1.2", "1.2.1" to represent branches / alternative leads.
- Mark each step status: pending [ ], partial [~], done [x], failed [!].
- Log per-step resource usage after execution: (search=#, browse=#).
- Never delete or overwrite steps; preserve the trace by adding new branches and marking old ones failed/partial.
- If you use any tools in an iteration, you MUST set "activeStepId" so the orchestrator can attribute tool usage to the checklist step.

## Previous Attempts

Learn from previous attempt summaries. Do not repeat failed approaches.
Use reusable facts from prior attempts to avoid redundant queries.`
```

### 12.2 Constraint Analysis Prompt

```ts
const CONSTRAINT_ANALYSIS_PROMPT = `Analyze this question and extract constraints.

Classify each constraint as:
- EXPLORATION: Broad constraints that help find candidate answers (e.g., "person who", "event in", "company that")
- VERIFICATION: Narrow constraints that validate specific properties (e.g., "born in 1985", "located in Texas", "has exactly 3")

Return as JSON:
{
  "exploration": ["constraint 1", "constraint 2"],
  "verification": ["constraint 3", "constraint 4"]
}`
```

---

## 13. Answer Selection

```ts
async function selectBestAnswer(
  judgeModel: LanguageModel,
  candidates: Array<{ answer: string; verification: VerificationResult }>,
  question: string
): Promise<string> {
  if (candidates.length === 1) {
    return candidates[0].answer
  }

  // Paper-faithful: use an LLM-as-a-judge to select the BEST verified answer
  // among candidates (best-of), not majority vote aggregation.
  const { object } = await generateObject({
    model: judgeModel,
    schema: z.object({
      selectedIndex: z.number(),
      reasoning: z.string(),
    }),
    temperature: 0,
    prompt: `## Question
${question}

## Candidate Answers
${candidates.map((c, i) => `${i + 1}. ${c.answer} (verification: ${c.verification.justification})`).join("\n")}

## Task
Select the single best answer (most likely factually correct and most specific to the question).
Do NOT perform majority vote. Do NOT select based on writing quality.`,
  })

  const idx = Math.max(0, Math.min(candidates.length - 1, Math.floor(object.selectedIndex)))
  return candidates[idx].answer
}
```

---

## 14. Error Handling

```ts
export class BATSError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = "BATSError"
  }
}

export class BudgetExhaustedError extends BATSError {
  constructor(tool: ToolName, requested: number, available: number) {
    super(
      `Budget exhausted for ${tool}: requested ${requested}, available ${available}`,
      "BUDGET_EXHAUSTED"
    )
  }
}

export class NoVerifiedAnswerError extends BATSError {
  constructor(attempts: number) {
    super(
      `No verified answer found after ${attempts} attempts`,
      "NO_VERIFIED_ANSWER"
    )
  }
}

export class VerificationError extends BATSError {
  constructor(message: string) {
    super(message, "VERIFICATION_ERROR")
  }
}
```

---

## 15. Usage Example

```ts
import { BATSAgent, createSearchTool, createJinaBrowseTool } from "./bats"
import { anthropic } from "@ai-sdk/anthropic"

const agent = new BATSAgent({
  id: "research-agent",
  model: anthropic("claude-sonnet-4-20250514"),
  
  tools: {
    search: createSearchTool({
      apiKey: process.env.GOOGLE_API_KEY!,
      searchEngineId: process.env.GOOGLE_SEARCH_ENGINE_ID!,
    }),
    browse: createJinaBrowseTool({
      apiKey: process.env.JINA_API_KEY,
      contentLimit: 150000,
    }),
  },
  
  budget: {
    search: 50,
    browse: 50,
  },
  
  globalPolicy: "early-stop",
  temperature: 0.7,
  summarizationInterval: 10,
  
  onAttemptStart: (n, budget) => {
    console.log(`Starting attempt ${n}, budget:`, budget)
  },
  onVerification: (result) => {
    console.log(`Verification: ${result.decision}`)
  },
})

// Non-streaming usage
const result = await agent.generate({
  prompt: "What is the full name of the person who invented the first programmable computer?",
})
console.log(result.text)

// Streaming usage
const stream = await agent.stream({
  prompt: "Find the company that...",
})
for await (const event of stream.fullStream) {
  // Handle streaming events
}
```

---

## 16. File Structure

```
bats/
├── index.ts              # Public exports
├── agent.ts              # BATSAgent class
├── types.ts              # Type definitions
├── budget-tracker.ts     # BudgetTracker class
├── planner.ts            # Planner class
├── verifier.ts           # Verifier class
├── orchestrator.ts       # Attempt loop logic
├── prompts.ts            # System prompts
├── control-schema.ts     # Control schema parsing
├── answer-selection.ts   # Answer selection logic
├── errors.ts             # Error classes
└── tools/
    ├── search.ts         # Search tool implementations
    ├── browse-jina.ts    # Jina browse implementation
    └── browse-crawl4ai.ts # Crawl4AI browse implementation
```

---

## 17. Implementation Phases

### Phase 1: Core Infrastructure
1. Type definitions
2. BudgetTracker
3. Planner
4. Error classes

### Phase 2: Tools
1. Search tool (Google Custom Search)
2. Browse tool (Jina.ai)
3. Browse tool (Crawl4AI)

### Phase 3: Verification
1. Verifier class
2. Constraint analysis
3. Trajectory summarization

### Phase 4: Orchestration
1. Single attempt loop
2. Multi-attempt loop
3. Answer selection

### Phase 5: Agent Interface
1. BATSAgent.generate()
2. BATSAgent.stream()
3. Progress events
