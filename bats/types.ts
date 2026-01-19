export type Budget = {
  search: number
  browse: number
}

export type Ledger = {
  search: {
    used: number
    remaining: number
  }
  browse: {
    used: number
    remaining: number
  }
}

export type Mode = "early_abort" | "budget_exhaustive"

export type BatsAgentInput = {
  question: string
  budget: Budget
  mode: Mode
  K?: number
}

export type Decision = "SUCCESS" | "CONTINUE" | "PIVOT"

// TODO: Update trajectory to be more structured.
export type VerificationInput = {
  question: string
  trajectory: string
  proposedAnswer: string
  ledger: Ledger
}

export type VerificationOutput = {
  verification: {
    constraint: string
    assessment: "SATISFIED" | "CONTRADICTED" | "UNVERIFIABLE"
    reasoning: string
  }[]
  decision: "SUCCESS" | "CONTINUE" | "PIVOT"
  justification: string
  trajectory_summary: string
  details?: {
    failure_analysis: string
    useful_information: string
    strategic_recommendations: string
  }
}

export type Evidence = Pick<
  VerificationOutput,
  "verification" | "justification"
>

export type VerifiedAnswer = {
  answer: string
  evidence: Evidence
}

/** Atomic resource counters (never derived automatically) */
export type ResourceUsage = {
  query: number
  url: number
}

export type NodeId = string

export type NodeStatus = "pending" | "partial" | "done" | "failed"

/**
 * A PlanNode records ONLY the cost incurred
 * while THIS node was the execution focus.
 *
 * It does NOT include children.
 */
export type PlanNode = {
  id: NodeId
  description: string
  status: NodeStatus
  /** Local, append-only usage for this node only */
  usage: ResourceUsage
  /**
   * Human-readable evolving summary.
   * May be appended to or replaced by a faithful summary,
   * but must not falsify earlier conclusions.
   * TODO: This might be redundant and not necessary if we
   * accumulating <think> blocks in the trajectory.
   */
  notes?: string
  /** Conditional refinements / branches */
  children?: PlanNode[]
}

export type Plan = {
  /** Root nodes for this attempt */
  roots: PlanNode[]
  /**
   * Execution focus.
   * Changing this enables backtracking without mutation.
   */
  executionCursor: NodeId | null
  /** Plan status */
  status: "active" | "abandoned" | "succeeded"
  /**
   * Authoritative, monotonic total usage for this attempt.
   * This is what the budget tracker and verifier rely on.
   */
  totalUsage: ResourceUsage
}
