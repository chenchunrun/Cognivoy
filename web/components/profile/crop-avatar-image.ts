/**
 * Client-side avatar preprocessing: center-crop to a square and downscale
 * before upload. Canvas re-encode also strips EXIF metadata.
 */

export const AVATAR_OUTPUT_SIZE = 256;
// Decoding a huge photo just to throw away most pixels wastes memory; the
// server enforces its own 1 MB cap on the (much smaller) cropped result.
export const MAX_AVATAR_SOURCE_BYTES = 20 * 1024 * 1024;

export async function cropToSquareBlob(file: File): Promise<Blob> {
  let source: CanvasImageSource;
  let width: number;
  let height: number;
  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    source = bitmap;
    width = bitmap.width;
    height = bitmap.height;
  } catch {
    // Older Safari: fall back to decoding via an <img> element.
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Could not decode image"));
        el.src = url;
      });
      source = image;
      width = image.naturalWidth;
      height = image.naturalHeight;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (!width || !height) throw new Error("Could not decode image");

  const side = Math.min(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_OUTPUT_SIZE;
  canvas.height = AVATAR_OUTPUT_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not decode image");
  ctx.drawImage(
    source,
    (width - side) / 2,
    (height - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_OUTPUT_SIZE,
    AVATAR_OUTPUT_SIZE,
  );
  // Release the decoder/GPU memory now instead of waiting for GC.
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
    source.close();
  }

  const toBlob = (type: string, quality?: number) =>
    new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, type, quality),
    );
  // WebP keeps avatars tiny; browsers without a WebP encoder return null.
  const blob =
    (await toBlob("image/webp", 0.85)) ?? (await toBlob("image/png"));
  if (!blob) throw new Error("Could not encode image");
  return blob;
}
