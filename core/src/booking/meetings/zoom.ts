/**
 * Zoom, via a Server-to-Server OAuth app. Create the app at marketplace.zoom.us
 * with the meeting:write:admin scope and copy the three credentials.
 */
import type { Booking } from "@prisma/client";
import { Provider, type MeetingContext, type MeetingResult } from "./provider.js";
import * as Data from "../data.js";
import { term } from "../settings.js";
import { GetBooqinError } from "../errors.js";

const tokenCache = new Map<string, { token: string; expires: number }>();

export class ZoomProvider extends Provider {
  id() {
    return "zoom";
  }
  label() {
    return "Zoom";
  }
  description() {
    return "Creates a scheduled Zoom meeting per booking.";
  }

  isConfigured(ctx: MeetingContext) {
    return !!this.setting(ctx, "account_id") && !!this.setting(ctx, "client_id") && !!this.setting(ctx, "client_secret");
  }

  needsReprovision() {
    return true;
  }

  settingsFields() {
    return [
      { key: "account_id", label: "Account ID", type: "text", description: "Zoom Marketplace → Build App → Server-to-Server OAuth." },
      { key: "client_id", label: "Client ID", type: "text" },
      { key: "client_secret", label: "Client secret", type: "password" },
      { key: "host_email", label: "Host email", type: "text", description: "The Zoom user meetings are created under. Defaults to the staff member's email, falling back to this." },
    ];
  }

  private cacheKey(ctx: MeetingContext): string {
    return `${this.setting(ctx, "account_id")}|${this.setting(ctx, "client_id")}|${this.setting(ctx, "client_secret")}`;
  }

  private async token(ctx: MeetingContext): Promise<string> {
    const key = this.cacheKey(ctx);
    const cached = tokenCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.token;

    const response = await fetch(
      `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(this.setting(ctx, "account_id"))}`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.setting(ctx, "client_id")}:${this.setting(ctx, "client_secret")}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    const body = (await response.json()) as { access_token?: string; expires_in?: number; reason?: string };

    if (!response.ok || !body.access_token) {
      tokenCache.delete(key);
      throw new GetBooqinError("getbooqin_zoom_auth", body?.reason ?? "Zoom rejected those credentials.", 502);
    }

    const ttl = Math.max(60, (body.expires_in ?? 3000) - 60) * 1000;
    tokenCache.set(key, { token: body.access_token, expires: Date.now() + ttl });
    return body.access_token;
  }

  async create(ctx: MeetingContext, booking: Booking): Promise<MeetingResult> {
    const token = await this.token(ctx);

    const service = await Data.catalogService(ctx.shop, booking.serviceId);
    const resource = await Data.resource(ctx.shop, booking.resourceId);
    const customer = await Data.customer(ctx.shop, booking.customerId);

    const host = resource?.email || this.setting(ctx, "host_email") || "me";
    const customerName = customer ? `${customer.firstName} ${customer.lastName}`.trim() : "";
    const topic = `${service ? service.name : term(ctx.settings, "booking_single")} with ${customerName}`.slice(0, 200);
    const duration = service ? service.durationMin : 30;

    const response = await fetch(`https://api.zoom.us/v2/users/${encodeURIComponent(host)}/meetings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        topic,
        type: 2,
        start_time: booking.startUtc.toISOString().replace(/\.\d{3}Z$/, "Z"),
        duration,
        timezone: "UTC",
        // Private-by-default: waiting room on, nobody joins before the host.
        settings: { join_before_host: false, waiting_room: true },
      }),
    });

    const body = (await response.json()) as { join_url?: string; id?: string | number; message?: string };

    if (response.status === 401) {
      tokenCache.delete(this.cacheKey(ctx));
    }
    if (!response.ok || !body.join_url) {
      throw new GetBooqinError("getbooqin_zoom_create", body?.message ?? "Zoom did not create the meeting.", 502);
    }

    return { url: body.join_url, id: body.id ? String(body.id) : undefined };
  }
}
