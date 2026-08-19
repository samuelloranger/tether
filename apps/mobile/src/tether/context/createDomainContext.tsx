import { createContext, useContext } from 'react';

// One domain context per concern. `use<Domain>()` throws rather than handing back
// a partial default: a component that reads a domain outside its provider is a
// wiring bug, and a silent default would surface as an undefined field somewhere
// far away from the cause.
export function createDomainContext<T>(name: string) {
  const Context = createContext<T | null>(null);
  Context.displayName = `${name}Context`;
  function useDomain(): T {
    const value = useContext(Context);
    if (value === null) {
      throw new Error(`use${name}() must be called inside <${name}Provider>`);
    }
    return value;
  }
  return [Context.Provider, useDomain] as const;
}
