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

const budgetIsExhausted = (ledger: Ledger) => {
  return ledger.search.remaining === 0 || ledger.browse.remaining === 0
}

function bats_agent(
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
  const verified_answers: VerifiedAnswer[] = []

  // Macro-Attempt Loop
  while (mode === "early_abort" ? verified_answers.length === 0 : true) {
    // Micro-Attempt State
    let decision: Decision | null = null
    let microAttemptNumber: number = 0
    let microAttemptIteration: number = 0
    const verification_outputs: Record<
      `attempt_${number}`,
      VerificationOutput[]
    > = {}

    // Micro-Attempt Loop
    while (decision !== "SUCCESS") {
      // Adjust outer-loop state
      microAttemptIteration++
      if (decision === "PIVOT") microAttemptNumber++

      // ReAct State
      let proposed_answer: string | null = null

      // ReAct Loop
      while (!proposed_answer) {
        think()
        plan()
        if (budgetIsExhausted(ledger)) go_to_select_answer()
        use_tools()
      }
      const verification_output = runSelfVerification()
    }
  }
  select_answer()
}
