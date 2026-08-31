/**
 * Readiness.
 *
 * Reports each dependency separately, because "the app is down" and "the directory server is
 * refusing binds" call for completely different people at 3am.
 */
import { checkConnection } from '@raci/db';

export default defineEventHandler(async (event) => {
  const [database, directory, idp] = await Promise.all([
    checkConnection(useDb()).catch((e: unknown) => ({ ok: false, detail: String(e) })),
    useDirectory()
      .then((d) => (d?.probe ? d.probe() : { ok: true, detail: d ? 'no probe' : 'disabled' }))
      .catch((e: unknown) => ({ ok: false, detail: String(e) })),
    useOidc()
      .discover()
      .then((d) => ({ ok: true, detail: d.issuer }))
      .catch((e: unknown) => ({ ok: false, detail: String(e) })),
  ]);

  const ok = database.ok && idp.ok;
  // 503 rather than 200-with-a-flag, so a load balancer takes the instance out of rotation.
  setResponseStatus(event, ok ? 200 : 503);
  return { ok, database, directory, idp };
});
