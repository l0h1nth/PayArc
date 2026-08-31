import { resolve } from "node:path";
import { z } from "zod";

const bool = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const nonNegativeInt = (fallback: number) =>
  z.coerce.number().int().nonnegative().default(fallback);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: positiveInt(3000),
  DATABASE_PATH: z.string().default("./data/payarc.db"),
  OPERATOR_API_TOKEN: z.string().default(""),
  PAYMENT_PROVIDER_MODE: z.enum(["mock", "razorpay"]).default("mock"),
  RAZORPAY_KEY_ID: z.string().default(""),
  RAZORPAY_KEY_SECRET: z.string().default(""),
  RAZORPAY_WEBHOOK_SECRET: z.string().default("dev_webhook_secret"),
  RAZORPAY_PREVIOUS_WEBHOOK_SECRET: z.string().default(""),
  RAZORPAY_API_BASE_URL: z.string().url().default("https://api.razorpay.com/v1"),
  AUTO_ACTIONS_ENABLED: bool,
  EXTERNAL_ACTIONS_ENABLED: bool,
  GLOBAL_KILL_SWITCH: bool,
  MAX_AUTO_AMOUNT_PAISE: positiveInt(500_000),
  MAX_CONTACTS_PER_CASE: positiveInt(3),
  CONTACT_COOLDOWN_SECONDS: nonNegativeInt(86_400),
  PAYMENT_LINK_TTL_SECONDS: positiveInt(172_800),
  CONTROL_COHORT_PERCENT: z.coerce.number().int().min(0).max(100).default(10),
  ALLOWED_CURRENCIES: z.string().default("INR"),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(200),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(10),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(500),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().default(""),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  WHATSAPP_MODE: z.enum(["click_to_chat", "cloud_api"]).default("click_to_chat"),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(""),
  WHATSAPP_ACCESS_TOKEN: z.string().default(""),
  WHATSAPP_GRAPH_API_BASE_URL: z.string().url().default("https://graph.facebook.com/v23.0"),
  WHATSAPP_TEMPLATE_NAME: z.string().default("recovery_payment_link"),
  WHATSAPP_TEMPLATE_LANGUAGE: z.string().default("en_US"),
  WHATSAPP_AUTO_SEND_ENABLED: bool,
  WHATSAPP_CONSENT_NOTE_KEY: z.string().min(1).max(64).default("payarc_whatsapp_opt_in")
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databasePath: string;
  operatorApiToken: string;
  paymentProviderMode: "mock" | "razorpay";
  razorpay: {
    keyId: string;
    keySecret: string;
    webhookSecrets: string[];
    apiBaseUrl: string;
  };
  policy: {
    autoActionsEnabled: boolean;
    externalActionsEnabled: boolean;
    globalKillSwitch: boolean;
    maxAutoAmountPaise: number;
    maxContactsPerCase: number;
    contactCooldownSeconds: number;
    paymentLinkTtlSeconds: number;
    controlCohortPercent: number;
    allowedCurrencies: Set<string>;
  };
  openai: {
    apiKey: string;
    model: string;
    baseUrl: string;
    enabled: boolean;
  };
  worker: {
    batchSize: number;
    concurrency: number;
    intervalMs: number;
  };
  whatsapp: {
    mode: "click_to_chat" | "cloud_api";
    phoneNumberId: string;
    accessToken: string;
    graphApiBaseUrl: string;
    templateName: string;
    templateLanguage: string;
    autoSendEnabled: boolean;
    consentNoteKey: string;
  };
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = envSchema.parse(source);

  if (env.PAYMENT_PROVIDER_MODE === "razorpay") {
    if (!env.RAZORPAY_KEY_ID.startsWith("rzp_test_")) {
      throw new Error("Razorpay mode requires an rzp_test_ key; live keys are intentionally rejected");
    }
    if (!env.RAZORPAY_KEY_SECRET) {
      throw new Error("RAZORPAY_KEY_SECRET is required in Razorpay mode");
    }
  }
  if (env.NODE_ENV === "production") {
    if (env.RAZORPAY_WEBHOOK_SECRET === "dev_webhook_secret" || env.RAZORPAY_WEBHOOK_SECRET.length < 16) {
      throw new Error("Production requires a non-default webhook secret of at least 16 characters");
    }
    if (env.OPERATOR_API_TOKEN.length < 32) {
      throw new Error("Production requires OPERATOR_API_TOKEN with at least 32 characters");
    }
  }
  if (env.WHATSAPP_MODE === "cloud_api" && (!env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_ACCESS_TOKEN)) {
    throw new Error("WhatsApp Cloud API mode requires WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN");
  }

  const webhookSecrets = [env.RAZORPAY_WEBHOOK_SECRET, env.RAZORPAY_PREVIOUS_WEBHOOK_SECRET]
    .filter((secret) => secret.length > 0);

  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    databasePath: env.DATABASE_PATH === ":memory:" ? ":memory:" : resolve(env.DATABASE_PATH),
    operatorApiToken: env.OPERATOR_API_TOKEN,
    paymentProviderMode: env.PAYMENT_PROVIDER_MODE,
    razorpay: {
      keyId: env.RAZORPAY_KEY_ID,
      keySecret: env.RAZORPAY_KEY_SECRET,
      webhookSecrets,
      apiBaseUrl: env.RAZORPAY_API_BASE_URL.replace(/\/$/, "")
    },
    policy: {
      autoActionsEnabled: env.AUTO_ACTIONS_ENABLED,
      externalActionsEnabled: env.EXTERNAL_ACTIONS_ENABLED,
      globalKillSwitch: env.GLOBAL_KILL_SWITCH,
      maxAutoAmountPaise: env.MAX_AUTO_AMOUNT_PAISE,
      maxContactsPerCase: env.MAX_CONTACTS_PER_CASE,
      contactCooldownSeconds: env.CONTACT_COOLDOWN_SECONDS,
      paymentLinkTtlSeconds: env.PAYMENT_LINK_TTL_SECONDS,
      controlCohortPercent: env.CONTROL_COHORT_PERCENT,
      allowedCurrencies: new Set(
        env.ALLOWED_CURRENCIES.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean)
      )
    },
    openai: {
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      baseUrl: env.OPENAI_BASE_URL.replace(/\/$/, ""),
      enabled: Boolean(env.OPENAI_API_KEY && env.OPENAI_MODEL)
    },
    worker: {
      batchSize: env.WORKER_BATCH_SIZE,
      concurrency: env.WORKER_CONCURRENCY,
      intervalMs: env.WORKER_INTERVAL_MS
    },
    whatsapp: {
      mode: env.WHATSAPP_MODE,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      accessToken: env.WHATSAPP_ACCESS_TOKEN,
      graphApiBaseUrl: env.WHATSAPP_GRAPH_API_BASE_URL.replace(/\/$/, ""),
      templateName: env.WHATSAPP_TEMPLATE_NAME,
      templateLanguage: env.WHATSAPP_TEMPLATE_LANGUAGE,
      autoSendEnabled: env.WHATSAPP_AUTO_SEND_ENABLED,
      consentNoteKey: env.WHATSAPP_CONSENT_NOTE_KEY
    }
  };
}

export function publicConfig(config: AppConfig) {
  return {
    nodeEnv: config.nodeEnv,
    paymentProviderMode: config.paymentProviderMode,
    autoActionsEnabled: config.policy.autoActionsEnabled,
    externalActionsEnabled: config.policy.externalActionsEnabled,
    globalKillSwitch: config.policy.globalKillSwitch,
    maxAutoAmountPaise: config.policy.maxAutoAmountPaise,
    maxContactsPerCase: config.policy.maxContactsPerCase,
    contactCooldownSeconds: config.policy.contactCooldownSeconds,
    controlCohortPercent: config.policy.controlCohortPercent,
    allowedCurrencies: [...config.policy.allowedCurrencies],
    aiProvider: config.openai.enabled ? "openai" : "deterministic",
    whatsappMode: config.whatsapp.mode,
    whatsappAutoSendEnabled: config.whatsapp.autoSendEnabled,
    workerBatchSize: config.worker.batchSize,
    workerConcurrency: config.worker.concurrency
  };
}
