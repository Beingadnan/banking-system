"use server";

import { ObjectId } from "mongodb";
import { getDb } from "../mongodb";
import { parseStringify } from "../utils";

function serializeTransaction(doc: Record<string, unknown> | null) {
  if (!doc || !doc._id) return null;
  const id = (doc._id as ObjectId).toString();
  const { _id, createdAt, ...rest } = doc;
  return {
    ...rest,
    $id: id,
    $createdAt:
      createdAt instanceof Date
        ? createdAt.toISOString()
        : String(createdAt ?? ""),
  };
}

export const createTransaction = async (transaction: CreateTransactionProps) => {
  try {
    const db = await getDb();
    const doc = {
      channel: "online",
      category: "Transfer",
      ...transaction,
      createdAt: new Date(),
    };

    const result = await db.collection("transactions").insertOne(doc);
    const inserted = await db.collection("transactions").findOne({
      _id: result.insertedId,
    });

    return parseStringify(
      serializeTransaction(inserted as Record<string, unknown> | null)
    );
  } catch (error) {
    console.log(error);
  }
};

export const getTransactionsByBankId = async ({
  bankId,
}: getTransactionsByBankIdProps) => {
  try {
    const db = await getDb();
    const docs = await db
      .collection("transactions")
      .find({
        $or: [{ senderBankId: bankId }, { receiverBankId: bankId }],
      })
      .toArray();

    const documents = docs
      .map((d) => serializeTransaction(d as unknown as Record<string, unknown>))
      .filter(Boolean);

    return parseStringify({
      total: documents.length,
      documents,
    });
  } catch (error) {
    console.log(error);
  }
};
