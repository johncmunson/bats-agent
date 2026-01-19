type Budget = {
  search: number
  browse: number
}

type Ledger = {
  search: {
    used: number
    remaining: number
  }
  browse: {
    used: number
    remaining: number
  }
}

type Mode = "early_abort" | "budget_exhaustive"

type Decision = "SUCCESS" | "CONTINUE" | "PIVOT"

type VerificationOutput = {
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

type Evidence = Pick<VerificationOutput, "verification" | "justification">

type VerifiedAnswer = {
  answer: string
  evidence: Evidence
}

/** Atomic resource counters (never derived automatically) */
type ResourceUsage = {
  query: number
  url: number
}

type NodeId = string

type NodeStatus = "pending" | "partial" | "done" | "failed"

/**
 * A PlanNode records ONLY the cost incurred
 * while THIS node was the execution focus.
 *
 * It does NOT include children.
 */
type PlanNode = {
  id: NodeId
  description: string
  status: NodeStatus
  /** Local, append-only usage for this node only */
  usage: ResourceUsage
  /**
   * Human-readable evolving summary.
   * May be appended to or replaced by a faithful summary,
   * but must not falsify earlier conclusions.
   */
  notes?: string
  /** Conditional refinements / branches */
  children?: PlanNode[]
}

type Plan = {
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

const budgetIsExhausted = (ledger: Ledger) => {
  return ledger.search.remaining === 0 || ledger.browse.remaining === 0
}

async function bats_agent(
  budget: Budget,
  question: string,
  mode: Mode = "early_abort",
) {
  // Global/Macro-Attempt State
  const ledger: Ledger = {
    search: {
      used: 0,
      remaining: budget.search,
    },
    browse: {
      used: 0,
      remaining: budget.browse,
    },
  }
  const verifiedAnswers: VerifiedAnswer[] = []

  // Macro-Attempt Loop
  macroAttemptLoop: while (
    mode === "early_abort" ? verifiedAnswers.length === 0 : true
  ) {
    const initializePlan = () => ({
      roots: [],
      executionCursor: null,
      status: "active" as Plan["status"],
      totalUsage: {
        query: 0,
        url: 0,
      },
    })
    // Micro-Attempt State
    let microAttemptIteration: number = 1
    let microAttemptNumber: number = 1
    const plans: Record<`attempt_${number}`, Plan> = {
      attempt_1: initializePlan(),
    }
    const verificationOutputs: Record<
      `attempt_${number}`,
      VerificationOutput[]
    > = {}

    // Micro-Attempt Loop
    microAttemptLoop: while (true) {
      // ReAct State
      let proposedAnswer: string | null = null

      // ReAct Loop
      reActLoop: while (!proposedAnswer) {
        if (budgetIsExhausted(ledger)) break macroAttemptLoop
        // Psuedocode...
        const thought = await think()
        const updatedPlan = await plan()
        const toolOutputs = await useTools()
      }
      const verificationOutput = await runSelfVerification({
        question,
        trajectory,
        proposedAnswer,
        ledger,
      })
      ;(verificationOutputs[`attempt_${microAttemptNumber}`] ||= []).push(
        verificationOutput,
      )
      microAttemptIteration++
      if (verificationOutput.decision === "PIVOT") {
        plans[`attempt_${microAttemptNumber}`].status = "abandoned"
        microAttemptNumber++
        plans[`attempt_${microAttemptNumber}`] = initializePlan()
      }
      if (verificationOutput.decision === "SUCCESS") {
        plans[`attempt_${microAttemptNumber}`].status = "succeeded"
        verifiedAnswers.push({
          answer: proposedAnswer,
          evidence: {
            verification: verificationOutput.verification,
            justification: verificationOutput.justification,
          },
        })
        break microAttemptLoop
      }
    }
  }
  return await selectAnswer()
}
