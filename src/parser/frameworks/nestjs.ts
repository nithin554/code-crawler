import type { FrameworkModule } from "./types.js";

/**
 * NestJS: route/messaging/scheduler/event decorators, its injection decorators,
 * and the class decorators that make a class container-managed. The Angular
 * class decorators share this list because the parser labels both `nestjs`.
 */
export const nestjs: FrameworkModule = {
  name: "nestjs",
  evidence: ["@nestjs/"],
  entryPoints: {
    Get: { kind: "http", httpMethod: "GET" },
    Post: { kind: "http", httpMethod: "POST" },
    Put: { kind: "http", httpMethod: "PUT" },
    Delete: { kind: "http", httpMethod: "DELETE" },
    Patch: { kind: "http", httpMethod: "PATCH" },
    Head: { kind: "http", httpMethod: "HEAD" },
    Options: { kind: "http", httpMethod: "OPTIONS" },
    All: { kind: "http", httpMethod: "ALL" },
    MessagePattern: { kind: "messaging" },
    EventPattern: { kind: "messaging" },
    OnMessage: { kind: "messaging" },
    Cron: { kind: "scheduler" },
    Interval: { kind: "scheduler" },
    Timeout: { kind: "scheduler" },
    OnEvent: { kind: "event" },
    EventSubscriber: { kind: "event" },
    SubscribeMessage: { kind: "event" },
  },
  injections: {
    Inject: true,
    InjectRepository: true,
    InjectModel: true,
    InjectDataSource: true,
    /** Spring-style decorator accepted by the TS parser. */
    Autowired: "spring",
  },
  injectables: [
    "Injectable",
    "Controller",
    "Component",
    "Service",
    "Directive",
    "Pipe",
    "Guard",
    "Gateway",
    "Resolver",
    "Module",
  ],
};
