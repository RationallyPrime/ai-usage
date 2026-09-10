import { digestToken, digestsEqual, type EdgeCredential } from "./config.js";
import { parseObservation, ValidationError, type UsageObservation, type UsageSnapshot } from "./contract.js";
import {
  StoreCapacityError,
  type DoctorProfile,
  type IngestResult,
} from "./store.js";

export const MAX_BODY_BYTES = 8 * 1_024;
const FIXED_UNAUTHORISED_BODY = JSON.stringify({ error: "unauthorised" });
const FIXED_FORBIDDEN_BODY = JSON.stringify({ error: "forbidden" });
const BEARER_PATTERN = /^Bearer ([\x21-\x7e]{16,512})$/;

export interface ServerStore {
  ingest(observation: UsageObservation, receivedAt: string): IngestResult;
  snapshot(generatedAt: string, profileIds?: ReadonlySet<string>): UsageSnapshot;
  probeReady(at: string): void;
  conflictCount(): number;
  recordIdentityKeyMismatch(
    observationId: string,
    profileId: string,
    edgeId: string,
    presentedKeyId: string,
    expectedKeyId: string,
    at: string,
  ): void;
  identityKeyMismatchCount(): number;
  lastIdentityKeyMismatch(): Record<string, unknown> | null;
  doctorProfiles(generatedAt: string): DoctorProfile[];
  recordEdgeForbidden(edgeId: string, observationId: string, at: string): void;
  doctorEdges(): Array<Record<string, unknown>>;
}

export interface AppOptions {
  store: ServerStore;
  readTokenDigest: Uint8Array;
  edgeCredentials: readonly EdgeCredential[];
  invalidAuthMaxAttempts: number;
  invalidAuthWindowMs: number;
  expectedIdentityKeyId?: string | null;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface UsageApp {
  fetch(request: Request, clientKey?: string): Promise<Response>;
}

interface AuthAttempt {
  failures: number;
  windowStartedAt: number;
  lastUsedAt: number;
}

interface ReadAuthentication {
  authorised: boolean;
  rateLimited: boolean;
}

interface EdgeAuthentication {
  credential: EdgeCredential | null;
  rateLimited: boolean;
}

class InvalidAuthLimiter {
  private readonly attempts = new Map<string, AuthAttempt>();

  constructor(
    private readonly maximum: number,
    private readonly windowMs: number,
    private readonly maximumKeys = 1_024,
  ) {}

  blocked(key: string, now: number): boolean {
    const attempt = this.attempts.get(key);
    if (!attempt) return false;
    if (now - attempt.windowStartedAt >= this.windowMs) {
      this.attempts.delete(key);
      return false;
    }
    attempt.lastUsedAt = now;
    return attempt.failures >= this.maximum;
  }

  failure(key: string, now: number): void {
    const attempt = this.attempts.get(key);
    if (!attempt || now - attempt.windowStartedAt >= this.windowMs) {
      this.ensureCapacity();
      this.attempts.set(key, { failures: 1, windowStartedAt: now, lastUsedAt: now });
      return;
    }
    attempt.failures = Math.min(this.maximum, attempt.failures + 1);
    attempt.lastUsedAt = now;
  }

  private ensureCapacity(): void {
    if (this.attempts.size < this.maximumKeys) return;
    let oldestKey: string | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, value] of this.attempts) {
      if (value.lastUsedAt < oldest) {
        oldest = value.lastUsedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.attempts.delete(oldestKey);
  }
}

class HttpBoundaryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createApp(options: AppOptions): UsageApp {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? console.log;
  const limiter = new InvalidAuthLimiter(
    options.invalidAuthMaxAttempts,
    options.invalidAuthWindowMs,
  );

  function presentedBearer(request: Request): string | null {
    const match = BEARER_PATTERN.exec(request.headers.get("authorization") ?? "");
    return match?.[1] ?? null;
  }

  function authenticationKey(
    clientKey: string,
    role: "read" | "edge",
  ): string {
    // Invalid attempts are bounded per transport source and role, so rotating
    // bogus bearer values cannot evade the limiter. Valid credentials are
    // checked first and therefore cannot be locked out by another client that
    // happens to share a reverse-proxy address. A success deliberately leaves
    // that source's invalid-attempt history untouched.
    return `${clientKey}:${role}`;
  }

