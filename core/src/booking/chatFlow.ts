/**
 * Scripted chat flow. Ported from shopify-openslot/app/lib/chatFlow.server.ts
 * — same logic, adapted to core's Prisma client and threaded with an
 * explicit `platform` parameter alongside `shop` (see data.ts's header).
 *
 * A deterministic server-side state machine — no AI, no external service, no
 * API key. The visitor either taps a quick reply or types free text; the
 * state lives in the conversation row so a refresh never loses the thread.
 */
import { DateTime } from "luxon";
import type { ChatConversation } from "@prisma/client";
import prisma from "../db.js";
import * as Data from "./data.js";
import * as Availability from "./availability.js";
import * as Bookings from "./bookings.js";
import { getSettings, term, money, type Settings } from "./settings.js";
import { uid, now } from "./ids.js";
import { GetBooqinError } from "./errors.js";
import * as Mailer from "./mailer.js";

export const MENU = "__menu";

interface Option {
  label: string;
  value: string;
}
interface Input {
  type: string;
  placeholder: string;
}
interface ChatState {
  step: string;
  data: Record<string, any>;
  ui?: { options: Option[]; input: Input };
}
interface Message {
  sender: "bot" | "visitor";
  body: string;
}
interface Turn {
  conversation: string;
  messages: Message[];
  options: Option[];
  input: Input;
  finished: boolean;
  resumed?: boolean;
}

function input(type = "text", placeholder = ""): Input {
  return { type, placeholder };
}

function backOption(): Option {
  return { label: "← Main menu", value: MENU };
}

function menuOptions(settings: Settings): Option[] {
  const options: Option[] = [];
  if (settings.chat_show_booking) {
    options.push({ label: `📅 Book an ${term(settings, "booking_single").toLowerCase()}`, value: "book" });
  }
  if (settings.chat_show_faq) {
    options.push({ label: "💬 Ask a question", value: "faq" });
  }
  if (settings.chat_show_message) {
    options.push({ label: "✉️ Leave a message", value: "message" });
  }
  return options;
}

async function faqOptions(shop: string, platform: string, withMenu = false): Promise<Option[]> {
  const rows = await Data.faqs(shop, platform, true);
  const options = rows.slice(0, 6).map((f) => ({ label: f.question, value: `faq:${f.id}` }));
  if (withMenu) options.push(backOption());
  return options;
}

function prettyTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return DateTime.fromObject({ hour: h, minute: m }, { zone: "utc" }).toFormat("h:mm a");
}

async function storeMessage(conversationId: number, sender: "bot" | "visitor", body: string) {
  await prisma.chatMessage.create({
    data: { conversationId, sender, body: body.replace(/<[^>]*>/g, ""), createdAt: now() },
  });
}

async function botMsg(conversation: ChatConversation, body: string): Promise<Message> {
  await storeMessage(conversation.id, "bot", body);
  return { sender: "bot", body };
}

async function reply(
  conversation: ChatConversation,
  state: ChatState,
  bodies: string[],
  options: Option[] = [],
  resolvedInput?: Input
): Promise<Turn> {
  const finalInput = resolvedInput ?? input("text", "Type a message…");

  await prisma.chatConversation.update({
    where: { id: conversation.id },
    data: {
      state: JSON.stringify({ ...state, ui: { options, input: finalInput } }),
      updatedAt: now(),
    },
  });

  const messages: Message[] = [];
  for (const body of bodies) {
    messages.push(await botMsg(conversation, body));
  }

  return { conversation: conversation.uid, messages, options, input: finalInput, finished: false };
}

/* ---------------------------------------------------------- Conversation */

export async function start(shop: string, platform: string, pageUrl = ""): Promise<Turn> {
  const settings = await getSettings(shop, platform);
  const conversationUid = uid();

  const conversation = await prisma.chatConversation.create({
    data: {
      shop,
      platform,
      uid: conversationUid,
      state: JSON.stringify({
        step: "menu",
        data: {},
        ui: { options: menuOptions(settings), input: input("text", "Type your question…") },
      }),
      status: "open",
      pageUrl: pageUrl.slice(0, 255),
      createdAt: now(),
      updatedAt: now(),
    },
  });

  const messages = [await botMsg(conversation, settings.chat_greeting)];

  return {
    conversation: conversation.uid,
    messages,
    options: menuOptions(settings),
    input: input("text", "Type your question…"),
    finished: false,
  };
}

