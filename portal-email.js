/* eslint-disable no-console */
/**
 * Transactional email (password reset). Uses Resend HTTP API when RESEND_API_KEY is set.
 */

function stripEnv(value) {
  if (value == null || value === "") return "";
  let s = String(value).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

async function sendPasswordResetEmail({ to, resetUrl, loginName }) {
  const apiKey = stripEnv(process.env.RESEND_API_KEY);
  const from =
    stripEnv(process.env.PASSWORD_RESET_FROM_EMAIL) ||
    "Shiflow <onboarding@resend.dev>";
  const recipient = String(to || "").trim();
  if (!isValidEmail(recipient)) {
    return { ok: false, error: "Invalid recipient email." };
  }
  if (!resetUrl) {
    return { ok: false, error: "Missing reset link." };
  }

  const subject = "Reset your Shiflow password";
  const greeting = loginName ? `Hi ${loginName},` : "Hi,";
  const text =
    `${greeting}\n\n` +
    "We received a request to reset your password. Open this link to choose a new password:\n\n" +
    `${resetUrl}\n\n` +
    "This link expires in 1 hour. If you did not request a reset, you can ignore this email.\n\n" +
    "— Shiflow";

  const html =
    `<p>${greeting}</p>` +
    `<p>We received a request to reset your password. Click the button below to choose a new password.</p>` +
    `<p><a href="${resetUrl}" style="display:inline-block;padding:10px 16px;background:#1e3a5f;color:#fff;text-decoration:none;border-radius:6px;">Reset password</a></p>` +
    `<p style="font-size:13px;color:#475569;">Or copy this link:<br><a href="${resetUrl}">${resetUrl}</a></p>` +
    `<p style="font-size:13px;color:#475569;">This link expires in 1 hour. If you did not request a reset, you can ignore this email.</p>`;

  if (!apiKey) {
    const isProd = stripEnv(process.env.NODE_ENV) === "production";
    if (!isProd) {
      console.log("[password-reset] RESEND_API_KEY not set — reset link for", recipient);
      console.log(resetUrl);
      return { ok: true, dev: true };
    }
    return {
      ok: false,
      error:
        "Password reset email is not configured. Set RESEND_API_KEY and PASSWORD_RESET_FROM_EMAIL on the server.",
    };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [recipient],
      subject,
      html,
      text,
    }),
  });

  let body = {};
  try {
    body = await res.json();
  } catch (_e) {
    body = {};
  }

  if (!res.ok) {
    const msg =
      (body && body.message) ||
      (body && body.error) ||
      `Email provider returned ${res.status}.`;
    console.warn("[password-reset] send failed", msg);
    return { ok: false, error: "Could not send reset email. Try again later." };
  }

  return { ok: true };
}

async function sendCompanyConfirmationEmail({ to, companyName, confirmUrl, loginName }) {
  const apiKey = stripEnv(process.env.RESEND_API_KEY);
  const from =
    stripEnv(process.env.PASSWORD_RESET_FROM_EMAIL) ||
    "Shiflow <onboarding@resend.dev>";
  const recipient = String(to || "").trim();
  if (!isValidEmail(recipient)) {
    return { ok: false, error: "Invalid recipient email." };
  }
  if (!confirmUrl) {
    return { ok: false, error: "Missing confirmation link." };
  }

  const subject = `Confirm your Shiflow company — ${companyName || "New company"}`;
  const greeting = loginName ? `Hi ${loginName},` : "Hi,";
  const text =
    `${greeting}\n\n` +
    `You started creating "${companyName || "your company"}" on Shiflow. ` +
    "Confirm your email to continue. After confirming, you will choose your company access code, then sign in with the normal login flow:\n\n" +
    `${confirmUrl}\n\n` +
    "If you did not request this, you can ignore this email.\n\n" +
    "— Shiflow";

  const html =
    `<p>${greeting}</p>` +
    `<p>You started creating <strong>${companyName || "your company"}</strong> on Shiflow. ` +
    "Confirm your email to continue. After confirming, you will choose your company access code, then sign in normally.</p>" +
    `<p><a href="${confirmUrl}" style="display:inline-block;padding:10px 16px;background:#1e3a5f;color:#fff;text-decoration:none;border-radius:6px;">Confirm and set access code</a></p>` +
    `<p style="font-size:13px;color:#475569;">Or copy this link:<br><a href="${confirmUrl}">${confirmUrl}</a></p>` +
    `<p style="font-size:13px;color:#475569;">If you did not request this, you can ignore this email.</p>`;

  if (!apiKey) {
    const isProd = stripEnv(process.env.NODE_ENV) === "production";
    if (!isProd) {
      console.log("[company-confirm] RESEND_API_KEY not set — confirm link for", recipient);
      console.log(confirmUrl);
      return { ok: true, dev: true };
    }
    return {
      ok: false,
      error:
        "Company confirmation email is not configured. Set RESEND_API_KEY and PASSWORD_RESET_FROM_EMAIL on the server.",
    };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [recipient],
      subject,
      html,
      text,
    }),
  });

  let body = {};
  try {
    body = await res.json();
  } catch (_e) {
    body = {};
  }

  if (!res.ok) {
    const msg =
      (body && body.message) ||
      (body && body.error) ||
      `Email provider returned ${res.status}.`;
    console.warn("[company-confirm] send failed", msg);
    return { ok: false, error: "Could not send confirmation email. Try again later." };
  }

  return { ok: true };
}

module.exports = {
  sendPasswordResetEmail,
  sendCompanyConfirmationEmail,
  isValidEmail,
};
