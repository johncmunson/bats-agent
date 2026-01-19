# Global State

```ts
export type ToolName = string

export interface BudgetState {
  initial: Record<ToolName, number>
  remaining: Record<ToolName, number>
}

export type StepStatus = "pending" | "done" | "failed" | "partial"

export interface PlanNode {
  id: string
  label: string
  status: StepStatus
  usage: Partial<Record<ToolName, number>>
  children: PlanNode[]
  notes?: string
}

export interface PlanState {
  root: PlanNode
  focusNodeId: string
}

export type VerifyDecision = "SUCCESS" | "CONTINUE" | "PIVOT"

export interface VerificationRecord {
  decision: VerifyDecision
  verificationText: string
  justification: string
  trajectorySummary: string
}

export interface CandidateAnswer {
  attemptId: number
  answer: string
  verification?: VerificationRecord
}

export interface ToolCallRecord {
  tool: ToolName
  args: unknown
  costUnits: number
}

export interface ToolResponseRecord {
  tool: ToolName
  content: unknown
  summarized?: string
}

export interface IterationRecord {
  budgetSnapshot: BudgetState
  agentMessage: string
  toolCalls: ToolCallRecord[]
  toolResponses: ToolResponseRecord[]
}

export interface AttemptRecord {
  attemptId: number
  iterations: IterationRecord[]
  currentAnswer?: string
  verification?: VerificationRecord
}

export interface WorkingContextState {
  attemptId: number
  lastToolResponseForPrompt?: string
  trajectorySummaryForPrompt?: string
  itersSinceLastSummary: number
}

export interface BATSState {
  budget: BudgetState
  plan: PlanState
  attemptCounter: number
  attempts: AttemptRecord[]
  working: WorkingContextState
  candidates: CandidateAnswer[]
}
```
