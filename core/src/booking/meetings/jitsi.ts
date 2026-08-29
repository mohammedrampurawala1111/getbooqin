/**
 * Jitsi Meet. No account, no API key, no per-minute cost.
 * Room names come from the booking's unguessable UID.
 */
import type { Booking } from "@prisma/client";
import { Provider, type MeetingContext, type MeetingResult } from "./provider.js";

function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export class JitsiProvider extends Provider {
  id() {
    return "jitsi";
  }
  label() {
    return "Jitsi Meet (free, no account needed)";
  }
  description() {
    return "Creates a private room per booking on meet.jit.si, or on your own Jitsi server.";
  }
  isConfigured() {
    return true;
  }

  settingsFields() {
    return [
      { key: "domain", label: "Jitsi domain", type: "text", description: "Defaults to meet.jit.si. Point this at your own server for full control." },
      { key: "prefix", label: "Room name prefix", type: "text", description: "Helps you recognise your rooms. Defaults to the shop name." },
    ];
  }

  async create(ctx: MeetingContext, booking: Booking): Promise<MeetingResult> {
    const domain = this.setting(ctx, "domain", "meet.jit.si").replace(/^https?:\/\//, "").replace(/\/$/, "");
    const prefix = slugify(this.setting(ctx, "prefix", slugify(ctx.settings.business_name))) || "getbooqin";
    const room = `${prefix}-${booking.uid}`;

    return { url: `https://${domain}/${encodeURIComponent(room)}`, id: room };
  }
}
