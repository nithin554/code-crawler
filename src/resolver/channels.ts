import type { GraphEdge } from "../graph/schema.js";
import type { AnnotationInfo, MethodInfo, ParsedFile } from "../parser/language.js";

/**
 * Event and messaging wiring.
 *
 * A publication and a listener are two halves of one runtime call that no
 * source reference connects. Spring dispatches `publishEvent(new X())` to every
 * `@EventListener` that accepts `X`; Kafka delivers a produced topic record to
 * every `@KafkaListener` subscribed to it. The static graph sees two unrelated
 * methods, so a trace stops at the publication and the listener looks uncalled.
 *
 * This module joins the halves by channel and emits `EMITS` edges from
 * publisher to listener. The join is project-wide: the producer and the
 * consumer can live in different modules and in different indexed projects,
 * which is what makes the edge useful in a monorepo.
 *
 * Confidence describes target identity only — how sure the analyser is that
 * *this* listener receives *that* publication. It deliberately says nothing
 * about whether the listener fires: a `@TransactionalEventListener` is certainly
 * the listener for its event even though it only runs when a transaction
 * commits, so the phase is recorded as a property instead of being folded into
 * the number.
 */

/** Confidence when both sides name the same fully-qualified symbol. */
const CONFIDENCE_QUALIFIED = 1;
/** Confidence when the two sites share only a simple event-class name. */
const CONFIDENCE_SIMPLE_NAME = 0.85;

interface ListenerSpec {
  /** Join on the event type the listener accepts, or on a literal channel name. */
  channelKind: "event-class" | "topic";
  /** Annotation attribute holding the channel. Absent means a class literal or the parameter type. */
  attribute?: string;
  /** Framework label recorded on the edge. */
  framework: string;
  /** True for listeners that only run inside a transaction, e.g. `@TransactionalEventListener`. */
  transactional?: boolean;
}

/** Annotations that register a method as a receiver. */
const LISTENERS: Record<string, ListenerSpec> = {
  EventListener: { channelKind: "event-class", attribute: "classes", framework: "spring-event" },
  TransactionalEventListener: {
    channelKind: "event-class",
    attribute: "classes",
    framework: "spring-event",
    transactional: true,
  },
  // `@KafkaListener(topics = "orders")`; the bare form takes its topics from a
  // bean expression, which is not resolvable and produces no edge.
  KafkaListener: { channelKind: "topic", attribute: "topics", framework: "spring-kafka" },
  JmsListener: { channelKind: "topic", attribute: "destination", framework: "spring-jms" },
  RabbitListener: { channelKind: "topic", attribute: "queues", framework: "spring-amqp" },
  SqsListener: { channelKind: "topic", attribute: "value", framework: "spring-sqs" },
  OnEvent: { channelKind: "topic", attribute: "value", framework: "nestjs-events" },
};

interface PublisherSpec {
  channelKind: "event-class" | "topic";
  framework: string;
  /**
   * Receiver types on which this method name means "send". `send` and
   * `emit` are far too common to match by name alone, so a call only counts as
   * a publication when the receiver's declared type says it is a template.
   */
  receiverTypes?: string[];
}

/** Methods that publish, and what their first argument means. */
const PUBLISHERS: Record<string, PublisherSpec> = {
  publishEvent: { channelKind: "event-class", framework: "spring-event" },
  send: {
    channelKind: "topic",
    framework: "spring-kafka",
    receiverTypes: ["KafkaTemplate", "KafkaOperations"],
  },
  convertAndSend: {
    channelKind: "topic",
    framework: "spring-jms",
    receiverTypes: ["JmsTemplate"],
  },
  emit: {
    channelKind: "topic",
    framework: "nestjs-events",
    receiverTypes: ["EventEmitter2", "EventEmitter"],
  },
};

interface Endpoint {
  role: "publish" | "listen";
  channelKind: "event-class" | "topic";
  /** Simple event-class name or literal topic/destination. */
  channel: string;
  /** Fully-qualified channel when both sides resolved one. */
  qualified?: string;
  framework: string;
  ownerId: string;
  line: number;
  /** Transaction phase for a phase-aware listener. */
  phase?: string;
}

/** Map lookup that never resolves through `Object.prototype`. */
function lookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** String literals inside a raw annotation argument or expression. */
function stringLiterals(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    if (match[1] !== undefined) out.push(match[1]);
  }
  return out;
}

/** True for a value that is only known at run time (`${app.topic}`). */
function isPlaceholder(value: string): boolean {
  return value.includes("${") || value.includes("#{");
}

/**
 * Literal values of one annotation attribute.
 *
 * Attributes are matched positionally inside the raw argument text because the
 * parser records arguments as written, not as a tree: `topics = "a"` and
 * `{"/x", "y"}` both arrive as plain strings.
 */
