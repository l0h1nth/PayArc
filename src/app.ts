import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppConfig, loadConfig, publicConfig } from "./config.js";
import { systemClock, type Clock } from "./domain/types.js";
import {
  DeterministicDecisionProvider,
  FallbackDecisionProvider,
  GroqDecisionProvider,
  OpenAIDecisionProvider,
  type DecisionProvider
} from "./providers/decision-provider.js";
import { MockPaymentProvider } from "./providers/mock-payment-provider.js";
import { ProviderError, type PaymentProvider } from "./providers/payment-provider.js";
import { RazorpayProvider } from "./providers/razorpay-provider.js";
import {
  ClickToChatWhatsAppProvider,
  CloudApiWhatsAppProvider,
  type WhatsAppProvider
} from "./providers/whatsapp-provider.js";
import { signWebhook } from "./security/webhook.js";
import { DemoScenarioRunner, demoScenarios } from "./services/demo-scenarios.js";
import { RecoveryEngine } from "./services/recovery-engine.js";
import { RecoveryChannelOrchestrator } from "./services/recovery-channel-orchestrator.js";
import { RevenueIntelligenceService } from "./services/revenue-intelligence.js";
import { WebhookAuthError, WebhookIngestor, WebhookInputError } from "./services/webhook-ingestor.js";
import { RecoveryRepository } from "./storage/database.js";

export type AppContext = {
  app: FastifyInstance;
  config: AppConfig;
  repository: RecoveryRepository;
  provider: PaymentProvider;
  engine: RecoveryEngine;
  revenueIntelligence: RevenueIntelligenceService;
  ingestor: WebhookIngestor;
  whatsappProvider: WhatsAppProvider;
  channelOrchestrator: RecoveryChannelOrchestrator;
};

export type BuildOptions = {
  config?: AppConfig;
  repository?: RecoveryRepository;
  provider?: PaymentProvider;
  decisionProvider?: DecisionProvider;
  clock?: Clock;
  whatsappProvider?: WhatsAppProvider;
  logger?: boolean;
};

function parseJsonBody<T>(value: unknown, schema: z.ZodType<T>): T {
  return schema.parse(value ?? {});
}

