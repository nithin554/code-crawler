import type { FrameworkModule } from "./types.js";

/** Spring: HTTP mappings, scheduling, events, and Spring messaging listeners. */
export const spring: FrameworkModule = {
  name: "spring",
  evidence: ["org.springframework"],
  entryPoints: {
    GetMapping: { kind: "http", httpMethod: "GET" },
    PostMapping: { kind: "http", httpMethod: "POST" },
    PutMapping: { kind: "http", httpMethod: "PUT" },
    DeleteMapping: { kind: "http", httpMethod: "DELETE" },
    PatchMapping: { kind: "http", httpMethod: "PATCH" },
    RequestMapping: { kind: "http", httpMethod: "ANY" },
    KafkaListener: { kind: "messaging" },
    RabbitListener: { kind: "messaging" },
    JmsListener: { kind: "messaging" },
    StreamListener: { kind: "messaging" },
    SqsListener: { kind: "messaging" },
    Scheduled: { kind: "scheduler" },
    EventListener: { kind: "event" },
    TransactionalEventListener: { kind: "event" },
  },
  injections: { Autowired: true, Value: true, Qualifier: true },
};
