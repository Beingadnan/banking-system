"use server";

import { cookies } from "next/headers";
import { ObjectId } from "mongodb";
import bcrypt from "bcryptjs";
import { getDb } from "../mongodb";
import { COOKIE_NAME, signSessionToken, verifySessionToken } from "../session";
import { encryptId, extractCustomerIdFromUrl, parseStringify } from "../utils";
import {
  CountryCode,
  ProcessorTokenCreateRequest,
  ProcessorTokenCreateRequestProcessorEnum,
  Products,
} from "plaid";

import { plaidClient } from "@/lib/plaid";
import { revalidatePath } from "next/cache";
import { addFundingSource, createDwollaCustomer } from "./dwolla.actions";

function sessionCookieOptions() {
  return {
    path: "/" as const,
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 7,
  };
}

function serializeUser(doc: Record<string, unknown> | null) {
  if (!doc || !doc._id) return null;
  const id = (doc._id as ObjectId).toString();
  const { _id, passwordHash: _pw, ...rest } = doc;
  return {
    ...rest,
    $id: id,
    userId: typeof rest.userId === "string" ? rest.userId : id,
  };
}

function serializeBank(doc: Record<string, unknown> | null) {
  if (!doc || !doc._id) return null;
  const id = (doc._id as ObjectId).toString();
  const { _id, ...rest } = doc;
  const ownerId = String(rest.userId ?? "");
  return {
    ...rest,
    $id: id,
    userId: { $id: ownerId },
  };
}

