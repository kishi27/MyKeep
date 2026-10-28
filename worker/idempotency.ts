export interface IdempotencyRecord {
  idempotency_key: string;
  scope: string;
  payload_hash: string;
  resource_id: string;
  secondary_resource_id: string | null;
  state: "pending" | "completed";
  created_at: string;
  completed_at: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseIdempotencyKey(request: Request): string | null | false {
  const value = request.headers.get("Idempotency-Key");
  if (value === null) return null;
  if (!UUID_PATTERN.test(value)) return false;
  return value.toLowerCase();
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return "[" + value.map((item) => stableJson(item)).join(",") + "]";
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return "{" + entries.map(([key, item]) => JSON.stringify(key) + ":" + stableJson(item)).join(",") + "}";
  }
  throw new Error("invalid_idempotency_payload");
}

async function digestHex(value: Uint8Array): Promise<string> {
  const input = new ArrayBuffer(value.byteLength);
  new Uint8Array(input).set(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashIdempotencyPayload(value: unknown): Promise<string> {
  return digestHex(new TextEncoder().encode(stableJson(value)));
}

export async function hashIdempotencyBytes(value: Uint8Array): Promise<string> {
  return digestHex(value);
}

export async function readIdempotencyRecord(db: D1Database, key: string): Promise<IdempotencyRecord | null> {
  return db.prepare(
    "SELECT idempotency_key, scope, payload_hash, resource_id, secondary_resource_id, state, created_at, completed_at FROM api_idempotency WHERE idempotency_key = ?",
  ).bind(key).first<IdempotencyRecord>();
}

export async function reserveIdempotencyRecord(
  db: D1Database,
  key: string,
  scope: string,
  payloadHash: string,
  secondaryResourceId: string | null = null,
): Promise<IdempotencyRecord> {
  const createdAt = new Date().toISOString();
  await db.prepare(
    "INSERT OR IGNORE INTO api_idempotency (idempotency_key, scope, payload_hash, resource_id, secondary_resource_id, state, created_at, completed_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)",
  ).bind(key, scope, payloadHash, crypto.randomUUID(), secondaryResourceId, createdAt).run();
  const record = await readIdempotencyRecord(db, key);
  if (!record) throw new Error("idempotency_record_missing");
  return record;
}

export function idempotencyMatches(record: IdempotencyRecord, scope: string, payloadHash: string): boolean {
  return record.scope === scope && record.payload_hash === payloadHash;
}

export function markIdempotencyCompleted(
  db: D1Database,
  record: IdempotencyRecord,
  completedAt: string,
  completionCondition: string,
  completionBindings: unknown[] = [],
): D1PreparedStatement {
  return db.prepare(
    "UPDATE api_idempotency SET state = 'completed', completed_at = ? " +
    "WHERE idempotency_key = ? AND scope = ? AND payload_hash = ? AND resource_id = ? " +
    "AND state = 'pending' AND " + completionCondition,
  ).bind(completedAt, record.idempotency_key, record.scope, record.payload_hash, record.resource_id, ...completionBindings);
}
