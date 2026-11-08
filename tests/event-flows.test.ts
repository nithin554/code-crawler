import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { crawlProject } from "../src/crawler.js";
import { findEventFlows, getCallers } from "../src/graph/queries.js";
import { GraphStore } from "../src/graph/store.js";

const JAVA = path.join(__dirname, "fixtures", "java", "events");
const TYPESCRIPT = path.join(__dirname, "fixtures", "typescript", "events");

let spring: GraphStore;
let nest: GraphStore;

/** Every EMITS edge as `publisher -> listener`, with its interesting properties. */
function flows(store: GraphStore = spring): { pair: string; props: Record<string, unknown> }[] {
  return findEventFlows(store, { limit: 500 }).map((e) => ({
    pair: `${e.source.id} -> ${e.target.id}`,
    props: {
      ...(e.channel ? { channel: e.channel } : {}),
      ...(e.channelKind ? { channelKind: e.channelKind } : {}),
      ...(e.framework ? { framework: e.framework } : {}),
      ...(e.phase ? { phase: e.phase } : {}),
      ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
    },
  }));
}

function pairs(store: GraphStore = spring): string[] {
  return flows(store).map((f) => f.pair);
}

function propsOf(pair: string): Record<string, unknown> {
  return flows().find((f) => f.pair === pair)?.props ?? {};
}

beforeAll(async () => {
  spring = new GraphStore(":memory:", { maxDepth: 10 });
  spring.clearAll();
  await crawlProject(spring, JAVA, loadConfig().excludeDirs, {});

  nest = new GraphStore(":memory:", { maxDepth: 10 });
  nest.clearAll();
  await crawlProject(nest, TYPESCRIPT, loadConfig().excludeDirs, {});
});

afterAll(() => {
  spring.close();
  nest.close();
});

describe("Spring application events", () => {
  const PLACE = "com.acme.events.OrderPublisher#place";
  const ON_PLACED = "com.acme.notifications.OrderListeners#onPlaced";

  it("joins a published event to the listener that receives it", () => {
    expect(pairs()).toContain(`${PLACE} -> ${ON_PLACED}`);
  });

  it("infers the event type from a local variable's declared type", () => {
    expect(pairs()).toContain(
      "com.acme.events.OrderPublisher#cancel -> com.acme.notifications.OrderListeners#onCancelled"
    );
  });

  it("reports the channel a publication and its listener share", () => {
    expect(propsOf(`${PLACE} -> ${ON_PLACED}`)).toMatchObject({
      channel: "OrderPlaced",
      channelKind: "event-class",
      framework: "spring-event",
      confidence: 1,
    });
  });

  it("records the transaction phase that gates a listener", () => {
    const afterCommit = `${PLACE} -> com.acme.notifications.AuditListener#onPlaced`;
    const beforeCommit = `${PLACE} -> com.acme.notifications.AuditListener#beforeCommit`;
    expect(propsOf(afterCommit).phase).toBe("AFTER_COMMIT");
    expect(propsOf(beforeCommit).phase).toBe("BEFORE_COMMIT");
  });

  it("links one publication to every distinct listener on its channel", () => {
    expect(pairs().filter((p) => p.startsWith(`${PLACE} -> `))).toHaveLength(3);
  });
});

describe("Spring application event negatives", () => {
  it("does not link a listener for a different event type", () => {
    expect(pairs()).not.toContain(
      "com.acme.events.OrderPublisher#cancel -> com.acme.notifications.OrderListeners#onPlaced"
    );
  });

  it("does not guess the subtype dispatch of a supertype listener", () => {
    expect(pairs()).not.toContain(
      "com.acme.events.OrderPublisher#place -> com.acme.notifications.OrderListeners#onAny"
    );
  });

  it("invents no edge when the published value is a plain parameter", () => {
    expect(pairs().filter((p) => p.startsWith("com.acme.events.OrderPublisher#republish"))).toEqual(
      []
    );
  });

  it("does not read `String.valueOf` as a publication", () => {
    // `PUBLISHERS["valueOf"]` would otherwise resolve through Object.prototype.
    expect(pairs().filter((p) => p.startsWith("com.acme.events.OrderPublisher#describe"))).toEqual(
      []
    );
  });

  it("keeps same-named events in different packages apart", () => {
    expect(pairs()).not.toContain(
      "com.acme.billing.InvoiceService#pay -> com.acme.legacy.InvoicePaid#onPaid"
    );
  });
});

