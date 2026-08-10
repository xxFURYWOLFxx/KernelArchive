import { register } from "tsx/esm/api";

register();
await import("./archive-read-worker.ts");
