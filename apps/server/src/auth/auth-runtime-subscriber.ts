import type { FuturesReadStatus } from "../../../../packages/shared/src/protocol.js";
import type { EventBus } from "../realtime/event-bus.js";
import type { FuturesReadService } from "../futures/futures-read-service.js";
import type { AutoLiveOrchestrator } from "../kcex-live/auto-live-orchestrator.js";
import type { AuthRecoveryController } from "./auth-recovery-controller.js";

export interface AuthRuntimeSubscriberOptions {
  events: EventBus;
  futuresRead: Pick<FuturesReadService, "start" | "stop">;
  getAutoLive: () => AutoLiveOrchestrator | undefined;
  getAuthRecovery: () => AuthRecoveryController | undefined;
}

/**
 * Applies auth state changes to the read-only browser and runtime Auto Live
 * gate. OTP is only conservative when it is not owned by an active bounded
 * recovery episode; recovery OTP must leave PAUSED_AUTH intact.
 */
export function subscribeAuthRuntime(options: AuthRuntimeSubscriberOptions): () => void {
  return options.events.subscribe((event) => {
    if (event.type !== "auth.state") return;
    const autoLive = options.getAutoLive();
    if (event.payload.status === "AUTHENTICATED") {
      options.futuresRead.start();
    } else {
      if (event.payload.status === "AUTH_UNKNOWN" || event.payload.status === "MANUAL_CHALLENGE") {
        autoLive?.requireManualAction();
      } else if (event.payload.status === "OTP_REQUIRED") {
        if (options.getAuthRecovery()?.isRecoveryActive()) autoLive?.pauseForAuth();
        else autoLive?.requireManualAction();
      }
      const stopStatus: FuturesReadStatus | undefined = event.payload.status === "AUTH_UNKNOWN" ? "UNKNOWN"
        : event.payload.status === "MANUAL_CHALLENGE" ? "MANUAL_CHALLENGE"
          : event.payload.status === "SESSION_LOST" ? "SESSION_LOST" : undefined;
      options.futuresRead.stop(stopStatus);
    }
  });
}
