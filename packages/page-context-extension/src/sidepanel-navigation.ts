/**
 * Navigation and iframe management utilities for the side panel.
 */

import { runtimeGetUrl, tabsCreate } from './extension-api';

/** Normalizes a URL by prepending http:// if no scheme is present. */
export function normalizeUrl(url: string): string {
  return /^https?:\/\//.test(url) ? url : `http://${url}`;
}

/** Creates the bound message handler for iframe communication. */
export function createBoundMessageHandler(): (e: MessageEvent) => void {
  return (e: MessageEvent): void => {
    if (!e.data?.type) return;

    switch (e.data.type) {
      case 'sidepanel-action':
        if (e.data.action === 'open-opencode') {
          void tabsCreate({ url: 'opencode://v1/web?port=22338' });
        }
        break;
      // sidepanel-probe messages are informational — loader handles its own UI
    }
  };
}

/** Builds the loader iframe URL for embedding a target page. */
export function buildLoaderUrl(currentUrl: string): string {
  return runtimeGetUrl('loader.html') + '#' + currentUrl;
}