function parseObjectId(id: string): ObjectId | null {
  if (!ObjectId.isValid(id)) return null;
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

export const getUserInfo = async ({ userId }: getUserInfoProps) => {
  try {
    const db = await getDb();
    const oid = parseObjectId(userId);
    if (!oid) return undefined;

    const doc = await db.collection("users").findOne({ _id: oid });
    return parseStringify(serializeUser(doc as Record<string, unknown>));
  } catch (error) {
    console.log(error);
  }
};

export const signIn = async ({ email, password }: signInProps) => {
  try {
    const db = await getDb();
    const userDoc = await db
      .collection("users")
      .findOne({ email: email.toLowerCase() });

    if (
      !userDoc ||
      !(await bcrypt.compare(password, userDoc.passwordHash as string))
    ) {
      console.error("Invalid email or password");
      return;
    }

    const id = (userDoc._id as ObjectId).toString();
    const token = await signSessionToken(id);
    cookies().set(COOKIE_NAME, token, sessionCookieOptions());

    const user = await getUserInfo({ userId: id });
    return parseStringify(user);
  } catch (error) {
    console.error("Error", error);
  }
};

export const signUp = async ({ password, ...userData }: SignUpParams) => {
  const { email, firstName, lastName } = userData;

  try {
    const db = await getDb();
    const emailNorm = email.toLowerCase();
    const existing = await db.collection("users").findOne({ email: emailNorm });
    if (existing) {
      console.error("Email already registered");
      return;
    }

    const dwollaCustomerUrl = await createDwollaCustomer({
      ...userData,
      type: "personal",
    });

    if (!dwollaCustomerUrl) throw new Error("Error creating Dwolla customer");

    const dwollaCustomerId = extractCustomerIdFromUrl(dwollaCustomerUrl);
    const passwordHash = await bcrypt.hash(password, 12);

    const insertDoc = {
      ...userData,
      email: emailNorm,
      passwordHash,
      dwollaCustomerId,
      dwollaCustomerUrl,
    };

    const result = await db.collection("users").insertOne(insertDoc);
    const newUserId = result.insertedId.toString();

    const token = await signSessionToken(newUserId);
    cookies().set(COOKIE_NAME, token, sessionCookieOptions());

    const user = await getUserInfo({ userId: newUserId });
    return parseStringify(user);
  } catch (error) {
    console.error("Error", error);
  }
};

export async function getLoggedInUser() {
  try {
    const token = cookies().get(COOKIE_NAME)?.value;
    if (!token) return null;

    const userId = await verifySessionToken(token);
    if (!userId) return null;

    const user = await getUserInfo({ userId });
    return parseStringify(user);
  } catch (error) {
    console.log(error);
    return null;
  }
}

export const logoutAccount = async () => {
  try {
    cookies().delete(COOKIE_NAME);
  } catch (error) {
    return null;
  }
};

export const createLinkToken = async (user: User) => {
  try {
    const tokenParams = {
      user: {
        client_user_id: user.$id,
      },
      client_name: `${user.firstName} ${user.lastName}`,
      products: ["auth"] as Products[],
      language: "en",
      country_codes: ["US"] as CountryCode[],
    };

    const response = await plaidClient.linkTokenCreate(tokenParams);

    return parseStringify({ linkToken: response.data.link_token });
  } catch (error) {
    console.log(error);
  }
};

export const createBankAccount = async ({
  userId,
  bankId,
  accountId,
  accessToken,
  fundingSourceUrl,
  shareableId,
}: createBankAccountProps) => {
  try {
    const db = await getDb();
    const doc = {
      userId,
      bankId,
      accountId,
      accessToken,
      fundingSourceUrl,
      shareableId,
      createdAt: new Date(),
    };

    const result = await db.collection("banks").insertOne(doc);
    const inserted = await db.collection("banks").findOne({
      _id: result.insertedId,
    });

    return parseStringify(
      serializeBank(inserted as Record<string, unknown> | null)
    );
  } catch (error) {
    console.log(error);
  }
};

export const exchangePublicToken = async ({
  publicToken,
  user,
}: exchangePublicTokenProps) => {
  try {
    const response = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken,
    });

    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;

    const accountsResponse = await plaidClient.accountsGet({
      access_token: accessToken,
    });

    const accountData = accountsResponse.data.accounts[0];

    const request: ProcessorTokenCreateRequest = {
      access_token: accessToken,
      account_id: accountData.account_id,
      processor: "dwolla" as ProcessorTokenCreateRequestProcessorEnum,
    };

    const processorTokenResponse =
      await plaidClient.processorTokenCreate(request);
    const processorToken = processorTokenResponse.data.processor_token;

    const fundingSourceUrl = await addFundingSource({
      dwollaCustomerId: user.dwollaCustomerId,
      processorToken,
      bankName: accountData.name,
    });

    if (!fundingSourceUrl) throw Error;

    await createBankAccount({
      userId: user.$id,
      bankId: itemId,
      accountId: accountData.account_id,
      accessToken,
      fundingSourceUrl,
      shareableId: encryptId(accountData.account_id),
    });

    revalidatePath("/");

    return parseStringify({
      publicTokenExchange: "complete",
    });
  } catch (error) {
    console.error("An error occurred while creating exchanging token:", error);
  }
};

export const getBanks = async ({ userId }: getBanksProps) => {
  try {
    const db = await getDb();
    const cursor = db.collection("banks").find({ userId });
    const docs = await cursor.toArray();

    const banks = docs.map((d) =>
      serializeBank(d as unknown as Record<string, unknown>)
    );
    return parseStringify(banks);
  } catch (error) {
    console.log(error);
  }
};

export const getBank = async ({ documentId }: getBankProps) => {
  try {
    const db = await getDb();
    const oid = parseObjectId(documentId);
    if (!oid) return undefined;

    const bank = await db.collection("banks").findOne({ _id: oid });
    return parseStringify(
      serializeBank(bank as Record<string, unknown> | null)
    );
  } catch (error) {
    console.log(error);
  }
};

export const getBankByAccountId = async ({
  accountId,
}: getBankByAccountIdProps) => {
  try {
    const db = await getDb();
    const banks = await db
      .collection("banks")
      .find({ accountId })
      .limit(2)
      .toArray();

    if (banks.length !== 1) return null;

    return parseStringify(
      serializeBank(banks[0] as unknown as Record<string, unknown>)
    );
  } catch (error) {
    console.log(error);
  }
};
