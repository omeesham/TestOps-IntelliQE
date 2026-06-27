import { useState, useEffect, useRef } from 'react';

/**
 * Animated number counter hook.
 * Smoothly animates from 0 to target value using ease-out cubic easing.
 */
export function useAnimatedCounter(
  target: number,
  duration = 800,
  decimals = 0,
): number {
  const [current, setCurrent] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (target === 0) {
      // Reset via rAF rather than a synchronous setState in the effect body.
      rafRef.current = requestAnimationFrame(() => setCurrent(0));
      return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    }

    const start = performance.now();
    const from = 0;

    const animate = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = from + (target - from) * eased;

      if (decimals > 0) {
        setCurrent(parseFloat(value.toFixed(decimals)));
      } else {
        setCurrent(Math.round(value));
      }

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration, decimals]);

  return current;
}
