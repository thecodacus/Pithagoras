import { ImageGenerationError, requestPicture, type GenerateOptions, type ImageEditingTarget } from "./image-generation.js";
import { MAX_EDIT_PICTURES, MAX_EDIT_TOTAL_BYTES, promptWith, type NativeSettings, type OutputFormat } from "./image-settings.js";
import { pictureSize } from "./picture-size.js";
import { pictureExt, pictureType } from "./prompt-images.js";
import { MAX_PICTURE_BYTES } from "./workspace-files.js";

/**
 * Changing a picture with the image endpoint the person set up: the same add-on
 * as generation (see image-generation.ts), asked for `images/edits` instead.
 *
 * The request is the OpenAI-style one — a multipart form with the picture, a
 * prompt and optionally a mask, and the model, size and output format when
 * there are some — and the answer is read as a generation's is, as `b64_json`
 * or `url`, with the same rules for where an address may lead, the same check
 * of the bytes and the same limits. Other request shapes are not translated.
 *
 * Several pictures are sent as `image[]`, once each in the order given, only to
 * an endpoint the person said takes them (see ImageEditingTarget.multiple); one
 * picture is always sent as `image`. The same request makes a new picture from
 * pictures used as references: the route does not tell the two apart, the
 * prompt does.
 *
 * What the agent's tool and the Images page share is here: the checked request
 * and the picture that comes back. Nothing is written by it; where the result
 * goes is the caller's business, and a request that failed has left nothing
 * anywhere.
 */

/** Where the request goes: the base, with the route the OpenAI-style APIs have unless it is already there. */
export function editEndpointUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  // The address of generation is taken as it stands, so its route is swapped for this one.
  const base = url.pathname.replace(/\/+$/, "").replace(/\/images\/(generations|edits)$/, "");
  url.pathname = `${base}/images/edits`;
  return url;
}

/** How many pictures one edit takes, and how much they weigh together: set in image-settings.ts, which the page reads too. */
export { MAX_EDIT_PICTURES, MAX_EDIT_TOTAL_BYTES };

export interface EditRequest {
  /** What should change, or what a new picture should be made of the pictures. */
  prompt: string;
  /**
   * The picture to change. Its type is read from its bytes. A list is several
   * pictures, in the order the prompt refers to them; the endpoint must be one
   * that takes them, and the mask, where there is one, goes with the first.
   */
  image: Buffer | Buffer[];
  /** Marks the area to change, where the endpoint takes one. Checked as a picture; its size must match the picture's, which the endpoint tells. */
  mask?: Buffer;
  /** Instead of the model set for editing, for the Images page: the agent's tool has the saved one only. */
  model?: string;
  /** What the result comes out as, `1024x1024`; not sent without it, since the endpoint's own is usually the picture's. */
  size?: string;
  /** Sent as `output_format`, and `output_compression` with it. */
  outputFormat?: OutputFormat;
  outputCompression?: number;
  /** Not in the OpenAI format: put in the prompt as stable-diffusion.cpp's server reads them, and only where one is set. */
  native?: NativeSettings;
}

export interface EditOptions extends GenerateOptions {
  /** The most each picture and the mask may be; the same limit the Files panel shows a picture up to by default. */
  maxInputBytes?: number;
  /** The most the pictures may be together. */
  maxTotalBytes?: number;
}

/**
 * Refuses a picture with more pixels than the maximum for an edit (`maxSize`, such as `2048x1024`; empty is none).
 * The picture must fit the box either way up, so that a portrait one is not refused by a landscape limit. One whose
 * size cannot be read is refused too, since it cannot be shown to be within the limit. `who` starts the sentence.
 */
export function checkPictureSize(bytes: Buffer, maxSize: string, who: string): void {
  const [maxWidth, maxHeight] = (maxSize || "x").split("x").map(Number);
  if (!maxWidth || !maxHeight) return;
  const size = pictureSize(bytes);
  const limit = `${maxWidth}x${maxHeight}`;
  const advice = "Nothing was sent. Use a smaller picture (it is not scaled or cut), or tell the person; the limit is set in Settings → Agent → Images.";
  if (!size) throw new ImageGenerationError(`${who} has a size that cannot be read, so it cannot be shown to be within the maximum of ${limit} pixels for an edit. ${advice}`);
  const fits = (size.width <= maxWidth && size.height <= maxHeight) || (size.width <= maxHeight && size.height <= maxWidth);
  if (!fits) throw new ImageGenerationError(`${who} is ${size.width}x${size.height} pixels, which is over the maximum of ${limit} for an edit. ${advice}`);
}

