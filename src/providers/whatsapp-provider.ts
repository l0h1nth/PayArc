export type WhatsAppRecoveryMessage = {
  recipient: string;
  amountDisplay: string;
  paymentUrl: string;
  caseReference: string;
};

export type WhatsAppDeliveryResult = {
  mode: "CLICK_TO_CHAT" | "CLOUD_API";
  status: "PREPARED" | "SENT";
  deliveryUrl: string | null;
  providerReference: string | null;
};

export interface WhatsAppProvider {
  readonly mode: WhatsAppDeliveryResult["mode"];
  deliver(input: WhatsAppRecoveryMessage): Promise<WhatsAppDeliveryResult>;
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

export class ClickToChatWhatsAppProvider implements WhatsAppProvider {
  readonly mode = "CLICK_TO_CHAT" as const;

  async deliver(input: WhatsAppRecoveryMessage): Promise<WhatsAppDeliveryResult> {
    const message = [
      `Your payment of ${input.amountDisplay} could not be completed.`,
      `You can safely continue here: ${input.paymentUrl}`,
      `Reference: ${input.caseReference}`,
      "Reply STOP to opt out. If you already paid, please ignore this message."
    ].join("\n\n");
    return {
      mode: this.mode,
      status: "PREPARED",
      deliveryUrl: `https://wa.me/${digitsOnly(input.recipient)}?text=${encodeURIComponent(message)}`,
      providerReference: null
    };
  }
}

type CloudOptions = {
  phoneNumberId: string;
  accessToken: string;
  graphApiBaseUrl: string;
  templateName: string;
  templateLanguage: string;
  fetchImpl?: typeof fetch;
};

export class CloudApiWhatsAppProvider implements WhatsAppProvider {
  readonly mode = "CLOUD_API" as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CloudOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async deliver(input: WhatsAppRecoveryMessage): Promise<WhatsAppDeliveryResult> {
    const response = await this.fetchImpl(`${this.options.graphApiBaseUrl}/${encodeURIComponent(this.options.phoneNumberId)}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: digitsOnly(input.recipient),
        type: "template",
        template: {
          name: this.options.templateName,
          language: { code: this.options.templateLanguage },
          components: [{
            type: "body",
            parameters: [
              { type: "text", text: input.amountDisplay },
              { type: "text", text: input.paymentUrl },
              { type: "text", text: input.caseReference }
            ]
          }]
        }
      })
    });
    const body = await response.json() as { messages?: Array<{ id?: string }>; error?: { message?: string } };
    if (!response.ok) throw new Error(`WhatsApp request failed (${response.status}): ${body.error?.message ?? "provider error"}`);
    const providerReference = body.messages?.[0]?.id;
    if (!providerReference) throw new Error("WhatsApp accepted the request without a message reference");
    return { mode: this.mode, status: "SENT", deliveryUrl: null, providerReference };
  }
}
