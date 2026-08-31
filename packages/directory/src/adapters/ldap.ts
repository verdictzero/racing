/**
 * LDAP / Active Directory adapter.
 *
 * Reads organizational units and users, and turns AD's conventions into the neutral snapshot the
 * reconciler consumes. The AD-specific knowledge is all here so nothing downstream has to know
 * what a userAccountControl bit is.
 *
 * WHAT IT KNOWS ABOUT AD SPECIFICALLY
 *   - objectGUID is the stable identity. sAMAccountName and userPrincipalName both get reassigned
 *     when people leave, and a DN changes the moment someone moves OU — using either as the
 *     external id would silently re-key half the roster after a reorganization, which is the one
 *     failure this whole design exists to prevent.
 *   - Disabled accounts are flagged by bit 2 of userAccountControl. They are read and marked
 *     rather than filtered out, so a departure shows up as a reportable change instead of a
 *     person quietly disappearing.
 *   - Nesting comes from the DN, so the parent OU is derivable without a second query.
 *
 * THE DEPENDENCY IS LOADED LAZILY on purpose. A deployment that syncs from Graph or from a CSV
 * should not have to install an LDAP client, and an air-gapped bundle should not have to vendor
 * one it will never call.
 */

import {
  DirectoryError,
  DirectorySnapshot,
  type DirectoryPerson,
  type DirectorySource,
  type DirectoryUnit,
} from '../port.js';

export interface LdapAdapterOptions {
  /** ldap://host:389 or ldaps://host:636. Prefer ldaps in any real deployment. */
  readonly url: string;
  readonly bindDn: string;
  readonly bindPassword: string;
  readonly baseDn: string;
  readonly userFilter?: string;
  readonly unitFilter?: string;
  /** PEM CA bundle for ldaps. Verification is never disabled — see the note in connect(). */
  readonly tlsCaCertificate?: string;
  readonly timeoutMs?: number;
  /** AD caps a page at 1000 by default; the adapter pages through regardless. */
  readonly pageSize?: number;
}

/** Default AD user filter: real people, excluding disabled accounts' noise but keeping the flag. */
const DEFAULT_USER_FILTER = '(&(objectCategory=person)(objectClass=user))';
const DEFAULT_UNIT_FILTER = '(objectClass=organizationalUnit)';

/** Bit 2 of userAccountControl is ACCOUNTDISABLE. */
const UAC_ACCOUNTDISABLE = 0x2;

/** Minimal shape of the ldapts client, so this module compiles without the dependency present. */
interface LdapEntry {
  dn: string;
  [key: string]: unknown;
}
interface LdapClient {
  bind(dn: string, password: string): Promise<void>;
  unbind(): Promise<void>;
  search(
    base: string,
    options: Record<string, unknown>,
  ): Promise<{ searchEntries: LdapEntry[] }>;
}

/** The parent OU's DN: everything after the first component. */
export function parentDn(dn: string): string | null {
  // Split on unescaped commas — an OU name may legitimately contain "\,".
  const parts = dn.match(/(?:[^,\\]|\\.)+/g);
  if (!parts || parts.length <= 1) return null;
  const rest = parts.slice(1).join(',');
  // Stop at the domain root: DC components are not organizational units.
  return /^(?:DC=)/i.test(parts[1] ?? '') ? null : rest;
}

/** AD hands objectGUID back as a Buffer; normalize it to a stable hex string. */
export function guidToString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value instanceof Uint8Array) {
    return Array.from(value)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return null;
}

