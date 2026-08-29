import { useState } from "react";
import { useFetcher } from "react-router";
import { Badge, Button, Popover, ActionList } from "@shopify/polaris";
import { TRANSITIONS, statusLabels, type BookingStatus } from "getbooqin-core/booking/bookingsShared";

const STATUS_TONE: Record<string, "success" | "attention" | "critical" | "info" | "new"> = {
  confirmed: "success",
  pending: "attention",
  declined: "critical",
  cancelled: "critical",
  completed: "info",
  no_show: "critical",
};

export { STATUS_TONE };

export function BookingStatusMenu({
  bookingId,
  current,
  onRequestDecline,
}: {
  bookingId: number;
  current: string;
  onRequestDecline: (bookingId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  // A fetcher submission revalidates this route's loader data in place
  // without a full navigation-style transition — useSubmit() here would
  // reintroduce the same "bare 200 instead of re-render" failure mode that
  // app.bookings_.$id.tsx (one of this component's two callers) was just
  // switched away from useSubmit() to fix.
  const fetcher = useFetcher();
  const options = TRANSITIONS[current as BookingStatus] ?? [];

  if (options.length === 0) return <Badge tone={STATUS_TONE[current]}>{statusLabels()[current as BookingStatus] ?? current}</Badge>;

  return (
    <Popover
      active={open}
      onClose={() => setOpen(false)}
      activator={
        <Button size="slim" onClick={() => setOpen(true)} disclosure>
          {statusLabels()[current as BookingStatus] ?? current}
        </Button>
      }
    >
      <ActionList
        items={options.map((next) => ({
          content: `Mark ${statusLabels()[next]}`,
          onAction: () => {
            setOpen(false);
            if (next === "declined") {
              onRequestDecline(bookingId);
              return;
            }
            const form = new FormData();
            form.set("id", String(bookingId));
            form.set("status", next);
            fetcher.submit(form, { method: "post" });
          },
        }))}
      />
    </Popover>
  );
}
