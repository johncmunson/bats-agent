Below is a **condensed implementation specification** for BATS that is intended to be directly usable by a software engineer. It is deliberately precise about **control flow, state transitions, and termination semantics**, and omits empirical motivation.

---

# BATS (Budget-Aware Test-time Scaling)

## Implementation One-Pager (Engineering Spec)

### Scope

This document specifies the **runtime control flow**, **state machines**, and **decision logic** for implementing BATS for a tool-augmented LLM agent. It assumes no training-time changes; all behavior is orchestration-level.

---

## 1. Core Concepts and State

### 1.1 Budgets

- **Global Budget** (hard constraint)
  - Per-tool counters (e.g., `search`, `browse`)
  - Monotonically decreasing

- **Attempt Budget**
  - View of remaining global budget at attempt start
  - No local replenishment

### 1.2 Attempts

- An **attempt** is a single coherent reasoning trajectory.
- Each attempt produces **at most one candidate answer**.
- Attempts are **independent except for summaries** passed forward.

### 1.3 Global Answer Pool

- Stores **only self-verified answers**
- Used only in **budget-exhaustive mode**

---

## 2. High-Level Control Loop (Global)

```pseudo
verified_answers = []

while global_budget_remaining():
    attempt = initialize_attempt(global_budget)

    outcome = run_attempt(attempt)

    if outcome.type == SUCCESS:
        verified_answers.append(outcome.answer)

        // Mandatory: terminate this attempt immediately
        terminate(attempt)

        if GLOBAL_POLICY == EARLY_STOP:
            return outcome.answer
        else:
            continue  // start a new attempt

    if outcome.type == BUDGET_EXHAUSTED:
        break

// Budget exhausted
return select_best_verified_answer(verified_answers)
```

**Important invariants**

- A SUCCESS always terminates the _current attempt_.
- Continuing after SUCCESS is a _global policy decision_, not verifier logic.

---

## 3. Attempt Lifecycle (Local)

### 3.1 Attempt Initialization

At attempt start:

1. Snapshot remaining global budget
2. Parse question → extract constraints
3. Classify constraints:
   - **Exploration constraints** (broad, candidate-generating)
   - **Verification constraints** (narrow, candidate-filtering)

4. Initialize **Plan Tree** (see §4)

---

## 4. Planning Module (Persistent, Attempt-Local)

### 4.1 Plan Structure

Tree of steps; each node contains:

- `id` (e.g., `1`, `1.2`)
- `description`
- `status`: `pending | partial | done | failed`
- `resource_usage`: `{search: n, browse: m}`

### 4.2 Planning Rules

- Plan nodes are **never deleted**
- Failed paths remain recorded
- New branches may be added dynamically
- Plan updates must consider remaining budget

---

## 5. Attempt Execution Loop

```pseudo
while attempt_budget_remaining():

    think_with_budget_context(plan, budget)

    action = select_next_action(plan, budget)

    if action == PROPOSE_ANSWER:
        verification = verify_answer(attempt)

        if verification.decision == SUCCESS:
            return SUCCESS(answer)

        if verification.decision == CONTINUE:
            summarize_trajectory()
            continue  // same attempt

        if verification.decision == PIVOT:
            summarize_trajectory()
            return PIVOT  // terminate attempt

    else if action == TOOL_CALL:
        execute_tool_call()
        update_plan()
        update_budget()

// budget exhausted mid-attempt
return BUDGET_EXHAUSTED
```

---

## 6. Budget Tracker (Always-On Signal)

At **every reasoning step**, inject:

- Per-tool used / remaining counts
- Optional budget regime classification:
  - HIGH (≥70%)
  - MEDIUM (30–70%)
  - LOW (10–30%)
  - CRITICAL (<10%)

Budget tracker:

- Does **not** decide actions
- Only exposes state

---

## 7. Self-Verification Module (Control Operator)

### 7.1 Verification Input

- Original question
- Current attempt trajectory
- Proposed answer
- Remaining budget

### 7.2 Verification Step 1: Constraint Audit