  function authenticateRead(
    request: Request,
    clientKey: string,
    at: number,
  ): ReadAuthentication {
    const bearer = presentedBearer(request);
    const digest = digestToken(bearer ?? "");
    const key = authenticationKey(clientKey, "read");
    const authorised = bearer !== null && digestsEqual(digest, options.readTokenDigest);
    if (authorised) {
      return { authorised: true, rateLimited: false };
    }
    if (limiter.blocked(key, at)) return { authorised: false, rateLimited: true };
    limiter.failure(key, at);
    return { authorised: false, rateLimited: false };
  }

  function authenticateEdge(
    request: Request,
    clientKey: string,
    at: number,
  ): EdgeAuthentication {
    const bearer = presentedBearer(request);
    const digest = digestToken(bearer ?? "");
    const key = authenticationKey(clientKey, "edge");
    let matched: EdgeCredential | null = null;
    // Always compare against every configured digest. Which edge matched must
    // not be observable through an early return timing difference.
    for (const credential of options.edgeCredentials) {
      if (digestsEqual(digest, credential.tokenDigest)) matched = credential;
    }
    if (bearer !== null && matched) {
      return { credential: matched, rateLimited: false };
    }
    if (limiter.blocked(key, at)) return { credential: null, rateLimited: true };
    limiter.failure(key, at);
    return { credential: null, rateLimited: false };
  }

