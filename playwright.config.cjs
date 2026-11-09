const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: ".\\tests\\browser",
  timeout: 60000,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
