import type { FrameworkModule } from "./types.js";

/** Generic event-listener decorators with no single owning library. */
export const events: FrameworkModule = {
  name: "events",
  entryPoints: {
    on_event: { kind: "event" },
    listener: { kind: "event" },
    receiver: { kind: "event" },
    on_message: { kind: "event" },
    subscribe: { kind: "event" },
    handler: { kind: "event" },
  },
};
