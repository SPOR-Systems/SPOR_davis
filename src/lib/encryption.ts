import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;

// Derive the secret key from the environment variable (or throw if missing)
function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY must be a 64-character (32-byte) hex string in the environment variables."
    );
  }
  return Buffer.from(key, "hex");
}

export function encryptText(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const salt = crypto.randomBytes(SALT_LENGTH);

  // We mix salt in just to make the cipher text more dynamic, though GCM provides authentication.
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  // Return formatted string: iv:salt:authTag:encryptedData
  return `${iv.toString("hex")}:${salt.toString("hex")}:${authTag.toString(
    "hex"
  )}:${encrypted}`;
}

export function decryptText(encryptedText: string): string {
  const parts = encryptedText.split(":");
  
  if (parts.length !== 4) {
    throw new Error("Invalid encrypted text format.");
  }

  const [ivHex, saltHex, authTagHex, encryptedHex] = parts;

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}
