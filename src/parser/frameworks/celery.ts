import type { FrameworkModule } from "./types.js";

/** Celery (and celery-beat) task and schedule decorators. */
export const celery: FrameworkModule = {
  name: "celery",
  evidence: ["celery"],
  entryPoints: {
    task: { kind: "messaging" },
    shared_task: { kind: "messaging" },
    celery_task: { kind: "messaging" },
    periodic_task: { kind: "messaging" },
    scheduled: { kind: "scheduler" },
    cron: { kind: "scheduler" },
    interval: { kind: "scheduler" },
  },
};
