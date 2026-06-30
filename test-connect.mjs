import { MongoClient } from "mongodb";
import "dotenv/config";
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
try {
  await client.connect();
  await client.db("molfi").command({ ping: 1 });
  console.log("MONGO OK: connected + ping succeeded");
  const dbs = await client.db().admin().listDatabases().catch(() => null);
  if (dbs) console.log("databases:", dbs.databases.map(d => d.name).join(", "));
} catch (e) {
  console.log("MONGO FAIL:", e.message.slice(0, 200));
} finally {
  await client.close();
}
