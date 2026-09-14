/**
 * Building the link a customer actually pays through.
 *
 * No payment provider is involved, and that is the point. The merchant
 * gives us one string — a UPI ID, or a PayPal.me handle — and we render
 * a link and a QR that sends money **directly to them**. GetBooqin
 * never holds it, never settles it, and is not a payment aggregator.
 * That is what makes this shippable without Razorpay Route, its RBI
 * turnover threshold, or the liability of holding other people's money.
 *
 * ## What UPI actually is here
 *
 * `upi://pay?...` is an open NPCI deep link, not a Razorpay feature.
 * On a phone it opens the app chooser straight into GPay, PhonePe,
 * Paytm or a bank app with the amount and reference already filled in;
 * on a desktop the same string is encoded as a QR and scanned. It is
 * strictly better than the merchant's own printed QR, which is static
 * and can carry neither an amount nor a booking reference.
 *
 * ## What it cannot do
 *
 * Tell us whether it was paid. There is no webhook, no callback and
 * nothing to poll — the money lands in the merchant's bank and they see
 * it in their own app. Payment status is therefore the merchant's
 * assertion, which is why `Payment.confirmedByUserId` exists. The `tr`
 * reference and the UTR the customer can quote afterwards are what make
 * that assertion checkable against a bank statement.
 *
 * Zero imports, so the booking page can build the same link client-side
 * that the confirmation email builds server-side.
 */

export type PaymentMethod = "upi" | "paypal" | "cash" | "bank" | "other";

export interface PayeeDetails {
  /** UPI virtual payment address, e.g. "acme@okhdfcbank". */
  upiId?: string;
  /** PayPal.me handle or full link, e.g. "acmedental" or "https://paypal.me/acmedental". */
  payPalMe?: string;
  /** Shown in the payer's app so they know who they're paying. */
  payeeName: string;
}

export interface PaymentLinkRequest {
  payee: PayeeDetails;
  /** Major units — what a person would type. */
  amount: number;
  /** ISO code. UPI is INR only; PayPal.me takes the currency in the path. */
  currency: string;
  /** Short booking reference, carried through so a bank line can be matched back. */
  reference: string;
  /** What the payer sees as the reason. */
  note: string;
}

/**
 * A UPI virtual payment address.
 *
 * Deliberately permissive about the handle — there are hundreds of PSP
 * suffixes and new ones appear — while still rejecting the things that
 * are definitely not a VPA. A wrong-but-valid address is not something
 * validation can catch, which is exactly why setup should include
 * sending yourself one rupee.
 */
export function isUpiId(value: string): boolean {
  return /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/.test(value.trim());
}

/** Accepts a handle or a full paypal.me URL, and normalises to the handle. */
export function payPalMeHandle(value: string): string {
  // The scheme is optional: merchants paste "paypal.me/acme" as often
  // as the full URL, because that is what their own app shows them.
  const trimmed = value
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?paypal\.me\//i, "")
    .replace(/^@/, "")
    .replace(/\/+$/, "");
  return /^[a-zA-Z0-9._-]{1,50}$/.test(trimmed) ? trimmed : "";
}

/** Two decimal places, because a payment app will show exactly what it is given. */
function money(amount: number): string {
  return amount.toFixed(2);
}

/**
 * The link, or "" when this method cannot produce one.
 *
 * Cash and bank transfer deliberately have no link: they are real ways
 * to be paid and belong in the record, but there is nothing to click.
 */
export function paymentLink(method: PaymentMethod, req: PaymentLinkRequest): string {
  if (method === "upi") {
    const upi = (req.payee.upiId ?? "").trim();
    if (!isUpiId(upi)) return "";
    const params = new URLSearchParams({
      pa: upi,
      pn: req.payee.payeeName.slice(0, 50),
      am: money(req.amount),
      cu: "INR",
      tn: req.note.slice(0, 50),
      tr: req.reference,
    });
    // URLSearchParams encodes spaces as "+", which some UPI apps pass
    // through literally into the note rather than decoding. %20 is
    // understood everywhere.
    return `upi://pay?${params.toString().replace(/\+/g, "%20")}`;
  }

  if (method === "paypal") {
    const handle = payPalMeHandle(req.payee.payPalMe ?? "");
    if (!handle) return "";
    // paypal.me takes the amount in the path, currency appended. It
    // pre-fills rather than fixes the amount — same as UPI.
    return `https://paypal.me/${handle}/${money(req.amount)}${req.currency.toUpperCase()}`;
  }

  return "";
}

