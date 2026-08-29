/**
 * Industry presets. Ported verbatim from shopify-openslot's app/lib/presets.ts
 * (itself ported from the WordPress plugin's includes/Presets.php).
 *
 * The data model is deliberately generic: a Resource (person, room, bay,
 * table, machine) delivers a Service to a Customer inside a Booking. A preset
 * only changes the words shown in the UI and a few sensible defaults — it
 * never changes the schema. That is what keeps the app industry-neutral.
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
      resource_single: "Staff Member",
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
      resource_single: "Doctor",
      resource_plural: "Doctors",
      service_single: "Treatment",
      service_plural: "Treatments",
      booking_single: "Appointment",
      booking_plural: "Appointments",
      customer_single: "Patient",
      customer_plural: "Patients",
    },
    defaults: { slot_interval: 15 },
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
    defaults: { slot_interval: 15 },
  },
  automotive: {
    label: "Automotive / Repair Shop",
    terms: {
      resource_single: "Service Bay",
      resource_plural: "Service Bays",
      service_single: "Job",
      service_plural: "Jobs",
      booking_single: "Job Booking",
      booking_plural: "Job Bookings",
      customer_single: "Customer",
      customer_plural: "Customers",
    },
    defaults: { slot_interval: 60 },
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
    defaults: { slot_interval: 30 },
  },
  education: {
    label: "Education / Tutoring",
    terms: {
      resource_single: "Tutor",
      resource_plural: "Tutors",
      service_single: "Class",
      service_plural: "Classes",
      booking_single: "Session",
      booking_plural: "Sessions",
      customer_single: "Student",
      customer_plural: "Students",
    },
    defaults: { slot_interval: 30 },
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
    defaults: { slot_interval: 30 },
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
    defaults: { slot_interval: 30 },
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
    defaults: { slot_interval: 30 },
  },
  homeservice: {
    label: "Home Services / Trades",
    terms: {
      resource_single: "Technician",
      resource_plural: "Technicians",
      service_single: "Service",
      service_plural: "Services",
      booking_single: "Job",
      booking_plural: "Jobs",
      customer_single: "Customer",
      customer_plural: "Customers",
    },
    defaults: { slot_interval: 60 },
  },
};

export function getPreset(key: string): Preset {
  return PRESETS[key] ?? PRESETS.generic;
}

export function presetChoices(): Array<{ value: string; label: string }> {
  return Object.entries(PRESETS).map(([value, preset]) => ({ value, label: preset.label }));
}
