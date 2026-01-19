I've provided a research paper describing the BATS agentic framework. Additionally, I have summarized the main algorithmic control flow below. Please note that this is a high-level summary and not every detail is precisely captured.

1. BATSAgent is initialized with a tool budget and a question. Internally, the agent also initializes the following items in global state.

- An empty tree-structured plan/checklist
- An empty record of attempt summaries, `Record<`attempt\_${number}`, string[]>`
- The current attempt number and current attempt iteration, both initially 0. These can drift due to how the CONTINUE semantics work.
- The most recent verification result, SUCCESS, CONTINUE, or PIVOT, initially null

2. The outer "attempt" loop begins

- Check if either part of the budget is zero. If so, exit the loop and goto answer selection.
- If early abort mode, also check if most recent verification result is SUCCESS. If so, exit the loop and goto answer selection.
- Increment the current iteration number in global state
- If the most recent verification result in global state is CONTINUE, then do not update the current attempt number in global state. Otherwise, do increment.
- The planner/executor inner loop runs until an answer is proposed
- The self-verification module produces a trajectory summary (plus details if CONTINUE or PIVOT), evaluates the answer, and outputs one of SUCCESS, CONTINUE, or PIVOT
  - Update attempt summaries in global state
  - Update the most recent verification result in global state
  - Update the proposed answers array in global state

3. The inner "think + plan + use tools" loop begins

- Help me
- fill this
- section out

4. Answer selection

- Help me
- fill this
- section out

FIGURE OUT...

- How to store proposed answers in global state
- Tools should have a tool-call gate that rejects calls when budget is zero. If the gate is triggered, force an answer proposal of "None - Answer injected by controller; model failed to terminate inner loop when budget was exhausted."
- The browse tool should truncate webpage results to 150k characters
- **ReAct loop is conditioned on the historical trajectory / reasoning trace. When a new attempt begins, if K > 10, then replace the historical trace with a compact representation derived from the summaries on file that were output from the verification module.** ??
- Store the historical self-verifier decisions and analysis for auditing purposes, but each new attempt is only conditioned on the most recent decision / analysis.
- The judge DOES NOT see the trajectory_summary, just the analysis from the self-verifier
- The judge is only presented with **terminal and verified answers**, not intermediate ones. i.e. not answers from continue or pivot, only success

---

- The browse tool truncates webpage results to 150k
- maxIterations is _not_ utilized by the ReAct + Budget Tracker module
- lifetime_budget is owned by the BATS controller/orchestrator
- two modes...
  - budget-exhaustive
  - early abort
- use a temperature of 0.7 during agent execution to encourage exploration
- use a temperature of 0.0 for final answer selection and evaluation
- "In BATS’s verification module, we further control context size by periodically replacing the historical trajectory with summary. Since the agent determines when to activate the verification module, we perform a check during each invocation: if more than 𝐾 iterations have passed since the last update (with 𝐾 = 10 in our experiments), we replace the older reasoning trace with a concise summary derived from the verification outputs."

```
while budget_remaining {                  // <-- Macro-Attempt Loop
    while decision !== success {          // <-- Micro-Attempt Loop
        while no_proposed_answer_yet {    // <-- ReAct Loop
          think_plan_use_tools()
        }
        verify()
    }
}
select_answer()
```

```
type BudgetInput = {
  search: number;
  browse: number;
};

type Budget = {
  search: {
    used: number;
    remaining: number;
  };
  browse: {
    used: number;
    remaining: number;
  };
};

type Mode = "early_abort" | "budget_exhaustive";

type Decision = "SUCCESS" | "CONTINUE" | "PIVOT";

function bats_agent(budget: BudgetInput, question: string, mode: Mode = early_abort) {
  const question: string = question
  const budget: Budget = {
    search: {
      used: 0,
      remaining: budget.search
    },
    browse: {
      used: 0,
      remaining: budget.browse
    }
  }
  const verified_answers: array = []
  const mode: Mode = mode
  while (
    mode === "early_abort"
      ? verified_answers.length === 0
      : true
  ) {                                                 // <-- Macro-Attempt Loop
      let decision: Decision
      let microAttemptNumber: number = 0
      let microAttemptIteration: number = 0
      const verification_outputs: VerificationOutput
      while (decision !== "SUCCESS") {                // <-- Micro-Attempt Loop
          while (!proposed_answer) {                  // <-- ReAct Loop
            think()
            plan()
            if (!budget_remaining) go_to_select_answer()
            use_tools()
          }
          verify()
      }
  }
  select_answer()
}
```
