import { useEffect, useState } from 'react';

export function useMediaScheme(): 'light' | 'dark' {
  const [scheme, setScheme] = useState<'light' | 'dark'>(() =>
    window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setScheme(mq.matches ? 'light' : 'dark');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return scheme;
}

export function useWideLayout(): boolean {
  const [wide, setWide] = useState(() => window.innerWidth >= 720);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 720);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return wide;
}