  return {
    async fetch(request: Request, clientKey = "unknown"): Promise<Response> {
      const url = new URL(request.url);
      const current = now();
      const currentIso = current.toISOString();
      const currentMs = current.getTime();

      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/ready") {
        const auth = authenticateRead(request, clientKey, currentMs);
        if (!auth.authorised) return unauthorised(auth.rateLimited, options.invalidAuthWindowMs);
        try {
          options.store.probeReady(currentIso);
          return json({ ready: true });
        } catch {
          return json({ ready: false }, 503);
        }
      }

      if (request.method === "GET" && url.pathname === "/doctor") {
        const auth = authenticateRead(request, clientKey, currentMs);
        if (!auth.authorised) return unauthorised(auth.rateLimited, options.invalidAuthWindowMs);
        try {
          options.store.probeReady(currentIso);
          // Configured-but-silent profiles must appear: a collector that never
          // reached the server is exactly what this surface exists to expose.
          const configured = new Map<string, string>();
          for (const credential of options.edgeCredentials) {
            for (const profileId of credential.profileIds) {
              configured.set(profileId, credential.edgeId);
            }
          }
          const observed = options.store.doctorProfiles(currentIso);
          const observedIds = new Set(observed.map((profile) => profile.profile_id));
          const profiles = [
            ...observed.map((profile) => ({
              ...profile,
              configured: configured.has(profile.profile_id),
            })),
            ...[...configured.entries()]
              .filter(([profileId]) => !observedIds.has(profileId))
              .map(([profileId, edgeId]) => ({
                profile_id: profileId,
                observer_instance_id: null,
                edge_id: edgeId,
                provider: null,
                first_seen_at: null,
                last_received_at: null,
                last_sampled_at: null,
                last_sequence: null,
                last_outcome: null,
                pool_id: null,
                binding_confidence: null,
                identity_evidence: null,
                identity_key_id: null,
                freshness: "never" as const,
                last_conflict: null,
                configured: true,
              })),
          ].sort((a, b) => a.profile_id.localeCompare(b.profile_id));
          return json({
            schema: 3,
            ready: true,
            conflict_count: options.store.conflictCount(),
            expected_identity_key_id: options.expectedIdentityKeyId ?? null,
            identity_key_mismatch_count: options.store.identityKeyMismatchCount(),
            last_identity_key_mismatch: options.store.lastIdentityKeyMismatch(),
            edges: options.store.doctorEdges(),
            profiles,
          });
        } catch {
          return json({ schema: 3, ready: false, conflict_count: null }, 503);
        }
      }

      if (request.method === "GET" && url.pathname === "/v3/usage") {
        const auth = authenticateRead(request, clientKey, currentMs);
        if (!auth.authorised) return unauthorised(auth.rateLimited, options.invalidAuthWindowMs);
        return json(options.store.snapshot(currentIso, new Set(
          options.edgeCredentials.flatMap((credential) => [...credential.profileIds]),
        )));
      }

      if (request.method === "POST" && url.pathname === "/v3/observations") {
        const auth = authenticateEdge(request, clientKey, currentMs);
        if (!auth.credential) {
          return unauthorised(auth.rateLimited, options.invalidAuthWindowMs);
        }
        const credential = auth.credential;

        try {
          const observation = parseObservation(await readJsonBody(request));
          if (
            observation.edge_id !== credential.edgeId ||
            !credential.profileIds.has(observation.profile_id)
          ) {
            // The evidence 422 already gets: this rejection destroys the
            // observation for a correctly-behaving collector, so it must be
            // visible in the doctor, keyed on the CREDENTIAL's edge id (the
            // payload's fields are attacker-controlled within an
            // authenticated edge).
            options.store.recordEdgeForbidden(
              credential.edgeId,
              observation.observation_id,
              currentIso,
            );
            log(
              `observation forbidden edge=${credential.edgeId} ` +
              `claimed_edge=${observation.edge_id} ` +
              `claimed_profile=${observation.profile_id}`,
            );
            return forbidden();
          }
          const expectedKeyId = options.expectedIdentityKeyId ?? null;
          if (expectedKeyId !== null && observation.identity_key_id !== expectedKeyId) {
            // A wrong identity-key namespace would split one account into
            // several apparently verified pools. Reject loudly with the two
            // non-secret identifiers so the operator can fix provisioning.
            options.store.recordIdentityKeyMismatch(
              observation.observation_id,
              observation.profile_id,
              observation.edge_id,
              observation.identity_key_id,
              expectedKeyId,
              currentIso,
            );
            log(
              `observation rejected identity_key_mismatch ` +
              `edge=${observation.edge_id} profile=${observation.profile_id} ` +
              `presented=${observation.identity_key_id} expected=${expectedKeyId}`,
            );
            return json({
              error: "identity_key_id does not match this aggregator's namespace",
              presented_key_id: observation.identity_key_id,
              expected_key_id: expectedKeyId,
            }, 422);
          }
          const result = options.store.ingest(observation, currentIso);
          log(
            `observation ${result.outcome} id=${observation.observation_id} ` +
            `edge=${observation.edge_id} profile=${observation.profile_id}`,
          );
          return json({
            ok: true,
            observation_id: result.observation_id,
            outcome: result.outcome,
            clock_skewed: result.clock_skewed,
          });
        } catch (error) {
          if (error instanceof HttpBoundaryError) {
            return json({ error: error.message }, error.status);
          }
          if (error instanceof ValidationError) {
            return json({ error: error.message }, 400);
          }
          if (error instanceof StoreCapacityError) {
            return json({ error: "pool capacity reached" }, 409);
          }
          console.error("observation ingest failed", safeError(error));
          return json({ error: "internal error" }, 500);
        }
      }

      return json({ error: "not found" }, 404);
    },
  };
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentEncoding = request.headers.get("content-encoding");
  if (contentEncoding !== null && contentEncoding.toLowerCase().trim() !== "identity") {
    throw new HttpBoundaryError(415, "compressed request bodies are not supported");
  }
  const contentType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpBoundaryError(415, "content-type must be application/json");
  }

  const rawLength = request.headers.get("content-length");
  let declaredLength: number | null = null;
  if (rawLength !== null) {
    if (!/^\d+$/.test(rawLength)) throw new HttpBoundaryError(400, "invalid content-length");
    declaredLength = Number(rawLength);
    if (!Number.isSafeInteger(declaredLength)) {
      throw new HttpBoundaryError(400, "invalid content-length");
    }
    if (declaredLength > MAX_BODY_BYTES) {
      try {
        await request.body?.cancel("body too large");
      } catch {
        // The HTTP status is determined by the byte bound, not by a producer's
        // cancellation callback.
      }
      throw new HttpBoundaryError(413, "body too large");
    }
  }

  if (!request.body) throw new HttpBoundaryError(400, "body is not valid JSON");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        try {
          await reader.cancel("body too large");
        } catch {
          // Preserve the boundary error even if the stream rejects cancel.
        }
        throw new HttpBoundaryError(413, "body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (declaredLength !== null && declaredLength !== total) {
    throw new HttpBoundaryError(400, "content-length does not match body");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpBoundaryError(400, "body is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpBoundaryError(400, "body is not valid JSON");
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function unauthorised(rateLimited = false, windowMs = 0): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (rateLimited) {
    headers["retry-after"] = String(Math.max(1, Math.ceil(windowMs / 1_000)));
  }
  return new Response(FIXED_UNAUTHORISED_BODY, {
    status: 401,
    headers,
  });
}

function forbidden(): Response {
  return new Response(FIXED_FORBIDDEN_BODY, {
    status: 403,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.name;
  return "unknown error";
}
