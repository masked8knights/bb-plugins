import { describe, expect, it } from "vitest";
import { McpOAuthProvider, type OAuthCredentialRecord, type OAuthCredentialStore } from "./oauth.js";

class MemorySecrets implements OAuthCredentialStore {
  readonly records = new Map<string, OAuthCredentialRecord>();
  async get(key: string) { return this.records.get(key); }
  async set(key: string, value: OAuthCredentialRecord) { this.records.set(key, value); }
  async delete(key: string) { this.records.delete(key); }
}

describe("McpOAuthProvider", () => {
  it("persists PKCE state and credentials without exposing them in status", async () => {
    const secrets = new MemorySecrets();
    const provider = new McpOAuthProvider(
      "plugin:server",
      new URL("https://mcp.example.test/mcp"),
      new URL("http://127.0.0.1:4000/callback?pluginId=plugin&serverId=server"),
      secrets,
    );
    expect(provider.clientMetadata).toEqual(expect.objectContaining({
      client_name: "BB Agent Plugins",
      token_endpoint_auth_method: "none",
      redirect_uris: ["http://127.0.0.1:4000/callback?pluginId=plugin&serverId=server"],
    }));
    expect(await provider.status()).toBe("unauthenticated");

    const state = await provider.state();
    await expect(provider.validateState("wrong")).rejects.toThrow("state mismatch");
    await expect(provider.validateState(state)).resolves.toBeUndefined();
    await provider.saveCodeVerifier("verifier");
    await provider.redirectToAuthorization(new URL("https://auth.example.test/authorize?state=" + state));
    expect(await provider.status()).toBe("authorizing");
    expect(provider.getAuthorizationUrl()).toContain("auth.example.test");
    const reloadedProvider = new McpOAuthProvider(
      "plugin:server",
      new URL("https://mcp.example.test/mcp"),
      new URL("http://127.0.0.1:4000/callback?pluginId=plugin&serverId=server"),
      secrets,
    );
    expect(await reloadedProvider.authorizationUrlValue()).toContain("auth.example.test");

    await provider.saveTokens({ access_token: "secret-access-token", token_type: "Bearer", refresh_token: "secret-refresh-token" });
    await provider.clearPending();
    expect(await provider.status()).toBe("authenticated");
    expect(await provider.tokens()).toEqual(expect.objectContaining({ access_token: "secret-access-token" }));

    await provider.invalidateCredentials("tokens");
    expect(await provider.status()).toBe("unauthenticated");
    expect(secrets.records.get("plugin:server")?.codeVerifier).toBeUndefined();
  });
});
