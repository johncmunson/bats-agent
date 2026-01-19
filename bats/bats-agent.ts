import { runVerificationSubagent } from "./verification-subagent"
import type {
  Budget,
  Ledger,
  Mode,
  VerifiedAnswer,
  Plan,
  VerificationOutput,
} from "./types"

const budgetIsExhausted = (ledger: Ledger) => {
  return ledger.search.remaining === 0 || ledger.browse.remaining === 0
}

async function runBATSAgent(
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
      const verificationOutput = await runVerificationSubagent({
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
