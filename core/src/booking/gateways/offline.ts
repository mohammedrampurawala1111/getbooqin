/** Pay on arrival / bank transfer. Always available, charges nothing online. */
import type { Booking, Payment } from "@prisma/client";
import { Gateway, type GatewayContext, type StartResult } from "./gateway.js";

export class OfflineGateway extends Gateway {
  id() {
    return "offline";
  }

  label(ctx: GatewayContext) {
    return this.setting(ctx, "label") || "Pay at the appointment";
  }

  description(ctx: GatewayContext) {
    return this.setting(ctx, "instructions") || "No payment needed now — settle up when you arrive.";
  }

  isConfigured() {
    return true;
  }

  /** Nothing is ever collected online, so this can never confirm a booking waiting on payment. */
  canSettle() {
    return false;
  }

  settingsFields() {
    return [
      { key: "label", label: "Button label", type: "text" },
      {
        key: "instructions",
        label: "Instructions shown to the customer",
        type: "textarea",
        description: "Use this for cash, card on arrival, or bank transfer details.",
      },
    ];
  }

  async start(ctx: GatewayContext, _booking: Booking, _payment: Payment): Promise<StartResult> {
    return { type: "instructions", message: this.description(ctx) };
  }
}
