import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const packageNodeModules = join(packageRoot, "node_modules");

export default {
  resolve: {
    alias: [
      { find: /^react$/, replacement: join(packageNodeModules, "react/index.js") },
      {
        find: /^react\/jsx-runtime$/,
        replacement: join(packageNodeModules, "react/jsx-runtime.js"),
      },
      {
        find: /^react-dom$/,
        replacement: join(packageNodeModules, "react-dom/index.js"),
      },
      {
        find: /^@testing-library\/react$/,
        replacement: join(packageNodeModules, "@testing-library/react/dist/index.js"),
      },
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
