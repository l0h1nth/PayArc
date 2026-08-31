import { randomUUID } from "node:crypto";
import { loadConfig, type AppConfig } from "../src/config.js";
import type { Clock } from "../src/domain/types.js";

export class TestClock implements Clock {
  constructor(public value = 1_800_000_000) {}
  now(): number { return this.value; }
  advance(seconds: number): void { this.value += seconds; }
}

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "3000",
    DATABASE_PATH: ":memory:",
    PAYMENT_PROVIDER_MODE: "mock",
    RAZORPAY_WEBHOOK_SECRET: "test_webhook_secret",
    AUTO_ACTIONS_ENABLED: "false",
    EXTERNAL_ACTIONS_ENABLED: "false",
    GLOBAL_KILL_SWITCH: "false",
    MAX_AUTO_AMOUNT_PAISE: "500000",
    MAX_CONTACTS_PER_CASE: "3",
    CONTACT_COOLDOWN_SECONDS: "0",
    PAYMENT_LINK_TTL_SECONDS: "172800",
    CONTROL_COHORT_PERCENT: "0",
    ALLOWED_CURRENCIES: "INR",
    OPENAI_API_KEY: "",
    OPENAI_MODEL: "",
    ...overrides
  });
}

export function failedPaymentEvent(options: {
  paymentId?: string;
  orderId?: string;
  amount?: number;
  currency?: string;
  reason?: string;
  source?: string;
  createdAt?: number;
  note?: string;
} = {}) {
  const paymentId = options.paymentId ?? `pay_test_${randomUUID().slice(0, 8)}`;
  const orderId = options.orderId ?? `order_test_${randomUUID().slice(0, 8)}`;
  return {
    entity: "event",
    account_id: "acc_test",
    event: "payment.failed",
    contains: ["payment"],
    payload: { payment: { entity: {
      id: paymentId,
      entity: "payment",
      amount: options.amount ?? 99_900,
      currency: options.currency ?? "INR",
      status: "failed",
      order_id: orderId,
      method: "card",
      email: "buyer@example.test",
      contact: "+919000090000",
      error_code: "BAD_REQUEST_ERROR",
      error_reason: options.reason ?? "incorrect_otp",
      error_source: options.source ?? "customer",
      error_step: "payment_authentication",
      notes: options.note ? { note: options.note } : {}
    } } },
    created_at: options.createdAt ?? 1_800_000_000
  };
}

export function linkEvent(options: {
  type: "payment_link.paid" | "payment_link.partially_paid" | "payment_link.expired" | "payment_link.cancelled";
  linkId: string;
  referenceId: string;
  amount: number;
  amountPaid: number;
  createdAt?: number;
}) {
  const status = options.type.split(".")[1];
  return {
    entity: "event",
    account_id: "acc_test",
    event: options.type,
    contains: ["payment_link"],
    payload: { payment_link: { entity: {
      id: options.linkId,
      entity: "payment_link",
      amount: options.amount,
      amount_paid: options.amountPaid,
      currency: "INR",
      status,
      reference_id: options.referenceId,
      short_url: "https://example.test/pay/test",
      expire_by: 1_900_000_000
    } } },
    created_at: options.createdAt ?? 1_800_000_100
  };
}
