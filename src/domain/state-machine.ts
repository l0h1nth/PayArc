import type { RecoveryStatus } from "./types.js";

const transitions: Record<RecoveryStatus, ReadonlySet<RecoveryStatus>> = {
  DETECTED: new Set(["PLANNED", "WAITING", "ACTION_REQUIRED", "HUMAN_REVIEW", "SUPPRESSED", "RECOVERED"]),
  PLANNED: new Set(["WAITING", "ACTION_REQUIRED", "HUMAN_REVIEW", "SUPPRESSED", "EXHAUSTED", "RECOVERED"]),
  WAITING: new Set(["PLANNED", "ACTION_REQUIRED", "ACTIONED", "HUMAN_REVIEW", "SUPPRESSED", "EXHAUSTED", "RECOVERED"]),
  ACTION_REQUIRED: new Set(["WAITING", "ACTIONED", "HUMAN_REVIEW", "SUPPRESSED", "EXHAUSTED", "RECOVERED"]),
  HUMAN_REVIEW: new Set(["ACTION_REQUIRED", "WAITING", "SUPPRESSED", "EXHAUSTED", "RECOVERED"]),
  ACTIONED: new Set(["WAITING", "PARTIALLY_RECOVERED", "RECOVERED", "SUPPRESSED", "EXHAUSTED", "HUMAN_REVIEW"]),
  PARTIALLY_RECOVERED: new Set(["ACTIONED", "RECOVERED", "SUPPRESSED", "EXHAUSTED", "HUMAN_REVIEW"]),
  RECOVERED: new Set([]),
  SUPPRESSED: new Set([]),
  EXHAUSTED: new Set(["HUMAN_REVIEW", "RECOVERED"])
};

export function canTransition(from: RecoveryStatus, to: RecoveryStatus): boolean {
  return from === to || transitions[from].has(to);
}

export function assertTransition(from: RecoveryStatus, to: RecoveryStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid recovery transition: ${from} -> ${to}`);
  }
}

export function isTerminal(status: RecoveryStatus): boolean {
  return status === "RECOVERED" || status === "SUPPRESSED";
}
