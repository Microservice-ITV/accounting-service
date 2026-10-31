import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import app from "./app.js";

test("mounts AR/AP and inventory valuation report routes under the API prefix", async () => {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const [arAp, inventory] = await Promise.all([
      fetch(`http://127.0.0.1:${address.port}/api/v1/reports/ar-ap`),
      fetch(`http://127.0.0.1:${address.port}/api/v1/reports/inventory-valuation`),
    ]);

    assert.equal(arAp.status, 401);
    assert.equal(inventory.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
