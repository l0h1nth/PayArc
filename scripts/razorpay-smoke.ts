import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { RazorpayProvider } from "../src/providers/razorpay-provider.js";

const config = loadConfig(process.env);
if (config.paymentProviderMode !== "razorpay") {
  throw new Error("Set PAYMENT_PROVIDER_MODE=razorpay to run the Test Mode smoke check");
}
const paymentId = process.env.RAZORPAY_SMOKE_PAYMENT_ID;
if (!paymentId?.startsWith("pay_")) {
  throw new Error("Set RAZORPAY_SMOKE_PAYMENT_ID to an existing Test Mode payment ID");
}

const provider = new RazorpayProvider({
  keyId: config.razorpay.keyId,
  keySecret: config.razorpay.keySecret,
  baseUrl: config.razorpay.apiBaseUrl
});
const payment = await provider.fetchPayment(paymentId);
console.log(JSON.stringify({
  connected: true,
  provider: "razorpay-test-mode",
  payment: {
    id: payment.id,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    method: payment.method,
    errorReason: payment.errorReason
  }
}, null, 2));
