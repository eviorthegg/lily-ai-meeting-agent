import { ga4MeasurementId } from '@/config/env';

/**
 * GA4 loader.
 *
 * The requirement is that GA4 does not LOAD before consent, which is stronger
 * than not firing. There is no gtag snippet in index.html and no import of a
 * Google package anywhere in the bundle — the tag exists only as the string
 * below, and the only thing that turns it into a network request is
 * `loadGa4()`, called from exactly one place: the consent subscriber in
 * ./index.ts, after `analytics` is granted.
 *
 * Consequence worth stating: a visitor who never accepts analytics makes zero
 * requests to any Google domain, and `window.gtag` never exists.
 */

let injected = false;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export function isLoaded(): boolean {
  return injected;
}

export function loadGa4(): void {
  if (injected) return;
  if (ga4MeasurementId === null) return; // prod-only, and only when configured
  if (typeof document === 'undefined') return;

  injected = true;

  window.dataLayer = window.dataLayer ?? [];
  window.gtag = function gtag(...args: unknown[]) {
    window.dataLayer?.push(args);
  };

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ga4MeasurementId)}`;
  document.head.appendChild(script);

  window.gtag('js', new Date());
  window.gtag('config', ga4MeasurementId, {
    // We send page_view ourselves on route change; the SPA's first automatic one
    // would otherwise double-count the landing page.
    send_page_view: false,
    anonymize_ip: true,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
}

export function ga4PageView(path: string): void {
  window.gtag?.('event', 'page_view', { page_path: path });
}

export function ga4Event(name: string, props: Record<string, string | number | boolean>): void {
  window.gtag?.('event', name, props);
}
