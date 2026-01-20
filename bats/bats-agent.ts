import type { LanguageModel } from "ai"
import { runVerificationSubagent } from "./verification-subagent"
import {
  runReActSubagent,
  getAllTrajectorySummaries,
  getMostRecentVerification,
} from "./react-subagent"
import type {
  Ledger,
  Plan,
  VerifiedAnswer,
  VerificationOutput,
  BatsAgentInput,
  TrajectoryEntry,
} from "./types"

const budgetIsExhausted = (ledger: Ledger) => {
  return ledger.search.remaining <= 0 || ledger.browse.remaining <= 0
}

function formatTrajectoryForVerification(trajectory: TrajectoryEntry[]): string {
  return trajectory
    .map((entry) => {
      const toolCallsStr =
        entry.toolCalls.length > 0
          ? entry.toolCalls
              .map((tc) => `  Tool: ${tc.toolName}\n  Input: ${JSON.stringify(tc.input)}`)
              .join("\n")
          : "  (no tool calls)"

      return `=== Iteration ${entry.iteration} ===
Thinking:
${entry.thinking}

Actions:
${toolCallsStr}`
    })
    .join("\n\n")
}

export async function runBATSAgent({
  budget,
  question,
  mode = "early_abort",
  K = 10,
  model,
}: BatsAgentInput & { model: LanguageModel }) {
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
    // Check budget at start of each macro iteration
    if (budgetIsExhausted(ledger)) break macroAttemptLoop

    const initializePlan = (): Plan => ({
      roots: [],
      executionCursor: null,
      status: "active",
      totalUsage: {
        query: 0,
        url: 0,
      },
    })

    // Micro-Attempt State
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
      // Check budget at start of each micro iteration
      if (budgetIsExhausted(ledger)) break macroAttemptLoop

      // Run ReAct Subagent
      const {
        proposedAnswer,
        trajectory,
        budgetExhausted,
      } = await runReActSubagent({
        question,
        ledger,
        plan: plans[`attempt_${microAttemptNumber}`],
        allTrajectorySummaries: getAllTrajectorySummaries(verificationOutputs),
        mostRecentVerification: getMostRecentVerification(
          verificationOutputs,
          microAttemptNumber,
        ),
        K,
        model,
        verificationOutputs: verificationOutputs[`attempt_${microAttemptNumber}`] || [],
      })

      // If budget exhausted during ReAct, break to macro loop
      if (budgetExhausted) break macroAttemptLoop

      // If no answer proposed (shouldn't happen unless budget exhausted), continue
      if (!proposedAnswer) {
        console.warn("ReAct subagent returned without proposedAnswer or budgetExhausted")
        break macroAttemptLoop
      }

      // Run verification
      const verificationOutput = await runVerificationSubagent({
        question,
        trajectory: formatTrajectoryForVerification(trajectory),
        proposedAnswer,
        ledger,
      })

      // Store verification output
      ;(verificationOutputs[`attempt_${microAttemptNumber}`] ||= []).push(
        verificationOutput,
      )

      // Handle verification decision
      if (verificationOutput.decision === "PIVOT") {
        plans[`attempt_${microAttemptNumber}`].status = "abandoned"
        microAttemptNumber++
        plans[`attempt_${microAttemptNumber}`] = initializePlan()
        // Continue micro-attempt loop with new attempt
        continue microAttemptLoop
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

      // CONTINUE decision - stay in current attempt, run ReAct again
      // The verification guidance will be picked up in the next iteration
    }
  }

  // Select best answer from verified answers
  return selectAnswer(verifiedAnswers, question, model)
}

async function selectAnswer(
  verifiedAnswers: VerifiedAnswer[],
  question: string,
  model: LanguageModel,
): Promise<{ answer: string; confidence: "verified" | "best_effort" | "none" }> {
  if (verifiedAnswers.length === 0) {
    return { answer: "None", confidence: "none" }
  }

  if (verifiedAnswers.length === 1) {
    return { answer: verifiedAnswers[0].answer, confidence: "verified" }
  }

  // Multiple verified answers - use majority vote or best-of-N selection
  // For now, return the first one (can be enhanced with LLM-as-judge)
  // TODO: Implement proper answer selection with majority vote
  return { answer: verifiedAnswers[0].answer, confidence: "verified" }
}
