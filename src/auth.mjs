import {
  createHash,
  randomInt,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import { join } from "node:path";
import { readJSON, saveJSON, secret, PhoneError } from "./state.mjs";
const hash = (s) => createHash("sha256").update(String(s)).digest("hex");
export const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
export class PhoneAuth {
  constructor(config, data, { save = async () => {}, now = Date.now } = {}) {
    this.config = config;
    this.data = data;
    this.writeQueue = Promise.resolve();
    this.save = (data) => {
      const snapshot = structuredClone(data);
      const pending = this.writeQueue.then(() => save(snapshot));
      this.writeQueue = pending.catch(() => {});
      return pending;
    };
    this.now = now;
    this.listeners = new Set();
  }
  static async open(config, dir) {
    const file = join(dir, "phones.json");
    return new PhoneAuth(
      config,
      await readJSON(file, { phones: [], sessions: [], pairing: null }),
      { save: (data) => saveJSON(file, data) },
    );
  }
  async pairCode() {
    const code = String(randomInt(100000000)).padStart(8, "0");
    this.data.pairing = {
      hash: hash(code),
      expiresAt: this.now() + 600000,
      failures: 0,
    };
    await this.save(this.data);
    return { code, expiresAt: this.data.pairing.expiresAt };
  }
  checkDevice(deviceId) {
    if (deviceId !== this.config.deviceId)
      throw new PhoneError("wrong_computer");
  }
  async pair({ deviceId, code, name }) {
    this.checkDevice(deviceId);
    const p = this.data.pairing;
    if (!p || p.expiresAt <= this.now())
      throw new PhoneError("pairing_expired");
    if (p.failures >= 20) throw new PhoneError("pairing_locked");
    if (!equal(hash(code), p.hash)) {
      p.failures++;
      await this.save(this.data);
      throw new PhoneError("invalid_pairing_code");
    }
    // Consume before awaiting IO, so concurrent requests cannot reuse a code.
    this.data.pairing = null;
    const credential = secret();
    const phone = {
      phoneId: randomUUID(),
      credentialHash: hash(credential),
      name: String(name || "Android").slice(0, 120),
      createdAt: this.now(),
      expiresAt: this.now() + 365 * 86400000,
    };
    this.data.phones.push(phone);
    const result = await this.sessionFor(phone);
    return { ...result, credential };
  }
  validate({ deviceId, phoneId, credential }) {
    this.checkDevice(deviceId);
    const p = this.data.phones.find(
      (p) =>
        p.phoneId === phoneId &&
        !p.revokedAt &&
        p.expiresAt > this.now() &&
        equal(p.credentialHash, hash(credential)),
    );
    if (!p) throw new PhoneError("phone_not_authorized");
    return p;
  }
  async session(body) {
    return this.sessionFor(this.validate(body));
  }
  async sessionFor(phone) {
    const token = secret(),
      expiresAt = Math.min(phone.expiresAt, this.now() + 28 * 86400000);
    this.data.sessions = this.data.sessions.filter(
      (s) => s.expiresAt > this.now(),
    );
    const own = this.data.sessions
      .filter((s) => s.phoneId === phone.phoneId)
      .slice(-15);
    this.data.sessions = this.data.sessions
      .filter((s) => s.phoneId !== phone.phoneId)
      .concat(own, { hash: hash(token), phoneId: phone.phoneId, expiresAt });
    await this.save(this.data);
    return {
      ok: true,
      phoneId: phone.phoneId,
      deviceId: this.config.deviceId,
      deviceName: this.config.deviceName,
      expiresAt,
      token,
    };
  }
  authorization(req) {
    const value = /(?:^|;\s*)bridge_phone_session=([^;]+)/.exec(
      req.headers.cookie || "",
    )?.[1];
    if (!value) return null;
    const s = this.data.sessions.find(
      (s) => s.expiresAt > this.now() && equal(s.hash, hash(value)),
    );
    if (!s) return null;
    const phone = this.data.phones.find(
      (p) =>
        p.phoneId === s.phoneId && !p.revokedAt && p.expiresAt > this.now(),
    );
    return phone
      ? { phone, session: s, expiresAt: Math.min(phone.expiresAt, s.expiresAt) }
      : null;
  }
  authorized(req) {
    return this.authorization(req)?.phone || null;
  }
  list() {
    return this.data.phones.map(({ credentialHash, ...p }) => p);
  }
  async revoke(phoneId) {
    const p = this.data.phones.find((p) => p.phoneId === phoneId);
    if (!p) throw new PhoneError("phone_not_found");
    p.revokedAt = this.now();
    this.data.sessions = this.data.sessions.filter(
      (s) => s.phoneId !== phoneId,
    );
    for (const fn of this.listeners) fn(phoneId);
    await this.save(this.data);
  }
}