function first(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

export class LdapDirectorySource implements DirectorySource {
  readonly name = 'ldap';

  constructor(private readonly opts: LdapAdapterOptions) {
    if (!opts.url) throw new DirectoryError('DIRECTORY_LDAP_URL is required');
    if (!opts.baseDn) throw new DirectoryError('DIRECTORY_LDAP_BASE_DN is required');
  }

  private async connect(): Promise<LdapClient> {
    // Loaded here rather than at module scope so a Graph-only or CSV-only deployment never needs
    // the package installed at all.
    // The specifier is held in a variable rather than written inline so TypeScript does not try
    // to resolve it at build time: an install without ldapts must still typecheck and ship.
    const LDAP_MODULE = 'ldapts';
    let ldapts: { Client: new (opts: Record<string, unknown>) => LdapClient };
    try {
      ldapts = (await import(/* @vite-ignore */ LDAP_MODULE)) as unknown as typeof ldapts;
    } catch {
      throw new DirectoryError(
        'DIRECTORY_PROVIDER=ldap needs the "ldapts" package. Run: pnpm add ldapts --filter @raci/directory',
      );
    }

    const tlsOptions: Record<string, unknown> = {};
    if (this.opts.tlsCaCertificate) tlsOptions.ca = this.opts.tlsCaCertificate;
    // There is deliberately no "insecure" or "rejectUnauthorized: false" option. A directory bind
    // sends service credentials, and an unverified TLS session hands them to whoever answered.
    // A deployment with a private CA supplies the CA bundle instead.

    const client = new ldapts.Client({
      url: this.opts.url,
      timeout: this.opts.timeoutMs ?? 30_000,
      connectTimeout: this.opts.timeoutMs ?? 30_000,
      tlsOptions,
    });

    try {
      await client.bind(this.opts.bindDn, this.opts.bindPassword);
    } catch (err) {
      throw new DirectoryError(`LDAP bind failed for ${this.opts.bindDn}`, err);
    }
    return client;
  }

  async fetch(): Promise<DirectorySnapshot> {
    const client = await this.connect();
    try {
      const unitResult = await client.search(this.opts.baseDn, {
        scope: 'sub',
        filter: this.opts.unitFilter ?? DEFAULT_UNIT_FILTER,
        attributes: ['objectGUID', 'ou', 'name', 'description', 'managedBy', 'distinguishedName'],
        paged: { pageSize: this.opts.pageSize ?? 1000 },
      });

      const unitByDn = new Map<string, DirectoryUnit>();
      for (const entry of unitResult.searchEntries) {
        const guid = guidToString(entry.objectGUID);
        if (!guid) continue; // no stable identity — cannot be reconciled across runs
        unitByDn.set(entry.dn.toLowerCase(), {
          externalId: guid,
          name: first(entry.ou) || first(entry.name) || entry.dn,
          parentExternalId: null, // resolved below, once every DN is known
          leadExternalId: first(entry.managedBy) || null,
          path: entry.dn,
        });
      }

      // Second pass: DN → parent GUID, now that the whole set is indexed.
      const units: DirectoryUnit[] = [];
      for (const [dn, unit] of unitByDn) {
        const parent = parentDn(dn);
        const parentUnit = parent ? unitByDn.get(parent.toLowerCase()) : undefined;
        units.push({ ...unit, parentExternalId: parentUnit?.externalId ?? null });
      }

      const userResult = await client.search(this.opts.baseDn, {
        scope: 'sub',
        filter: this.opts.userFilter ?? DEFAULT_USER_FILTER,
        attributes: [
          'objectGUID',
          'displayName',
          'cn',
          'title',
          'mail',
          'manager',
          'userAccountControl',
          'distinguishedName',
        ],
        paged: { pageSize: this.opts.pageSize ?? 1000 },
      });

      // managedBy and manager are DNs; the reconciler wants GUIDs, so index by DN to translate.
      const guidByDn = new Map<string, string>();
      for (const entry of userResult.searchEntries) {
        const guid = guidToString(entry.objectGUID);
        if (guid) guidByDn.set(entry.dn.toLowerCase(), guid);
      }

      const people: DirectoryPerson[] = [];
      for (const entry of userResult.searchEntries) {
        const guid = guidToString(entry.objectGUID);
        if (!guid) continue;
        const uac = Number(first(entry.userAccountControl) || '0');
        const managerDn = first(entry.manager).toLowerCase();
        const ou = parentDn(entry.dn);
        people.push({
          externalId: guid,
          displayName: first(entry.displayName) || first(entry.cn),
          title: first(entry.title),
          email: first(entry.mail) || null,
          managerExternalId: managerDn ? (guidByDn.get(managerDn) ?? null) : null,
          unitExternalId: ou ? (unitByDn.get(ou.toLowerCase())?.externalId ?? null) : null,
          enabled: (uac & UAC_ACCOUNTDISABLE) === 0,
        });
      }

      // Translate each unit's managedBy DN into a GUID now that people are indexed.
      const resolved = units.map((u) =>
        u.leadExternalId
          ? { ...u, leadExternalId: guidByDn.get(u.leadExternalId.toLowerCase()) ?? null }
          : u,
      );

      return DirectorySnapshot.parse({
        units: resolved,
        people,
        fetchedAt: new Date().toISOString(),
        provider: 'ldap',
      });
    } finally {
      await client.unbind().catch(() => {
        /* the read already succeeded; a failed unbind must not mask it */
      });
    }
  }

  async probe(): Promise<{ ok: boolean; detail: string }> {
    try {
      const client = await this.connect();
      await client.unbind();
      return { ok: true, detail: `bound to ${this.opts.url} as ${this.opts.bindDn}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
