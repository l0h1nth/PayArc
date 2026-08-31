import type { RecoveryCase } from "./types.js";

const actionableStatuses = new Set<RecoveryCase["status"]>([
  "ACTION_REQUIRED",
  "HUMAN_REVIEW",
  "PARTIALLY_RECOVERED"
]);

const notifiableStatuses = new Set<RecoveryCase["status"]>([
  "DETECTED",
  "PLANNED",
  "ACTION_REQUIRED",
  "HUMAN_REVIEW",
  "WAITING",
  "ACTIONED",
  "PARTIALLY_RECOVERED"
]);

export function isActionableCase(item: RecoveryCase): boolean {
  return actionableStatuses.has(item.status);
}

export function isNotifiableCase(item: RecoveryCase): boolean {
  return notifiableStatuses.has(item.status);
}

export function notificationRevisionKey(item: RecoveryCase): string {
  return [
    item.id,
    item.status,
    item.updatedAt,
    item.recoveredAmount,
    item.interventionCount,
    item.contactCount
  ].join(":");
}

export function caseNotificationState(cases: RecoveryCase[], readKeys: ReadonlySet<string>) {
  const actionable = cases.filter(isActionableCase);
  const open = cases.filter(isNotifiableCase);
  const unread = open.filter((item) => !readKeys.has(notificationRevisionKey(item)));
  const unreadIds = new Set(unread.map((item) => item.id));
  return {
    actionable,
    open,
    unread,
    ordered: [...unread, ...open.filter((item) => !unreadIds.has(item.id))]
  };
}
