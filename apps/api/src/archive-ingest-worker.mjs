import { register } from "tsx/esm/api";

register();
await import("./archive-ingest-worker.ts");
