# What to build, what it's worth, and whether there's scope

Third research document. Companion to [crm-marketing-plan.md](crm-marketing-plan.md)
(what to build) and [india-market-analysis.md](india-market-analysis.md) (who
buys it). Research conducted 2026-09-15 across three tracks: feature-level
voice-of-customer, category pricing-power, and non-subscription revenue lines.

**This document corrects the first two.** Three things in
[crm-marketing-plan.md](crm-marketing-plan.md) are contradicted by customer
evidence, and the scope question has a narrower answer than the market
sizing implied. Both are stated plainly in §1 and §6.

Tagging as before: **[P]** primary source read directly, **[S]** secondary,
**[V]** verbatim customer quote read off the page.

---

## 1. The answer, up front

**Is there scope? Yes, but it is bounded, and the bound is now measurable.**

| | ARPU/merchant/month | What it takes |
|---|---:|---|
| Subscription alone | **₹999–1,499** | Bounded by the customer's own value-added. Established in [india-market-analysis.md](india-market-analysis.md) §2.4 |
| **+ adjacencies, realistic base case** | **₹1,250–1,600** | Payments on high-ticket verticals, package module |
| + every adjacency at the top of its range | ₹1,950 | Requires all six lines to hit maximum simultaneously. **Not a base case** |
| **+ demand generation (lead-gen/marketplace)** | **₹2,500–4,500** | Converts you into a marketplace. Different company, different capital |

**The honest framing: this is a good ₹10–20 Cr ARR software business with a
small team, and it is not a venture-scale one unless you take the marketplace
bet.** Practo does ₹234 Cr revenue FY25 *with* a marketplace, ₹3,500 Cr+ GMV
and 15 years of brand **[P]**. That is what the marketplace path buys and what
it costs.

**And three corrections to the plan I wrote:**

1. **Waitlist got zero organic demand mentions** across ~150 primary reviews
   and four owner forum threads. It is heavily marketed by Zenoti, Phorest and
   Fresha, and not one owner asked for it. It is currently gated at Starter in
   [plans.ts](../core/src/billing/plans.ts) and listed as a headline feature.
   **Ungate it, stop selling on it.**
2. **Broadcast marketing shows up in customer voice as a *cost complaint*, not
   a want.** Phase 9 of the plan treats campaigns as the marketing payoff.
   Owners talk about message bundles the way they talk about fees. The feature
   is right; **the framing is wrong** — see §4.3.
3. **The no-show pitch is weaker than assumed.** The best transactional data
   available says salon no-show is **3%** and cancellation **8–16%** — and the
   bigger revenue hole is neither. See §3.

---

## 2. What customers actually ask for

Ranked by evidence of organic demand — what appears unprompted in reviews and
owner forums, not what vendors market.

### Tier 1 — asked for constantly, complained about loudest

**1. Reminders that actually get delivered, with a reply loop.** This is the
clearest wedge available in India today, because **two of the three Indian
incumbents are publicly losing reviews on exactly this**:

> *"Whatsapp Services lags alot also reminder messages doesnt works"*
> — Mayuresh M., salon, India, DINGG, 27 Sep 2023 **[V]**

> *"Very delayed whatsapp integration"* · *"international numbers not available
> on whatsapp"* — Dr. Srini, MioSalon, 5 Jul 2024 **[V]**

And the positive case, from the dental incumbent:

> *"Treatment specific reminders, post treatment instructions very beneficial
> to the patients"* — Dr Rajeshwari, BestoSys, 10 Dec 2025 **[V]**

Cliniko's 2025 year-in-review leads with *"send multiple pre-appointment
reminders and follow up messages"* — ahead of audit logs, passkeys and
invoicing **[P]**. **Message deliverability is a feature, not plumbing.**

**2. Conditional deposits — not blanket deposits.** The demand is for
*granular control*, and the counter-voice is as strong as the voice:

> *"My website takes 50% of the treatment cost when booking is made online…
> it's saved me so much money because I hardly ever have any no shows."* **[V]**

> *"I think asking for a deposit will steer clients away. You pay a deposit for
> a house not a beauty treatment in my opinion."* **[V]**

> *"can't offer individual deposit requirements for specific services"*
> — Demaris C., Vagaro **[V]**

**The primitive owners actually want is risk-based**: deposit required only for
new clients, clients with N prior no-shows, or specific long/high-value
services. One owner describes Ovatu's model approvingly — *"it doesn't take the
deposit/cancellation % unless they cancel"* **[V]**.

