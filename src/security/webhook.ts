import { createHmac, timingSafeEqual } from "node:crypto";

export function signWebhook(rawBody: string | Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyWebhookSignature(rawBody: string | Buffer, received: string, secrets: string[]): boolean {
  if (!received || secrets.length === 0 || !/^[a-f0-9]{64}$/i.test(received)) return false;
  const receivedBuffer = Buffer.from(received.toLowerCase(), "hex");
  let valid = false;
  for (const secret of secrets) {
    const expected = Buffer.from(signWebhook(rawBody, secret), "hex");
    valid = timingSafeEqual(expected, receivedBuffer) || valid;
  }
  return valid;
}
