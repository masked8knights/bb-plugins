import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = process.env.BB_PLUGIN_SDK_ROOT
  ? process.env.BB_PLUGIN_SDK_ROOT
  : fileURLToPath(new URL("../../../bb/packages/plugin-sdk", import.meta.url));

export default {
  resolve: {
    alias: [
      { find: /^@bb\/plugin-sdk\/testing$/, replacement: join(sdkRoot, "dist/testing/index.js") },
      { find: /^@bb\/plugin-sdk$/, replacement: join(sdkRoot, "dist/index.js") },
    ],
  },
  test: {
    include: ["test/**/*.test.mts"],
    environment: "node",
  },
};
