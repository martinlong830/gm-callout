/* eslint-disable no-console */
const crypto = require("crypto");
const dns = require("dns");
const http = require("http");
const https = require("https");
const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const twilio = require("twilio");

dotenv.config();

if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}

const app = express();

function stripEnv(value) {
  if (value == null || value === "") return "";
  let s = String(value).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.trim();
}

const TWILIO_ACCOUNT_SID = stripEnv(process.env.TWILIO_ACCOUNT_SID);
const TWILIO_AUTH_TOKEN = stripEnv(process.env.TWILIO_AUTH_TOKEN);
const TWILIO_FROM_NUMBER = stripEnv(process.env.TWILIO_FROM_NUMBER);
const TWILIO_API_KEY_SID = stripEnv(process.env.TWILIO_API_KEY_SID);
const TWILIO_API_KEY_SECRET = stripEnv(process.env.TWILIO_API_KEY_SECRET);
const PUBLIC_BASE_URL = stripEnv(process.env.PUBLIC_BASE_URL);
const PORT = stripEnv(process.env.PORT) || "8000";
/** Render and most PaaS require listening on all interfaces, not only localhost. */
const LISTEN_HOST = stripEnv(process.env.LISTEN_HOST) || "0.0.0.0";
/** Set to 1 to force one-way <Say> TwiML (no Twilio fetch to PUBLIC_BASE_URL). Use to verify trial/from/to when ngrok/TwiML fetch fails. */
const VOICE_INLINE_ONLY =
  stripEnv(process.env.VOICE_INLINE_ONLY) === "1" ||
  stripEnv(process.env.VOICE_USE_INLINE_TWIML) === "1";
/** Skip HTTPS preflight before placing interactive calls (Twilio may still return 11200 if URL is wrong). */
const SKIP_PUBLIC_URL_PREFLIGHT = stripEnv(process.env.SKIP_PUBLIC_URL_PREFLIGHT) === "1";

/** Free ngrok returns an HTML interstitial unless this header or query param is present — breaks preflight + Twilio GETs. */
const NGROK_SKIP_HEADER = "ngrok-skip-browser-warning";
const NGROK_SKIP_VALUE = "1";

function voiceCallTwilioHint(code) {
  const c = Number(code);
  if (c === 21211) {
    return "Invalid “to” number — use E.164 (e.g. +16095551234).";
  }
  if (c === 21212) {
    return "Invalid “from” — TWILIO_FROM_NUMBER must be a voice-capable Twilio number on this account.";
  }
  if (c === 21608) {
    return "Trial account: add the destination under Twilio → Phone Numbers → Verified Caller IDs, or upgrade.";
  }
  if (c === 21606 || c === 21408) {
    return "Voice routing/geo permission — check Twilio Console → Voice / account permissions for this country.";
  }
  if (c === 20003) {
    return "Auth failed — verify TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN (or API key + account SID).";
  }
  if (c === 20404) {
    return "Not found — Account SID may not own this “from” number.";
  }
  return "";
}

function appendNgrokBypassToPublicUrl(absoluteUrl) {
  try {
    const u = new URL(absoluteUrl);
    if (!/ngrok/i.test(u.hostname)) return absoluteUrl;
    if (!u.searchParams.has(NGROK_SKIP_HEADER)) {
      u.searchParams.set(NGROK_SKIP_HEADER, NGROK_SKIP_VALUE);
    }
    return u.toString();
  } catch {
    return absoluteUrl;
  }
}

// Allow gm-callout opened from another port (e.g. python http.server :8000) to call this API.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(__dirname));

function createTwilioClient() {
  if (!TWILIO_ACCOUNT_SID) {
    throw new Error("Missing TWILIO_ACCOUNT_SID");
  }
  // Prefer Account SID + Auth Token — API Key (SK…) auth often returns 403 if keys are wrong or restricted.
  if (TWILIO_AUTH_TOKEN) {
    return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  }
  if (TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET) {
    return twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, {
      accountSid: TWILIO_ACCOUNT_SID,
    });
  }
  throw new Error("Missing TWILIO_AUTH_TOKEN or API key credentials");
}

/** Lazy so the process can boot (e.g. Render health checks) before env is configured. */
let twilioRestClient = null;
function getTwilioClient() {
  if (twilioRestClient) return twilioRestClient;
  twilioRestClient = createTwilioClient();
  return twilioRestClient;
}

