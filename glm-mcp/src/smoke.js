#!/usr/bin/env node
// smoke.js -- quick offline + online sanity check. Run: npm run smoke
// Offline checks always run. The live API call runs only if a key is present.
import "./loadEnv.js";
import { isPeak, chinaHour, resolveModel, recommend, estimateCost } from "./router.js";
import { glmMessage, config } from "./glmClient.js";

console.log("=== GLM MCP smoke test ===");
console.log("base_url:", config.BASE_URL);
console.log("api_key_loaded:", config.hasKey);
console.log("china_hour:", chinaHour(), "peak_now:", isPeak());
console.log("auto model now:", resolveModel("auto"));
console.log(
  "recommend(frontend/low):",
  JSON.stringify(recommend({ taskType: "frontend", complexity: "low" }))
);
console.log(
  "recommend(architecture/high):",
  JSON.stringify(recommend({ taskType: "architecture", complexity: "high" }))
);
console.log("recommend(sensitive):", JSON.stringify(recommend({ sensitive: true })));
console.log("est cost glm-5.2 (1k in / 2k out):", "$" + estimateCost("glm-5.2", 1000, 2000));

if (!config.hasKey) {
  console.log("\nNo API key -> skipping live call. Offline checks passed.");
  process.exit(0);
}

console.log("\nLive call to GLM…");
try {
  const { text, usage } = await glmMessage({
    model: resolveModel("auto"),
    messages: [{ role: "user", content: "Reply with exactly: GLM_OK" }],
    maxTokens: 32,
  });
  console.log("response:", text);
  console.log("usage:", JSON.stringify(usage));
  console.log(text.includes("GLM_OK") ? "\n✅ Live call OK." : "\n⚠️ Live call returned unexpected text.");
} catch (e) {
  console.error("\n❌ Live call failed:", e.message);
  process.exit(1);
}