⚠️ **This is the one Tier-1 item with an India problem.** Every deposit
complaint above assumes a stored card. RBI's tokenisation and e-mandate regime
makes "authorise now, charge on breach" impractical at a ₹999 price point. **The
realistic Indian primitive is a conditional UPI advance-payment link with an
expiry** — which [paymentLinks.ts](../core/src/booking/paymentLinks.ts) already
builds. Note also that the researcher found **no primary evidence of Indian
owners asking for deposits** — the demand evidence is US/UK. Treat as a
hypothesis to validate in interviews, not a settled requirement.

**3. Billing that is correct: GST invoice + product sale + package redemption
on one bill.** India-specific and non-negotiable. In the US this is "POS"; in
India it is a compliance artefact and owners otherwise run a second tool
alongside the booking system.

> *"revised sale amount does not show in daily sales"* after cancellations or
> edits — Mani N., franchise owner, India, DINGG **[V]**

**4. Staff commission calculation, correct.** Low glamour, highest churn risk.
**The only 1-star MioSalon review in the Indian set is a commission bug:**

> *"full of bugs (for example, the employee's commissions were wrongly
> calculated)"* — Robin, 7 Mar 2023 **[V]**

**5. Memberships / packages / prepaid credits with automatic deduction.**
Consistently the #1 *missing* feature in clinic software:

> *"Lack of ability to generate recurring invoices. Lack of ability to manage a
> membership"* — Robin P., director, Cliniko, 10 Feb 2025 **[V]**

Zenoti's platform data (30,000+ businesses) shows salons and medspas averaged
**24% membership sales growth** in 2024 **[P]**.

### Tier 2 — real but segment-dependent

Online booking that converts (including **existing-clients-only** booking, a
recurrent clinic request and the opposite of the salon marketplace instinct);
reports (a *retention* feature, almost never a purchase trigger); multi-branch;
reviews funnelled to Google (appears as an explicit *switching* reason);
inventory with consumption and **expiry-date** tracking; clinical forms, notes
and photos.

### Tier 3 — vendors market it hard, customers never ask

| Feature | Organic mentions | Note |
|---|---:|---|
| **Waitlist / gap-filling** | **0** | Heavily marketed by Zenoti, Phorest, Fresha. Not one owner asked |
| **AI receptionist / auto-reply** | **1, negative** | *"AI assistant lost us lots of clients - charge to credit card on file did not work"* — Veronica R., Square, 29 May 2025 **[V]** |
| Two-way Google/Outlook sync | 1 | A solo-operator need; front-desk-run businesses don't care |
| Loyalty points | Setup pain only | Never a buying reason |
| Recurring appointments | 1 | — |
| Broadcast campaigns | Cost complaints | *"limited amount of texts and emails in purchased packages"* **[V]** |

### What makes them buy, and what makes them leave

**Buy:** price; *teachability* — *"Anyone can learn in a day and doesn't
require technology knowledge"* **[V]**; all-in-one; a named human who answers;
**migration help** (one owner chose DINGG citing the founders by name plus help
migrating off Zenoti).