function isTwilioEnvConfigError(err) {
  const m = err && err.message;
  return typeof m === "string" && /^Missing TWILIO/i.test(m);
}

const TWILIO_ENV_HINT =
  "Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER in your host’s environment (Render → Environment), save, then redeploy or restart.";

/** In-memory state for interactive voice (yes/no + confirm). Requires PUBLIC_BASE_URL. */
const voiceFlowSessions = new Map();
const VOICE_FLOW_TTL_MS = 3 * 60 * 60 * 1000;

/** CallSid → outcome for UI polling after caller says yes + confirm. */
const voiceCallOutcomes = new Map();
const VOICE_OUTCOME_TTL_MS = 48 * 60 * 60 * 1000;

function normalizeVoiceCallback(body) {
  const raw = body && body.callback;
  if (!raw || typeof raw !== "object") return null;
  const shift = raw.shift && typeof raw.shift === "object" ? raw.shift : null;
  if (!shift || !String(shift.id || "").trim()) return null;
  return {
    workerId: String(raw.workerId || "").trim(),
    workerName: String(raw.workerName || "").trim(),
    workerRole: String(raw.workerRole || "").trim(),
    phone: String(raw.phone || "").trim(),
    shift: {
      id: String(shift.id || "").trim(),
      day: String(shift.day || "").trim(),
      role: String(shift.role || "").trim(),
      start: String(shift.start || "").trim(),
      end: String(shift.end || "").trim(),
      timeLabel: String(shift.timeLabel || "").trim(),
      groupLabel: String(shift.groupLabel || "").trim(),
    },
  };
}

function recordVoiceCallConfirmed(callSid, session) {
  const sid = String(callSid || "").trim();
  if (!sid || !session || !session.callback) return;
  const cb = session.callback;
  voiceCallOutcomes.set(sid, {
    status: "confirmed",
    workerId: cb.workerId,
    workerName: cb.workerName,
    workerRole: cb.workerRole,
    shift: cb.shift,
    recordedAt: Date.now(),
    confirmedAt: new Date().toISOString(),
  });
}

