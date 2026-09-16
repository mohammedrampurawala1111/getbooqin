import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import {
  WHATSAPP_TEMPLATES,
  metaName,
  previewBody,
  type WhatsAppTemplateKey,
} from "getbooqin-core/whatsapp/templates";
import { UpgradePrompt } from "~/components/upgrade";
import type { PlanId } from "getbooqin-core/billing/plans";

/**
 * Connecting WhatsApp, and seeing whether it can actually send.
 *
 * ## Why Facebook's script is on this page
 *
 * Meta's Embedded Signup cannot run in our own iframe or a window we
 * open ourselves — it has to be `FB.login()` from Facebook's own SDK.
 * That is also the only way the merchant can attach **their own**
 * payment method to **their own** WhatsApp Business Account inside the
 * flow, which is the arrangement that makes this feature free for us to
 * run and is therefore not a detail worth engineering around.
 *
 * The script is loaded lazily, on click, rather than on every dashboard
 * page view. Nobody connects WhatsApp twice, and a third-party script
 * on every render for a one-time action is a tax on everyone else.
 *
 * ## Two channels back, and you need both
 *
 * The SDK callback gives a `code`. A `postMessage` from
 * `facebook.com` gives the `waba_id` and `phone_number_id`. Neither
 * carries the other, and the listener has to be attached *before*
 * `FB.login` opens the popup. Miss it and you hold a single-use code
 * with nothing to spend it on — which is why the ref below is set up
 * first and the login call comes after.
 */

export interface WhatsAppAccountView {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string;
  status: "pending" | "active" | "revoked" | "error";
  qualityRating: string | null;
  lastError: string | null;
}

export interface TemplateView {
  key: string;
  name: string;
  status: string;
  rejectedReason: string | null;
}

declare global {
  interface Window {
    FB?: {
      init(options: Record<string, unknown>): void;
      login(callback: (response: { authResponse?: { code?: string } }) => void, options: Record<string, unknown>): void;
    };
    fbAsyncInit?: () => void;
  }
}

const SDK_ID = "facebook-jssdk";

function loadSdk(appId: string): Promise<void> {
  if (window.FB) return Promise.resolve();

  return new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB?.init({ appId, cookie: true, xfbml: false, version: "v21.0" });
      resolve();
    };

    if (document.getElementById(SDK_ID)) return;
    const script = document.createElement("script");
    script.id = SDK_ID;
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => reject(new Error("Couldn't load Meta's sign-in. Check your connection and try again."));
    document.body.appendChild(script);
  });
}

