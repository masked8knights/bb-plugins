import * as React from "react";
import { cn } from "../../lib/utils";

export type IconName =
  | "ChevronLeft"
  | "Loading"
  | "Paperclip"
  | "MessageCirclePlus"
  | "Copy"
  | "Download"
  | "Trash2"
  | "File"
  | "Plus";

const paths: Record<IconName, string> = {
  ChevronLeft: "M15 18 9 12l6-6",
  Paperclip: "m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48",
  MessageCirclePlus: "M12 20H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h14a3 3 0 0 1 3 3v7m-5 9v-6m-3 3h6",
  Copy: "M9 9h10v10H9z M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  Download: "M12 3v12m0 0 4-4m-4 4-4-4M5 21h14",
  Trash2: "M3 6h18m-2 0v14H5V6m3 0V3h8v3M10 11v6m4-6v6",
  File: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6",
  Plus: "M12 5v14M5 12h14",
  Loading: "M12 3a9 9 0 1 0 9 9",
};

export function Icon({ name, className, ...props }: { name: IconName; className?: string; "aria-hidden"?: boolean | "true" | "false" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(name === "Loading" && "animate-spin", className)}
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
