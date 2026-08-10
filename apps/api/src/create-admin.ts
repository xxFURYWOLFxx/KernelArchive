import { provision_admin } from "./auth-store";

const username = process.env.KERNELARCHIVE_ADMIN_USERNAME?.trim();
const password = process.env.KERNELARCHIVE_ADMIN_PASSWORD ?? "";

if (!username || !password) {
  throw new Error("KERNELARCHIVE_ADMIN_USERNAME and KERNELARCHIVE_ADMIN_PASSWORD are required.");
}

const user = await provision_admin(username, password);
process.stdout.write(`${JSON.stringify({ created: true, user })}\n`);