export function WhatsAppCard({
  connectionId,
  plan,
  entitled,
  account,
  templates,
  appId,
  configId,
}: {
  connectionId: string;
  plan: PlanId;
  entitled: boolean;
  account: WhatsAppAccountView | null;
  templates: TemplateView[];
  appId: string;
  configId: string;
}) {
  const fetcher = useFetcher<{ error?: string }>();
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // Written by the postMessage listener, read by the SDK callback. A
  // ref rather than state on purpose: the callback closes over its
  // render, and a state update would not be visible to it in time.
  const signupIds = useRef<{ wabaId?: string; phoneNumberId?: string }>({});

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Meta posts from facebook.com. Anything else on the page is not
      // this conversation.
      if (!/^https:\/\/(www\.)?facebook\.com$/.test(event.origin)) return;
      try {
        const payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (payload?.type !== "WA_EMBEDDED_SIGNUP") return;
        if (payload?.data?.waba_id) signupIds.current.wabaId = payload.data.waba_id;
        if (payload?.data?.phone_number_id) signupIds.current.phoneNumberId = payload.data.phone_number_id;
      } catch {
        // Facebook posts non-JSON strings on this channel too.
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function connect() {
    setLocalError(null);
    setBusy(true);
    try {
      await loadSdk(appId);
      window.FB?.login(
        (response) => {
          setBusy(false);
          const code = response?.authResponse?.code;
          const { wabaId, phoneNumberId } = signupIds.current;

          if (!code) {
            // The overwhelmingly common case is that they closed the
            // popup, which is not an error worth shouting about.
            setLocalError("WhatsApp wasn't connected. You can try again any time.");
            return;
          }
          if (!wabaId || !phoneNumberId) {
            setLocalError("Meta didn't tell us which number you picked. Please try again.");
            return;
          }

          fetcher.submit(
            { _intent: "connect", code, waba_id: wabaId, phone_number_id: phoneNumberId },
            { method: "post", action: `/dashboard/${connectionId}/whatsapp` }
          );
        },
        {
          config_id: configId,
          response_type: "code",
          // Without this the SDK returns an access token to the browser
          // instead of a code. A token in a browser is a token in a
          // browser's history, and the exchange belongs on the server.
          override_default_response_type: true,
          extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
        }
      );
    } catch (error) {
      setBusy(false);
      setLocalError(error instanceof Error ? error.message : "Couldn't open Meta's sign-in.");
    }
  }

  if (!entitled) {
    return (
      <div className="card p-[18px]">
        <h2 className="card-title mb-1">WhatsApp</h2>
        <p className="m-0 mb-3 text-meta text-muted">
          Send confirmations and reminders on WhatsApp, from your own business number.
        </p>
        <UpgradePrompt feature="whatsapp" currentPlan={plan} connectionId={connectionId} compact />
      </div>
    );
  }

  const configured = !!appId && !!configId;
  const error = localError || fetcher.data?.error;

  return (
    <div className="card p-[18px]">
      <div className="mb-1 flex items-start justify-between gap-3">
        <h2 className="card-title m-0">WhatsApp</h2>
        {account?.status === "active" && <span className="badge-ok">Connected</span>}
      </div>

      {!account && (
        <>
          <p className="m-0 mb-3 text-meta text-muted">
            Connect your own WhatsApp Business account. Meta bills you directly for messages — usually a few paise
            each — and you keep the number whatever happens here.
          </p>
          {!configured ? (
            <p className="m-0 rounded-[8px] bg-canvas-alt px-3 py-2 text-[12.5px] text-muted">
              WhatsApp isn't switched on for this deployment yet.
            </p>
          ) : (
            <button type="button" className="btn" onClick={connect} disabled={busy || fetcher.state !== "idle"}>
              {busy || fetcher.state !== "idle" ? "Connecting…" : "Connect WhatsApp"}
            </button>
          )}
        </>
      )}

      {account && (
        <>
          <dl className="m-0 mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
            <dt className="text-muted">Number</dt>
            <dd className="m-0">{account.displayPhoneNumber || "—"}</dd>
            <dt className="text-muted">Business name</dt>
            <dd className="m-0">{account.verifiedName || "—"}</dd>
            {account.qualityRating && (
              <>
                <dt className="text-muted">Quality</dt>
                {/* Meta's own verdict. A number that reaches RED stops
                    being able to send, so it is worth seeing before
                    that rather than after. */}
                <dd className="m-0">{account.qualityRating}</dd>
              </>
            )}
          </dl>

          {account.status === "pending" && (
            <p className="m-0 mb-3 rounded-[8px] bg-warn-bg px-3 py-2 text-[12.5px] text-warn">
              Setup didn't finish. Your account is saved — finishing is safe to retry.
            </p>
          )}
          {account.status === "revoked" && (
            <p className="m-0 mb-3 rounded-[8px] bg-danger-bg px-3 py-2 text-[12.5px] text-danger">
              Meta revoked our access to this account. Reconnect to start sending again.
            </p>
          )}
          {account.lastError && account.status !== "revoked" && (
            <p className="m-0 mb-3 rounded-[8px] bg-warn-bg px-3 py-2 text-[12.5px] text-warn">{account.lastError}</p>
          )}

          <TemplateList templates={templates} />

          <div className="mt-3 flex flex-wrap gap-2">
            {account.status !== "active" && (
              <fetcher.Form method="post" action={`/dashboard/${connectionId}/whatsapp`}>
                <input type="hidden" name="_intent" value={account.status === "revoked" ? "connect" : "finish"} />
                {account.status === "revoked" ? (
                  <button type="button" className="btn" onClick={connect}>Reconnect</button>
                ) : (
                  <button type="submit" className="btn">Finish setup</button>
                )}
              </fetcher.Form>
            )}
            <fetcher.Form method="post" action={`/dashboard/${connectionId}/whatsapp`}>
              <input type="hidden" name="_intent" value="refresh" />
              <button type="submit" className="btn-sec">Refresh status</button>
            </fetcher.Form>
            <fetcher.Form method="post" action={`/dashboard/${connectionId}/whatsapp`}>
              <input type="hidden" name="_intent" value="disconnect" />
              <button type="submit" className="btn-sec">Disconnect</button>
            </fetcher.Form>
          </div>
        </>
      )}

      {error && (
        <p className="m-0 mt-3 rounded-[8px] bg-danger-bg px-3 py-2 text-[12.5px] text-danger">{error}</p>
      )}
    </div>
  );
}

/**
 * What Meta has and hasn't approved.
 *
 * A freshly connected merchant sits here for minutes to days with
 * everything PENDING, and that is an ordinary state rather than a
 * fault — approval is per WhatsApp Business Account, so our templates
 * get reviewed again for every merchant who connects. Saying so
 * plainly is the difference between "it's working on it" and "it's
 * broken".
 */
function TemplateList({ templates }: { templates: TemplateView[] }) {
  const byKey = new Map(templates.map((t) => [t.key, t]));

  return (
    <div>
      <h3 className="m-0 mb-1 text-[12.5px] font-medium">Messages</h3>
      <p className="m-0 mb-2 text-[11.5px] text-muted">
        WhatsApp reviews every message type before it can be sent. This usually takes a few minutes.
      </p>
      <ul className="m-0 flex list-none flex-col gap-[6px] p-0">
        {WHATSAPP_TEMPLATES.map((def) => {
          const state = byKey.get(def.key);
          const status = state?.status ?? "NOT_SUBMITTED";
          return (
            <li key={def.key} className="flex items-start justify-between gap-3 text-[12.5px]">
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{def.label}</span>
                <span className="text-muted">{def.description}</span>
                {state?.rejectedReason && (
                  <span className="text-danger">Meta said: {state.rejectedReason}</span>
                )}
              </span>
              <span className={`shrink-0 ${statusTone(status)}`}>{statusLabel(status)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "APPROVED": return "Ready";
    case "PENDING": return "In review";
    case "REJECTED": return "Rejected";
    case "PAUSED": return "Paused";
    case "DISABLED": return "Disabled";
    default: return "Not submitted";
  }
}

function statusTone(status: string): string {
  if (status === "APPROVED") return "text-ok";
  if (status === "REJECTED" || status === "DISABLED") return "text-danger";
  if (status === "PAUSED") return "text-warn";
  return "text-muted";
}

export { previewBody, metaName };
export type { WhatsAppTemplateKey };
