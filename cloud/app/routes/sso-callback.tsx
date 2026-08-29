import { AuthenticateWithRedirectCallback } from "@clerk/react-router";

// Landing point Google redirects back to after the OAuth handshake — see
// authenticateWithRedirect() calls in login.tsx/signup.tsx. This component
// finishes the flow (exchanges the OAuth code, activates the session) and
// navigates on itself; there's nothing else to render.
export default function SSOCallback() {
  return (
    <AuthenticateWithRedirectCallback
      signInUrl="/login"
      signUpUrl="/signup"
      signInFallbackRedirectUrl="/dashboard"
      signUpFallbackRedirectUrl="/onboarding?step=1"
    />
  );
}
