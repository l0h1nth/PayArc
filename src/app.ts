import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { type AppConfig, loadConfig, publicConfig } from "./config.js";
import { systemClock, type Clock, type RecoveryCase, type StoredAction } from "./domain/types.js";
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]!);
}

function recoveryPage(input: {
  title: string;
  message: string;
  amount?: string | undefined;
  destination?: string;
  refreshSeconds?: number;
  tone?: "blue" | "green" | "amber";
}): string {
  const destination = input.destination ? escapeHtml(input.destination) : null;
  const refresh = input.refreshSeconds === undefined ? "" : `<meta http-equiv="refresh" content="${input.refreshSeconds}${destination ? `;url=${destination}` : ""}">`;
  const action = destination ? `<a class="action" href="${destination}">Continue securely</a>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>${escapeHtml(input.title)} · PayArc</title><style>
  :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#182238;background:#f4f7fc}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 80% 10%,#dbeafe 0,transparent 30%),#f4f7fc}.card{width:min(100%,460px);background:#fff;border:1px solid #dbe3ef;border-radius:22px;box-shadow:0 24px 70px #1e3a5f1c;overflow:hidden}.top{height:9px;background:${input.tone === "green" ? "#12a06a" : input.tone === "amber" ? "#d78808" : "#2874f0"}}.body{padding:34px}.brand{display:flex;align-items:center;gap:11px;font-weight:800;font-size:20px}.mark{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:#2874f0;color:#fff}.eyebrow{margin:30px 0 8px;color:#64748b;font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}h1{margin:0;font-size:28px;line-height:1.2}p{font-size:16px;line-height:1.6;color:#56657a}.amount{margin:24px 0;padding:16px 18px;border-radius:13px;background:#f3f7fd;font-size:23px;font-weight:800}.action{display:block;margin-top:24px;padding:14px 18px;border-radius:10px;background:#2874f0;color:#fff;text-decoration:none;text-align:center;font-weight:750}.foot{margin-top:22px;font-size:12px;color:#8290a3}.pulse{display:inline-block;width:8px;height:8px;margin-right:7px;border-radius:50%;background:#12a06a;box-shadow:0 0 0 5px #12a06a20}</style></head><body><main class="card"><div class="top"></div><div class="body"><div class="brand"><span class="mark">P</span>PayArc</div><div class="eyebrow">Smart recovery session</div><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.message)}</p>${input.amount ? `<div class="amount">${escapeHtml(input.amount)}</div>` : ""}${action}<div class="foot"><span class="pulse"></span>Payment status is verified with Razorpay. This page never asks for card or UPI credentials.</div></div></main></body></html>`;
}

function approvedRecoveryDestination(value: string, allowMock: boolean): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (
      url.hostname === "rzp.io" || url.hostname === "razorpay.com" || url.hostname.endsWith(".razorpay.com") ||
      (allowMock && url.hostname === "example.test")
    );
  } catch {
    return false;
  }
}

function classifyWhatsAppIntent(text: string): "OPT_OUT" | "PROMISE_TOMORROW" | "SEND_UPI" | "ALREADY_PAID" | "UNKNOWN" {
  const normalized = text.trim().toLowerCase();
  if (/\b(stop|unsubscribe|opt[ -]?out|band|mat bhej|nahi chahiye)\b/.test(normalized)) return "OPT_OUT";
  if (/\b(already paid|paid already|payment done|pay kar diya|kar diya|ho gaya)\b/.test(normalized)) return "ALREADY_PAID";
  if (/\b(upi|gpay|google pay|phonepe|paytm)\b/.test(normalized)) return "SEND_UPI";
  if (/\b(tomorrow|kal|salary|next day)\b/.test(normalized)) return "PROMISE_TOMORROW";
  return "UNKNOWN";
}

type PresentedCase = RecoveryCase & {
  automation: null | Pick<StoredAction, "id" | "type" | "status" | "attemptCount" | "maxAttempts" | "nextAttemptAt" | "lastAttemptAt">;
};

