import { generateText } from "ai"
import type { VerificationOutput, TrajectoryEntry } from "./types"

/**
 * Summarize the current trajectory to reduce context length.
 * Accepts either a structured TrajectoryEntry[] or a raw string.
 */
export const summarizeTrajectory = async (
  verificationOutputs: VerificationOutput[],
  trajectory: TrajectoryEntry[] | string,
): Promise<string> => {
  // Format trajectory if it's structured
  const trajectoryStr =
    typeof trajectory === "string"
      ? trajectory
      : formatTrajectoryForSummary(trajectory)

  const verificationSummaries = verificationOutputs
    .map((vo) => vo.trajectory_summary)
    .filter(Boolean)
    .join("\n---\n")

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
- URLs that were visited and their key findings
- Search queries that were productive

4. What to Remove
- Raw chain-of-thought that doesn't lead to conclusions
- Speculative hypotheses that weren't validated
- Redundant tool outputs (keep only key findings)
- Reasoning paths that were abandoned or contradicted
- Detailed tool response JSON (summarize the findings instead)

5. Output Requirements
- Be concise and information-dense
- Use neutral, factual language
- Structure as: Key Facts → Open Questions → Dead Ends
- Do NOT reference "the trajectory" or "the verification"
- Do NOT include instructions or recommendations
- Produce a standalone summary suitable for continuing reasoning

INPUTS

Trajectory (to be summarized):
${trajectoryStr}

Verification Outputs (for grounding only):
${verificationSummaries || "(none yet)"}

OUTPUT

Provide a concise summary of the trajectory:`

  const { text } = await generateText({
    model: "openai/gpt-5.2", // TODO: Use configurable model
    prompt,
    temperature: 0,
  })

  return text
}

function formatTrajectoryForSummary(trajectory: TrajectoryEntry[]): string {
  return trajectory
    .map((entry) => {
      const toolCallsStr =
        entry.toolCalls.length > 0
          ? entry.toolCalls
              .map((tc) => {
                if (tc.toolName === "search") {
                  const input = tc.input as { query: string[] }
                  return `  - Search: ${input.query.join(", ")}`
                } else {
                  const input = tc.input as { url: string[]; goal: string }
                  return `  - Browse: ${input.url.join(", ")} (goal: ${input.goal})`
                }
              })
              .join("\n")
          : "  (no actions)"

      return `--- Iteration ${entry.iteration} ---
Thinking: ${entry.thinking}

Actions:
${toolCallsStr}`
    })
    .join("\n\n")
}
