import { supabase } from "@/integrations/supabase/client";
import { compressImage } from "@/lib/image";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_AVATAR_EXTS = ["jpg", "jpeg", "png", "webp"];

/**
 * Uploads a profile photo into avatars/<userId>/ and stores its path; returns the public URL.
 * Errors: image_too_large, image_bad_type (i18n keys under profile.errors), or the storage / database error.
 */
export async function uploadAvatar(userId: string, file: File): Promise<string> {
  // Validate content — client-side is UX, but it blocks obvious mistakes before
  // the upload. Storage RLS + bucket config are the real enforcement.
  if (file.size > MAX_AVATAR_BYTES) {
    throw new Error("image_too_large");
  }
  const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
  const typeOk = file.type ? ALLOWED_AVATAR_TYPES.includes(file.type) : false;
  const extOk = ALLOWED_AVATAR_EXTS.includes(ext);
  if (!typeOk && !extOk) {
    throw new Error("image_bad_type");
  }
  // Re-encode as JPEG on the device: smaller upload and no EXIF (e.g. GPS location).
  const body = await compressImage(file, 800);
  const isJpeg = body.type === "image/jpeg";
  const path = `${userId}/avatar-${Date.now()}.${isJpeg ? "jpg" : ext}`;
  const { error } = await supabase.storage.from("avatars").upload(path, body, {
    upsert: false,
    contentType: isJpeg ? "image/jpeg" : file.type || "image/jpeg",
  });
  if (error) throw error;
  const { error: upErr } = await supabase.from("profiles").update({ avatar_path: path }).eq("id", userId);
  if (upErr) throw upErr;
  // The old photos would stay public by URL: remove them (best effort — the new one is already in place).
  await removeAvatars(userId, path).catch(() => undefined);
  return avatarUrl(path)!;
}

/** Remove every photo in your folder except `keep` (all of them when deleting your account). */
export async function removeAvatars(userId: string, keep?: string) {
  const { data, error } = await supabase.storage.from("avatars").list(userId, { limit: 100 });
  if (error) throw error;
  const paths = (data ?? []).map((f) => `${userId}/${f.name}`).filter((p) => p !== keep);
  if (!paths.length) return;
  const { error: rmErr } = await supabase.storage.from("avatars").remove(paths);
  if (rmErr) throw rmErr;
}

/** Public URL of an avatar (the bucket is public by URL but can't be listed). */
export function avatarUrl(path: string | null | undefined): string | null {
  return path ? supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl : null;
}
