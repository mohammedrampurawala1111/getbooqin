/**
 * Industry presets. Ported verbatim from shopify-openslot's app/lib/presets.ts
 * (itself ported from the WordPress plugin's includes/Presets.php).
 *
 * The data model is deliberately generic: a Resource (person, room, bay,
 * table, machine) delivers a Service to a Customer inside a Booking. A preset
 * only changes the words shown in the UI and a few sensible defaults — it
 * never changes the schema. That is what keeps the app industry-neutral.
 *
 * `defaults` only ever contains keys that real booking logic actually reads
 * (see availability.ts/bookings.ts for min_notice_hours, max_advance_days,
 * cancel_cutoff_hours, auto_confirm, require_phone) plus real customer-facing
 * copy (consent_text, widget_text, templates overrides) — never a field with
 * no downstream effect, so a preset's promise always matches what it does.
 * `generic` deliberately carries none of these beyond slot_interval: its
 * values already match defaultSettings()'s baseline, so it is the neutral
 * "nothing customized yet" state every other preset is written relative to.
 */

export interface Terms {
  resource_single: string;
  resource_plural: string;
  service_single: string;
  service_plural: string;
  booking_single: string;
  booking_plural: string;
  customer_single: string;
  customer_plural: string;
}

export interface Preset {
  label: string;
  terms: Terms;
  defaults: Record<string, unknown>;
}

