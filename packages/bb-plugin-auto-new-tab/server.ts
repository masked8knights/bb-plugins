// bb-plugin-auto-new-tab — a BB plugin backend entry.
//
// This plugin is frontend-only: the content script in app.tsx does all the
// work. The backend exists because BB plugins require a server entry.
import type { BbPluginApi } from "@bb/plugin-sdk";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");
}