/**
 * The same payment, addressed to one specific UPI app.
 *
 * `upi://pay?…` is the NPCI standard and every certified app handles
 * it — which is the problem. Android sends it to whichever app holds
 * the default, and WhatsApp registers as a handler, so a customer with
 * WhatsApp Pay set as default is taken there with no chooser and no way
 * back. They do not know why, and neither does the merchant.
 *
 * Each app also publishes its own scheme carrying identical parameters,
 * so offering them explicitly lets the customer pick instead of the OS
 * deciding for them. The generic link stays as "any UPI app" for
 * devices where the chooser works properly.
 *
 * Only relevant when *tapping* a link on the paying phone. A QR is
 * scanned from inside whichever app the customer already opened, so it
 * never had this problem.
 */
export const UPI_APPS = [
  { id: "phonepe", label: "PhonePe", scheme: "phonepe://upi/pay" },
  { id: "gpay", label: "Google Pay", scheme: "gpay://upi/pay" },
  { id: "paytm", label: "Paytm", scheme: "paytm://upi/pay" },
  { id: "bhim", label: "BHIM", scheme: "bhim://upi/pay" },
] as const;

export interface UpiAppLink {
  id: string;
  label: string;
  url: string;
}

/**
 * One link per app, plus the generic one.
 *
 * Returns [] for anything that isn't a payable UPI request, so a caller
 * can render the list unconditionally.
 */
export function upiAppLinks(req: PaymentLinkRequest): UpiAppLink[] {
  const generic = paymentLink("upi", req);
  if (!generic) return [];

  const query = generic.slice(generic.indexOf("?"));
  return [
    { id: "any", label: "Any UPI app", url: generic },
    ...UPI_APPS.map((app) => ({ id: app.id, label: app.label, url: `${app.scheme}${query}` })),
  ];
}

/**
 * Which method a shop can offer, given what it has configured.
 *
 * UPI is INR-only by definition — offering it to a shop pricing in
 * euros would produce a link that either fails or silently charges
 * rupees.
 */
export function availableMethod(payee: PayeeDetails, currency: string): PaymentMethod | null {
  if (currency.toUpperCase() === "INR" && isUpiId(payee.upiId ?? "")) return "upi";
  if (payPalMeHandle(payee.payPalMe ?? "")) return "paypal";
  return null;
}

/**
 * What the customer owes at booking time.
 *
 * Fixed beats percent when both are set — a merchant who typed an
 * amount meant the amount. Never more than the price: a deposit larger
 * than the service is a typo, and charging it would be worse than
 * ignoring it.
 */
export function amountDueFor(
  price: number,
  policy: { paymentRequired: boolean; depositPercent: number; depositAmount: number }
): number {
  if (!policy.paymentRequired || price <= 0) return 0;

  const raw =
    policy.depositAmount > 0
      ? policy.depositAmount
      : policy.depositPercent > 0
        ? (price * policy.depositPercent) / 100
        : price;

  return Math.min(round2(Math.max(raw, 0)), round2(price));
}

/**
 * A short reference a person can read out over the phone, and that a
 * UPI app will accept.
 *
 * Strictly alphanumeric. This used to be `BK-${last six of the uid}`,
 * which produced references like `BK-T_0001` — and NPCI's `tr` field is
 * alphanumeric, so several UPI apps reject punctuation in it. The link
 * then fails on some phones and works on others, with nothing on screen
 * explaining why.
 *
 * Non-alphanumerics are stripped rather than replaced, and the result
 * is padded, so a uid made mostly of punctuation still yields a usable
 * reference instead of a bare "BK".
 */
export function paymentReference(bookingUid: string): string {
  const cleaned = bookingUid.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return `BK${cleaned.slice(-6).padStart(6, "0")}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
