export type Ds4LifecyclePhase =
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "error";

export type Ds4LifecycleNoticeKind = "loading" | "success" | "info" | "error";

export interface Ds4LifecycleNotice {
  kind: Ds4LifecycleNoticeKind;
  title: string;
  description: string;
}

export function ds4LifecyclePhase(status: {
  state: string;
  healthOk?: boolean;
  hasError?: boolean;
}): Ds4LifecyclePhase | null {
  if (status.state === "stopping") return "stopping";
  if (status.state === "stopped") return status.hasError ? "error" : "stopped";
  if (status.state === "crashed" || status.state === "exited") return "error";
  if (status.state === "starting") return "starting";
  if (status.state === "running") {
    return status.healthOk === true ? "ready" : "starting";
  }
  return null;
}

export function ds4LifecycleNotice(
  next: Ds4LifecyclePhase,
  previous: Ds4LifecyclePhase | null,
  options: { initial?: boolean; error?: string | null } = {},
): Ds4LifecycleNotice | null {
  if (next === previous) return null;
  if (options.initial && (next === "ready" || next === "stopped")) return null;

  switch (next) {
    case "starting":
      return {
        kind: "loading",
        title: "Starting DwarfStar…",
        description:
          "Loading the local inference server. The first response may take a moment.",
      };
    case "ready":
      return {
        kind: "success",
        title: "DwarfStar ready",
        description: "The local inference server is ready.",
      };
    case "stopping":
      return {
        kind: "loading",
        title: "Stopping DwarfStar…",
        description: "Releasing the local inference server.",
      };
    case "stopped":
      return {
        kind: "info",
        title: "DwarfStar stopped",
        description: "The local inference server is no longer running.",
      };
    case "error":
      return {
        kind: "error",
        title: "DwarfStar unavailable",
        description:
          options.error ?? "The local inference server exited unexpectedly.",
      };
  }
}
