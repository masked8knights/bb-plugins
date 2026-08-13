import * as React from "react";
import { cn } from "../../lib/utils";

/**
 * Compact page shell used by bb's operational plugin panels.
 * Keep the content width and gutters consistent with the native panels.
 */
export function PanelContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("mx-auto w-full max-w-6xl px-5 py-5 md:px-6", className)}
      {...props}
    />
  );
}