/** Re-open an existing conversation after a page reload. */
export async function resume(shop: string, platform: string, uidValue: string): Promise<Turn> {
  const conversation = await prisma.chatConversation.findFirst({ where: { shop, platform, uid: uidValue } });
  if (!conversation || conversation.status !== "open") {
    throw new GetBooqinError("getbooqin_no_conversation", "Chat session expired.", 404);
  }

  const state: ChatState = conversation.state ? JSON.parse(conversation.state) : { step: "menu", data: {} };
  const ui = state.ui ?? { options: menuOptions(await getSettings(shop, platform)), input: input("text", "Type your question…") };

  const rows = await prisma.chatMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { id: "asc" },
    take: 60,
  });

  return {
    conversation: conversation.uid,
    messages: rows.map((r) => ({ sender: r.sender as "bot" | "visitor", body: r.body ?? "" })),
    options: ui.options,
    input: ui.input,
    finished: false,
    resumed: true,
  };
}

export async function respond(shop: string, platform: string, uidValue: string, value: string): Promise<Turn> {
  const conversation = await prisma.chatConversation.findFirst({ where: { shop, platform, uid: uidValue } });
  if (!conversation) {
    throw new GetBooqinError("getbooqin_no_conversation", "Chat session expired. Please reload the page.", 404);
  }

  const settings = await getSettings(shop, platform);
  let state: ChatState = conversation.state ? JSON.parse(conversation.state) : { step: "menu", data: {} };
  const step = state.step || "menu";

  const cleanValue = value.replace(/<[^>]*>/g, "").trim();
  if (!cleanValue) {
    return reply(conversation, state, ["Sorry, I did not catch that."], menuOptions(settings));
  }

  await storeMessage(conversation.id, "visitor", cleanValue);

  if (cleanValue === MENU) {
    state = { step: "menu", data: {} };
    return reply(conversation, state, ["What would you like to do?"], menuOptions(settings));
  }

  const handler = STEPS[step];
  if (!handler) {
    state = { step: "menu", data: {} };
    return reply(conversation, state, ["Let us start again."], menuOptions(settings));
  }

  return handler(shop, platform, settings, conversation, state, state.data, cleanValue);
}

/* ------------------------------------------------------------------ Steps */

type StepHandler = (
  shop: string,
  platform: string,
  settings: Settings,
  conversation: ChatConversation,
  state: ChatState,
  data: Record<string, any>,
  value: string
) => Promise<Turn>;

const STEPS: Record<string, StepHandler> = {
  menu: stepMenu,
  faq_list: stepFaqList,
  book_service: stepBookService,
  book_resource: stepBookResource,
  book_date: stepBookDate,
  book_time: stepBookTime,
  book_name: stepBookName,
  book_email: stepBookEmail,
  book_phone: stepBookPhone,
  book_confirm: stepBookConfirm,
  lead_name: stepLeadName,
  lead_email: stepLeadEmail,
  lead_message: stepLeadMessage,
};

async function stepMenu(shop: string, platform: string, settings: Settings, conversation: ChatConversation, state: ChatState, data: any, value: string) {
  if (value === "book" && settings.chat_show_booking) {
    return askService(shop, platform, settings, conversation, {});
  }
  if (value === "faq" && settings.chat_show_faq) {
    return askFaq(shop, platform, settings, conversation);
  }
  if (value === "message" && settings.chat_show_message) {
    const next: ChatState = { step: "lead_name", data: {} };
    return reply(conversation, next, [settings.chat_offline_note, "What is your name?"], [], input("text", "Your name"));
  }
  return answerFromFaq(shop, platform, settings, conversation, value);
}

async function stepFaqList(shop: string, platform: string, settings: Settings, conversation: ChatConversation, state: ChatState, data: any, value: string) {
  if (value.startsWith("faq:")) {
    const faq = await Data.faq(shop, parseInt(value.slice(4), 10));
    if (faq) {
      const next: ChatState = { step: "faq_list", data: {} };
      return reply(
        conversation,
        next,
        [(faq.answer ?? "").replace(/<[^>]*>/g, ""), "Anything else I can help with?"],
        await faqOptions(shop, platform, true)
      );
    }
  }
  return answerFromFaq(shop, platform, settings, conversation, value);
}

