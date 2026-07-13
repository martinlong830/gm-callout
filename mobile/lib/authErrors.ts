/** Detect Supabase Auth / GoTrue token failures (JWT, refresh, email OTP). */
export function isInvalidAuthTokenError(raw: string | null | undefined): boolean {
  const msg = String(raw || '');
  return /invalid\s*(jwt|token|refresh)|refresh.?token.*(not found|expired|already used)|jwt\s*expired|token has expired|email link is invalid|otp_expired|bad_jwt|jwsinvalid|unable to parse or verify|^invalid token$/i.test(
    msg
  );
}

/** User-facing copy when a stored or email-confirm token cannot be used. */
export function friendlyAuthTokenMessage(
  raw: string | null | undefined,
  context: 'session' | 'confirm' | 'signin' = 'session'
): string {
  const msg = String(raw || '').trim();
  if (!isInvalidAuthTokenError(msg) && !/^invalid token$/i.test(msg)) {
    return msg || 'Request failed.';
  }
  if (context === 'confirm') {
    return (
      'This email confirmation link is invalid or was already used. ' +
      'Open a fresh confirmation email in Safari or Chrome (not Expo Go), ' +
      'or create the company again to get a new link.'
    );
  }
  if (context === 'signin') {
    return (
      'Could not start a sign-in session (invalid or expired token). ' +
      'Sign out if you are still signed in, then try again with your name and password.'
    );
  }
  return (
    'Your saved sign-in expired or is no longer valid. Sign in again with your name and password.'
  );
}