/** Absolute webhook URL, or null if PUBLIC_BASE_URL is missing (never throws — avoids 500 HTML for Twilio). */
function publicUrl(pathname) {
  const base = (PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (!base) return null;
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return appendNgrokBypassToPublicUrl(`${base}${path}`);
}

function voiceFlowServerErrorTwiML() {
  const vr = new twilio.twiml.VoiceResponse();
  vr.say("Sorry, something went wrong. Goodbye.");
  vr.hangup();
  return vr.toString();
}

function voiceFlowConfigErrorTwiML() {
  const vr = new twilio.twiml.VoiceResponse();
  vr.say("This call could not be completed. Goodbye.");
  vr.hangup();
  return vr.toString();
}

function pruneVoiceFlowSessions() {
  const now = Date.now();
  for (const [token, s] of voiceFlowSessions) {
    if (!s.createdAt || now - s.createdAt > VOICE_FLOW_TTL_MS) {
      voiceFlowSessions.delete(token);
    }
  }
  for (const [callSid, o] of voiceCallOutcomes) {
    if (!o.recordedAt || now - o.recordedAt > VOICE_OUTCOME_TTL_MS) {
      voiceCallOutcomes.delete(callSid);
    }
  }
}
setInterval(pruneVoiceFlowSessions, 15 * 60 * 1000).unref();

function soundsLikeYes(speech) {
  const t = String(speech || "")
    .toLowerCase()
    .trim();
  if (!t) return false;
  if (/\b(no|not|nope|nah|can't|cannot|unable)\b/i.test(t) && !/\byes\b|\byeah\b/i.test(t)) return false;
  if (/\byes\b|\byeah\b|\byep\b|\byup\b|\bsure\b|\bokay\b|\bok\b|\babsolutely\b|\bdefinitely\b|\bI can\b|\bI'll do\b/i.test(t)) {
    return true;
  }
  // Twilio sometimes returns short transcripts: "yep.", "uh-huh"
  if (/^(y(es|ep|eah)?|sure|ok|okay)[.!\s]*$/i.test(t)) return true;
  return false;
}

function soundsLikeNo(speech) {
  const t = String(speech || "")
    .toLowerCase()
    .trim();
  if (!t) return false;
  if (/\byes\b|\byeah\b|\bsure\b/i.test(t) && !/\bno\b/i.test(t)) return false;
  return /\bno\b|\bnope\b|\bnah\b|\bnegative\b|\bcan't\b|\bcannot\b|\bunable\b/i.test(t);
}

function soundsLikeConfirm(speech) {
  const t = String(speech || "")
    .toLowerCase()
    .trim();
  return /\bconfirm(ed|ation)?\b/i.test(t);
}

/**
 * Twilio Gather: default actionOnEmptyResult=false means on timeout with no speech, Twilio does NOT
 * POST to action — and with no next verb the call can sit silent. We always POST so reprompt/confirm runs.
 */
function gatherSpeechOpts(actionUrl, hints) {
  return {
    input: "speech",
    timeout: 10,
    speechTimeout: 3,
    action: actionUrl,
    method: "POST",
    actionOnEmptyResult: true,
    language: "en-US",
    hints:
      hints ||
      "yes, no, yeah, yep, sure, okay, nah, nope, available, confirm, confirmed",
  };
}

/**
 * Twilio error 11200 = could not GET your TwiML URL. Common cause: ngrok not running (ERR_NGROK_3200).
 * Preflight so we fail in the app with a clear message instead of a failed call.
 */
function verifyPublicBaseUrlReachable() {
  const base = (PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (!base) return Promise.resolve({ ok: false, reason: "PUBLIC_BASE_URL not set" });
  if (SKIP_PUBLIC_URL_PREFLIGHT) {
    console.warn(
      "[Voice] SKIP_PUBLIC_URL_PREFLIGHT=1 — not checking PUBLIC_BASE_URL over HTTPS (Twilio may still fail with 11200)."
    );
    return Promise.resolve({ ok: true, skipped: true });
  }
  let url;
  try {
    url = appendNgrokBypassToPublicUrl(`${base}/health`);
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    return Promise.resolve({ ok: false, reason: "Invalid PUBLIC_BASE_URL (bad URL)" });
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    const headerBlock = {
      Accept: "application/json",
      [NGROK_SKIP_HEADER]: NGROK_SKIP_VALUE,
    };
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers: headerBlock }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => {
        const jsonOk = res.statusCode >= 200 && res.statusCode < 300 && /"ok"\s*:\s*true/.test(body);
        if (jsonOk) {
          finish({ ok: true });
          return;
        }
        finish({
          ok: false,
          reason: res.statusCode ? `HTTP ${res.statusCode}` : "bad response",
          detail: body.slice(0, 280),
        });
      });
    });
    req.setTimeout(8000, () => {
      req.destroy();
      finish({ ok: false, reason: "timeout (8s)" });
    });
    req.on("error", (e) => {
      const msg = e.message || String(e);
      let extra = "";
      if (/EPROTO|packet length too long|wrong version number|SSL|TLS/i.test(msg)) {
        extra =
          " TLS failed from this machine. Try: curl -sS \"" +
          url +
          '" -H "' +
          NGROK_SKIP_HEADER +
          ": " +
          NGROK_SKIP_VALUE +
          "\"  Or set SKIP_PUBLIC_URL_PREFLIGHT=1 (then confirm Twilio Console if calls fail), or VOICE_INLINE_ONLY=1 for one-way audio.";
      }
      finish({
        ok: false,
        reason: msg,
        detail: extra || undefined,
      });
    });
  });
}

function normalizePhone(value) {
  if (!value) return "";
  const digits = String(value).replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  const justDigits = digits.replace(/[^\d]/g, "");
  if (justDigits.length === 10) return `+1${justDigits}`;
  if (justDigits.length === 11 && justDigits.startsWith("1")) return `+${justDigits}`;
  return value;
}

