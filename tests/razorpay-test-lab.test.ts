import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { buildApplication } from "../src/app.js";
import { RazorpayProvider } from "../src/providers/razorpay-provider.js";
import { signWebhook } from "../src/security/webhook.js";
import { RecoveryRepository } from "../src/storage/database.js";
import { failedPaymentEvent, TestClock, testConfig } from "./helpers.js";

function setup() {
  const clock = new TestClock();
  const repository = new RecoveryRepository(":memory:");
  const config = testConfig({
    PAYMENT_PROVIDER_MODE: "razorpay",
    RAZORPAY_KEY_ID: "rzp_test_payarc",
    RAZORPAY_KEY_SECRET: "checkout_secret"
  });
  const orderId = "order_real_test_123";
  const provider = new RazorpayProvider({
    keyId: config.razorpay.keyId,
    keySecret: config.razorpay.keySecret,
    baseUrl: config.razorpay.apiBaseUrl,
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/orders") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { amount: number; currency: string; receipt: string };
        return new Response(JSON.stringify({ id: orderId, ...body, status: "created" }), { status: 200 });
      }
      if (url.includes("/payments/pay_real_success")) {
        return new Response(JSON.stringify({
          id: "pay_real_success", order_id: orderId, amount: 98_900,
          currency: "INR", status: "captured", notes: {}
        }), { status: 200 });
      }
      if (url.includes("/payments/pay_real_failed")) {
        return new Response(JSON.stringify({
          id: "pay_real_failed", order_id: orderId, amount: 98_900,
          currency: "INR", status: "failed", method: "card",
          error_code: "BAD_REQUEST_ERROR", error_reason: "incorrect_otp",
          error_source: "customer", error_step: "payment_authentication", notes: {}
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { description: "not found" } }), { status: 404 });
    }
  });
  return { clock, repository, config, provider, orderId };
}

test("real Razorpay Test Run creates an Order and signed failure enters Recovery Cases", async () => {
  const fixture = setup();
  const context = await buildApplication({
    config: fixture.config, repository: fixture.repository,
    provider: fixture.provider, clock: fixture.clock
  });
  const createdResponse = await context.app.inject({
    method: "POST", url: "/api/razorpay-test/runs",
    payload: { amount: 98_900, currency: "INR", description: "Real failure proof" }
  });
  assert.equal(createdResponse.statusCode, 201, createdResponse.body);
  const created = createdResponse.json();
  assert.equal(created.run.providerOrderId, fixture.orderId);
  assert.equal(created.run.status, "CHECKOUT_READY");
  assert.equal(created.checkoutKeyId, "rzp_test_payarc");

  const event = failedPaymentEvent({
    paymentId: "pay_real_failed", orderId: fixture.orderId,
    amount: 98_900, reason: "incorrect_otp", source: "customer"
  });
  const raw = JSON.stringify(event);
  const webhook = await context.app.inject({
    method: "POST", url: "/webhooks/razorpay", payload: raw,
    headers: {
      "content-type": "application/json",
      "x-razorpay-event-id": "evt_real_test_failure",
      "x-razorpay-signature": signWebhook(raw, fixture.config.razorpay.webhookSecrets[0]!)
    }
  });
  assert.equal(webhook.statusCode, 202, webhook.body);
  assert.equal((await context.app.inject({ method: "GET", url: "/api/razorpay-test/runs" })).json().runs[0].status, "FAILURE_RECEIVED");

  const worker = await context.engine.processPending(10);
  assert.equal(worker.completed, 1);
  const lab = (await context.app.inject({ method: "GET", url: "/api/razorpay-test/runs" })).json();
  assert.equal(lab.available, true);
  assert.equal(lab.runs[0].status, "FAILURE_RECEIVED");
  assert.ok(lab.runs[0].caseId);
  assert.equal(lab.runs[0].caseStatus, "ACTION_REQUIRED");
  const cases = (await context.app.inject({ method: "GET", url: "/api/cases" })).json();
  assert.equal(cases[0].orderId, fixture.orderId);
  assert.equal(cases[0].paymentId, "pay_real_failed");

  await context.app.close();
  fixture.repository.close();
});

test("successful Razorpay Test checkout callback is HMAC and provider verified", async () => {
  const fixture = setup();
  const context = await buildApplication({
    config: fixture.config, repository: fixture.repository,
    provider: fixture.provider, clock: fixture.clock
  });
  const created = (await context.app.inject({
    method: "POST", url: "/api/razorpay-test/runs",
    payload: { amount: 98_900, currency: "INR", description: "Real success proof" }
  })).json();
  const signature = createHmac("sha256", fixture.config.razorpay.keySecret)
    .update(`${fixture.orderId}|pay_real_success`).digest("hex");
  const verified = await context.app.inject({
    method: "POST", url: `/api/razorpay-test/runs/${created.run.id}/verify`,
    payload: { paymentId: "pay_real_success", orderId: fixture.orderId, signature }
  });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal(verified.json().status, "PAYMENT_SUCCEEDED");
  assert.equal(verified.json().caseId, null, "successful payments are not revenue recovery cases");

  const rejected = await context.app.inject({
    method: "POST", url: `/api/razorpay-test/runs/${created.run.id}/verify`,
    payload: { paymentId: "pay_real_success", orderId: fixture.orderId, signature: "0".repeat(64) }
  });
  assert.equal(rejected.statusCode, 401);

  await context.app.close();
  fixture.repository.close();
});