For **each original constraint**:

- `satisfied`
- `contradicted`
- `unverifiable`

### 7.3 Verification Step 2: Decision Logic

```pseudo
if all constraints satisfied:
    decision = SUCCESS
else if promising_path AND sufficient_budget:
    decision = CONTINUE
else:
    decision = PIVOT
```

Definitions:

- **Promising path**: logical structure intact, failures correctable
- **Sufficient budget**: remaining tools can plausibly resolve missing constraints

### 7.4 Verification Step 3: Trajectory Summary

If decision ∈ {CONTINUE, PIVOT}:

- Replace raw history with compact summary:
  - What was attempted
  - What failed and why
  - Useful intermediate findings
  - Explicit guidance to avoid repetition

---

## 8. Termination Semantics (Critical)

| Event                   | Effect                                        |
| ----------------------- | --------------------------------------------- |
| Verification = SUCCESS  | **Immediate attempt termination (mandatory)** |
| Verification = PIVOT    | Attempt terminates                            |
| Verification = CONTINUE | Same attempt resumes                          |
| Tool budget exhausted   | Attempt terminates                            |
| Global early-stop       | System terminates                             |
| Global budget exhausted | Final answer selection                        |

---

## 9. Answer Selection (Budget-Exhaustive Mode Only)

- Input: list of verified answers
- Selection method:
  - Judge model (Best-of-N)
  - Majority vote over verified answers

- **Unverified answers are never eligible**

---

## 10. Non-Goals / Explicit Exclusions

- No within-attempt refinement after SUCCESS
- No speculative continuation past verification
- No token-based budgeting logic (tool calls dominate)
- No training or fine-tuning assumptions

---

## 11. Minimal Mental Model

> BATS is a **budget-bounded, verification-gated, multi-attempt search system**
> where **verification decides control flow**, not just correctness,
> and **budget is a first-class state variable**, not a side constraint.

---

Below is a **concrete, implementation-ready TypeScript interface specification** for **BudgetTracker**, **Planner**, and **Verifier**, with **explicit semantics and invariants**. This is written to be handed directly to an engineer.

No motivation, no paper references—only contracts and behavior.

---

# BATS Core Interfaces (TypeScript)

---

## 1. Shared Types

```ts
/** Tool identifiers must be stable and enumerable */
export type ToolName = "search" | "browse"

/** Budget is always non-negative and monotonically decreasing */
export interface BudgetState {
  readonly used: Record<ToolName, number>
  readonly remaining: Record<ToolName, number>
}

/** Snapshot of budget at a specific point in time */
export interface BudgetSnapshot extends BudgetState {
  readonly total: Record<ToolName, number>
}

/** Classification is advisory, not authoritative */
export type BudgetRegime = "HIGH" | "MEDIUM" | "LOW" | "CRITICAL"
```

---

## 2. BudgetTracker Interface

### Purpose

Expose **current budget state** and **derived regime**.
BudgetTracker never decides actions.

```ts
export interface BudgetTracker {
  /** Current authoritative budget state */
  getSnapshot(): BudgetSnapshot

  /** Advisory regime derived from remaining / total */
  getRegime(): BudgetRegime

  /**
   * Record a tool invocation.
   * Must throw if remaining budget would go negative.
   */
  consume(tool: ToolName, units?: number): void

  /**
   * True iff at least one unit remains for every required tool
   */
  hasRemaining(required?: Partial<Record<ToolName, number>>): boolean
}
```

### Semantics & Invariants

- `consume()` is the **only mutation path**
- Budget is **global** across attempts
- `getRegime()` is derived, not stateful
- BudgetTracker must be **queried before every reasoning step**

---

## 3. Planner Interface

### Purpose

Maintain a **persistent, tree-structured plan** and select the next action.

---

### 3.1 Plan Representation

```ts
export type PlanStepStatus = "pending" | "partial" | "done" | "failed"

export interface PlanStep {
  readonly id: string // e.g. "1", "1.2"
  readonly description: string
  status: PlanStepStatus
  readonly parentId?: string

  /** Accumulated usage for this step */
  resourceUsage: Partial<Record<ToolName, number>>

  /** Optional free-form notes */
  notes?: string
}
```

