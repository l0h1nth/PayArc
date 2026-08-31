import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicDecisionProvider, FallbackDecisionProvider, OpenAIDecisionProvider } from "../src/providers/decision-provider.js";
import { RazorpayProvider } from "../src/providers/razorpay-provider.js";
import { ClickToChatWhatsAppProvider, CloudApiWhatsAppProvider } from "../src/providers/whatsapp-provider.js";
import type { DecisionInput } from "../src/domain/types.js";

const decisionInput: DecisionInput = {
  eventType: "payment.failed", entityType: "payment", amount: 99_900, currency: "INR",
  paymentMethod: "card", failureClass: "CUSTOMER_ACTIONABLE", errorCode: "BAD_REQUEST_ERROR",
  errorReason: "incorrect_otp", errorSource: "customer", errorStep: "payment_authentication",
  subscriptionState: null, previousInterventions: 0, previousContacts: 0, isControl: false
};

test("Razorpay adapter uses Basic auth, exact test-mode amount, and no provider reminders", async () => {
  let request: { url: string; init: RequestInit } | null = null;
  const provider = new RazorpayProvider({
    keyId: "rzp_test_key",
    keySecret: "secret",
    baseUrl: "https://api.razorpay.com/v1",
    fetchImpl: async (input, init) => {
      request = { url: String(input), init: init ?? {} };
      return new Response(JSON.stringify({
        id: "plink_test", reference_id: "ref_test", amount: 99900, amount_paid: 0,
        currency: "INR", status: "created", short_url: "https://rzp.io/test", expire_by: 1900000000
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const link = await provider.createPaymentLink({
    amount: 99_900, currency: "INR", referenceId: "ref_test", description: "Recovery",
    expireBy: 1_900_000_000, customerEmail: "a@example.test", customerContact: null,
    notes: { recovery_case: "case_test" }
  });
  assert.equal(link.id, "plink_test");
  assert.ok(request);
  const captured = request as unknown as { url: string; init: RequestInit };
  assert.equal(captured.url, "https://api.razorpay.com/v1/payment_links");
  assert.equal((captured.init.headers as Record<string, string>).authorization, `Basic ${Buffer.from("rzp_test_key:secret").toString("base64")}`);
  const body = JSON.parse(String(captured.init.body));
  assert.equal(body.amount, 99_900);
  assert.equal(body.reminder_enable, false);
  assert.deepEqual(body.notify, { email: false, sms: false });
  assert.equal("customer" in body, false);
});

test("Razorpay adapter refuses live credentials", () => {
  assert.throws(() => new RazorpayProvider({ keyId: "rzp_live_key", keySecret: "secret", baseUrl: "https://api.razorpay.com/v1" }));
});

test("Razorpay adapter never serializes optional webhook customer data", async () => {
  let requestBody: Record<string, unknown> = {};
  const provider = new RazorpayProvider({
    keyId: "rzp_test_key", keySecret: "secret", baseUrl: "https://api.razorpay.com/v1",
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: "plink_without_customer", reference_id: "ref_empty", amount: 98900,
        amount_paid: 0, currency: "INR", status: "created",
        short_url: "https://rzp.io/test-empty", expire_by: 1900000000
      }), { status: 200 });
    }
  });
  await provider.createPaymentLink({
    amount: 98_900, currency: "INR", referenceId: "ref_empty", description: "Recovery",
    expireBy: 1_900_000_000, customerEmail: "buyer@example.test",
    customerContact: "+919876543210", notes: {}
  });
  assert.equal("customer" in requestBody, false);
});

test("safe Razorpay reads retry transient failures", async () => {
  let calls = 0;
  const provider = new RazorpayProvider({
    keyId: "rzp_test_key", keySecret: "secret", baseUrl: "https://api.razorpay.com/v1",
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ error: { description: "temporary" } }), { status: 500 });
      return new Response(JSON.stringify({ id: "pay_test", amount: 100, currency: "INR", status: "failed" }), { status: 200 });
    }
  });
  assert.equal((await provider.fetchPayment("pay_test")).id, "pay_test");
  assert.equal(calls, 2);
});

test("WhatsApp click-to-chat prepares an encoded recovery message without an API call", async () => {
  const result = await new ClickToChatWhatsAppProvider().deliver({
    recipient: "+91 98765 43210", amountDisplay: "INR 989",
    paymentUrl: "https://rzp.io/rzp/test", caseReference: "case_test"
  });
  assert.equal(result.status, "PREPARED");
  assert.match(result.deliveryUrl!, /^https:\/\/wa\.me\/919876543210\?text=/);
  assert.match(decodeURIComponent(result.deliveryUrl!), /Reply STOP to opt out/);
});

test("WhatsApp Cloud API sends only an approved template payload", async () => {
  let captured: { url: string; body: Record<string, unknown> } | null = null;
  const provider = new CloudApiWhatsAppProvider({
    phoneNumberId: "phone_123", accessToken: "token", graphApiBaseUrl: "https://graph.facebook.com/v23.0",
    templateName: "recovery_payment_link", templateLanguage: "en_US",
    fetchImpl: async (input, init) => {
      captured = { url: String(input), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ messages: [{ id: "wamid_test" }] }), { status: 200 });
    }
  });
  const result = await provider.deliver({ recipient: "+919876543210", amountDisplay: "INR 989", paymentUrl: "https://rzp.io/test", caseReference: "case_test" });
  assert.equal(result.providerReference, "wamid_test");
  assert.ok(captured);
  assert.equal((captured as { url: string }).url, "https://graph.facebook.com/v23.0/phone_123/messages");
  assert.equal((captured as { body: { type: string } }).body.type, "template");
});

test("OpenAI decision provider consumes strict structured output without tools", async () => {
  let requestBody: Record<string, unknown> | null = null;
  const provider = new OpenAIDecisionProvider({
    apiKey: "test", model: "test-model", baseUrl: "https://api.openai.com/v1",
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ output_text: JSON.stringify({
        action: "SEND_RECOVERY_LINK", confidence: 0.91, reason: "Customer can retry safely",
        delay_seconds: 900, requires_human_approval: false
      }) }), { status: 200 });
    }
  });
  const result = await provider.decide(decisionInput);
  assert.equal(result.provider, "openai");
  assert.equal(result.action, "SEND_RECOVERY_LINK");
  assert.ok(requestBody);
  assert.equal((requestBody as Record<string, unknown>).store, false);
  assert.equal("tools" in (requestBody as Record<string, unknown>), false);
});

test("invalid AI output fails closed to deterministic decision", async () => {
  const primary = new OpenAIDecisionProvider({
    apiKey: "test", model: "test-model", baseUrl: "https://api.openai.com/v1",
    fetchImpl: async () => new Response(JSON.stringify({ output_text: '{"action":"TRANSFER_MONEY"}' }), { status: 200 })
  });
  const result = await new FallbackDecisionProvider(primary, new DeterministicDecisionProvider()).decide(decisionInput);
  assert.equal(result.provider, "deterministic");
  assert.equal(result.action, "SEND_RECOVERY_LINK");
});
