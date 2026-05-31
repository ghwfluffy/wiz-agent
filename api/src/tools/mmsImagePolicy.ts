export type ImageArtifact = {
  bytes: Uint8Array;
  contentType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  metadataStripped: boolean;
};

export type ImageProcessor = {
  sanitize(input: {
    bytes: Uint8Array;
    contentType: string;
    maxWidth: number;
    maxHeight: number;
  }): Promise<ImageArtifact>;
};

export type MmsImagePolicyResult =
  | { ok: true; artifact: ImageArtifact }
  | { ok: false; reason: string };

export async function sanitizeImageForMms(options: {
  bytes: Uint8Array;
  contentType: string;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxWidth: number;
  maxHeight: number;
  processor: ImageProcessor;
}): Promise<MmsImagePolicyResult> {
  if (!["image/jpeg", "image/png"].includes(options.contentType)) {
    return { ok: false, reason: "unsupported_content_type" };
  }
  if (options.bytes.byteLength > options.maxInputBytes) {
    return { ok: false, reason: "input_too_large" };
  }
  const artifact = await options.processor.sanitize({
    bytes: options.bytes,
    contentType: options.contentType,
    maxWidth: options.maxWidth,
    maxHeight: options.maxHeight
  });
  if (!artifact.metadataStripped) {
    return { ok: false, reason: "metadata_not_stripped" };
  }
  if (artifact.bytes.byteLength > options.maxOutputBytes) {
    return { ok: false, reason: "output_too_large" };
  }
  if (artifact.width > options.maxWidth || artifact.height > options.maxHeight) {
    return { ok: false, reason: "dimensions_too_large" };
  }
  return { ok: true, artifact };
}
