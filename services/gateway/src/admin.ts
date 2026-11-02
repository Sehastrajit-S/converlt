// Admin CLI, working on the gateway's database directly (DATABASE_URL, or the SQLite file in CONVERLT_DATA_DIR).
//   node src/admin.ts add-user <email> [credits] [name]
//   node src/admin.ts grant <email> <credits> [note]
//   node src/admin.ts rotate-token <email>
//   node src/admin.ts users
import { loadConfig } from "./config.ts";
import { openStore, toMicro } from "./db.ts";

const [cmd, ...args] = process.argv.slice(2);
const store = await openStore(loadConfig());

function need(v: string | undefined, what: string): string {
  if (!v) {
    console.error(`Missing ${what}`);
    process.exit(2);
  }
  return v;
}

switch (cmd) {
  case "add-user": {
    const email = need(args[0], "email");
    if (await store.userByEmail(email)) {
      console.error("A user with that email exists");
      process.exit(1);
    }
    const { user, token } = await store.createUser(email, args[2] ?? "");
    const credits = Number(args[1] ?? 0);
    if (credits > 0) await store.addEntry(user.id, "grant", toMicro(credits), "Welcome credits");
    console.log(`Created ${user.email} with ${credits} credits.\nToken (shown once): ${token}`);
    break;
  }
  case "grant": {
    const user = await store.userByEmail(need(args[0], "email"));
    if (!user) throw new Error("No such user");
    const credits = Number(need(args[1], "credits"));
    await store.addEntry(user.id, credits >= 0 ? "grant" : "adjust", toMicro(credits), args[2] ?? "Credits added");
    console.log(`${user.email}: balance ${((await store.balanceMicro(user.id)) / 1e6).toFixed(2)} credits`);
    break;
  }
  case "rotate-token": {
    const user = await store.userByEmail(need(args[0], "email"));
    if (!user) throw new Error("No such user");
    console.log(`New token for ${user.email} (shown once): ${await store.rotateToken(user.id)}`);
    break;
  }
  case "users":
    for (const u of await store.listUsers()) console.log(`${u.email}\t${((await store.balanceMicro(u.id)) / 1e6).toFixed(2)} credits`);
    break;
  default:
    console.log("Usage: node src/admin.ts add-user <email> [credits] [name] | grant <email> <credits> [note] | rotate-token <email> | users");
    process.exit(cmd ? 2 : 0);
}
