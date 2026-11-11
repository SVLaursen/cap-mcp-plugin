import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A local token issuer for the auth matrix (docs/testing.md). It signs real RS256 JWTs, and
 * hands @sap/xssec its public key through xssec's own JWKS cache option
 * (`config.validation.jwks.impl`), so xssec validates every token for real (signature, issuer,
 * audience, expiry) without a network call. Nothing in @sap/xssec or @sap/cds is stubbed.
 */
export interface Issuer {
  /** Sign a token with these claims (iat/exp default to now / now + 1 h). */
  token(claims: Record<string, unknown>, header?: Record<string, unknown>): string;
  /** `cds.requires.auth.config`: xssec's service config with this issuer's keys. */
  config: { validation: { jwks: { impl: JwksStore } } };
}

/** The store interface of xssec's ResponseCache (`impl`): snapshots `{ data, lastRefresh }`. */
export interface JwksStore {
  get(key: string): { data: { keys: unknown[] }; lastRefresh: number };
  set(key: string, value: unknown): void;
  clear(): void;
}

const base64url = (value: unknown) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

export function createIssuer(): Issuer {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = `test-${randomUUID()}`;
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  // Every JWKS lookup (whatever the tenant or issuer key) sees this issuer's key, fresh.
  const store: JwksStore = {
    get: () => ({ data: { keys: [jwk] }, lastRefresh: Date.now() }),
    set: () => undefined,
    clear: () => undefined,
  };
  return {
    token: (claims, header = {}) =>
      signJwt(privateKey, { alg: "RS256", typ: "JWT", kid, ...header }, claims),
    config: { validation: { jwks: { impl: store } } },
  };
}

function signJwt(key: KeyObject, header: Record<string, unknown>, claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now, exp: now + 3600, ...claims };
  const input = `${base64url(header)}.${base64url(payload)}`;
  return `${input}.${sign("sha256", Buffer.from(input), key).toString("base64url")}`;
}

/**
 * A self-signed client certificate and its key (PEM), as an X.509 binding carries them. Made with
 * the `openssl` CLI, since Node's crypto can parse certificates but not issue them.
 */
export function clientCertificate(subject = "/CN=cap-mcp-tests"): {
  certificate: string;
  key: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "cap-mcp-cert-"));
  try {
    const key = path.join(dir, "key.pem");
    const cert = path.join(dir, "cert.pem");
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1"].concat([
        "-subj",
        subject,
        "-keyout",
        key,
        "-out",
        cert,
      ]),
      { stdio: "ignore" },
    );
    return { certificate: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
