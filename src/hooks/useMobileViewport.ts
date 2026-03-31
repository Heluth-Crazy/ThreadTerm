import { useEffect, useState } from 'react';

const getIsMobileViewport = (breakpoint: number): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.innerWidth < breakpoint;
};

export function useMobileViewport(breakpoint = 1024): boolean {
  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(() =>
    getIsMobileViewport(breakpoint),
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const updateViewportMode = () => {
      setIsMobileViewport(getIsMobileViewport(breakpoint));
    };

    updateViewportMode();
    window.addEventListener('resize', updateViewportMode);
    window.addEventListener('orientationchange', updateViewportMode);

    return () => {
      window.removeEventListener('resize', updateViewportMode);
      window.removeEventListener('orientationchange', updateViewportMode);
    };
  }, [breakpoint]);

  return isMobileViewport;
}

