/**
 * Microsoft Graph adapter — EntraID (Azure AD).
 *
 * Plain fetch against the REST API with a client-credentials token, rather than the Graph SDK:
 * the SDK is a large dependency for three endpoints, and an air-gapped mirror has one fewer thing
 * to carry. The three calls are /users, /administrativeUnits and each unit's /members.
 *
 * THE STRUCTURAL PROBLEM WITH ENTRA
 * Entra has no OU tree. It has flat administrative units and a manager chain, so there is no
 * "parent unit" to read. Two shapes are therefore supported:
 *
 *   - administrativeUnits — flat, so every unit maps at the same depth. Nesting, if any, has to
 *     come from a naming convention, which `TierMapping.directorates` handles.
 *   - the manager chain — when there are no administrative units, the reporting hierarchy is
 *     synthesized into units, one per manager. Coarse, but it is what most tenants actually have.
 *
 * Which one runs is chosen by what the tenant returns, not by configuration, because an admin
 * usually does not know which of the two their tenant is using.
 *
 * SOVEREIGN CLOUDS work by changing two hosts: login.microsoftonline.us and graph.microsoft.us
 * for Azure Gov. Both are options here rather than constants.
 */

import {
  DirectoryError,
  DirectorySnapshot,
  type DirectoryPerson,
  type DirectorySource,
  type DirectoryUnit,
} from '../port.js';

export interface GraphAdapterOptions {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** https://graph.microsoft.com (commercial) or https://graph.microsoft.us (Gov). */
  readonly baseUrl?: string;
  /** https://login.microsoftonline.com (commercial) or .us (Gov). */
  readonly loginUrl?: string;
  /** Synthesize units from the manager chain even when administrative units exist. */
  readonly forceManagerHierarchy?: boolean;
  readonly timeoutMs?: number;
}

interface GraphUser {
  id: string;
  displayName?: string | null;
  jobTitle?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
  accountEnabled?: boolean | null;
  manager?: { id?: string } | null;
}

interface GraphUnit {
  id: string;
  displayName?: string | null;
  description?: string | null;
}

interface GraphPage<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

export class GraphDirectorySource implements DirectorySource {
  readonly name = 'graph';
  private readonly baseUrl: string;
  private readonly loginUrl: string;

  constructor(private readonly opts: GraphAdapterOptions) {
    if (!opts.tenantId) throw new DirectoryError('DIRECTORY_GRAPH_TENANT_ID is required');
    if (!opts.clientId) throw new DirectoryError('DIRECTORY_GRAPH_CLIENT_ID is required');
    if (!opts.clientSecret) throw new DirectoryError('DIRECTORY_GRAPH_CLIENT_SECRET is required');
    this.baseUrl = (opts.baseUrl ?? 'https://graph.microsoft.com').replace(/\/$/, '');
    this.loginUrl = (opts.loginUrl ?? 'https://login.microsoftonline.com').replace(/\/$/, '');
  }

  /**
   * Client-credentials token. Not cached: a sync runs on a schedule measured in hours, so the
   * complexity of a cache with expiry handling buys nothing and adds a way to use a stale token.
   */
  private async token(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      scope: `${this.baseUrl}/.default`,
      grant_type: 'client_credentials',
    });
    const res = await fetch(`${this.loginUrl}/${this.opts.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) {
      // The response body names the actual cause (wrong tenant, expired secret, missing consent),
      // and losing it turns a five-minute fix into an afternoon.
      throw new DirectoryError(`Graph token request failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new DirectoryError('Graph token response carried no access_token');
    return json.access_token;
  }

  /** Follow @odata.nextLink to the end. Graph pages at 100 by default. */
  private async getAll<T>(token: string, path: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | undefined = path.startsWith('http') ? path : `${this.baseUrl}/v1.0${path}`;
    while (url) {
      const res: Response = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
      if (!res.ok) {
        throw new DirectoryError(`Graph GET ${url} failed (${res.status}): ${await res.text()}`);
      }
      const page = (await res.json()) as GraphPage<T>;
      out.push(...page.value);
      url = page['@odata.nextLink'];
    }
    return out;
  }

  async fetch(): Promise<DirectorySnapshot> {
    const token = await this.token();

    const users = await this.getAll<GraphUser>(
      token,
      '/users?$select=id,displayName,jobTitle,mail,userPrincipalName,accountEnabled&$expand=manager($select=id)&$top=999',
    );

    let units: DirectoryUnit[] = [];
    const unitOfPerson = new Map<string, string>();

    if (!this.opts.forceManagerHierarchy) {
      const adminUnits = await this.getAll<GraphUnit>(
        token,
        '/directory/administrativeUnits?$select=id,displayName,description&$top=999',
      );
      if (adminUnits.length > 0) {
        units = adminUnits.map((u) => ({
          externalId: u.id,
          name: u.displayName ?? u.id,
          // Administrative units are flat in Entra. Any hierarchy has to come from naming, which
          // TierMapping.directorates matches on.
          parentExternalId: null,
          leadExternalId: null,
          path: u.displayName ?? u.id,
        }));
        for (const unit of adminUnits) {
          const members = await this.getAll<{ id: string }>(
            token,
            `/directory/administrativeUnits/${unit.id}/members?$select=id&$top=999`,
          );
          for (const member of members) unitOfPerson.set(member.id, unit.id);
        }
      }
    }

    if (units.length === 0) {
      // No administrative units (or forced): synthesize one unit per manager from the reporting
      // chain. Coarse, but it is the hierarchy most tenants actually maintain.
      const managerIds = new Set<string>();
      for (const user of users) if (user.manager?.id) managerIds.add(user.manager.id);
      const byId = new Map(users.map((u) => [u.id, u]));

      units = [...managerIds].map((id) => {
        const manager = byId.get(id);
        return {
          externalId: `mgr:${id}`,
          name: manager?.displayName ? `${manager.displayName}'s org` : `Org ${id.slice(0, 8)}`,
          parentExternalId: manager?.manager?.id ? `mgr:${manager.manager.id}` : null,
          leadExternalId: id,
          path: manager?.displayName ?? id,
        };
      });
      for (const user of users) {
        if (user.manager?.id) unitOfPerson.set(user.id, `mgr:${user.manager.id}`);
      }
    }

    const people: DirectoryPerson[] = users.map((u) => ({
      externalId: u.id,
      displayName: u.displayName ?? '',
      title: u.jobTitle ?? '',
      email: u.mail ?? u.userPrincipalName ?? null,
      managerExternalId: u.manager?.id ?? null,
      unitExternalId: unitOfPerson.get(u.id) ?? null,
      enabled: u.accountEnabled ?? true,
    }));

    return DirectorySnapshot.parse({
      units,
      people,
      fetchedAt: new Date().toISOString(),
      provider: 'graph',
    });
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      const token = await this.token();
      const res = await fetch(`${this.baseUrl}/v1.0/organization?$select=displayName`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
      if (!res.ok) return { ok: false, detail: `probe failed (${res.status})` };
      const json = (await res.json()) as { value?: Array<{ displayName?: string }> };
      return { ok: true, detail: `tenant: ${json.value?.[0]?.displayName ?? this.opts.tenantId}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