**Leave**, in frequency order: **price creep and à-la-carte fees** (*"À la carte
model…increases pricing exponentially"*; *"I didn't like how they said they
wouldn't charge but are now charging"* **[V]**); outages and speed; support
latency; and **onboarding/migration cost** — Zenoti's most consistent
complaint, which is simultaneously your biggest acquisition wedge and your
biggest future moat.

---

## 3. The no-show pitch needs rebuilding

The best available data is Zenoti's 2025 benchmark report — platform
transaction data across 30,000+ businesses **[P]**:

| Segment | No-show | Cancellation |
|---|---:|---:|
| Salons | **3%** | 8% |
| Nail salons | 1% | 16% |
| Barbershops | 4% | 2% |
| Medspas | 5% | 16% |

Vendor-published and therefore directionally self-serving, but it is real
booking data at scale, and **it says cancellation is the bigger hole than
no-shows in most salon segments.** Healthcare is different — a systematic
review of missed GP appointments finds a **mean of 15.2%** **[S]** — which is
another argument for the clinic-first recommendation.

**The bigger hole than either is unbooked online capacity.** Zenoti's data: the
average salon takes **30% of bookings online; top earners take 59%**. Medspas:
11% average vs 31% for top performers **[P]**. That gap is worth far more than
a 3% no-show rate, and it is what the product is already good at.

⚠️ **Numbers circulating in Indian marketing that should not go in a deck:**
"Indian dental no-show is 20–30%, costing ₹10–15 lakh a year" (vendor blog, no
method); "deposits cut no-shows 60–80%" (a "2026 No-Show Report" that discloses
no sample size and doesn't say whether figures are transactional or survey);
"Cochrane says reminders cut no-shows up to 50%". All trace to SEO listicles
citing each other.

**The defensible ROI claim: at ₹999/month, break-even is roughly one recovered
appointment per month.** That survives contact with even the most conservative
number above. Lead with *"the appointment book fills itself and the bill is
correct"*, not with a no-show percentage you cannot source.

One useful India-specific finding: a pediatric dental RCT found the
**voice-message group at 8.2% no-show vs the SMS group at 17.7%** **[S]** —
text reminders *underperformed* calls. That argues for a WhatsApp message that
is *interactive* (confirm / reschedule buttons) rather than a one-way blast,
which is what Phase 6 of the plan specifies anyway.

---

## 4. Pricing power: what the category proves is monetisable

### 4.1 Every vendor has exactly one meter, and it is never "features"

Read across fourteen global vendors' live pricing pages **[P]**:

| Meter | Vendors | Examples |
|---|---:|---|
| **Headcount** (staff / calendars / seats) | **10 of 14** | Booksy +$20/staff · Vagaro +$10/calendar · SimplePractice +$74/clinician · Cliniko bands $45→$95 at 2 practitioners |
| **Message volume** | **10 of 14** | Fresha 20 free then €0.15 · Cliniko $0.10 · **Phorest's entire tier ladder is 1,000 → 27,000 SMS/month** |
| **Payment volume** | 4 | Square gives away unlimited staff calendars free and monetises 2.6% + 15¢ |
| **Commission** | 5 | Treatwell 35% · Booksy 30% · Vagaro 20% · Mindbody 20% capped at $30 |

**Vendors that gate on *features* — Mindbody, Acuity — have the widest price
spread and the most upgrade friction.** Vendors that abandoned per-seat
(Phorest, Treatwell, Square) replaced it with a *different meter*, never with a
flat fee. Nobody in this category is genuinely flat.

### 4.2 The meter you cannot use, and what to use instead

**The category's most universal meter is messages — and as a Meta Tech Provider
you are structurally barred from marking up messages** ([india-market-analysis.md](india-market-analysis.md) §4.4).
The single most proven lever in the category is unavailable to you.

**The substitute is to meter the quota, not the message.** A cap on broadcasts
per month, contacts, or seats is a feature limit, not a markup — it stays
inside Meta's rules and it is what [plans.ts](../core/src/billing/plans.ts)
already does. Available meters, ranked by fit:

1. **Staff seats** — matches 10 of 14 vendors, scales with customer success,
   and `teamMembers` already exists as a limit key.
2. **Contacts** — the natural CRM meter; new limit key.
3. **Broadcasts per month** — quota, not markup.
4. **Locations** — `businesses` already exists.

### 4.3 What to put inside the base, and what to gate

The category bundles these and they don't hold price — **put them inside ₹999
to justify it**: forms, deposit/no-show tooling, basic reporting, **waitlist**
(§2 Tier 3), online booking, WhatsApp transactional messaging.

Genuine upgrade triggers, in the order the category proves them: extra staff
seats → contacts → memberships/packages → multi-branch → advanced reporting.

**On broadcasts specifically.** Customer voice treats campaign marketing as a
cost, and Meta's rate card agrees — 1,000 marketing messages costs the merchant
**₹863/month, nearly as much as the software**
([india-market-analysis.md](india-market-analysis.md) §4.3). So do not sell
"campaigns". Sell the two jobs owners actually have: **fill tomorrow's gaps**
and **win back lapsed clients** — both narrow, both obviously ROI-positive,
both cheap in message volume. Show estimated cost before send. This is a
reframing of Phase 9, not a cancellation of it.

### 4.4 Do not build an AI receptionist

The pricing-power research is unambiguous that AI carries the highest
willingness-to-pay in the category: **8 of 8 vendors keep it out of the base
plan** — Jane's AI Scribe $15/practitioner, SimplePractice's Note Taker $35 and
Care Aide $59, Zenoti and Pabau billing "AI call minutes" as consumption.
Standalone AI receptionists run $49–$599/month.

**And you should still not build one for India**, for two reasons that only
appear when the three research tracks are read together:

- **Meta gives it away free in India.** Business AI shipped inside the free
  WhatsApp Business app on 2026-05-14 — FAQs, lead capture, appointment
  booking, all Indian languages **[P]**. The global category is charging
  $49–$599/month for a thing Meta now bundles at zero in your exact market.
- **The only real owner mention of an AI receptionist in the entire corpus is a
  complaint that it lost them clients.**

**Where AI does pay here is internal, not customer-facing**: drafting replies
for the operator to approve, summarising a contact's history, categorising
inbound. That is the G9 gate in the plan, and the answer is: suggest-only,
never auto-send — which is what it already says.

---

## 5. Revenue lines beyond the subscription

Ranked by realistic ₹/merchant/month for a single-location clinic or salon
doing ~₹2.5–3L/month in collections.

| # | Line | ₹/mo | Margin | Regulatory risk | Verdict |
|---:|---|---:|---|---|---|
| 1 | **Lead generation / marketplace** | **₹1,000–3,000** | 80–90% gross, **20–40% net of consumer CAC** | Low | The only line that clears the bar. Different company |
| 2 | **Packages / memberships** (% of package sales) | ₹100–400 | ~90% | **Medium** — unregulated only if the *merchant* issues it | Build it. Don't hold the float |
| 3 | **Payments attach** | **₹150–500** | 20–40% | **High** | Real but small. See below |
| 4 | Lending / embedded finance | ₹50–150 | 60–80%, 5% FLDG exposure | **High** | Khatabook and OkCredit both failed here |
| 5 | Deposits / no-show protection | ₹50–200 | ~85% | **High** — T+1 settlement means you cannot legally hold the deposit | Build the *feature*, don't monetise the float |
| 6 | Retail / supply marketplace | ₹0–300 | 3–8%, working-capital heavy | Low | Khatabook MyStore and OkCredit OkShop both shut |
| 7 | Payroll / staff | ₹0–100 *incremental* | 80% | Low | Competes for the same ₹999 wallet |

### 5.1 The UPI question was answered this week

**14 Sep 2026:** the Finance Ministry created the legal room for MDR above
₹2,000. **15 Sep 2026:** NPCI set **0.4% MDR on P2M UPI above ₹2,000, capped at
₹300, effective 15 October 2026.** Below ₹2,000 remains free; NPCI states ~96%
of merchant transactions are unaffected **[P]**.

**This does not rescue the payments line for most of the market.** A salon
ticket is ~₹600; a GP consult ₹300–700. Essentially none clear the threshold.
And 94% of small merchants already accept UPI on their own free QR — any
platform fee is defeated by a counter-top sticker.

**Practo is the live proof of the model and of its fragility.** Ray is ₹999/mo
with payments at 2%, or ₹1,499 with 1.8% **[P]**. Cashfree lists at 1.95% — so
Practo's gross spread *on cards is near zero*. **The 2% only earns when charged
on UPI, where their cost is ~zero.** That is the actual trick, and NPCI has now
put a floor under how long it lasts.

**But there is a real segmentation insight here**, and it converges with
everything else: **from 15 October, merchants whose average ticket exceeds
₹2,000 are structurally advantaged** — dental, dermatology/aesthetics, IVF,
physiotherapy, premium spa packages. Fillings, RCTs and crowns clear ₹2,000
comfortably; a ₹600 salon ticket never will.

### 5.2 Two hard constraints

**Never hold the money.** RBI's 2025 Payment Aggregator Directions require
₹15 Cr net worth at application rising to ₹25 Cr by end of the third FY, plus
escrow and T+1 settlement. [paymentLinks.ts](../core/src/booking/paymentLinks.ts)
already pays the merchant directly and must stay that way. To earn anything,
be a platform partner of a licensed PA (Razorpay Route, Cashfree Easy Split) —
Razorpay's published illustrative partner commission is **0.1% or ₹10**, which
on ₹3L of TPV is **₹300/month**. That is the honest anchor.

**A PA licence and a booking marketplace are mutually exclusive** under the
2025 Directions. The lead-gen line and an owned payments rail cannot sit in the
same entity. **Choose one before either is built.**

### 5.3 What lead-gen would be worth, and what it would cost

Justdial's FY25 revenue across ~600,000 active paid campaigns computes to
**₹1,586/merchant/month** **[DERIVED from primary]**. Urban Company takes
**28.3%** of service value **[P]**. Indian local merchants demonstrably pay
~1.6× their software wallet for demand.

Ceiling arithmetic: a salon ticket of ~₹600 at 55–65% gross margin is ~₹350–400
of contribution per visit. A merchant can rationally pay **25–40% of first-visit
contribution → ₹100–250 per genuinely new customer.** Ten to twenty a month is
₹1,000–5,000/month.

**That is where the scope is, and it is a different company** — competing with
Justdial, Urban Company and Google for consumer attention, monetising only the
subset of merchants who actually receive bookings, at 20–40% net margin after
consumer CAC rather than 85%.

**A warning worth weighing:** Fresha ran the category's biggest free-forever
experiment backed by a 20% marketplace take-rate, and **abandoned it** — its
page today shows no free plan, only a trial into per-seat subscription, while
running the cheapest card rates in the category **[P]**. A vendor moving *from*
take-rate *to* subscription is the opposite of the usual narrative.

---

## 6. What this means for the build

### 6.1 Revised feature order

Phases 5, 6 and 7 of [crm-marketing-plan.md](crm-marketing-plan.md) survive
unchanged — contact identity, WhatsApp transactional, inbox. They are the three
things without which nothing else is true, and Tier 1 demand item #1 is
precisely Phase 6 done well.

**Insert before Phase 9 (marketing), because the evidence ranks them higher:**

| New | What | Why |
|---|---|---|
| **Correct billing** | GST invoice + product sale + package redemption on one bill; fix the cancel/edit→daily-sales desync that DINGG is losing reviews over | Tier 1 #3. Compliance artefact in India, not a POS nicety |
| **Packages / memberships** | Prepaid credits with automatic deduction, recurring billing | Tier 1 #5, #1 missing in clinic software, and a ₹100–400/mo revenue line |
| **Staff commission** | Calculated correctly, reconciled, visible to staff | Tier 1 #4. The only 1-star review in the Indian set |
| **Conditional deposits** | UPI advance link, required only for new clients / repeat no-shows / high-value services | Tier 1 #2, with the India adaptation |
| **Queue / token + wait time** | Walk-in mode alongside appointments | No US analogue; DINGG ships it; a BestoSys dentist asked for wait time in minutes |

**Demote:** waitlist (built already — ungate it, stop marketing it), broadcast
campaigns (reframe to "fill tomorrow" and "win back"), AI receptionist (don't).

### 6.2 Revised packaging

| | Contains | Meter |
|---|---|---|
| **Trial, 14 days, card required** | Everything | ChartMogul: card-gated converts 5× |
| **₹999/mo clinic** | Calendar, unlimited bookings, WhatsApp transactional, GST billing, deposits, forms, reports, **waitlist**, 1–3 staff | — |
| **₹1,799/mo** | + packages/memberships, 4–10 staff, broadcasts | **Staff seats**, then contacts |
| **₹2,999/mo** | + multi-branch, advanced reports, unlimited | Locations |

Annual default (62% vs 41% retention under $100 ARPA), with a multi-year
gradient following Practo's four-year precedent.

### 6.3 What the numbers become

At a blended **₹1,300/month** ARPU (subscription plus the realistic adjacency
mid-point), 4.2% monthly churn, 85% gross margin:

| | Before (₹999) | **After (₹1,300)** |
|---|---:|---:|
| Gross-profit LTV | ₹20,214 | **₹26,310** |
| Max CAC at 3:1 | ₹6,738 | **₹8,770** |
| Payback | 7.9 months | 7.9 months |

**The extra ₹300 of ARPU buys ₹2,000 of CAC headroom**, which is the difference
between a phone call and a phone call plus a field visit — and the GTM research
says every Indian SMB company that scaled ended up offline.

---

## 7. What would change this answer

- **If lead-gen can be built cheaply on top of an existing installed base** —
  i.e. if merchants already on the product generate enough consumer traffic
  through their own booking links that a directory becomes a by-product rather
  than a capital project — the ₹2,500–4,500 ARPU tier opens without becoming
  Justdial. Worth testing once there are a few hundred live merchants, not
  before.
- **If average ticket in the chosen vertical is above ₹2,000**, the payments
  line roughly triples and the base case moves to ₹1,500–1,800. This is a
  vertical-selection decision, and dental already wins on three other grounds.
- **If Meta's Business AI adds a calendar**, §4.4 inverts and the defensible
  surface shrinks sharply. Watch quarterly.
- **If deposits turn out not to be wanted in India** — the demand evidence is
  entirely US/UK and the researcher found none from Indian owners — then Tier 1
  item #2 drops out and the conditional-deposit build is wasted. **Validate
  this in the first ten customer interviews.**

## 8. Still unverified

Reddit, G2, Google Play and the App Store were all inaccessible to the
research (domain blocks and 403s), so the voice-of-customer corpus is Capterra
US + Capterra India + SoftwareAdvice UK + SalonGeek. **There is no Indian
salon-owner forum equivalent to SalonGeek**, which is a genuine gap in the
Indian evidence. Also open: Practo Prime's actual per-patient fee (not
published; third-party claims of ₹600–1,000/lead are SEO blogs); Fresha's
current marketplace fee status, which its own page and every third-party guide
now disagree about; Petpooja's supply-marketplace take rate; and the Indian
salon retail attach rate.
