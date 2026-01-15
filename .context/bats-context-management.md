# Context Management in BATS

## Truncation vs. Trajectory Summarization

This system uses **two distinct context-control mechanisms** that operate at different layers and serve different purposes:

1. **Tool-level content truncation** (mechanical, loss-y, pre-LLM)
2. **Trajectory summarization** (semantic, structured, verifier-driven)

They should not be conflated.

---

## 1. Search & Browse Tool Truncation

### What is truncated

* **Raw webpage content** returned by browse tools
* Not search results (which are already short)

### When truncation happens

* **Immediately after fetching a webpage**
* **Before** content is passed into the LLM context

### How truncation works

* Hard character cap (paper: **150,000 characters per page**)
* Simple cutoff (e.g., first N characters)
* No semantic reasoning involved

### Who performs truncation

* **Tool adapter / orchestration layer**
* Not the Planner
* Not the Verifier
* Not the LLM

### Why truncation exists

* Prevent worst-case context explosion from long webpages
* Bound token cost deterministically
* Ensure tool calls have predictable overhead

### Important invariants

* Truncation is **not summarization**
* No attempt is made to preserve “important” parts
* Information may be lost irreversibly
* This is acceptable because:

  * Webpages are external evidence, not internal state
  * Higher-level reasoning happens later

### Engineer takeaway

> **Browse tools truncate raw page text mechanically to enforce hard context limits. No semantic judgment is involved.**

---

## 2. Trajectory Summarization

### What is summarized

* **Entire reasoning trajectory of an attempt**, including:

  * internal reasoning
  * tool calls and observations
  * intermediate hypotheses
  * partial plans and failures

This is *agent state*, not raw evidence.

---

### When summarization happens

Trajectory summarization is triggered in **three cases**:

1. **Verification returns `CONTINUE`**

   * Attempt is promising but incomplete
   * Budget remains
   * Same attempt will continue

2. **Verification returns `PIVOT`**

   * Attempt is terminated as unproductive
   * A new attempt will start
   * Lessons must be preserved

3. **Periodic safeguard**

   * After a fixed number of iterations (paper: **K = 10**)
   * Prevents uncontrolled context growth

---

### Who performs summarization

* **The Verifier, and only the Verifier**

This is deliberate:

* Verifier has access to:

  * original constraints
  * success/failure judgment
  * global reasoning validity
* Planner does not summarize
* Orchestrator only applies the result

---

### How summarization works

* Verifier replaces the *entire raw trajectory* with a **structured summary**
* Summary includes:

  * goal of the attempt
  * strategy used
  * key findings (positive and negative)
  * failure analysis (if any)
  * reusable facts
  * explicit recommendations for next steps

This is a **destructive replacement**, not an append.

---

### Why summarization exists

Trajectory summarization enables:

* **Bounded-memory reasoning**
* **Cross-attempt learning without training**
* **Avoidance of repeated dead ends**
* **Safe continuation after partial success**
* **Budget efficiency**

It is not just for token savings; it is a **control-flow primitive**.

---

### Critical invariants

* At any time, the system holds:

  * either a full trajectory
  * or a summary
    **Never both**
* Summarization never happens mid-reasoning without verifier involvement
* Summaries may reference facts learned from webpages, but do **not** replace webpage truncation

### Engineer takeaway

> **Trajectory summarization is a verifier-driven state compression step that replaces long reasoning histories with a compact, reusable search state.**

---

## 3. Side-by-Side Summary

| Aspect         | Tool Truncation         | Trajectory Summarization       |
| -------------- | ----------------------- | ------------------------------ |
| Operates on    | Webpage content         | Agent reasoning history        |
| When           | Immediately after fetch | On CONTINUE / PIVOT / periodic |
| Who            | Tool adapter            | Verifier                       |
| Type           | Mechanical cutoff       | Semantic, structured           |
| Purpose        | Hard context bounds     | Control flow + learning        |
| Lossy          | Yes (blind)             | Yes (intentional)              |
| Affects budget | Indirectly              | Directly                       |

---

## One-line mental model

> **Truncation limits how much the agent can read at once; summarization determines what the agent remembers.**