async function stepBookService(shop: string, platform: string, settings: Settings, conversation: ChatConversation, state: ChatState, data: any, value: string) {
  const serviceId = parseInt(value.replace("service:", ""), 10);
  const service = await Data.catalogService(shop, serviceId);
  if (!service) {
    return askService(shop, platform, settings, conversation, data, "Please pick one of these options:");
  }

  data.service_id = serviceId;
  data.service_name = service.name;

  const resources = await Data.resourcesForService(shop, platform, serviceId);
  if (resources.length <= 1) {
    data.resource_id = resources[0]?.id ?? 0;
    return askDate(shop, platform, settings, conversation, data);
  }

  const options: Option[] = [{ label: "Anyone available", value: "resource:0" }];
  for (const r of resources) options.push({ label: r.name, value: `resource:${r.id}` });
  options.push(backOption());

  const next: ChatState = { step: "book_resource", data };
  return reply(conversation, next, [`Great — ${service.name}. Who would you like to see?`], options, input("none"));
}

async function stepBookResource(shop: string, platform: string, settings: Settings, conversation: ChatConversation, state: ChatState, data: any, value: string) {
  if (!value.startsWith("resource:")) {
    return reply(conversation, state, ["Please choose from the options above."], []);
  }
  data.resource_id = parseInt(value.slice(9), 10);
  return askDate(shop, platform, settings, conversation, data);
}

async function stepBookDate(shop: string, platform: string, settings: Settings, conversation: ChatConversation, state: ChatState, data: any, value: string) {
  if (!value.startsWith("date:")) {
    return askDate(shop, platform, settings, conversation, data, "Please pick one of the dates shown.");
  }
  const date = value.slice(5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return askDate(shop, platform, settings, conversation, data);
  }
  data.date = date;
  return askTime(shop, platform, settings, conversation, data);
}

async function stepBookTime(shop: string, platform: string, settings: Settings, conversation: ChatConversation, state: ChatState, data: any, value: string) {
  if (value === "date_back") {
    return askDate(shop, platform, settings, conversation, data);
  }
  if (!value.startsWith("time:")) {
    return askTime(shop, platform, settings, conversation, data, "Please pick one of the times shown.");
  }
  const time = value.slice(5);
  if (!Bookings.validTime(time)) {
    return askTime(shop, platform, settings, conversation, data, "Please pick one of the times shown.");
  }
  if (!(await Bookings.slotIsPublished(shop, platform, settings.timezone, data.service_id, data.resource_id ?? 0, data.date, time))) {
    return askTime(shop, platform, settings, conversation, data, "That time is no longer available. Here is what is left:");
  }

  data.time = time;
  const next: ChatState = { step: "book_name", data };
  return reply(conversation, next, ["Almost done. What is your full name?"], [], input("text", "Your full name"));
}

async function stepBookName(shop: string, platform: string, settings: Settings, conversation: ChatConversation, state: ChatState, data: any, value: string) {
  const parts = value.split(/\s+/);
  data.first_name = parts[0];
  data.last_name = parts.slice(1).join(" ");
  const next: ChatState = { step: "book_email", data };
  return reply(conversation, next, ["Thanks! What is your email address?"], [], input("email", "you@example.com"));
}

async function stepBookEmail(shop: string, platform: string, settings: Settings, conversation: ChatConversation, state: ChatState, data: any, value: string) {
  if (!Bookings.isEmail(value)) {
    return reply(conversation, state, ["That does not look like a valid email — could you check it?"], [], input("email", "you@example.com"));
  }
  data.email = value;
  const next: ChatState = { step: "book_phone", data };
  const skip: Option[] = settings.require_phone ? [] : [{ label: "Skip", value: "skip" }];
  return reply(conversation, next, ["And a phone number we can reach you on?"], skip, input("tel", "Phone number"));
}

async function stepBookPhone(shop: string, platform: string, settings: Settings, conversation: ChatConversation, state: ChatState, data: any, value: string) {
  if (value !== "skip") {
    data.phone = value;
  } else if (settings.require_phone) {
    return reply(conversation, state, ["A phone number is required to book. Could you share one?"], [], input("tel", "Phone number"));
  }

  const next: ChatState = { step: "book_confirm", data };
  const summary = `Here is what I have: ${data.service_name} on ${DateTime.fromISO(data.date).toFormat("DDD")} at ${prettyTime(data.time)}. Shall I confirm it?`;

  return reply(conversation, next, [summary], [
    { label: "Yes, confirm", value: "confirm" },
    { label: "Start over", value: MENU },
  ], input("none"));
}

