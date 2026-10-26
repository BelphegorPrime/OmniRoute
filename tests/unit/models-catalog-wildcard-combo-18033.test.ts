import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-wildcard-catalog-18033-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET ||= "wildcard-catalog-18033-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const catalog = await import("../../src/app/api/v1/models/catalog.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function listIds(): Promise<Record<string, Record<string, unknown>>> {
  const response = await catalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Array<Record<string, unknown>> };
  return Object.fromEntries(body.data.map((m) => [String(m.id), m]));
}

test("#18033: wildcard-only combo is advertised in /v1/models like an explicit-member combo", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "groq",
    authType: "apikey",
    name: "groq-18033",
    apiKey: "gsk-test",
    isActive: true,
    testStatus: "active",
  });
  await modelsDb.replaceSyncedAvailableModelsForConnection("groq", connection.id, [
    { id: "openai/gpt-oss-120b", name: "gpt-oss-120b" },
    { id: "openai/gpt-oss-20b", name: "gpt-oss-20b" },
  ]);

  await combosDb.createCombo({
    name: "explicit-repro",
    strategy: "auto",
    models: ["groq/openai/gpt-oss-120b"],
  });
  await combosDb.createCombo({
    name: "wildcard-repro",
    strategy: "auto",
    models: [{ kind: "provider-wildcard", providerId: "groq", modelPattern: "openai/gpt-oss-*" }],
  });
  await combosDb.createCombo({
    name: "wildcard-string-repro",
    strategy: "auto",
    models: ["groq/openai/gpt-oss-*"],
  });
  await combosDb.createCombo({
    name: "wildcard-nomatch-repro",
    strategy: "auto",
    models: ["groq/nonexistent-family-*"],
  });

  const byId = await listIds();
  assert.ok(byId["explicit-repro"], "control: explicit-member combo is listed");
  assert.ok(byId["wildcard-repro"], "structured wildcard-only combo must be listed");
  assert.ok(byId["wildcard-string-repro"], "string wildcard-only combo must be listed");
  assert.equal(byId["wildcard-nomatch-repro"], undefined, "wildcard matching nothing stays hidden");
});