/** A picture to send: what its first bytes say it is, not larger than the limit and within the maximum size. `who` starts the sentence that says what is wrong with it. */
function toSend(bytes: Buffer, who: string, name: string, max: number, maxSize: string): { blob: Blob; name: string } {
  const type = pictureType(bytes.subarray(0, 12));
  if (!type) throw new ImageGenerationError(`${who} is not a PNG, JPEG, GIF or WebP picture`);
  if (bytes.length > max) throw new ImageGenerationError(`${who} is over ${Math.round(max / 1024 / 1024)} MB`);
  checkPictureSize(bytes, maxSize, who);
  // Never the file's own name, which says where it came from: a neutral one, with the extension its bytes say.
  return { blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), name: `${name}.${pictureExt(bytes.subarray(0, 12))}` };
}

/** Refuses a count of pictures the endpoint is not said to take, or one longer than an edit takes. */
export function checkCount(count: number, multiple: boolean): void {
  if (count < 1) throw new ImageGenerationError("There is no picture to change");
  if (count > 1 && !multiple) {
    throw new ImageGenerationError(
      `The editing endpoint is not set up to take several pictures, so none was sent (${count} were given). Use one, or tell the person that "Several pictures per edit" can be switched on in Settings → Agent → Images if the endpoint takes them.`,
    );
  }
  if (count > MAX_EDIT_PICTURES) throw new ImageGenerationError(`An edit takes at most ${MAX_EDIT_PICTURES} pictures, and ${count} were given`);
}

/** Refuses pictures that weigh more together than an edit takes: none is scaled or cut to fit. */
export function checkTotal(bytes: number, max = MAX_EDIT_TOTAL_BYTES): void {
  if (bytes > max) {
    throw new ImageGenerationError(`The pictures are over ${Math.round(max / 1024 / 1024)} MB together, which is more than an edit takes. Use fewer or smaller ones; none is scaled or cut.`);
  }
}

/**
 * Asks for a picture changed and returns the result, checked as a generated
 * one is: a PNG, JPEG, GIF or WebP by its first bytes, and not too large.
 *
 * A picture that is no picture, or is over the limit or beyond the maximum size
 * of the editing settings, is refused before anything is sent, so that nothing leaves the portal that should not. With several, one
 * that is refused refuses them all: the prompt refers to them by their place in
 * the list, which a result made of the others would not match. A size is sent
 * only when the request has one: what an edit comes out as is the endpoint's to
 * say, usually the picture's own, and the size set for generation need not be
 * one an edit takes.
 */
export async function editImage(
  target: ImageEditingTarget,
  request: EditRequest,
  options: EditOptions = {},
): Promise<{ bytes: Buffer; ext: string }> {
  const max = options.maxInputBytes ?? MAX_PICTURE_BYTES;
  const given = Array.isArray(request.image) ? request.image : [request.image];
  checkCount(given.length, target.multiple);
  checkTotal(given.reduce((sum, bytes) => sum + bytes.length, 0), options.maxTotalBytes);
  const images = given.map((bytes, i) => (given.length > 1 ? toSend(bytes, `Picture ${i + 1}`, `image-${i + 1}`, max, target.maxSize) : toSend(bytes, "The image", "image", max, target.maxSize)));
  const mask = request.mask ? toSend(request.mask, "The mask", "mask", max, target.maxSize) : undefined;
  const form = new FormData();
  // One picture as the first OpenAI-style endpoints took it; several as the list form, once each, in order.
  for (const image of images) form.append(images.length > 1 ? "image[]" : "image", image.blob, image.name);
  if (mask) form.append("mask", mask.blob, mask.name);
  // As for generation: nothing that only stable-diffusion.cpp reads goes while the switch for it is off.
  form.append("prompt", promptWith(request.prompt, target.sdExtras ? (request.native ?? {}) : {}));
  const model = request.model || target.model;
  if (model) form.append("model", model);
  form.append("n", "1");
  if (request.size) form.append("size", request.size);
  if (request.outputFormat) form.append("output_format", request.outputFormat);
  if (request.outputCompression !== undefined) form.append("output_compression", String(request.outputCompression));
  // The time limit is the one of generation: the picture goes up first, and then the endpoint makes the new one.
  return requestPicture(editEndpointUrl(target.baseUrl), target.apiKey, form, { timeoutMs: target.timeoutSeconds * 1000, ...options });
}