async function stepBookConfirm(shop: string, platform: string, settings: Settings, conversation: ChatConversation, state: ChatState, data: any, value: string) {
  if (value !== "confirm") {
    const next: ChatState = { step: "menu", data: {} };
    return reply(conversation, next, ["No problem. What would you like to do?"], menuOptions(settings));
  }

  let booking;
  try {
    booking = await Bookings.create(shop, platform, settings.timezone, {
      service_id: data.service_id,
      resource_id: data.resource_id ?? 0,
      date: data.date,
      time: data.time,
      first_name: data.first_name,
      last_name: data.last_name ?? "",
      email: data.email,
      phone: data.phone ?? "",
      source: "chat",
    });
  } catch (err) {
    const next: ChatState = { step: "book_date", data };
    const message = err instanceof GetBooqinError ? err.message : "Something went wrong.";
    return reply(conversation, next, [message, "Let us try another day."], await dateOptions(shop, platform, settings, data));
  }

  // Meetings are attached on the created event handler; re-read to pick up the link.
  const fresh = (await Bookings.get(shop, booking.id)) ?? booking;

  await prisma.chatConversation.update({
    where: { id: conversation.id },
    data: {
      visitorName: `${data.first_name} ${data.last_name ?? ""}`.trim(),
      visitorEmail: data.email,
      visitorPhone: data.phone ?? "",
      bookingId: fresh.id,
      status: "booked",
      updatedAt: now(),
    },
  });

  const next: ChatState = { step: "menu", data: {} };
  const messages = [
    `✅ All set! You are booked for ${Bookings.localDate(fresh, settings.timezone)} at ${Bookings.localTime(fresh, settings.timezone)}. A confirmation email is on its way to you.`,
  ];

  if (fresh.meetingUrl) {
    messages.push(`It is a video call — join here when it is time: ${fresh.meetingUrl}`);
  }
  if (Bookings.needsPayment(fresh)) {
    messages.push(`There is ${money(settings, fresh.amountDue)} to pay. You can do that here: ${Bookings.manageUrl(fresh, settings)}`);
  }
  messages.push("Anything else I can help with?");

  return reply(conversation, next, messages, menuOptions(settings));
}

async function stepLeadName(shop: string, platform: string, settings: Settings, conversation: ChatConversation, state: ChatState, data: any, value: string) {
  data.name = value;
  const next: ChatState = { step: "lead_email", data };
  return reply(conversation, next, ["Thanks. What email should we reply to?"], [], input("email", "you@example.com"));
}

async function stepLeadEmail(shop: string, platform: string, settings: Settings, conversation: ChatConversation, state: ChatState, data: any, value: string) {
  if (!Bookings.isEmail(value)) {
    return reply(conversation, state, ["That email looks off — mind checking it?"], [], input("email", "you@example.com"));
  }
  data.email = value;
  const next: ChatState = { step: "lead_message", data };
  return reply(conversation, next, ["Great. What would you like to tell us?"], [], input("textarea", "Your message"));
}

async function stepLeadMessage(shop: string, platform: string, settings: Settings, conversation: ChatConversation, state: ChatState, data: any, value: string) {
  data.message = value;

  const updated = await prisma.chatConversation.update({
    where: { id: conversation.id },
    data: { visitorName: data.name, visitorEmail: data.email, updatedAt: now() },
  });

  await Mailer.sendChatLead(shop, platform, { name: data.name, email: data.email, message: data.message }, updated);

  const next: ChatState = { step: "menu", data: {} };
  return reply(conversation, next, ["Thank you — we have your message and will get back to you shortly."], menuOptions(settings));
}

/* ------------------------------------------------------------- Sub-flows */

async function askService(shop: string, platform: string, settings: Settings, conversation: ChatConversation, data: any, prefix = ""): Promise<Turn> {
  const list = await Data.catalogServices(shop, platform, true);
  if (list.length === 0) {
    const next: ChatState = { step: "menu", data: {} };
    return reply(conversation, next, ["Online booking is not set up yet. Please contact us directly."], menuOptions(settings));
  }

  const options: Option[] = list.map((service) => {
    let label = `${service.name} · ${service.durationMin} min`;
    if (service.price > 0) label += ` · ${money(settings, service.price)}`;
    if (service.locationType === "video") label += " · video";
    return { label, value: `service:${service.id}` };
  });
  options.push(backOption());

  const messages = prefix ? [prefix] : [];
  messages.push(`Which of our ${term(settings, "service_plural").toLowerCase()} would you like?`);

  const next: ChatState = { step: "book_service", data };
  return reply(conversation, next, messages, options, input("none"));
}

async function dateOptions(shop: string, platform: string, settings: Settings, data: any): Promise<Option[]> {
  const days = await Availability.nextAvailableDays(shop, platform, settings.timezone, data.service_id, data.resource_id ?? 0, 6);
  const options = days.map((d) => ({ label: d.label, value: `date:${d.date}` }));
  if (options.length) options.push(backOption());
  return options;
}

