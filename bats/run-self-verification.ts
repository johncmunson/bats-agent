import { generateText, Output } from "ai"
import { z } from "zod"
import { type BudgetStatus } from "./types"

// TODO: Update trajectory to be more structured.
type SelfVerificationInput = {
  question: string
  trajectory: string
  currentAnswer: string
  budgetStatus: BudgetStatus
}

const selfVerificationSchema = z.object({
  verification: z
    .array(
      z.object({
        constraint: z
          .string()
          .describe(
            "A single explicit constraint derived from the original Question.",
          ),

        assessment: z
          .enum(["SATISFIED", "CONTRADICTED", "UNVERIFIABLE"])
          .describe(
            "Whether the Current Answer satisfies, contradicts, or cannot be verified against this constraint.",
          ),

        reasoning: z
          .string()
          .describe(
            "Brief justification explaining why this constraint received the given assessment, referencing the Current Answer and/or Trajectory.",
          ),
      }),
    )
    .describe("Constraint-by-constraint verification results."),

  decision: z
    .enum(["SUCCESS", "CONTINUE", "PIVOT"])
    .describe(
      "Final strategic decision based on verification results and remaining budget.",
    ),

  justification: z
    .string()
    .describe(
      "Concise explanation for your strategic decision. Why is it a success, a dead end, or a correctable error?",
    ),

  trajectory_summary: z
    .string()
    .describe(
      "Concise narrative summarizing the reasoning trajectory, key steps, findings, and how they led to the final decision.",
    ),

  details: z
    .object({
      failure_analysis: z
        .string()
        .describe(
          "Root-cause analysis explaining why the current attempt failed or was incomplete.",
        ),

      useful_information: z
        .string()
        .describe(
          "Any intermediate findings or insights worth preserving for future attempts.",
        ),

      strategic_recommendations: z
        .string()
        .describe(
          "Actionable guidance for the next attempt, including pivots, backtracking points, or strategy changes.",
        ),
    })
    .optional()
    .describe(
      "Additional guidance for CONTINUE or PIVOT decisions. Omitted for SUCCESS.",
    ),
})

type SelfVerificationOutput = z.infer<typeof selfVerificationSchema>

export async function runSelfVerification({
  question,
  trajectory,
  currentAnswer,
  budgetStatus,
}: SelfVerificationInput): Promise<SelfVerificationOutput> {
  const prompt = `You are an AI Strategic Verifier. Your primary goal is to evaluate a proposed answer, assess the viability of the current problem-solving plan, and decide the best course of action: declare success, continue with the current plan, or pivot to a new one.

### Given Inputs

- **Question**: The original user question. An answer is believed to exist.
- **Trajectory**: The sequence of reasoning steps and tool calls taken so far in the current attempt.
- **Current Answer**: The final answer produced by the current attempt.
- **Budget Status**: Information on current tool call budget utilization and remaining budget, including search queries and browsing URLs.

### Your Task: A 3-Step Process

You must proceed in the following order:

#### Step 1: Conduct Verification Analysis

First, perform a strict verification of the \`Current Answer\`.

- Go through each constraint from the original \`Question\` one by one.
- For each constraint, compare it against the \`Current Answer\` and the \`Trajectory\`.
- State your finding for each constraint: \`SATISFIED\`, \`CONTRADICTED\`, or \`UNVERIFIABLE\`.

#### Step 2: Make a Strategic Decision

Based on your verification and the budget, make one of three decisions:

1. SUCCESS: If the verification in Step 1 passed (all constraints are satisfied). The task is complete.
2. CONTINUE: If the verification failed because a few constraints are unverifiable, but the overall plan is still sound and salvageable. This is the choice if **both** of these conditions are true:
   - Promising Path: The \`Trajectory\` is generally sound, and the failure was due to a correctable error.
   - Sufficient Budget: There is enough \`Remaining Budget \`to attempt a correction on this path.
3. PIVOT: If the verification failed, signal to abandon the current plan and switch to another one. You should pivot if any of these conditions are true:
   - Dead End: The \`Trajectory\` reveals a fundamental flaw in the current plan’s logic that cannot be easily fixed.
   - Failed Tool Calls: The \`Trajectory\` shows repeated, unsuccessful attempts to find certain info.
   - Insufficient Budget: The \`Remaining Budget\` is too low to make another meaningful attempt or correction within the current plan.

#### Step 3: Summarize for the Next Step

This is the most critical step for guiding future actions.

You need to first provide a **trajectory summary**: summarize the agent’s reasoning trajectory into a concise narrative. Explain its initial goal, the logical steps taken, key findings, and the final conclusion, emphasizing how key findings or contradictions caused the agent to change its strategy.

Then, provide additional details tailored to your decision in Step 2.

- If the decision is **SUCCESS**:
  - No further detail needed.
- If the decision is **CONTINUE / PIVOT**:
  - Failure Analysis: Diagnose the root cause of the failure. Identify the critical flaw (e.g., poor query design, flawed logic, misinterpreted evidence) and name the general failure pattern to prevent its recurrence.
  - Useful Information: Any useful intermediate findings or results from the current \`Trajectory\` that could be valuable inputs for the next attempt. This prevents redundant work.
  - Strategic Recommendations: Provide actionable advice for the agent’s next attempt. Suggest strategic pivots, new angles of investigation, or different ways to combine the problem’s constraints. Explicitly state if it should backtrack to and resume from a specific step in the previous plan to avoid re-doing work.

### Input Data

**Question**
${question}

**Trajectory**
${trajectory}

**Current Answer**
${currentAnswer}

**Budget Status**
${budgetStatus}
`

  const { output } = await generateText({
    model: "openai/gpt-5.2",
    prompt,
    output: Output.object({
      name: "StrategicVerificationResult",
      description:
        "Structured evaluation of an agent trajectory, including verification, strategic decision, and next-step guidance.",
      schema: selfVerificationSchema,
    }),
  })

  return output
}