describe("Spring messaging", () => {
  it("joins a Kafka topic producer to its listener", () => {
    expect(pairs()).toContain(
      "com.acme.messaging.OrderMessaging#publishOrder -> com.acme.messaging.OrderConsumers#consumeOrder"
    );
  });

  it("joins a JMS destination producer to its listener", () => {
    expect(pairs()).toContain(
      "com.acme.messaging.OrderMessaging#publishInvoice -> com.acme.messaging.OrderConsumers#consumeInvoice"
    );
  });

  it("tags a topic with its broker and a lower confidence than an event type", () => {
    expect(
      propsOf(
        "com.acme.messaging.OrderMessaging#publishOrder -> com.acme.messaging.OrderConsumers#consumeOrder"
      )
    ).toMatchObject({
      channel: "orders",
      channelKind: "topic",
      framework: "spring-kafka",
      confidence: 0.85,
    });
  });

  it("does not link a topic nobody consumes", () => {
    expect(
      pairs().filter((p) => p.startsWith("com.acme.messaging.OrderMessaging#publishPayments"))
    ).toEqual([]);
  });

  it("does not link a topic that is only known at run time", () => {
    expect(
      pairs().filter((p) => p.startsWith("com.acme.messaging.OrderMessaging#publishDynamic"))
    ).toEqual([]);
  });
});

describe("NestJS events", () => {
  const PLACE = "src.orders.service.OrdersService#place";
  const HANDLE = "src.notifications.listener.NotificationsListener#handlePlaced";

  it("joins an emitted channel to its @OnEvent handler", () => {
    expect(pairs(nest)).toContain(`${PLACE} -> ${HANDLE}`);
    const props = flows(nest).find((f) => f.pair === `${PLACE} -> ${HANDLE}`)?.props ?? {};
    expect(props).toMatchObject({
      channel: "order.placed",
      channelKind: "topic",
      framework: "nestjs-events",
    });
  });

  it("does not link an unsubscribed channel", () => {
    expect(
      pairs(nest).filter((p) => p.startsWith("src.orders.service.OrdersService#ship"))
    ).toEqual([]);
  });

  it("does not link a channel passed in as a parameter", () => {
    expect(pairs(nest).filter((p) => p.startsWith("src.orders.service.OrdersService#raw"))).toEqual(
      []
    );
  });
});

describe("event edges in traversal", () => {
  const LISTENER = "com.acme.notifications.OrderListeners#onPlaced";
  const PUBLISHER = "com.acme.events.OrderPublisher#place";

  it("counts a publisher as a caller of the listener it feeds", () => {
    const result = getCallers(spring, LISTENER, { transitive: false });
    expect(result?.callers.some((c) => c.caller.id === PUBLISHER)).toBe(true);
  });

  it("drops event edges when they are excluded", () => {
    const result = getCallers(spring, LISTENER, { transitive: false, includeEvents: false });
    expect(result?.callers.some((c) => c.caller.id === PUBLISHER)).toBe(false);
  });

  it("echoes the event policy in the response", () => {
    expect(getCallers(spring, LISTENER, { transitive: false })?.edgesFollowed).toContain("EMITS");
    expect(
      getCallers(spring, LISTENER, { transitive: false, includeEvents: false })?.edgesFollowed
    ).not.toContain("EMITS");
  });
});

describe("event edges survive an incremental crawl", () => {
  let temp: string;
  let incremental: GraphStore;

  const pairsIn = (): string[] => pairs(incremental).sort();

  beforeAll(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "codecrawler-events-"));
    fs.cpSync(JAVA, temp, { recursive: true });
    incremental = new GraphStore(":memory:", { maxDepth: 10 });
    incremental.clearAll();
    await crawlProject(incremental, temp, loadConfig().excludeDirs, {});
  });

  afterAll(() => {
    incremental.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it("adds a publisher's outbound edge when a listener appears later", async () => {
    const publisher = "com.acme.messaging.OrderMessaging#publishPayments";
    expect(pairsIn().filter((p) => p.startsWith(`${publisher} -> `))).toEqual([]);

    const listener = path.join(temp, "com", "acme", "messaging", "PaymentConsumers.java");
    fs.writeFileSync(
      listener,
      [
        "package com.acme.messaging;",
        "import org.springframework.kafka.annotation.KafkaListener;",
        "public class PaymentConsumers {",
        '  @KafkaListener(topics = "payments")',
        "  public void consumePayment(String payload) {}",
        "}",
        "",
      ].join("\n")
    );
    await crawlProject(incremental, temp, loadConfig().excludeDirs, {});

    expect(pairsIn()).toContain(
      `${publisher} -> com.acme.messaging.PaymentConsumers#consumePayment`
    );
  });

  it("removes the edge when the listener file is deleted", async () => {
    const publisher = "com.acme.messaging.OrderMessaging#publishPayments";
    fs.rmSync(path.join(temp, "com", "acme", "messaging", "PaymentConsumers.java"));
    await crawlProject(incremental, temp, loadConfig().excludeDirs, {});

    expect(pairsIn().filter((p) => p.startsWith(`${publisher} -> `))).toEqual([]);
  });

  it("keeps the untouched pairs stable across crawls", async () => {
    const before = pairsIn();
    const stats = await crawlProject(incremental, temp, loadConfig().excludeDirs, {});
    expect(stats.filesUnchanged).toBeGreaterThan(0);
    expect(pairsIn()).toEqual(before);
  });
});
