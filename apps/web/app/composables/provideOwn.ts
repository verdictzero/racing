/**
 * `provide`, visible to the providing component's own setup as well.
 *
 * Vue's inject() walks the PARENT chain, so a component can never inject what it provided itself.
 * The workspace shell both provides the session and the shell bridge AND calls composables that
 * inject them (the rail actions, the document helpers, the Final-lock toast) — which then throw, or
 * silently get the no-op fallback. Recording the value against the current instance as well lets
 * those same-component calls resolve, without making every composable take its dependencies as
 * arguments.
 */
import type { ComponentInternalInstance, InjectionKey } from 'vue';

const own = new WeakMap<ComponentInternalInstance, Map<unknown, unknown>>();

export function provideOwn<T>(key: InjectionKey<T> | string, value: T): void {
  provide(key, value);
  const inst = getCurrentInstance();
  if (!inst) return;
  const map = own.get(inst) ?? new Map<unknown, unknown>();
  map.set(key, value);
  own.set(inst, map);
}

export function injectOwn<T>(key: InjectionKey<T> | string, fallback: T): T {
  const inst = getCurrentInstance();
  const mine = inst ? own.get(inst)?.get(key) : undefined;
  if (mine !== undefined) return mine as T;
  return inject(key, fallback) as T;
}