function attributeLiterals(annotation: AnnotationInfo, attribute: string): string[] {
  const pattern = new RegExp(`(?:^|[,\\s(])${attribute}\\s*=`);
  const source = annotation.arguments.find((a) => pattern.test(` ${a}`));
  return source ? stringLiterals(source).filter((v) => !isPlaceholder(v)) : [];
}

/** Class literals (`OrderPlaced.class`) inside one annotation attribute. */
function attributeClasses(annotation: AnnotationInfo, attribute: string): string[] {
  const pattern = new RegExp(`(?:^|[,\\s(])${attribute}\\s*=`);
  const source = annotation.arguments.find((a) => pattern.test(` ${a}`));
  if (!source) return [];
  const out: string[] = [];
  for (const match of source.matchAll(/([\w.$]+)\.class/g)) {
    if (match[1] !== undefined) out.push(match[1]);
  }
  return out;
}

/**
 * Resolve a simple or qualified type name against the file's own scope.
 *
 * `scopeTypes` covers imports and types declared in the file. A same-package
 * sibling lives in neither, so fall back to the file's package: Java resolves
 * those without an import whenever no import shadows the name.
 */
function qualify(parsed: ParsedFile, name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  const simple = trimmed.includes(".") ? (trimmed.split(".").pop() ?? trimmed) : trimmed;
  const scoped = parsed.scopeTypes?.get(simple);
  if (scoped) return scoped;
  if (trimmed.includes(".")) return trimmed;
  return parsed.packageName ? `${parsed.packageName}.${simple}` : undefined;
}

/** Enum constant assigned to an attribute (`phase = TransactionPhase.X`). */
function attributeConstant(annotation: AnnotationInfo, attribute: string): string | undefined {
  const pattern = new RegExp(`(?:^|[,\\s(])${attribute}\\s*=\\s*(?:[\\w$.]+\\.)?([A-Z][A-Z0-9_]*)`);
  const source = annotation.arguments.find((a) => pattern.test(` ${a}`));
  if (!source) return undefined;
  return pattern.exec(` ${source}`)?.[1];
}

/** The base type of a declared parameter, e.g. `List<Order>` -> `List`. */
function baseType(text: string): string {
  return text.split("<")[0]?.replace(/\[\]$/, "").trim() ?? "";
}

/** Declared type of a receiver expression, from a field or a local variable. */
function receiverType(parsed: ParsedFile, receiver: string, enclosingMethodId: string): string {
  const name = receiver.replace(/^this\./, "");
  const local = parsed.localsByMethod.get(enclosingMethodId)?.get(name);
  if (local) return baseType(local);
  const field = parsed.fields.find((f) => f.name === name);
  return field ? baseType(field.type) : "";
}

/** Listeners declared by one file's methods. */
function listenersOf(parsed: ParsedFile): Endpoint[] {
  const out: Endpoint[] = [];
  for (const method of parsed.methods) {
    if (method.isConstructor) continue;
    for (const annotation of method.annotations) {
      const spec = lookup(LISTENERS, annotation.name);
      if (!spec) continue;
      const phase = spec.transactional
        ? (attributeLiterals(annotation, "phase")[0] ??
          attributeConstant(annotation, "phase") ??
          "AFTER_COMMIT")
        : undefined;
      if (spec.channelKind === "event-class") {
        const declared = spec.attribute ? attributeClasses(annotation, spec.attribute) : [];
        const accepted = declared.length > 0 ? declared : eventParameterOf(method);
        for (const name of accepted) {
          const channel = baseType(name);
          if (!channel) continue;
          out.push({
            role: "listen",
            channelKind: "event-class",
            channel,
            qualified: qualify(parsed, channel),
            framework: spec.framework,
            ownerId: method.id,
            line: annotation.line,
            ...(phase ? { phase } : {}),
          });
        }
        continue;
      }
      const channels = literalChannelsOf(annotation, spec.attribute);
      for (const channel of channels) {
        out.push({
          role: "listen",
          channelKind: "topic",
          channel,
          framework: spec.framework,
          ownerId: method.id,
          line: annotation.line,
        });
      }
    }
  }
  return out;
}

/** Event type a listener method accepts, ignoring framework parameter types. */
function eventParameterOf(method: MethodInfo): string[] {
  return method.params.map((p) => baseType(p.type)).filter((t) => t.length > 0);
}

/**
 * Literal channels named by a listener annotation.
 *
 * A declared attribute (`topics = "orders"`) wins; otherwise the annotation's
 * first positional argument is the channel (`@SqsListener("orders")`).
 */
