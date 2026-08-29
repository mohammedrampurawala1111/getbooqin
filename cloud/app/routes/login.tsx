import { useState, type FormEvent } from "react";
import { redirect, useNavigate } from "react-router";
import { useSignIn } from "@clerk/react-router/legacy";
import { isClerkAPIResponseError } from "@clerk/react-router/errors";
import type { Route } from "./+types/login";
import { getUserSession } from "~/session.server";
import { Field, Input, GoogleIcon } from "~/components/ui";

export async function loader({ request }: Route.LoaderArgs) {
  const session = await getUserSession(request);
  if (session) throw redirect("/dashboard");
  return null;
}

export default function Login() {
  const { isLoaded, signIn, setActive } = useSignIn();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleGoogle() {
    if (!isLoaded || submitting) return;
    setError(null);
    try {
      // Full-page redirect to Google — the browser leaves this page, so
      // there's no session/navigate call here; sso-callback.tsx handles
      // completion when Google redirects back.
      await signIn.authenticateWithRedirect({
        strategy: "oauth_google",
        redirectUrl: "/sso-callback",
        redirectUrlComplete: "/dashboard",
      });
    } catch (err) {
      const message = isClerkAPIResponseError(err) ? err.errors[0]?.longMessage ?? err.errors[0]?.message : undefined;
      setError(message ?? "Couldn't start Google sign-in — try again.");
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isLoaded || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await signIn.create({ strategy: "password", identifier: email, password });
      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        navigate("/dashboard");
      } else {
        setError("Couldn't log in — check your email and password.");
      }
    } catch (err) {
      const message = isClerkAPIResponseError(err) ? err.errors[0]?.longMessage ?? err.errors[0]?.message : undefined;
      setError(message ?? "Incorrect email or password.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-screen grid-cols-2">
      <div className="flex items-center justify-center bg-canvas px-8">
        <div className="card w-full max-w-[372px] p-[26px]">
          <span className="flex h-[30px] w-[30px] shrink-0 flex-col justify-center gap-[3px] rounded-[8px] bg-brand-950 p-[6px]">
            <span className="h-[6px] rounded-[2px] bg-brand-500" />
            <span className="h-[6px] rounded-[2px] border-[1.5px] border-brand-500" />
          </span>
          <h1 className="page-title mt-4">Log in</h1>
          {error && <div className="alert-error mt-3">{error}</div>}
          <button type="button" onClick={handleGoogle} className="btn-sec mt-5 justify-center gap-2">
            <GoogleIcon />
            Continue with Google
          </button>
          <div className="my-4 flex items-center gap-3 text-meta text-muted">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
          <form onSubmit={handleSubmit} className="flex flex-col gap-[14px]">
            <Field label="Email">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </Field>
            <Field label="Password">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <button type="submit" className="btn-pri mt-1 justify-center" disabled={submitting}>
              Log in
            </button>
          </form>
          <p className="mt-4 text-body text-muted">
            Need an account? <a href="/signup">Sign up</a>
          </p>
        </div>
      </div>
      <div className="side-dark flex flex-col items-center justify-center gap-3 px-12 text-center">
        <span className="flex h-[44px] w-[44px] shrink-0 flex-col justify-center gap-[4px] rounded-[10px] bg-brand-950 p-[8px]">
          <span className="h-[7px] rounded-[2px] bg-brand-500" />
          <span className="h-[7px] rounded-[2px] border-[1.5px] border-brand-500" />
        </span>
        <h2 className="m-0 text-[20px] font-semibold">GetBooqin Cloud</h2>
        <p className="m-0 max-w-[320px] text-[13.5px] text-[#a49caf]">
          Manage bookings, staff schedules, and services for every store you connect — all from one dashboard.
        </p>
      </div>
    </div>
  );
}