function presentCases(repository: RecoveryRepository): PresentedCase[] {
  const latestActions = new Map(repository.listLatestActionsByCase().map((action) => [action.caseId, action]));
  return repository.listCases().map((recoveryCase) => {
    const action = latestActions.get(recoveryCase.id);
    return {
      ...recoveryCase,
      automation: action ? {
        id: action.id,
        type: action.type,
        status: action.status,
        attemptCount: action.attemptCount,
        maxAttempts: action.maxAttempts,
        nextAttemptAt: action.nextAttemptAt,
        lastAttemptAt: action.lastAttemptAt
      } : null
    };
  });
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
  const revenueIntelligence = new RevenueIntelligenceService(repository, clock);
  const channelOrchestrator = new RecoveryChannelOrchestrator(repository, provider, whatsappProvider, config, clock);
  const ingestor = new WebhookIngestor(repository, config.razorpay.webhookSecrets, clock);
  const engine = new RecoveryEngine(repository, provider, decisionProvider, config, clock, {
    onFailureObserved: (event, recoveryCase, action) => revenueIntelligence.observeRecoveryFailure(event, recoveryCase, action),
    onActionSucceeded: async (actionId) => {
      revenueIntelligence.onRecoveryActionSucceeded(actionId);
      await channelOrchestrator.onActionSucceeded(actionId);
    }
  });
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
    if (status === 500) app.log.error(error);
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
  app.get("/api/cases", async () => presentCases(repository));
  app.get<{ Params: { id: string } }>("/api/cases/:id", async (request, reply) => {
    const recoveryCase = repository.getCase(request.params.id);
    if (!recoveryCase) return reply.code(404).send({ error: "Case not found" });
    const actions = repository.listActions(recoveryCase.id);
    return {
      case: recoveryCase,
      actions,
      recoverySession: repository.getRecoverySessionByCase(recoveryCase.id),
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

  app.get<{ Querystring: Record<string, string | undefined> }>("/webhooks/whatsapp", async (request, reply) => {
    if (!config.whatsapp.webhookVerifyToken) return reply.code(503).send({ error: "WhatsApp inbound webhook is not configured" });
    const mode = request.query["hub.mode"];
    const token = request.query["hub.verify_token"] ?? "";
    const challenge = request.query["hub.challenge"] ?? "";
    const expected = Buffer.from(config.whatsapp.webhookVerifyToken);
    const received = Buffer.from(token);
    if (mode !== "subscribe" || expected.length !== received.length || !timingSafeEqual(expected, received)) return reply.code(403).send({ error: "Webhook verification failed" });
    return reply.type("text/plain").send(challenge);
  });

  app.post("/webhooks/whatsapp", async (request, reply) => {
    if (!config.whatsapp.appSecret) return reply.code(503).send({ error: "WhatsApp inbound webhook is not configured" });
    if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "Expected a raw request body" });
    const signature = String(request.headers["x-hub-signature-256"] ?? "");
    const expected = `sha256=${createHmac("sha256", config.whatsapp.appSecret).update(request.body).digest("hex")}`;
    const expectedBuffer = Buffer.from(expected);
    const receivedBuffer = Buffer.from(signature);
    if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
      return reply.code(401).send({ error: "WhatsApp signature is invalid" });
    }
    const payload = JSON.parse(request.body.toString("utf8")) as {
      entry?: Array<{ changes?: Array<{ value?: { messages?: Array<{ id?: string; from?: string; text?: { body?: string } }> } }> }>;
    };
    const messages = payload.entry?.flatMap((entry) => entry.changes ?? []).flatMap((change) => change.value?.messages ?? []) ?? [];
    const outcomes: Array<{ intent: string; outcome: string }> = [];
    for (const message of messages) {
      const digits = message.from?.replace(/\D/g, "") ?? "";
      const intent = classifyWhatsAppIntent(message.text?.body ?? "");
      if (!message.id || !digits || intent === "UNKNOWN" || !repository.claimWhatsAppInboundMessage(message.id, clock.now())) continue;
      const recipientHash = createHmac("sha256", config.razorpay.webhookSecrets[0]!).update(`+${digits}`).digest("hex");
      const delivery = repository.findLatestDeliveryByRecipient(recipientHash);
      const action = delivery ? repository.getAction(delivery.actionId) : null;
      if (!action) continue;
      outcomes.push(await engine.applyCustomerIntent(action.caseId, intent));
      repository.recordRevenueOperation({ operation: `WHATSAPP_INTENT_${intent}`, status: "SUCCEEDED", output: { caseId: action.caseId, deliveryId: delivery!.id }, now: clock.now() });
    }
    return reply.code(200).send({ accepted: true, processed: outcomes.length, outcomes });
  });

  app.post("/api/worker/run", async () => {
    const worker = await engine.processPending(100);
    return {
      ...worker,
      swarmsAdvanced: revenueIntelligence.reconcileFailureSwarms(),
      promisesAdvanced: revenueIntelligence.reconcilePromiseWorkflows()
    };
  });

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
  app.post<{ Params: { id: string }; Body: unknown }>("/api/revenue/receivables/:id/outcome", async (request, reply) => {
    try {
      const body = parseJsonBody(request.body, z.object({ outcome: z.enum(["PROMISE", "DISPUTE", "PAID"]) }));
      return revenueIntelligence.recordReceivableOutcome(request.params.id, body.outcome);
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "Receivable outcome failed" }); }
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

  app.get<{ Params: { id: string } }>("/recover/:id", async (request, reply) => {
    const session = repository.getRecoverySession(request.params.id);
    reply.header("cache-control", "no-store");
    reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action https://rzp.io https://razorpay.com https://*.razorpay.com; frame-ancestors 'none'");
    reply.type("text/html; charset=utf-8");
    if (!session) return reply.code(404).send(recoveryPage({ title: "Recovery session not found", message: "This recovery address is invalid or is no longer available.", tone: "amber" }));
    const recoveryCase = repository.getCase(session.caseId);
    if (!recoveryCase) return reply.code(404).send(recoveryPage({ title: "Recovery session not found", message: "The linked payment obligation is unavailable.", tone: "amber" }));
    const now = clock.now();
    const amount = recoveryCase.amount === null ? undefined : `${recoveryCase.currency ?? "INR"} ${(recoveryCase.amount / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
    if (session.status === "PAID" || recoveryCase.status === "RECOVERED") {
      if (session.status !== "PAID") repository.updateRecoverySession(session.id, { status: "PAID" }, "smart-session", now);
      return reply.send(recoveryPage({ title: "Payment received", message: "Razorpay has verified this obligation as paid. No further recovery messages will be sent.", amount, tone: "green" }));
    }
    if (session.expiresAt <= now || session.status === "EXPIRED") {
      if (session.status !== "EXPIRED") repository.updateRecoverySession(session.id, { status: "EXPIRED" }, "smart-session", now);
      return reply.code(410).send(recoveryPage({ title: "This session has expired", message: "For your safety, the bounded payment window is closed. Please contact the merchant for a fresh checkout.", amount, tone: "amber" }));
    }
    if (["CLOSED"].includes(session.status) || ["SUPPRESSED", "EXHAUSTED"].includes(recoveryCase.status)) {
      return reply.code(410).send(recoveryPage({ title: "Recovery has stopped", message: "This payment session was closed by a stopping rule. No action is required here.", amount, tone: "amber" }));
    }
    repository.recordRecoverySessionOpen(session.id, now);
    if (recoveryCase.pausedUntil && recoveryCase.pausedUntil > now) {
      const wait = Math.max(5, Math.min(300, recoveryCase.pausedUntil - now));
      return reply.send(recoveryPage({ title: "We’ll wait as requested", message: "This recovery is paused until the promised payment time. The same link will become ready automatically.", amount, refreshSeconds: wait, tone: "amber" }));
    }
    if (session.status === "READY" && session.destinationUrl && approvedRecoveryDestination(session.destinationUrl, provider.mode === "mock")) {
      return reply.send(recoveryPage({ title: session.preferredMethod === "UPI" ? "Continue with your UPI preference" : "Your secure checkout is ready", message: "You are being sent to the current Razorpay checkout. This PayArc link remains the same if the safe payment route changes.", amount, destination: session.destinationUrl, refreshSeconds: 2 }));
    }
    const action = repository.listActions(recoveryCase.id)[0];
    const nextAt = action?.nextAttemptAt ?? now + 5;
    const seconds = Math.max(3, Math.min(30, nextAt - now));
    return reply.send(recoveryPage({ title: "Preparing the safest payment route", message: "PayArc is observing provider health or creating a bounded Razorpay checkout. This page refreshes automatically—there is no need to request another link.", amount, refreshSeconds: seconds }));
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
