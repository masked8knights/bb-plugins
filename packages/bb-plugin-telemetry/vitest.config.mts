import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The SDK is maintained in the sibling BB checkout in this workspace. The
// published SDK has the same dist/testing/app.js entrypoint.
const sdkRoot = process.env.BB_PLUGIN_SDK_ROOT
  ? process.env.BB_PLUGIN_SDK_ROOT
  : fileURLToPath(new URL("../../../bb/packages/plugin-sdk", import.meta.url));
const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const packageNodeModules = join(packageRoot, "node_modules");

export default {
  resolve: {
    alias: [
      { find: /^@bb\/plugin-sdk\/testing\/app$/, replacement: join(sdkRoot, "dist/testing/app.js") },
      { find: /^@bb\/plugin-sdk\/testing$/, replacement: join(sdkRoot, "dist/testing/index.js") },
      { find: /^@bb\/plugin-sdk\/app$/, replacement: join(sdkRoot, "dist/app.js") },
      { find: /^@bb\/plugin-sdk$/, replacement: join(sdkRoot, "dist/index.js") },
      { find: /^react$/, replacement: join(packageNodeModules, "react/index.js") },
      { find: /^react\/jsx-runtime$/, replacement: join(packageNodeModules, "react/jsx-runtime.js") },
      { find: /^react\/jsx-dev-runtime$/, replacement: join(packageNodeModules, "react/jsx-dev-runtime.js") },
      { find: /^react-dom$/, replacement: join(packageNodeModules, "react-dom/index.js") },
      { find: /^react-dom\/client$/, replacement: join(packageNodeModules, "react-dom/client.js") },
      { find: /^@testing-library\/react$/, replacement: join(packageNodeModules, "@testing-library/react/dist/index.js") },
    ],
  },
  test: {
    environmentMatchGlobs: [
      ["**/*.test.tsx", "jsdom"],
      ["**/*.test.ts", "node"],
    ],
    include: ["**/*.test.ts", "**/*.test.tsx"],
    passWithNoTests: false,
  },
};
