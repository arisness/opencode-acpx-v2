import { createServerPlugin } from "./server.js";
import { createOpenCode2Setup } from "./server-v2.js";

const plugin = {
  id: "opencode-acpx-v2",
  server: createServerPlugin(),
  setup: createOpenCode2Setup(),
};

export default plugin;