---

### 3.2 Planner Interface

```ts
export interface Planner {
  /** Initialize a new plan for a fresh attempt */
  initialize(question: string): void

  /** Read-only view of all plan steps */
  getPlan(): ReadonlyArray<PlanStep>

  /**
   * Decide the next action.
   * Must be pure: no internal mutation.
   */
  nextAction(context: {
    budget: BudgetSnapshot
    lastObservation?: unknown
  }): PlannerAction

  /**
   * Update plan state after tool execution or reasoning.
   */
  update(
    stepId: string,
    update: {
      status?: PlanStepStatus
      resourceUsageDelta?: Partial<Record<ToolName, number>>
      notes?: string
    },
  ): void

  /**
   * Add new branches or steps.
   * Steps are never removed.
   */
  addStep(step: PlanStep): void
}
```

---

### 3.3 Planner Actions

```ts
export type PlannerAction =
  | {
      type: "TOOL_CALL"
      tool: ToolName
      payload: unknown // tool-specific
      stepId: string
    }
  | {
      type: "PROPOSE_ANSWER"
    }
  | {
      type: "THINK_ONLY"
    }
```

### Planner Guarantees

- Must **not** propose verification constraints as first action
- Must bias exploration vs. verification based on budget
- Must avoid repeating failed steps
- Must never mutate plan during `nextAction`

---

## 4. Verifier Interface

### Purpose

Evaluate a candidate answer and **control attempt termination**.

---

### 4.1 Verification Output

```ts
export type VerificationDecision = "SUCCESS" | "CONTINUE" | "PIVOT"

export interface ConstraintCheck {
  constraint: string
  status: "satisfied" | "contradicted" | "unverifiable"
}

export interface VerificationResult {
  decision: VerificationDecision

  /** Mandatory: full constraint-by-constraint audit */
  checks: ConstraintCheck[]

  /** Human- and machine-readable justification */
  justification: string

  /**
   * Summary to replace full trajectory
   * Required iff decision !== SUCCESS
   */
  trajectorySummary?: TrajectorySummary
}
```

---

### 4.2 Trajectory Summary

```ts
export interface TrajectorySummary {
  goal: string
  attemptedApproach: string
  keyFindings: string[]
  failureReason?: string
  reusableFacts?: string[]
  recommendations: string[]
}
```

---

### 4.3 Verifier Interface

```ts
export interface Verifier {
  /**
   * Perform verification.
   * Must be deterministic given inputs.
   */
  verify(input: {
    question: string
    proposedAnswer: string
    trajectory: unknown // opaque reasoning trace
    budget: BudgetSnapshot
  }): VerificationResult
}
```

---

### Verifier Hard Rules

- `SUCCESS` ⇒ **attempt must terminate immediately**
- `CONTINUE` is allowed **only if budget suffices**
- `PIVOT` must be chosen if contradictions exist or budget is insufficient
- Verifier never initiates tool calls

---

## 5. Cross-Component Control Guarantees

| Guarantee                   | Enforced By             |
| --------------------------- | ----------------------- |
| Budget monotonicity         | BudgetTracker           |
| Attempt isolation           | Orchestrator            |
| No refinement after SUCCESS | Verifier + Orchestrator |
| No forgotten failures       | Planner                 |
| Bounded execution           | BudgetTracker           |

---

## 6. Minimal Orchestrator Contract (Context)

```ts
export interface BATSOrchestrator {
  run(question: string): Promise<string>
}
```

Orchestrator responsibilities:

- Wire Planner ↔ BudgetTracker ↔ Verifier
- Enforce termination semantics
- Implement early-stop vs. budget-exhaustive policy

---

## 7. Mental Model for Engineers

- **BudgetTracker** = authoritative resource ledger
- **Planner** = search-tree controller
- **Verifier** = termination oracle
- **Orchestrator** = traffic cop

No component is optional.
No component overlaps responsibility.
