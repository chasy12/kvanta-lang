import { defineConfig } from "vite";

export default defineConfig({
  // Relative paths, so the build works from any URL (GitHub Pages, a fork, a custom domain).
  base: "./",
  test: {
    include: ['tests/**/*.test.js'],
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.js"],
  },
});
