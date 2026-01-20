### Random notes for later...

- Figure out the ReAct loop
- The browse tool should truncate webpage results to 150k characters
- Section 4.2 (CONTINUE/PIVOT summary) appears to be in conflict with section A.2 (K = 10 summary)
- Use a temperature of 0.7 during agent execution to encourage exploration
- Use a temperature of 0.0 for final answer selection and evaluation
- ensure that we're utilizing an efficient prompt caching strategy

---

### Thinking + Planning: Combined or Separate?

Looking at the paper and your existing verification subagent, should the ReAct iteration be:

- Single LLM call that outputs thinking, plan delta, and tool selection together
- Two separate calls: one for think+plan, another for tool selection

The paper shows them as conceptually separate (Think + Plan → Tool Call), but from an AI SDK perspective, combining them would be more token-efficient.

**Insight**: This could be something that we experiment with.
