/**
 * Payment gateway contract. Ported from shopify-openslot/app/lib/gateways/gateway.ts.
 * A gateway never touches booking code directly, so adding one is additive.
 */
import type { Booking, Payment } from "@prisma/client";
import type { Settings } from "../settings.js";
import { gatewaySetting } from "../settings.js";

export interface GatewayContext {
  shop: string;
  settings: Settings;
  appProxyBase: string; // e.g. https://shop.myshopify.com/apps/getbooqin
  manageUrl: (booking: Booking) => string;
}

export type StartResult =
  | { type: "redirect"; url: string }
  | { type: "razorpay"; params: Record<string, unknown> }
  | { type: "instructions"; message: string };

export abstract class Gateway {
  /** Machine id, e.g. "razorpay". */
  abstract id(): string;

  /** Human label shown to the customer. */
  abstract label(ctx: GatewayContext): string;

  /** One line shown under the label. */
  description(_ctx: GatewayContext): string {
    return "";
  }

  /** Are the credentials present? */
  abstract isConfigured(ctx: GatewayContext): boolean;

  /**
   * Can this gateway actually settle money and report it back to us?
   * Offline-style gateways return false: valid payment *methods*, but they
   * can never confirm a booking that is waiting on payment.
   */
  canSettle(): boolean {
    return true;
  }

  /** Credential fields rendered on Settings → Payments. */
  settingsFields(): Array<{ key: string; label: string; type: string; description?: string }> {
    return [];
  }

  abstract start(ctx: GatewayContext, booking: Booking, payment: Payment): Promise<StartResult>;

  /** Handle the customer coming back from the gateway (GET). */
  async handleReturn(_ctx: GatewayContext, _params: URLSearchParams, _payment: Payment, _booking: Booking): Promise<void> {
    throw Object.assign(new Error("This gateway does not use a return URL."), { code: "getbooqin_not_supported" });
  }

  /** Handle an in-page confirmation (POST), e.g. Razorpay checkout success. */
  async handleVerify(
    _ctx: GatewayContext,
    _body: Record<string, unknown>,
    _payment: Payment,
    _booking: Booking
  ): Promise<void> {
    throw Object.assign(new Error("This gateway does not use client verification."), {
      code: "getbooqin_not_supported",
    });
  }

  protected setting(ctx: GatewayContext, key: string, fallback = ""): string {
    return gatewaySetting(ctx.settings, this.id(), key, fallback);
  }

  protected returnUrl(ctx: GatewayContext, payment: Payment): string {
    return `${ctx.appProxyBase}/payments/return/${this.id()}?payment=${payment.id}`;
  }

  protected cancelUrl(ctx: GatewayContext, booking: Booking): string {
    const url = ctx.manageUrl(booking);
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}payment_cancelled=1`;
  }

  /** Amounts in the smallest currency unit (paise, cents). */
  protected minorUnits(amount: number): number {
    return Math.round(amount * 100);
  }
}
