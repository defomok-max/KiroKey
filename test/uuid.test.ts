import { test } from "node:test";
import assert from "node:assert/strict";

import { v5 } from "../src/util/uuid.js";

test("v5 rejects malformed namespace UUIDs", () => {
  assert.throws(() => v5("name", "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"), /invalid uuid/);
});