export async function buildApplication(options: BuildOptions = {}): Promise<AppContext> {
  const config = options.config ?? loadConfig();
  const clock = options.clock ?? systemClock;
  const repository = options.repository ?? new RecoveryRepository(config.databasePath);
  const provider = options.provider ?? (config.paymentProviderMode === "razorpay"
    ? new RazorpayProvider({
        keyId: config.razorpay.keyId,
        keySecret: config.razorpay.keySecret,
        baseUrl: config.razorpay.apiBaseUrl
      })
    : new MockPaymentProvider());
  const deterministic = new DeterministicDecisionProvider();
  const configuredAI = config.aiProvider === "groq"
    ? new GroqDecisionProvider({
        apiKey: config.groq.apiKey,
        model: config.groq.model,
        baseUrl: config.groq.baseUrl
      })
    : config.aiProvider === "openai"
      ? new OpenAIDecisionProvider({
          apiKey: config.openai.apiKey,
          model: config.openai.model,
          baseUrl: config.openai.baseUrl
        })
      : null;
  const decisionProvider = options.decisionProvider
    ?? (configuredAI ? new FallbackDecisionProvider(configuredAI, deterministic) : deterministic);
  const whatsappProvider = options.whatsappProvider ?? (config.whatsapp.mode === "cloud_api"
    ? new CloudApiWhatsAppProvider({
        phoneNumberId: config.whatsapp.phoneNumberId,
        accessToken: config.whatsapp.accessToken,
        graphApiBaseUrl: config.whatsapp.graphApiBaseUrl,
        templateName: config.whatsapp.templateName,
        templateLanguage: config.whatsapp.templateLanguage
      })
    : new ClickToChatWhatsAppProvider());
  const channelOrchestrator = new RecoveryChannelOrchestrator(repository, provider, whatsappProvider, config, clock);
  const ingestor = new WebhookIngestor(repository, config.razorpay.webhookSecrets, clock);
  const engine = new RecoveryEngine(repository, provider, decisionProvider, config, clock, channelOrchestrator);
  const revenueIntelligence = new RevenueIntelligenceService(repository, clock);
  const scenarioRepository = config.nodeEnv === "production" ? null : new RecoveryRepository(":memory:");
  const scenarioProvider = scenarioRepository ? new MockPaymentProvider() : null;
  const scenarioConfig: AppConfig = {
    ...config,
    paymentProviderMode: "mock",
    databasePath: ":memory:",
    policy: { ...config.policy, autoActionsEnabled: false, externalActionsEnabled: false },
    whatsapp: { ...config.whatsapp, autoSendEnabled: false }
  };
  const scenarioIngestor = scenarioRepository ? new WebhookIngestor(scenarioRepository, config.razorpay.webhookSecrets, clock) : null;
  const scenarioEngine = scenarioRepository && scenarioProvider
    ? new RecoveryEngine(scenarioRepository, scenarioProvider, deterministic, scenarioConfig, clock)
    : null;
  const demoRunner = scenarioRepository && scenarioProvider && scenarioIngestor && scenarioEngine
    ? new DemoScenarioRunner(scenarioConfig, scenarioRepository, scenarioProvider, scenarioEngine, scenarioIngestor, clock)
    : null;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1_048_576 });
  const realtimeCleanups = new Set<() => void>();

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    if (request.url.startsWith("/webhooks/")) {
      done(null, body);
      return;
    }
    try {
      done(null, body.length ? JSON.parse(body.toString("utf8")) : {});
    } catch (error) {
      done(error as Error);
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/") || !config.operatorApiToken) return;
    const expected = Buffer.from(`Bearer ${config.operatorApiToken}`);
    const received = Buffer.from(request.headers.authorization ?? "");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return reply.code(401).send({ error: "Operator authentication required" });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof z.ZodError ? 400 : 500;
    reply.code(status).send({
      error: status === 500 ? "Internal server error" : "Invalid request",
      details: error instanceof z.ZodError ? error.issues : undefined
    });
  });

  app.get("/health", async () => ({ status: "ok", provider: provider.mode, audit: repository.verifyAuditChain() }));
  app.get("/api/config", async () => publicConfig(config));
  app.get("/api/metrics", async () => repository.metrics());
  app.get("/api/revenue/snapshot", async () => revenueIntelligence.snapshot());
  app.get<{ Querystring: { limit?: string } }>("/api/revenue/operations", async (request) => {
    const limit = Math.min(500, Math.max(1, Number.parseInt(request.query.limit ?? "100", 10) || 100));
    return repository.listRevenueOperations(limit);
  });
  app.get("/api/cases", async () => repository.listCases());
  app.get<{ Params: { id: string } }>("/api/cases/:id", async (request, reply) => {
    const recoveryCase = repository.getCase(request.params.id);
    if (!recoveryCase) return reply.code(404).send({ error: "Case not found" });
    const actions = repository.listActions(recoveryCase.id);
    return {
      case: recoveryCase,
      actions,
      deliveries: repository.listChannelDeliveries(recoveryCase.id),
      // Keep transaction inspection on the local ledger's fast path. Contact and
      // consent resolution can require several Razorpay reads and is loaded only
      // when the operator opens the WhatsApp delivery surface.
      channelReadiness: null,
      audit: repository.listAudit(recoveryCase.id)
    };
  });
  app.get<{ Params: { id: string } }>("/api/actions/:id/channel-readiness", async (request, reply) => {
    if (!repository.getAction(request.params.id)) return reply.code(404).send({ error: "Action not found" });
    return channelOrchestrator.readiness(request.params.id);
  });
  app.get("/api/actions", async () => repository.listActions());
  app.get<{ Querystring: { limit?: string } }>("/api/events", async (request) => {
    const limit = Math.min(500, Math.max(1, Number.parseInt(request.query.limit ?? "100", 10) || 100));
    return repository.listEventSummaries(limit);
  });
  app.get<{ Querystring: { limit?: string } }>("/api/audit/recent", async (request) => {
    const limit = Math.min(100, Math.max(1, Number.parseInt(request.query.limit ?? "30", 10) || 30));
    return repository.listAudit().slice(-limit).reverse();
  });
  app.get("/api/audit/verify", async () => repository.verifyAuditChain());
  app.get("/api/realtime", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    let revision = repository.revision();
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ revision })}\n\n`);
    const changes = setInterval(() => {
      const next = repository.revision();
      if (next === revision) return;
      revision = next;
      reply.raw.write(`event: sync\ndata: ${JSON.stringify({ revision })}\n\n`);
    }, 750);
    const heartbeat = setInterval(() => reply.raw.write(": keepalive\n\n"), 15_000);
    const cleanup = () => {
      clearInterval(changes);
      clearInterval(heartbeat);
      realtimeCleanups.delete(cleanup);
    };
    realtimeCleanups.add(cleanup);
    request.raw.once("close", cleanup);
  });

  app.post("/webhooks/razorpay", async (request, reply) => {
    try {
      if (!Buffer.isBuffer(request.body)) throw new WebhookInputError("Expected a raw request body");
      const result = ingestor.ingest(
        request.body,
        request.headers["x-razorpay-signature"] as string | undefined,
        request.headers["x-razorpay-event-id"] as string | undefined
      );
      if (result.eventRowId !== null) {
        const stored = repository.getEvent(result.eventRowId);
        if (stored) {
          repository.observeRazorpayTestEvent(stored.normalized, clock.now());
          revenueIntelligence.observeProviderEvent(stored.normalized);
        }
      }
      return reply.code(result.duplicate ? 200 : 202).send({ accepted: true, duplicate: result.duplicate });
    } catch (error) {
      if (error instanceof WebhookAuthError) return reply.code(401).send({ error: error.message });
      if (error instanceof WebhookInputError || error instanceof z.ZodError || error instanceof SyntaxError) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid webhook" });
      }
      throw error;
    }
  });

  app.post("/api/worker/run", async () => engine.processPending(100));

  app.post<{ Params: { id: string } }>("/api/revenue/incidents/:id/resolve", async (request, reply) => {
    try { return revenueIntelligence.resolveIncident(request.params.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Incident resolution failed" }); }
  });
  app.post<{ Params: { id: string } }>("/api/revenue/incidents/:id/release", async (request, reply) => {
    try { return revenueIntelligence.releaseIncident(request.params.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Traffic release failed" }); }
  });
  app.post<{ Params: { id: string } }>("/api/revenue/journeys/:id/recover", async (request, reply) => {
    try { return revenueIntelligence.recoverJourney(request.params.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Journey recovery failed" }); }
  });
  app.post<{ Body: unknown }>("/api/revenue/journeys", async (request, reply) => {
    try {
      const body = parseJsonBody(request.body, z.object({
        customerRef: z.string().min(3).max(80),
        orderId: z.string().min(3).max(100).optional(),
        amount: z.number().int().positive().max(100_000_000),
        currency: z.string().length(3).default("INR"),
        originalCheckoutUrl: z.string().url().max(500),
        checkoutExpiresAt: z.number().int().positive(),
        paymentMethod: z.string().min(2).max(40).optional()
      }));
      return reply.code(201).send(revenueIntelligence.registerJourney(body));
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "Journey registration failed" }); }
  });
  app.post<{ Params: { id: string }; Body: unknown }>("/api/revenue/journeys/:id/signal", async (request, reply) => {
    try {
      const body = parseJsonBody(request.body, z.object({
        stage: z.enum(["CHECKOUT_OPENED", "METHOD_SELECTED", "OTP", "FAILED", "ABANDONED", "PAID"]),
        customerActive: z.boolean(),
        paymentMethod: z.string().min(2).max(40).optional()
      }));
      return revenueIntelligence.signalJourney(request.params.id, body);
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Journey signal failed" }); }
  });
  app.post<{ Params: { id: string } }>("/api/revenue/journeys/:id/pay", async (request, reply) => {
    try { return revenueIntelligence.payJourney(request.params.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Payment verification failed" }); }
  });
  app.post<{ Params: { id: string } }>("/api/revenue/subscriptions/:id/advance", async (request, reply) => {
    try { return revenueIntelligence.advanceSubscription(request.params.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Subscription workflow failed" }); }
  });
  app.post<{ Params: { id: string } }>("/api/revenue/receivables/:id/contact", async (request, reply) => {
    try { return revenueIntelligence.contactReceivable(request.params.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Receivable contact failed" }); }
  });
  app.post<{ Params: { id: string } }>("/api/revenue/receivables/:id/resolve-blocker", async (request, reply) => {
    try { return revenueIntelligence.resolveReceivableBlocker(request.params.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Blocker resolution failed" }); }
  });
  app.post<{ Params: { id: string } }>("/api/revenue/mandates/:id/advance", async (request, reply) => {
    try { return revenueIntelligence.advanceMandate(request.params.id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Mandate sequencing failed" }); }
  });
  app.post<{ Params: { id: string }; Body: unknown }>("/api/revenue/conversations/:id/respond", async (request, reply) => {
    try {
      const body = parseJsonBody(request.body, z.object({ intent: z.enum(["PROMISE_TOMORROW", "SEND_UPI", "ALREADY_PAID", "OPT_OUT"]) }));
      return revenueIntelligence.respondConversation(request.params.id, body.intent);
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Conversation response failed" }); }
  });
  app.post<{ Params: { id: string }; Body: unknown }>("/api/revenue/promises/:id/outcome", async (request, reply) => {
    try {
      const body = parseJsonBody(request.body, z.object({ outcome: z.enum(["KEPT", "MISSED", "CANCELLED"]) }));
      return revenueIntelligence.updatePromise(request.params.id, body.outcome);
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Promise update failed" }); }
  });
  app.post<{ Body: unknown }>("/api/revenue/portfolio/optimize", async (request) => {
    const body = parseJsonBody(request.body, z.object({ budget: z.number().int().min(1).max(25).default(6) }));
    return { recommendations: revenueIntelligence.optimizePortfolio(body.budget) };
  });
  app.post("/api/revenue/batch/run", async () => revenueIntelligence.runBatch());

  app.post<{ Params: { id: string } }>("/api/actions/:id/approve", async (request, reply) => {
    try {
      return engine.approveAction(request.params.id);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Approval failed" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/actions/:id/execute", async (request, reply) => {
    try {
      return await engine.executeAction(request.params.id);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Execution failed" });
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/actions/:id/whatsapp", async (request, reply) => {
    const body = parseJsonBody(request.body, z.object({
      consentConfirmed: z.literal(true)
    }));
    try {
      return await channelOrchestrator.deliver(request.params.id, { operatorConsent: body.consentConfirmed });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "WhatsApp delivery failed" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/cases/:id/suppress", async (request, reply) => {
    try {
      return engine.suppressCase(request.params.id);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Suppression failed" });
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/cases/:id/pause", async (request, reply) => {
    try {
      const body = parseJsonBody(request.body, z.object({ until: z.number().int().positive() }));
      return engine.pauseCase(request.params.id, body.until);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Pause failed" });
    }
  });

  const demoFailureSchema = z.object({
    amount: z.number().int().positive().max(10_000_000).default(99_900),
    currency: z.string().length(3).default("INR"),
    errorReason: z.string().default("incorrect_otp"),
    errorSource: z.string().default("customer"),
    untrustedNote: z.string().max(500).optional()
  });

  const razorpayTestRunSchema = z.object({
    amount: z.number().int().min(100).max(10_000_000).default(98_900),
    currency: z.literal("INR").default("INR"),
    description: z.string().trim().min(3).max(120).default("PayArc revenue recovery test")
  });

  app.get("/api/razorpay-test/runs", async () => ({
    available: provider.mode === "razorpay",
    reason: provider.mode === "razorpay" ? null : "Set PAYMENT_PROVIDER_MODE=razorpay with Test Mode keys to enable genuine checkout runs.",
    checkoutKeyId: provider.mode === "razorpay" ? config.razorpay.keyId : null,
    runs: repository.listRazorpayTestRuns(20)
  }));

  app.post<{ Body: unknown }>("/api/razorpay-test/runs", async (request, reply) => {
    if (provider.mode !== "razorpay") {
      return reply.code(409).send({ error: "Razorpay Test Mode is not connected" });
    }
    const input = parseJsonBody(request.body, razorpayTestRunSchema);
    const id = `rtest_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const receipt = `payarc_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    try {
      const order = await provider.createCheckoutOrder({
        amount: input.amount,
        currency: input.currency,
        receipt,
        notes: { payarc_test_run: id, purpose: "revenue_recovery_proof" }
      });
      if (order.amount !== input.amount || order.currency !== input.currency || order.receipt !== receipt) {
        throw new Error("Razorpay returned contradictory order parameters");
      }
      const run = repository.createRazorpayTestRun({
        id,
        providerOrderId: order.id,
        amount: order.amount,
        currency: order.currency,
        description: input.description,
        now: clock.now()
      });
      return reply.code(201).send({ run, checkoutKeyId: config.razorpay.keyId });
    } catch (error) {
      const status = error instanceof ProviderError && error.status === 429 ? 429 : 502;
      return reply.code(status).send({ error: error instanceof Error ? error.message : "Unable to create Razorpay Test Order" });
    }
  });

  app.post<{ Params: { runId: string }; Body: unknown }>("/api/razorpay-test/runs/:runId/verify", async (request, reply) => {
    if (provider.mode !== "razorpay") return reply.code(409).send({ error: "Razorpay Test Mode is not connected" });
    const run = repository.getRazorpayTestRun(request.params.runId);
    if (!run) return reply.code(404).send({ error: "Razorpay Test Run not found" });
    const input = parseJsonBody(request.body, z.object({
      paymentId: z.string().min(6).max(100),
      orderId: z.string().min(6).max(100),
      signature: z.string().regex(/^[a-f0-9]{64}$/i)
    }));
    if (input.orderId !== run.providerOrderId) return reply.code(409).send({ error: "Checkout order does not match the Test Run" });
    const expected = createHmac("sha256", config.razorpay.keySecret)
      .update(`${run.providerOrderId}|${input.paymentId}`)
      .digest("hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    const receivedBuffer = Buffer.from(input.signature, "hex");
    if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
      return reply.code(401).send({ error: "Razorpay checkout signature is invalid" });
    }
    try {
      const payment = await provider.fetchPayment(input.paymentId);
      if (payment.orderId !== run.providerOrderId || payment.amount !== run.amount || payment.currency !== run.currency) {
        return reply.code(409).send({ error: "Razorpay payment does not match the Test Run financial envelope" });
      }
      if (!["authorized", "captured"].includes(payment.status)) {
        return reply.code(409).send({ error: `Razorpay payment is ${payment.status}, not successful` });
      }
      const status = payment.status === "captured" ? "PAYMENT_SUCCEEDED" as const : "PAYMENT_AUTHORIZED" as const;
      return repository.markRazorpayTestRunVerified(run.id, payment.id, status, clock.now());
    } catch (error) {
      const status = error instanceof ProviderError && error.status === 404 ? 404 : 502;
      return reply.code(status).send({ error: error instanceof Error ? error.message : "Unable to verify Razorpay payment" });
    }
  });

  app.get("/api/demo/scenarios", async (request, reply) => {
    if (config.nodeEnv === "production" || !demoRunner) {
      return reply.code(404).send({ error: "Scenario Lab is available only outside production" });
    }
    return { count: demoScenarios.length, scenarios: demoScenarios };
  });

  app.get("/api/demo/runs", async (request, reply) => {
    if (config.nodeEnv === "production" || !demoRunner) {
      return reply.code(404).send({ error: "Scenario Lab is available only outside production" });
    }
    const runs = demoRunner.listRuns();
    return { count: runs.length, runs };
  });

  app.get<{ Params: { runId: string } }>("/api/demo/runs/:runId", async (request, reply) => {
    if (config.nodeEnv === "production" || !demoRunner) {
      return reply.code(404).send({ error: "Scenario Lab is available only outside production" });
    }
    const run = demoRunner.getRun(request.params.runId);
    return run ?? reply.code(404).send({ error: "Scenario run not found" });
  });

  app.post<{ Params: { scenarioId: string } }>("/api/demo/scenarios/:scenarioId/run", async (request, reply) => {
    if (config.nodeEnv === "production" || !demoRunner) {
      return reply.code(404).send({ error: "Scenario Lab is available only outside production" });
    }
    if (!demoScenarios.some((item) => item.id === request.params.scenarioId)) {
      return reply.code(404).send({ error: "Scenario not found" });
    }
    return reply.code(201).send(await demoRunner.run(request.params.scenarioId));
  });

  app.post<{ Body: unknown }>("/api/demo/failure", async (request, reply) => {
    if (config.nodeEnv === "production" || !(provider instanceof MockPaymentProvider)) {
      return reply.code(404).send({ error: "Demo endpoint is available only in local mock mode" });
    }
    const input = parseJsonBody(request.body, demoFailureSchema);
    const paymentId = `pay_demo_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const orderId = `order_demo_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    provider.seedPayment({
      id: paymentId,
      amount: input.amount,
      currency: input.currency.toUpperCase(),
      status: "failed",
      orderId,
      invoiceId: null,
      method: "card",
      email: "demo@example.test",
      contact: "+919000090000",
      errorCode: "BAD_REQUEST_ERROR",
      errorReason: input.errorReason,
      errorSource: input.errorSource,
      errorStep: "payment_authentication"
    });
    const event = {
      entity: "event",
      account_id: "acc_demo",
      event: "payment.failed",
      contains: ["payment"],
      payload: { payment: { entity: {
        id: paymentId,
        entity: "payment",
        amount: input.amount,
        currency: input.currency.toUpperCase(),
        status: "failed",
        order_id: orderId,
        method: "card",
        email: "demo@example.test",
        contact: "+919000090000",
        error_code: "BAD_REQUEST_ERROR",
        error_reason: input.errorReason,
        error_source: input.errorSource,
        error_step: "payment_authentication",
        notes: input.untrustedNote ? { customer_note: input.untrustedNote } : {}
      } } },
      created_at: clock.now()
    };
    const raw = Buffer.from(JSON.stringify(event));
    const eventId = `evt_demo_${randomUUID()}`;
    ingestor.ingest(raw, signWebhook(raw, config.razorpay.webhookSecrets[0]!), eventId);
    const worker = await engine.processPending(10);
    const recoveryCase = repository.findCaseForEvent({
      providerEventId: eventId,
      type: "payment.failed",
      occurredAt: clock.now(),
      entityType: "payment",
      entityId: paymentId,
      paymentId,
      untrustedTextSignals: []
    });
    return reply.code(201).send({ worker, case: recoveryCase, actions: recoveryCase ? repository.listActions(recoveryCase.id) : [] });
  });

  app.post<{ Params: { actionId: string }; Body: unknown }>("/api/demo/actions/:actionId/pay", async (request, reply) => {
    if (config.nodeEnv === "production" || !(provider instanceof MockPaymentProvider)) {
      return reply.code(404).send({ error: "Demo endpoint is available only in local mock mode" });
    }
    const action = repository.getAction(request.params.actionId);
    if (!action?.providerReference) return reply.code(409).send({ error: "Action does not have an active Payment Link" });
    const body = parseJsonBody(request.body, z.object({ amountPaid: z.number().int().positive().optional() }));
    const recoveryCase = repository.getCase(action.caseId)!;
    const link = provider.setLinkOutcome(action.providerReference, body.amountPaid ?? recoveryCase.amount ?? 0);
    const eventType = link.status === "paid" ? "payment_link.paid" : "payment_link.partially_paid";
    const event = {
      entity: "event",
      account_id: "acc_demo",
      event: eventType,
      contains: ["payment_link"],
      payload: { payment_link: { entity: {
        id: link.id,
        entity: "payment_link",
        amount: link.amount,
        amount_paid: link.amountPaid,
        currency: link.currency,
        status: link.status,
        reference_id: link.referenceId,
        short_url: link.shortUrl,
        expire_by: link.expireBy
      } } },
      created_at: clock.now()
    };
    const raw = Buffer.from(JSON.stringify(event));
    ingestor.ingest(raw, signWebhook(raw, config.razorpay.webhookSecrets[0]!), `evt_demo_${randomUUID()}`);
    const worker = await engine.processPending(10);
    return { worker, case: repository.getCase(action.caseId) };
  });

  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL("../public", import.meta.url)),
    prefix: "/"
  });

  app.addHook("onClose", async () => {
    for (const cleanup of realtimeCleanups) cleanup();
    if (!options.repository) repository.close();
    scenarioRepository?.close();
  });

  return { app, config, repository, provider, engine, revenueIntelligence, ingestor, whatsappProvider, channelOrchestrator };
}