async function askDate(shop: string, platform: string, settings: Settings, conversation: ChatConversation, data: any, prefix = ""): Promise<Turn> {
  const options = await dateOptions(shop, platform, settings, data);
  if (options.length === 0) {
    const next: ChatState = { step: "menu", data: {} };
    return reply(
      conversation,
      next,
      ["I could not find any free slots in the next few weeks. Please leave us a message and we will sort something out."],
      menuOptions(settings)
    );
  }

  const messages = prefix ? [prefix] : [];
  messages.push("Which day suits you?");

  const next: ChatState = { step: "book_date", data };
  return reply(conversation, next, messages, options, input("none"));
}

async function askTime(shop: string, platform: string, settings: Settings, conversation: ChatConversation, data: any, prefix = ""): Promise<Turn> {
  const daySlots = await Availability.slots(shop, platform, settings.timezone, data.service_id, data.resource_id ?? 0, data.date);
  if (daySlots.length === 0) {
    return askDate(shop, platform, settings, conversation, data, "That day just filled up.");
  }

  const options: Option[] = daySlots.slice(0, 12).map((s) => ({ label: s.label, value: `time:${s.time}` }));
  options.push({ label: "← Another day", value: "date_back" });

  const messages = prefix ? [prefix] : [];
  messages.push("Here are the available times:");

  const next: ChatState = { step: "book_time", data };
  return reply(conversation, next, messages, options, input("none"));
}

async function askFaq(shop: string, platform: string, settings: Settings, conversation: ChatConversation): Promise<Turn> {
  const next: ChatState = { step: "faq_list", data: {} };
  return reply(
    conversation,
    next,
    ["Sure — pick a common question, or just type yours."],
    await faqOptions(shop, platform, true),
    input("text", "Type your question…")
  );
}

/** Keyword-scored FAQ lookup. Deterministic, no external calls. */
async function answerFromFaq(shop: string, platform: string, settings: Settings, conversation: ChatConversation, question: string): Promise<Turn> {
  const rows = await Data.faqs(shop, platform, true);
  let best: (typeof rows)[number] | null = null;
  let score = 0;

  const needle = question.toLowerCase();
  const words = needle.split(/[^a-z0-9]+/).filter((w) => w.length > 2);

  for (const faq of rows) {
    const haystack = `${faq.question} ${faq.keywords}`.toLowerCase();
    let s = 0;
    for (const keyword of faq.keywords.toLowerCase().split(",")) {
      const k = keyword.trim();
      if (k && needle.includes(k)) s += 3;
    }
    for (const word of words) {
      if (haystack.includes(word)) s += 1;
    }
    if (s > score) {
      score = s;
      best = faq;
    }
  }

  const next: ChatState = { step: "faq_list", data: {} };

  if (best && score >= 2) {
    return reply(
      conversation,
      next,
      [(best.answer ?? "").replace(/<[^>]*>/g, ""), "Did that help? You can ask something else, or book an appointment."],
      await faqOptions(shop, platform, true)
    );
  }

  return reply(
    conversation,
    next,
    ["I do not have an answer for that one yet — but a human does. You can leave a message, or book a time to talk."],
    menuOptions(settings)
  );
}

/* ------------------------------------------------------------- Admin/cleanup */

export function conversations(shop: string, platform: string, limit = 50, offset = 0) {
  return prisma.chatConversation.findMany({
    where: { shop, platform },
    orderBy: { updatedAt: "desc" },
    take: limit,
    skip: offset,
  });
}

export function messages(conversationId: number) {
  return prisma.chatMessage.findMany({ where: { conversationId }, orderBy: { id: "asc" } });
}

/** Drop abandoned conversations so the table cannot grow without bound. */
export async function cleanup(retentionDays = 30): Promise<{ deleted: number }> {
  if (retentionDays < 1) return { deleted: 0 };
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);

  const stale = await prisma.chatConversation.findMany({
    where: { updatedAt: { lt: cutoff }, bookingId: 0, visitorEmail: "" },
    select: { id: true },
    take: 500,
  });
  if (stale.length === 0) return { deleted: 0 };

  const ids = stale.map((s) => s.id);
  await prisma.chatMessage.deleteMany({ where: { conversationId: { in: ids } } });
  await prisma.chatConversation.deleteMany({ where: { id: { in: ids } } });
  return { deleted: ids.length };
}
