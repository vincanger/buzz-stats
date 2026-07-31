import type { Event, EventTemplate } from "nostr-tools/pure";

// NIP-07 surface, provided by an extension or the nostr-login shim.
declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>;
      signEvent(template: EventTemplate): Promise<Event>;
    };
  }
}

export {};
