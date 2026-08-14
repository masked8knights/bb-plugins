import type { ComposerCustomization, PluginComposerScope } from "@bb/plugin-sdk/app";

export function createExcalidrawComposerCustomization(
  run: (scope: PluginComposerScope) => void,
): ComposerCustomization {
  return {
    id: "excalidraw-attach",
    scopes: ["thread", "new-thread"],
    plusMenu: [
      {
        id: "excalidraw",
        label: "Excalidraw drawing",
        icon: "PenTool",
        description: "Attach a drawing to this conversation as an image",
        disabled: (view) => view.scope.kind !== "thread",
        run: ({ view }) => run(view.scope),
      },
    ],
  };
}
