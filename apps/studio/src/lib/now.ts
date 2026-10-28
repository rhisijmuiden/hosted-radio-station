import { useEffect, useState } from 'react';

/** The time now, re-rendering every `ms`: the autodj poll returns the same object while a track plays, so clocks tick on their own. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
