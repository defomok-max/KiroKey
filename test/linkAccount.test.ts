import { test } from "node:test";
import assert from "node:assert/strict";

import { linkedAccountId, tokenPathForAccount, LINK_ACCOUNT_INTERNALS } from "../src/kiro/linkAccount.js";

test("linkedAccountId is stable and does not expose the refresh token", () => {
  const id = linkedAccountId({
    refreshToken: "aorAAAAAG-secret-refresh-token",
    authMethod: "social",
    provider: "Google",
  });
  assert.match(id, /^linked:google:[a-f0-9]{16}$/);
  assert.equal(id.includes("secret-refresh-token"), false);
  assert.equal(
    id,
    linkedAccountId({
      refreshToken: "aorAAAAAG-secret-refresh-token",
      authMethod: "social",
      provider: "Google",
    })
  );
});

test("tokenPathForAccount keeps linked token files inside the cache dir", () => {
  const path = tokenPathForAccount("/safe/cache", "../linked:Google:abc");
  assert.equal(path, "/safe/cache/.._linked:Google:abc.json");
});

test("link account constants use Kiro-compatible OAuth settings", () => {
  assert.equal(LINK_ACCOUNT_INTERNALS.BUILDER_ID_START_URL, "https://view.awsapps.com/start");
  assert.equal(LINK_ACCOUNT_INTERNALS.SOCIAL_CALLBACK_PATH, "/oauth/callback");
  assert.deepEqual(LINK_ACCOUNT_INTERNALS.AWS_SCOPES, [
    "codewhisperer:completions",
    "codewhisperer:analysis",
    "codewhisperer:conversations",
    "codewhisperer:transformations",
    "codewhisperer:taskassist",
  ]);
});
