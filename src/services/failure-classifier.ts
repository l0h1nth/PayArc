import type { FailureClass, NormalizedEvent } from "../domain/types.js";

const transientReasons = new Set([
  "payment_failed",
  "gateway_technical_error",
  "server_error",
  "timeout",
  "bank_not_available",
  "transaction_timed_out"
]);

const customerActionableReasons = new Set([
  "incorrect_otp",
  "insufficient_funds",
  "payment_cancelled",
  "payment_risk_check_failed",
  "incorrect_pin"
]);

const invalidMethodReasons = new Set([
  "card_expired",
  "card_declined",
  "card_not_supported",
  "invalid_card",
  "mandate_cancelled",
  "token_expired",
  "bank_account_blocked"
]);

const merchantReasons = new Set([
  "merchant_account_disabled",
  "merchant_not_activated",
  "payment_method_not_enabled",
  "invalid_currency",
  "invalid_amount"
]);

export function classifyFailure(event: NormalizedEvent): FailureClass {
  const reason = event.errorReason?.toLowerCase() ?? "";
  const source = event.errorSource?.toLowerCase() ?? "";

  if (merchantReasons.has(reason) || source === "merchant" || event.errorStep === "payment_initiation") {
    return "MERCHANT_CONFIGURATION";
  }
  if (reason.includes("risk") || reason.includes("fraud") || reason.includes("compliance")) {
    return "RISK_OR_COMPLIANCE";
  }
  if (invalidMethodReasons.has(reason) || reason.includes("expired") || reason.includes("mandate")) {
    return "PAYMENT_METHOD_INVALID";
  }
  if (customerActionableReasons.has(reason) || source === "customer") {
    return "CUSTOMER_ACTIONABLE";
  }
  if (transientReasons.has(reason) || source === "gateway" || source === "razorpay") {
    return "TRANSIENT_PROVIDER";
  }
  if (event.type === "subscription.halted") return "PAYMENT_METHOD_INVALID";
  if (event.type === "subscription.pending") return "TRANSIENT_PROVIDER";
  return "UNKNOWN";
}
