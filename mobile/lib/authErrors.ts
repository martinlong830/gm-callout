import { translate, type Locale } from './i18n';

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
  context: 'session' | 'confirm' | 'signin' = 'session',
  locale: Locale = 'en'
): string {
  const msg = String(raw || '').trim();
  if (!isInvalidAuthTokenError(msg) && !/^invalid token$/i.test(msg)) {
    return msg || translate(locale, 'auth.requestFailed');
  }
  if (context === 'confirm') return translate(locale, 'auth.invalidConfirmLink');
  if (context === 'signin') return translate(locale, 'auth.invalidSignInToken');
  return translate(locale, 'auth.sessionExpired');
}
