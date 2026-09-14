import type { Route } from "./+types/dashboard.$connectionId.invoices.$invoiceId[.pdf]";
import { Invoices, InvoicePdf } from "getbooqin-core";
import { requireTenant } from "~/tenant.server";

/**
 * Downloading an invoice.
 *
 * Rendered on demand from the stored row rather than saved as a file at
 * issue time: the row is the record, and every field on it is frozen,
 * so re-rendering produces the same document forever without a blob
 * store to keep in sync with the database.
 *
 * Scoped to the tenant twice over — `requireTenant` proves this user
 * may see this business, and `getInvoice` filters by connection id, so
 * an invoice id guessed from another account resolves to nothing rather
 * than to somebody else's tax document.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const { connection } = await requireTenant(request, params.connectionId!);

  const invoice = await Invoices.getInvoice(connection.id, params.invoiceId!);
  if (!invoice) throw new Response("Not found", { status: 404 });

  const pdf = await InvoicePdf.renderInvoicePdf(invoice);

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      // attachment, so a click saves the file an accountant asked for
      // rather than opening a viewer inside the dashboard.
      "Content-Disposition": `attachment; filename="${Invoices.invoiceFilename(invoice)}"`,
      // A tax document, tied to a session. Never in a shared cache.
      "Cache-Control": "private, no-store",
    },
  });
}
