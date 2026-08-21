import * as crypto from "node:crypto";
import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";

export interface OAuthCredentialRecord {
  clientInformation?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  codeVerifier?: string;
  state?: string;
  authorizationUrl?: string;
  discoveryState?: OAuthDiscoveryState;
  authorizationServerUrl?: string;
  resourceUrl?: string;
}

export interface OAuthCredentialStore {
  get(key: string): Promise<OAuthCredentialRecord | undefined>;
  set(key: string, value: OAuthCredentialRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface OAuthCredentialBackend {
  load(): Promise<Record<string, OAuthCredentialRecord>>;
  save(value: Record<string, OAuthCredentialRecord>): Promise<void>;
}

/**
 * Durable OAuth storage needs one small host integration seam: BB's settings
 * writer is an HTTP request, and calling it while the OAuth callback route is
 * still running can deadlock a serialized plugin worker. Keep callback-leg
 * mutations in memory, then flush them after the route has returned.
 */
export class DeferredOAuthCredentialStore implements OAuthCredentialStore {
  private cached: Record<string, OAuthCredentialRecord> | undefined;
  private dirty = false;
  private callbackDepth = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly backend: OAuthCredentialBackend,
    private readonly onPersistError: (error: unknown) => void = () => {},
  ) {}

  async get(key: string): Promise<OAuthCredentialRecord | undefined> {
    const records = await this.readAll();
    const value = records[key];
    return value ? cloneRecord(value) : undefined;
  }

  async set(key: string, value: OAuthCredentialRecord): Promise<void> {
    await this.mutate((records) => { records[key] = cloneRecord(value); });
  }

  async delete(key: string): Promise<void> {
    await this.mutate((records) => { delete records[key]; });
  }

  /** Defer host settings writes until the returned release function is called. */
  deferPersistence(): () => void {
    this.callbackDepth += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.callbackDepth = Math.max(0, this.callbackDepth - 1);
      if (this.callbackDepth === 0 && this.dirty) this.scheduleFlush();
    };
  }

  async flush(): Promise<void> {
    this.writeChain = this.writeChain.catch(() => {}).then(() => this.persistIfSafe());
    await this.writeChain;
  }

  private async mutate(mutator: (records: Record<string, OAuthCredentialRecord>) => void): Promise<void> {
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      const records = await this.readAll();
      mutator(records);
      this.cached = records;
      this.dirty = true;
      await this.persistIfSafe();
    });
    await this.writeChain;
  }

  private async readAll(): Promise<Record<string, OAuthCredentialRecord>> {
    if (!this.cached) this.cached = cloneRecords(await this.backend.load());
    return cloneRecords(this.cached);
  }

  private async persistIfSafe(): Promise<void> {
    if (this.callbackDepth > 0 || !this.dirty || !this.cached) return;
    const snapshot = cloneRecords(this.cached);
    this.dirty = false;
    try {
      await this.backend.save(snapshot);
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch((error) => this.onPersistError(error));
    }, 0);
  }
}

function cloneRecord(value: OAuthCredentialRecord): OAuthCredentialRecord {
  return JSON.parse(JSON.stringify(value)) as OAuthCredentialRecord;
}

function cloneRecords(value: Record<string, OAuthCredentialRecord>): Record<string, OAuthCredentialRecord> {
  return JSON.parse(JSON.stringify(value)) as Record<string, OAuthCredentialRecord>;
}

export type OAuthStatus = "unauthenticated" | "authorizing" | "authenticated";

