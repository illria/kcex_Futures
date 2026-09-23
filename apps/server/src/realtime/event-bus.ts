import { parseDashboardEvent, type DashboardEvent } from "../../../../packages/shared/src/protocol.js";

export type EventListener = (event: DashboardEvent) => void;

export class EventBus {
  private readonly listeners = new Set<EventListener>();

  publish(value: unknown): DashboardEvent {
    const event = parseDashboardEvent(value);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
