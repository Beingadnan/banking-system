import { MongoClient, Db } from "mongodb";

declare global {
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

let prodClientPromise: Promise<MongoClient> | undefined;

async function getMongoClient(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      'Missing MONGODB_URI. Add it to your environment (e.g. .env.local).'
    );
  }

  if (process.env.NODE_ENV === "development") {
    if (!global._mongoClientPromise) {
      global._mongoClientPromise = new MongoClient(uri).connect();
    }
    return global._mongoClientPromise;
  }

  if (!prodClientPromise) {
    prodClientPromise = new MongoClient(uri).connect();
  }
  return prodClientPromise;
}

let indexesEnsured = false;

async function ensureIndexes(db: Db) {
  if (indexesEnsured) return;
  await db.collection("users").createIndex({ email: 1 }, { unique: true });
  indexesEnsured = true;
}

export async function getDb(): Promise<Db> {
  const mongoClient = await getMongoClient();
  const dbName = process.env.MONGODB_DB || "banking";
  const db = mongoClient.db(dbName);
  await ensureIndexes(db);
  return db;
}