function literalChannelsOf(annotation: AnnotationInfo, attribute?: string): string[] {
  const named = attribute ? attributeLiterals(annotation, attribute) : [];
  if (named.length > 0) return named;
  const positional = annotation.arguments.find((a) => !a.includes("="));
  return positional ? stringLiterals(positional).filter((v) => !isPlaceholder(v)) : [];
}

/** Publications made from one file's call sites. */
function publicationsOf(parsed: ParsedFile): Endpoint[] {
  const out: Endpoint[] = [];
  for (const site of parsed.callSites) {
    const spec = lookup(PUBLISHERS, site.name);
    if (!spec) continue;
    if (spec.receiverTypes && site.receiver) {
      const type = receiverType(parsed, site.receiver, site.enclosingMethodId);
      if (!spec.receiverTypes.includes(type)) continue;
    } else if (spec.receiverTypes) {
      continue;
    }
    const first = site.argumentTexts[0];
    if (!first) continue;
    const channel = channelOf(parsed, spec.channelKind, first, site.enclosingMethodId);
    if (!channel) continue;
    out.push({
      role: "publish",
      channelKind: spec.channelKind,
      channel: channel.name,
      qualified: channel.qualified,
      framework: spec.framework,
      ownerId: site.enclosingMethodId,
      line: site.line,
    });
  }
  return out;
}

/**
 * Channel a publish-site argument names.
 *
 * Only a literal is accepted. `new X()` and a local variable of a known type
 * are resolved; anything computed at run time produces no edge, because
 * guessing which event was published would be worse than reporting nothing.
 */
function channelOf(
  parsed: ParsedFile,
  kind: "event-class" | "topic",
  argument: string,
  enclosingMethodId: string
): { name: string; qualified?: string } | null {
  if (kind === "topic") {
    const literals = stringLiterals(argument).filter((v) => !isPlaceholder(v));
    const first = literals[0];
    return first === undefined ? null : { name: first };
  }
  const constructed = /^\s*new\s+([\w.$]+)/.exec(argument);
  const raw = constructed?.[1] ?? (/^[\w$]+$/.test(argument.trim()) ? argument.trim() : "");
  if (!raw) return null;
  const name = baseType(raw);
  if (!name) return null;
  if (constructed) return { name, qualified: qualify(parsed, name) };
  const localType = parsed.localsByMethod.get(enclosingMethodId)?.get(name);
  if (!localType) return null;
  const localName = baseType(localType);
  if (!localName) return null;
  return { name: localName, qualified: qualify(parsed, localName) };
}

/**
 * Join publications to listeners across the whole indexed project.
 *
 * The join is on the channel, so it also links a producer to a consumer in
 * another indexed project that uses the same topic. Every edge is rebuilt from
 * scratch on each crawl: a listener added in one file changes the inbound set of
 * a publisher in another, so per-file persistence would go stale.
 */
export function buildChannelEdges(
  parsedFiles: ParsedFile[],
  allNodeIds: Set<string>
): { edges: GraphEdge[]; count: number } {
  const publishers: Endpoint[] = [];
  const byChannel = new Map<string, Endpoint[]>();
  for (const parsed of parsedFiles) {
    publishers.push(...publicationsOf(parsed));
    for (const endpoint of listenersOf(parsed)) {
      const key = `${endpoint.channelKind}:${endpoint.channel}`;
      const bucket = byChannel.get(key);
      if (bucket) bucket.push(endpoint);
      else byChannel.set(key, [endpoint]);
    }
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const publisher of publishers) {
    const key = `${publisher.channelKind}:${publisher.channel}`;
    for (const listener of byChannel.get(key) ?? []) {
      if (listener.ownerId === publisher.ownerId) continue;
      // Two distinct classes that happen to share a simple name are different
      // events: when both sides resolved a qualified name and they differ, the
      // listener does not receive this publication.
      if (publisher.qualified && listener.qualified && publisher.qualified !== listener.qualified) {
        continue;
      }
      if (!allNodeIds.has(publisher.ownerId) || !allNodeIds.has(listener.ownerId)) continue;
      const dedupe = `${publisher.ownerId}>${listener.ownerId}>${publisher.channel}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      edges.push({
        source: publisher.ownerId,
        target: listener.ownerId,
        kind: "EMITS",
        properties: {
          line: publisher.line,
          channel: publisher.channel,
          channelKind: publisher.channelKind,
          framework: listener.framework,
          confidence:
            publisher.qualified && listener.qualified
              ? CONFIDENCE_QUALIFIED
              : CONFIDENCE_SIMPLE_NAME,
          ...(listener.phase ? { phase: listener.phase } : {}),
        },
      });
    }
  }
  return { edges, count: edges.length };
}
