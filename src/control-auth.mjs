import { createHmac, createHash, randomBytes } from "node:crypto";
import { equal } from "./auth.mjs";
import { PhoneError } from "./state.mjs";

export const CONTROL_PROTOCOL = "2";
const digest = (text) => createHash("sha256").update(text).digest("hex");
const mac = (config, value) =>
  createHmac("sha256", config.adminSecret).update(value).digest("hex");
const responseValue = (nonce, status, text) =>
  ["response", CONTROL_PROTOCOL, nonce, status, digest(text)].join("\n");

export function controlRequestHeaders(
  config,
  method,
  path,
  text = "",
  { now = Date.now(), nonce = randomBytes(24).toString("hex") } = {},
) {
  const timestamp = String(now);
  return {
    "x-codex-control-protocol": CONTROL_PROTOCOL,
    "x-codex-control-time": timestamp,
    "x-codex-control-nonce": nonce,
    "x-codex-control-signature": mac(
      config,
      [
        "request",
        CONTROL_PROTOCOL,
        method,
        path,
        timestamp,
        nonce,
        digest(text),
      ].join("\n"),
    ),
  };
}

export function verifyControlRequest(
  config,
  req,
  text,
  seen,
  { now = Date.now() } = {},
) {
  const protocol = req.headers["x-codex-control-protocol"],
    timestamp = req.headers["x-codex-control-time"],
    nonce = req.headers["x-codex-control-nonce"],
    signature = req.headers["x-codex-control-signature"];
  if (
    protocol !== CONTROL_PROTOCOL ||
    !/^\d{10,16}$/.test(timestamp || "") ||
    Math.abs(now - Number(timestamp)) > 60000 ||
    !/^[a-f0-9]{48}$/.test(nonce || "") ||
    !/^[a-f0-9]{64}$/.test(signature || "")
  )
    return false;
  for (const [key, expiry] of seen) if (expiry < now) seen.delete(key);
  if (seen.has(nonce) || seen.size >= 4096) return false;
  const expected = mac(
    config,
    [
      "request",
      protocol,
      req.method,
      req.url,
      timestamp,
      nonce,
      digest(text),
    ].join("\n"),
  );
  if (!equal(signature, expected)) return false;
  seen.set(nonce, now + 60000);
  return true;
}

export function controlResponse(config, nonce, status, value) {
  const text = JSON.stringify({
    ...value,
    service: "codex-phone",
    controlProtocol: Number(CONTROL_PROTOCOL),
    deviceId: config.deviceId,
  });
  return {
    text,
    headers: {
      "x-codex-control-protocol": CONTROL_PROTOCOL,
      "x-codex-control-device": config.deviceId,
      "x-codex-control-signature": mac(
        config,
        responseValue(nonce || "", status, text),
      ),
    },
  };
}

export function verifyControlResponse(config, nonce, status, text, headers) {
  if (
    headers.get("x-codex-control-protocol") !== CONTROL_PROTOCOL ||
    headers.get("x-codex-control-device") !== config.deviceId ||
    !equal(
      headers.get("x-codex-control-signature"),
      mac(config, responseValue(nonce, status, text)),
    )
  )
    throw new PhoneError(
      "control_identity_mismatch",
      "The saved port is not an authenticated codex-phone control service.",
      [
        "Inspect the saved port owner; do not send credentials or trust its status.",
      ],
    );
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new PhoneError("control_invalid_response");
  }
  if (
    result.service !== "codex-phone" ||
    result.controlProtocol !== Number(CONTROL_PROTOCOL) ||
    result.deviceId !== config.deviceId
  )
    throw new PhoneError("control_identity_mismatch");
  if (status < 200 || status >= 300)
    throw new PhoneError(result.error || "control_failed");
  return result;
}

export async function requestControl(
  config,
  name,
  body,
  { timeout = 90000 } = {},
) {
  if (!config.ports.control) throw new PhoneError("service_not_running");
  const path = "/" + name,
    method = body ? "POST" : "GET",
    text = body ? JSON.stringify(body) : "";
  const headers = controlRequestHeaders(config, method, path, text);
  const response = await fetch(
    `http://127.0.0.1:${config.ports.control}${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? text : undefined,
      signal: AbortSignal.timeout(timeout),
    },
  );
  if (
    response.headers.get("x-codex-control-protocol") !== CONTROL_PROTOCOL ||
    response.headers.get("x-codex-control-device") !== config.deviceId
  ) {
    await response.body?.cancel();
    throw new PhoneError(
      "control_identity_mismatch",
      "The saved control port belongs to a different service.",
    );
  }
  let responseText = "";
  const reader = response.body?.getReader();
  if (reader) {
    let bytes = 0;
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new PhoneError("control_response_too_large");
      }
      chunks.push(Buffer.from(value));
    }
    responseText = Buffer.concat(chunks).toString();
  }
  return verifyControlResponse(
    config,
    headers["x-codex-control-nonce"],
    response.status,
    responseText,
    response.headers,
  );
}
