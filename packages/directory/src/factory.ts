/**
 * Choose an adapter from configuration.
 *
 * The one place that knows the provider names, so adding a directory type later means adding a
 * case here and nothing else. Config is validated up front rather than at first sync: a missing
 * bind password should fail at boot with a clear message, not at 3am when the cron fires.
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { DirectoryError, type DirectorySource } from './port.js';
import { CsvDirectorySource } from './adapters/csv.js';
import { LdapDirectorySource } from './adapters/ldap.js';
import { GraphDirectorySource } from './adapters/graph.js';

export const DirectoryConfig = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('none') }),
  z.object({
    provider: z.literal('ldap'),
    url: z.string().min(1),
    bindDn: z.string().min(1),
    bindPassword: z.string().min(1),
    baseDn: z.string().min(1),
    userFilter: z.string().optional(),
    unitFilter: z.string().optional(),
    tlsCaFile: z.string().optional(),
  }),
  z.object({
    provider: z.literal('graph'),
    tenantId: z.string().min(1),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    baseUrl: z.string().optional(),
    loginUrl: z.string().optional(),
  }),
  z.object({ provider: z.literal('csv'), path: z.string().min(1) }),
]);
export type DirectoryConfig = z.infer<typeof DirectoryConfig>;

/** Read the config out of the environment, with the failure naming the variable at fault. */
export function directoryConfigFromEnv(env: Record<string, string | undefined>): DirectoryConfig {
  const provider = (env.DIRECTORY_PROVIDER ?? 'none').toLowerCase();
  const need = (key: string): string => {
    const value = env[key];
    if (!value) throw new DirectoryError(`${key} is required when DIRECTORY_PROVIDER=${provider}`);
    return value;
  };

  switch (provider) {
    case 'none':
      return { provider: 'none' };
    case 'ldap':
      return DirectoryConfig.parse({
        provider: 'ldap',
        url: need('DIRECTORY_LDAP_URL'),
        bindDn: need('DIRECTORY_LDAP_BIND_DN'),
        bindPassword: need('DIRECTORY_LDAP_BIND_PASSWORD'),
        baseDn: need('DIRECTORY_LDAP_BASE_DN'),
        userFilter: env.DIRECTORY_LDAP_USER_FILTER || undefined,
        unitFilter: env.DIRECTORY_LDAP_GROUP_FILTER || undefined,
        tlsCaFile: env.DIRECTORY_LDAP_TLS_CA_FILE || undefined,
      });
    case 'graph':
      return DirectoryConfig.parse({
        provider: 'graph',
        tenantId: need('DIRECTORY_GRAPH_TENANT_ID'),
        clientId: need('DIRECTORY_GRAPH_CLIENT_ID'),
        clientSecret: need('DIRECTORY_GRAPH_CLIENT_SECRET'),
        baseUrl: env.DIRECTORY_GRAPH_BASE_URL || undefined,
        loginUrl: env.DIRECTORY_GRAPH_LOGIN_URL || undefined,
      });
    case 'csv':
      return DirectoryConfig.parse({ provider: 'csv', path: need('DIRECTORY_CSV_PATH') });
    default:
      throw new DirectoryError(
        `unknown DIRECTORY_PROVIDER "${provider}" — expected one of: none, ldap, graph, csv`,
      );
  }
}

/** Build the adapter. Returns null when directory sync is switched off. */
export async function createDirectorySource(
  config: DirectoryConfig,
): Promise<DirectorySource | null> {
  switch (config.provider) {
    case 'none':
      return null;
    case 'csv':
      return new CsvDirectorySource({ text: await readFile(config.path, 'utf8') });
    case 'ldap':
      return new LdapDirectorySource({
        url: config.url,
        bindDn: config.bindDn,
        bindPassword: config.bindPassword,
        baseDn: config.baseDn,
        userFilter: config.userFilter,
        unitFilter: config.unitFilter,
        tlsCaCertificate: config.tlsCaFile
          ? await readFile(config.tlsCaFile, 'utf8')
          : undefined,
      });
    case 'graph':
      return new GraphDirectorySource({
        tenantId: config.tenantId,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        baseUrl: config.baseUrl,
        loginUrl: config.loginUrl,
      });
  }
}
