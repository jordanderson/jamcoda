import { useCallback, useEffect, useState } from 'react';

const SOUNDFONT_CACHE_NAME = 'jamcoda-soundfont-cache-v2';
const SW_SCRIPT_NAME = '/soundfont-cache-sw.js';

interface SoundfontCacheStatus {
  isSupported: boolean;
  isRegistered: boolean;
  cachedAssetCount: number;
  isChecking: boolean;
  refresh: () => Promise<void>;
}

export function useSoundfontCacheStatus(): SoundfontCacheStatus {
  const [isSupported, setIsSupported] = useState(true);
  const [isRegistered, setIsRegistered] = useState(false);
  const [cachedAssetCount, setCachedAssetCount] = useState(0);
  const [isChecking, setIsChecking] = useState(true);

  const refresh = useCallback(async () => {
    if (typeof window === 'undefined') return;
    const supported = ('serviceWorker' in navigator) && ('caches' in window);
    setIsSupported(supported);

    if (!supported) {
      setIsRegistered(false);
      setCachedAssetCount(0);
      setIsChecking(false);
      return;
    }

    setIsChecking(true);
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      const hasSoundfontWorker = registrations.some((registration) => {
        const scriptUrl = (
          registration.active?.scriptURL
          || registration.waiting?.scriptURL
          || registration.installing?.scriptURL
          || ''
        );
        return scriptUrl.includes(SW_SCRIPT_NAME);
      });

      const cache = await caches.open(SOUNDFONT_CACHE_NAME);
      const requests = await cache.keys();

      setIsRegistered(hasSoundfontWorker);
      setCachedAssetCount(requests.length);
    } catch (error) {
      console.warn('Failed to read soundfont cache status:', error);
      setIsRegistered(false);
      setCachedAssetCount(0);
    } finally {
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    isSupported,
    isRegistered,
    cachedAssetCount,
    isChecking,
    refresh
  };
}
