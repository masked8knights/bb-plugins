import { describe, expect, it } from "vitest";
import { DeferredOAuthCredentialStore, type OAuthCredentialRecord } from "./oauth.js";

function record(accessToken: string): OAuthCredentialRecord {
  return { tokens: { access_token: accessToken, token_type: "Bearer" } };
}

describe("DeferredOAuthCredentialStore", () => {
  it("does not call the host writer from inside a deferred callback", async () => {
    const saved: Record<string, OAuthCredentialRecord>[] = [];
    const store = new DeferredOAuthCredentialStore({
      async load() { return {}; },
      async save(value) { saved.push(value); },
    });

    const release = store.deferPersistence();
    await store.set("plugin:server", record("access-token"));
    expect(saved).toEqual([]);
    release();
    await store.flush();
    expect(saved).toEqual([{ "plugin:server": record("access-token") }]);
  });

  it("persists ordinary writes before resolving", async () => {
    let saveCount = 0;
    const store = new DeferredOAuthCredentialStore({
      async load() { return {}; },
      async save() { saveCount += 1; },
    });

    await store.set("plugin:server", record("access-token"));
    expect(saveCount).toBe(1);
  });

  it("keeps callback-leg credentials available to a reconnect before flush", async () => {
    const store = new DeferredOAuthCredentialStore({
      async load() { return {}; },
      async save() {},
    });
    const release = store.deferPersistence();
    await store.set("plugin:server", record("access-token"));
    expect(await store.get("plugin:server")).toEqual(record("access-token"));
    release();
  });
});
