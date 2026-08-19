// bb-plugin-ds4 — setup guidance for the demand-driven DwarfStar server.

import { definePluginApp, useSettings } from "@bb/plugin-sdk/app";

function SetupSection() {
  const { values, isLoading } = useSettings();
  const modelSelector =
    typeof values?.modelSelector === "string" ? values.modelSelector : "ds4/";
  const providerId =
    typeof values?.providerId === "string" && values.providerId
      ? values.providerId
      : "any provider";
  const idleTimeout =
    typeof values?.idleTimeoutSeconds === "string"
      ? values.idleTimeoutSeconds
      : "300";

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4 text-sm">
      <div>
        <p className="font-medium">Automatic local model lifecycle</p>
        <p className="mt-1 text-muted-foreground">
          Configure the DS4 checkout and model above, then choose the matching
          model in BB&apos;s model picker. DwarfStar starts when a turn uses that
          model and stops after the last matching turn has been idle.
        </p>
      </div>
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
        <div>
          <span className="block uppercase tracking-wide">Model selector</span>
          <code className="font-mono text-foreground">
            {isLoading ? "…" : modelSelector}
          </code>
        </div>
        <div>
          <span className="block uppercase tracking-wide">Provider filter</span>
          <code className="font-mono text-foreground">
            {isLoading ? "…" : providerId}
          </code>
        </div>
        <div>
          <span className="block uppercase tracking-wide">Idle grace</span>
          <code className="font-mono text-foreground">
            {isLoading ? "…" : `${idleTimeout}s`}
          </code>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        The selector defaults to <code className="font-mono">ds4/</code>, which
        matches <code className="font-mono">ds4/deepseek-v4-flash</code>.
        Leave the provider filter empty unless the same model id is used by
        more than one provider.
      </p>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "setup",
    title: "Automatic startup",
    description:
      "DwarfStar is managed on demand by the model selected in BB.",
    component: SetupSection,
  });
});