function escapeXmlText(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Twilio <Say> often skips or mumbles "-" / "–" / "—" in time ranges.
 * Rewrite dashes so TTS clearly says "to" (e.g. "11:00 AM to 3:00 PM").
 */
function normalizeVoiceScriptForTts(s) {
  let t = String(s || "").trim();
  if (!t) return t;
  // "11:00 AM-3:00" / "11:00 AM–3:00" / "11:00 AM — 3:00" → "... AM to 3:00"
  t = t.replace(/([AP]M)\s*[-\u2013\u2014]\s*/gi, "$1 to ");
  // Spaced hyphen between words/phrases
  t = t.replace(/\s-\s/g, " to ");
  // Standalone en dash or em dash
  t = t.replace(/\s*[\u2013\u2014]\s*/g, " to ");
  // Collapse accidental "to  to"
  t = t.replace(/\bto\s+to\b/gi, "to");
  return t.replace(/\s{2,}/g, " ").trim();
}

/** Full script for <Say> — content is XML-escaped; length capped for Twilio. */
function buildSayTwiMLFromScript(script) {
  const t = normalizeVoiceScriptForTts(String(script || "")).slice(0, 2000);
  if (!t) {
    return `<Response><Say>Hello.</Say></Response>`;
  }
  return `<Response><Say>${escapeXmlText(t)}</Say></Response>`;
}

function buildGreetingTwiML(firstName) {
  const safe = String(firstName || "there")
    .replace(/[^a-zA-Z\s]/g, "")
    .trim()
    .slice(0, 40) || "there";
  // Minimal TwiML, no XML declaration, no voice attribute (max compatibility).
  return `<Response><Say>Hi ${safe}, this is the first test of a really cool product</Say></Response>`;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/** Verify Twilio credentials (open in browser while server runs). */
app.get("/api/twilio/validate", async (_req, res) => {
  try {
    const client = getTwilioClient();
    const account = await client.api.accounts(TWILIO_ACCOUNT_SID).fetch();
    return res.json({
      ok: true,
      accountStatus: account.status,
      friendlyName: account.friendlyName,
      authMode: TWILIO_AUTH_TOKEN ? "auth_token" : "api_key",
    });
  } catch (err) {
    if (isTwilioEnvConfigError(err)) {
      return res.status(503).json({
        ok: false,
        error: err.message,
        hint: TWILIO_ENV_HINT,
      });
    }
    const code = err && err.code;
    const msg = err && err.message;
    const status = err && err.status;
    console.error("[Twilio validate]", status, code, msg);
    return res.status(500).json({
      ok: false,
      error: msg || "Twilio auth failed",
      twilioCode: code,
      twilioStatus: status,
      moreInfo: err && err.moreInfo,
    });
  }
});

/** Same HTTPS check as before interactive voice; open while server runs to debug 11200 / preflight. */
app.get("/api/voice/public-url-check", async (_req, res) => {
  let host = "";
  try {
    const b = (PUBLIC_BASE_URL || "").replace(/\/$/, "");
    if (b) host = new URL(b).hostname;
  } catch (_) {
    host = "";
  }
  const reach = await verifyPublicBaseUrlReachable();
  return res.json({
    publicBaseUrlConfigured: Boolean(PUBLIC_BASE_URL),
    hostname: host || null,
    reach,
    voiceInlineOnly: VOICE_INLINE_ONLY,
    skipPreflightEnv: SKIP_PUBLIC_URL_PREFLIGHT,
  });
});

/** Twilio fetches this URL when the outbound call connects (must be public HTTPS). */
app.get("/api/voice/twiml", (req, res) => {
  let firstName = String(req.query.firstName || "there").trim();
  firstName = firstName.replace(/[^a-zA-Z.'\-\s]/g, "").slice(0, 40) || "there";
  const twimlXml = buildGreetingTwiML(firstName);
  return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>${twimlXml}`);
});

function voiceFlowMissingSessionTwiML() {
  const vr = new twilio.twiml.VoiceResponse();
  vr.say("This call link is no longer valid. Goodbye.");
  vr.hangup();
  return vr.toString();
}

function voiceFlowGoodbyeTwiML() {
  const vr = new twilio.twiml.VoiceResponse();
  vr.say("got it, thank you");
  vr.hangup();
  return vr.toString();
}

/** Twilio GETs this when an interactive outbound call connects (speech gather flow). */
function handleVoiceFlowStart(req, res) {
  try {
    const token = String(req.query.token || "").trim();
    const session = voiceFlowSessions.get(token);
    if (!session) {
      return res.type("text/xml").send(voiceFlowMissingSessionTwiML());
    }
    const qSid = String(req.query.CallSid || "").trim();
    if (qSid) {
      session.callSid = qSid;
    }
    const intro = normalizeVoiceScriptForTts(session.voiceScript).slice(0, 2000);
    const vr = new twilio.twiml.VoiceResponse();
    if (intro) {
      vr.say(intro);
    } else {
      vr.say("Hello.");
    }
    const actionUrl = publicUrl(
      `/api/voice/flow/step?token=${encodeURIComponent(token)}&phase=availability`
    );
    if (!actionUrl) {
      console.error("[Voice flow] start: PUBLIC_BASE_URL missing");
      return res.type("text/xml").send(voiceFlowConfigErrorTwiML());
    }
    vr.gather(gatherSpeechOpts(actionUrl, "yes, no, yeah, yep, sure, okay, available"));
    return res.type("text/xml").send(vr.toString());
  } catch (err) {
    console.error("[Voice flow] start", err && err.stack);
    return res.type("text/xml").send(voiceFlowServerErrorTwiML());
  }
}

app.get("/api/voice/flow/start", handleVoiceFlowStart);
app.post("/api/voice/flow/start", handleVoiceFlowStart);

/** Browser polls this after placing a call; populated when caller completes yes + confirm on the phone. */
app.get("/api/voice/call-outcome/:callSid", (req, res) => {
  const sid = String(req.params.callSid || "").trim();
  if (!sid) {
    return res.status(400).json({ error: "Missing Call SID" });
  }
  const o = voiceCallOutcomes.get(sid);
  if (!o) {
    return res.json({ status: "pending" });
  }
  const { recordedAt, ...rest } = o;
  return res.json(rest);
});

/**
 * Twilio POSTs here after each <Gather> (including timeouts). SpeechResult may be empty.
 */
app.post("/api/voice/flow/step", (req, res) => {
  try {
    const token = String(req.query.token || "").trim();
    const phase = String(req.query.phase || "").trim();
    const session = voiceFlowSessions.get(token);
    if (!session) {
      return res.type("text/xml").send(voiceFlowMissingSessionTwiML());
    }

    const postSid = String((req.body && req.body.CallSid) || "").trim();
    if (postSid) {
      session.callSid = postSid;
    }

    const body = req.body || {};
    const speechRaw =
      body.SpeechResult != null
        ? String(body.SpeechResult)
        : body.speechResult != null
          ? String(body.speechResult)
          : "";
    const speech = speechRaw.trim();
    const speechEmpty = !speech;

    if (process.env.DEBUG_VOICE === "1") {
      console.log("[Voice flow] step", { phase, speechEmpty, speech: speech.slice(0, 200), round: session.availabilityRound });
    }

    if (phase === "confirm") {
      const vr = new twilio.twiml.VoiceResponse();
      if (speechEmpty || !soundsLikeConfirm(speech)) {
        vr.say("got it, thank you");
        vr.hangup();
        return res.type("text/xml").send(vr.toString());
      }
      const line = normalizeVoiceScriptForTts(`${session.shiftTime} on ${session.shiftDay} confirmed`).slice(
        0,
        2000
      );
      vr.say(line || "Confirmed. Thank you.");
      vr.hangup();
      const callSid = String((req.body && req.body.CallSid) || session.callSid || "").trim();
      recordVoiceCallConfirmed(callSid, session);
      return res.type("text/xml").send(vr.toString());
    }

    if (phase !== "availability") {
      return res.type("text/xml").send(voiceFlowGoodbyeTwiML());
    }

    const vr = new twilio.twiml.VoiceResponse();
    const actionAvail = publicUrl(`/api/voice/flow/step?token=${encodeURIComponent(token)}&phase=availability`);
    if (!actionAvail) {
      console.error("[Voice flow] step: PUBLIC_BASE_URL missing");
      return res.type("text/xml").send(voiceFlowConfigErrorTwiML());
    }

    if (!speechEmpty && soundsLikeNo(speech)) {
      vr.say("got it, thank you");
      vr.hangup();
      return res.type("text/xml").send(vr.toString());
    }

    if (!speechEmpty && soundsLikeYes(speech)) {
      vr.say("got it. please confirm by saying confirm.");
      const actionConfirm = publicUrl(`/api/voice/flow/step?token=${encodeURIComponent(token)}&phase=confirm`);
      if (!actionConfirm) {
        return res.type("text/xml").send(voiceFlowConfigErrorTwiML());
      }
      vr.gather(gatherSpeechOpts(actionConfirm, "confirm, confirmed, yes"));
      return res.type("text/xml").send(vr.toString());
    }

    // Silence, unclear, or non-yes/no
    if (session.availabilityRound === 1) {
      session.availabilityRound = 2;
      const rep = normalizeVoiceScriptForTts(
        `I didn't hear a response - let me know if you're free to cover ${session.shiftTime} on ${session.shiftDay}`
      );
      vr.say(rep);
      vr.gather(gatherSpeechOpts(actionAvail, "yes, no, yeah, yep, sure, okay, available"));
      return res.type("text/xml").send(vr.toString());
    }

    vr.say("got it, thank you");
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  } catch (err) {
    console.error("[Voice flow] step", err && err.stack);
    return res.type("text/xml").send(voiceFlowServerErrorTwiML());
  }
});

/** Place outbound call: inline TwiML, or interactive speech URL when PUBLIC_BASE_URL is set. */
app.post("/api/voice/call", async (req, res) => {
  try {
    const {
      to,
      firstName,
      name,
      voiceScript,
      shiftDay,
      shiftTime,
      roleLabel,
      voiceInteractive,
    } = req.body || {};
    const normalizedTo = normalizePhone(to || "");
    if (!normalizedTo) {
      return res.status(400).json({ error: "Missing or invalid phone number (to)" });
    }
    if (!TWILIO_FROM_NUMBER) {
      return res.status(500).json({ error: "Missing TWILIO_FROM_NUMBER" });
    }

    const wantInteractive =
      !VOICE_INLINE_ONLY &&
      voiceInteractive !== false &&
      voiceScript != null &&
      String(voiceScript).trim() !== "" &&
      !!PUBLIC_BASE_URL;

    let twimlString;
    let previewText;
    let callUrl;
    let flowToken;

    if (wantInteractive) {
      flowToken = crypto.randomBytes(24).toString("hex");
      const normalizedCallback = normalizeVoiceCallback(req.body);
      voiceFlowSessions.set(flowToken, {
        voiceScript: String(voiceScript).trim(),
        shiftDay: shiftDay != null ? String(shiftDay).trim() : "",
        shiftTime: shiftTime != null ? String(shiftTime).trim() : "",
        roleLabel: roleLabel != null ? String(roleLabel).trim() : "",
        availabilityRound: 1,
        createdAt: Date.now(),
        callback: normalizedCallback,
        callSid: null,
      });
      callUrl = publicUrl(`/api/voice/flow/start?token=${encodeURIComponent(flowToken)}`);
      if (!callUrl) {
        return res.status(500).json({
          error: "PUBLIC_BASE_URL is not set — cannot start interactive voice. Set it in .env to your HTTPS base URL (e.g. ngrok).",
        });
      }
      previewText = normalizeVoiceScriptForTts(voiceScript).trim().slice(0, 200);
    } else if (voiceScript != null && String(voiceScript).trim() !== "") {
      twimlString = buildSayTwiMLFromScript(voiceScript);
      previewText = normalizeVoiceScriptForTts(voiceScript).trim().slice(0, 120);
      if (voiceInteractive !== false && !PUBLIC_BASE_URL) {
        console.warn(
          "[Voice] PUBLIC_BASE_URL not set — using one-way playback only. Set PUBLIC_BASE_URL (e.g. ngrok HTTPS) for yes/no + confirm."
        );
      }
    } else {
      const greet =
        (firstName && String(firstName).trim()) ||
        (name && String(name).trim().split(/\s+/)[0].replace(/\.$/, "")) ||
        "there";
      const safeGreet = String(greet).replace(/[^a-zA-Z.'\-\s]/g, "").slice(0, 40) || "there";
      twimlString = buildGreetingTwiML(safeGreet);
      previewText = safeGreet;
    }

    const createOpts = {
      to: normalizedTo,
      from: TWILIO_FROM_NUMBER,
    };
    if (callUrl) {
      createOpts.url = callUrl;
    } else {
      createOpts.twiml = twimlString;
    }

    if (callUrl) {
      const reach = await verifyPublicBaseUrlReachable();
      if (!reach.ok) {
        console.error("[Voice call] PUBLIC_BASE_URL unreachable — Twilio would return 11200:", reach.reason);
        if (reach.detail) console.error(reach.detail);
        return res.status(503).json({
          error:
            "PUBLIC_BASE_URL is not reachable (Twilio error 11200). Start ngrok on this machine: ngrok http " +
            PORT +
            " — then copy the https forwarding URL into PUBLIC_BASE_URL in .env (no trailing slash), restart npm start, and try again. If the URL in .env is old, update it (free ngrok URLs change when you restart ngrok).",
          reason: reach.reason,
          detail: reach.detail,
          twilioHint: "11200",
          hint:
            "Or set VOICE_INLINE_ONLY=1 for one-way audio; or SKIP_PUBLIC_URL_PREFLIGHT=1 to bypass this check (Twilio may still error 11200). Open /api/voice/public-url-check for details.",
        });
      }
    }

    const client = getTwilioClient();
    const call = await client.calls.create(createOpts);
    if (callUrl) {
      const openPreview =
        previewText.length > 140 ? `${previewText.slice(0, 140)}…` : previewText;
      console.log(
        "[Voice call]",
        normalizedTo,
        call.sid,
        "| mode=interactive (Twilio GETs TwiML from your PUBLIC_BASE_URL; not inline <Say>)",
        `\n  url: ${callUrl}`,
        `\n  open: ${openPreview}`
      );
    } else {
      console.log("[Voice call]", normalizedTo, call.sid, "| mode=inline-twiml", `\n  ${twimlString}`);
    }
    return res.json({
      ok: true,
      callSid: call.sid,
      to: normalizedTo,
      greeting: previewText,
      scriptPreview: previewText,
      voiceInteractive: !!callUrl,
    });
  } catch (err) {
    if (isTwilioEnvConfigError(err)) {
      return res.status(503).json({ error: err.message, hint: TWILIO_ENV_HINT });
    }
    const code = err && err.code;
    const msg = err && err.message;
    const hint = voiceCallTwilioHint(code);
    console.error("[Voice call error]", code, msg, hint || "", (err && err.moreInfo) || "");
    return res.status(500).json({
      error: msg || "Call failed",
      twilioCode: code,
      moreInfo: err && err.moreInfo,
      hint: hint || undefined,
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const server = app.listen(Number(PORT), LISTEN_HOST, () => {
  console.log(`GM callout app listening on http://${LISTEN_HOST}:${PORT}`);
  if (!TWILIO_ACCOUNT_SID) {
    console.warn(
      "[Env] TWILIO_ACCOUNT_SID is not set — add it in Render → Environment (with auth token and from number), then redeploy. UI works; outbound calls will return 503 until then."
    );
  }
  console.log(`Twilio check: http://localhost:${PORT}/api/twilio/validate`);
  console.log(`Voice PUBLIC_BASE_URL preflight check: http://localhost:${PORT}/api/voice/public-url-check`);
  if (SKIP_PUBLIC_URL_PREFLIGHT) {
    console.warn("SKIP_PUBLIC_URL_PREFLIGHT=1 — HTTPS preflight disabled before voice calls.");
  }
  if (VOICE_INLINE_ONLY) {
    console.log(
      "VOICE_INLINE_ONLY=1: outbound calls use inline <Say> only (Twilio never fetches your ngrok URL). Remove after debugging."
    );
  }
  console.log(
    PUBLIC_BASE_URL && !VOICE_INLINE_ONLY
      ? `Outbound voice: interactive yes/no + confirm when voiceScript is used (PUBLIC_BASE_URL=${PUBLIC_BASE_URL.replace(/\/$/, "")}).`
      : VOICE_INLINE_ONLY
        ? "Outbound voice: inline TwiML only (VOICE_INLINE_ONLY)."
        : "Outbound voice: set PUBLIC_BASE_URL (HTTPS, e.g. ngrok) for speech yes/no + confirm; otherwise one-way playback only."
  );
  if (PUBLIC_BASE_URL) {
    const b = PUBLIC_BASE_URL.replace(/\/$/, "");
    console.log(`Voice flow test: ${b}/api/voice/twiml?firstName=Martin`);
    const healthProbe = appendNgrokBypassToPublicUrl(`${b}/health`);
    console.log(
      `Before placing calls: curl -sS "${healthProbe}" -H "${NGROK_SKIP_HEADER}: ${NGROK_SKIP_VALUE}" — expect HTTP 200 and {"ok":true}. Free ngrok: without that header/param you get HTML (interstitial), not JSON — the server adds this for preflight and Twilio URLs automatically.`
    );
  }
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `\nPort ${PORT} is already in use (another \`npm start\` or app is running).\n` +
        `Free it on macOS:\n` +
        `  kill $(lsof -ti :${PORT})\n` +
        `Or use a different port: PORT=8788 npm start\n` +
        `(If you change PORT, update app.js API_BASE or open the app on that port.)\n`
    );
    process.exit(1);
  }
  throw err;
});
