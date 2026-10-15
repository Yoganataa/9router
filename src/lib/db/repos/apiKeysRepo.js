import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { keyAccessFromColumns, keyAccessToColumns } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";

const CONFIGURED_API_KEY_ID = "00000000-0000-4000-8000-000000000001";

function ensureConfiguredApiKey(db) {
  const configuredKey = String(process.env.NINEROUTER_API_KEY || "").trim();
  if (!configuredKey) return;

  const configuredName =
    String(process.env.NINEROUTER_API_KEY_NAME || "").trim() || "Environment API Key";

  // Reconcile this key on demand so a fresh or reset data directory can use
  // the same explicitly configured key without manual database editing.
  db.transaction(() => {
    const existingKey = db.get("SELECT id FROM apiKeys WHERE key = ? LIMIT 1", [configuredKey]);
    const managedRow = db.get("SELECT id, key FROM apiKeys WHERE id = ? LIMIT 1", [CONFIGURED_API_KEY_ID]);

    if (existingKey) {
      db.run("UPDATE apiKeys SET isActive = 1 WHERE id = ?", [existingKey.id]);
      if (managedRow && managedRow.id !== existingKey.id) {
        db.run("UPDATE apiKeys SET isActive = 0 WHERE id = ?", [managedRow.id]);
      }
      return;
    }

    if (managedRow) {
      db.run(
        "UPDATE apiKeys SET key = ?, name = ?, machineId = NULL, isActive = 1, accessRestricted = 0, accessAllow = NULL WHERE id = ?",
        [configuredKey, configuredName, CONFIGURED_API_KEY_ID]
      );
      return;
    }

    db.run(
      "INSERT INTO apiKeys (id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow) VALUES (?, ?, ?, NULL, 1, ?, 0, NULL)",
      [CONFIGURED_API_KEY_ID, configuredKey, configuredName, new Date().toISOString()]
    );
  });
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    access: keyAccessFromColumns(row.accessRestricted, row.accessAllow),
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  ensureConfiguredApiKey(db);
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

// Used by the /v1 handlers to read the presented key's access settings.
export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  ensureConfiguredApiKey(db);
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    access: { restricted: false, allow: [] },
  };
  const cols = keyAccessToColumns(KEY_ACCESS_UNRESTRICTED);
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, cols.accessRestricted, cols.accessAllow]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    const cols = keyAccessToColumns(merged.access);
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, accessRestricted = ?, accessAllow = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, cols.accessRestricted, cols.accessAllow, id]
    );
    result = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  ensureConfiguredApiKey(db);
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
