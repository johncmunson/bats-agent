import { generateText } from "ai"
import type { VerificationOutput } from "./types"

// TODO: Refine prompt and update `trajectory` to be more structured.
export const summarizeTrajectory = async (verificationOutputs: VerificationOutput[], trajectory: string) => {
  const prompt = `You are summarizing the CURRENT in-progress reasoning trajectory of a single attempt.

Your task is to produce a concise, factual summary that REPLACES the older parts of the trajectory.
This summary will be used as the ONLY historical context for continuing the SAME attempt.

IMPORTANT RULES

1. Scope
- Summarize ONLY the provided Trajectory.
- Do NOT include information from other attempts or external context.
- Do NOT speculate or add new reasoning.

2. Role of Verification Outputs
- The Verification Outputs are NOT to be summarized themselves.
- Use them ONLY as grounding and correction signals.
- If a fact, conclusion, or assumption in the Trajectory is contradicted or deemed invalid by the Verification Outputs, it MUST be excluded.
- If a fact is explicitly validated or marked as useful, it SHOULD be preserved.

3. What to Preserve
- Verified or strongly supported facts
- Key intermediate findings that remain relevant
- Explicit failure causes or dead ends (as negative knowledge)
- Constraints that are satisfied, unsatisfied, or still open

4. What to Remove
- Raw chain-of-thought
- Speculative hypotheses
- Redundant tool outputs
- Reasoning paths that were abandoned or contradicted

5. Output Requirements
- Be concise and information-dense
- Use neutral, factual language
- Do NOT reference “the trajectory” or “the verification”
- Do NOT include instructions or recommendations
- Produce a standalone summary suitable for continuing reasoning

INPUTS

Trajectory (to be summarized):
${trajectory}

Verification Outputs (for grounding only):
${verificationOutputs.map((verificationOutput) => verificationOutput.trajectory_summary).join("\n")}
`

  const { output } = await generateText({
    model: "openai/gpt-5.2",
    prompt,
  })

  return output
}