export const PRESETS: Record<string, Preset> = {
  generic: {
    label: "Generic / Other",
    terms: {
      resource_single: "Staff",
      resource_plural: "Staff",
      service_single: "Service",
      service_plural: "Services",
      booking_single: "Booking",
      booking_plural: "Bookings",
      customer_single: "Customer",
      customer_plural: "Customers",
    },
    defaults: { slot_interval: 30 },
  },
  clinic: {
    label: "Clinic / Healthcare",
    terms: {
      resource_single: "Practitioner",
      resource_plural: "Practitioners",
      service_single: "Treatment",
      service_plural: "Treatments",
      booking_single: "Appointment",
      booking_plural: "Appointments",
      customer_single: "Patient",
      customer_plural: "Patients",
    },
    defaults: {
      slot_interval: 15,
      min_notice_hours: 4,
      max_advance_days: 90,
      cancel_cutoff_hours: 24,
      auto_confirm: false,
      require_phone: true,
      waitlist_enabled: true,
      waitlist_offer_window_hours: 3,
      consent_text:
        "We require at least 24 hours' notice to cancel or reschedule your appointment. Cancellations made with less notice, or missed appointments, may be subject to a missed-appointment fee. This helps us keep appointment times available for other patients who need care.",
      widget_text: {
        noSlots: "No further appointments left with this practitioner today. Please call us if you need an urgent visit.",
      },
      templates: {
        customer_created_pending_subject: "We've received your {{booking_term}} request — {{date}} at {{time}}",
        customer_created_pending_body:
          "Hi {{customer_name}},\n\nThank you — we've received your request to see {{resource}} for {{service}} on {{date}} at {{time}} {{timezone}}.\n\nA member of our team will confirm your appointment shortly. If you have any medical history or referral information to share beforehand, please reply to this email.\n\n{{manage_url}}\n\n{{business_name}}",
        customer_cancelled_subject: "Your appointment on {{date}} has been cancelled",
        customer_cancelled_body:
          "Hi {{customer_name}},\n\nYour appointment for {{service}} with {{resource}} on {{date}} at {{time}} has been cancelled.\n\nIf you still need care, please book a new time on our website or call us directly.\n\n{{business_name}}",
      },
    },
  },
  salon: {
    label: "Salon / Spa / Barber",
    terms: {
      resource_single: "Stylist",
      resource_plural: "Stylists",
      service_single: "Service",
      service_plural: "Services",
      booking_single: "Appointment",
      booking_plural: "Appointments",
      customer_single: "Client",
      customer_plural: "Clients",
    },
    defaults: {
      slot_interval: 15,
      min_notice_hours: 1,
      max_advance_days: 30,
      cancel_cutoff_hours: 24,
      auto_confirm: true,
      require_phone: false,
      waitlist_enabled: true,
      waitlist_offer_window_hours: 1,
      consent_text:
        "Need to cancel? Just let us know at least 24 hours ahead so we can offer your spot to someone else. Less notice than that, or a no-show, may be charged at 50% of the service price.",
      widget_text: {
        noSlots: "Fully booked for today — try another day, or give us a call to check for cancellations.",
      },
      templates: {
        customer_created_subject: "You're booked! {{date}} at {{time}} with {{resource}}",
        customer_created_body:
          "Hi {{customer_name}},\n\nYou're all set for {{service}} with {{resource}} on {{date}} at {{time}}.\n\n{{payment_line}}\n\nNeed to change anything? Just tap here:\n{{manage_url}}\n\nSee you soon,\n{{business_name}}",
        customer_cancelled_subject: "Your {{date}} appointment has been cancelled",
        customer_cancelled_body:
          "Hi {{customer_name}},\n\nYour {{service}} appointment with {{resource}} on {{date}} at {{time}} has been cancelled.\n\nWhenever you're ready, you can grab a new time on our website.\n\n{{business_name}}",
      },
    },
  },
  automotive: {
    label: "Automotive / Repair Shop",
    terms: {
      resource_single: "Bay",
      resource_plural: "Bays",
      service_single: "Job",
      service_plural: "Jobs",
      booking_single: "Booking",
      booking_plural: "Bookings",
      customer_single: "Customer",
      customer_plural: "Customers",
    },
    defaults: {
      slot_interval: 60,
      min_notice_hours: 24,
      max_advance_days: 45,
      cancel_cutoff_hours: 48,
      auto_confirm: false,
      require_phone: true,
      waitlist_enabled: true,
      waitlist_offer_window_hours: 4,
      consent_text:
        "Please give us at least 48 hours' notice to cancel or move a booked job — our bays are scheduled tightly and late cancellations affect other customers waiting for a slot.",
      widget_text: {
        noSlots: "No bays available on this day. Call us to check for a cancellation.",
      },
      templates: {
        customer_created_pending_subject: "Job request received — {{date}} at {{time}}",
        customer_created_pending_body:
          "Hi {{customer_name}},\n\nThanks — we've received your request for {{service}} on {{date}} at {{time}}.\n\nWe'll confirm your bay booking shortly. If you have any specific issues with the vehicle, reply to this email and we'll pass it to the technician.\n\n{{manage_url}}\n\n{{business_name}}",
        customer_cancelled_subject: "Your job booking on {{date}} was cancelled",
        customer_cancelled_body:
          "Hi {{customer_name}},\n\nYour {{service}} booking on {{date}} at {{time}} has been cancelled.\n\nNeed to get it back in? Book a new slot any time on our website.\n\n{{business_name}}",
      },
    },
  },
  legal: {
    label: "Legal / Consulting",
    terms: {
      resource_single: "Consultant",
      resource_plural: "Consultants",
      service_single: "Consultation Type",
      service_plural: "Consultation Types",
      booking_single: "Consultation",
      booking_plural: "Consultations",
      customer_single: "Client",
      customer_plural: "Clients",
    },
    defaults: {
      slot_interval: 30,
      min_notice_hours: 24,
      max_advance_days: 60,
      cancel_cutoff_hours: 48,
      auto_confirm: false,
      require_phone: true,
      waitlist_enabled: false,
      waitlist_offer_window_hours: 24,
      consent_text:
        "We require at least 48 hours' notice to reschedule or cancel a consultation. Cancellations made with less notice, or missed appointments, will be billed at the full consultation rate, as this time is reserved exclusively for your matter.",
      widget_text: {
        noSlots: "No further consultation times are available on this day. Please contact our office directly.",
      },
      templates: {
        customer_created_pending_subject: "Your consultation request — {{date}} at {{time}}",
        customer_created_pending_body:
          "Dear {{customer_name}},\n\nThank you for your request to meet with {{resource}} on {{date}} at {{time}} {{timezone}} regarding {{service}}.\n\nWe will confirm this appointment shortly. Please have any relevant documents ready in advance.\n\n{{manage_url}}\n\nKind regards,\n{{business_name}}",
        customer_cancelled_subject: "Your consultation on {{date}} has been cancelled",
        customer_cancelled_body:
          "Dear {{customer_name}},\n\nThis confirms that your consultation with {{resource}} on {{date}} at {{time}} has been cancelled.\n\nPlease contact our office directly to arrange a new time.\n\nKind regards,\n{{business_name}}",
      },
    },
  },
  education: {
    label: "Education / Tutoring",
    terms: {
      resource_single: "Tutor",
      resource_plural: "Tutors",
      service_single: "Course",
      service_plural: "Courses",
      booking_single: "Lesson",
      booking_plural: "Lessons",
      customer_single: "Student",
      customer_plural: "Students",
    },
    defaults: {
      slot_interval: 30,
      min_notice_hours: 12,
      max_advance_days: 45,
      cancel_cutoff_hours: 24,
      auto_confirm: false,
      require_phone: false,
      waitlist_enabled: true,
      waitlist_offer_window_hours: 4,
      consent_text:
        "Please cancel or reschedule at least 24 hours before your lesson. Late cancellations and missed lessons may still be charged, as this time is reserved for you.",
      widget_text: {
        noSlots: "No lesson times left today — please choose another day.",
      },
      templates: {
        customer_created_pending_subject: "Lesson request received — {{date}} at {{time}}",
        customer_created_pending_body:
          "Hi {{customer_name}},\n\nThanks for booking {{service}} with {{resource}} on {{date}} at {{time}}.\n\nWe'll confirm shortly. See you in class!\n\n{{manage_url}}\n\n{{business_name}}",
        customer_cancelled_subject: "Your lesson on {{date}} has been cancelled",
        customer_cancelled_body:
          "Hi {{customer_name}},\n\nYour {{service}} lesson with {{resource}} on {{date}} at {{time}} has been cancelled.\n\nYou can book a new lesson any time on our website.\n\n{{business_name}}",
      },
    },
  },
  fitness: {
    label: "Fitness / Wellness",
    terms: {
      resource_single: "Trainer",
      resource_plural: "Trainers",
      service_single: "Class",
      service_plural: "Classes",
      booking_single: "Session",
      booking_plural: "Sessions",
      customer_single: "Member",
      customer_plural: "Members",
    },
    defaults: {
      slot_interval: 30,
      min_notice_hours: 1,
      max_advance_days: 14,
      cancel_cutoff_hours: 2,
      auto_confirm: true,
      require_phone: false,
      waitlist_enabled: true,
      waitlist_offer_window_hours: 1,
      consent_text:
        "Please cancel at least 2 hours before class to free your spot for someone else. Late cancellations or no-shows may use one class credit.",
      widget_text: {
        noSlots: "This class is full. Check another time, or contact the studio about availability.",
      },
      templates: {
        customer_created_subject: "You're in! {{service}} on {{date}} at {{time}}",
        customer_created_body:
          "Hi {{customer_name}},\n\nYou're booked into {{service}} with {{resource}} on {{date}} at {{time}}.\n\nSee you soon — arrive a few minutes early to get set up.\n\n{{manage_url}}\n\n{{business_name}}",
        customer_cancelled_subject: "Your {{date}} class booking was cancelled",
        customer_cancelled_body:
          "Hi {{customer_name}},\n\nYour spot in {{service}} on {{date}} at {{time}} has been cancelled.\n\nGrab another class any time on our website.\n\n{{business_name}}",
      },
    },
  },
  realestate: {
    label: "Real Estate / Property Viewings",
    terms: {
      resource_single: "Agent",
      resource_plural: "Agents",
      service_single: "Viewing Type",
      service_plural: "Viewing Types",
      booking_single: "Viewing",
      booking_plural: "Viewings",
      customer_single: "Prospect",
      customer_plural: "Prospects",
    },
    defaults: {
      slot_interval: 30,
      min_notice_hours: 12,
      max_advance_days: 30,
      cancel_cutoff_hours: 24,
      auto_confirm: true,
      require_phone: true,
      waitlist_enabled: false,
      waitlist_offer_window_hours: 24,
      consent_text:
        "Please let us know as soon as possible if you can no longer make a scheduled viewing, so we can offer the time to another interested buyer.",
      widget_text: {
        noSlots: "No viewing times left for this listing today.",
      },
      templates: {
        customer_created_subject: "Viewing confirmed — {{date}} at {{time}}",
        customer_created_body:
          "Hi {{customer_name}},\n\nYour viewing with {{resource}} is confirmed for {{date}} at {{time}}.\n\n{{meeting_line}}\n\nNeed to reschedule? Use this link:\n{{manage_url}}\n\nSee you there,\n{{business_name}}",
        customer_cancelled_subject: "Your viewing on {{date}} has been cancelled",
        customer_cancelled_body:
          "Hi {{customer_name}},\n\nYour viewing on {{date}} at {{time}} has been cancelled.\n\nYou're welcome to book another viewing time on our website.\n\n{{business_name}}",
      },
    },
  },
  restaurant: {
    label: "Restaurant / Table Reservations",
    terms: {
      resource_single: "Table",
      resource_plural: "Tables",
      service_single: "Reservation Type",
      service_plural: "Reservation Types",
      booking_single: "Reservation",
      booking_plural: "Reservations",
      customer_single: "Guest",
      customer_plural: "Guests",
    },
    defaults: {
      slot_interval: 30,
      min_notice_hours: 1,
      max_advance_days: 30,
      cancel_cutoff_hours: 2,
      auto_confirm: true,
      require_phone: true,
      waitlist_enabled: true,
      waitlist_offer_window_hours: 0.5,
      consent_text:
        "We kindly ask for at least 2 hours' notice if you need to cancel your reservation, so we can offer the table to other guests.",
      widget_text: {
        noSlots: "We're fully booked at this time — please try another sitting, or call us directly.",
      },
      templates: {
        customer_created_subject: "You're booked! {{date}} at {{time}}",
        customer_created_body:
          "Hi {{customer_name}},\n\nYou're all set — we'll have your table ready on {{date}} at {{time}}.\n\nWe hold tables for a short while past the reservation time, so please let us know if you're running late.\n\n{{manage_url}}\n\nSee you soon,\n{{business_name}}",
        customer_cancelled_subject: "Your reservation on {{date}} was cancelled",
        customer_cancelled_body:
          "Hi {{customer_name}},\n\nYour table for {{date}} at {{time}} has been cancelled.\n\nWe'd love to have you another time — book any time on our website.\n\n{{business_name}}",
      },
    },
  },
  homeservice: {
    label: "Home Services / Trades",
    terms: {
      resource_single: "Engineer",
      resource_plural: "Engineers",
      service_single: "Service",
      service_plural: "Services",
      booking_single: "Job",
      booking_plural: "Jobs",
      customer_single: "Customer",
      customer_plural: "Customers",
    },
    defaults: {
      slot_interval: 60,
      min_notice_hours: 24,
      max_advance_days: 45,
      cancel_cutoff_hours: 24,
      auto_confirm: false,
      require_phone: true,
      waitlist_enabled: true,
      waitlist_offer_window_hours: 4,
      consent_text:
        "Please give us at least 24 hours' notice to cancel or move a booked visit. Late cancellations may incur a callout fee, as a technician is scheduled specifically for your job.",
      widget_text: {
        noSlots: "No further callout slots today. For urgent jobs, please call us directly.",
      },
      templates: {
        customer_created_pending_subject: "Callout request received — {{date}} at {{time}}",
        customer_created_pending_body:
          "Hi {{customer_name}},\n\nThanks — we've received your request for {{service}} on {{date}} at {{time}}.\n\nWe'll confirm your engineer shortly. If it's urgent, please call us directly.\n\n{{manage_url}}\n\n{{business_name}}",
        customer_cancelled_subject: "Your job on {{date}} has been cancelled",
        customer_cancelled_body:
          "Hi {{customer_name}},\n\nYour {{service}} booking on {{date}} at {{time}} has been cancelled.\n\nNeed to rebook? You can do that any time on our website.\n\n{{business_name}}",
      },
    },
  },
};

export function getPreset(key: string): Preset {
  return PRESETS[key] ?? PRESETS.generic;
}

export function presetChoices(): Array<{ value: string; label: string }> {
  return Object.entries(PRESETS).map(([value, preset]) => ({ value, label: preset.label }));
}

/**
 * The Settings keys a preset's `defaults` is allowed to seed. Used by
 * setSettings()/applyPreset() (see settings.ts) to track which of these a
 * merchant has hand-edited, so re-applying or switching a preset never
 * silently discards a customization — and by Settings UI in both apps to
 * render a "Preset default" vs "Customized" indicator next to each field.
 */
export const PRESET_CONTROLLED_KEYS = [
  "slot_interval",
  "min_notice_hours",
  "max_advance_days",
  "cancel_cutoff_hours",
  "auto_confirm",
  "require_phone",
  "waitlist_enabled",
  "waitlist_offer_window_hours",
  "consent_text",
  "widget_text",
  "templates",
] as const;

export type PresetControlledKey = (typeof PRESET_CONTROLLED_KEYS)[number];