function randomState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function sameString(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * The official MCP SDK owns discovery, PKCE, token exchange, refresh, and
 * WWW-Authenticate handling. This provider only gives it durable, per-server
 * storage and a BB loopback redirect.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private authorizationUrl: string | undefined;

  constructor(
    private readonly key: string,
    private readonly serverUrl: URL,
    private readonly redirectUrlValue: URL,
    private readonly store: OAuthCredentialStore,
  ) {}

  get redirectUrl(): URL { return this.redirectUrlValue; }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "BB Agent Plugins",
      redirect_uris: [this.redirectUrlValue.toString()],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    } as OAuthClientMetadata;
  }

  async state(): Promise<string> {
    const record = await this.read();
    const value = randomState();
    await this.write({ ...record, state: value });
    return value;
  }

  async clientInformation(ctx?: { issuer: string }): Promise<StoredOAuthClientInformation | undefined> {
    const value = (await this.read()).clientInformation;
    if (ctx?.issuer && value?.issuer && value.issuer !== ctx.issuer) return undefined;
    return value;
  }

  async saveClientInformation(value: StoredOAuthClientInformation): Promise<void> {
    const record = await this.read();
    await this.write({ ...record, clientInformation: value });
  }

  async tokens(ctx?: { issuer: string }): Promise<StoredOAuthTokens | undefined> {
    const value = (await this.read()).tokens;
    if (ctx?.issuer && value?.issuer && value.issuer !== ctx.issuer) return undefined;
    return value;
  }

  async saveTokens(value: StoredOAuthTokens): Promise<void> {
    const record = await this.read();
    await this.write({ ...record, tokens: value });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    this.authorizationUrl = url.toString();
    const record = await this.read();
    await this.write({ ...record, authorizationUrl: this.authorizationUrl });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const record = await this.read();
    await this.write({ ...record, codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const value = (await this.read()).codeVerifier;
    if (!value) throw new Error("MCP OAuth code verifier is missing; restart authorization");
    return value;
  }

  async saveAuthorizationServerUrl(value: string): Promise<void> {
    const record = await this.read();
    await this.write({ ...record, authorizationServerUrl: value });
  }

  async authorizationServerUrl(): Promise<string | undefined> {
    return (await this.read()).authorizationServerUrl;
  }

  async saveResourceUrl(value: string): Promise<void> {
    const record = await this.read();
    await this.write({ ...record, resourceUrl: value });
  }

  async resourceUrl(): Promise<string | undefined> {
    return (await this.read()).resourceUrl;
  }

  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    const record = await this.read();
    await this.write({ ...record, discoveryState: value });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.read()).discoveryState;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const record = await this.read();
    if (scope === "all") {
      await this.store.delete(this.key);
      this.authorizationUrl = undefined;
      return;
    }
    const next = { ...record };
    if (scope === "client") delete next.clientInformation;
    if (scope === "tokens") delete next.tokens;
    if (scope === "verifier") {
      delete next.codeVerifier;
      delete next.state;
    }
    if (scope === "discovery") {
      delete next.discoveryState;
      delete next.authorizationServerUrl;
      delete next.resourceUrl;
    }
    await this.write(next);
  }

  getAuthorizationUrl(): string | undefined { return this.authorizationUrl; }

  async authorizationUrlValue(): Promise<string | undefined> {
    return this.authorizationUrl ?? (await this.read()).authorizationUrl;
  }

  async status(): Promise<OAuthStatus> {
    const record = await this.read();
    if (this.authorizationUrl || record.state) return "authorizing";
    return record.tokens?.access_token ? "authenticated" : "unauthenticated";
  }

  async validateState(value: string | null): Promise<void> {
    const expected = (await this.read()).state;
    if (!sameString(expected, value ?? undefined)) throw new Error("MCP OAuth state mismatch");
  }

  async clearPending(): Promise<void> {
    this.authorizationUrl = undefined;
    const record = await this.read();
    delete record.state;
    delete record.codeVerifier;
    delete record.authorizationUrl;
    await this.write(record);
  }

  private async read(): Promise<OAuthCredentialRecord> {
    return (await this.store.get(this.key)) ?? {};
  }

  private async write(value: OAuthCredentialRecord): Promise<void> {
    if (Object.keys(value).length === 0) await this.store.delete(this.key);
    else await this.store.set(this.key, value);
  }

  /** Exposed for tests and diagnostics; it never contains an access token. */
  get serverOrigin(): string { return this.serverUrl.origin; }
}
