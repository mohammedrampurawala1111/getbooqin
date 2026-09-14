/**
 * QR codes, as images rather than links.
 *
 * Split out from payments.ts because the booking-link QR has nothing to
 * do with money: a clinic prints it, tapes it to the window, and people
 * scan it with their phone camera to reach the booking page.
 *
 * Worth noting how much simpler this is than the payment QR. A UPI QR
 * has to be read by a UPI app and is subject to which app the phone
 * hands it to; a QR containing an ordinary https:// URL is opened by
 * the camera itself on every phone made in the last decade. There is no
 * app chooser and nothing to configure.
 */
import QRCode from "qrcode";

export interface QrOptions {
  /** Pixel width of the square image. 1024 prints cleanly at postcard size. */
  width?: number;
  /** Quiet-zone modules. Print needs more than screen, or scanners struggle at the edge. */
  margin?: number;
}

/**
 * A PNG buffer, for download and print.
 *
 * `errorCorrectionLevel: "M"` recovers ~15% of the symbol — enough for
 * a printed sheet that gets scuffed, curled or taped at the corners,
 * without inflating the pattern the way "H" does.
 */
export function qrPng(text: string, opts: QrOptions = {}): Promise<Buffer> {
  return QRCode.toBuffer(text, {
    type: "png",
    width: opts.width ?? 1024,
    margin: opts.margin ?? 2,
    errorCorrectionLevel: "M",
  });
}

/** A data URL, for inlining into a page or an email. */
export function qrDataUrl(text: string, opts: QrOptions = {}): Promise<string> {
  return QRCode.toDataURL(text, {
    width: opts.width ?? 320,
    margin: opts.margin ?? 1,
    errorCorrectionLevel: "M",
  });
}

/** A filename that says what it is once it's in someone's Downloads folder. */
export function qrFilename(businessName: string): string {
  const slug = businessName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${slug || "booking"}-qr.png`;
}
