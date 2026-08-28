/**
 * Turn the capture child's host-wide stream key into one device capability.
 *
 * The result must live in the DOM because a direct `<img>`/fetch URL cannot
 * carry our private header. Putting the key itself there made every simulator
 * pixel route equivalent. HMAC keeps the child and server stateless while
 * making a copied URL useful for exactly one UDID; the raw child independently
 * derives the same value before it lets the request reach pixel middleware.
 */
import { createHmac } from "node:crypto";

export function deriveStreamCapability(streamKey: string, udid: string): string {
  return createHmac("sha256", streamKey).update(udid, "utf8").digest("base64url");
}
