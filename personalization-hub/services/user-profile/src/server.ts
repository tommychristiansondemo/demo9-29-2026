import { createApp } from "./app";
import { initSchema } from "./db";

const PORT = Number(process.env.PORT || 8080);

async function main() {
  try {
    await initSchema();
    // eslint-disable-next-line no-console
    console.log("schema initialized");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("schema init failed (health checks will retry):", err);
  }
  const app = createApp();
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`user-profile service listening on ${PORT}`);
  });
}

main();
